// Keep a few recent copies of the ledger, automatically.
//
// Everything in this app is one SQLite file, and a fair amount of what it does is
// destructive by design: trashing a job, purging a knowledge-base source, an update
// that discards local changes, a merge that folds duplicate rows together. Each of
// those has been safe so far because a backup was taken by hand first — which only
// works while someone remembers.
//
// VACUUM INTO rather than copying the file: the app runs in WAL mode, so the bytes on
// disk are not the database. A plain `cp` of jobs.db silently misses whatever is
// still in the write-ahead log, which is exactly the recent work worth keeping.
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { writeFileSync } from "node:fs";
import { getDb, DB_PATH, getSetting } from "../sqlite.server";

const KEEP_DEFAULT = 10;
const EVERY_HOURS_DEFAULT = 6; // an automatic backup is not worth taking hourly

const num = (key: string, fallback: number, min: number, max: number) => {
  const n = Number(getSetting(key) || "");
  return Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : fallback;
};

/** How many to keep, how often, and where — all overridable in Settings → Data. */
export const backupKeep = () => num("backup_keep", KEEP_DEFAULT, 1, 200);
export const backupEveryHours = () => num("backup_every_hours", EVERY_HOURS_DEFAULT, 1, 24 * 14);

/**
 * Where the .db snapshots go. A custom folder is honoured, but never silently: if it
 * cannot be written the caller falls back to the default rather than skipping the
 * backup, because a backup that did not happen is worse than one in the wrong place.
 */
export const backupDir = () => (getSetting("backup_dir") || "").trim() || resolve(dirname(DB_PATH), "backups");

export interface BackupInfo {
  path: string;
  at: string;
  bytes: number;
}

export function listBackups(): BackupInfo[] {
  const dir = backupDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith("jobs-") && f.endsWith(".db"))
    .map((f) => {
      const p = join(dir, f);
      const s = statSync(p);
      return { path: p, at: s.mtime.toISOString(), bytes: s.size };
    })
    .sort((a, b) => b.at.localeCompare(a.at));
}

/**
 * Take one, and keep the newest KEEP.
 *
 * `reason` goes in the filename so a backup taken before something destructive is
 * distinguishable from the routine one — that is the copy you actually want when
 * you come looking.
 */
export function takeBackup(reason = "auto"): BackupInfo | null {
  try {
    const dir = backupDir();
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safe = reason.replace(/[^a-z0-9-]+/gi, "-").slice(0, 40) || "auto";
    const path = join(dir, `jobs-${stamp}-${safe}.db`);
    // single-quoted SQL literal; the path is ours, but keep it unquotable anyway
    getDb().exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);

    for (const old of listBackups().slice(backupKeep())) {
      try { rmSync(old.path, { force: true }); } catch {}
    }
    const s = statSync(path);
    return { path, at: s.mtime.toISOString(), bytes: s.size };
  } catch (e) {
    console.error("[backup] failed:", e);
    return null;
  }
}

/** Scheduler hook: at most one automatic backup per configured interval. */
export function runDueBackup(): void {
  const newest = listBackups()[0];
  if (newest && Date.now() - Date.parse(newest.at) < backupEveryHours() * 3600 * 1000) return;
  const b = takeBackup("auto");
  if (b) console.log(`[backup] ${b.path} (${Math.round(b.bytes / 1024)}KB)`);
  writeScheduledExport();
}

/**
 * Also drop a portable export in a folder you chose, on the same schedule.
 *
 * The .db snapshots above are for this machine — same SQLite file, same version. This
 * is the one you can carry to another laptop, so it belongs somewhere you actually
 * sync or back up rather than inside the app's own data directory.
 *
 * It carries no keys, for the same reason the manual export does not: see
 * portability.server.ts, where the secrets table is never read.
 */
export function writeScheduledExport(): string | null {
  const dir = (getSetting("backup_export_dir") || "").trim();
  if (!dir) return null;
  try {
    mkdirSync(dir, { recursive: true });
    // required lazily: portability imports this module for its pre-import backup, and
    // importing it at the top would be a cycle
    const { exportGzip, exportFilename } = require("./portability.server") as typeof import("./portability.server");
    const path = join(dir, exportFilename());
    writeFileSync(path, exportGzip());
    console.log(`[backup] portable export -> ${path}`);
    return path;
  } catch (e) {
    console.error("[backup] portable export failed:", e);
    return null;
  }
}
