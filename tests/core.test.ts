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

test.after(cleanup);
