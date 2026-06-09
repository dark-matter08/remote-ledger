// Single shared better-sqlite3 connection + schema bootstrap for the whole app.
// All server modules import getDb() from here so there is exactly one connection.
import Database from "better-sqlite3";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const DB_PATH =
  process.env.JOBS_DB_PATH || resolve(process.cwd(), "data", "jobs.db");
const SCHEMA_PATH = resolve(process.cwd(), "scripts", "schema.sql");

declare global {
  // eslint-disable-next-line no-var
  var __ledgerDb: Database.Database | undefined;
}

function ensureColumn(db: Database.Database, table: string, col: string, type: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
}

export function getDb(): Database.Database {
  if (global.__ledgerDb) return global.__ledgerDb;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  // migrations for DBs created before a column existed
  ensureColumn(db, "jobs", "jd", "TEXT");
  ensureColumn(db, "jobs", "jd_html", "TEXT"); // sanitized rich JD (rendered in Heritage Press)
  try { ensureColumn(db, "email_messages", "interview_at", "TEXT"); } catch {} // phase-2 (table may not exist yet on very old DBs)
  try { ensureColumn(db, "kb_sources", "depth", "TEXT"); } catch {} // scan depth: quick | standard | deep
  try { ensureColumn(db, "kb_sources", "link_item_id", "INTEGER"); } catch {} // link a scan to an existing KB item
  try { ensureColumn(db, "kb_suggestions", "cluster_id", "INTEGER"); } catch {} // group near-duplicate drafted bullets
  // company-experience metadata (a company scan = ONE experience entry, not N projects)
  for (const t of ["kb_items", "kb_sources"]) {
    try { ensureColumn(db, t, "role", "TEXT"); } catch {}
    try { ensureColumn(db, t, "start_date", "TEXT"); } catch {}
    try { ensureColumn(db, t, "end_date", "TEXT"); } catch {}
    try { ensureColumn(db, t, "location", "TEXT"); } catch {}
  }
  // reconcile runs orphaned by a previous process: this runs once per process at
  // connection creation, before any new crawl/session can start, so it never
  // touches a run that's live in THIS process.
  try {
    db.exec("UPDATE crawl_runs SET status='error', ended_at=datetime('now'), note='interrupted (restarted)' WHERE status='running'");
    db.exec("UPDATE apply_sessions SET status='stopped', ended_at=datetime('now') WHERE status='running'");
  } catch {}
  global.__ledgerDb = db;
  return db;
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
