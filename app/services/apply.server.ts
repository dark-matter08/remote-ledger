// Auto-apply ASSIST (ported from career-ops `apply` mode).
//
// Safety: this never submits an application. It (1) reads the form to draft answers,
// and (2) opens a VISIBLE browser and prefills identity fields, résumé upload, cover
// letter, and drafted answers — then leaves it for you to review and submit.
//
// The browser-side fill engine lives in `prefill.server.ts` (DB-free, unit-testable);
// this module wires it to the DB: artifact generation, freshness gate, persistence.
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { getJob, getMeta, setMeta, addEvent, markClosed, setApplyUrl, jobApplyActivity, answerBank } from "../db.server";
import { getDefaultProfile } from "../resume/profiles.server";
import { latestVersion, createVersion, setVersionPdf } from "../resume/versions.server";
import { tailorResume, coverLetter } from "../resume/ai.server";
import { renderResumePdf } from "../resume/pdf.server";
import { verifyApplyUrl, renderWaitFor } from "./scrape.server";
import { loggedTask } from "./crawl.server";
import { UA, EXTRACT_FIELDS, detectAts, questionFields, prefillPage, type FormField } from "./prefill.server";

export type { FormField } from "./prefill.server";
export { detectAts, questionFields } from "./prefill.server";

const SHOT_DIR = resolve(process.cwd(), "data", "apply");
// Headed by default (you watch + submit). Set APPLY_HEADLESS=1 for servers without a
// display or for automated testing.
const HEADLESS = process.env.APPLY_HEADLESS === "1";

// When a form requires a résumé upload and/or cover letter that we don't yet have for
// this job, generate them on the fly (tailor → PDF, draft cover) so the prefill can use
// them. Each generation streams in the Crawl Shell.
async function ensureArtifacts(
  job: any,
  needs: { resume: boolean; cover: boolean },
  current: { pdfPath: string | null; cover: string | null }
): Promise<{ pdfPath: string | null; cover: string | null; generated: string[] }> {
  let { pdfPath, cover } = current;
  const generated: string[] = [];
  const profile = getDefaultProfile();
  if (!profile) return { pdfPath, cover, generated };
  const base = profile.data;
  const ctx = { id: job.id, company: job.company, role: job.role, stack: job.stack, eligibility: job.eligibility, jd: job.jd };

  if (needs.resume && !pdfPath) {
    try {
      await loggedTask("tailor", `Auto-apply résumé · ${job.company} — ${job.role}`, async (L) => {
        L("step", "Form requires a résumé — tailoring it to this role…");
        const t = await tailorResume(base, ctx);
        const vid = createVersion({ jobId: job.id, profileId: profile.id, kind: "resume", style: "letterpress", data: t.resume, flags: t.flags, match: t.match, llmCallId: t.callId ?? null });
        L("step", "Rendering the résumé PDF…");
        const pdf = await renderResumePdf(t.resume, "letterpress", `${job.id}-v${vid}`);
        setVersionPdf(vid, pdf.path);
        setMeta(`match:${job.id}`, JSON.stringify(t.match));
        addEvent(job.id, "resume_generated", { versionId: vid, style: "letterpress", score: t.match.score, via: "auto-apply" });
        pdfPath = pdf.path;
      });
      generated.push("résumé PDF");
    } catch { /* leave pdfPath null; field stays unfilled */ }
  }

  if (needs.cover && !cover) {
    try {
      await loggedTask("cover", `Auto-apply cover letter · ${job.company} — ${job.role}`, async (L) => {
        L("step", "Form requires a cover letter — drafting it…");
        const c = await coverLetter(base, ctx);
        createVersion({ jobId: job.id, kind: "cover-letter", content_md: c.text, llmCallId: c.callId ?? null });
        addEvent(job.id, "cover_generated", { via: "auto-apply" });
        cover = c.text;
      });
      generated.push("cover letter");
    } catch { /* leave cover null */ }
  }
  return { pdfPath, cover, generated };
}

export async function detectFormFields(url: string): Promise<FormField[]> {
  let browser: any;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
    const page = await browser.newPage({ userAgent: UA });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(renderWaitFor(url));
    const fields = (await page.evaluate(EXTRACT_FIELDS)) as FormField[];
    return fields;
  } catch {
    return [];
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// gather every Q→A we have for this job (per-job drafts, session answers, answer bank)
function gatherAnswers(jobId: string): { qa: { q: string; a: string }[]; cover: string | null } {
  const qa: { q: string; a: string }[] = [];
  const m = getMeta(`answers:${jobId}`);
  if (m) { try { for (const x of JSON.parse(m).answers || []) if (x.question && x.answer) qa.push({ q: x.question, a: x.answer }); } catch {} }
  for (const log of jobApplyActivity(jobId).answers) {
    const mt = /^Q:\s*([\s\S]*?)\nA:\s*([\s\S]*)$/.exec(log.text || "");
    if (mt) qa.push({ q: mt[1].trim(), a: mt[2].trim() });
  }
  for (const b of answerBank()) qa.push({ q: b.question, a: b.answer });
  const seen = new Set<string>();
  const out: { q: string; a: string }[] = [];
  for (const x of qa) {
    const key = x.q.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (key && !seen.has(key)) { seen.add(key); out.push(x); }
  }
  return { qa: out, cover: latestVersion(jobId, "cover-letter")?.content_md || null };
}

// Detect whether a form needs a résumé upload / dedicated cover-letter textarea, and
// if so generate the artifacts. Returns the (possibly updated) pdfPath, cover, qa pool.
async function ensureForForm(
  job: any,
  fields: { tag: string; type: string; label: string; name: string }[],
  pdfPath: string | null,
  cover: string | null
): Promise<{ pdfPath: string | null; cover: string | null; qa: { q: string; a: string }[]; generated: string[] }> {
  const isCover = (f: { label: string; name: string }) => /cover ?letter/.test(`${f.label} ${f.name}`.toLowerCase());
  const needResume = fields.some((f) => f.type === "file");
  const needCover = fields.some((f) => f.tag === "textarea" && isCover(f));
  let qa = gatherAnswers(job.id).qa;
  const generated: string[] = [];
  if ((needResume && !pdfPath) || (needCover && !cover)) {
    const ens = await ensureArtifacts(job, { resume: needResume, cover: needCover }, { pdfPath, cover });
    pdfPath = ens.pdfPath; cover = ens.cover; generated.push(...ens.generated);
    if (ens.generated.length) qa = gatherAnswers(job.id).qa;
  }
  return { pdfPath, cover, qa, generated };
}

export interface AssistResult {
  ok: boolean;
  filled: string[];
  unfilled: string[];
  ats: string;
  confidence: number; // 0-100: share of detected fields we could prefill
  at: string; // ISO timestamp of the run
  shot?: string | null; // screenshot of the prefilled form (evidence)
  message: string;
}

// Persisted snapshot of the last prefill run, surfaced in the job's Apply tab.
export function lastAssist(jobId: string): AssistResult | null {
  const raw = getMeta(`assist:${jobId}`);
  if (!raw) return null;
  try { return JSON.parse(raw) as AssistResult; } catch { return null; }
}

export const APPLY_HEADLESS = HEADLESS;

// Re-verify a posting is live (following redirects). Returns the final URL or a reason
// it's dead (in which case the job is marked closed). Shared by the per-job assist and
// the apply session.
export async function freshnessGate(jobId: string): Promise<{ ok: boolean; finalUrl?: string; reason?: string }> {
  const job = getJob(jobId);
  if (!job) return { ok: false, reason: "job not found" };
  const live = await verifyApplyUrl(job.apply_url);
  if (!live.ok) { markClosed(jobId, live.reason); return { ok: false, reason: live.reason }; }
  if (live.finalUrl && live.finalUrl !== job.apply_url) setApplyUrl(jobId, live.finalUrl);
  return { ok: true, finalUrl: live.finalUrl || job.apply_url };
}

// Prefill a job's application on an ALREADY-NAVIGATED, hydrated page (generating a
// résumé/cover first if the form requires them). Persists the result + screenshots.
// Used by both assistApply (own headed browser) and the apply SESSION (shared browser,
// one tab per job). NEVER submits.
export async function prefillJobOnPage(jobId: string, page: any, log?: (msg: string) => void): Promise<AssistResult> {
  const at = new Date().toISOString();
  const say = log || (() => {});
  const job = getJob(jobId);
  if (!job) return { ok: false, filled: [], unfilled: [], ats: "", confidence: 0, at, message: "job not found" };
  const ats = detectAts(job.apply_url);
  const contact = getDefaultProfile()?.data.contact || { name: "" };
  let pdfPath = latestVersion(jobId, "resume")?.pdf_path || null;
  let cover = gatherAnswers(jobId).cover;

  const peek = (await page.evaluate(EXTRACT_FIELDS)) as FormField[];
  const ens = await ensureForForm(job, peek, pdfPath, cover);
  pdfPath = ens.pdfPath; cover = ens.cover;
  const { generated, qa } = ens;

  const { filled, unfilled } = await prefillPage(page, { contact, pdfPath, qa, cover, log: say });

  let shot: string | null = null;
  try {
    mkdirSync(SHOT_DIR, { recursive: true });
    shot = resolve(SHOT_DIR, `assist-${jobId}.png`);
    await page.screenshot({ path: shot, fullPage: true });
  } catch { shot = null; }

  const total = filled.length + unfilled.length;
  const confidence = total ? Math.round((filled.length / total) * 100) : 0;
  const result: AssistResult = {
    ok: true, filled, unfilled, ats, confidence, at, shot,
    message: `${ats}: ${generated.length ? `generated ${generated.join(" + ")}, ` : ""}prefilled ${filled.length} field(s)${unfilled.length ? `, ${unfilled.length} need your input` : ""} — ${confidence}% ready. ${HEADLESS ? "Headless run (screenshot saved)." : "Review everything in the open browser and click Submit yourself; it never submits."}`,
  };
  setMeta(`assist:${jobId}`, JSON.stringify(result));
  addEvent(jobId, "assist_prefill", { ats, filled: filled.length, unfilled: unfilled.length, confidence, generated });
  return result;
}

// Opens a VISIBLE browser, prefills what it safely can (ATS-aware), screenshots the
// result, and leaves it open for you to review and submit. NEVER submits.
export async function assistApply(jobId: string, log?: (msg: string) => void): Promise<AssistResult> {
  const at = new Date().toISOString();
  const say = log || (() => {});
  const job = getJob(jobId);
  if (!job) return { ok: false, filled: [], unfilled: [], ats: "", confidence: 0, at, message: "job not found" };

  say("Verifying the posting is still open…");
  const gate = await freshnessGate(jobId);
  if (!gate.ok) {
    return { ok: false, filled: [], unfilled: [], ats: detectAts(job.apply_url), confidence: 0, at,
      message: `This posting is no longer applyable (${gate.reason}). I've marked it closed so it won't show up for auto-apply again.` };
  }
  const url = gate.finalUrl || job.apply_url;

  let browser: any;
  try {
    const { chromium } = await import("playwright");
    say(`Opening ${detectAts(url)} application in a ${HEADLESS ? "headless" : "visible"} browser…`);
    browser = await chromium.launch({ headless: HEADLESS }); // headed: you watch + submit
    const page = await browser.newPage({ userAgent: UA });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(renderWaitFor(url)); // React ATSes need a beat to hydrate

    const result = await prefillJobOnPage(jobId, page, say);

    // in headless (test/server) mode there's no one to submit, so close; headed stays open
    if (HEADLESS && browser) await browser.close().catch(() => {});
    return result;
  } catch (e: any) {
    if (browser) await browser.close().catch(() => {});
    return { ok: false, filled: [], unfilled: [], ats: detectAts(url), confidence: 0, at, message: `Could not open the browser to prefill (${e.message}). Use the drafted answers to apply manually.` };
  }
}
