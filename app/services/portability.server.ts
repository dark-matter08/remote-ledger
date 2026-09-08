// Moving to another machine.
//
// Everything lives in one SQLite file on one laptop, which is the point of the app
// and also the reason a new laptop starts empty. This writes what you have collected
// to a single file, and reads it back on the other side.
//
// Two rules shape the whole thing:
//
//   1. Secrets never leave, even into a file you asked for. The `secrets` table is
//      not read here at all — not filtered downstream, not read. An export names what
//      it left out, so the new machine tells you which keys to re-enter rather than
//      looking like it worked and failing on the first crawl.
//
//   2. It refuses a file it does not understand rather than guessing. A future
//      version's export can carry columns this code has never seen; writing those in
//      by position or by name-that-happens-to-match is how an import quietly corrupts
//      a database instead of declining to touch it.
import { gzipSync, gunzipSync } from "node:zlib";
import { getDb, transaction } from "../sqlite.server";
import { takeBackup } from "./backup.server";

/** Bumped when a table's shape changes in a way an older reader could not handle. */
export const EXPORT_VERSION = 1;

/**
 * What travels, in the order it must be written — parents before the rows that
 * reference them, so a merge never inserts a child whose parent is not there yet.
 */
const TABLES = [
  "profiles",
  "companies",
  "jobs",
  "applications",
  "application_events",
  "resume_profiles",
  "resume_versions",
  "kb_items",
  "kb_questions",
  "kb_sources",
  "answer_bank",
  "apply_questions",
  "job_blocks",
  "email_accounts",
  "settings",
  "meta",
] as const;

/**
 * What does not, and why. Kept as data rather than prose so the export can show it.
 */
export const OMITTED: Record<string, string> = {
  secrets: "API keys and email passwords — re-enter them on the new machine",
  llm_calls: "the cost ledger, which belongs to the machine that spent it",
  crawl_runs: "crawl history",
  crawl_logs: "crawl logs",
  apply_sessions: "in-flight apply sessions",
  apply_session_jobs: "in-flight apply sessions",
  apply_logs: "apply logs",
  kb_suggestions: "undecided draft bullets",
  kb_scans: "folder scans, which point at paths this machine has",
  email_messages: "synced mail, which the accounts re-fetch",
  "data/pdfs": "rendered PDFs — remade on demand from the versions that do travel",
};

/** Rows whose values could be a credential in disguise, whatever the table says. */
const SETTING_LOOKS_SECRET = /key|token|secret|password|credential/i;

export interface ExportFile {
  format: "remote-ledger-export";
  version: number;
  created_at: string;
  profile_id: string | null;
  omitted: Record<string, string>;
  counts: Record<string, number>;
  tables: Record<string, Record<string, unknown>[]>;
}

/** Which column, if any, ties a table to one profile. */
const PROFILE_COLUMN: Record<string, string> = { profiles: "id", jobs: "profile_id", companies: "profile_id" };

function columns(table: string): string[] {
  return (getDb().prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

function tableExists(table: string): boolean {
  return !!getDb().prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
}

/**
 * Read everything out.
 *
 * `profileId` narrows it to one search and the postings under it — the shape you want
 * when handing one search to another machine rather than the whole install. The rows
 * that are not tied to a profile (the knowledge base, the answer bank) travel either
 * way: they describe you, not the search.
 */
export function exportData(profileId?: string): ExportFile {
  const db = getDb();
  const tables: Record<string, Record<string, unknown>[]> = {};
  const counts: Record<string, number> = {};

  for (const t of TABLES) {
    if (!tableExists(t)) continue;
    const col = profileId ? PROFILE_COLUMN[t] : undefined;
    const rows = (
      col
        ? db.prepare(`SELECT * FROM ${t} WHERE ${col} = ?`).all(profileId)
        : db.prepare(`SELECT * FROM ${t}`).all()
    ) as Record<string, unknown>[];

    // A job's application travels with the job it belongs to, or a narrowed export
    // arrives as postings with no history — which looks like data loss and is.
    const kept =
      profileId && (t === "applications" || t === "application_events" || t === "resume_versions" || t === "apply_questions")
        ? rows.filter((r) => jobIdsFor(profileId).has(String(r.job_id ?? "")))
        : rows;

    tables[t] =
      t === "settings"
        ? kept.filter((r) => !SETTING_LOOKS_SECRET.test(String(r.key ?? "")))
        : t === "email_accounts"
          ? kept.map((r) => ({ ...r, password: null })) // the password lives in `secrets`; make the absence explicit
          : kept;
    counts[t] = tables[t].length;
  }

  return {
    format: "remote-ledger-export",
    version: EXPORT_VERSION,
    created_at: new Date().toISOString(),
    profile_id: profileId ?? null,
    omitted: OMITTED,
    counts,
    tables,
  };
}

let jobIdCache: { profile: string; ids: Set<string> } | null = null;
function jobIdsFor(profileId: string): Set<string> {
  if (jobIdCache?.profile === profileId) return jobIdCache.ids;
  const ids = new Set(
    (getDb().prepare("SELECT id FROM jobs WHERE profile_id=?").all(profileId) as { id: string }[]).map((r) => String(r.id))
  );
  jobIdCache = { profile: profileId, ids };
  return ids;
}

export function exportGzip(profileId?: string): Buffer {
  jobIdCache = null;
  return gzipSync(Buffer.from(JSON.stringify(exportData(profileId)), "utf8"));
}

export function exportFilename(profileId?: string): string {
  const day = new Date().toISOString().slice(0, 10);
  return `remote-ledger-${profileId ? `${profileId}-` : ""}${day}.json.gz`;
}

export interface ImportResult {
  ok: boolean;
  message: string;
  inserted: Record<string, number>;
  skipped: Record<string, number>;
}

export function readExport(buf: Buffer): ExportFile {
  const text = buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf).toString("utf8") : buf.toString("utf8");
  const parsed = JSON.parse(text) as ExportFile;
  if (parsed?.format !== "remote-ledger-export") throw new Error("that is not a Remote Ledger export");
  if (typeof parsed.version !== "number") throw new Error("the file does not say which version it is");
  if (parsed.version > EXPORT_VERSION) {
    throw new Error(
      `that file was written by a newer version (${parsed.version}; this reads ${EXPORT_VERSION}). Update first — this will not guess at columns it has never seen.`
    );
  }
  return parsed;
}

/**
 * Write it in.
 *
 * `merge` adds what is not already here and leaves everything else alone, so running
 * the same import twice does nothing the second time. `replace` empties the tables it
 * is about to write first — and takes a backup before it does, because that is the one
 * operation here you cannot undo by re-importing.
 */
export function importData(file: ExportFile, mode: "merge" | "replace" = "merge"): ImportResult {
  const db = getDb();
  const inserted: Record<string, number> = {};
  const skipped: Record<string, number> = {};

  if (mode === "replace") takeBackup("before an import that replaces");

  transaction(() => {
    for (const t of TABLES) {
      const rows = file.tables?.[t];
      if (!rows?.length || !tableExists(t)) continue;

      // Only columns this database actually has. A newer export may carry more; those
      // are dropped rather than guessed at, which is the whole reason for the version
      // check above being a refusal and this being a filter.
      const mine = new Set(columns(t));
      const cols = Object.keys(rows[0]).filter((c) => mine.has(c));
      if (!cols.length) continue;

      if (mode === "replace") db.prepare(`DELETE FROM ${t}`).run();

      const sql =
        `INSERT ${mode === "merge" ? "OR IGNORE " : ""}INTO ${t} (${cols.join(",")}) ` +
        `VALUES (${cols.map(() => "?").join(",")})`;
      const stmt = db.prepare(sql);
      let n = 0;
      let miss = 0;
      for (const r of rows) {
        try {
          const res = stmt.run(...(cols.map((c) => (r[c] === undefined ? null : r[c])) as never[]));
          if (res.changes) n++;
          else miss++;
        } catch {
          miss++; // a row that clashes on something OR IGNORE cannot see is skipped, not fatal
        }
      }
      inserted[t] = n;
      if (miss) skipped[t] = miss;
    }
  });

  const total = Object.values(inserted).reduce((a, b) => a + b, 0);
  const keysMissing = Object.keys(file.omitted || {}).length > 0;
  return {
    ok: true,
    inserted,
    skipped,
    message:
      `Imported ${total} row(s).` +
      (keysMissing ? " Your API keys and email passwords were not in the file — re-enter them in Settings." : ""),
  };
}
