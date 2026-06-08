// Manual, rule-based auto-apply SESSION engine.
//
// You start it from the Apply room. It selects matching jobs, and for each one:
//   navigate → screenshot the application page → detect the form → draft an answer
//   per question (reusing your answer bank) → pool anything it can't answer.
// Everything (actions, answers, screenshots) is logged to the DB for review.
// It NEVER submits an application.
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { getDb } from "../sqlite.server";
import {
  createSession,
  updateSession,
  addSessionJob,
  updateSessionJob,
  addLog,
  addQuestion,
  lookupAnswer,
  setJd,
} from "../db.server";
import { getDefaultProfile } from "../resume/profiles.server";
import { draftSessionAnswers, type JobCtx } from "../resume/ai.server";
import { detectFormFields, questionFields } from "./apply.server";

const SHOT_DIR = resolve(process.cwd(), "data", "apply");
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

export interface ApplyRules {
  categories: string[]; // high|medium|stretch
  minFit: number;
  stages: string[]; // job stage must be one of these (e.g. ['saved'])
  max: number;
  requireJd: boolean; // scrape JD first if missing
}

function selectJobs(rules: ApplyRules): { id: string; apply_url: string; company: string; role: string; jd: string | null }[] {
  const today = new Date().toISOString().slice(0, 10);
  const cats = rules.categories.length ? rules.categories : ["high", "medium", "stretch"];
  const stages = rules.stages.length ? rules.stages : ["saved"];
  const catQ = cats.map(() => "?").join(",");
  const stageQ = stages.map(() => "?").join(",");
  return getDb()
    .prepare(
      `SELECT j.id, j.apply_url, j.company, j.role, j.jd
       FROM jobs j LEFT JOIN applications a ON a.job_id=j.id
       WHERE j.active=1 AND (j.closes_at IS NULL OR j.closes_at>=?)
         AND j.category IN (${catQ}) AND j.fit_score>=?
         AND COALESCE(a.stage,'saved') IN (${stageQ})
       ORDER BY j.fit_score DESC LIMIT ?`
    )
    .all(today, ...cats, rules.minFit, ...stages, rules.max) as any[];
}

// Runs the whole session synchronously (bounded by rules.max). Returns the id.
export async function runSession(mode: "draft" | "assist", rules: ApplyRules): Promise<number> {
  const sessionId = createSession(mode, rules);
  await processSession(sessionId, mode, rules);
  return sessionId;
}

// Fire-and-forget: create the session, return its id immediately, process in the
// background so the UI's Start button returns at once and the monitor polls live.
export function startSession(mode: "draft" | "assist", rules: ApplyRules): number {
  const sessionId = createSession(mode, rules);
  void processSession(sessionId, mode, rules).catch((e: any) => {
    try {
      addLog(sessionId, "error", { text: String(e?.message || e) });
      updateSession(sessionId, { status: "error", ended_at: new Date().toISOString() });
    } catch {}
  });
  return sessionId;
}

async function processSession(sessionId: number, mode: "draft" | "assist", rules: ApplyRules): Promise<void> {
  mkdirSync(SHOT_DIR, { recursive: true });
  const jobs = selectJobs(rules);
  updateSession(sessionId, { total: jobs.length });
  addLog(sessionId, "note", { text: `Session started (${mode}). ${jobs.length} job(s) match the rules.` });

  const profile = getDefaultProfile();
  if (!profile) {
    addLog(sessionId, "error", { text: "No base résumé. Upload one on the Résumés page." });
    updateSession(sessionId, { status: "error", ended_at: new Date().toISOString(), note: "no résumé" });
    return;
  }

  let browser: any;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
  } catch (e: any) {
    addLog(sessionId, "error", { text: `Browser unavailable: ${e.message}` });
  }

  let processed = 0,
    needsInputTotal = 0;

  for (const job of jobs) {
    const sjId = addSessionJob(sessionId, job.id);
    addLog(sessionId, "action", { jobId: job.id, text: `Opening ${job.company} — ${job.role}` });
    try {
      // 1) screenshot the application page + (optionally) capture the JD
      let shot: string | undefined;
      let fields: any[] = [];
      if (browser) {
        const page = await browser.newPage({ userAgent: UA });
        try {
          await page.goto(job.apply_url, { waitUntil: "domcontentloaded", timeout: 30000 });
          await page.waitForTimeout(1800);
          shot = resolve(SHOT_DIR, `s${sessionId}-${sjId}.png`);
          await page.screenshot({ path: shot, fullPage: true });
          addLog(sessionId, "screenshot", { jobId: job.id, text: "Captured application page", shot });
          if (rules.requireJd && (!job.jd || job.jd.length < 60)) {
            const txt = await page.evaluate(() => (document.querySelector("main,article,[role=main]") as HTMLElement | null)?.innerText || document.body.innerText);
            if (txt && txt.length > 60) {
              setJd(job.id, txt.slice(0, 16000));
              addLog(sessionId, "action", { jobId: job.id, text: `Saved JD (${txt.length} chars)` });
            }
          }
        } finally {
          await page.close().catch(() => {});
        }
      }
      fields = await detectFormFields(job.apply_url);
      const qs = questionFields(fields);
      addLog(sessionId, "action", { jobId: job.id, text: `Detected ${fields.length} form fields, ${qs.length} question(s)` });

      // 2) draft answers, reusing the answer bank, pooling gaps
      const known: Record<string, string> = {};
      for (const q of qs) {
        const a = lookupAnswer(q);
        if (a) known[q] = a;
      }
      const ctx: JobCtx = { id: job.id, company: job.company, role: job.role, jd: job.jd };
      const { items } = await draftSessionAnswers(profile.data, ctx, qs, known);

      let unanswered = 0;
      for (const it of items) {
        const banked = lookupAnswer(it.question);
        if (it.needsInput && !banked) {
          addQuestion({ sessionId, jobId: job.id, question: it.question });
          addLog(sessionId, "note", { jobId: job.id, text: `NEEDS INPUT: ${it.question}` });
          unanswered++;
        } else {
          const ans = banked || it.answer;
          addLog(sessionId, "answer", { jobId: job.id, text: `Q: ${it.question}\nA: ${ans}` });
        }
      }
      updateSessionJob(sjId, {
        status: unanswered ? "needs_input" : "drafted",
        questions: items.length,
        unanswered,
        shot_path: shot ?? null,
        ended_at: new Date().toISOString(),
      });
      needsInputTotal += unanswered;
    } catch (e: any) {
      addLog(sessionId, "error", { jobId: job.id, text: e.message });
      updateSessionJob(sjId, { status: "failed", ended_at: new Date().toISOString() });
    }
    processed++;
    updateSession(sessionId, { processed, needs_input: needsInputTotal });
  }

  if (browser) await browser.close().catch(() => {});
  updateSession(sessionId, { status: "done", ended_at: new Date().toISOString() });
  addLog(sessionId, "note", { text: `Session complete. ${processed} processed, ${needsInputTotal} question(s) need your input.` });
}

// Resume a finished session after you've answered its pooled questions. Re-applies the
// now-available answers (from the question pool + answer bank), flipping jobs whose
// questions are all answered from "needs_input" to "drafted". Cheap — no LLM/browser.
export function resumeSession(sessionId: number): { resolved: number; stillNeeds: number } {
  const db = getDb();
  const sjs = db
    .prepare("SELECT id, job_id FROM apply_session_jobs WHERE session_id=? AND status='needs_input'")
    .all(sessionId) as { id: number; job_id: string }[];
  addLog(sessionId, "note", { text: "Resuming — applying your pooled answers…" });
  let resolved = 0, stillNeeds = 0, totalUnanswered = 0;
  for (const sj of sjs) {
    const open = (db
      .prepare("SELECT COUNT(*) n FROM apply_questions WHERE session_id=? AND job_id=? AND answer IS NULL")
      .get(sessionId, sj.job_id) as any).n as number;
    const answered = db
      .prepare("SELECT question, answer FROM apply_questions WHERE session_id=? AND job_id=? AND answer IS NOT NULL")
      .all(sessionId, sj.job_id) as { question: string; answer: string }[];
    for (const a of answered) addLog(sessionId, "answer", { jobId: sj.job_id, text: `Q: ${a.question}\nA: ${a.answer}` });
    updateSessionJob(sj.id, { unanswered: open, status: open ? "needs_input" : "drafted", ended_at: new Date().toISOString() });
    totalUnanswered += open;
    if (open) stillNeeds++; else resolved++;
  }
  updateSession(sessionId, { needs_input: totalUnanswered, status: "done", ended_at: new Date().toISOString() });
  addLog(sessionId, "note", { text: `Resume complete — ${resolved} job(s) ready, ${stillNeeds} still awaiting answers.` });
  return { resolved, stillNeeds };
}
