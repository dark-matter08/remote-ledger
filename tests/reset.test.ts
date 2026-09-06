// Settings → Danger zone: what "clear my system" actually clears.
//
// Its own file, and its own database, on purpose: every assertion here is about a
// table being empty afterwards, and sharing core.test.ts's DB would mean each of these
// deleted the rows the next test was counting on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";

const TEST_DIR = resolve(tmpdir(), `ledger-reset-${process.pid}`);
mkdirSync(resolve(TEST_DIR, "pdfs"), { recursive: true });
mkdirSync(resolve(TEST_DIR, "apply"), { recursive: true });
process.env.JOBS_DB_PATH = resolve(TEST_DIR, "jobs.db");
process.env.JOBS_MASTER_KEY = resolve(TEST_DIR, "master.key");

/** A ledger with something in every scope, so a reset has something to get wrong. */
async function seed() {
  const { getDb, setSetting } = await import("../app/sqlite.server");
  const { upsertJobs } = await import("../app/db.server");
  const db = getDb();
  const now = new Date().toISOString();
  // the crawl-guard test leaves one behind on purpose; every other test starts idle
  db.prepare("UPDATE crawl_runs SET status='done' WHERE status='running'").run();

  // through the real writer, so the row looks like one a crawl produced
  upsertJobs([{ id: "acme--dev", company: "Acme", role: "Dev", category: "high", fit_score: 80, apply_url: "https://acme.test/jobs/1", source: "test" }]);
  db.prepare("INSERT OR IGNORE INTO job_blocks (scope,value,reason,created_at) VALUES ('job','x--y','trashed',?)").run(now);
  for (const [k, v] of [["match:acme--dev", "{}"], ["last_crawl", "2026-01-01"], ["apply_resume_style", "ats-plain"]])
    db.prepare("INSERT OR REPLACE INTO meta (key,value) VALUES (?,?)").run(k, v);
  db.prepare("INSERT OR REPLACE INTO resume_profiles (id,name,is_default,data_json,created_at,updated_at) VALUES ('p1','Mine',1,'{}',?,?)").run(now, now);
  db.prepare("INSERT INTO kb_items (kind,title,created_at,updated_at) VALUES ('experience','A',?,?)").run(now, now);
  db.prepare("INSERT INTO crawl_runs (type,trigger,status,started_at,ended_at) VALUES ('find','test','done',?,?)").run(now, now);
  db.prepare("INSERT INTO llm_calls (ts,purpose,runner,model) VALUES (?,'misc','x','y')").run(now);
  setSetting("setup_complete", "true");
  setSetting("profile_location", "Somewhere");
  writeFileSync(resolve(TEST_DIR, "pdfs", "a.pdf"), "x");
  writeFileSync(resolve(TEST_DIR, "apply", "s.png"), "x");
}

const count = async (table: string, where = "") => {
  const { getDb } = await import("../app/sqlite.server");
  return Number(
    (getDb().prepare(`SELECT COUNT(*) c FROM ${table}${where ? ` WHERE ${where}` : ""}`).get() as any).c
  );
};

test("reset: a scope clears its own tables and nothing else's", async () => {
  await seed();
  const { performReset } = await import("../app/services/reset.server");

  const r = await performReset(["jobs"]);
  assert.equal(r.ok, true, r.message);
  assert.equal(await count("jobs"), 0);
  assert.equal(await count("job_blocks"), 0, "a trashed posting must be findable again");
  assert.equal(await count("meta", "key LIKE 'match:%'"), 0);
  assert.equal(await count("meta", "key='last_crawl'"), 0);

  // `meta` is a shared table. A preference living in it is not job data and must survive.
  assert.equal(await count("meta", "key='apply_resume_style'"), 1);
  assert.equal(await count("resume_profiles"), 1, "résumés are their own scope");
  assert.equal(await count("crawl_runs"), 1, "history is its own scope");
  assert.equal(await count("kb_items"), 1, "the knowledge base is its own scope");

  const { getSetting } = await import("../app/sqlite.server");
  assert.equal(getSetting("setup_complete"), "true", "clearing jobs must not eject you to the wizard");
  assert.equal(r.toSetup, false);
});

test("reset: files go with the rows that pointed at them", async () => {
  await seed();
  const { performReset } = await import("../app/services/reset.server");
  await performReset(["resumes", "jobs"]);
  assert.deepEqual(readdirSync(resolve(TEST_DIR, "pdfs")), []);
  assert.deepEqual(readdirSync(resolve(TEST_DIR, "apply")), []);
});

test("reset: a backup is taken before anything is deleted", async () => {
  await seed();
  const { performReset } = await import("../app/services/reset.server");
  const before = await count("jobs");
  assert.ok(before > 0);

  const r = await performReset(["jobs"]);
  assert.ok(r.backup, "no backup means no way back — the reset must not have happened");
  assert.ok(existsSync(r.backup!.path));
  assert.match(r.backup!.path, /before-reset/);

  // and the copy is a working ledger holding what was just deleted
  const { DatabaseSync } = await import("node:sqlite");
  const copy = new DatabaseSync(r.backup!.path, { readOnly: true }) as any;
  assert.equal(Number(copy.prepare("SELECT COUNT(*) c FROM jobs").get().c), before);
  copy.close();
});

test("reset: clearing the boards puts the shipped list back, never zero", async () => {
  await seed();
  const { performReset } = await import("../app/services/reset.server");
  const { DEFAULT_BOARDS } = await import("../app/default-boards");

  const r = await performReset(["boards"]);
  assert.equal(r.ok, true);
  // The seed marker names every board already inserted, and seeding skips what it
  // names. Clearing the registry without clearing the marker would empty it for good.
  assert.equal(await count("companies"), DEFAULT_BOARDS.length);
});

test("reset: clearing the settings does not resurrect a board you deleted", async () => {
  await seed();
  const { getDb, getSetting } = await import("../app/sqlite.server");
  const { performReset } = await import("../app/services/reset.server");
  const { DEFAULT_BOARDS } = await import("../app/default-boards");

  const gone = DEFAULT_BOARDS[0].url;
  getDb().prepare("DELETE FROM companies WHERE careers_url=?").run(gone);
  const kept = await count("companies");

  const r = await performReset(["settings"]);
  assert.equal(r.ok, true);
  assert.equal(r.toSetup, true, "the wizard is where you belong once the settings are gone");
  assert.equal(getSetting("setup_complete"), null);
  assert.equal(await count("companies"), kept, "the board list is not part of the settings scope");
  assert.equal(await count("companies", `careers_url='${gone}'`), 0, "a deletion has to stick");
});

test("reset: everything ticked leaves a ledger a new install would recognise", async () => {
  await seed();
  const { performReset, ALL_SCOPES } = await import("../app/services/reset.server");
  const { getSetting } = await import("../app/sqlite.server");
  const { DEFAULT_BOARDS } = await import("../app/default-boards");

  const r = await performReset(ALL_SCOPES);
  assert.equal(r.ok, true, r.message);
  assert.equal(r.toSetup, true);
  for (const t of ["jobs", "resume_profiles", "kb_items", "crawl_runs", "llm_calls", "secrets", "meta"])
    assert.equal(await count(t), 0, `${t} should be empty`);
  assert.equal(getSetting("setup_complete"), null);
  // the one thing that comes back, because it ships with the app rather than being yours
  assert.equal(await count("companies"), DEFAULT_BOARDS.length);
});

test("reset: nothing selected does nothing at all", async () => {
  await seed();
  const { performReset } = await import("../app/services/reset.server");
  const before = await count("jobs");
  const r = await performReset([]);
  assert.equal(r.ok, false);
  assert.equal(await count("jobs"), before);
});

test("reset: a crawl mid-flight blocks the clear rather than racing it", async () => {
  await seed();
  const { getDb } = await import("../app/sqlite.server");
  const { performReset } = await import("../app/services/reset.server");

  // A crawl holds its findings in memory and writes them when it finishes, so a wipe
  // that runs underneath one is undone seconds later by the crawl itself. Owned by
  // THIS process, so the orphan reconciler correctly leaves it alone.
  getDb()
    .prepare("INSERT INTO crawl_runs (type,trigger,status,started_at,owner_pid) VALUES ('find','test','running',datetime('now'),?)")
    .run(process.pid);

  const before = await count("jobs");
  const r = await performReset(["jobs"]);
  assert.equal(r.ok, false);
  assert.match(r.message, /crawl is still running/i);
  assert.equal(await count("jobs"), before, "not one row may go while a crawl could re-add them");
});

test("reset: clearing the inbox takes the mailbox passwords with it", async () => {
  await seed();
  const { setSecret, hasSecret } = await import("../app/secrets.server");
  const { performReset } = await import("../app/services/reset.server");

  setSecret("email_pw_1", "app-password");
  setSecret("openrouter_api_key", "sk-or-test");

  const r = await performReset(["email"]);
  assert.equal(r.ok, true, r.message);
  assert.equal(hasSecret("email_pw_1"), false, "a saved mailbox password is part of the mailbox");
  assert.equal(hasSecret("openrouter_api_key"), true, "and a provider key is not");
});

test("reset: the preview counts what is really there", async () => {
  await seed();
  const { resetPreview } = await import("../app/services/reset.server");
  const p = resetPreview();
  assert.equal(p.find((s) => s.id === "jobs")!.count, await count("jobs"));
  assert.equal(p.find((s) => s.id === "knowledge")!.count, await count("kb_items"));
  assert.ok(p.every((s) => s.what.length > 20), "every scope says what it takes");
});

process.on("exit", () => {
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
});
