// Upsert jobs from JSON into the DB. The 4-hour updater pipes claude's research
// output through here. Accepts a JSON array of job objects, OR an object
// { jobs: [...] }, from a file arg or stdin.
//
// Usage:
//   node scripts/upsert-jobs.mjs path/to/jobs.json
//   cat jobs.json | node scripts/upsert-jobs.mjs
//   node scripts/upsert-jobs.mjs --deactivate-missing   (also soft-delete stale)
import { readFileSync } from "node:fs";
import { openDb, upsertJobs, setMeta, getMeta, deactivateMissing, DB_PATH } from "./db.mjs";

function readInput() {
  const fileArg = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (fileArg) return readFileSync(fileArg, "utf8");
  return readFileSync(0, "utf8"); // stdin
}

function parseJobs(text) {
  // Be forgiving: if the model wrapped JSON in prose or ```json fences, extract it.
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  if (!t.startsWith("[") && !t.startsWith("{")) {
    const a = t.indexOf("["), o = t.indexOf("{");
    const start = a === -1 ? o : o === -1 ? a : Math.min(a, o);
    if (start > 0) t = t.slice(start);
    const lastA = t.lastIndexOf("]"), lastO = t.lastIndexOf("}");
    const end = Math.max(lastA, lastO);
    if (end !== -1) t = t.slice(0, end + 1);
  }
  const data = JSON.parse(t);
  return Array.isArray(data) ? data : data.jobs || [];
}

const deactivate = process.argv.includes("--deactivate-missing");

let jobs;
try {
  jobs = parseJobs(readInput());
} catch (e) {
  console.error("Failed to parse input JSON:", e.message);
  process.exit(1);
}

if (!Array.isArray(jobs) || jobs.length === 0) {
  console.error("No jobs found in input. Nothing to upsert. (DB left unchanged.)");
  process.exit(1);
}

const db = openDb();
const now = new Date().toISOString();

const { inserted, updated, errors } = upsertJobs(db, jobs, now);

// roll crawl markers forward so the app can flag rows new since the prior crawl
const prevLast = getMeta(db, "last_crawl");
if (prevLast) setMeta(db, "prev_crawl", prevLast);
setMeta(db, "last_crawl", now);
setMeta(db, "last_crawl_status", errors.length ? "partial" : "ok");
setMeta(db, "last_crawl_counts", JSON.stringify({ inserted, updated, errors: errors.length }));

let deactivated = 0;
if (deactivate) deactivated = deactivateMissing(db, now);

console.log(
  `[${now}] upsert -> ${DB_PATH}\n  received: ${jobs.length}  inserted: ${inserted}  updated: ${updated}  deactivated: ${deactivated}  errors: ${errors.length}`
);
if (errors.length) console.log(JSON.stringify(errors, null, 2));
db.close();
