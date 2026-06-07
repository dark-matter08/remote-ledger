// Seed the DB with the initial 26 researched jobs.
// Usage: node scripts/seed.mjs
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, upsertJobs, setMeta, getMeta, DB_PATH } from "./db.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const jobs = JSON.parse(readFileSync(resolve(HERE, "seed-jobs.json"), "utf8"));

const db = openDb();
const now = new Date().toISOString();

const { inserted, updated, errors } = upsertJobs(db, jobs, now);

// On a fresh seed, set both crawl markers to now so nothing shows as "new".
if (!getMeta(db, "last_crawl")) setMeta(db, "prev_crawl", now);
else setMeta(db, "prev_crawl", getMeta(db, "last_crawl"));
setMeta(db, "last_crawl", now);
setMeta(db, "last_crawl_status", "seed");

console.log(`Seeded ${DB_PATH}`);
console.log(`  inserted: ${inserted}  updated: ${updated}  errors: ${errors.length}`);
if (errors.length) console.log(JSON.stringify(errors, null, 2));
db.close();
