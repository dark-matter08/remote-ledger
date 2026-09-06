// A private metasearch engine, run as a local process — no Docker, no account.
//
// SearXNG queries the public engines on your behalf and returns JSON. That is the
// piece a local model is missing: it cannot browse, but the app can search and hand
// it real results, which keeps the anti-hallucination guarantee the crawl depends on
// (the model only ever judges pages we actually fetched).
//
// Three things about running it natively that are easy to get wrong, and are the
// reason this file exists rather than a paragraph in the README:
//
//   1. Never spawn bare `python3`. On this machine PATH resolves it to an unrelated
//      project's virtualenv, and installing into that would be both wrong and
//      invisible. We pin an absolute interpreter, or let uv supply one.
//   2. JSON is OFF by default. SearXNG ships `formats: [html]`, so the API returns
//      403 until settings.yml says otherwise — the single most common "it installed
//      but nothing works" cause.
//   3. It needs a secret_key. Without one it refuses to start.
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";

const pexecFile = promisify(execFile);

// Machine-wide rather than inside the repo: it is ~250MB of checkout and wheels, and
// one copy should serve every checkout of the Ledger on this machine.
export const SEARXNG_HOME = resolve(homedir(), ".remote-ledger", "searxng");
const SRC = resolve(SEARXNG_HOME, "src");
const VENV = resolve(SEARXNG_HOME, "venv");
const SETTINGS = resolve(SEARXNG_HOME, "settings.yml");
const PID_FILE = resolve(SEARXNG_HOME, "searxng.pid");
// written only after the environment is proven to import; a half-finished install
// leaves a venv and a checkout behind, and both of those look like success
const MARKER = resolve(SEARXNG_HOME, "installed.json");
export const SEARXNG_LOG = resolve(SEARXNG_HOME, "searxng.log");
const REPO = "https://github.com/searxng/searxng.git";

export const DEFAULT_PORT = 8899;

// SearXNG lags the newest CPython by a release or two, and the machine default may be
// ahead of it. Pin something known-good and let uv fetch it if it is missing.
const PY_VERSION = "3.12";

const venvPython = () => resolve(VENV, "bin", "python");

async function which(bin: string): Promise<string | null> {
  try {
    const { stdout } = await pexecFile("/usr/bin/which", [bin]);
    const p = stdout.trim();
    return p && existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

/** An interpreter we can trust — never the one PATH happens to point at. */
export async function systemPython(): Promise<string | null> {
  for (const p of [
    "/opt/homebrew/bin/python3.12",
    "/opt/homebrew/bin/python3.11",
    "/opt/homebrew/bin/python3.13",
    "/usr/local/bin/python3.12",
    "/usr/local/bin/python3.11",
    "/opt/homebrew/bin/python3",
  ]) {
    if (existsSync(p)) return p;
  }
  return null;
}

export interface SearxngStatus {
  installed: boolean;
  running: boolean;
  port: number;
  url: string;
  home: string;
  pid: number | null;
  /** JSON output enabled in settings.yml — without it the API answers 403. */
  jsonEnabled: boolean;
  hasUv: boolean;
  hasGit: boolean;
  python: string | null;
  canInstall: boolean;
  version: string | null;
}

export function searxngPort(): number {
  const raw = Number(process.env.SEARXNG_PORT || DEFAULT_PORT);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PORT;
}

export function searxngUrl(port = searxngPort()): string {
  return `http://127.0.0.1:${port}`;
}

function readPid(): number | null {
  try {
    const n = Number(readFileSync(PID_FILE, "utf8").trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM"; // exists, just not ours
  }
}

export async function searxngRunning(port = searxngPort(), ms = 1500): Promise<boolean> {
  try {
    const r = await fetch(`${searxngUrl(port)}/healthz`, { signal: AbortSignal.timeout(ms) });
    if (r.ok) return true;
  } catch {}
  try {
    // older builds have no /healthz; the root page is proof enough that it is serving
    const r = await fetch(searxngUrl(port), { signal: AbortSignal.timeout(ms) });
    return r.ok;
  } catch {
    return false;
  }
}

export async function searxngStatus(): Promise<SearxngStatus> {
  const port = searxngPort();
  const installed = existsSync(venvPython()) && existsSync(SRC) && existsSync(MARKER);
  const pid = readPid();
  const [hasUv, hasGit, python] = await Promise.all([which("uv"), which("git"), systemPython()]);
  let jsonEnabled = false;
  try {
    jsonEnabled = /^\s*-\s*json\s*$/m.test(readFileSync(SETTINGS, "utf8"));
  } catch {}
  return {
    installed,
    running: await searxngRunning(port),
    port,
    url: searxngUrl(port),
    home: SEARXNG_HOME,
    pid: pid && pidAlive(pid) ? pid : null,
    jsonEnabled,
    hasUv: !!hasUv,
    hasGit: !!hasGit,
    python,
    canInstall: !!hasGit && (!!hasUv || !!python),
    version: installed ? readVersion() : null,
  };
}

function readVersion(): string | null {
  try {
    const m = readFileSync(resolve(SRC, "searx", "version_frozen.py"), "utf8").match(/VERSION_STRING\s*=\s*"([^"]+)"/);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * settings.yml, written by us and overwritten on every install.
 *
 * Bound to loopback and with no public instance settings: this exists to answer the
 * Ledger's own queries, not to be a search engine anyone else can reach.
 */
function settingsYaml(port: number): string {
  return `# Generated by The Remote Ledger. Edits here are overwritten on reinstall.
use_default_settings: true

general:
  instance_name: "Remote Ledger search"
  # a local instance has nobody to donate to and nobody to ask
  donation_url: false
  contact_url: false

server:
  port: ${port}
  bind_address: "127.0.0.1"
  # generated per install; SearXNG refuses to start without one
  secret_key: "${randomBytes(32).toString("hex")}"
  limiter: false
  public_instance: false
  image_proxy: false

search:
  # THE line that matters. SearXNG ships [html] only, and the JSON API answers 403
  # until json is listed here — which looks exactly like a broken install.
  formats:
    - html
    - json
  safe_search: 0
  autocomplete: ""

ui:
  static_use_hash: true
`;
}

export interface InstallStep {
  step: string;
  ok: boolean;
  output?: string;
}

/**
 * Clone, build an isolated environment, and write our settings.
 *
 * uv is preferred: it resolves and installs an order of magnitude faster, and it can
 * fetch the pinned interpreter itself rather than depending on what happens to be
 * installed. Plain venv + pip is the fallback so this still works without uv.
 */
export async function installSearxng(onStep?: (s: InstallStep) => void): Promise<{ ok: boolean; steps: InstallStep[] }> {
  const steps: InstallStep[] = [];
  const push = (s: InstallStep) => {
    steps.push(s);
    onStep?.(s);
    return s.ok;
  };
  const run = async (bin: string, args: string[], step: string, cwd?: string) => {
    try {
      const { stdout, stderr } = await pexecFile(bin, args, {
        cwd,
        timeout: 20 * 60 * 1000,
        maxBuffer: 16 * 1024 * 1024,
        // a clean environment: inheriting VIRTUAL_ENV or a PATH pointing into another
        // project's venv is how this ends up installing somewhere surprising
        env: { ...process.env, VIRTUAL_ENV: "", PYTHONHOME: "", PYTHONPATH: "" },
      });
      return push({ step, ok: true, output: `${stdout}\n${stderr}`.trim().slice(-1200) });
    } catch (e: any) {
      return push({ step, ok: false, output: String(e?.stderr || e?.message || e).slice(-1500) });
    }
  };

  mkdirSync(SEARXNG_HOME, { recursive: true });

  const git = await which("git");
  if (!git) return { ok: !push({ step: "git", ok: false, output: "git is not installed." }), steps };

  if (!existsSync(resolve(SRC, ".git"))) {
    if (!(await run(git, ["clone", "--depth", "1", REPO, SRC], "Cloning SearXNG"))) return { ok: false, steps };
  } else {
    await run(git, ["pull", "--ff-only"], "Updating the checkout", SRC);
  }

  // Deliberately NOT `pip install -e .`. SearXNG's setup.py imports the package to
  // read its version, and the package imports msgspec — so an editable install fails
  // on a clean environment with ModuleNotFoundError before it can install anything.
  // Installing the pinned requirements and running from the checkout is what SearXNG's
  // own `make run` does, and it sidesteps the build entirely.
  const reqs = resolve(SRC, "requirements.txt");
  if (!existsSync(reqs)) return { ok: !push({ step: "requirements.txt", ok: false, output: "not found in the checkout" }), steps };

  const uv = await which("uv");
  if (uv) {
    if (!(await run(uv, ["venv", "--python", PY_VERSION, VENV], `Creating an isolated Python ${PY_VERSION}`)))
      return { ok: false, steps };
    if (!(await run(uv, ["pip", "install", "--python", venvPython(), "-r", reqs], "Installing dependencies", SRC)))
      return { ok: false, steps };
  } else {
    const py = await systemPython();
    if (!py) return { ok: !push({ step: "python", ok: false, output: "No usable Python found." }), steps };
    if (!(await run(py, ["-m", "venv", VENV], "Creating a virtual environment"))) return { ok: false, steps };
    if (!(await run(venvPython(), ["-m", "pip", "install", "--upgrade", "pip"], "Updating pip"))) return { ok: false, steps };
    if (!(await run(venvPython(), ["-m", "pip", "install", "-r", reqs], "Installing dependencies", SRC)))
      return { ok: false, steps };
  }

  // prove the environment can actually load it before calling the install a success
  if (!(await run(venvPython(), ["-c", "import searx, msgspec, flask; print(searx.__file__)"], "Checking it imports", SRC)))
    return { ok: false, steps };

  writeFileSync(SETTINGS, settingsYaml(searxngPort()));
  push({ step: "Writing settings.yml (JSON API enabled)", ok: true });
  writeFileSync(MARKER, new Date().toISOString());
  return { ok: true, steps };
}

/** Start it in the background and wait until it actually answers. */
export async function startSearxng(waitMs = 40000): Promise<boolean> {
  const port = searxngPort();
  if (await searxngRunning(port)) return true;
  if (!existsSync(venvPython())) return false;

  // settings.yml can go missing or predate a port change; it is cheap to rewrite
  if (!existsSync(SETTINGS)) writeFileSync(SETTINGS, settingsYaml(port));

  const out = openSync(SEARXNG_LOG, "a");
  const child = spawn(venvPython(), ["-m", "searx.webapp"], {
    cwd: SRC,
    detached: true,
    stdio: ["ignore", out, out],
    env: {
      ...process.env,
      SEARXNG_SETTINGS_PATH: SETTINGS,
      SEARXNG_PORT: String(port),
      SEARXNG_BIND_ADDRESS: "127.0.0.1",
      VIRTUAL_ENV: VENV,
      PYTHONHOME: "",
      // the package is not installed into site-packages, it is run from the checkout
      PYTHONPATH: SRC,
    },
  });
  child.unref();
  if (child.pid) writeFileSync(PID_FILE, String(child.pid));

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (await searxngRunning(port, 1000)) return true;
    await new Promise((r) => setTimeout(r, 700));
  }
  return false;
}

export function stopSearxng(): boolean {
  const pid = readPid();
  if (!pid || !pidAlive(pid)) {
    rmSync(PID_FILE, { force: true });
    return false;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
  rmSync(PID_FILE, { force: true });
  return true;
}

/** The last few lines it wrote, for when it will not start. */
export function searxngLogTail(lines = 20): string {
  try {
    return readFileSync(SEARXNG_LOG, "utf8").split(/\r?\n/).slice(-lines).join("\n").slice(-3000);
  } catch {
    return "";
  }
}

export function removeSearxng(): void {
  stopSearxng();
  rmSync(SEARXNG_HOME, { recursive: true, force: true });
}
