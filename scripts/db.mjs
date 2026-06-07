// Shared DB helper for node scripts (seed + upsert). Plain ESM so launchd/claude
// headless can run it without a build step. The RR7 app uses app/db.server.ts,
// which talks to the SAME sqlite file and schema.
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

export const DB_PATH = process.env.JOBS_DB_PATH || resolve(ROOT, "data", "jobs.db");
const SCHEMA = readFileSync(resolve(HERE, "schema.sql"), "utf8");

export function openDb() {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  return db;
}

export function setMeta(db, key, value) {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, String(value));
}

export function getMeta(db, key) {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
  return row ? row.value : null;
}

const VALID_CATEGORY = new Set(["high", "medium", "stretch"]);

function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function jobId(company, role) {
  return `${slugify(company)}--${slugify(role)}`;
}

// Upsert an array of job objects. Returns { inserted, updated, errors }.
// User-owned columns (status, notes) and first_seen are preserved on update.
export function upsertJobs(db, jobs, now = new Date().toISOString()) {
  const existing = db.prepare("SELECT id FROM jobs WHERE id = ?");
  const insert = db.prepare(`
    INSERT INTO jobs
      (id, company, role, category, fit_score, stack, eligibility, seniority,
       apply_url, source, closes_at, active, first_seen, last_seen, updated_at)
    VALUES
      (@id, @company, @role, @category, @fit_score, @stack, @eligibility, @seniority,
       @apply_url, @source, @closes_at, 1, @now, @now, @now)
  `);
  const update = db.prepare(`
    UPDATE jobs SET
      company=@company, role=@role, category=@category, fit_score=@fit_score,
      stack=@stack, eligibility=@eligibility, seniority=@seniority,
      apply_url=@apply_url, source=@source, closes_at=@closes_at,
      active=1, last_seen=@now, updated_at=@now
    WHERE id=@id
  `);

  let inserted = 0,
    updated = 0;
  const errors = [];

  const run = db.transaction((rows) => {
    for (const raw of rows) {
      try {
        const company = (raw.company || "").trim();
        const role = (raw.role || "").trim();
        const category = (raw.category || "").trim().toLowerCase();
        const apply_url = (raw.apply_url || raw.url || "").trim();
        if (!company || !role) throw new Error("missing company/role");
        if (!VALID_CATEGORY.has(category))
          throw new Error(`bad category "${category}"`);
        if (!/^https?:\/\//.test(apply_url))
          throw new Error("apply_url must be http(s)");

        let fit = Number(raw.fit_score);
        if (!Number.isFinite(fit)) fit = 0;
        fit = Math.max(0, Math.min(100, Math.round(fit)));

        const row = {
          id: raw.id || jobId(company, role),
          company,
          role,
          category,
          fit_score: fit,
          stack: (raw.stack || "").trim() || null,
          eligibility: (raw.eligibility || "").trim() || null,
          seniority: (raw.seniority || "").trim() || null,
          apply_url,
          source: (raw.source || "").trim() || null,
          closes_at: (raw.closes_at || "").trim() || null,
          now,
        };

        if (existing.get(row.id)) update.run(row);
        else {
          insert.run(row);
          inserted++;
          continue;
        }
        updated++;
      } catch (e) {
        errors.push({ job: `${raw.company} / ${raw.role}`, error: e.message });
      }
    }
  });

  run(jobs);
  return { inserted, updated, errors };
}

// Mark jobs not seen in the current crawl as inactive (soft-delete). We keep the
// row so the user's status/notes survive and history is preserved.
export function deactivateMissing(db, now) {
  const info = db
    .prepare("UPDATE jobs SET active = 0 WHERE last_seen < ? AND active = 1")
    .run(now);
  return info.changes;
}
