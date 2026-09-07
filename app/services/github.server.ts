// Read a GitHub repository through the gh CLI the user already has logged in.
//
// A private repo is where the interesting work usually is, and it is exactly what a
// local-first tool can reach that a hosted one cannot: `gh` is already sitting on
// this machine holding a token the user granted themselves. Nothing here asks for a
// credential, stores one, or sends one anywhere — it shells out to gh and lets gh do
// what it is already trusted to do.
//
// Every step reports through `log`, because "it did not work" is not an answer when
// the failure could be gh missing, gh logged out, the token lacking `repo`, or the
// repo simply not existing. Each of those needs a different thing from the user.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

export type Log = (kind: string, text: string) => void;

export interface RepoRef {
  owner: string;
  repo: string;
  /** owner/repo — the only form passed to gh */
  slug: string;
}

// Deliberately strict: everything here becomes an argument to a subprocess. Nothing
// is interpolated into a shell, but a name that cannot be a repo is a mistake worth
// catching before the network call rather than after it.
const NAME = /^[A-Za-z0-9._-]+$/;

/** github.com URLs, git@ remotes, and the bare owner/repo people actually type. */
export function parseRepoRef(input: string): RepoRef | null {
  const raw = String(input || "").trim();
  if (!raw) return null;
  // A filesystem path is never a repo reference, and "Users/me" is what you get from
  // /Users/me/Projects/app if you do not say so.
  if (/^[~./]/.test(raw) || raw.startsWith("\\")) return null;
  const isUrl = /github\.com/i.test(raw);
  const cleaned = raw
    .replace(/^git\+/, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/^(https?:\/\/)?(www\.)?github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "");
  const parts = cleaned.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  // github.com/owner/repo/tree/main is still that repo; a bare a/b/c is not one at all
  if (parts.length > 2 && !isUrl) return null;
  const [owner, repo] = parts;
  if (!NAME.test(owner) || !NAME.test(repo)) return null;
  return { owner, repo, slug: `${owner}/${repo}` };
}

export const looksLikeRepo = (s: string): boolean =>
  /github\.com/i.test(s) || (/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(String(s || "").trim()) && !s.startsWith("/") && !s.startsWith("~"));

function gh(args: string[], timeoutMs = 60_000): { ok: boolean; out: string; err: string } {
  const r = spawnSync("gh", args, { encoding: "utf8", timeout: timeoutMs, windowsHide: true });
  return {
    ok: r.status === 0,
    out: String(r.stdout || "").trim(),
    err: String(r.stderr || r.error?.message || "").trim(),
  };
}

function git(args: string[], cwd: string, timeoutMs = 60_000): string | null {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: timeoutMs, windowsHide: true });
  return r.status === 0 ? String(r.stdout || "").trim() : null;
}

export interface GhIdentity {
  ok: boolean;
  login?: string;
  name?: string;
  email?: string;
  reason?: string;
}

/**
 * Is gh here, and is it logged in? Split from everything else so the crawl log can
 * name the actual blocker — a missing binary and an expired token look identical
 * from the far side of a failed clone.
 */
export function ghIdentity(log: Log): GhIdentity {
  const v = gh(["--version"], 10_000);
  if (!v.ok) {
    log("error", "gh is not on this machine, so a private repo cannot be read. Install it from cli.github.com, then `gh auth login`.");
    return { ok: false, reason: "gh not installed" };
  }
  log("step", `gh present · ${v.out.split("\n")[0]}`);

  const status = gh(["auth", "status"], 20_000);
  if (!status.ok) {
    log("error", "gh is installed but not logged in. Run `gh auth login` once and this will reach your private repos.");
    return { ok: false, reason: "gh not authenticated" };
  }

  const me = gh(["api", "user", "--jq", "[.login, .name, .email] | @tsv"], 20_000);
  if (!me.ok) {
    log("error", `gh is logged in but the API refused: ${me.err.slice(0, 160)}`);
    return { ok: false, reason: "gh api refused" };
  }
  const [login, name, email] = me.out.split("\t");
  log("step", `gh authenticated as ${login || "?"} — using those credentials, nothing is stored here`);
  return { ok: true, login: login || undefined, name: name || undefined, email: email || undefined };
}

export interface RepoMeta {
  slug: string;
  description: string;
  visibility: string;
  primaryLanguage: string;
  languages: { name: string; size: number }[];
  stars: number;
  createdAt: string;
  pushedAt: string;
  topics: string[];
}

const FIELDS =
  "name,description,visibility,primaryLanguage,languages,stargazerCount,createdAt,pushedAt,repositoryTopics";

export function repoMeta(ref: RepoRef, log: Log): RepoMeta | null {
  log("step", `asking gh about ${ref.slug}…`);
  const r = gh(["repo", "view", ref.slug, "--json", FIELDS]);
  if (!r.ok) {
    const err = r.err.toLowerCase();
    if (err.includes("could not resolve") || err.includes("not found"))
      log("error", `${ref.slug} was not found by your account. If it is private, the token needs the \`repo\` scope — \`gh auth refresh -s repo\`.`);
    else log("error", `gh could not read ${ref.slug}: ${r.err.slice(0, 200)}`);
    return null;
  }
  let j: any;
  try { j = JSON.parse(r.out); } catch { log("error", "gh returned something that was not JSON"); return null; }

  const languages = (Array.isArray(j.languages) ? j.languages : [])
    .map((l: any) => ({ name: String(l?.node?.name || ""), size: Number(l?.size || 0) }))
    .filter((l: { name: string }) => l.name)
    .sort((a: any, b: any) => b.size - a.size);

  const meta: RepoMeta = {
    slug: ref.slug,
    description: String(j.description || ""),
    visibility: String(j.visibility || ""),
    primaryLanguage: String(j.primaryLanguage?.name || ""),
    languages,
    stars: Number(j.stargazerCount || 0),
    createdAt: String(j.createdAt || ""),
    pushedAt: String(j.pushedAt || ""),
    topics: (Array.isArray(j.repositoryTopics) ? j.repositoryTopics : []).map((t: any) => String(t?.name || t?.topic?.name || "")).filter(Boolean),
  };
  log("result", `${meta.visibility.toLowerCase() || "unknown"} repo · ${meta.primaryLanguage || "mixed"} · ${languages.length} language(s) · last pushed ${meta.pushedAt.slice(0, 10)}`);
  if (meta.visibility.toUpperCase() === "PRIVATE") log("reasoning", "Private, and your own credentials opened it. This is work no public scan could have seen.");
  return meta;
}

/** Shallow clone into a temp dir. The caller owns it and must call cleanup(). */
export function cloneRepo(ref: RepoRef, log: Log): { dir: string; cleanup: () => void } | null {
  const parent = mkdtempSync(join(tmpdir(), "ledger-repo-"));
  const dir = resolve(parent, ref.repo);
  log("step", `cloning ${ref.slug} (shallow, code only, into a temp folder)…`);
  // depth 200 is enough history to attribute work without pulling years of it
  const r = gh(["repo", "clone", ref.slug, dir, "--", "--depth=200", "--single-branch"], 180_000);
  if (!r.ok) {
    log("error", `clone failed: ${(r.err || "unknown").slice(0, 200)}`);
    try { rmSync(parent, { recursive: true, force: true }); } catch {}
    return null;
  }
  log("result", "cloned — reading it exactly like a local folder from here on");
  return { dir, cleanup: () => { try { rmSync(parent, { recursive: true, force: true }); } catch {} } };
}

export interface Contribution {
  total: number;
  mine: number;
  share: number;
  firstAt: string;
  lastAt: string;
  areas: string[];
  /** Whether we could identify the user in the history at all. */
  identified: boolean;
}

/**
 * What did THIS person actually do here? A résumé bullet that claims a repo without
 * distinguishing "I wrote it" from "I opened one pull request" is the kind of thing
 * an interview finds out in a minute, so the share is measured rather than implied.
 */
export function contribution(dir: string, who: GhIdentity, log: Log): Contribution | null {
  const total = Number(git(["rev-list", "--count", "HEAD"], dir) || "0") || 0;
  if (!total) { log("step", "no commit history in the clone — skipping attribution"); return null; }

  // Match on every identity the account exposes: the commit author is often a noreply
  // address or a display name, and rarely the login itself.
  const needles = [who.login, who.name, who.email].filter(Boolean).map((s) => String(s).toLowerCase());
  const shortlog = git(["shortlog", "-sne", "--all", "HEAD"], dir) || "";
  let mine = 0;
  let matchedAuthor = "";
  for (const line of shortlog.split("\n")) {
    const m = /^\s*(\d+)\s+(.*?)\s*<(.*?)>\s*$/.exec(line);
    if (!m) continue;
    const [, count, name, email] = m;
    const hay = `${name} ${email}`.toLowerCase();
    if (needles.some((n) => hay.includes(n))) { mine += Number(count) || 0; matchedAuthor ||= `${name} <${email}>`; }
  }

  if (!mine) {
    log("note", `${total} commit(s), none attributable to ${who.login || "you"} — recorded as a project you worked with, not one you wrote.`);
    return { total, mine: 0, share: 0, firstAt: "", lastAt: "", areas: [], identified: false };
  }

  const range = ["log", `--author=${matchedAuthor.split("<")[1]?.replace(">", "") || who.email || who.login || ""}`, "--pretty=%ad", "--date=short"];
  const dates = (git(range, dir) || "").split("\n").filter(Boolean);
  const firstAt = dates[dates.length - 1] || "";
  const lastAt = dates[0] || "";

  // which parts of the tree they touched, most-edited first
  const files = (git([...range.slice(0, 2), "--name-only", "--pretty=format:"], dir) || "").split("\n").filter(Boolean);
  const dirs: Record<string, number> = {};
  for (const f of files) {
    const top = f.split("/").slice(0, 2).join("/");
    if (top) dirs[top] = (dirs[top] || 0) + 1;
  }
  const areas = Object.entries(dirs).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([d]) => d);

  const share = Math.round((mine / total) * 100);
  log("result", `${mine} of ${total} commit(s) are yours (${share}%)${firstAt ? ` · ${firstAt} → ${lastAt}` : ""}`);
  return { total, mine, share, firstAt, lastAt, areas, identified: true };
}

/** The facts, as prose the analyzer can read alongside the code. */
export function repoContext(meta: RepoMeta, c: Contribution | null): string {
  const langs = meta.languages.slice(0, 6).map((l) => l.name).join(", ");
  const lines = [
    `This is the GitHub repository ${meta.slug} (${meta.visibility.toLowerCase()}).`,
    meta.description ? `Its own description: ${meta.description}` : "",
    langs ? `Languages by volume: ${langs}.` : "",
    meta.topics.length ? `Topics: ${meta.topics.join(", ")}.` : "",
    meta.stars ? `${meta.stars} star(s).` : "",
    meta.createdAt ? `Created ${meta.createdAt.slice(0, 10)}, last pushed ${meta.pushedAt.slice(0, 10)}.` : "",
  ];
  if (c?.identified) {
    lines.push(
      `THE CANDIDATE'S OWN CONTRIBUTION: ${c.mine} of ${c.total} commits (${c.share}%)` +
        (c.firstAt ? `, between ${c.firstAt} and ${c.lastAt}` : "") + ".",
      c.areas.length ? `They worked mostly in: ${c.areas.join(", ")}.` : "",
      c.share >= 80
        ? "At that share, treat this as their own project."
        : c.share >= 25
          ? "A substantial share of a shared codebase — write bullets about their part, never the whole repo."
          : "A minority contribution. Bullets must be scoped to what they actually touched, and must not imply ownership of the project."
    );
  } else if (c) {
    lines.push(
      `The candidate has no commits under their GitHub identity in the cloned history (${c.total} commit(s) total).`,
      "Do not claim authorship. Describe it as a codebase they worked with, and ask what their role was."
    );
  }
  return lines.filter(Boolean).join(" ");
}
