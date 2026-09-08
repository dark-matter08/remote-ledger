// Single shared SQLite connection + schema bootstrap for the whole app. Uses the
// built-in node:sqlite module, so the project has zero native dependencies and
// installs without a compiler. All server modules import getDb() from here so
// there is exactly one connection.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { urlKey } from "./job-identity";
import { DEFAULT_BOARDS } from "./default-boards";

export const DB_PATH =
  process.env.JOBS_DB_PATH || resolve(process.cwd(), "data", "jobs.db");
const SCHEMA_PATH = resolve(process.cwd(), "scripts", "schema.sql");

// node:sqlite types .get()/.all() as `Record<string, SQLOutputValue>`, which rejects
// the direct `as SomeRow` casts the data layer uses at ~130 call sites.
// better-sqlite3 returned `unknown`, so widen back to that at this one boundary:
// every call site keeps its own explicit cast, exactly as before.
export interface Stmt {
  get(...params: any[]): unknown;
  all(...params: any[]): unknown[];
  run(...params: any[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}
export interface Db {
  prepare(sql: string): Stmt;
  exec(sql: string): void;
}

declare global {
  // eslint-disable-next-line no-var
  var __ledgerDb: Db | undefined;
}

function ensureColumn(db: Db, table: string, col: string, type: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
}

export function getDb(): Db {
  if (global.__ledgerDb) return global.__ledgerDb;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH) as unknown as Db;
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  // migrations for DBs created before a column existed
  ensureColumn(db, "jobs", "jd", "TEXT");
  ensureColumn(db, "jobs", "jd_html", "TEXT"); // sanitized rich JD (rendered in Heritage Press)
  try { ensureColumn(db, "email_messages", "interview_at", "TEXT"); } catch {} // phase-2 (table may not exist yet on very old DBs)
  try { ensureColumn(db, "email_messages", "company", "TEXT"); } catch {} // store classified company/role for re-matching
  try { ensureColumn(db, "email_messages", "role", "TEXT"); } catch {}
  try { ensureColumn(db, "kb_sources", "depth", "TEXT"); } catch {} // scan depth: quick | standard | deep
  try { ensureColumn(db, "kb_sources", "link_item_id", "INTEGER"); } catch {} // link a scan to an existing KB item
  try { ensureColumn(db, "kb_suggestions", "cluster_id", "INTEGER"); } catch {} // group near-duplicate drafted bullets
  try { ensureColumn(db, "kb_items", "context", "TEXT"); } catch {} // your own facts, fed to AI drafts
  try { ensureColumn(db, "companies", "kind", "TEXT NOT NULL DEFAULT 'company'"); } catch {} // company | board
  // Stable identity for a posting, so a reworded title cannot mint a second row.
  // See app/job-identity.ts for why the company--role slug could never do this job.
  try {
    ensureColumn(db, "jobs", "url_key", "TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_url_key ON jobs(url_key)");
    const missing = db.prepare("SELECT id, apply_url FROM jobs WHERE url_key IS NULL").all() as {
      id: string;
      apply_url: string;
    }[];
    if (missing.length) {
      const set = db.prepare("UPDATE jobs SET url_key=? WHERE id=?");
      for (const r of missing) {
        const k = urlKey(String(r.apply_url || ""));
        if (k) set.run(k, String(r.id));
      }
    }
  } catch {}
  // ── profiles ────────────────────────────────────────────────────────────────
  //
  // One profile per line of work. Before this there was one search, held as three
  // settings rows, and a second line of work meant overwriting the first.
  //
  // The migration is careful in one specific way: it adopts the existing search
  // rather than inventing a profile beside it. Every job and every company already
  // on this machine belongs to that adopted profile, so nothing an install has
  // collected becomes unreachable the moment it updates.
  try {
    ensureColumn(db, "jobs", "profile_id", "TEXT NOT NULL DEFAULT 'default'");
    ensureColumn(db, "companies", "profile_id", "TEXT NOT NULL DEFAULT 'default'");
    ensureColumn(db, "profiles", "last_crawled_at", "TEXT");
    ensureColumn(db, "crawl_runs", "profile_id", "TEXT");
    ensureColumn(db, "crawl_runs", "job_id", "TEXT"); // autopilot runs belong to a posting
    db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_profile ON jobs(profile_id)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_companies_profile ON companies(profile_id)");
    // Deliberately NOT unique. Two profiles may hold the same posting — that is the
    // chosen model — and within one profile upsertJobs already guarantees one row per
    // url_key. A unique index would add nothing there and take something away: it
    // makes the legacy-duplicate state unrepresentable, and installs from before
    // url_key existed still carry it. On those, creating the index throws, this catch
    // swallows it, and the result is no enforcement and no warning — while the fold
    // that exists to repair them can no longer run either.
    //
    // Application code can heal a duplicate. An index can only refuse to admit one.
    db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_profile_url_key ON jobs(profile_id, url_key)");

    const have = db.prepare("SELECT count(*) AS n FROM profiles").get() as { n: number };
    if (!have.n) {
      const get = (k: string) =>
        (db.prepare("SELECT value FROM settings WHERE key=?").get(k) as { value?: string } | undefined)?.value || "";
      const field = get("profile_field") || "software";
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO profiles (id, name, field, location, stack, active, sort_order, created_at, updated_at)
         VALUES ('default', ?, ?, ?, ?, 1, 0, ?, ?)`
      ).run(get("profile_stack") ? "My search" : "My search", field, get("profile_location"), get("profile_stack"), now, now);
    }
  } catch {}

  // company-experience metadata (a company scan = ONE experience entry, not N projects)
  for (const t of ["kb_items", "kb_sources"]) {
    try { ensureColumn(db, t, "role", "TEXT"); } catch {}
    try { ensureColumn(db, t, "start_date", "TEXT"); } catch {}
    try { ensureColumn(db, t, "end_date", "TEXT"); } catch {}
    try { ensureColumn(db, t, "location", "TEXT"); } catch {}
  }
  // which process owns an in-flight run (see reconcileOrphans)
  try { ensureColumn(db, "crawl_runs", "owner_pid", "INTEGER"); } catch {}
  // which posting a résumé profile was assembled for, so progress on the guided flow
  // is a fact rather than a match on a name the user is free to change
  try { ensureColumn(db, "resume_profiles", "built_for_job_id", "TEXT"); } catch {}
  // Which runner served a run. "It found nothing" and "it found nine things that
  // were not real" are the same row in the history until you can see what answered.
  try {
    ensureColumn(db, "crawl_runs", "runner", "TEXT");
    ensureColumn(db, "crawl_runs", "model", "TEXT");
    backfillCrawlRunners(db);
  } catch {}
  try { ensureColumn(db, "apply_sessions", "owner_pid", "INTEGER"); } catch {}
  seedDefaultBoards(db);
  reconcileOrphans(db);
  global.__ledgerDb = db;
  return db;
}

// The shipped job boards (app/default-boards.ts), recorded per URL rather than
// behind one "already seeded" flag. That distinction is the whole design: a board
// you delete from the Companies tab stays deleted across restarts, while a board
// added to DEFAULT_BOARDS in a later release still reaches a ledger that already
// exists. Runs inside getDb(), so it cannot use getSetting() — that would recurse
// back into the connection being built.
function seedDefaultBoards(db: Db) {
  const row = db.prepare("SELECT value FROM settings WHERE key='seeded_boards'").get() as
    | { value: string }
    | undefined;
  let seeded: string[] = [];
  try {
    if (row) seeded = JSON.parse(row.value);
  } catch {}
  const done = new Set(Array.isArray(seeded) ? seeded : []);
  const fresh = DEFAULT_BOARDS.filter((b) => !done.has(b.url));
  if (!fresh.length) return;

  // Someone may already track a default by hand (the registry has no unique index on
  // careers_url, so nothing else would stop a second copy appearing).
  const exists = db.prepare("SELECT 1 FROM companies WHERE careers_url=?");
  const insert = db.prepare(
    "INSERT INTO companies (name,kind,ats,slug,careers_url,active,note,created_at) VALUES (?,'board',NULL,NULL,?,1,?,?)"
  );
  const now = new Date().toISOString();
  for (const b of fresh) {
    if (!exists.get(b.url)) insert.run(b.name, b.url, b.note, now);
    done.add(b.url);
  }
  db.prepare(
    "INSERT INTO settings (key,value) VALUES ('seeded_boards',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).run(JSON.stringify([...done]));
}

/**
 * Put the shipped boards back after a reset.
 *
 * seedDefaultBoards runs once, inside getDb(), and the connection is memoised for the
 * life of the process — so clearing the registry through Settings would otherwise
 * leave an install with nowhere to look until it was restarted.
 */
export function reseedDefaultBoards(): void {
  seedDefaultBoards(getDb());
}

// Older runs never recorded a runner, but llm_calls did — and a call inside a run's
// own window belongs to it. Cheaper than leaving the whole history blank, and it
// only ever fills a column that is still null.
function backfillCrawlRunners(db: Db) {
  db.exec(`
    UPDATE crawl_runs SET
      runner = COALESCE(runner, (
        SELECT c.runner FROM llm_calls c
        WHERE c.ts >= crawl_runs.started_at
          AND c.ts <= COALESCE(crawl_runs.ended_at, crawl_runs.started_at)
        ORDER BY c.ts LIMIT 1)),
      model = COALESCE(model, (
        SELECT c.model FROM llm_calls c
        WHERE c.ts >= crawl_runs.started_at
          AND c.ts <= COALESCE(crawl_runs.ended_at, crawl_runs.started_at)
        ORDER BY c.ts LIMIT 1))
    WHERE runner IS NULL AND ended_at IS NOT NULL`);
}

// A PID we recorded may belong to a process that has since exited. EPERM means it
// exists but isn't ours, which still counts as alive.
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

// Backstop for the one case PID liveness can't catch: the owner died and the OS
// recycled its PID onto an unrelated process. Far longer than any real crawl
// (crawl_timeout_min maxes out well under this).
const STALE_RUN_MS = 12 * 60 * 60 * 1000;

// Reconcile runs orphaned by a process that died mid-flight. Runs once per process
// at connection creation, before any new crawl/session can start.
//
// This must NOT touch a run that is live in a DIFFERENT process: `npm run crawl`
// (and the OS scheduler that shells out to it) opens its own connection while the
// app may be mid-crawl, and blanket-resetting every status='running' row would mark
// the app's live crawl as interrupted and release the isCrawlRunning() guard,
// letting a second crawl start on top of the first. So only reset a row when its
// owning process is actually gone.
function reconcileOrphans(db: Db): void {
  const tables = [
    { name: "crawl_runs", status: "error", note: true },
    { name: "apply_sessions", status: "stopped", note: false },
  ] as const;
  for (const t of tables) {
    try {
      const rows = db
        .prepare(`SELECT id, owner_pid, started_at FROM ${t.name} WHERE status='running'`)
        .all() as { id: number; owner_pid: number | null; started_at: string | null }[];
      for (const r of rows) {
        const pid = r.owner_pid == null ? null : Number(r.owner_pid);
        if (pid === process.pid) continue; // ours, and still running
        const started = r.started_at ? Date.parse(r.started_at) : NaN;
        const stale = Number.isFinite(started) && Date.now() - started > STALE_RUN_MS;
        // owner_pid IS NULL => row predates this column, so it is genuinely orphaned
        const orphaned = pid == null || !pidAlive(pid) || stale;
        if (!orphaned) continue;
        const sql = t.note
          ? `UPDATE ${t.name} SET status=?, ended_at=datetime('now'), note='interrupted (restarted)' WHERE id=?`
          : `UPDATE ${t.name} SET status=?, ended_at=datetime('now') WHERE id=?`;
        db.prepare(sql).run(t.status, r.id);
      }
    } catch {}
  }
}

// node:sqlite has no db.transaction() (better-sqlite3 did), so wrap BEGIN/COMMIT by
// hand. Not re-entrant: callers must not nest transaction() calls.
export function transaction<T>(fn: () => T): T {
  const db = getDb();
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw e;
  }
}

// generic settings helpers (separate from `meta`, which is crawl bookkeeping)
export function getSetting(key: string, fallback: string | null = null): string | null {
  const row = getDb().prepare("SELECT value FROM settings WHERE key=?").get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : fallback;
}

export function setSetting(key: string, value: string): void {
  getDb()
    .prepare(
      "INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    )
    .run(key, value);
}

export function getJson<T>(key: string, fallback: T): T {
  const v = getSetting(key);
  if (v == null) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

export function setJson(key: string, value: unknown): void {
  setSetting(key, JSON.stringify(value));
}
