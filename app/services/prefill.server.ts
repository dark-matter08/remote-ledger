// Pure browser-side form-fill engine for assisted auto-apply.
//
// This module has NO database / native imports on purpose: it is the testable core
// that both the per-job assist (its own headed browser) and the apply SESSION (one
// shared headed browser, a tab per job) call to actually populate a real application
// form. It NEVER clicks submit.
//
// A `Page` here is a Playwright Page; we keep it as `any` so this file stays free of
// the native better-sqlite3 graph and can be exercised by a standalone headless test.
import type { ResumeContact } from "../resume/types";

export const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

export interface FormField {
  tag: string;
  type: string;
  name: string;
  label: string;
  required: boolean;
}

// Identity field → value. Covers Greenhouse first_name, Lever urls[LinkedIn],
// Workable firstname, Ashby aria-labels, etc.
export function valueForIdentity(label: string, name: string, id: string, c: ResumeContact): string | null {
  const k = `${label} ${name} ${id}`.toLowerCase();
  const short = label.trim().length <= 30 || !!name || !!id; // long labels are custom questions
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
  if (/myworkdayjobs|workday/.test(h)) return "Workday";
  return "the form";
}

// Free-text questions worth drafting answers for.
export function questionFields(fields: FormField[]): string[] {
  return fields
    .filter(
      (f) =>
        f.tag === "textarea" ||
        /\?|why|describe|tell us|cover|motivat|interest|fit|about you|experience/i.test(f.label)
    )
    .map((f) => f.label);
}

const toks = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w.length > 2));
export function matchAnswer(label: string, qa: { q: string; a: string }[]): string | null {
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

// In-page extractor for read-only field detection (no element handles).
export const EXTRACT_FIELDS = () => {
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

export interface PrefillCtx {
  contact: ResumeContact;
  pdfPath: string | null;
  qa: { q: string; a: string }[];
  cover: string | null;
  log?: (msg: string) => void;
}
export interface PrefillOutcome {
  filled: string[];
  unfilled: string[];
}

const isCoverField = (label: string, name: string) =>
  /cover ?letter/.test(`${label} ${name}`.toLowerCase());

// The heart of assisted apply: given a hydrated Playwright page, fill everything we
// safely can (identity inputs, résumé upload, cover-letter + matched answer textareas,
// and simple <select> dropdowns). Returns what was filled vs. what still needs input.
// NEVER submits.
export async function prefillPage(page: any, ctx: PrefillCtx): Promise<PrefillOutcome> {
  const { contact, pdfPath, qa, cover } = ctx;
  const log = ctx.log || (() => {});
  const filled: string[] = [];
  const unfilled: string[] = [];

  // --- inputs + textareas (element handles so we can fill them) ---
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
        const visible = !!(node.offsetParent || node.type === "file") && !node.disabled && !node.readOnly;
        return { tag, type, name: node.name || "", id: node.id || "", label: String(label).replace(/\s+/g, " ").trim(), visible };
      });
      if (["hidden", "submit", "button", "search", "checkbox", "radio"].includes(meta.type)) continue;
      if (!meta.visible) continue;

      if (meta.type === "file") {
        if (pdfPath) {
          await el.setInputFiles(pdfPath);
          filled.push("résumé (upload)");
          log(`✓ uploaded résumé`);
        } else unfilled.push("résumé upload");
        continue;
      }

      const idv = valueForIdentity(meta.label, meta.name, meta.id, contact);
      if (idv) {
        await el.fill(idv);
        filled.push(meta.label || meta.name || "field");
        log(`✓ ${meta.label || meta.name}`);
        continue;
      }

      if (meta.tag === "textarea") {
        if (isCoverField(meta.label, meta.name) && cover) {
          await el.fill(cover);
          filled.push("cover letter");
          log(`✓ cover letter`);
          continue;
        }
        const a = matchAnswer(meta.label, qa);
        if (a) {
          await el.fill(a);
          filled.push(`answer: ${meta.label.slice(0, 40)}`);
          log(`✓ answer: ${meta.label.slice(0, 40)}`);
          continue;
        }
        if (meta.label) unfilled.push(meta.label.slice(0, 50));
      }
    } catch {
      /* skip uncooperative field */
    }
  }

  // --- <select> dropdowns: choose the option that matches a known answer ---
  const selects = await page.$$("select");
  for (const el of selects) {
    try {
      const info = await el.evaluate((node: any) => {
        const labelEl = node.id ? document.querySelector(`label[for="${node.id}"]`) : null;
        const label =
          (labelEl as HTMLElement | null)?.innerText ||
          node.getAttribute("aria-label") ||
          node.name ||
          "";
        const visible = !!node.offsetParent && !node.disabled;
        return {
          label: String(label).replace(/\s+/g, " ").trim(),
          visible,
          options: Array.from(node.options).map((o: any) => ({ value: o.value, text: (o.text || "").trim() })),
        };
      });
      if (!info.visible || !info.label) continue;
      // value to look for: a matched free-text answer, or location/country identity
      let want = matchAnswer(info.label, qa);
      if (!want && /country|location|based/i.test(info.label)) want = contact.location || null;
      if (!want) { unfilled.push(info.label.slice(0, 50)); continue; }
      const wl = want.toLowerCase();
      const opt = info.options.find(
        (o: any) => o.value && o.text && (o.text.toLowerCase().includes(wl) || wl.includes(o.text.toLowerCase()))
      );
      if (opt) {
        await el.selectOption(opt.value);
        filled.push(`select: ${info.label.slice(0, 40)}`);
        log(`✓ select: ${info.label.slice(0, 40)} → ${opt.text}`);
      } else {
        unfilled.push(info.label.slice(0, 50));
      }
    } catch {
      /* skip */
    }
  }

  return { filled, unfilled };
}
