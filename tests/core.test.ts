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

test.after(cleanup);
