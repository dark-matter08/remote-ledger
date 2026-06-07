// Auto-apply ASSIST (ported from career-ops `apply` mode).
//
// Safety: this never submits an application. It (1) reads the form to draft answers,
// and (2) optionally opens a VISIBLE browser and prefills identity fields, resume
// upload, and drafted answers — then leaves it for you to review and submit.
import { getJob } from "../db.server";
import { getDefaultProfile, getProfile } from "../resume/profiles.server";
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

function valueForIdentity(label: string, name: string, c: ResumeContact): string | null {
  const k = `${label} ${name}`.toLowerCase();
  const links = c.links || [];
  const find = (re: RegExp) => links.find((l) => re.test(l.label + " " + l.url))?.url;
  if (/first name/.test(k)) return c.name?.split(" ")[0] || null;
  if (/last name|surname/.test(k)) return c.name?.split(" ").slice(1).join(" ") || null;
  if (/full name|^name|your name/.test(k)) return c.name || null;
  if (/e-?mail/.test(k)) return c.email || null;
  if (/phone|mobile|tel/.test(k)) return c.phone || null;
  if (/linkedin/.test(k)) return find(/linkedin/i) || null;
  if (/github/.test(k)) return find(/github/i) || null;
  if (/portfolio|website|url/.test(k)) return find(/.*/) || null;
  if (/location|city|where.*based|country/.test(k)) return c.location || null;
  return null;
}

export interface AssistResult {
  ok: boolean;
  filled: string[];
  message: string;
}

// Opens a VISIBLE browser, prefills what it safely can, never submits.
export async function assistApply(jobId: string): Promise<AssistResult> {
  const job = getJob(jobId);
  if (!job) return { ok: false, filled: [], message: "job not found" };
  const profile = getDefaultProfile();
  const contact = profile?.data.contact || { name: "" };
  const resumeV = latestVersion(jobId, "resume");
  const pdfPath = resumeV?.pdf_path || null;

  let browser: any;
  const filled: string[] = [];
  try {
    const { chromium } = await import("playwright");
    // headed so the candidate watches + reviews before submitting
    browser = await chromium.launch({ headless: false });
    const page = await browser.newPage({ userAgent: UA });
    await page.goto(job.apply_url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(2000);

    const handles = await page.$$("input, textarea");
    for (const el of handles) {
      try {
        const meta = await el.evaluate((node: any) => {
          const tag = node.tagName.toLowerCase();
          const type = tag === "textarea" ? "textarea" : node.type || "text";
          const labelEl = node.id ? document.querySelector(`label[for="${node.id}"]`) : null;
          const label =
            (labelEl as HTMLElement | null)?.innerText ||
            node.getAttribute("aria-label") ||
            node.getAttribute("placeholder") ||
            node.name ||
            "";
          return { tag, type, name: node.name || "", label: String(label).replace(/\s+/g, " ").trim() };
        });
        if (["hidden", "submit", "button", "checkbox", "radio"].includes(meta.type)) continue;

        if (meta.type === "file") {
          if (pdfPath) {
            await el.setInputFiles(pdfPath);
            filled.push(`resume → "${meta.label || "file"}"`);
          }
          continue;
        }
        const idv = valueForIdentity(meta.label, meta.name, contact);
        if (idv) {
          await el.fill(idv);
          filled.push(`${meta.label || meta.name}`);
        }
      } catch {
        /* skip uncooperative field */
      }
    }
    // leave the browser open for review + manual submit (do NOT close)
    return {
      ok: true,
      filled,
      message: `Opened the application and prefilled ${filled.length} field(s). Review the rest, paste your drafted answers, and submit it yourself.`,
    };
  } catch (e: any) {
    if (browser) await browser.close().catch(() => {});
    return {
      ok: false,
      filled,
      message: `Could not open a visible browser here (${e.message}). Use the drafted answers to apply manually.`,
    };
  }
}
