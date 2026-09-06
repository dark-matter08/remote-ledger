// Offer a job board back to the project it came from.
//
// The shipped board list is short because one person wrote it. Everyone running the
// Ledger is quietly finding boards that work, and none of that ever comes back — so
// this looks at what a user has added that the defaults do not carry, and opens a
// pull request against the repo for the maintainer to read.
//
// Three rules this is built around, because the thing being published is somebody
// else's private list:
//
//   1. Opt in, never opt out. Nothing leaves without the setting being switched on,
//      and switching it on is not consent to whatever today's payload happens to be.
//   2. The exact payload is shown first, per board, and boards are chosen one at a
//      time. `note` is free text a user wrote for themselves, so they read it back
//      before anyone else does.
//   3. Nothing else is ever read. Not jobs, not the profile, not keys — only a
//      board's name, url, note, and how many roles it has actually produced.
//
// The pull request is opened with the contributor's own gh login, from their own
// fork. It is their contribution, under their name, and it is public.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getDb, getSetting, setSetting } from "../sqlite.server";
import { DEFAULT_BOARDS } from "../default-boards";
import { parseRepoRef, ghIdentity, type Log } from "./github.server";

export interface BoardSuggestion {
  name: string;
  url: string;
  note: string;
  /** Roles in this ledger that came from it — the case for adding it. */
  jobsFound: number;
}

const noop: Log = () => {};

/** A trailing slash and a www are not a different board. */
function normUrl(u: string): string {
  try {
    const x = new URL(u);
    return `${x.hostname.replace(/^www\./, "")}${x.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return String(u || "").trim().toLowerCase().replace(/\/+$/, "");
  }
}

const hostOf = (u: string) => {
  try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; }
};

/**
 * Boards this install has that the shipped list does not.
 *
 * Counted, not just named: a board nobody has got a role out of is a guess, and the
 * maintainer should be able to tell the difference without installing it themselves.
 */
export function pendingBoardSuggestions(): BoardSuggestion[] {
  const db = getDb();
  const known = new Set(DEFAULT_BOARDS.map((b) => normUrl(b.url)));
  const mine = db
    .prepare("SELECT name, careers_url, note FROM companies WHERE kind='board' AND careers_url IS NOT NULL")
    .all() as { name: string; careers_url: string; note: string | null }[];

  const countBoth = db.prepare("SELECT COUNT(*) c FROM jobs WHERE source LIKE ? OR source LIKE ?");
  const countName = db.prepare("SELECT COUNT(*) c FROM jobs WHERE source LIKE ?");
  const out: BoardSuggestion[] = [];
  const seen = new Set<string>();
  for (const b of mine) {
    const key = normUrl(b.careers_url);
    if (!key || known.has(key) || seen.has(key)) continue;
    seen.add(key);
    const host = hostOf(b.careers_url);
    // Two statements rather than one with a sentinel: the "match nothing" value has
    // to be a string SQL will never match, and reaching for one is how a stray NUL
    // ended up in this file and made git treat the whole thing as binary.
    const r = (host
      ? countBoth.get(`%${b.name}%`, `%${host}%`)
      : countName.get(`%${b.name}%`)) as { c: number };
    out.push({
      name: String(b.name || "").trim(),
      url: String(b.careers_url || "").trim(),
      note: String(b.note || "").trim(),
      jobsFound: Number(r?.c || 0),
    });
  }
  return out.sort((a, b) => b.jobsFound - a.jobsFound);
}

// ---------- the pull request ----------

function gh(args: string[], timeoutMs = 90_000) {
  const r = spawnSync("gh", args, { encoding: "utf8", timeout: timeoutMs });
  return { ok: r.status === 0, out: String(r.stdout || "").trim(), err: String(r.stderr || r.error?.message || "").trim() };
}

function git(args: string[], cwd: string, timeoutMs = 120_000) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: timeoutMs });
  return { ok: r.status === 0, out: String(r.stdout || "").trim(), err: String(r.stderr || r.error?.message || "").trim() };
}

/** Where this clone came from — the repo a contribution goes back to. */
export function upstreamRepo(): { owner: string; repo: string; slug: string } | null {
  const r = spawnSync("git", ["remote", "get-url", "origin"], { cwd: process.cwd(), encoding: "utf8" });
  if (r.status !== 0) return null;
  return parseRepoRef(String(r.stdout || "").trim());
}

export interface SubmitResult {
  ok: boolean;
  message: string;
  prUrl?: string;
  submitted: string[];
}

const BRANCH_PREFIX = "community-boards";
const DATA_PATH = "app/default-boards.json";

/**
 * Open (or find) a pull request adding these boards upstream.
 *
 * Deliberately clone-edit-push rather than the contents API: the diff the maintainer
 * reads is then produced by git from real files, so a mangled write fails here as a
 * refused commit instead of arriving as a broken build after a merge.
 */
export async function submitBoardSuggestions(urls: string[], log: Log = noop): Promise<SubmitResult> {
  const wanted = new Set(urls.map(normUrl));
  const picked = pendingBoardSuggestions().filter((b) => wanted.has(normUrl(b.url)));
  if (!picked.length) return { ok: false, message: "nothing selected to send", submitted: [] };

  const upstream = upstreamRepo();
  if (!upstream) return { ok: false, message: "this clone has no GitHub origin to contribute back to", submitted: [] };

  const who = ghIdentity(log);
  if (!who.ok) return { ok: false, message: who.reason || "gh is unavailable", submitted: [] };
  const login = who.login || "";

  // An open one already carries the offer; a second is just noise in the queue.
  const open = gh(["pr", "list", "--repo", upstream.slug, "--author", "@me", "--state", "open", "--json", "url,title,headRefName"]);
  if (open.ok) {
    try {
      // Match the branch this tool creates, not the word "board" in a title. A PR
      // called "feat(board): ..." is not a board suggestion, and treating it as one
      // silently switches community sharing off for as long as it stays open.
      const existing = (JSON.parse(open.out || "[]") as { url: string; title: string; headRefName?: string }[])
        .find((p) => String(p.headRefName || "").startsWith(BRANCH_PREFIX));
      if (existing) {
        log("note", `you already have an open board suggestion: ${existing.url}`);
        return { ok: true, message: "an open pull request already carries your suggestions", prUrl: existing.url, submitted: [] };
      }
    } catch {}
  }

  const ownRepo = login.toLowerCase() === upstream.owner.toLowerCase();
  if (!ownRepo) {
    log("step", `forking ${upstream.slug} to ${login} (or reusing the fork you already have)…`);
    const f = gh(["repo", "fork", upstream.slug, "--clone=false"], 120_000);
    if (!f.ok && !/already exists/i.test(f.err))
      return { ok: false, message: `could not fork: ${f.err.slice(0, 160)}`, submitted: [] };
  } else {
    log("step", "this is your own repo — pushing a branch to it directly, no fork needed");
  }

  gh(["auth", "setup-git"], 30_000); // idempotent; lets git push use the gh token

  const parent = mkdtempSync(join(tmpdir(), "ledger-contrib-"));
  const dir = resolve(parent, upstream.repo);
  try {
    log("step", `cloning ${upstream.slug}…`);
    const c = gh(["repo", "clone", upstream.slug, dir, "--", "--depth=1"], 180_000);
    if (!c.ok) return { ok: false, message: `clone failed: ${c.err.slice(0, 160)}`, submitted: [] };

    const file = resolve(dir, DATA_PATH);
    let current: { name: string; url: string; note: string }[];
    try {
      current = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return { ok: false, message: `${DATA_PATH} could not be read upstream`, submitted: [] };
    }

    // Upstream may have taken the board since this ledger last looked.
    const have = new Set(current.map((b) => normUrl(b.url)));
    const fresh = picked.filter((b) => !have.has(normUrl(b.url)));
    if (!fresh.length) return { ok: true, message: "upstream already carries every board you picked", submitted: [] };

    for (const b of fresh) current.push({ name: b.name, url: b.url, note: b.note });
    writeFileSync(file, JSON.stringify(current, null, 2) + "\n");

    const stamp = `${new Date().toISOString().slice(0, 10)}-${Date.now().toString(36).slice(-4)}`;
    const branch = `${BRANCH_PREFIX}-${stamp}`;
    git(["checkout", "-b", branch], dir);
    git(["config", "user.name", who.name || login || "The Remote Ledger"], dir);
    git(["config", "user.email", who.email || `${login}@users.noreply.github.com`], dir);
    git(["add", DATA_PATH], dir);

    const subject =
      fresh.length === 1 ? `feat(boards): add ${fresh[0].name}` : `feat(boards): add ${fresh.length} job boards`;
    const lines = fresh.map((b) => `- ${b.name} (${b.url}) — ${b.jobsFound} role(s) found from it here`);
    const commit = git(["commit", "-m", subject, "-m", lines.join("\n")], dir);
    if (!commit.ok) return { ok: false, message: `commit failed: ${commit.err.slice(0, 160)}`, submitted: [] };

    const target = ownRepo ? upstream.slug : `${login}/${upstream.repo}`;
    log("step", `pushing to ${target}…`);
    const push = git(["push", `https://github.com/${target}.git`, `HEAD:${branch}`], dir);
    if (!push.ok) return { ok: false, message: `push failed: ${push.err.slice(0, 200)}`, submitted: [] };

    const prBody = [
      "Boards this ledger has been using that the shipped list does not carry yet.",
      "",
      ...fresh.map((b) =>
        [
          `### ${b.name}`,
          `- ${b.url}`,
          `- **${b.jobsFound}** role(s) in my ledger came from it`,
          b.note ? `- note: ${b.note}` : "",
        ].filter(Boolean).join("\n")
      ),
      "",
      "Opened by The Remote Ledger on the contributor's machine — from the Companies tab,",
      "or by the daily pass if they switched that on. Only the name, url, note and role",
      "count above were read; nothing else left the machine.",
    ].join("\n");

    log("step", "opening the pull request…");
    const pr = gh(
      ["pr", "create", "--repo", upstream.slug, "--head", ownRepo ? branch : `${login}:${branch}`,
       "--title", subject, "--body", prBody],
      120_000
    );
    if (!pr.ok) return { ok: false, message: `could not open the pull request: ${pr.err.slice(0, 200)}`, submitted: [] };

    const url = (pr.out.match(/https:\/\/\S+/) || [])[0] || "";
    setSetting("community_last_submit", new Date().toISOString());
    log("result", `pull request opened: ${url}`);
    return { ok: true, message: `suggested ${fresh.length} board(s)`, prUrl: url, submitted: fresh.map((b) => b.url) };
  } finally {
    try { rmSync(parent, { recursive: true, force: true }); } catch {}
  }
}

/** Scheduler hook: once a day, and only where someone actually switched this on. */
export async function runDueCommunityShare(): Promise<void> {
  if (getSetting("community_share") !== "true") return;
  const last = getSetting("community_last_check");
  if (last && Date.now() - Date.parse(last) < 24 * 3600 * 1000) return;
  setSetting("community_last_check", new Date().toISOString());

  const pending = pendingBoardSuggestions();
  if (!pending.length) return;
  console.log(`[community] ${pending.length} board(s) missing from the shipped list — offering them upstream`);
  const r = await submitBoardSuggestions(
    pending.map((b) => b.url),
    (k, t) => console.log(`[community] ${k}: ${t}`)
  );
  console.log(`[community] ${r.message}${r.prUrl ? ` · ${r.prUrl}` : ""}`);
}
