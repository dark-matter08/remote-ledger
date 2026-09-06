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
import { getDb, DB_PATH } from "../sqlite.server";

const KEEP = 10;
const MIN_GAP_MS = 6 * 3600 * 1000; // an automatic backup is not worth taking hourly

export const backupDir = () => resolve(dirname(DB_PATH), "backups");

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

    for (const old of listBackups().slice(KEEP)) {
      try { rmSync(old.path, { force: true }); } catch {}
    }
    const s = statSync(path);
    return { path, at: s.mtime.toISOString(), bytes: s.size };
  } catch (e) {
    console.error("[backup] failed:", e);
    return null;
  }
}

/** Scheduler hook: at most one automatic backup per MIN_GAP_MS. */
export function runDueBackup(): void {
  const newest = listBackups()[0];
  if (newest && Date.now() - Date.parse(newest.at) < MIN_GAP_MS) return;
  const b = takeBackup("auto");
  if (b) console.log(`[backup] ${b.path} (${Math.round(b.bytes / 1024)}KB)`);
}
