// Core logic tests — no network / no LLM. Run with: npm test
// Uses an isolated temp DB + master key so it never touches your real data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { rmSync } from "node:fs";

const STAMP = `ledger-test-${process.pid}`;
process.env.JOBS_DB_PATH = resolve(tmpdir(), `${STAMP}.db`);
process.env.JOBS_MASTER_KEY = resolve(tmpdir(), `${STAMP}.key`);

function cleanup() {
  for (const f of [process.env.JOBS_DB_PATH!, process.env.JOBS_MASTER_KEY!, process.env.JOBS_DB_PATH! + "-wal", process.env.JOBS_DB_PATH! + "-shm"]) {
    try { rmSync(f); } catch {}
  }
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
  assert.equal(listCompanies().length, 2);

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

test.after(cleanup);
