// Auto-apply ASSIST (ported from career-ops `apply` mode).
//
// Safety: this never submits an application. It (1) reads the form to draft answers,
// and (2) optionally opens a VISIBLE browser and prefills identity fields, resume
// upload, and drafted answers — then leaves it for you to review and submit.
import { getJob, getMeta, jobApplyActivity, answerBank } from "../db.server";
import { getDefaultProfile } from "../resume/profiles.server";
import { latestVersion } from "../resume/versions.server";
import type { ResumeContact } from "../resume/types";

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
    await page.waitForTimeout(1800);
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
  message: string;
}

// Opens a VISIBLE browser, prefills what it safely can (ATS-aware), never submits.
export async function assistApply(jobId: string): Promise<AssistResult> {
  const job = getJob(jobId);
  if (!job) return { ok: false, filled: [], unfilled: [], ats: "", message: "job not found" };
  const ats = detectAts(job.apply_url);
  const contact = getDefaultProfile()?.data.contact || { name: "" };
  const pdfPath = latestVersion(jobId, "resume")?.pdf_path || null;
  const { qa, cover } = gatherAnswers(jobId);

  let browser: any;
  const filled: string[] = [];
  const unfilled: string[] = [];
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: false }); // headed: you watch + submit
    const page = await browser.newPage({ userAgent: UA });
    await page.goto(job.apply_url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(ats === "Ashby" ? 3500 : 2200); // React ATSes need a beat

    const handles = await page.$$("input, textarea");
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

        if (meta.type === "file") {
          if (pdfPath) { await el.setInputFiles(pdfPath); filled.push("résumé (upload)"); }
          continue;
        }
        const idv = valueForIdentity(meta.label, meta.name, meta.id, contact);
        if (idv) { await el.fill(idv); filled.push(meta.label || meta.name || "field"); continue; }

        if (meta.tag === "textarea") {
          const lk = `${meta.label} ${meta.name}`.toLowerCase();
          if (/cover ?letter/.test(lk) && cover) { await el.fill(cover); filled.push("cover letter"); continue; }
          const a = matchAnswer(meta.label, qa);
          if (a) { await el.fill(a); filled.push(`answer: ${meta.label.slice(0, 40)}`); continue; }
          if (meta.label) unfilled.push(meta.label.slice(0, 50));
        }
      } catch {
        /* skip uncooperative field */
      }
    }
    // leave the browser open for review + manual submit (NEVER submit)
    return {
      ok: true,
      filled,
      unfilled,
      ats,
      message: `Opened ${ats} and prefilled ${filled.length} field(s)${unfilled.length ? `, ${unfilled.length} need your input` : ""}. Review everything and click Submit yourself — it does not submit.`,
    };
  } catch (e: any) {
    if (browser) await browser.close().catch(() => {});
    return { ok: false, filled, unfilled, ats, message: `Could not open a visible browser here (${e.message}). Use the drafted answers to apply manually.` };
  }
}
