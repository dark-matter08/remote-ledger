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
  setMeta,
  markClosed,
  setApplyUrl,
} from "../db.server";
import { getDefaultProfile } from "../resume/profiles.server";
import { draftSessionAnswers, type JobCtx } from "../resume/ai.server";
import { detectFormFields, questionFields, prefillJobOnPage, APPLY_HEADLESS } from "./apply.server";
import { resolveLive, renderWaitFor } from "./scrape.server";

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

  // ASSIST mode opens a VISIBLE browser and actually prefills each form (you submit);
  // DRAFT mode runs headless and only captures + drafts answers. (APPLY_HEADLESS=1
  // forces headless everywhere for servers/testing.)
  const headed = mode === "assist" && !APPLY_HEADLESS;
  let browser: any;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: !headed });
  } catch (e: any) {
    addLog(sessionId, "error", { text: `Browser unavailable: ${e.message}` });
  }
  if (mode === "assist") {
    addLog(sessionId, "note", { text: headed ? "Assist mode: opening a visible browser and prefilling each form — review and click Submit yourself." : "Assist mode (headless): prefilling forms and saving a screenshot of each." });
  }

  let processed = 0,
    needsInputTotal = 0;

  for (const job of jobs) {
    const sjId = addSessionJob(sessionId, job.id);
    addLog(sessionId, "action", { jobId: job.id, text: `Opening ${job.company} — ${job.role}` });
    try {
      // 0) FRESHNESS GATE: confirm the posting is still live (follow redirects to the
      // final employer page) before spending any work on it. Closed → mark + skip.
      if (browser) {
        const live = await resolveLive(browser, job.apply_url, (s) => addLog(sessionId, "action", { jobId: job.id, text: s }));
        if (!live.ok) {
          markClosed(job.id, live.reason);
          addLog(sessionId, "note", { jobId: job.id, text: `SKIPPED — posting no longer open (${live.reason}); marked closed.` });
          updateSessionJob(sjId, { status: "skipped", ended_at: new Date().toISOString() });
          processed++;
          updateSession(sessionId, { processed, needs_input: needsInputTotal });
          continue;
        }
        if (live.finalUrl && live.finalUrl !== job.apply_url) { setApplyUrl(job.id, live.finalUrl); job.apply_url = live.finalUrl; }
      }

      // 1) open the application page + (optionally) capture the JD. In assist mode we
      // KEEP this page open so we can prefill it and leave it for you to submit.
      let shot: string | undefined;
      let fields: any[] = [];
      let livePage: any = null;
      if (browser) {
        const page = await browser.newPage({ userAgent: UA });
        let keep = false;
        try {
          await page.goto(job.apply_url, { waitUntil: "domcontentloaded", timeout: 30000 });
          await page.waitForTimeout(renderWaitFor(job.apply_url));
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
          if (mode === "assist") { keep = true; livePage = page; } // reuse for prefill
        } finally {
          if (!keep) await page.close().catch(() => {});
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
      const drafted: { question: string; answer: string }[] = [];
      for (const it of items) {
        const banked = lookupAnswer(it.question);
        if (it.needsInput && !banked) {
          addQuestion({ sessionId, jobId: job.id, question: it.question });
          addLog(sessionId, "note", { jobId: job.id, text: `NEEDS INPUT: ${it.question}` });
          unanswered++;
        } else {
          const ans = banked || it.answer;
          addLog(sessionId, "answer", { jobId: job.id, text: `Q: ${it.question}\nA: ${ans}` });
          drafted.push({ question: it.question, answer: ans });
        }
      }

      // 3) ASSIST mode: persist drafted answers so the prefill engine can use them,
      // then actually prefill the open form (résumé upload, identity, cover, answers).
      let status: string = unanswered ? "needs_input" : "drafted";
      if (mode === "assist" && livePage) {
        if (drafted.length) setMeta(`answers:${job.id}`, JSON.stringify({ answers: drafted }));
        try {
          const r = await prefillJobOnPage(job.id, livePage, (m) => addLog(sessionId, "action", { jobId: job.id, text: m }));
          addLog(sessionId, "note", { jobId: job.id, text: r.message });
          if (r.shot) addLog(sessionId, "screenshot", { jobId: job.id, text: `Prefilled form (${r.confidence}% ready)`, shot: r.shot });
          shot = r.shot || shot;
          status = r.ok ? (headed ? "prefilled" : "drafted") : status;
        } catch (e: any) {
          addLog(sessionId, "error", { jobId: job.id, text: `Prefill failed: ${e.message}` });
        }
        // headed: leave the tab open for the user to review + submit. headless: close it.
        if (!headed) await livePage.close().catch(() => {});
      }

      updateSessionJob(sjId, {
        status,
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

  // Headed assist leaves the browser + prefilled tabs OPEN so you can review and submit
  // each one; everything else closes the browser.
  if (browser && !headed) await browser.close().catch(() => {});
  updateSession(sessionId, { status: "done", ended_at: new Date().toISOString() });
  addLog(sessionId, "note", {
    text: headed
      ? `Session complete. ${processed} processed — prefilled tabs are open in the browser; review each and click Submit. ${needsInputTotal} question(s) need your input.`
      : `Session complete. ${processed} processed, ${needsInputTotal} question(s) need your input.`,
  });
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
