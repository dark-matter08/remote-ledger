#!/usr/bin/env tsx
// Fold jobs that are the same posting under two ids.
//
// Before url_key identity, a crawl that reworded a title minted a second row — so a
// job you had already applied to came back looking new. This repairs the rows that
// already exist; upsertJobs stops it happening again.
//
//   pnpm dedupe:jobs            what it would do
//   pnpm dedupe:jobs --apply    do it
import { findDuplicateJobs, mergeDuplicateJobs } from "../app/db.server";

const apply = process.argv.includes("--apply");
const groups = findDuplicateJobs();

if (!groups.length) {
  console.log("  no duplicates — every posting has exactly one row.");
  process.exit(0);
}

console.log(`  ${groups.length} duplicate group(s), ${groups.reduce((n, g) => n + g.drop.length, 0)} row(s) to fold\n`);
for (const g of groups) {
  console.log(`  ${g.key.slice(0, 78)}`);
  console.log(`    keep  ${g.keep}   (${g.reason})`);
  for (const d of g.drop) console.log(`    fold  ${d}`);
}

if (!apply) {
  console.log("\n  dry run — nothing changed. Re-run with --apply to merge.");
  process.exit(0);
}

const res = mergeDuplicateJobs({ apply: true });
console.log(`\n  merged ${res.removed} row(s), moved ${res.moved} attached record(s).`);
