// Single shared SQLite connection + schema bootstrap for the whole app. Uses the
// built-in node:sqlite module, so the project has zero native dependencies and
// installs without a compiler. All server modules import getDb() from here so
// there is exactly one connection.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

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
  // company-experience metadata (a company scan = ONE experience entry, not N projects)
  for (const t of ["kb_items", "kb_sources"]) {
    try { ensureColumn(db, t, "role", "TEXT"); } catch {}
    try { ensureColumn(db, t, "start_date", "TEXT"); } catch {}
    try { ensureColumn(db, t, "end_date", "TEXT"); } catch {}
    try { ensureColumn(db, t, "location", "TEXT"); } catch {}
  }
  // which process owns an in-flight run (see reconcileOrphans)
  try { ensureColumn(db, "crawl_runs", "owner_pid", "INTEGER"); } catch {}
  try { ensureColumn(db, "apply_sessions", "owner_pid", "INTEGER"); } catch {}
  reconcileOrphans(db);
  global.__ledgerDb = db;
  return db;
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
