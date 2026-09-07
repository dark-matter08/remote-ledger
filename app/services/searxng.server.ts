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
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
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

const MAC = platform() === "darwin";
const WIN = platform() === "win32";

// SearXNG lags the newest CPython by a release or two, and the machine default may be
// ahead of it. Pin something known-good and let uv fetch it if it is missing.
const PY_VERSION = "3.12";
// The window SearXNG's pinned requirements resolve wheels for. Outside it we still
// offer to try — a distro that ships only 3.14 should not be a dead end — but we say
// so first, because the failure would otherwise land as an opaque pip error.
const PY_MIN = 10;
const PY_MAX = 13;
// Preference, not numeric order: PY_VERSION first, then out from it.
const PY_PREFERRED = [12, 11, 13, 10];
// Where each platform actually puts CPython. The old list was Homebrew-only, which is
// why a Linux box with a perfectly good interpreter reported having none. macOS stays
// off /usr/bin deliberately: python3 there is the Xcode stub, and running one to ask
// its version is enough to raise the developer-tools install dialog.
// LEDGER_PYTHON_DIRS covers what no fixed list can: pyenv, asdf, conda, /opt/pythonX.
const PY_PREFIXES = (process.env.LEDGER_PYTHON_DIRS || "")
  .split(":")
  .map((d) => d.trim())
  .filter(Boolean)
  .concat(
    MAC
      ? ["/opt/homebrew/bin", "/usr/local/bin"]
      : WIN
        ? []
        : ["/usr/bin", "/usr/local/bin", resolve(homedir(), ".local", "bin")]
  );

const venvPython = () => resolve(VENV, "bin", "python");

async function which(bin: string): Promise<string | null> {
  try {
    const { stdout } = await pexecFile("/usr/bin/which", [bin], { windowsHide: true });
    const p = stdout.trim();
    return p && existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

// Asking an interpreter its version costs a process, and the Search tab polls status
// every 15s. Keyed by absolute path, so a python installed mid-session is a new key
// and still gets picked up.
const pyVersions = new Map<string, number | null>();

/** The minor version the interpreter reports for itself. The filename is only a hint. */
async function pythonMinor(bin: string): Promise<number | null> {
  const cached = pyVersions.get(bin);
  if (cached !== undefined) return cached;
  let minor: number | null = null;
  try {
    const { stdout } = await pexecFile(bin, ["-c", "import sys; print(sys.version_info[0], sys.version_info[1])"], {
      timeout: 5000,
      env: { ...process.env, VIRTUAL_ENV: "", PYTHONHOME: "", PYTHONPATH: "" },
      windowsHide: true,
    });
    const m = stdout.trim().match(/^(\d+)\s+(\d+)/);
    if (m && m[1] === "3") minor = Number(m[2]);
  } catch {}
  pyVersions.set(bin, minor);
  return minor;
}

/** Every `python3.N` on this machine, in the order we would rather use them. */
function pythonCandidates(): string[] {
  const out: string[] = [];
  const add = (p: string) => {
    if (!out.includes(p) && existsSync(p)) out.push(p);
  };
  for (const v of PY_PREFERRED) for (const dir of PY_PREFIXES) add(resolve(dir, `python3.${v}`));
  // Anything else installed, including versions newer than we know about. Without this
  // a machine whose only interpreter is /usr/bin/python3.14 looks empty.
  for (const dir of PY_PREFIXES) {
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {}
    for (const n of names.filter((n) => /^python3\.\d+$/.test(n)).sort()) add(resolve(dir, n));
  }
  for (const dir of PY_PREFIXES) add(resolve(dir, "python3"));
  return out;
}

/**
 * An interpreter we can trust — never the one PATH happens to point at.
 *
 * Probed by absolute path and then asked its own version, because the name lies in
 * both directions: `python3` is whatever the distro moved to last, and a `python3.12`
 * on PATH may belong to another project's virtualenv.
 */
export async function findPython(): Promise<{ path: string; minor: number; tooNew: boolean } | null> {
  let newest: { path: string; minor: number; tooNew: boolean } | null = null;
  for (const p of pythonCandidates()) {
    const minor = await pythonMinor(p);
    if (minor === null || minor < PY_MIN) continue;
    if (minor <= PY_MAX) return { path: p, minor, tooNew: false };
    // too new for the pins — keep the least-new one in case it is all there is
    if (!newest || minor < newest.minor) newest = { path: p, minor, tooNew: true };
  }
  return newest;
}

export async function systemPython(): Promise<string | null> {
  return (await findPython())?.path ?? null;
}

/**
 * How to get an interpreter SearXNG will build against, on THIS machine.
 *
 * uv everywhere, rather than a per-distro python3.12 package: it fetches its own
 * pinned CPython, so it is the one answer that does not depend on the distro still
 * packaging a release the current one is two ahead of. Homebrew is macOS-only and
 * printing it on Linux was the bug that sent us here.
 */
export function pythonInstallCommand(): string {
  if (MAC) return "brew install uv";
  if (WIN) return "winget install --id=astral-sh.uv -e";
  return "curl -LsSf https://astral.sh/uv/install.sh | sh";
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
  /** e.g. "3.14" — what the interpreter above reports, not what its name claims. */
  pythonVersion: string | null;
  /** Found one, but newer than SearXNG pins for. Installable, with a warning. */
  pythonTooNew: boolean;
  /** The command to run HERE to fix it, or null when nothing needs fixing. */
  pythonInstall: string | null;
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
  const [hasUv, hasGit, py] = await Promise.all([which("uv"), which("git"), findPython()]);
  let jsonEnabled = false;
  try {
    jsonEnabled = /^\s*-\s*json\s*$/m.test(readFileSync(SETTINGS, "utf8"));
  } catch {}
  // uv brings its own PY_VERSION, so nothing about the machine's python matters then.
  const python = py?.path ?? null;
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
    pythonVersion: py ? `3.${py.minor}` : null,
    pythonTooNew: !!py?.tooNew,
    pythonInstall: hasUv || (py && !py.tooNew) ? null : pythonInstallCommand(),
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
      windowsHide: true,
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
    const py = await findPython();
    if (!py)
      return {
        ok: !push({
          step: "python",
          ok: false,
          output: `No Python 3.${PY_MIN}+ found in ${PY_PREFIXES.join(", ")}.\nInstall uv and it will fetch its own Python ${PY_VERSION}:\n\n  ${pythonInstallCommand()}`,
        }),
        steps,
      };
    // A pip failure two steps down is opaque; name the likely cause before it happens.
    if (py.tooNew)
      push({
        step: `Python 3.${py.minor} is newer than SearXNG pins for — trying it anyway`,
        ok: true,
        output: `If the dependency install fails, install uv and it will fetch Python ${PY_VERSION}:\n\n  ${pythonInstallCommand()}`,
      });
    if (!(await run(py.path, ["-m", "venv", VENV], `Creating a virtual environment (Python 3.${py.minor})`)))
      return { ok: false, steps };
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
    windowsHide: true,
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
