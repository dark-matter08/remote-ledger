// Auto-apply ASSIST (ported from career-ops `apply` mode).
//
// Safety: this never submits an application. It (1) reads the form to draft answers,
// and (2) optionally opens a VISIBLE browser and prefills identity fields, resume
// upload, and drafted answers — then leaves it for you to review and submit.
import { getJob, getMeta, setMeta, addEvent, markClosed, setApplyUrl, jobApplyActivity, answerBank } from "../db.server";
import { getDefaultProfile } from "../resume/profiles.server";
import { latestVersion, createVersion, setVersionPdf } from "../resume/versions.server";
import { tailorResume, coverLetter } from "../resume/ai.server";
import { renderResumePdf } from "../resume/pdf.server";
import { verifyApplyUrl, renderWaitFor } from "./scrape.server";
import { loggedTask } from "./crawl.server";
import type { ResumeContact } from "../resume/types";

// When a form requires a résumé upload and/or cover letter that we don't yet have for
// this job, generate them on the fly (tailor → PDF, draft cover) so the prefill can use
// them. Each generation streams in the Crawl Shell. Returns updated paths + what we made.
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

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

export interface FormField {
  tag: string;
  type: string;
  name: string;
  label: string;
  required: boolean;
}

const EXTRACT_FIELDS = () => {
  const out: any[] = [];
  const labelFor = (el: any) => {
    if (el.id) {
      const l = document.querySelector(`label[for="${el.id}"]`) as HTMLElement | null;
      if (l) return l.innerText;
    }
    const wrap = el.closest("label") as HTMLElement | null;
    if (wrap) return wrap.innerText;
    return el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.name || "";
  };
  document.querySelectorAll("input, textarea, select").forEach((el: any) => {
    const tag = el.tagName.toLowerCase();
    const type = tag === "textarea" ? "textarea" : el.type || "text";
    if (["hidden", "submit", "button", "search", "checkbox", "radio"].includes(type)) return;
    const label = (labelFor(el) || "").replace(/\s+/g, " ").trim().slice(0, 140);
    if (!label) return;
    out.push({ tag, type, name: el.name || "", label, required: !!el.required });
  });
  return out.slice(0, 60);
};

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

// free-text questions worth drafting answers for
export function questionFields(fields: FormField[]): string[] {
  return fields
    .filter(
      (f) =>
        f.tag === "textarea" ||
        /\?|why|describe|tell us|cover|motivat|interest|fit|about you|experience/i.test(f.label)
    )
    .map((f) => f.label);
}

// classify an identity field from its label + name + id (covers Greenhouse first_name,
// Lever urls[LinkedIn], Workable firstname, Ashby aria-labels, etc.) and return the value.
function valueForIdentity(label: string, name: string, id: string, c: ResumeContact): string | null {
  const k = `${label} ${name} ${id}`.toLowerCase();
  // identity fields have short labels; long ones are almost always custom questions.
  const short = label.trim().length <= 30 || !!name || !!id;
  const links = c.links || [];
  const find = (re: RegExp) => links.find((l) => re.test(`${l.label} ${l.url}`))?.url;
  if (/first[\s_-]?name|fname|given[\s_-]?name/.test(k)) return c.name?.split(" ")[0] || null;
  if (/last[\s_-]?name|surname|lname|family[\s_-]?name/.test(k)) return c.name?.split(" ").slice(1).join(" ") || null;
  if (/e-?mail/.test(k)) return c.email || null;
  if (/phone|mobile|\btel\b/.test(k)) return c.phone || null;
  if (/linkedin/.test(k)) return find(/linkedin/i) || null;
  if (/github/.test(k)) return find(/github/i) || null;
  if (short && /portfolio|personal (site|website)|\bwebsite\b|urls\[other\]/.test(k)) return find(/.*/) || null;
  if (short && /\blocation\b|^city\b|\bcountry\b|where.*based/.test(k)) return c.location || null;
  if (short && /full[\s_-]?name|your name|\bname\b/.test(k)) return c.name || null; // after first/last
  return null;
}

export function detectAts(url: string): string {
  const h = (() => { try { return new URL(url).hostname; } catch { return ""; } })();
  if (/greenhouse/.test(h)) return "Greenhouse";
  if (/lever\.co/.test(h)) return "Lever";
  if (/ashbyhq/.test(h)) return "Ashby";
  if (/workable/.test(h)) return "Workable";
  return "the form";
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

const toks = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w.length > 2));
function matchAnswer(label: string, qa: { q: string; a: string }[]): string | null {
  const lt = toks(label);
  if (!lt.size) return null;
  let best: string | null = null, bestScore = 0;
  for (const x of qa) {
    const qt = toks(x.q);
    let inter = 0;
    for (const t of lt) if (qt.has(t)) inter++;
    const score = inter / Math.max(1, Math.min(lt.size, qt.size));
    if (score > bestScore) { bestScore = score; best = x.a; }
  }
  return bestScore >= 0.5 ? best : null;
}

export interface AssistResult {
  ok: boolean;
  filled: string[];
  unfilled: string[];
  ats: string;
  confidence: number; // 0-100: share of detected fields we could prefill
  at: string; // ISO timestamp of the run
  message: string;
}

// Persisted snapshot of the last prefill run, surfaced in the job's Apply tab.
export function lastAssist(jobId: string): AssistResult | null {
  const raw = getMeta(`assist:${jobId}`);
  if (!raw) return null;
  try { return JSON.parse(raw) as AssistResult; } catch { return null; }
}

// Opens a VISIBLE browser, prefills what it safely can (ATS-aware), never submits.
export async function assistApply(jobId: string): Promise<AssistResult> {
  const at = new Date().toISOString();
  const job = getJob(jobId);
  if (!job) return { ok: false, filled: [], unfilled: [], ats: "", confidence: 0, at, message: "job not found" };

  // FRESHNESS GATE: never auto-apply to a posting that's closed/gone. Re-verify the
  // link is still a live, open application right now (following any redirect to the
  // final employer page). If it's dead, mark the job closed and refuse.
  const live = await verifyApplyUrl(job.apply_url);
  if (!live.ok) {
    markClosed(jobId, live.reason);
    return { ok: false, filled: [], unfilled: [], ats: detectAts(job.apply_url), confidence: 0, at,
      message: `This posting is no longer applyable (${live.reason}). I've marked it closed so it won't show up for auto-apply again.` };
  }
  if (live.finalUrl && live.finalUrl !== job.apply_url) { setApplyUrl(jobId, live.finalUrl); job.apply_url = live.finalUrl; }

  const ats = detectAts(job.apply_url);
  const contact = getDefaultProfile()?.data.contact || { name: "" };
  let pdfPath = latestVersion(jobId, "resume")?.pdf_path || null;
  let { qa, cover } = gatherAnswers(jobId);
  const generated: string[] = [];

  let browser: any;
  const filled: string[] = [];
  const unfilled: string[] = [];
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: false }); // headed: you watch + submit
    const page = await browser.newPage({ userAgent: UA });
    await page.goto(job.apply_url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(renderWaitFor(job.apply_url)); // React ATSes need a beat to hydrate

    // 1) read every field once (with its element handle)
    const handles = await page.$$("input, textarea");
    const fields: { el: any; tag: string; type: string; name: string; id: string; label: string }[] = [];
    for (const el of handles) {
      try {
        const meta = await el.evaluate((node: any) => {
          const tag = node.tagName.toLowerCase();
          const type = tag === "textarea" ? "textarea" : node.type || "text";
          const labelEl = node.id ? document.querySelector(`label[for="${node.id}"]`) : null;
          const label = (labelEl as HTMLElement | null)?.innerText || node.getAttribute("aria-label") || node.getAttribute("placeholder") || node.name || "";
          return { tag, type, name: node.name || "", id: node.id || "", label: String(label).replace(/\s+/g, " ").trim() };
        });
        if (["hidden", "submit", "button", "search", "checkbox", "radio"].includes(meta.type)) continue;
        fields.push({ el, ...meta });
      } catch { /* skip */ }
    }

    // 2) if the form needs a résumé upload / cover letter we don't have yet, generate them
    const isCover = (f: { label: string; name: string }) => /cover ?letter/.test(`${f.label} ${f.name}`.toLowerCase());
    const needResume = fields.some((f) => f.type === "file");
    const needCover = fields.some((f) => f.tag === "textarea" && isCover(f));
    if ((needResume && !pdfPath) || (needCover && !cover)) {
      const ens = await ensureArtifacts(job, { resume: needResume, cover: needCover }, { pdfPath, cover });
      pdfPath = ens.pdfPath; cover = ens.cover; generated.push(...ens.generated);
      // a generated cover letter should also be matchable; refresh the QA pool's cover
      if (ens.generated.length) qa = gatherAnswers(jobId).qa;
    }

    // 3) fill
    for (const f of fields) {
      try {
        if (f.type === "file") {
          if (pdfPath) { await f.el.setInputFiles(pdfPath); filled.push("résumé (upload)"); }
          else unfilled.push("résumé upload");
          continue;
        }
        const idv = valueForIdentity(f.label, f.name, f.id, contact);
        if (idv) { await f.el.fill(idv); filled.push(f.label || f.name || "field"); continue; }

        if (f.tag === "textarea") {
          if (isCover(f) && cover) { await f.el.fill(cover); filled.push("cover letter"); continue; }
          const a = matchAnswer(f.label, qa);
          if (a) { await f.el.fill(a); filled.push(`answer: ${f.label.slice(0, 40)}`); continue; }
          if (f.label) unfilled.push(f.label.slice(0, 50));
        }
      } catch { /* skip uncooperative field */ }
    }
    // leave the browser open for review + manual submit (NEVER submit)
    const total = filled.length + unfilled.length;
    const confidence = total ? Math.round((filled.length / total) * 100) : 0;
    const result: AssistResult = {
      ok: true,
      filled,
      unfilled,
      ats,
      confidence,
      at,
      message: `${ats}: ${generated.length ? `generated ${generated.join(" + ")}, ` : ""}prefilled ${filled.length} field(s)${unfilled.length ? `, ${unfilled.length} need your input` : ""} — ${confidence}% ready. Review everything and click Submit yourself; it does not submit.`,
    };
    setMeta(`assist:${jobId}`, JSON.stringify(result));
    addEvent(jobId, "assist_prefill", { ats, filled: filled.length, unfilled: unfilled.length, confidence, generated });
    return result;
  } catch (e: any) {
    if (browser) await browser.close().catch(() => {});
    return { ok: false, filled, unfilled, ats, confidence: 0, at, message: `Could not open a visible browser here (${e.message}). Use the drafted answers to apply manually.` };
  }
}
