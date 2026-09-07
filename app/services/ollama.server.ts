// Getting Ollama installed, running, and holding the right weights — from the app.
//
// Ollama is the only runner the Ledger can set up end to end, because it is the only
// one that is just a local daemon: no key, no account, no per-token cost. So this is
// the one place where "make it work for me" is a button rather than a doc page.
//
// Everything here is best-effort and reports what it found. Nothing is installed
// without an explicit action from the UI, and every privileged or network-fetching
// command is shown to the user as text before it can be run.
import { exec, execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { platform, totalmem } from "node:os";
import { promisify } from "node:util";
import { resetOllamaProbe } from "../llm/adapters.server";

const pexec = promisify(exec);
const pexecFile = promisify(execFile);

export const OLLAMA_BASE = (process.env.OLLAMA_URL || "http://localhost:11434/v1").replace(/\/v1$/, "");
const MAC = platform() === "darwin";
const WIN = platform() === "win32";

// launchd/GUI apps do not share the shell's PATH, and neither does a server started
// from Finder — look where the installers actually put it.
const BIN_CANDIDATES = WIN
  ? [
      // where the official installer and winget put it
      `${process.env.LOCALAPPDATA}\\Programs\\Ollama\\ollama.exe`,
      `${process.env.ProgramFiles}\\Ollama\\ollama.exe`,
      `${process.env.LOCALAPPDATA}\\Microsoft\\WinGet\\Links\\ollama.exe`,
    ]
  : [
      "/usr/local/bin/ollama",
      "/opt/homebrew/bin/ollama",
      "/usr/bin/ollama",
      `${process.env.HOME}/.local/bin/ollama`,
      "/Applications/Ollama.app/Contents/Resources/ollama",
    ];

export interface OllamaStatus {
  installed: boolean;
  binPath: string | null;
  version: string | null;
  /** The daemon answers on OLLAMA_BASE. Installed but not running is the common case. */
  running: boolean;
  models: { name: string; sizeBytes: number; modified: string }[];
  totalRamGb: number;
  platform: string;
  /** The command we would run to install it, shown before anything happens. */
  installCmd: string | null;
  /** Homebrew is present, so we can install without piping a script into a shell. */
  hasBrew: boolean;
  error?: string;
}

async function which(bin: string): Promise<string | null> {
  try {
    const { stdout } = WIN
      ? await pexecFile("where", [bin], { shell: true })
      : await pexecFile("/usr/bin/which", [bin]);
    const p = stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || "";
    return p && existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

export async function ollamaBin(): Promise<string | null> {
  const found = await which("ollama");
  if (found) return found;
  return BIN_CANDIDATES.find((p) => existsSync(p)) ?? null;
}

/** Does the daemon answer? Short timeout — this runs on every settings render. */
export async function daemonRunning(ms = 1500): Promise<boolean> {
  try {
    const r = await fetch(`${OLLAMA_BASE}/api/version`, { signal: AbortSignal.timeout(ms) });
    return r.ok;
  } catch {
    return false;
  }
}

export async function listLocal(): Promise<{ name: string; sizeBytes: number; modified: string }[]> {
  try {
    const r = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return [];
    const j: any = await r.json();
    return (j.models || []).map((m: any) => ({
      name: String(m.name || ""),
      sizeBytes: Number(m.size || 0),
      modified: String(m.modified_at || ""),
    }));
  } catch {
    return [];
  }
}

/**
 * How we would install it here.
 *
 * Homebrew first on macOS: it is a signed, versioned formula, and it does not require
 * piping a downloaded script into a shell. The official installer is the fallback, and
 * the UI prints it in full so nobody runs it without reading it.
 */
export function installCommand(hasBrew: boolean, os: string = platform()): string | null {
  if (os === "darwin") return hasBrew ? "brew install ollama" : "curl -fsSL https://ollama.com/install.sh | sh";
  if (os === "win32") return "winget install Ollama.Ollama";
  return "curl -fsSL https://ollama.com/install.sh | sh";
}

/** The version number out of whatever the CLI decided to print around it. */
export function parseVersion(out: string): string | null {
  const m = String(out || "").match(/\b(\d+\.\d+\.\d+(?:[-+][\w.]+)?)\b/g);
  // "client version is 0.17.7" puts the number last; a bare "0.17.7" is also fine
  return m?.length ? m[m.length - 1] : null;
}

export async function ollamaStatus(): Promise<OllamaStatus> {
  const binPath = await ollamaBin();
  const hasBrew = !!(await which("brew"));
  const running = await daemonRunning();
  let version: string | null = null;

  if (running) {
    try {
      const r = await fetch(`${OLLAMA_BASE}/api/version`, { signal: AbortSignal.timeout(1500) });
      version = String(((await r.json()) as any)?.version || "") || null;
    } catch {}
  } else if (binPath) {
    try {
      // With the daemon down, `ollama --version` still answers but prefixes warnings
      // ("could not connect to a running Ollama instance"). Take the number, not the
      // paragraph, or the UI prints a wall of text where a version belongs.
      const { stdout, stderr } = await pexecFile(binPath, ["--version"], { timeout: 4000 });
      version = parseVersion(`${stdout}\n${stderr}`);
    } catch {}
  }

  return {
    installed: !!binPath,
    binPath,
    version,
    running,
    models: running ? await listLocal() : [],
    totalRamGb: Math.round(totalmem() / 1024 ** 3),
    platform: platform(),
    installCmd: installCommand(hasBrew),
    hasBrew,
  };
}

/** Install it. Long-running, so the caller streams or polls rather than awaiting a render. */
export async function installOllama(): Promise<{ ok: boolean; output: string }> {
  if (WIN) {
    if (!(await which("winget"))) {
      return { ok: false, output: "winget is not available. Install Ollama from https://ollama.com/download instead." };
    }
    // winget's exit code does not answer "did this work": it reports non-zero for a
    // PATH change it made itself, and for "already installed". Run it, then look on
    // disk, which is the only thing that settles it.
    let output = "";
    try {
      const { stdout, stderr } = await pexec(
        "winget install --id Ollama.Ollama -e --source winget --accept-source-agreements --accept-package-agreements",
        { timeout: 15 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 }
      );
      output = `${stdout}\n${stderr}`;
    } catch (e: any) {
      output = String(e?.stdout || "") + String(e?.stderr || e?.message || e);
    }
    return { ok: !!(await ollamaBin()), output: output.trim().slice(-4000) };
  }

  const hasBrew = !!(await which("brew"));
  const cmd = installCommand(hasBrew);
  if (!cmd) return { ok: false, output: "No install command for this platform." };
  try {
    const { stdout, stderr } = await pexec(cmd, { timeout: 15 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 });
    return { ok: !!(await ollamaBin()), output: `${stdout}\n${stderr}`.trim().slice(-4000) };
  } catch (e: any) {
    return { ok: false, output: String(e?.stderr || e?.message || e).slice(-4000) };
  }
}

/**
 * Start the daemon and wait for it to answer.
 *
 * `ollama serve` in the background rather than `brew services`: this needs no
 * privilege, works the same however Ollama arrived, and dies with the machine rather
 * than quietly persisting something the user did not ask us to install.
 */
export async function startDaemon(waitMs = 15000): Promise<boolean> {
  if (await daemonRunning()) return true;
  const bin = await ollamaBin();
  if (!bin) return false;
  try {
    const child = spawn(bin, ["serve"], { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    return false;
  }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (await daemonRunning(1000)) {
      // the Runners table holds its answer for a few seconds; do not make the user
      // wait for that to expire before it agrees the runner is up
      resetOllamaProbe();
      return true;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// --- pulls -----------------------------------------------------------------

export interface PullState {
  model: string;
  status: string;
  /** 0..100, or null while Ollama is still resolving the manifest. */
  percent: number | null;
  completed: number;
  total: number;
  done: boolean;
  error?: string;
  startedAt: number;
}

// A pull outlives the request that started it — Ollama keeps downloading whether or
// not anyone is watching — so progress lives here and the UI polls. Losing this on a
// server restart is fine: /api/tags is the source of truth for what actually landed.
const pulls = new Map<string, PullState>();

export function pullStates(): PullState[] {
  return [...pulls.values()].sort((a, b) => b.startedAt - a.startedAt);
}

export function startPull(model: string): PullState {
  const name = String(model || "").trim();
  const existing = pulls.get(name);
  if (existing && !existing.done) return existing;

  const state: PullState = {
    model: name,
    status: "starting",
    percent: null,
    completed: 0,
    total: 0,
    done: false,
    startedAt: Date.now(),
  };
  pulls.set(name, state);

  (async () => {
    try {
      const res = await fetch(`${OLLAMA_BASE}/api/pull`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: name, stream: true }),
      });
      if (!res.ok || !res.body) throw new Error(`Ollama answered ${res.status}`);

      // NDJSON: one JSON object per line, and the last line of a chunk is often partial
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let j: any;
          try {
            j = JSON.parse(line);
          } catch {
            continue;
          }
          if (j.error) throw new Error(String(j.error));
          state.status = String(j.status || state.status);
          if (typeof j.total === "number" && j.total > 0) {
            state.total = j.total;
            state.completed = Number(j.completed || 0);
            state.percent = Math.min(100, Math.round((state.completed / j.total) * 100));
          }
        }
      }
      state.status = "done";
      state.percent = 100;
      state.done = true;
    } catch (e: any) {
      state.error = String(e?.message || e).slice(0, 300);
      state.status = "failed";
      state.done = true;
    }
  })();

  return state;
}

export async function removeModel(model: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(`${OLLAMA_BASE}/api/delete`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
    });
    if (!r.ok) return { ok: false, error: `Ollama answered ${r.status}` };
    pulls.delete(model);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}

/** A real round-trip, so "configured" means something was actually generated. */
export async function testModel(model: string): Promise<{ ok: boolean; ms: number; reply?: string; error?: string }> {
  const t = Date.now();
  try {
    const r = await fetch(`${OLLAMA_BASE}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, prompt: "Reply with exactly: OK", stream: false, options: { num_predict: 12 } }),
      signal: AbortSignal.timeout(120000),
    });
    const j: any = await r.json().catch(() => null);
    // Ollama puts the useful part in the body even on a 400 — "\"nomic-embed-text\"
    // does not support generate" tells you what to do; "Ollama answered 400" does not.
    if (j?.error) return { ok: false, ms: Date.now() - t, error: String(j.error).slice(0, 200) };
    if (!r.ok || !j) return { ok: false, ms: Date.now() - t, error: `Ollama answered ${r.status}` };
    return { ok: true, ms: Date.now() - t, reply: String(j.response || "").trim().slice(0, 120) };
  } catch (e: any) {
    return { ok: false, ms: Date.now() - t, error: String(e?.message || e).slice(0, 200) };
  }
}
