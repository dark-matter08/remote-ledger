// Autopilot: run the guided application end to end.
//
// It adds no capability. Every step here already exists on the Guided Application
// tab and can be run by hand — match, build from the knowledge base, tailor, cover
// letter, read the form, draft the answers. What it adds is doing them in order
// without you clicking six times and waiting between each.
//
// Three things shape it:
//
//   1. It stops before submitting, and always will. That is not a limitation to be
//      lifted later; it is the promise in the README. The two endings are "open it
//      and fill it yourself" and "open it and prefill what I am sure of".
//
//   2. Steps are data, not a chain of awaits, and each declares when it can be
//      skipped. Re-running autopilot on a job you part-did by hand must not pay to
//      redo the parts that are done.
//
//   3. A failure stops the run. These steps cost money and each feeds the next — a
//      cover letter written from a résumé that failed to tailor is worth less than
//      nothing. What finished is kept, the failed step is named, and running it
//      again resumes from there because everything before it now skips.
//
// It is queue-shaped while it only ever holds one job, so running it across a
// selection later is a caller change rather than a rewrite.
import { getJob, addEvent, createCrawlRun, updateCrawlRun, crawlLog } from "../db.server";
import { getSetting } from "../sqlite.server";
import { getMeta, setMeta } from "../db.server";
import { getDefaultProfile, getProfile as getResumeProfile } from "../resume/profiles.server";
import { analyzeMatch, tailorResume, coverLetter, applicationAnswers, GENERIC_QUESTIONS } from "../resume/ai.server";
import { buildResumeFromKb, rankKbForJob } from "../resume/build.server";
import { createVersion, listVersions } from "../resume/versions.server";
import { assistApply, detectFormFields, questionFields, applyFormUrl } from "./apply.server";
import type { JobCtx } from "../resume/ai.server";

export type StepId = "match" | "gate" | "build" | "tailor" | "cover" | "form" | "answers";

export interface AutopilotStep {
  id: StepId;
  title: string;
  /** Already done — by an earlier run, or by hand. Skipped without spending anything. */
  done: (job: any) => boolean;
  run: (job: any, log: (m: string) => void) => Promise<string>;
}

/** Thrown by the gate so the caller can offer Force apply rather than just an error. */
export class AutopilotBelowMinimum extends Error {
  constructor(readonly score: number, readonly minimum: number) {
    super(`Match ${score} is below your minimum of ${minimum}`);
    this.name = "AutopilotBelowMinimum";
  }
}

const ctx = (job: any): JobCtx => ({
  id: job.id,
  company: job.company,
  role: job.role,
  stack: job.stack,
  eligibility: job.eligibility,
  jd: job.jd,
});

/** The résumé everything is written from. Autopilot never invents one. */
function baseResume(job: any) {
  const built = getResumeProfile(String(getMeta(`built:${job.id}`) || ""))?.data;
  return built || getDefaultProfile()?.data || null;
}

const versionsOf = (jobId: string, kind: "resume" | "cover-letter") =>
  listVersions(jobId).filter((v: any) => v.kind === kind);

export const STEPS: AutopilotStep[] = [
  {
    id: "match",
    title: "Match analysis",
    done: (job) => !!getMeta(`match:${job.id}`),
    run: async (job, log) => {
      const base = baseResume(job);
      if (!base) throw new Error("no base résumé — upload one on the Résumés page first");
      log("Comparing your résumé against the job description…");
      const m = await analyzeMatch(base, ctx(job));
      setMeta(`match:${job.id}`, JSON.stringify(m.match));
      return `scored ${m.match.score}`;
    },
  },
  {
    // The gate, deliberately here: after the one call that produces a score and before
    // the three that cost real money. Below the line it stops with the match kept, and
    // Force apply resumes from the next step because every step skips what is done.
    id: "gate",
    title: "Check the match against your minimum",
    done: () => false,
    run: async (job, log) => {
      const min = Number(getSetting("min_match_score") || "0") || 0;
      if (min <= 0) return "no minimum set — carrying on";

      const stored = getMeta(`match:${job.id}`);
      const score = stored ? Number(JSON.parse(stored)?.score ?? 0) : 0;
      if (score >= min) return `${score} is at or above your minimum of ${min}`;

      // Advise mode reports and continues, so a threshold can be watched for a week
      // before it is allowed to stop anything. A floor stricter than you expected that
      // silently halts every run looks like a broken feature, not a working one.
      if (getSetting("min_match_advise") === "true") {
        log(`${score} is below your minimum of ${min} — advise mode, so carrying on anyway.`);
        return `${score} below ${min} (advised, not blocked)`;
      }
      throw new AutopilotBelowMinimum(score, min);
    },
  },
  {
    id: "build",
    title: "Build from your knowledge base",
    done: (job) => !!getMeta(`built:${job.id}`),
    run: async (job, log) => {
      // The KB pieces this posting actually calls for, ranked the same way the Guided
      // tab ranks them when you pick by hand. With nothing relevant it is not worth
      // assembling anything — the tailor step will work from your base résumé, which
      // is what happens today if you skip this step yourself.
      const ranked = rankKbForJob(`${job.role} ${job.company} ${job.stack || ""} ${job.jd || ""}`, 8, job.profile_id);
      if (!ranked.length) return "nothing in the knowledge base matched this posting — using your base résumé";
      log(`Assembling from ${ranked.length} piece(s) of your own work…`);
      const built = buildResumeFromKb({
        itemIds: ranked.map((r) => r.source.id),
        mode: "new",
        name: `${job.company} — ${job.role}`,
        builtForJobId: job.id,
      });
      if (built.error) throw new Error(built.error);
      if (built.profileId) setMeta(`built:${job.id}`, String(built.profileId));
      return `assembled from ${ranked.length} piece(s)`;
    },
  },
  {
    id: "tailor",
    title: "Tailor the résumé",
    done: (job) => versionsOf(job.id, "resume").length > 0,
    run: async (job, log) => {
      const base = baseResume(job);
      if (!base) throw new Error("no base résumé to tailor");
      log("Rewriting for this role, with the anti-hallucination guard on…");
      const t = await tailorResume(base, ctx(job));
      createVersion({
        jobId: job.id,
        kind: "resume",
        style: (getSetting("apply_resume_style") || "letterpress") as string,
        data: t.resume,
        flags: t.flags,
        match: t.match,
        llmCallId: t.callId ?? null,
      });
      const invented = (t.flags || []).filter((f: any) => f?.severity === "high").length;
      return invented ? `written, ${invented} claim(s) flagged for you to check` : "written";
    },
  },
  {
    id: "cover",
    title: "Cover letter",
    done: (job) => versionsOf(job.id, "cover-letter").length > 0,
    run: async (job, log) => {
      const base = baseResume(job);
      if (!base) throw new Error("no base résumé to write from");
      log("Drafting the cover letter…");
      const c = await coverLetter(base, ctx(job));
      createVersion({ jobId: job.id, kind: "cover-letter", content_md: c.text, llmCallId: c.callId ?? null });
      return "drafted";
    },
  },
  {
    id: "form",
    title: "Read the application form",
    // Never skipped: a form can change under you, and reading it is cheap — no model
    // call, just the page. The expensive step is the one after it.
    done: () => false,
    run: async (job, log) => {
      log("Opening the application page and reading its fields…");
      const r = await assistApply(job.id, (m) => log(m));
      if (!r.ok) throw new Error(r.message || "could not read the form");
      return r.message;
    },
  },
  {
    id: "answers",
    title: "Draft the questions",
    done: (job) => !!getMeta(`answers:${job.id}`),
    run: async (job, log) => {
      const base = baseResume(job);
      if (!base) throw new Error("no base résumé to answer from");

      // The form's own questions where there are any, and the stock ones where there
      // are not — an application with no free-text boxes still asks why you want it,
      // just later and in person.
      let questions: string[] = [];
      let detected = 0;
      try {
        const fields = await detectFormFields(applyFormUrl(job.apply_url));
        detected = fields.length;
        questions = questionFields(fields);
      } catch {
        log("Could not read the form's questions; drafting the stock ones instead.");
      }
      const generic = !questions.length;
      if (generic) questions = GENERIC_QUESTIONS;

      log(`Drafting ${questions.length} answer(s)…`);
      const a = await applicationAnswers(base, ctx(job), questions);
      setMeta(
        `answers:${job.id}`,
        JSON.stringify({ fieldCount: detected, detected: questions.length, generic, answers: a.answers })
      );
      return `${a.answers.length} drafted${generic ? " (stock questions — the form had none)" : ""}`;
    },
  },
];

export type StepState = "pending" | "running" | "done" | "skipped" | "failed";

export interface StepProgress {
  id: StepId;
  title: string;
  state: StepState;
  /** The line this step is on right now, or what it ended up saying. */
  detail?: string;
}

/**
 * A run as seen from outside, for the page that is watching it.
 *
 * Held in memory rather than written to a table: it is a view of work happening in
 * this process, and when the process is gone so is the work. The durable record is
 * crawl_runs/crawl_logs, which is already written and already has a reader.
 */
export interface AutopilotProgress {
  jobId: string;
  runId: number;
  startedAt: string;
  endedAt?: string;
  /** Still working. False for a run that finished, failed or was stopped. */
  live: boolean;
  /**
   * A stop was asked for and the run has not reached a place to take it yet. Steps are
   * not interruptible — a model call in flight finishes — so this says "stopping" for
   * as long as that is the truth, rather than a button that looks ignored.
   */
  stopping?: boolean;
  steps: StepProgress[];
  ok?: boolean;
  message?: string;
  /**
   * The run stopped because the match came in under the minimum. Carried here rather
   * than only in the return value: whoever started the run no longer waits for it, so
   * the page has to learn this the same way it learns everything else.
   */
  belowMinimum?: { score: number; minimum: number };
}

// Kept after the run ends, so the page can still say how it went; trimmed, because
// this is a progress display and not a history.
const PROGRESS_KEPT = 20;
const progress = new Map<string, AutopilotProgress>();

function seedProgress(jobId: string, runId: number): AutopilotProgress {
  const p: AutopilotProgress = {
    jobId,
    runId,
    startedAt: new Date().toISOString(),
    live: true,
    steps: STEPS.map((s) => ({ id: s.id, title: s.title, state: "pending" as StepState })),
  };
  progress.delete(jobId); // re-insert, so the trim below drops the least recent
  progress.set(jobId, p);
  for (const k of progress.keys()) {
    if (progress.size <= PROGRESS_KEPT) break;
    progress.delete(k);
  }
  return p;
}

export function autopilotProgress(jobId: string): AutopilotProgress | null {
  return progress.get(jobId) ?? null;
}

/**
 * Start a run and return at once.
 *
 * The steps take minutes — they are model calls and a real browser. Awaiting them
 * inside the request that started them meant the page sat on a single pending POST:
 * a disabled button, no sign that four of the six steps had finished, and a browser
 * opening on its own with nothing on screen to explain it. Reloading was the only
 * way to find out it had worked.
 *
 * The work is unchanged. What changed is that the caller gets an answer immediately
 * and watches through autopilotProgress(), which also means closing the tab no
 * longer looks like it cancelled anything — it never did.
 */
export function startAutopilot(jobId: string, opts: { force?: boolean } = {}): { started: boolean; message?: string } {
  const job = getJob(jobId);
  if (!job) return { started: false, message: "no such posting" };
  if (running.has(jobId)) return { started: false, message: "already running for this posting" };
  // runAutopilot registers the job and seeds progress before its first await, so a
  // second click in the same tick is refused rather than run twice.
  void runAutopilot(jobId, opts).catch(() => {});
  return { started: true };
}

export interface AutopilotResult {
  ok: boolean;
  runId: number;
  done: StepId[];
  skipped: StepId[];
  failedAt?: StepId;
  /** Set when the run stopped at the gate rather than at a fault. */
  belowMinimum?: { score: number; minimum: number };
  message: string;
}

/** Live runs, so a Stop takes effect at once rather than when the tail unwinds. */
const running = new Map<string, AbortController>();

export function autopilotRunning(jobId: string): boolean {
  return running.has(jobId);
}

export function stopAutopilot(jobId: string): boolean {
  const ac = running.get(jobId);
  const p = progress.get(jobId);
  if (p?.live && ac) p.stopping = true;
  // Dropped here, not when the run finishes — the same lesson the crawl taught: a
  // stop that only takes effect once the work unwinds goes on blocking the next one.
  running.delete(jobId);
  if (!ac) return false;
  ac.abort();
  return true;
}

/**
 * Run the steps for one posting.
 *
 * Logs to crawl_runs/crawl_logs with type 'autopilot' rather than a table of its own:
 * crawl_runs already carries match, tailor, cover and prep, activeCrawl() filters to
 * the real crawl types so this cannot block the scheduler, and the log shell on the
 * crawl page renders it with nothing new written.
 */
export async function runAutopilot(jobId: string, opts: { force?: boolean } = {}): Promise<AutopilotResult> {
  const job = getJob(jobId);
  if (!job) return { ok: false, runId: 0, done: [], skipped: [], message: "no such posting" };
  if (running.has(jobId)) return { ok: false, runId: 0, done: [], skipped: [], message: "already running for this posting" };

  const runId = createCrawlRun("autopilot", "manual");
  try {
    updateCrawlRun(runId, { job_id: jobId } as never);
  } catch {}

  const ac = new AbortController();
  running.set(jobId, ac);
  const P = seedProgress(jobId, runId);
  const mark = (id: StepId, state: StepState, detail?: string) => {
    const s = P.steps.find((x) => x.id === id);
    if (!s) return;
    s.state = state;
    if (detail !== undefined) s.detail = detail;
  };
  const finish = (patch: Partial<AutopilotProgress>) =>
    Object.assign(P, { live: false, endedAt: new Date().toISOString() }, patch);
  const L = (kind: string, text: string) => crawlLog(runId, kind, text);
  const done: StepId[] = [];
  const skipped: StepId[] = [];

  L("note", `Autopilot · ${job.company} — ${job.role}`);

  try {
    for (const step of STEPS) {
      if (ac.signal.aborted) {
        L("note", "Stopped.");
        finish({ ok: false, stopping: false, message: "Stopped. What finished is kept — running it again picks up from here." });
        updateCrawlRun(runId, { status: "error", ended_at: new Date().toISOString(), note: "stopped by user" });
        return { ok: false, runId, done, skipped, message: "stopped" };
      }
      if (step.id === "gate" && opts.force) {
        skipped.push(step.id);
        L("note", "Minimum overridden for this job.");
        continue;
      }
      if (step.done(job)) {
        skipped.push(step.id);
        mark(step.id, "skipped", "already done");
        L("note", `${step.title} — already done, skipping`);
        continue;
      }
      mark(step.id, "running", "starting…");
      L("step", `${step.title}…`);
      try {
        const said = await step.run(job, (m) => {
          mark(step.id, "running", m);
          L("step", m);
        });
        done.push(step.id);
        mark(step.id, "done", said);
        L("result", `${step.title}: ${said}`);
      } catch (e: any) {
        if (e instanceof AutopilotBelowMinimum) {
          L("note", `${e.message}. Nothing further was run, and nothing was spent on it.`);
          updateCrawlRun(runId, { status: "error", ended_at: new Date().toISOString(), note: "below minimum" });
          // Being stopped by the gate is an ending. Without saying so, the page goes on
          // polling a run that is over and the button never comes back.
          mark(step.id, "failed", e.message);
          finish({ ok: false, message: e.message, belowMinimum: { score: e.score, minimum: e.minimum } });
          return {
            ok: false,
            runId,
            done,
            skipped,
            failedAt: "gate",
            belowMinimum: { score: e.score, minimum: e.minimum },
            message: e.message,
          };
        }
        const why = e?.message || String(e);
        mark(step.id, "failed", why);
        finish({ ok: false, message: `${step.title} failed: ${why}` });
        L("error", `${step.title} failed: ${why}`);
        L(
          "note",
          "Stopping here. What is finished is kept — run it again and it picks up from this step, because everything before it is now done."
        );
        updateCrawlRun(runId, { status: "error", ended_at: new Date().toISOString(), note: why.slice(0, 200) });
        return { ok: false, runId, done, skipped, failedAt: step.id, message: `${step.title} failed: ${why}` };
      }
    }

    addEvent(jobId, "note", "Autopilot prepared this application.");
    updateCrawlRun(runId, { status: "done", ended_at: new Date().toISOString() });
    L("note", "Ready. Nothing has been submitted — open the form when you want to.");
    const message = `Ready: ${done.length} step(s) run${skipped.length ? `, ${skipped.length} already done` : ""}. Nothing submitted.`;
    finish({ ok: true, message });
    return { ok: true, runId, done, skipped, message };
  } finally {
    running.delete(jobId);
  }
}
