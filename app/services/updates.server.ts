// Is there a newer version of the Ledger than the one running?
//
// This is a git clone that its user does not think of as a git clone: they ran one
// command, and the app has been up ever since. So the app has to notice a release on
// their behalf, and applying one has to be a button rather than a checkout.
//
// The check reads the same origin that `npm run ledger restart` pulls from, and
// applying an update runs exactly that command — so what the UI offers and what the
// script does cannot drift apart.
import { spawn, spawnSync } from "node:child_process";
import { openSync, mkdirSync, statSync, readSync, closeSync } from "node:fs";
import { resolve } from "node:path";

export interface UpdateState {
  /** How many commits origin is ahead of us. 0 = nothing to do. */
  behind: number;
  current: string;
  latest: string;
  /** Subject line of the newest commit, so the notice can say what it is. */
  subject: string;
  branch: string;
  /** Local edits are discarded by an update, which is worth saying out loud. */
  dirty: boolean;
  checkedAt: string;
  error?: string;
}

// Reaching the network on every page load would be rude; a release is not urgent.
const TTL_MS = 15 * 60_000;
let memo: { at: number; state: UpdateState } | null = null;

function git(args: string[], timeoutMs = 20_000): string | null {
  const r = spawnSync("git", args, { cwd: process.cwd(), encoding: "utf8", timeout: timeoutMs });
  return r.status === 0 ? String(r.stdout || "").trim() : null;
}

const short = (sha: string | null) => (sha || "").slice(0, 7);

export async function checkForUpdate(force = false): Promise<UpdateState> {
  if (!force && memo && Date.now() - memo.at < TTL_MS) return memo.state;

  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]) || "main";
  const base: UpdateState = {
    behind: 0,
    current: short(git(["rev-parse", "HEAD"])),
    latest: "",
    subject: "",
    branch,
    dirty: Boolean(git(["status", "--porcelain"])),
    checkedAt: new Date().toISOString(),
  };
  if (!base.current) {
    // not a clone, or git is not installed — either way there is nothing to offer
    const state = { ...base, error: "not a git checkout" };
    memo = { at: Date.now(), state };
    return state;
  }

  // A fetch writes only remote refs, so it cannot disturb the working tree of a
  // running app. Failing it is normal (offline, no remote) and not worth an alarm.
  if (git(["fetch", "--quiet", "origin", branch], 30_000) === null) {
    const state = { ...base, error: "could not reach the origin" };
    memo = { at: Date.now(), state };
    return state;
  }

  const behind = Number(git(["rev-list", "--count", `HEAD..origin/${branch}`]) || "0") || 0;
  const state: UpdateState = {
    ...base,
    behind,
    latest: short(git(["rev-parse", `origin/${branch}`])),
    subject: behind ? git(["log", "-1", "--pretty=%s", `origin/${branch}`]) || "" : "",
  };
  memo = { at: Date.now(), state };
  return state;
}

/**
 * The tail of the last update attempt.
 *
 * When one fails there is nothing on screen to say why — the child is detached, so
 * its only account of itself is this file. Read from the end: it is appended to
 * across every update this install has ever run.
 */
export function updateLogTail(lines = 14): string[] {
  try {
    const path = resolve(process.cwd(), "logs", "update.log");
    const size = statSync(path).size;
    const len = Math.min(size, 8192);
    const fd = openSync(path, "r");
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    closeSync(fd);
    return buf.toString("utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-lines);
  } catch {
    return [];
  }
}

/**
 * Hand the update to `npm run ledger restart` and get out of the way.
 *
 * Detached on purpose: that command stops this very process partway through, so it
 * cannot be awaited — by the time the server goes down the response has long been
 * written. `to` must match the commit the caller was actually offered, so a stray
 * request cannot roll the machine onto whatever happens to be on origin right now.
 */
export async function applyUpdate(to: string): Promise<{ ok: boolean; message: string }> {
  const state = await checkForUpdate(true);
  if (state.error) return { ok: false, message: state.error };
  if (!state.behind) return { ok: false, message: "already up to date" };
  if (!to || to !== state.latest)
    return { ok: false, message: "that update is no longer the current one — reload and try again" };

  const logs = resolve(process.cwd(), "logs");
  mkdirSync(logs, { recursive: true });
  const out = openSync(resolve(logs, "update.log"), "a");
  const child = spawn(process.execPath, [resolve(process.cwd(), "scripts", "ledger.mjs"), "restart"], {
    cwd: process.cwd(),
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  memo = null; // whatever happens next, the cached answer is now wrong
  return { ok: true, message: `updating to ${state.latest} — the app restarts in a moment` };
}
