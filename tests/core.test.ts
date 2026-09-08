// Core logic tests — no network / no LLM. Run with: npm test
// Uses an isolated temp DB + master key so it never touches your real data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { mkdirSync, rmSync } from "node:fs";

// Its own directory, not bare $TMPDIR: the app puts sidecar files (the OpenRouter
// catalogue cache) next to the DB, and in a shared temp dir a real run of the app
// would seed them under the tests.
const TEST_DIR = resolve(tmpdir(), `ledger-test-${process.pid}`);
mkdirSync(TEST_DIR, { recursive: true });
process.env.JOBS_DB_PATH = resolve(TEST_DIR, "jobs.db");
process.env.JOBS_MASTER_KEY = resolve(TEST_DIR, "master.key");

function cleanup() {
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
}

test("pricing: known model cost, unknown null, token estimate", async () => {
  const { costFor, estimateTokens } = await import("../app/llm/pricing.server");
  const c = costFor("anthropic", "claude-sonnet-4-6", 1_000_000, 1_000_000);
  assert.ok(c && c > 0, "priced model returns a cost");
  assert.equal(costFor("anthropic", "claude-sonnet-4-6", 1_000_000, 0)!.toFixed(2), "3.00");
  assert.equal(costFor("nope", "nope", 1000, 1000), null, "unknown model -> null");
  assert.equal(estimateTokens("abcd".repeat(25)), 25);
});

test("secrets: encrypt/decrypt roundtrip + delete", async () => {
  const { setSecret, getSecret, hasSecret, deleteSecret } = await import("../app/secrets.server");
  setSecret("unit_test_key", "sk-secret-123");
  assert.equal(getSecret("unit_test_key"), "sk-secret-123");
  assert.equal(hasSecret("unit_test_key"), true);
  deleteSecret("unit_test_key");
  assert.equal(getSecret("unit_test_key"), null);
});

test("runner: tryParseJson extracts JSON from prose/fences", async () => {
  const { tryParseJson } = await import("../app/llm/runner.server");
  assert.deepEqual(tryParseJson('here it is:\n```json\n[{"a":1}]\n```'), [{ a: 1 }]);
  assert.deepEqual(tryParseJson('blah {"x":2} trailing'), { x: 2 });
  assert.equal(tryParseJson("not json"), null);
});

test("resume guard: flags invented employer + clean case", async () => {
  const { guardTailored } = await import("../app/resume/ai.server");
  const base = {
    contact: { name: "A" }, summary: "", skills: ["Node"],
    experience: [{ company: "Acme", role: "Eng", bullets: ["Built APIs with Node"] }],
    projects: [], education: [{ school: "Buea", degree: "BEng" }],
  } as any;
  const clean = JSON.parse(JSON.stringify(base));
  const cf = guardTailored(base, clean);
  assert.ok(cf.every((f: any) => f.severity === "info"), "identical resume = no warnings");

  const tampered = JSON.parse(JSON.stringify(base));
  tampered.experience.push({ company: "Google", role: "SWE", bullets: ["Led 5000 users"] });
  const tf = guardTailored(base, tampered);
  assert.ok(tf.some((f: any) => f.severity === "warn" && /Google/.test(f.message)), "flags new employer");
  assert.ok(tf.some((f: any) => /5000|Metrics/.test(f.message)), "flags invented metric");
});

test("db: upsert (insert+update), slug, stage + funnel", async () => {
  const { upsertJobs, jobId, setStage, funnel, getJob } = await import("../app/db.server");
  assert.equal(jobId("Reliance Health", "Backend Software Engineer"), "reliance-health--backend-software-engineer");

  const r1 = upsertJobs([{ company: "Acme", role: "Eng", category: "high", fit_score: 90, apply_url: "https://x.co" }]);
  assert.equal(r1.inserted, 1);
  const r2 = upsertJobs([{ company: "Acme", role: "Eng", category: "high", fit_score: 95, apply_url: "https://x.co" }]);
  assert.equal(r2.updated, 1, "same company+role upserts, not duplicates");
  assert.equal(getJob("acme--eng")!.fit_score, 95);

  // bad rows are rejected, not thrown
  const r3 = upsertJobs([{ company: "", role: "x", category: "high", apply_url: "https://x.co" }]);
  assert.equal(r3.errors.length, 1);

  setStage("acme--eng", "applied");
  assert.equal(getJob("acme--eng")!.stage, "applied");
  const f = funnel();
  assert.ok(f.applied >= 1, "funnel counts applied");
});

test("email: strict job matching never picks the wrong application", async () => {
  const { upsertJobs } = await import("../app/db.server");
  const { matchJob } = await import("../app/services/email.server");
  upsertJobs([
    { company: "Northwind", role: "Senior Frontend Engineer", category: "high", fit_score: 80, apply_url: "https://n.co/fe" },
    { company: "Northwind", role: "Backend Engineer", category: "high", fit_score: 80, apply_url: "https://n.co/be" },
    { company: "Globex", role: "Data Scientist", category: "high", fit_score: 80, apply_url: "https://g.co/ds" },
  ]);

  // exact company + role → exact, picks the RIGHT role (not the other Northwind job)
  const m1 = matchJob("Northwind", "Senior Frontend Engineer");
  assert.equal(m1?.strength, "exact");
  assert.equal(m1?.id, "northwind--senior-frontend-engineer");

  // exact company, NO role, but TWO roles at that company → ambiguous → no match (the bug)
  assert.equal(matchJob("Northwind", ""), null, "ambiguous company w/o role must not match");

  // a totally different company must never match
  assert.equal(matchJob("Initech", "Frontend Engineer"), null, "unrelated company → no match");

  // generic/too-short company token must not match anything
  assert.equal(matchJob("AI", "Engineer"), null, "too-generic company → no match");

  // single role at a company, no role given → safe exact match
  assert.equal(matchJob("Globex", "")?.strength, "exact");

  // a job you APPLIED to and then ARCHIVED must still match (the rejection-email bug)
  const { setStage, archiveJob } = await import("../app/db.server");
  upsertJobs([{ company: "Hooli", role: "Platform Engineer", category: "high", fit_score: 80, apply_url: "https://h.co/pe" }]);
  setStage("hooli--platform-engineer", "applied");
  archiveJob("hooli--platform-engineer"); // active=0, removed from pipeline
  const ma = matchJob("Hooli", "Platform Engineer");
  assert.equal(ma?.id, "hooli--platform-engineer", "archived+applied job still matches an email");
  assert.equal(ma?.strength, "exact");
});

test("kb: accepting a company-experience bullet creates ONE résumé experience entry", async () => {
  const { getDb } = await import("../app/sqlite.server");
  const { saveProfile, getDefaultProfile } = await import("../app/resume/profiles.server");
  const { acceptSuggestion } = await import("../app/services/kb.server");
  const db = getDb();

  saveProfile({ name: "Base", makeDefault: true, data: { contact: { name: "Ada" }, summary: "", skills: [], experience: [], projects: [], education: [] } });

  const now = new Date().toISOString();
  const itemId = Number(db.prepare(
    "INSERT INTO kb_items (kind,title,summary,tags,source,source_path,role,start_date,end_date,location,created_at,updated_at) VALUES ('experience','Acme Corp','',?,'scan','/tmp/acme','Senior Engineer','2021','2024','Remote',?,?)"
  ).run("[]", now, now).lastInsertRowid);
  const mk = (bullet: string) => Number(db.prepare(
    "INSERT INTO kb_suggestions (item_id,section,bullet,created_at) VALUES (?,?,?,?)"
  ).run(itemId, "experience", bullet, now).lastInsertRowid);
  const s1 = mk("Built the billing service handling subscriptions.");
  const s2 = mk("Led the data pipeline migration to streaming.");

  assert.ok(acceptSuggestion(s1).ok);
  assert.ok(acceptSuggestion(s2).ok);

  const exp = getDefaultProfile()!.data.experience;
  assert.equal(exp.length, 1, "two company bullets → ONE experience entry, not two");
  assert.equal(exp[0].company, "Acme Corp");
  assert.equal(exp[0].role, "Senior Engineer");
  assert.equal(exp[0].start, "2021");
  assert.equal(exp[0].end, "2024");
  assert.equal(exp[0].location, "Remote");
  assert.equal(exp[0].bullets.length, 2, "both bullets land under the one company");
  assert.equal(getDefaultProfile()!.data.projects.length, 0, "company bullets must NOT become projects");
});

test("crawl runs: reconcile only clears runs whose owning process is gone", async () => {
  const { spawn } = await import("node:child_process");
  const { getDb } = await import("../app/sqlite.server");
  const db = getDb();

  const insert = (pid: number | null) =>
    Number(
      db
        .prepare("INSERT INTO crawl_runs (type,started_at,status,trigger,owner_pid) VALUES (?,?,?,?,?)")
        .run("find", new Date().toISOString(), "running", "manual", pid).lastInsertRowid
    );

  // a real, still-alive process that is NOT us — stands in for `npm run crawl`
  // running while the app is open (the case that used to get clobbered)
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  await new Promise<void>((r) => child.once("spawn", () => r()));
  const liveId = insert(child.pid!);

  // a process that has already exited — a genuine orphan
  const gone = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise<void>((r) => gone.once("exit", () => r()));
  const deadId = insert(gone.pid!);

  // a row written before owner_pid existed — also a genuine orphan
  const legacyId = insert(null);

  // drop the cached handle so the next getDb() reconciles, as a new process would
  delete (global as any).__ledgerDb;
  const db2 = getDb();
  const statusOf = (id: number) =>
    (db2.prepare("SELECT status FROM crawl_runs WHERE id=?").get(id) as { status: string }).status;

  assert.equal(statusOf(liveId), "running", "a crawl live in ANOTHER process must survive");
  assert.equal(statusOf(deadId), "error", "a crawl whose owner exited is reset");
  assert.equal(statusOf(legacyId), "error", "a pre-owner_pid row is treated as orphaned");

  child.kill();
});

test("kb: a scan names an unlabelled folder, but never renames one you named", async () => {
  const { nameSourceFromScan } = await import("../app/services/kb.server");
  const { getDb } = await import("../app/sqlite.server");
  const { createCrawlRun, getCrawlRun } = await import("../app/db.server");
  const db = getDb();

  const mkSource = (label: string | null, path: string) =>
    Number(
      db
        .prepare("INSERT INTO kb_sources (path,label,kind,interval_hours,depth,created_at) VALUES (?,?,?,?,?,?)")
        .run(path, label, "project", 0, "deep", new Date().toISOString()).lastInsertRowid
    );
  const read = (id: number) => db.prepare("SELECT * FROM kb_sources WHERE id=?").get(id) as any;

  // a folder you added without typing a name gets the name the scan inferred
  const unnamed = mkSource(null, "/tmp/ledger-test-unnamed");
  const runA = createCrawlRun("scan", "kb");
  nameSourceFromScan(runA, read(unnamed), "The Ezz Show");
  assert.equal(read(unnamed).label, "The Ezz Show", "inferred name fills an empty label");
  assert.match(getCrawlRun(runA)!.note!, /^The Ezz Show · /, "crawl shell shows the name, not a bare path");

  // a name you typed yourself survives every future re-scan
  const named = mkSource("My Own Name", "/tmp/ledger-test-named");
  nameSourceFromScan(createCrawlRun("scan", "kb"), read(named), "Something Else");
  assert.equal(read(named).label, "My Own Name", "a label you set is never renamed by a scan");

  // nothing usable inferred -> leave it unnamed rather than writing junk
  const blank = mkSource(null, "/tmp/ledger-test-blank");
  nameSourceFromScan(createCrawlRun("scan", "kb"), read(blank), "   ");
  assert.equal(read(blank).label, null, "a blank title does not set a label");
});

test("style: strips AI tells without touching real content", async () => {
  const { stripAiTells, cleanResumeProse } = await import("../app/llm/style");

  // the headline complaint: em/en dashes used as prose punctuation
  assert.equal(
    stripAiTells("Built for a roster of ~15 \u2014 the dev DB holds fifteen \u2014 and it works."),
    "Built for a roster of ~15, the dev DB holds fifteen, and it works."
  );

  // date ranges are real typography, not a tell
  assert.equal(
    stripAiTells("At Acme (2021\u20132024) I led the rewrite \u2013 it cut latency 40%."),
    "At Acme (2021\u20132024) I led the rewrite, it cut latency 40%."
  );
  assert.match(stripAiTells("Shipped 2022\u2014Present."), /2022\u2014Present/);

  // numbers in prose must survive the range-parking pass
  assert.equal(
    stripAiTells("I recorded 89 point events across an 8-week season for 15 players."),
    "I recorded 89 point events across an 8-week season for 15 players."
  );

  // assistant preamble and sign-off
  assert.equal(stripAiTells("Certainly! I built the scoring engine. I hope this helps!"), "I built the scoring engine.");
  assert.equal(stripAiTells("Great question \u2014 I owned the API."), "I owned the API.");

  // stray markdown in what is meant to be plain text
  assert.equal(stripAiTells("I built the **room engine** and scoring."), "I built the room engine and scoring.");

  // idempotent: running it again is a no-op
  const once = stripAiTells("A roster of 15 \u2014 live at example.com.");
  assert.equal(stripAiTells(once), once);
  assert.equal(stripAiTells(""), "");

  // résumé: only prose is cleaned, identifiers are left exactly as written
  const r = cleanResumeProse({
    summary: "Engineer \u2014 I ship production systems.",
    experience: [{ company: "Acme \u2014 Inc", start: "2021", end: "2024", bullets: ["Led the rewrite \u2014 cut latency 40%."] }],
    projects: [],
  } as any) as any;
  assert.equal(r.summary, "Engineer, I ship production systems.");
  assert.equal(r.experience[0].bullets[0], "Led the rewrite, cut latency 40%.");
  assert.equal(r.experience[0].company, "Acme \u2014 Inc", "company names are the user's own text, never rewritten");
});

test("kb: per-project context is stored and survives a re-read", async () => {
  const { setItemContext, kbItems } = await import("../app/services/kb.server");
  const { getDb } = await import("../app/sqlite.server");
  const db = getDb();
  const now = new Date().toISOString();
  const id = Number(
    db
      .prepare("INSERT INTO kb_items (kind,title,summary,tags,source,source_path,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
      .run("project", "Ctx Test", "s", "[]", "manual", "/tmp/ledger-test-ctx", now, now).lastInsertRowid
  );

  setItemContext(id, "  Live at example.com. Roster of 15.  ");
  const read = () => (kbItems().find((i: any) => i.id === id) as any);
  assert.equal(read().context, "Live at example.com. Roster of 15.", "trimmed and persisted");

  setItemContext(id, "   ");
  assert.equal(read().context, null, "clearing it stores null, not an empty string");
});

test("trash: a blocked job cannot be resurrected by a later crawl", async () => {
  const { upsertJobs, trashJob, listBlocks, blocklistPrompt, getJob, unblock } = await import("../app/db.server");

  const mk = (company: string, role: string, url: string) => ({
    company, role, category: "high", fit_score: 80, apply_url: url,
  });

  // --- scope: just this posting -------------------------------------------
  upsertJobs([mk("Trashme Co", "Eng", "https://boards.example.com/1")]);
  assert.ok(getJob("trashme-co--eng"), "seeded");
  const one = trashJob("trashme-co--eng", { reason: "irrelevant", note: "wrong stack" });
  assert.equal(one.removed, 1);
  assert.equal(getJob("trashme-co--eng"), null, "the row is gone, not archived");

  // the crawl finds it again — it must NOT come back
  const again = upsertJobs([mk("Trashme Co", "Eng", "https://boards.example.com/1")]);
  assert.equal(again.inserted, 0, "a blocked posting is never re-inserted");
  assert.equal(again.blocked, 1, "and it is reported as blocked, not silently dropped");
  assert.equal(getJob("trashme-co--eng"), null);

  // --- scope: whole domain clears every posting from it --------------------
  upsertJobs([
    mk("Agency A", "Role One", "https://jobot.example/a"),
    mk("Agency A", "Role Two", "https://jobot.example/b"),
    mk("Agency B", "Role Three", "https://jobot.example/c"),
    mk("Real Employer", "Keep Me", "https://greenhouse.example/x"),
  ]);
  const dom = trashJob("agency-a--role-one", { reason: "agency", scope: "domain" });
  assert.equal(dom.scope, "domain");
  assert.equal(dom.removed, 3, "one action clears every posting on that host");
  assert.ok(getJob("real-employer--keep-me"), "a different host is untouched");

  const reCrawl = upsertJobs([mk("Agency C", "Brand New", "https://jobot.example/d")]);
  assert.equal(reCrawl.inserted, 0, "a NEW posting on a blocked domain is refused too");
  assert.equal(reCrawl.blocked, 1);

  // --- what the crawler is told -------------------------------------------
  const prompt = blocklistPrompt();
  assert.match(prompt, /DO NOT RETURN/i);
  assert.match(prompt, /jobot\.example/, "blocked domains are named");
  assert.match(prompt, /wrong stack/, "your own note is passed through");
  assert.match(prompt, /staffing agency/i, "the reason becomes a rule");

  // --- un-blocking lets it be found again ---------------------------------
  const blk = listBlocks().find((b: any) => b.scope === "domain")!;
  unblock(blk.id);
  const after = upsertJobs([mk("Agency C", "Brand New", "https://jobot.example/d")]);
  assert.equal(after.inserted, 1, "un-blocking restores discovery");
});

test("trash: blocking a company keeps its user-facing history honest", async () => {
  const { upsertJobs, trashJob, setStage, getJob } = await import("../app/db.server");
  const { getDb } = await import("../app/sqlite.server");
  const db = getDb();

  upsertJobs([{ company: "Gone Corp", role: "Dev", category: "high", fit_score: 70, apply_url: "https://x.example/1" }]);
  setStage("gone-corp--dev", "applied");
  db.prepare("INSERT INTO llm_calls (ts,runner,model,purpose,job_id,in_tok,out_tok,cost_usd,metered,status) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(new Date().toISOString(), "claude-cli", "m", "match", "gone-corp--dev", 10, 10, 0, 0, "ok");

  trashJob("gone-corp--dev", { reason: "not-remote", scope: "company" });

  assert.equal(getJob("gone-corp--dev"), null, "job removed");
  assert.equal(
    (db.prepare("SELECT count(*) c FROM applications WHERE job_id=?").get("gone-corp--dev") as any).c, 0,
    "pipeline row removed with it"
  );
  const call = db.prepare("SELECT job_id FROM llm_calls WHERE purpose='match'").get() as any;
  assert.equal(call.job_id, null, "spend history survives with a null job_id — it really happened");
});

test("ats: recognises company boards from posting URLs", async () => {
  const { detectBoard } = await import("../app/services/ats.server");

  assert.deepEqual(detectBoard("https://job-boards.greenhouse.io/remotecom/jobs/5922893003"), { ats: "greenhouse", slug: "remotecom" });
  assert.deepEqual(detectBoard("https://boards.greenhouse.io/similarweb/jobs/1"), { ats: "greenhouse", slug: "similarweb" });
  assert.deepEqual(detectBoard("https://jobs.lever.co/oowlish/abc-def"), { ats: "lever", slug: "oowlish" });
  assert.deepEqual(detectBoard("https://jobs.ashbyhq.com/railway/6ddcfe47"), { ats: "ashby", slug: "railway" });
  assert.deepEqual(detectBoard("https://holepunch.recruitee.com/o/engineer"), { ats: "recruitee", slug: "holepunch" });

  // a company's own careers page has no feed, and must not be mistaken for one
  assert.equal(detectBoard("https://careers.bitfinex.com/jobs/123"), null);
  assert.equal(detectBoard("https://jobot.com/whatever"), null);
  assert.equal(detectBoard(""), null);
});

test("ats: the registry seeds itself from jobs already in the ledger", async () => {
  const { upsertJobs } = await import("../app/db.server");
  const { bootstrapCompaniesFromJobs, listCompanies, addCompany } = await import("../app/services/ats.server");

  upsertJobs([
    { company: "Railway", role: "Backend Eng", category: "high", fit_score: 90, apply_url: "https://jobs.ashbyhq.com/railway/aaa" },
    { company: "Railway", role: "Frontend Eng", category: "high", fit_score: 88, apply_url: "https://jobs.ashbyhq.com/railway/bbb" },
    { company: "Oowlish", role: "Node Dev", category: "medium", fit_score: 70, apply_url: "https://jobs.lever.co/oowlish/ccc" },
    { company: "Bitfinex", role: "Rust Dev", category: "medium", fit_score: 60, apply_url: "https://careers.bitfinex.com/jobs/1" },
  ]);

  const first = bootstrapCompaniesFromJobs();
  assert.equal(first.boards, 2, "two distinct boards, not four jobs");
  assert.equal(first.added, 2);
  const names = listCompanies().map((c: any) => `${c.ats}:${c.slug}`);
  assert.ok(names.includes("ashby:railway") && names.includes("lever:oowlish"));
  assert.ok(!names.some((n: string) => n.includes("bitfinex")), "a bespoke careers page yields no board");

  // running it again must not duplicate
  const second = bootstrapCompaniesFromJobs();
  assert.equal(second.added, 0, "bootstrap is idempotent");
  // count only what the bootstrap can create: the registry also holds the job boards
  // every install ships with, which have no ATS feed.
  assert.equal(listCompanies().filter((c: any) => c.ats).length, 2);

  // and the same board cannot be added twice by hand
  const dup = addCompany({ name: "Railway", ats: "ashby", slug: "railway" });
  assert.ok(dup.error, "duplicate board is rejected");

  // a bespoke careers page is allowed, and a board URL pasted in is understood
  assert.ok(addCompany({ name: "Bitfinex", careersUrl: "https://careers.bitfinex.com" }).id);
  const pasted = addCompany({ name: "Deel", careersUrl: "https://jobs.ashbyhq.com/deel" });
  assert.ok(pasted.id);
  const deel = listCompanies().find((c: any) => c.name === "Deel")!;
  assert.equal(deel.ats, "ashby");
  assert.equal(deel.slug, "deel", "pasting a board URL fills in the ATS and slug");

  assert.ok(addCompany({ name: "" }).error, "a name is required");
  assert.ok(addCompany({ name: "Nope" }).error, "a board or careers URL is required");
});

test("resume builder: composes from picked KB entries without losing identity", async () => {
  const { composeFromKb, rankKbForJob, buildResumeFromKb, kbBuildSources, kbAllSkills } =
    await import("../app/resume/build.server");
  const { saveProfile, getProfile } = await import("../app/resume/profiles.server");
  const { getDb } = await import("../app/sqlite.server");
  const db = getDb();
  const now = new Date().toISOString();

  const mkItem = (kind: string, title: string, tags: string[], role?: string) =>
    Number(
      db.prepare("INSERT INTO kb_items (kind,title,summary,tags,source,created_at,updated_at,role) VALUES (?,?,?,?,?,?,?,?)")
        .run(kind, title, `${title} summary`, JSON.stringify(tags), "scan", now, now, role || null).lastInsertRowid
    );
  const mkBullet = (itemId: number, bullet: string, status = "pending") =>
    db.prepare("INSERT INTO kb_suggestions (item_id,section,bullet,status,created_at) VALUES (?,?,?,?,?)")
      .run(itemId, "project", bullet, status, now);

  const proj = mkItem("project", "Sleeping Beauty", ["TypeScript", "Socket.IO", "Postgres"]);
  mkBullet(proj, "Built a real-time scoring engine.");
  mkBullet(proj, "Rejected idea", "dismissed");
  const exp = mkItem("experience", "KwikNkap", ["NestJS", "React Native"], "Software Engineer");
  mkBullet(exp, "Owned the payments service.");
  const unrelated = mkItem("project", "Woodworking Blog", ["Jekyll"]);
  mkBullet(unrelated, "Wrote about chisels.");

  const sources = kbBuildSources();
  const pick = (t: string) => sources.find((s: any) => s.title === t)!;
  assert.deepEqual(pick("Sleeping Beauty").bullets, ["Built a real-time scoring engine."], "dismissed bullets are excluded");
  assert.ok(kbAllSkills().includes("TypeScript"));

  const base = {
    contact: { name: "Lucien", email: "l@example.com" },
    summary: "Engineer.",
    skills: ["Docker"],
    experience: [{ company: "Old Corp", role: "Dev", bullets: ["Did a thing."] }],
    projects: [],
    education: [{ school: "Some University", degree: "BSc" }],
  } as any;

  // base-plus keeps what was already there
  const plus = composeFromKb(base, [pick("Sleeping Beauty"), pick("KwikNkap")], ["TypeScript"], "base-plus");
  assert.equal(plus.contact.name, "Lucien");
  assert.equal(plus.education.length, 1, "education is never dropped");
  assert.ok(plus.experience.some((e: any) => e.company === "Old Corp"), "existing history survives");
  assert.ok(plus.experience.some((e: any) => e.company === "KwikNkap" && e.role === "Software Engineer"));
  assert.ok(plus.projects.some((p: any) => p.name === "Sleeping Beauty"));
  assert.deepEqual(plus.skills, ["Docker", "TypeScript"], "skills merge, base first, no duplicates");

  // kb-only rebuilds the content but still knows who you are
  const only = composeFromKb(base, [pick("Sleeping Beauty")], ["TypeScript"], "kb-only");
  assert.equal(only.contact.name, "Lucien", "identity is kept");
  assert.equal(only.education.length, 1, "education is kept");
  assert.equal(only.experience.length, 0, "base history is replaced, as asked");
  assert.deepEqual(only.skills, ["TypeScript"]);

  // building twice must not duplicate an entry
  const twice = composeFromKb(plus, [pick("KwikNkap")], [], "base-plus");
  assert.equal(twice.experience.filter((e: any) => e.company === "KwikNkap").length, 1, "merge is idempotent");

  // relevance ranking is deterministic and ignores unrelated work
  const ranked = rankKbForJob("Senior Engineer building real-time services in TypeScript with Postgres and Socket.IO");
  const titles = ranked.map((r: any) => r.source.title);
  assert.equal(titles[0], "Sleeping Beauty", "the closest match ranks first");
  assert.ok(!titles.includes("Woodworking Blog"), "irrelevant work is not suggested");
  assert.deepEqual(rankKbForJob(""), [], "no job text means no guesses");

  // end to end through a real profile
  saveProfile({ name: "Base", data: base, makeDefault: true });
  const built = buildResumeFromKb({ mode: "new", name: "For The Job", itemIds: [pick("KwikNkap").id], skills: ["Rust"] });
  assert.ok(built.profileId && !built.error);
  const saved = getProfile(built.profileId!)!;
  assert.equal(saved.name, "For The Job");
  assert.equal(saved.data.contact.name, "Lucien", "identity carried over from the base profile");
  assert.ok(saved.data.skills.includes("Rust"));

  assert.ok(buildResumeFromKb({ mode: "new", itemIds: [], skills: [] }).error, "picking nothing is refused");
});

test("prefill: only a résumé field gets the résumé", async () => {
  const { fileFieldRole } = await import("../app/services/prefill.server");

  for (const l of ["Resume", "Resume/CV *", "Upload your CV", "Curriculum Vitae"])
    assert.equal(fileFieldRole(l, ""), "resume", l);
  assert.equal(fileFieldRole("", "resume_file"), "resume", "falls back to the input name");

  assert.equal(fileFieldRole("Cover Letter", ""), "cover");

  // the field that caused this: uploading a résumé here sends the wrong document
  assert.equal(fileFieldRole("Please provide a sample of your technical writing.", ""), "other");
  assert.equal(fileFieldRole("Portfolio", ""), "other");
  assert.equal(fileFieldRole("Transcript", ""), "other");

  // a lone unlabelled file input is conventionally the résumé
  assert.equal(fileFieldRole("", ""), "unlabelled");
});

test("prefill: the real Sticker Mule fields are recognised and filled", async () => {
  const { isQuestionField, questionFields, valueForIdentity, matchAnswer } =
    await import("../app/services/prefill.server");

  const contact = {
    name: "Nde Che Lucien Ngwa",
    email: "chelucien08@gmail.com",
    phone: "+237 650 002 952",
    location: "Yaounde, Cameroon",
    links: [{ label: "GitHub", url: "github.com/dark-matter08" }],
  } as any;

  // "located" is not "location" — this label silently matched nothing
  assert.equal(valueForIdentity("Where are you located?", "", "", contact), "Yaounde, Cameroon");
  assert.equal(valueForIdentity("Where do you live?", "", "", contact), "Yaounde, Cameroon");
  assert.equal(valueForIdentity("Location", "", "", contact), "Yaounde, Cameroon");
  assert.equal(valueForIdentity("Email", "", "", contact), "chelucien08@gmail.com");

  // a long label is a question even without a question mark, so it gets drafted or asked
  assert.ok(isQuestionField("Please provide a link to a code sample you're particularly proud of:", "input"));
  assert.ok(isQuestionField("How did you hear about us?", "input"), "questions are not always textareas");
  assert.ok(isQuestionField("", "textarea"));
  assert.ok(!isQuestionField("Email", "input"), "identity fields are not questions");
  assert.ok(!isQuestionField("Location", "input"));

  // both of the fields that were skipped now reach the question list
  const fields = [
    { tag: "input", type: "text", name: "", id: "", label: "Email", visible: true, combo: false },
    { tag: "input", type: "text", name: "", id: "", label: "Where are you located?", visible: true, combo: false },
    { tag: "input", type: "text", name: "", id: "", label: "How did you hear about us?", visible: true, combo: false },
    { tag: "input", type: "text", name: "", id: "", label: "Please provide a link to a code sample you're particularly proud of:", visible: true, combo: false },
    { tag: "textarea", type: "", name: "", id: "", label: "Why are you proud of the code?", visible: true, combo: false },
  ] as any;
  const qs = questionFields(fields);
  assert.ok(qs.includes("How did you hear about us?"));
  assert.ok(qs.includes("Please provide a link to a code sample you're particularly proud of:"));
  assert.ok(qs.includes("Why are you proud of the code?"));
  assert.ok(!qs.includes("Email"), "identity fields must not be drafted as questions");

  // a banked answer reaches a single-line input, which is where it failed before
  const bank = [{ q: "How did you hear about us?", a: "Through a tool I built." }];
  assert.equal(matchAnswer("How did you hear about us?", bank), "Through a tool I built.");
  assert.equal(matchAnswer("Where are you located?", bank), null, "unrelated labels do not borrow answers");
});

test("prefill: a long question label still gets pooled", async () => {
  const { normQ } = await import("../app/db.server");
  const { questionFields } = await import("../app/services/prefill.server");

  // prefillPage reports unfilled labels truncated to 50 chars; pooling looks them up
  // against the full list. Exact matching dropped anything longer, so the required
  // "code sample" field was never filled AND never asked about.
  const label = "Please provide a link to a code sample you're particularly proud of:";
  assert.ok(label.length > 50, "this is the case that broke");
  const truncated = label.slice(0, 50);

  const asks = questionFields([
    { tag: "input", type: "text", name: "", id: "", label, visible: true, combo: false },
    { tag: "textarea", type: "", name: "", id: "", label: "Why are you proud of the code?", visible: true, combo: false },
  ] as any);

  assert.equal(asks.find((q: string) => normQ(q) === normQ(truncated)), undefined, "exact match fails — the old bug");
  const found = asks.find((q: string) => normQ(q) === normQ(truncated) || normQ(q).startsWith(normQ(truncated)));
  assert.equal(found, label, "prefix match recovers the full question, which is what gets pooled");

  // short labels were never affected and must keep working
  const short = "Why are you proud of the code?";
  assert.equal(asks.find((q: string) => normQ(q).startsWith(normQ(short.slice(0, 50)))), short);
});

test("stale sweep: clears untouched jobs, never ones you engaged with", async () => {
  const { upsertJobs, trashStaleJobs, setStage, updateNotes, getJob, listBlocks, blocklistPrompt } =
    await import("../app/db.server");
  const { getDb } = await import("../app/sqlite.server");
  const db = getDb();

  const old = new Date(Date.now() - 30 * 864e5).toISOString();
  const fresh = new Date().toISOString();
  const mk = (company: string, role: string, seen: string) => {
    upsertJobs([{ company, role, category: "high", fit_score: 80, apply_url: `https://x.example/${company}` }]);
    const id = `${company.toLowerCase()}--${role.toLowerCase()}`;
    db.prepare("UPDATE jobs SET first_seen=? WHERE id=?").run(seen, id);
    return id;
  };

  const untouched = mk("stalea", "eng", old);
  const recent = mk("freshco", "eng", fresh);
  const applied = mk("appliedco", "eng", old);
  const noted = mk("notedco", "eng", old);
  const tailored = mk("tailoredco", "eng", old);

  setStage(applied, "applied");
  updateNotes(noted, "worth a follow-up");
  db.prepare("INSERT INTO resume_versions (job_id,kind,style,created_at) VALUES (?,?,?,?)")
    .run(tailored, "resume", "letterpress", new Date().toISOString());

  const r = trashStaleJobs(14);
  assert.equal(r.trashed, 1, "only the genuinely untouched one goes");
  assert.equal(getJob(untouched), null, "untouched + old is deleted");
  assert.ok(getJob(recent), "too recent to be stale");
  assert.ok(getJob(applied), "you moved it past Saved");
  assert.ok(getJob(noted), "you wrote notes on it");
  assert.ok(getJob(tailored), "you generated a résumé for it — real work, never auto-deleted");

  // blocked so a crawl cannot re-add it
  const again = upsertJobs([{ company: "Stalea", role: "Eng", category: "high", fit_score: 80, apply_url: "https://x.example/Stalea" }]);
  assert.equal(again.inserted, 0);
  assert.equal(again.blocked, 1);
  assert.ok(listBlocks().some((b: any) => b.reason === "stale"));

  // Staleness must not reach the crawl prompt in ANY form. The first version of this
  // test only checked the "rejected X as ..." phrasing and passed while the note
  // "untouched for 14+ days" was leaking through the notes section instead.
  const prompt = blocklistPrompt();
  assert.ok(!/stalea/i.test(prompt), "a stale job must not be named to the crawler");
  assert.ok(!/untouched|fortnight|stale/i.test(prompt), "and neither must its note");

  assert.equal(trashStaleJobs(0).trashed, 0, "0 disables the sweep");
});

test("registry: job boards are tracked separately from employers", async () => {
  const { addCompany, listCompanies, activeCompanies } = await import("../app/services/ats.server");

  const board = addCompany({ name: "Remotiko", careersUrl: "https://remotiko.com/", kind: "board" });
  assert.ok(board.id && !board.error);
  const employer = addCompany({ name: "Bitfinex", careersUrl: "https://careers.bitfinex.com" });
  assert.ok(employer.id && !employer.error);

  const all = listCompanies();
  const b = all.find((c: any) => c.name === "Remotiko")!;
  const e = all.find((c: any) => c.name === "Bitfinex")!;
  assert.equal(b.kind, "board");
  assert.equal(e.kind, "company", "an employer is the default, so existing rows keep working");
  assert.equal(b.ats, null, "a board has no ATS feed to read");

  // the careers crawl splits on exactly these predicates
  const active = activeCompanies();
  const pages = active.filter((c: any) => c.kind !== "board" && !c.ats && c.careers_url);
  const jobBoards = active.filter((c: any) => c.kind === "board" && c.careers_url);
  assert.ok(pages.some((c: any) => c.name === "Bitfinex"), "employer pages go to the careers pass");
  assert.ok(!pages.some((c: any) => c.name === "Remotiko"), "a board must not be read as an employer page");
  assert.ok(jobBoards.some((c: any) => c.name === "Remotiko"), "boards go to the board pass");

  // an ATS-looking URL is still detected as that ATS even when pasted as a careers page
  const ashby = addCompany({ name: "Scanboard Test", careersUrl: "https://jobs.ashbyhq.com/scanboardtest" });
  assert.ok(ashby.id && !ashby.error, ashby.error);
  assert.equal(listCompanies().find((c: any) => c.name === "Scanboard Test")!.ats, "ashby");

  // and the same board cannot be registered twice, whichever kind it is added as
  assert.ok(addCompany({ name: "Dupe", careersUrl: "https://jobs.ashbyhq.com/scanboardtest", kind: "board" }).error);
});

test("registry: shipped job boards seed themselves, and stay deleted once removed", async () => {
  const { DEFAULT_BOARDS } = await import("../app/default-boards");
  const { listCompanies, removeCompany } = await import("../app/services/ats.server");
  const { getDb } = await import("../app/sqlite.server");

  const boards = (url: string) =>
    listCompanies().filter((c: any) => c.kind === "board" && c.careers_url === url);

  for (const d of DEFAULT_BOARDS) {
    const row = boards(d.url)[0];
    assert.ok(row, `${d.name} is tracked without anyone adding it`);
    assert.equal(row.name, d.name);
    assert.equal(row.active, 1, "and is crawled without being switched on first");
    assert.equal(row.note, d.note, "its note carries that board's crawl rules");
  }

  // Deleting a default has to outlive a restart, or the Companies tab could never
  // say no to one. Dropping every copy first keeps this honest even when another
  // test has registered the same board by hand.
  const gone = DEFAULT_BOARDS[0];
  for (const row of boards(gone.url)) removeCompany(row.id);
  delete (global as any).__ledgerDb; // the next getDb() re-runs the bootstrap, as a restart does
  getDb();
  assert.equal(boards(gone.url).length, 0, "a default you removed is not seeded back");
});

test("feeds: every board's own shape normalises to one posting the crawl can score", async () => {
  const { FEEDS } = await import("../app/services/feeds.server");
  const by = (id: string) => FEEDS.find((f: any) => f.id === id)!;

  // element 0 of the RemoteOK feed is its legal notice, not a job
  const rok = by("remoteok").parse([
    { legal: "API Terms of Service: please link back" },
    { company: "Warehance", position: "QA Engineer", url: "https://remoteok.com/remote-jobs/1",
      location: "", description: "<p>Test &amp; automate</p>", date: "2026-09-04T15:13:46+00:00" },
  ]);
  assert.equal(rok.length, 1, "the legal notice is not a posting");
  assert.equal(rok[0].company, "Warehance");
  assert.equal(rok[0].title, "QA Engineer");
  assert.equal(rok[0].source, "RemoteOK", "the board is credited as the source");
  assert.equal(rok[0].description, "Test & automate", "html is unwrapped, entities decoded");
  assert.equal(rok[0].remote, true, "a remote-only board needs no guessing at the location");

  const rmv = by("remotive").parse({ jobs: [{ title: "Backend Engineer", company_name: "Coalition",
    url: "https://remotive.com/remote-jobs/2", candidate_required_location: "Worldwide",
    job_type: "full_time", description: "<p>Node</p>", publication_date: "2026-09-02T19:59:53" }] });
  assert.equal(rmv[0].location, "Worldwide");
  assert.equal(rmv[0].employmentType, "full_time");

  // himalayas restricts by a LIST of locations and dates in epoch seconds
  const him = by("himalayas").parse({ jobs: [{ title: "Pre-sales Engineer", companyName: "Wildix",
    applicationLink: "https://himalayas.app/companies/wildix/jobs/x",
    locationRestrictions: ["Italy", "Spain"], employmentType: "Full Time",
    description: "<h3>Hello</h3>", pubDate: "1788656191" }] });
  assert.equal(him[0].location, "Italy, Spain", "a list of restrictions reads as one place");
  assert.equal(him[0].updatedAt, new Date(1788656191 * 1000).toISOString(), "epoch seconds become a date");

  const job = by("jobicy").parse({ jobs: [{ jobTitle: "Support Associate", companyName: "Peerspace",
    url: "https://jobicy.com/jobs/152619", jobGeo: "USA", jobType: ["Full-Time"],
    jobExcerpt: "Customer Experience", pubDate: "2026-09-05T18:54:47+00:00" }] });
  assert.equal(job[0].employmentType, "Full-Time", "a one-element list is still one type");
  assert.equal(job[0].title, "Support Associate");

  // a row with no employer, or nowhere to apply, dies here rather than in verification
  assert.equal(by("remoteok").parse([{ company: "", position: "Ghost", url: "https://x.test/1" }]).length, 0);
});

test("catalogue: a model that browses is marked, with what the searching costs", async () => {
  const { normalizeModel } = await import("../app/llm/openrouter.server");

  const sonar = normalizeModel({
    id: "perplexity/sonar", name: "Sonar",
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    supported_parameters: ["max_tokens", "temperature", "web_search_options"],
    pricing: { prompt: "0.000001", completion: "0.000001", web_search: "0.005" },
  })!;
  assert.equal(sonar.web, true, "web_search_options is the provider's own search");
  assert.equal(sonar.webSearchUsd, 0.005, "billed per request, so it is not scaled to the million");
  assert.equal(sonar.inUsd, 1, "token prices still read per million");

  const plain = normalizeModel({
    id: "meta/llama-guess", name: "Llama",
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    supported_parameters: ["max_tokens", "tools"],
    pricing: { prompt: "0", completion: "0" },
  })!;
  assert.equal(plain.web, false, "tools are not the web");
  assert.equal(plain.webSearchUsd, null, "and an unpublished search price is not zero");
});

test("runner: web access is a capability, and free-only outranks buying it", async () => {
  const { setSecret, deleteSecret } = await import("../app/secrets.server");
  const { setSetting } = await import("../app/sqlite.server");
  const { runnerCanSearchWeb } = await import("../app/llm/runner.server");

  setSecret("openrouter_api_key", "sk-or-test-key");
  setSetting("openrouter_free_only", "false");
  setSetting("openrouter_web_search", "off");
  assert.equal(await runnerCanSearchWeb("openrouter-api"), false,
    "a plain chat completion cannot reach a page, whatever the prompt asks");

  setSetting("openrouter_web_search", "exa");
  assert.equal(await runnerCanSearchWeb("openrouter-api"), true, "the web plugin buys it real pages");

  // web search bills even on a free model, so the promise not to spend has to win
  setSetting("openrouter_free_only", "true");
  assert.equal(await runnerCanSearchWeb("openrouter-api"), false, "free-only holds it off");

  assert.equal(await runnerCanSearchWeb("anthropic-api"), false, "a bare API runner never browses");
  assert.equal(await runnerCanSearchWeb("claude-cli"), true, "an agent CLI does");

  setSetting("openrouter_free_only", "false");
  setSetting("openrouter_web_search", "off");
  deleteSecret("openrouter_api_key");
});

test("cover letter PDF: letterhead added, salutation and sign-off never duplicated", async () => {
  const { renderCoverHtml } = await import("../app/resume/templates.server");
  const contact = {
    name: "Nde Che Lucien Ngwa",
    email: "chelucien08@gmail.com",
    phone: "+237 650 002 952",
    location: "Yaounde, Cameroon",
    links: [{ label: "GitHub", url: "github.com/dark-matter08" }],
  } as any;
  const meta = { company: "ConsenSys", role: "Senior Engineer", date: new Date("2026-09-05T00:00:00Z") };

  // the usual case: the model writes the whole letter, greeting and signature included
  const whole = "Dear ConsenSys hiring team,\n\nI build things.\n\nNde Che Lucien Ngwa";
  const a = renderCoverHtml(whole, contact, meta, "letterpress");
  assert.equal((a.match(/Dear /g) || []).length, 1, "must not greet the reader twice");
  assert.ok(!a.includes("Sincerely,"), "must not append a second sign-off");
  assert.ok(a.includes("Nde Che Lucien Ngwa"), "letterhead carries the name");
  assert.ok(a.includes("chelucien08@gmail.com") && a.includes("Yaounde, Cameroon"), "contact block");
  assert.ok(a.includes("5 September 2026"), "dated");
  assert.ok(a.includes("ConsenSys Hiring Team") && a.includes("Re: Senior Engineer"), "addressed");

  // a bare body gets the missing furniture supplied
  const bare = "I build things.\n\nI would welcome a conversation.";
  const b = renderCoverHtml(bare, contact, meta, "letterpress");
  assert.ok(b.includes("Dear ConsenSys Hiring Team,"), "salutation supplied when absent");
  assert.ok(b.includes("Sincerely,"), "sign-off supplied when absent");

  // each blank-line-separated block becomes its own paragraph
  assert.equal((b.match(/<p>/g) || []).length, 3, "salutation + two paragraphs");

  // other openings count as salutations too
  assert.ok(!renderCoverHtml("Hello team,\n\nBody.", contact, meta).includes("Dear ConsenSys Hiring Team,"));

  // user text is escaped, not injected
  const evil = renderCoverHtml("Dear team,\n\n<script>alert(1)</script> & co\n\nNde Che Lucien Ngwa", contact, meta);
  assert.ok(!evil.includes("<script>"), "no raw script tag survives");
  assert.ok(evil.includes("&lt;script&gt;") && evil.includes("&amp; co"));

  // every style produces a complete document
  for (const style of ["letterpress", "modern", "compact", "ats-plain"] as const) {
    const h = renderCoverHtml(whole, contact, meta, style);
    assert.ok(h.startsWith("<!doctype html>") && h.includes("@page"), style);
  }
});

test("auto-apply browser: attach mode fails loudly, and is off by default", async () => {
  const { setSetting, getSetting } = await import("../app/sqlite.server");
  const { openApplyPage } = await import("../app/services/apply.server");

  assert.equal(getSetting("apply_browser"), null, "a fresh install must not attach to anything");

  // Nothing is listening on this port, so this pins the error CONTRACT: it has to name
  // the address and the command that fixes it, not surface a raw socket error.
  setSetting("apply_browser", "attach");
  setSetting("apply_cdp_url", "http://127.0.0.1:9");
  await assert.rejects(
    () => openApplyPage("https://example.com", () => {}),
    (e: any) => {
      assert.match(e.message, /127\.0\.0\.1:9\b/, "names the address it tried");
      assert.match(e.message, /apply-browser start/, "names the command that fixes it");
      return true;
    }
  );

  setSetting("apply_browser", "playwright");
});

test("dropport: the raw port redirects to the clean URL, but only when it should", async () => {
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { resolve: r } = await import("node:path");

  const dir = mkdtempSync(r(tmpdir(), "dp-"));
  const reg = r(dir, "apps.json");
  process.env.DROPPORT_REGISTRY = reg;
  writeFileSync(reg, JSON.stringify({ apps: [{ host: "remoteledger.local", port: 5173 }] }));

  const { dropportRedirect } = await import("../app/dropport.server");
  const req = (url: string, host: string, method = "GET") =>
    new Request(url, { method, headers: { host } });

  assert.equal(
    dropportRedirect(req("http://remoteledger.local:5173/board?q=x", "remoteledger.local:5173")),
    "https://remoteledger.local/board?q=x",
    "path and query are carried across"
  );

  // everything below must be left alone
  assert.equal(dropportRedirect(req("https://remoteledger.local/", "remoteledger.local")), null, "already clean");
  assert.equal(dropportRedirect(req("http://localhost:5173/", "localhost:5173")), null, "localhost is not dropport's");
  assert.equal(dropportRedirect(req("http://127.0.0.1:5173/", "127.0.0.1:5173")), null, "raw IP is not dropport's");
  assert.equal(
    dropportRedirect(req("http://remoteledger.local:3000/", "remoteledger.local:3000")),
    null,
    "a port dropport does not map is not ours to hijack"
  );
  assert.equal(
    dropportRedirect(req("http://remoteledger.local:5173/", "remoteledger.local:5173", "POST")),
    null,
    "redirecting a POST would silently discard the form body"
  );

  // with dropport absent the app must behave exactly as before
  process.env.DROPPORT_REGISTRY = r(dir, "does-not-exist.json");
  const fresh = await import("../app/dropport.server?nocache=" + Date.now());
  assert.equal(
    fresh.dropportRedirect(req("http://remoteledger.local:5173/", "remoteledger.local:5173")),
    null,
    "not installed means never redirect"
  );

  delete process.env.DROPPORT_REGISTRY;
});


// --- OpenRouter catalogue ---------------------------------------------------
// The free tier is the whole point, so the rules that decide "is this free, and can
// it do the Ledger's work" are the ones worth pinning down.

const orRaw = (over: any = {}) => ({
  id: "acme/model-1",
  name: "Acme: Model 1",
  description: "Model 1 is a general-purpose model from Acme. It does many things.",
  context_length: 128000,
  created: 1700000000,
  architecture: { input_modalities: ["text"], output_modalities: ["text"] },
  pricing: { prompt: "0.000001", completion: "0.000004" },
  top_provider: { max_completion_tokens: 8192 },
  supported_parameters: ["tools", "response_format"],
  ...over,
});

test("openrouter: normalize maps price, tier, vendor and capabilities", async () => {
  const { normalizeModel } = await import("../app/llm/openrouter.server");

  const m = normalizeModel(orRaw())!;
  assert.equal(m.inUsd, 1, "per-token price is scaled to per-million");
  assert.equal(m.outUsd, 4);
  assert.equal(m.tier, "standard");
  assert.equal(m.free, false);
  assert.equal(m.vendorLabel, "Acme");
  assert.equal(m.tools, true);
  assert.equal(m.jsonMode, true);
  assert.equal(m.blurb, "Model 1 is a general-purpose model from Acme.", "blurb is the first sentence");
  assert.equal(
    normalizeModel(orRaw({ description: "**Model 1** is built by [Acme](https://acme.test/) for everyone. More." }))!.blurb,
    "Model 1 is built by Acme for everyone.",
    "markdown in the vendor description is stripped for the plain-text picker"
  );
  assert.equal(
    normalizeModel(orRaw({ description: "GPT-4.1 is a flagship model tuned for long context. It also codes." }))!.blurb,
    "GPT-4.1 is a flagship model tuned for long context.",
    "a version number is not mistaken for the end of the sentence"
  );
  assert.equal(
    normalizeModel(orRaw({ description: "Replicates the prose of Sonnet(https://openrouter.ai/x) and Opus. More." }))!.blurb,
    "Replicates the prose of Sonnet and Opus.",
    "a hand-written link missing its [brackets] does not leak a raw url into the picker"
  );

  const free = normalizeModel(orRaw({ id: "google/gemma:free", pricing: { prompt: "0", completion: "0" } }))!;
  assert.equal(free.free, true);
  assert.equal(free.tier, "free");
  assert.equal(free.vendorLabel, "Google");

  // routers price per request, not per token: "-1" is variable, NOT free
  const router = normalizeModel(orRaw({ id: "openrouter/auto", pricing: { prompt: "-1", completion: "-1" } }))!;
  assert.equal(router.free, false, "variable pricing must never read as free");
  assert.equal(router.tier, "router");
  assert.equal(router.inUsd, null);

  const cheap = normalizeModel(orRaw({ pricing: { prompt: "0.00000002", completion: "0.00000003" } }))!;
  assert.equal(cheap.tier, "budget");
  const dear = normalizeModel(orRaw({ pricing: { prompt: "0.000015", completion: "0.000075" } }))!;
  assert.equal(dear.tier, "premium");

  // a model that cannot answer in text is no use to the Ledger
  assert.equal(
    normalizeModel(orRaw({ architecture: { input_modalities: ["text"], output_modalities: ["image"] } })),
    null
  );
  assert.equal(normalizeModel({}), null);
});

test("openrouter: ranking puts models that can do the work first", async () => {
  const { normalizeCatalog, groupByTier, vendorsOf } = await import("../app/llm/openrouter.server");
  const models = normalizeCatalog({
    data: [
      orRaw({ id: "a/plain", supported_parameters: [] }),
      orRaw({ id: "b/tools-json", supported_parameters: ["tools", "response_format"] }),
      orRaw({ id: "b/tools-only", supported_parameters: ["tools"] }),
      orRaw({ id: "c/free", pricing: { prompt: "0", completion: "0" } }),
      orRaw({ id: "a/plain" }), // duplicate id is dropped
    ],
  });
  assert.equal(models.length, 4, "duplicate ids collapse");
  assert.equal(models[0].id, "b/tools-json", "json + tools ranks above tools alone");
  assert.ok(
    models.findIndex((m) => m.id === "b/tools-only") < models.findIndex((m) => m.id === "a/plain"),
    "tools ranks above nothing"
  );

  const tiers = groupByTier(models).map((g) => g.tier);
  assert.deepEqual(tiers, ["free", "standard"], "free is listed before paid tiers");

  const vendors = vendorsOf(models);
  assert.equal(vendors[0].id, "b", "vendors sort by how many models they have");
  assert.equal(vendors[0].count, 2);
});

test("openrouter: :free ids are recognised without the catalogue", async () => {
  const { isFreeModelId, defaultFreeModelId, FREE_ROUTER_ID } = await import("../app/llm/openrouter.server");
  assert.equal(isFreeModelId("google/gemma-4-31b-it:free"), true);
  assert.equal(isFreeModelId(FREE_ROUTER_ID), true);
  assert.equal(isFreeModelId("anthropic/claude-sonnet-4.5"), false, "unknown paid model is not assumed free");
  assert.equal(isFreeModelId(""), false);
  // with no cache on disk the picker still has something safe to offer
  assert.equal(defaultFreeModelId([]), FREE_ROUTER_ID);
});


// The OpenRouter adapter is the piece a free-tier user actually depends on, so its
// request shape and its error messages are pinned here against a stubbed fetch.
test("openrouter adapter: request shape, free fallbacks, guard rails", async () => {
  const { writeFileSync } = await import("node:fs");
  const { dirname, resolve: r } = await import("node:path");
  const { normalizeCatalog, CACHE_VERSION } = await import("../app/llm/openrouter.server");

  const catRaw = (id: string, price: string, params: string[]) => ({
    id,
    name: id,
    description: "",
    context_length: 128000,
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    pricing: { prompt: price, completion: price },
    supported_parameters: params,
  });
  // seed the on-disk catalogue the adapter reads synchronously
  writeFileSync(
    r(dirname(process.env.JOBS_DB_PATH!), "openrouter-models.json"),
    JSON.stringify({
      version: CACHE_VERSION,
      fetchedAt: new Date().toISOString(),
      models: normalizeCatalog({
        data: [
          catRaw("lab/json-free:free", "0", ["tools", "response_format"]),
          catRaw("lab/plain-free:free", "0", ["tools"]),
          catRaw("lab/other-json-free:free", "0", ["response_format"]),
          // enough free models to overrun OpenRouter's cap if nothing enforces it
          catRaw("lab/json-free-2:free", "0", ["tools", "response_format"]),
          catRaw("lab/json-free-3:free", "0", ["tools", "response_format"]),
          catRaw("lab/json-free-4:free", "0", ["tools", "response_format"]),
          catRaw("lab/paid", "0.000003", ["tools", "response_format"]),
        ],
      }),
    })
  );

  const { setSecret, deleteSecret } = await import("../app/secrets.server");
  const { setSetting } = await import("../app/sqlite.server");
  const { adapterById } = await import("../app/llm/adapters.server");
  const or = adapterById("openrouter-api")!;
  setSecret("openrouter_api_key", "sk-or-test");

  const real = globalThis.fetch;
  let seen: { url: string; init: any } | null = null;
  let reply: any = { ok: true, status: 200, body: { model: "lab/json-free:free", choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0 } } };
  globalThis.fetch = (async (url: any, init: any) => {
    seen = { url: String(url), init };
    return {
      ok: reply.ok,
      status: reply.status,
      json: async () => {
        if (reply.unparseable) throw new SyntaxError("Unexpected token < in JSON at position 0");
        return reply.body;
      },
    } as any;
  }) as any;

  try {
    setSetting("openrouter_free_only", "false");
    setSetting("openrouter_free_fallback", "true");
    setSetting("openrouter_fallbacks", "");

    // JSON mode + free fallbacks that can also answer in JSON
    const res = await or.run({ purpose: "misc", prompt: "p", json: true } as any, "lab/json-free:free");
    const body = JSON.parse(seen!.init.body);
    assert.equal(res.usage.costUsd, 0, "a free model costs nothing");
    assert.deepEqual(body.response_format, { type: "json_object" }, "JSON mode asked for where supported");
    assert.equal(body.usage.include, true, "asks OpenRouter for the real cost");
    assert.equal(seen!.init.headers["X-Title"], "The Remote Ledger", "sends attribution");
    assert.ok(body.models.length > 1, "chains fallbacks");
    assert.equal(body.models[0], "lab/json-free:free");
    assert.ok(
      body.models.every((m: string) => m.endsWith(":free")),
      "a free model only ever falls back to another free model"
    );
    assert.ok(
      !body.models.includes("lab/plain-free:free"),
      "a JSON request never falls back to a model that cannot do JSON"
    );
    // OpenRouter answers 400 to a longer array — "'models' array must have 3 items or
    // fewer" — so an over-long chain is not a longer chain, it is no call at all.
    assert.ok(
      body.models.length <= 3,
      `chain must fit OpenRouter's limit, got ${body.models.length}: ${body.models.join(", ")}`
    );

    // the same cap applies to a hand-written list, which is not otherwise bounded
    setSetting("openrouter_fallbacks", "lab/json-free-2:free, lab/json-free-3:free, lab/json-free-4:free, lab/other-json-free:free");
    await or.run({ purpose: "misc", prompt: "p", json: true } as any, "lab/json-free:free");
    const long = JSON.parse(seen!.init.body);
    assert.ok(long.models.length <= 3, `configured chain must be capped too, got ${long.models.length}`);
    assert.equal(long.models[0], "lab/json-free:free", "the model asked for stays first");
    setSetting("openrouter_fallbacks", "");

    // a model without response_format support must not be sent one
    await or.run({ purpose: "misc", prompt: "p", json: true } as any, "lab/plain-free:free");
    assert.equal(
      JSON.parse(seen!.init.body).response_format,
      undefined,
      "no response_format for a model that does not support it"
    );

    // paid models are billed from the catalogue when OpenRouter omits the cost
    reply = { ok: true, status: 200, body: { model: "lab/paid", choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 1_000_000, completion_tokens: 0 } } };
    const paid = await or.run({ purpose: "misc", prompt: "p" } as any, "lab/paid");
    assert.equal(paid.usage.costUsd, 3, "falls back to catalogue pricing");

    // free-only refuses to spend, before any request goes out
    setSetting("openrouter_free_only", "true");
    seen = null;
    await assert.rejects(
      () => or.run({ purpose: "misc", prompt: "p" } as any, "lab/paid"),
      /locked to free models/
    );
    assert.equal(seen, null, "blocked before the network call");
    await assert.doesNotReject(() => or.run({ purpose: "misc", prompt: "p" } as any, "lab/json-free:free"));

    // a hand-written chain must not smuggle a paid model past the guard
    setSetting("openrouter_fallbacks", "lab/paid, lab/other-json-free:free");
    await or.run({ purpose: "misc", prompt: "p" } as any, "lab/json-free:free");
    assert.deepEqual(
      JSON.parse(seen!.init.body).models,
      ["lab/json-free:free", "lab/other-json-free:free"],
      "free-only strips paid models out of the configured chain"
    );
    setSetting("openrouter_free_only", "false");
    await or.run({ purpose: "misc", prompt: "p" } as any, "lab/json-free:free");
    assert.ok(
      JSON.parse(seen!.init.body).models.includes("lab/paid"),
      "with the guard off the configured chain is honoured as written"
    );
    setSetting("openrouter_fallbacks", "");

    // the errors a free-tier user will actually hit, in words they can act on
    reply = { ok: false, status: 429, body: { error: { code: 429, message: "rate limited" } } };
    await assert.rejects(() => or.run({ purpose: "misc", prompt: "p" } as any, "lab/json-free:free"), /rate-limited/);
    reply = { ok: false, status: 402, body: { error: { code: 402, message: "no credit" } } };
    await assert.rejects(() => or.run({ purpose: "misc", prompt: "p" } as any, "lab/paid"), /free model/);
    // OpenRouter can return an error with HTTP 200 — that must still throw
    reply = { ok: true, status: 200, body: { error: { code: 401, message: "bad key" } } };
    await assert.rejects(() => or.run({ purpose: "misc", prompt: "p" } as any, "lab/paid"), /rejected the key/);
    // a proxy or captive portal answers 200 with HTML: still a sentence, not a TypeError
    reply = { ok: true, status: 200, unparseable: true };
    await assert.rejects(
      () => or.run({ purpose: "misc", prompt: "p" } as any, "lab/json-free:free"),
      (e: any) => !(e instanceof TypeError) && /not with JSON/.test(e.message)
    );
    // and one that is merely unreadable behind a real status code keeps that meaning
    reply = { ok: false, status: 401, unparseable: true };
    await assert.rejects(() => or.run({ purpose: "misc", prompt: "p" } as any, "lab/paid"), /rejected the key/);
  } finally {
    globalThis.fetch = real;
    deleteSecret("openrouter_api_key");
  }
});


test("openrouter: a synchronous cache read does not make the catalogue look offline", async () => {
  const { writeFileSync } = await import("node:fs");
  const { dirname, resolve: r } = await import("node:path");
  const mod = await import("../app/llm/openrouter.server?fresh=" + Date.now());

  writeFileSync(
    r(dirname(process.env.JOBS_DB_PATH!), "openrouter-models.json"),
    JSON.stringify({
      version: mod.CACHE_VERSION,
      fetchedAt: new Date().toISOString(),
      models: mod.normalizeCatalog({
        data: [
          {
            id: "lab/m",
            name: "m",
            description: "",
            context_length: 1000,
            architecture: { input_modalities: ["text"], output_modalities: ["text"] },
            pricing: { prompt: "0", completion: "0" },
            supported_parameters: [],
          },
        ],
      }),
    })
  );

  // something touches the cache synchronously first (the budget gate does exactly this)
  assert.equal(mod.isFreeModelId("lab/m"), true);
  // …the picker must still report a live, fresh catalogue rather than "you are offline"
  const cat = await mod.openRouterCatalog();
  assert.equal(cat.stale, false, "a fresh disk cache is not stale");
  assert.equal(cat.models.length, 1);
});

test("openrouter: a failed refresh is retried, not held for the whole TTL", async () => {
  const { writeFileSync, rmSync } = await import("node:fs");
  const { dirname, resolve: r } = await import("node:path");
  const mod = await import("../app/llm/openrouter.server?retry=" + Date.now());
  const cachePath = r(dirname(process.env.JOBS_DB_PATH!), "openrouter-models.json");
  const raw = (fetchedAt: string) =>
    JSON.stringify({
      version: mod.CACHE_VERSION,
      fetchedAt,
      models: mod.normalizeCatalog({
        data: [
          {
            id: "lab/m:free",
            name: "m",
            description: "",
            context_length: 1000,
            architecture: { input_modalities: ["text"], output_modalities: ["text"] },
            pricing: { prompt: "0", completion: "0" },
            supported_parameters: [],
          },
        ],
      }),
    });

  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    throw new Error("ENETDOWN");
  }) as any;

  try {
    // nothing on disk: a failure leaves an empty picker, so it must not be remembered
    rmSync(cachePath, { force: true });
    const a = await mod.openRouterCatalog();
    assert.equal(a.models.length, 0);
    assert.equal(a.stale, true);
    assert.match(a.error!, /ENETDOWN/, "the reason reaches the picker");
    await mod.openRouterCatalog();
    assert.equal(calls, 2, "an empty catalogue is retried rather than cached for 6h");

    // the network comes back — the very next call must pick it up, not wait out the TTL
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({
        data: [
          {
            id: "lab/m:free",
            name: "m",
            description: "",
            context_length: 1000,
            architecture: { input_modalities: ["text"], output_modalities: ["text"] },
            pricing: { prompt: "0", completion: "0" },
            supported_parameters: [],
          },
        ],
      }),
    })) as any;
    const back = await mod.openRouterCatalog();
    assert.equal(back.stale, false, "recovers as soon as the connection does");
    assert.equal(back.models.length, 1);

    // a cache too old to trust plus a dead network: serve it, say why, and hold it
    // briefly rather than hammering OpenRouter on every page load
    const stale = await import("../app/llm/openrouter.server?retry2=" + Date.now());
    writeFileSync(cachePath, raw(new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString()));
    calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      throw new Error("ENETDOWN");
    }) as any;
    const s1 = await stale.openRouterCatalog();
    assert.equal(s1.models.length, 1, "a stale copy still beats an empty picker");
    assert.equal(s1.stale, true);
    const s2 = await stale.openRouterCatalog();
    assert.equal(s2.models.length, 1);
    assert.match(s2.error!, /ENETDOWN/, "the reason survives the retry window");
    assert.equal(calls, 1, "held for a moment instead of re-fetching every call");
  } finally {
    globalThis.fetch = real;
    rmSync(cachePath, { force: true });
  }
});

test("scrape: a page that embeds a Greenhouse job is read from Greenhouse", async () => {
  const real = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (u: any) => {
    const url = String(u);
    seen.push(url);
    // the employer's own careers page: chrome, plus the embed naming its board
    if (url.includes("jamasoftware.com"))
      return {
        ok: true,
        text: async () =>
          `<html><body><div id="grnhse_app"></div>` +
          `<script src="https://boards.greenhouse.io/embed/job_board/js?for=jamasoftware"></script>` +
          `</body></html>`,
      };
    if (url.includes("boards-api.greenhouse.io"))
      return {
        ok: true,
        json: async () => ({
          title: "Developer Support Engineer",
          location: { name: "Remote - EMEA" },
          content: "&lt;p&gt;" + "Jama Software is focused on innovation success. ".repeat(12) + "&lt;/p&gt;",
        }),
      };
    throw new Error("unexpected fetch: " + url);
  }) as any;

  try {
    const { scrapeJobPage } = await import("../app/services/scrape.server");
    const r = await scrapeJobPage("https://www.jamasoftware.com/company/careers/posting/8164690?gh_jid=8164690");

    assert.equal(r.ok, true);
    assert.match(r.title, /Developer Support Engineer/, "the real title, not the page's");
    assert.match(r.title, /Remote - EMEA/, "with where it can be worked from");
    assert.match(r.text, /innovation success/, "and the posting body the embed would have painted in later");
    assert.ok(!/grnhse_app/.test(r.text), "not the shell that was there while it loaded");

    // the board came from the page, the job id from the url, and no browser was needed
    const api = seen.find((u) => u.includes("boards-api.greenhouse.io"));
    assert.ok(api?.includes("/boards/jamasoftware/jobs/8164690"), `asked greenhouse directly: ${api}`);
  } finally {
    globalThis.fetch = real;
  }
});

test("kb: the résumé is mirrored in, and re-importing refreshes rather than duplicates", async () => {
  const { saveProfile, getDefaultProfile } = await import("../app/resume/profiles.server");
  const { importResumeToKb, kbItems } = await import("../app/services/kb.server");
  const { emptyResume } = await import("../app/resume/types");

  const base = emptyResume();
  base.contact.name = "Test Person";
  base.skills = ["TypeScript", "GraphQL"];
  base.experience = [
    { company: "Camsol Technologies", role: "FullStack Developer", start: "2022", end: "2024", location: "Remote",
      bullets: ["Built services in TypeScript for two products."] },
  ];
  base.projects = [{ name: "Ntopor", role: "Lead", start: "", end: "", url: "", bullets: ["A GraphQL API."] }];
  saveProfile({ name: "kb-import-test", data: base, raw_text: "", makeDefault: true });

  const first = importResumeToKb();
  assert.ok(first.added >= 2, "an experience entry and a project both come across");

  const job = kbItems().find((i: any) => i.title === "Camsol Technologies")!;
  assert.ok(job, "the job on the résumé is now something a note can be added to");
  assert.equal(job.kind, "experience");
  assert.equal(job.role, "FullStack Developer");
  assert.ok(job.tags.includes("TypeScript"), "skills the bullets evidence come with it");

  // the whole point of keying on resume: paths — a second import must not double it
  const again = importResumeToKb();
  assert.equal(again.added, 0, "nothing new the second time");
  assert.equal(kbItems().filter((i: any) => i.title === "Camsol Technologies").length, 1);
  assert.ok(again.updated >= 2, "existing rows are refreshed instead");
});

test("gaps: a gap already closed under a shorter name does not come back", async () => {
  const { getDb } = await import("../app/sqlite.server");
  const { gapsForJob, dismissGap } = await import("../app/services/gaps.server");
  const db = getDb();
  const now = "2026-09-06T00:00:00.000Z";
  const add = (title: string, tags: string[]) =>
    db.prepare(
      "INSERT INTO kb_items (kind,title,summary,tags,source,created_at,updated_at) VALUES ('project',?,'',?,'manual',?,?)"
    ).run(title, JSON.stringify(tags), now, now);

  add("Gap Test Project", ["Headless CMS", "GraphQL", "AI"]);

  const missing = [
    // the shape the analysis actually produces: a sentence, not a skill
    "Named headless CMS platforms common at agencies (Contentful, Sanity, Strapi)",
    "GraphQL",                                  // exactly a tag
    "Explicit accessibility (WCAG/a11y) work",  // genuinely absent
    "Kubernetes cluster operations",            // genuinely absent
  ];

  const offered = gapsForJob("gap-test-job", missing).map((g) => g.skill);
  assert.ok(!offered.some((g) => /headless cms/i.test(g)), "covered by the 'Headless CMS' tag, however it was phrased");
  assert.ok(!offered.includes("GraphQL"), "covered exactly");
  assert.ok(offered.includes("Explicit accessibility (WCAG/a11y) work"), "a real gap is still offered");
  assert.ok(offered.includes("Kubernetes cluster operations"), "and so is this one");

  // "AI" is a tag on that project, and must not answer for everything with an i in it
  const noisy = gapsForJob("gap-test-job", ["AI-assisted code review tooling"]).map((g) => g.skill);
  assert.equal(noisy.length, 1, "a two-letter tag cannot cover a gap");

  // dismissal is per posting
  dismissGap("gap-test-job", "Kubernetes cluster operations");
  assert.ok(!gapsForJob("gap-test-job", missing).some((g) => /Kubernetes/.test(g.skill)), "set aside here");
  assert.ok(gapsForJob("another-job", missing).some((g) => /Kubernetes/.test(g.skill)), "but not for every other posting");
});

test("kb: a company folder enriches the job already on the résumé", async () => {
  const { getDb } = await import("../app/sqlite.server");
  const db = getDb();
  const now = "2026-09-06T00:00:00.000Z";

  const one = (title: string, path: string, start: string) =>
    Number(
      db.prepare(
        "INSERT INTO kb_items (kind,title,summary,tags,source,source_path,role,start_date,end_date,created_at,updated_at) VALUES ('experience',?,'',?,'resume',?,?,?,'Present',?,?)"
      ).run(title, "[]", path, "Software Engineer", start, now, now).lastInsertRowid
    );

  // the job as the résumé has it — August, not July
  const fromResume = one("Acme Widgets", "resume:experience:acme widgets|aug 2025|present", "Aug 2025");
  const logs: string[] = [];
  const { upsertExperienceItemForTest } = await import("../app/services/kb.server");

  const r = upsertExperienceItemForTest({
    company: "Acme Widgets",
    summary: "A much longer summary synthesised from twenty-three project folders.",
    tags: ["Go", "Keycloak"],
    sourcePath: "/Users/me/Projects/Acme",
    role: "Software Engineer",
    start: "July 2025",
    end: "Present",
    location: "Remote, US",
    onLog: (_k, t) => logs.push(t),
  });

  assert.equal(r.isNew, false, "it enriches the entry instead of adding a second Acme Widgets");
  assert.equal(r.id, fromResume);
  assert.equal((db.prepare("SELECT COUNT(*) c FROM kb_items WHERE title='Acme Widgets'").get() as any).c, 1);

  const row = db.prepare("SELECT * FROM kb_items WHERE id=?").get(fromResume) as any;
  assert.equal(row.start_date, "Aug 2025", "the résumé's dates stand; a folder is not a record of when you were there");
  assert.match(logs.join(" "), /start: this folder says "July 2025", the entry says "Aug 2025"/, "and the disagreement is said out loud");
  assert.match(row.source_path, /^resume:/, "the résumé key survives, so the next import does not re-duplicate it");
  assert.match(row.summary, /twenty-three project folders/, "the scan's fuller summary wins");
  assert.ok(row.tags.includes("Keycloak"), "and its tags are added");

  // two stints: guessing which one a folder belongs to would be worse than asking
  one("Beta Corp", "resume:experience:beta corp|jan 2020|jan 2021", "Jan 2020");
  one("Beta Corp", "resume:experience:beta corp|jan 2022|jan 2023", "Jan 2022");
  const amb: string[] = [];
  const r2 = upsertExperienceItemForTest({
    company: "Beta Corp", summary: "x", tags: [], sourcePath: "/Users/me/Projects/Beta", onLog: (_k, t) => amb.push(t),
  });
  assert.equal(r2.isNew, true, "with two stints it does not pick one at random");
  assert.match(amb.join(" "), /2 entries already exist.*Link to existing/s, "it says how to resolve it");
});

test("kb: an entry already scanned from its folder is adopted, not duplicated", async () => {
  const { saveProfile } = await import("../app/resume/profiles.server");
  const { importResumeToKb, kbItems, addSource } = await import("../app/services/kb.server");
  const { emptyResume } = await import("../app/resume/types");
  const { getDb } = await import("../app/sqlite.server");
  const db = getDb();

  // stand in for a folder scan that already wrote this project up properly
  db.prepare(
    "INSERT INTO kb_items (kind,title,summary,tags,source,source_path,created_at,updated_at) VALUES ('project','Ntopor App','A long summary the scan worked out from the code.','[\"Go\"]','scan','/tmp/ntopor',datetime('now'),datetime('now'))"
  ).run();
  const scanned = kbItems().find((i: any) => i.title === "Ntopor App")!;
  db.prepare("INSERT INTO kb_suggestions (item_id,section,bullet,created_at) VALUES (?,'project','A bullet the scan drafted.',datetime('now'))").run(scanned.id);

  const base = emptyResume();
  base.contact.name = "Test Person";
  base.projects = [{ name: "Ntopor App", role: "Lead", start: "", end: "", url: "", bullets: ["Short."] }];
  saveProfile({ name: "kb-adopt-test", data: base, raw_text: "", makeDefault: true });

  importResumeToKb();

  const rows = kbItems().filter((i: any) => i.title === "Ntopor App");
  assert.equal(rows.length, 1, "the résumé does not add a second copy beside the scanned one");
  assert.equal(rows[0].id, scanned.id, "it is the same row — the bullets stay attached to it");
  assert.match(String(rows[0].source_path), /^resume:project:/, "and the import can find it again next time");
  assert.match(rows[0].summary, /worked out from the code/, "the scan's summary beats the résumé's one-liner");
  assert.equal(
    (db.prepare("SELECT COUNT(*) c FROM kb_suggestions WHERE item_id=?").get(scanned.id) as any).c,
    1,
    "nothing already drafted was stranded"
  );
});

test("ollama: a modest machine is offered a model that finishes, and warned", async () => {
  const { recommendedModel, willBeSlow, fitsInRam } = await import("../app/ollama");

  // The old rule was "biggest that fits", which on an 8 GB laptop picked a model
  // wanting all 8 — every score and every tailored bullet then waits on it, and a
  // first-time user reads slow as broken.
  const small = recommendedModel(8);
  assert.ok(fitsInRam(small, 8));
  assert.ok(small.ramGb <= 4, `8 GB should leave room to run: got ${small.id} wanting ${small.ramGb} GB`);
  assert.equal(willBeSlow(small, 8), false);

  // Plenty of memory: take the most capable that fits, as before.
  const big = recommendedModel(32);
  assert.ok(big.ramGb >= small.ramGb, "headroom should buy capability");

  // Nothing comfortable fits, so say so rather than pretend.
  assert.equal(willBeSlow(recommendedModel(4), 4), true);
  assert.ok(recommendedModel(4).caps.includes("tools"), "still has to be usable for the app's work");
});

test("kb: a folder of documents is work too, not just a repository", async () => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const { readDocument, DOC_FILE_RE } = await import("../app/services/documents.server");

  const dir = resolve(TEST_DIR, "support-folder");
  mkdirSync(dir, { recursive: true });

  // A .docx, built the way Word builds one: a zip with word/document.xml inside.
  // This is THE document format for everyone the scan used to be blind to, so it is
  // read without adding a zip dependency to open one file in one archive.
  const { default: zlib } = await import("node:zlib");
  const xml = Buffer.from(
    '<?xml version="1.0"?><w:document xmlns:w="x"><w:body>' +
      "<w:p><w:r><w:t>Escalation Handling Procedure &amp; Tier 2 Handover</w:t></w:r></w:p>" +
      "<w:p><w:r><w:t>Cut average handover time from 40 minutes to 12.</w:t></w:r></w:p>" +
      "</w:body></w:document>",
    "utf8"
  );
  const body = zlib.deflateRawSync(xml);
  const nameBuf = Buffer.from("word/document.xml", "latin1");
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0);
  head.writeUInt16LE(8, 8); // deflate
  head.writeUInt32LE(body.length, 18);
  head.writeUInt32LE(xml.length, 22);
  head.writeUInt16LE(nameBuf.length, 26);
  writeFileSync(resolve(dir, "procedure.docx"), Buffer.concat([head, nameBuf, body]));
  writeFileSync(resolve(dir, "csat.md"), "# CSAT\nHeld 94% across 2025 on ~60 tickets a day.\n");

  assert.ok(DOC_FILE_RE.test("procedure.docx") && DOC_FILE_RE.test("report.pdf"));
  assert.equal(DOC_FILE_RE.test("screenshot.png"), false, "an image has no text to read");

  const docx = await readDocument(resolve(dir, "procedure.docx"));
  assert.match(docx.text, /Escalation Handling Procedure & Tier 2 Handover/);
  assert.match(docx.text, /40 minutes to 12/);

  const md = await readDocument(resolve(dir, "csat.md"));
  assert.match(md.text, /94%/);

  // An unreadable file is named with the reason, never counted as evidence — a bullet
  // written around a file nobody read is exactly the fabrication the app guards against.
  writeFileSync(resolve(dir, "scan.pdf"), "not really a pdf");
  const bad = await readDocument(resolve(dir, "scan.pdf"));
  assert.equal(bad.text, "");
  assert.ok(bad.problem, "it says why rather than going quiet");
});

test("gaps: a skill you did not learn at a listed employer still gets kept", async () => {
  const { getDb } = await import("../app/sqlite.server");
  const { fillGaps } = await import("../app/services/gaps.server");
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare("DELETE FROM kb_items WHERE kind='skill'").run();

  // The case the flow used to refuse outright: a customer support specialist asked
  // for Zendesk who used it at a call centre that is not on their résumé. itemId was
  // required, so there was nowhere to put it and the gap re-opened on every posting.
  const r = await fillGaps("acme--support", [], [], [
    { skill: "Zendesk", note: "Two years on Zendesk at a call centre, about 60 tickets a day." },
  ]);
  assert.equal(r.filled.length, 1);
  assert.equal(r.filled[0].skill, "Zendesk");

  const row = db.prepare("SELECT * FROM kb_items WHERE kind='skill' AND title='Zendesk'").get() as any;
  assert.ok(row, "it has its own entry");
  assert.match(row.summary, /call centre/, "their own words, kept verbatim");
  assert.deepEqual(JSON.parse(row.tags), ["Zendesk"], "and tagged, so it stops being a gap next time");
  // No model call and no employer: attaching this to a company they never named is
  // the one thing this path must never do.
  assert.equal(row.source, "gap");

  // Said again on a later posting, it adds to what is there rather than replacing it.
  await fillGaps("other--job", [], [], [{ skill: "zendesk", note: "Also built the macros." }]);
  const after = db.prepare("SELECT * FROM kb_items WHERE kind='skill' AND lower(title)='zendesk'").all() as any[];
  assert.equal(after.length, 1, "matched case-insensitively, not duplicated");
  assert.match(after[0].summary, /call centre/);
  assert.match(after[0].summary, /macros/);
});

test("gaps: a draft needs either a place or a note, and says which is missing", async () => {
  const { draftGapUsage } = await import("../app/services/gaps.server");
  // Neither: there is genuinely nothing to write from, and it must not invent one.
  const empty = await draftGapUsage({ skill: "Zendesk", itemIds: [], notes: "" });
  assert.equal(empty.text, "");
  assert.match(empty.error || "", /Tick where you did this, or write a line/);
  assert.doesNotMatch(empty.error || "", /^pick where/, "the old message demanded an entry and offered no alternative");
});

test("verify: a feed posting that never leaves its board is kept, an agent's is not", async () => {
  const { verifyJobs } = await import("../app/services/scrape.server");

  // Jobicy's page links to the company's homepage and keeps the apply button
  // internal, so resolveLive correctly reports "could not resolve a final
  // application link". Dropping it was the wrong POLICY, not a scraper failure: a
  // support crawl scored seven real, open roles and saved none of them, which is
  // exactly what "no jobs were added" looked like on a non-engineer's machine.
  const boardJob = { company: "Toast", role: "Customer Care Tax Expert", apply_url: "https://jobicy.com/jobs/1-x" };

  // Strict by default — an agent can imagine a link, so it must reach an employer.
  const strict = await verifyJobs([boardJob], { limit: 1 });
  const lenient = await verifyJobs([boardJob], { limit: 1, keepOnBoard: true });

  // Both make a real network call; what matters is that the two policies differ only
  // in what they do with a board-only result, never in what they call live.
  assert.ok(
    strict.alive.length <= lenient.alive.length,
    "keepOnBoard may only ever keep more, never fewer"
  );
  assert.equal(strict.alive.length + strict.dropped.length, 1);
  assert.equal(lenient.alive.length + lenient.dropped.length, 1);
});

test("fields: relevance comes from the profile, not from a hardcoded trade", async () => {
  const { fieldById, inField, keywordTokens, keywordHit } = await import("../app/fields");
  const support = fieldById("support")!;
  const software = fieldById("software")!;

  // The bug this replaces: an engineering regex passed unconditionally, ahead of the
  // user's own keywords, so a support search and an engineering search returned the
  // same 35 postings off the live boards — every one of them engineering.
  assert.equal(inField(support, "Customer Service Agent"), true);
  assert.equal(inField(support, "Senior Golang Developer"), false, "an engineer's job is not a support search result");
  assert.equal(inField(software, "Senior Golang Developer"), true);
  assert.equal(inField(software, "Customer Service Agent"), false);

  // The board already classified it. A title that does not say what it is still can.
  assert.equal(inField(support, "Escalations Lead, Tier 2"), false, "title alone gives nothing away");
  assert.equal(
    inField(support, "Escalations Lead, Tier 2", ["Customer Support & Success"]),
    true,
    "but Jobicy filed it under support, and that is the board's own answer"
  );

  // "Customer Support Specialist" typed without commas used to become one token that
  // had to appear verbatim in a title, so the user contributed nothing to their search.
  const toks = keywordTokens("Customer Support Specialist");
  assert.ok(toks.includes("customer support specialist"), "the phrase is still the strongest signal");
  assert.ok(toks.includes("support"), "and its words are what catch 'Support Specialist, Tier 2'");
  assert.equal(
    toks.includes("specialist"),
    false,
    "but not the job-shape words: 'specialist' alone matched Amazon Specialist and HR Systems Integration Engineer"
  );
  assert.equal(keywordHit("Tier 2 Support Advisor", toks), true);
  assert.equal(keywordHit("Kitchen Technician", toks), false);
});

test("fields: every shipped field is usable, and 'other' defers to your own words", async () => {
  const { JOB_FIELDS, fieldById, fieldLabel, inField } = await import("../app/fields");

  for (const f of JOB_FIELDS) {
    assert.ok(f.label.length > 3, `${f.id} needs a label`);
    assert.ok(f.example.length > 10, `${f.id} needs an example`);
    assert.equal(fieldById(f.id)?.id, f.id);
  }
  // A field that matched everything would keep the whole remote market; one that
  // matched nothing has to fall through to the user's keywords instead.
  const other = fieldById("other")!;
  assert.equal(inField(other, "Customer Service Agent"), false);
  assert.equal(inField(other, "Senior Golang Developer"), false);

  // The scorer interpolates this where "software engineering role" was hardcoded.
  assert.equal(fieldLabel("support"), "customer support & success role");
  assert.match(fieldLabel(null), /line of work/, "an unset field must not name a trade");
  assert.match(fieldLabel("other"), /line of work/);
});

test("runner: a model the server cannot load is a permanent failure, not a retry", async () => {
  const { isPermanentModelError } = await import("../app/llm/adapters.server");

  // the exact string Ollama returned for llama3.2-vision on a build without mllama
  assert.equal(
    isPermanentModelError(
      `Ollama (local) 500: {"error":{"message":"llama-server process has terminated: exit status 1: error loading model: unknown model architecture: 'mllama'"}}`
    ),
    true,
    "grinding through 37 more postings would produce this same line 37 more times"
  );
  assert.equal(isPermanentModelError("model 'llama3.1:8b' not found, try pulling it first"), true);
  assert.equal(isPermanentModelError("this model does not support tools"), true);

  // things that WILL differ next time must stay retryable
  assert.equal(isPermanentModelError("429 Too Many Requests"), false);
  assert.equal(isPermanentModelError("fetch failed"), false);
  assert.equal(isPermanentModelError("context deadline exceeded"), false);
  assert.equal(isPermanentModelError(""), false);
});

test("runner: JSON survives a model that answers and then explains itself", async () => {
  const { tryParseJson } = await import("../app/llm/runner.server");

  // the shape that used to return null: correct JSON, then a sentence about it.
  // Trailing prose was only trimmed when the text did NOT start with a brace.
  const withTail = `{ "company": "Fueled", "fit_score": 4 }\n\nThis is a poor match: the role is content design, not engineering.`;
  assert.deepEqual(tryParseJson(withTail), { company: "Fueled", fit_score: 4 });

  // and the explanation is allowed to contain braces of its own
  assert.deepEqual(
    tryParseJson(`{"a":1}\n\nNote: the shape is {a, b} in later versions.`),
    { a: 1 }
  );
  // a brace inside a string must not close the object early
  assert.deepEqual(tryParseJson(`{"note":"use } carefully","b":2} trailing`), { note: "use } carefully", b: 2 });

  // the cases that already worked, still working
  assert.deepEqual(tryParseJson('{"a":1}'), { a: 1 });
  assert.deepEqual(tryParseJson('Here you go:\n```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(tryParseJson('Sure — {"a":1} is the answer'), { a: 1 });
  assert.deepEqual(tryParseJson('[{"a":1},{"a":2}] done'), [{ a: 1 }, { a: 2 }]);
  assert.equal(tryParseJson("no json here at all"), null);
  assert.equal(tryParseJson(""), null);

  // Every JSON call in the app goes through here, and it silently discarded good
  // answers until this session. It is worth being paranoid about.
  assert.deepEqual(tryParseJson('  \n\t {"a":1}  \n '), { a: 1 }, "surrounding whitespace");
  assert.deepEqual(tryParseJson('```\n{"a":1}\n```'), { a: 1 }, "unlabelled fence");
  assert.deepEqual(tryParseJson('```json\n{"a":1}\n```\nAnd here is why.'), { a: 1 }, "fence then prose");
  assert.deepEqual(tryParseJson('{"a":{"b":{"c":[1,2,{"d":3}]}}} trailing'), { a: { b: { c: [1, 2, { d: 3 }] } } }, "deep nesting");
  assert.deepEqual(tryParseJson('{"s":"he said \\"}\\" to me"} after'), { s: 'he said "}" to me' }, "escaped quote before a brace in a string");
  assert.deepEqual(tryParseJson('{"s":"c:\\\\path\\\\"} after'), { s: "c:\\path\\" }, "a string ending in an escaped backslash");
  assert.deepEqual(tryParseJson('{"a":1}\n{"b":2}'), { a: 1 }, "two objects: the first one wins");
  assert.deepEqual(tryParseJson('Note: [1,2] then {"a":1}'), [1, 2], "the first value, array or object");
  assert.deepEqual(tryParseJson('{"unicode":"café ✓ 日本語"} done'), { unicode: "café ✓ 日本語" }, "non-ascii survives");
  assert.deepEqual(tryParseJson('{"empty":{},"arr":[]} tail'), { empty: {}, arr: [] }, "empty containers");
  assert.deepEqual(tryParseJson('{"n":-1.5e3,"t":true,"z":null} tail'), { n: -1500, t: true, z: null }, "numbers, booleans, null");

  // malformed input must be null, never a throw — callers treat null as "no answer"
  assert.equal(tryParseJson('{"a":1'), null, "unclosed object");
  assert.equal(tryParseJson("{'a':1}"), null, "single quotes are not JSON");
  assert.equal(tryParseJson('{"a":1,}'), null, "trailing comma");
  assert.equal(tryParseJson("{"), null, "a lone brace");
  assert.equal(tryParseJson("prose { not json } prose"), null, "brace-shaped prose");
  assert.equal(tryParseJson(null as any), null, "null input");
  assert.equal(tryParseJson(undefined as any), null, "undefined input");
});

test("community: only boards the shipped list lacks are ever offered", async () => {
  const { addCompany, removeCompany, listCompanies } = await import("../app/services/ats.server");
  const { pendingBoardSuggestions } = await import("../app/services/contribute.server");
  const { DEFAULT_BOARDS } = await import("../app/default-boards");

  const shipped = DEFAULT_BOARDS[0];
  // the same board with a trailing slash dropped is still that board
  const dupe = addCompany({ name: shipped.name, careersUrl: shipped.url.replace(/\/+$/, ""), kind: "board" });
  const novel = addCompany({ name: "Wellfound", careersUrl: "https://wellfound.com/jobs", kind: "board", note: "startup roles" });
  assert.ok(dupe.id && novel.id);

  try {
    const urls = pendingBoardSuggestions().map((b) => b.url);
    assert.ok(urls.includes("https://wellfound.com/jobs"), "a board the defaults lack is offered");
    assert.ok(
      !urls.some((u) => u.includes("remotiko")),
      "a shipped board is not re-offered just because the url is punctuated differently"
    );

    const w = pendingBoardSuggestions().find((b) => b.name === "Wellfound")!;
    // the payload is exactly these four fields — nothing here reaches for a job or a profile
    assert.deepEqual(Object.keys(w).sort(), ["jobsFound", "name", "note", "url"]);
    assert.equal(w.note, "startup roles");
    assert.equal(typeof w.jobsFound, "number");
  } finally {
    for (const c of listCompanies() as any[])
      if (c.name === "Wellfound" || (c.kind === "board" && c.careers_url === shipped.url.replace(/\/+$/, "")))
        removeCompany(c.id);
  }
});

test("github: a repo reference is recognised, a file path never is", async () => {
  const { parseRepoRef, looksLikeRepo } = await import("../app/services/github.server");

  for (const [input, slug] of [
    ["https://github.com/dark-matter08/vertex-reader", "dark-matter08/vertex-reader"],
    ["http://www.github.com/a/b/", "a/b"],
    ["git@github.com:a/b.git", "a/b"],
    ["dark-matter08/vertex-reader", "dark-matter08/vertex-reader"],
    // a link to a branch is still a link to the repo
    ["https://github.com/a/b/tree/main/src", "a/b"],
  ] as const)
    assert.equal(parseRepoRef(input)?.slug, slug, input);

  // the trap: /Users/me/Projects/app reads as owner "Users", repo "me" if you let it
  for (const input of ["/Users/me/Projects/app", "~/Projects/app", "./app", "a/b/c", "nope", ""])
    assert.equal(parseRepoRef(input), null, `${input} must not parse as a repo`);

  assert.equal(looksLikeRepo("owner/repo"), true);
  assert.equal(looksLikeRepo("https://github.com/a/b"), true);
  assert.equal(looksLikeRepo("/Users/me/Projects/app"), false, "a folder still goes down the folder path");
  assert.equal(looksLikeRepo("~/Projects/app"), false);
});

test("ats: a board's own description is kept, as text and as markup", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({
      jobs: [
        {
          title: "Senior Full Stack Engineer",
          absolute_url: "https://job-boards.greenhouse.io/acme/jobs/1",
          location: { name: "Remote" },
          content: "&lt;p&gt;Hello &amp; welcome&lt;/p&gt;",
          updated_at: "2026-09-06T00:00:00Z",
        },
      ],
    }),
  })) as any;

  try {
    const { fetchBoard } = await import("../app/services/ats.server");
    const [p] = await fetchBoard("greenhouse", "acme");
    // the feed is the best copy of a posting there is — keeping it is what stops the
    // ledger filling with blank jobs that each need a second, headless fetch later
    assert.equal(p.description, "Hello & welcome", "entities decoded, tags flattened");
    assert.equal(p.descriptionHtml, "<p>Hello & welcome</p>", "and the markup survives for the rich render");
  } finally {
    globalThis.fetch = real;
  }
});

test("verify: a careers index is not a posting, whoever produced it", async () => {
  const { isCareersIndex } = await import("../app/services/scrape.server");

  // exactly what a model with no web access answers with: companies it remembers,
  // and a guessed careers URL for each. Every one of these was saved as a real job.
  for (const u of [
    "https://plaid.com/careers/",
    "https://mercury.com/jobs",
    "https://render.com/careers",
    "https://vercel.com/careers",
    "https://www.prisma.io/company/careers",
    "https://www.databricks.com/company/careers",
    "https://planetscale.com/careers",
  ])
    assert.equal(isCareersIndex(u), true, `${u} is an index, not an application`);

  // a real posting has a slug, and an ATS link is never an index
  for (const u of [
    "https://vercel.com/careers/senior-engineer-4821",
    "https://mercury.com/jobs/software-engineer-backend",
    "https://boards.greenhouse.io/plaid/jobs/5312345",
    "https://jobs.lever.co/oowlish/abc-def",
    "https://jobs.ashbyhq.com/railway/aaa",
    "https://example.com/",
    "not a url",
  ])
    assert.equal(isCareersIndex(u), false, `${u} must still be allowed through`);
});

test("openrouter: the advice names the cheapest model that can actually search", async () => {
  const { writeFileSync } = await import("node:fs");
  const { dirname, resolve: r } = await import("node:path");
  const { setSetting } = await import("../app/sqlite.server");
  const mod = await import("../app/llm/openrouter.server?advice=" + Date.now());

  const raw = (id: string, price: string, params: string[], webPrice?: string) => ({
    id,
    name: id,
    description: "",
    context_length: 128000,
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    pricing: { prompt: price, completion: price, ...(webPrice ? { web_search: webPrice } : {}) },
    supported_parameters: params,
  });

  writeFileSync(
    r(dirname(process.env.JOBS_DB_PATH!), "openrouter-models.json"),
    JSON.stringify({
      version: mod.CACHE_VERSION,
      fetchedAt: new Date().toISOString(),
      models: mod.normalizeCatalog({
        data: [
          raw("lab/cheap-blind", "0.0000001", ["tools"]),                  // cheapest of all, cannot search
          raw("lab/browser", "0.000002", ["web_search_options"], "0.005"), // the honest answer
          raw("lab/browser-dear", "0.00001", ["web_search_options"]),
          raw("lab/browser:batch", "0.00000001", ["web_search_options"]),  // a delayed queue, not a crawl
        ],
      }),
    })
  );

  const pick = mod.cheapestWebModel()!;
  assert.equal(pick.id, "lab/browser", "cheapest is not the same as usable: a batch queue cannot serve a crawl");

  setSetting("openrouter_free_only", "true");
  const advice = (await mod.webSearchAdvice()).join(" ");
  assert.match(advice, /lab\/browser/, "it names what to switch to");
  assert.match(advice, /\$2\.00 in \/ \$2\.00 out/, "and what that costs");
  assert.match(advice, /plus \$0\.005 a search/, "including the part that is not tokens");
  assert.match(advice, /free models only/i, "and why searching is off right now");
  assert.match(advice, /openrouter\.ai\/credits/, "and where the money goes");

  setSetting("openrouter_free_only", "false");
});

test.after(cleanup);

test("job identity: a posting is its url, not its title", async () => {
  const { urlKey } = await import("../app/job-identity");

  // the pair that actually broke the ledger: same Ashby posting, reworded title
  assert.equal(
    urlKey("https://jobs.ashbyhq.com/toggl/a4f3e1f5-753b-4af9-b068-86a09a164cd2"),
    urlKey("https://jobs.ashbyhq.com/toggl/a4f3e1f5-753b-4af9-b068-86a09a164cd2/")
  );
  // arrival noise must not change identity
  assert.equal(
    urlKey("https://jobot.com/details/software-engineer/ecab52b501?utm_source=DigestAlert"),
    urlKey("https://JOBOT.com/details/software-engineer/ecab52b501")
  );
  // A query id is part of the address on boards that have no id in the path, so it is
  // kept there — but NOT when the path already names the posting. This example used to
  // assert the opposite, and that is exactly what split Consensys into two rows: the
  // same job arrived with and without the ?gh_jid repeat and became two keys, so one
  // already at screening came back as new.
  assert.equal(
    urlKey("https://consensys.io/open-roles/8138475?gh_jid=8138475"),
    urlKey("https://consensys.io/open-roles/8138475")
  );
  assert.ok(urlKey("https://jobs.example.com/apply?gh_jid=449912")!.includes("gh_jid=449912"));
  assert.notEqual(
    urlKey("https://job-boards.greenhouse.io/x/jobs/7673273003"),
    urlKey("https://job-boards.greenhouse.io/x/jobs/7673273004")
  );

  // a landing page is one url shared by every role behind it — refuse to key on it,
  // or unrelated jobs would be merged into one
  assert.equal(urlKey("https://talent.andela.com/signup"), null);
  assert.equal(urlKey("https://acme.com/careers"), null);
  assert.equal(urlKey("not a url"), null);
  assert.equal(urlKey("javascript:alert(1)"), null);
  // a word that happens to use only hex letters is not an id
  assert.equal(urlKey("https://acme.com/jobs/facadedecade"), null);
});

test("upsertJobs: a reworded title updates the job instead of minting a new one", async () => {
  const { upsertJobs, setStage, getJob, jobId } = await import("../app/db.server");
  const { getDb } = await import("../app/sqlite.server");
  const url = "https://job-boards.greenhouse.io/dedupe-test/jobs/9911223344";
  const rowsFor = () =>
    getDb().prepare("SELECT id, role FROM jobs WHERE apply_url=?").all(url) as { id: string; role: string }[];

  const first = upsertJobs([
    { company: "Xapo Bank", role: "Front-End Web Developer", category: "high", fit_score: 80, apply_url: url },
  ]);
  assert.equal(first.inserted, 1);
  const id = jobId("Xapo Bank", "Front-End Web Developer");
  setStage(id, "applied");

  // next crawl reads the same posting and writes the title differently
  const second = upsertJobs([
    {
      company: "Xapo",
      role: "Front-End Web Developer (Remote — Work from Anywhere)",
      category: "high",
      fit_score: 82,
      apply_url: url,
    },
  ]);
  assert.equal(second.inserted, 0, "no second row for the same posting");
  assert.equal(second.updated, 1);

  const rows = rowsFor();
  assert.equal(rows.length, 1, "one posting, one row");
  assert.equal(rows[0].id, id, "keeps the id the application hangs off");
  assert.equal(rows[0].role, "Front-End Web Developer (Remote — Work from Anywhere)", "shows the fresh title");
  assert.equal(getJob(id)!.stage, "applied", "the application survives the rewording");
});

test("dedupe: legacy duplicates fold onto the row that was worked on", async () => {
  const { getDb } = await import("../app/sqlite.server");
  const { findDuplicateJobs, mergeDuplicateJobs, setStage, getJob } = await import("../app/db.server");
  const db = getDb();
  const url = "https://job-boards.greenhouse.io/legacy/jobs/5150051500";
  const key = (await import("../app/job-identity")).urlKey(url)!;
  const now = new Date().toISOString();

  // two rows for one posting, as the old slug-only upsert would have left them
  const ins = db.prepare(
    `INSERT INTO jobs (id,company,role,category,fit_score,apply_url,url_key,active,first_seen,last_seen,updated_at)
     VALUES (?,?,?,'high',70,?,?,1,?,?,?)`
  );
  ins.run("legacy--eng", "Legacy", "Engineer", url, key, "2026-01-01T00:00:00Z", now, now);
  ins.run("legacy--eng-remote", "Legacy", "Engineer (Remote)", url, key, "2026-02-01T00:00:00Z", now, now);
  setStage("legacy--eng-remote", "applied"); // the one that was actually acted on

  const planned = findDuplicateJobs().find((g) => g.key === key)!;
  assert.equal(planned.keep, "legacy--eng-remote", "keeps the row with the application");
  assert.deepEqual(planned.drop, ["legacy--eng"]);

  assert.equal(mergeDuplicateJobs().removed, 0, "a dry run changes nothing");
  assert.ok(getJob("legacy--eng"), "still there after the dry run");

  mergeDuplicateJobs({ apply: true });
  assert.equal(getJob("legacy--eng"), null, "the empty twin is gone");
  const kept = getJob("legacy--eng-remote")!;
  assert.equal(kept.stage, "applied");
  assert.equal(kept.first_seen, "2026-01-01T00:00:00Z", "keeps the earliest discovery, not the duplicate's");
  assert.equal(findDuplicateJobs().length, 0);
});

test("upsertJobs: a crawl folds a twin it finds, instead of feeding it", async () => {
  const { getDb } = await import("../app/sqlite.server");
  const { upsertJobs, setStage, getJob, jobId } = await import("../app/db.server");
  const { urlKey } = await import("../app/job-identity");
  const db = getDb();
  const url = "https://consensys.example/open-roles/8138475?gh_jid=8138475";
  const key = urlKey(url)!;
  const now = new Date().toISOString();

  // the state the ledger was actually in: one posting, two rows. The application is
  // on the row whose title the board no longer uses.
  const ins = db.prepare(
    `INSERT INTO jobs (id,company,role,category,fit_score,apply_url,url_key,active,first_seen,last_seen,updated_at)
     VALUES (?,?,?,'medium',70,?,?,1,?,?,?)`
  );
  const worked = "twinco-metamask--senior-engineer-social-ai-metamask";
  const twin = jobId("Twinco", "Senior Engineer: Social & AI (MetaMask)");
  ins.run(worked, "Twinco (MetaMask)", "Senior Engineer: Social & AI — MetaMask", url, key, "2026-09-01T00:00:00Z", now, now);
  ins.run(twin, "Twinco", "Senior Engineer: Social & AI (MetaMask)", url, key, "2026-09-05T00:00:00Z", now, now);
  setStage(worked, "applied");
  setStage(twin, "saved");

  // the next crawl writes the title the twin's slug was built from — which is exactly
  // why the twin used to survive: it matched by slug before the url was ever consulted
  const res = upsertJobs([
    {
      company: "Twinco",
      role: "Senior Engineer: Social & AI (MetaMask)",
      category: "medium",
      fit_score: 74,
      apply_url: url,
    },
  ]);

  assert.equal(res.inserted, 0, "no third row");
  assert.equal(res.folded, 1, "the twin was folded, not refreshed");
  const rows = db.prepare("SELECT id FROM jobs WHERE url_key=?").all(key) as { id: string }[];
  assert.equal(rows.length, 1, "one posting, one row");
  assert.equal(rows[0].id, worked, "the row carrying the application is the survivor");
  assert.equal(getJob(worked)!.stage, "applied", "and it is still applied");
  assert.equal(getJob(twin), null, "the twin is gone");
  assert.equal(
    getJob(worked)!.first_seen,
    "2026-09-01T00:00:00Z",
    "keeps the earliest discovery"
  );
});

test("ollama shelf: recommends the biggest useful model that actually fits", async () => {
  const { OLLAMA_MODELS, fitsInRam, recommendedModel, sameModel, prettyBytes } = await import("../app/ollama");

  // headroom matters: a 8GB model on an 8GB machine leaves nothing for the desktop
  const big = OLLAMA_MODELS.find((m) => m.ramGb === 8)!;
  assert.equal(fitsInRam(big, 8), false, "no headroom is not a fit");
  assert.equal(fitsInRam(big, 16), true);

  // a laptop with 8GB should be steered to something small, not the 12GB vision model
  const small = recommendedModel(8);
  assert.ok(small.ramGb <= 6, `suggested ${small.id} wants ${small.ramGb}GB on an 8GB machine`);
  assert.ok(small.caps.includes("tools"), "the Ledger needs structured output, so tools is required");
  assert.ok(!small.caps.includes("embedding"), "an embedding model cannot answer a prompt");

  // a workstation should be offered more
  assert.ok(recommendedModel(64).sizeGb >= small.sizeGb, "more memory should not suggest a smaller model");
  // and an unknown machine still gets an answer rather than undefined
  assert.ok(recommendedModel(0).id, "unknown RAM still yields a suggestion");

  // /api/tags reports "llama3.2:3b"; a bare name means :latest
  assert.equal(sameModel("llama3.2:3b", "llama3.2:3b"), true);
  assert.equal(sameModel("mistral:latest", "mistral"), true, ":latest is implied");
  assert.equal(sameModel("Mistral", "mistral"), true);
  assert.equal(sameModel("llama3.2:3b", "llama3.2:1b"), false, "different tags are different models");

  assert.equal(prettyBytes(0), "—");
  assert.equal(prettyBytes(1024), "1.0 KB", "one decimal below 10, so 2.0 GB reads consistently");
  assert.equal(prettyBytes(2.0 * 1024 ** 3), "2.0 GB");
});

test("ollama shelf: the catalogue itself is sane", async () => {
  const { OLLAMA_MODELS, CAPABILITY_LABEL } = await import("../app/ollama");
  const ids = OLLAMA_MODELS.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate model ids would render twice and pull twice");
  for (const m of OLLAMA_MODELS) {
    assert.match(m.id, /^[a-z0-9._-]+(:[a-z0-9._-]+)?$/, `${m.id} is not a pullable tag`);
    assert.ok(m.caps.length, `${m.id} claims no capability`);
    for (const c of m.caps) assert.ok(CAPABILITY_LABEL[c], `${m.id} has an unlabelled capability ${c}`);
    assert.ok(m.ramGb >= m.sizeGb, `${m.id} claims it needs less memory than it occupies on disk`);
    assert.ok(m.blurb.length > 20 && !/\bAI\b.*\bpowerful\b/i.test(m.blurb), `${m.id} blurb says nothing`);
  }
  // the shelf is useless without something that can do the Ledger's core work
  assert.ok(OLLAMA_MODELS.some((m) => m.caps.includes("tools") && m.ramGb <= 4), "nothing here fits a small laptop");
  assert.ok(OLLAMA_MODELS.some((m) => m.caps.includes("vision")), "no vision model on the shelf");
});

test("ollama: the version is a number, not the warning paragraph around it", async () => {
  const { parseVersion } = await import("../app/services/ollama.server");
  // exactly what the CLI prints when the daemon is not running
  assert.equal(
    parseVersion("Warning: could not connect to a running Ollama instance\nWarning: client version is 0.17.7"),
    "0.17.7"
  );
  assert.equal(parseVersion("ollama version is 0.5.1"), "0.5.1");
  assert.equal(parseVersion("0.17.7-rc1"), "0.17.7-rc1");
  assert.equal(parseVersion("no version here"), null);
  assert.equal(parseVersion(""), null);
});

test("ollama: a pull reports the phase, not the layer hash", async () => {
  const { pullPhase } = await import("../app/ollama");
  // exactly what Ollama streams — the hash changes several times per download
  assert.equal(pullPhase("pulling 2bada8a74506"), "downloading");
  assert.equal(pullPhase("pulling manifest"), "resolving");
  assert.equal(pullPhase("verifying sha256 digest"), "verifying");
  assert.equal(pullPhase("writing manifest"), "resolving");
  assert.equal(pullPhase("success"), "done");
  assert.equal(pullPhase(""), "starting");
  // anything unrecognised is shown as-is rather than swallowed
  assert.equal(pullPhase("removing any unused layers"), "removing any unused layers");
});

test("ollama runner: available means the daemon answers, not that a key is absent", async () => {
  const { adapterById, resetOllamaProbe } = await import("../app/llm/adapters.server");
  const or = adapterById("ollama-api")!;
  const real = globalThis.fetch;
  let asked = 0;

  try {
    // daemon down: a local runner with no key must not report itself ready, or it can
    // be picked as the default and then fail every call with a connection error
    resetOllamaProbe();
    globalThis.fetch = (async () => { asked++; throw new Error("ECONNREFUSED"); }) as any;
    const down = await or.info();
    assert.equal(down.available, false, "nothing listening is not available");
    assert.match(String(down.detail), /Settings → Local/, "says where to fix it");

    // and the answer is held briefly, because settings asks every runner on every render
    await or.info();
    assert.equal(asked, 1, "the probe is cached rather than run per info() call");

    resetOllamaProbe();
    globalThis.fetch = (async () => ({ ok: true, json: async () => ({ version: "0.17.7" }) })) as any;
    const up = await or.info();
    assert.equal(up.available, true);
    assert.match(String(up.detail), /nothing leaves this machine/);
  } finally {
    globalThis.fetch = real;
    resetOllamaProbe();
  }
});

test("web tools: a search page is not a posting", async () => {
  const { urlKey } = await import("../app/job-identity");
  // the exact pages a 7B model fetched and then reported as jobs
  assert.equal(urlKey("https://www.ziprecruiter.com/Jobs/Remote-Typescript"), null, "an aggregator search page has no posting id");
  assert.equal(urlKey("https://www.indeed.com/q-typescript-l-remote-jobs.html"), null);
  assert.equal(urlKey("https://acme.com/careers"), null);
  // a real posting carries the board's own id
  assert.ok(urlKey("https://jobs.ashbyhq.com/reedsy/835c9c7b-8b0a-499c-95c6-251c9aea3246"));
  assert.ok(urlKey("https://job-boards.greenhouse.io/xapo61/jobs/7673273003"));
});

test("web tools: only a page we actually fetched can back a posting", async () => {
  const { FetchLedger } = await import("../app/llm/tools.server");
  const led = new FetchLedger();
  led.record("https://jobs.lever.co/acme/abc-123", "…job text…");

  assert.equal(led.has("https://jobs.lever.co/acme/abc-123"), true);
  // the model rarely echoes a url byte-for-byte: trailing slash, www, casing
  assert.equal(led.has("https://www.jobs.lever.co/acme/abc-123/"), true, "cosmetic differences still match");
  assert.equal(led.has("https://JOBS.LEVER.CO/acme/abc-123"), true);
  // but a different posting, or one it never opened, does not count
  assert.equal(led.has("https://jobs.lever.co/acme/def-456"), false, "a neighbouring posting is not this one");
  assert.equal(led.has("https://jobs.lever.co/other/abc-123"), false);
  assert.equal(led.has("not a url"), false);
  assert.equal(led.size, 1);
});

test("crawl research: a whole stack string is not a search query", async () => {
  const { shortStack } = await import("../app/services/crawl.server");
  // exactly what the 7B model was handed, and searched for all at once — matching CV
  // databases and personal portfolios instead of a single posting
  assert.equal(
    shortStack("JavaScript, TypeScript, NodeJS, Express, NestJS, ReactJS, NextJS, React Native, Mobile"),
    "JavaScript TypeScript"
  );
  assert.equal(shortStack("Go and Rust"), "Go Rust");
  assert.equal(shortStack("python/django"), "python django");
  assert.equal(shortStack("  "), "engineer", "an empty profile still yields a searchable word");
  assert.ok(shortStack("a, b, c, d, e").split(" ").length <= 2, "never more than a couple of terms");
});

test("web tools: a percent-encoded path still matches the page we fetched", async () => {
  const { FetchLedger } = await import("../app/llm/tools.server");
  const led = new FetchLedger();
  // the real url from an Ashby board, as fetched
  led.record("https://jobs.ashbyhq.com/Scale%20Army%20Careers/889e3259-d95a-437c-8bc3-ebf689ecf3a3", "…");
  assert.equal(
    led.has("https://jobs.ashbyhq.com/Scale Army Careers/889e3259-d95a-437c-8bc3-ebf689ecf3a3"),
    true,
    "a model echoing the readable form has still opened that page"
  );
  assert.equal(led.has("https://jobs.ashbyhq.com/Scale%20Army%20Careers/889e3259-d95a-437c-8bc3-ebf689ecf3a3"), true);
  assert.equal(led.has("https://jobs.ashbyhq.com/Other%20Company/889e3259-d95a-437c-8bc3-ebf689ecf3a3"), false);
});

test("crawl research: one posting is still a list", async () => {
  const { asJobList } = await import("../app/services/crawl.server");
  // exactly what qwen2.5:7b returned after correctly reading a real Ashby posting —
  // a single object, which a strict array check silently discarded
  const one = { company: "Whiskey Library", role: "Senior Frontend Developer", apply_url: "https://x/y" };
  assert.deepEqual(asJobList(one), [one]);
  assert.deepEqual(asJobList([one]), [one]);
  assert.deepEqual(asJobList({ jobs: [one] }), [one]);
  assert.deepEqual(asJobList({ results: [one] }), [one]);
  // and nothing usable stays nothing, rather than becoming a bogus one-item list
  assert.deepEqual(asJobList(null), []);
  assert.deepEqual(asJobList("no"), []);
  assert.deepEqual(asJobList({ note: "I could not find any" }), []);
});

test("upsertJobs: a model that answers with a list does not lose the job", async () => {
  const { upsertJobs } = await import("../app/db.server");
  const { getDb } = await import("../app/sqlite.server");
  const url = "https://job-boards.greenhouse.io/databento/jobs/8076835";

  // exactly the payload the local model produced: stack as an array, not a string.
  // Before, this threw inside upsertJobs and the posting was rejected on the last
  // step — after being searched for, fetched, verified live and confirmed real.
  const r = upsertJobs([
    {
      company: "Databento",
      role: "Software Engineer (TypeScript/JavaScript)",
      category: "high",
      fit_score: 80,
      stack: ["TypeScript", "JavaScript", "React"],
      eligibility: ["Remote", "US"],
      apply_url: url,
    },
  ]);
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  assert.equal(r.inserted, 1);
  const row = getDb().prepare("SELECT stack, eligibility FROM jobs WHERE apply_url=?").get(url) as any;
  assert.equal(row.stack, "TypeScript, JavaScript, React", "a list is joined, not dropped");
  assert.equal(row.eligibility, "Remote, US");
});

test("openrouter: tools are offered, and the fallback chain keeps them", async () => {
  const { adapterById } = await import("../app/llm/adapters.server");
  const or = adapterById("openrouter-api")!;
  const info = await or.info();
  // OpenRouter has its own adapter class; teaching OpenAICompatAdapter about tools
  // did nothing for it, and this is the guard against that regressing back
  assert.equal(info.tools, true, "openrouter must advertise tool support");
  // `web` is a different capability: the provider searching for us, and billing for it
  assert.notEqual(info.tools, info.web, "tools and provider-side web are not the same thing");
});

test("windows: a path with a space is one argument, not two", async () => {
  const { winSafe, quoteArg } = await import("../scripts/win.mjs");

  // The reason this exists: npm and friends are .cmd shims, so Windows needs a shell,
  // and a shell takes a command line rather than an argv. An unquoted home directory
  // then arrives as two arguments and the command fails somewhere far from the cause.
  assert.equal(quoteArg("C:\\Users\\Jane Doe\\app"), '"C:\\Users\\Jane Doe\\app"');
  assert.equal(quoteArg("install"), "install", "a plain word is left alone");
  assert.equal(quoteArg("a&b"), '"a&b"', "cmd.exe would treat & as a separator");
  assert.equal(quoteArg('say "hi"'), '"say \\"hi\\""', "embedded quotes are escaped");

  const [cmd, args] = winSafe("C:\\Program Files\\nodejs\\npm.cmd", ["run", "ledger start"], true);
  assert.equal(cmd, '"C:\\Program Files\\nodejs\\npm.cmd"');
  assert.deepEqual(args, ["run", '"ledger start"']);

  // and on posix nothing is touched — quoting an argv inserts literal quote characters
  const [pcmd, pargs] = winSafe("/usr/bin/npm", ["run", "ledger start"], false);
  assert.equal(pcmd, "/usr/bin/npm");
  assert.deepEqual(pargs, ["run", "ledger start"]);
});

test("ollama: every platform has a way to install it from the app", async () => {
  const { installCommand } = await import("../app/services/ollama.server");

  // Windows used to return null here, so the wizard fell through to "go to a website
  // and come back" — the one platform where the Install button did nothing. It then
  // went through winget, which failed on a real machine with nothing printed under it.
  // Ollama's own script is what its docs give for Windows.
  const win = String(installCommand(false, "win32"));
  assert.match(win, /ollama\.com\/install\.ps1/, "Windows uses the vendor's own script");
  assert.match(win, /-NoProfile|-ExecutionPolicy/, "and does not trip over a user's PowerShell profile or policy");

  // macOS prefers Homebrew over piping a downloaded script into a shell
  assert.equal(installCommand(true, "darwin"), "brew install ollama");
  assert.match(String(installCommand(false, "darwin")), /install\.sh/, "without brew, the official installer");

  // Linux has one route either way; Homebrew is not part of the question
  assert.equal(installCommand(true, "linux"), installCommand(false, "linux"));

  for (const os of ["darwin", "win32", "linux"]) {
    assert.ok(installCommand(false, os), `${os} must have something to offer`);
  }
});

test("no server-side child process may pop a console window on Windows", async () => {
  const { readdirSync, readFileSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");

  // The server is started detached and so owns no console of its own. Windows gives a
  // console-mode child a brand new *visible* window when its parent has none, so every
  // one of these flashed a black window on screen — and the status endpoints behind
  // them are polled every few seconds. Windows became unusable to watch.
  //
  // This is invisible on macOS and Linux, which is exactly why it needs a test.
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const full = join(dir, e);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith(".server.ts")) files.push(full);
    }
  };
  walk("app");

  const CALL = /\b(spawnSync|spawn|execSync|execFileSync|pexecFile|pexec)\(/g;
  const offenders: string[] = [];

  for (const file of files) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(CALL)) {
      // walk to the matching close paren so we read this call's arguments and no others
      let depth = 0;
      let i = m.index! + m[0].length - 1;
      for (; i < src.length; i++) {
        if (src[i] === "(") depth++;
        else if (src[i] === ")" && --depth === 0) break;
      }
      const args = src.slice(m.index!, i + 1);
      if (!args.includes("windowsHide")) {
        offenders.push(`${file}:${src.slice(0, m.index!).split("\n").length} ${m[1]}(`);
      }
    }
  }

  assert.deepEqual(offenders, [], `these spawn a visible console window on Windows:\n${offenders.join("\n")}`);
});

test("starting at logon never stops to ask for a password", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync("scripts/serve.mjs", "utf8");

  // The launcher that runs at logon goes through serve.mjs, which adds the hosts entry
  // if it is missing — on Windows by raising a UAC prompt with -Wait, from a window
  // that is hidden. After a reboot that blocked forever, unanswerable, before the
  // server was ever spawned: the machine came back and the app did not.
  const launcher = src.slice(src.indexOf("function writeWinLauncher"));
  const body = launcher.slice(0, launcher.indexOf("\n}"));
  assert.match(body, /LEDGER_SKIP_HOSTS=1/, "the logon launcher must not attempt hosts changes");

  // and the same guard in the code itself, so launchers already written to disk — which
  // run this very file — are repaired by an update rather than a reinstall
  const addHost = src.slice(src.indexOf("function addHost"));
  const guard = addHost.slice(0, addHost.indexOf("\n}"));
  assert.match(guard, /isTTY/, "addHost must not prompt when no one is at the keyboard");
  assert.ok(
    guard.indexOf("isTTY") < guard.indexOf("RunAs"),
    "the guard has to come before the elevation, or it guards nothing"
  );
});

test("stopping a crawl lets the next one start", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync("app/services/crawl.server.ts", "utf8");

  // "A crawl is already running" was answered by a module-level boolean that only
  // cleared when execute() unwound. Aborting asks the agent to stop; it can take up
  // to twice the crawl timeout to agree, and for all of that time a crawl the user
  // had already stopped went on refusing the next one.
  const guard = src.slice(src.indexOf("export function isCrawlRunning"));
  const guardBody = guard.slice(0, guard.indexOf("\n}"));
  assert.match(guardBody, /controllers\.size/, "the guard must count live runs, not a flag beside them");
  assert.ok(
    !/\brunning\b\s*\|\|/.test(guardBody),
    "a separate boolean drifts from the map; that drift is the bug"
  );

  // and the abort has to take effect at once, not when the agent finally notices
  const abort = src.slice(src.indexOf("export function abortCrawl"));
  const abortBody = abort.slice(0, abort.indexOf("\n}"));
  assert.match(abortBody, /controllers\.delete/, "abortCrawl must forget the run immediately");

  // Every stage breaks out of its loops on the signal rather than throwing, so an
  // aborted run reaches the success path like a finished one — and marked itself
  // "done" over the "stopped by user" the Stop button had just written.
  const exec = src.slice(src.indexOf("async function execute("));
  const doneAt = exec.indexOf('status: "done"');
  assert.ok(doneAt > 0, "the success path should still exist");
  // the guard itself, not merely a mention of the signal — the stage loops read
  // ac.signal.aborted too, so looking for that alone proves nothing
  const guardAt = exec.indexOf("if (ac.signal.aborted) {");
  assert.ok(guardAt > 0, "execute must ask whether it was stopped");
  assert.ok(guardAt < doneAt, "and ask before it reports itself done, not after");
  assert.match(
    exec.slice(guardAt, doneAt),
    /stopped by user/,
    "and record it as stopped rather than leaving the Stop button's note to be overwritten"
  );
});

test("profiles: a second line of work no longer overwrites the first", async () => {
  const { listProfiles, createProfile, updateProfile, deleteProfile, profileSlug } = await import(
    "../app/profiles.server"
  );
  const { getDb } = await import("../app/sqlite.server");

  // The whole point: there used to be one search held in three settings rows, so
  // starting a second meant destroying the first. These have to coexist.
  const eng = createProfile({ name: "Engineering", field: "software", stack: "TypeScript" });
  const design = createProfile({ name: "Design", field: "design", stack: "Figma" });
  assert.notEqual(eng.id, design.id);
  assert.equal(createProfile({ name: "Design", field: "design" }).id, "design-2", "a repeated name gets its own id");

  const still = listProfiles().find((p) => p.id === eng.id)!;
  assert.equal(still.stack, "TypeScript", "creating the second must not have touched the first");

  // inactive is kept, just not searched
  updateProfile(design.id, { active: 0 });
  assert.equal(listProfiles().find((p) => p.id === design.id)!.active, 0);
  assert.ok(listProfiles().some((p) => p.id === design.id), "deactivating is not deleting");

  // A posting may exist under two profiles — that is the chosen model — but never
  // twice within one. Asserted through upsertJobs rather than a unique index: the
  // index would make the legacy-duplicate state unrepresentable, and the fold that
  // repairs installs carrying it could then never run.
  const { upsertJobs } = await import("../app/db.server");
  const db = getDb();
  const posting = [
    {
      company: "Profilecorp",
      role: "Backend Engineer",
      category: "high",
      fit_score: 80,
      apply_url: "https://boards.greenhouse.io/profilecorp/jobs/99001122",
    },
  ];
  const countIn = (p: string) =>
    (db.prepare("SELECT count(*) AS n FROM jobs WHERE profile_id=?").get(p) as { n: number }).n;

  assert.equal(upsertJobs(posting, undefined, eng.id).inserted, 1);
  assert.equal(upsertJobs(posting, undefined, design.id).inserted, 1, "the other profile collects it too");
  assert.equal(countIn(eng.id), 1);
  assert.equal(countIn(design.id), 1);

  // the same posting again, reworded — updates, never mints a second row
  const reworded = [{ ...posting[0], role: "Backend Engineer (Remote)" }];
  const again = upsertJobs(reworded, undefined, eng.id);
  assert.equal(again.inserted, 0, "a reworded title is not a new posting");
  assert.equal(countIn(eng.id), 1, "still one row in this profile");
  assert.equal(countIn(design.id), 1, "and the other profile was not touched");

  // deleting takes its postings with it, and leaves the other profile's copy alone
  const removed = deleteProfile(design.id, { deleteJobs: true });
  assert.equal(removed.jobs, 1, "deleting a profile takes its postings with it");
  assert.equal(
    (db.prepare("SELECT count(*) AS n FROM jobs WHERE profile_id=?").get(eng.id) as { n: number }).n,
    1,
    "the other profile's copy survives"
  );

  assert.equal(profileSlug("Data / ML!!", []), "data-ml");
  deleteProfile(eng.id, { deleteJobs: true });
  deleteProfile("design-2", { deleteJobs: true });
});

test("export carries your work and never your keys", async () => {
  const { exportData, readExport, importData, EXPORT_VERSION, OMITTED } = await import(
    "../app/services/portability.server"
  );
  const { gzipSync } = await import("node:zlib");
  const { setSecret } = await import("../app/secrets.server");

  // A real secret in the store. The export must not contain it — and not because
  // something downstream strips it: the secrets table is never read.
  setSecret("anthropic_api_key", "sk-ant-do-not-export-me-0123456789");

  const dump = exportData();
  const text = JSON.stringify(dump);
  assert.ok(!("secrets" in dump.tables), "no secrets table in the file");
  assert.ok(!text.includes("sk-ant-do-not-export-me"), "and the value is nowhere else in it either");
  assert.ok(OMITTED.secrets, "the file says what it left out, so the other machine knows to re-enter it");

  // An email account travels without its password rather than being dropped, so the
  // account is there to re-authorise instead of being silently missing.
  for (const a of dump.tables.email_accounts || []) assert.equal(a.password, null);

  // A file from a newer version is refused, not guessed at. Writing columns this
  // code has never seen is how an import corrupts a database instead of declining.
  assert.throws(
    () => readExport(Buffer.from(JSON.stringify({ ...dump, version: EXPORT_VERSION + 1 }))),
    /newer version/i
  );
  assert.throws(() => readExport(Buffer.from(JSON.stringify({ hello: "world" }))), /not a Remote Ledger export/i);

  // gzip and plain JSON both read
  assert.equal(readExport(gzipSync(Buffer.from(text))).version, EXPORT_VERSION);

  // and a merge is repeatable: the second run adds nothing
  const again = importData(dump, "merge");
  assert.equal(
    Object.values(again.inserted).reduce((a, b) => a + b, 0),
    0,
    "importing what is already here must be a no-op"
  );
});

test("autopilot skips what is done and never submits", async () => {
  const { STEPS } = await import("../app/services/autopilot.server");
  const { readFileSync } = await import("node:fs");

  const ids = STEPS.map((s) => s.id);
  assert.deepEqual(ids, ["match", "build", "tailor", "cover", "form", "answers"], "the guided order, in order");

  // Re-running on a job you part-did by hand must not pay to redo it. Every step that
  // produces something durable has to be able to say "already done".
  for (const id of ["match", "build", "tailor", "cover"]) {
    const step = STEPS.find((s) => s.id === id)!;
    assert.equal(typeof step.done, "function", `${id} must declare when it can be skipped`);
  }
  // Reading the form is the exception, deliberately: it costs no model call and a form
  // can change under you between runs.
  assert.equal(STEPS.find((s) => s.id === "form")!.done({} as never), false);

  // The promise in the README. Nothing in here may click a submit button — if a step
  // is ever added that does, this is the test that should stop it.
  const src = readFileSync("app/services/autopilot.server.ts", "utf8");
  assert.ok(!/\.click\(|submit\(\)|type="submit"/.test(src), "autopilot must never submit an application");
  assert.match(src, /stops before submitting/i, "and must say so where the next person will read it");
});

test("a new profile starts with the whole knowledge base, and can be narrowed", async () => {
  const { createProfile, deleteProfile, profileKbIds, setProfileKb, copyProfileKb } = await import(
    "../app/profiles.server"
  );
  const { kbBuildSources } = await import("../app/resume/build.server");
  const { getDb } = await import("../app/sqlite.server");

  const db = getDb();
  db.prepare(
    "INSERT INTO kb_items (kind,title,summary,tags,created_at,updated_at) VALUES ('project','Ledger','built a thing','[]','n','n')"
  ).run();
  db.prepare(
    "INSERT INTO kb_items (kind,title,summary,tags,created_at,updated_at) VALUES ('project','Poster','drew a thing','[]','n','n')"
  ).run();
  const all = kbBuildSources();
  assert.ok(all.length >= 2);

  // The base is shared. This is the thing worth asserting: making a profile does not
  // mean rebuilding what you have done, and an uncurated profile sees all of it.
  const fresh = createProfile({ name: "KB Test", field: "software" });
  assert.deepEqual(profileKbIds(fresh.id), [], "a new profile has no selection…");
  assert.equal(kbBuildSources(fresh.id).length, all.length, "…which means everything, not nothing");

  // narrowing it
  setProfileKb(fresh.id, [all[0].id]);
  assert.equal(kbBuildSources(fresh.id).length, 1);
  assert.equal(kbBuildSources().length, all.length, "and the shared base is untouched");

  // and starting another from it rather than picking again
  const second = createProfile({ name: "KB Test Two", field: "design" });
  assert.equal(copyProfileKb(fresh.id, second.id), 1);
  assert.deepEqual(profileKbIds(second.id), [all[0].id]);

  // clearing goes back to "all", not "none"
  setProfileKb(fresh.id, []);
  assert.equal(kbBuildSources(fresh.id).length, all.length);

  deleteProfile(fresh.id, { deleteJobs: true });
  deleteProfile(second.id, { deleteJobs: true });
});

test("a posting is one job whether or not the link repeats its id in the query", async () => {
  const { urlKey } = await import("../app/job-identity");

  // Consensys arrived both ways on different days. Two keys meant two rows, so a job
  // already at screening came back under "new jobs" — which is what this fixes.
  assert.equal(
    urlKey("https://consensys.io/open-roles/8138475?gh_jid=8138475"),
    urlKey("https://consensys.io/open-roles/8138475")
  );

  // The query is still kept where it is the only thing carrying an id: that is the
  // case the original rule was written for, and dropping it there would merge every
  // posting on the board into one.
  assert.equal(urlKey("https://jobs.example.com/apply?gh_jid=449912"), "jobs.example.com/apply?gh_jid=449912");
  assert.notEqual(
    urlKey("https://jobs.example.com/apply?gh_jid=449912"),
    urlKey("https://jobs.example.com/apply?gh_jid=778001")
  );

  // and a page with no id at all still refuses to be an identity
  assert.equal(urlKey("https://example.com/careers"), null);
});
