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
  // Explicit dropdown decisions (label → exact option text), usually chosen by an LLM
  // from each dropdown's real option list. Takes priority over qa/identity matching.
  picks?: { label: string; value: string }[];
  log?: (msg: string) => void;
}
export interface PrefillOutcome {
  filled: string[];
  unfilled: string[];
}

const isCoverField = (label: string, name: string) =>
  /cover ?letter/.test(`${label} ${name}`.toLowerCase());

const normLabel = (s: string) => s.toLowerCase().replace(/[*]/g, "").replace(/\s+/g, " ").trim();
// Exact (normalized) match. Labels on a form are unique, and loose substring matching is
// dangerous: "Country" is a substring of "What is your current country of residence?".
function sameLabel(a: string, b: string): boolean {
  const x = normLabel(a), y = normLabel(b);
  return !!x && x === y;
}

// Decide the value for a dropdown labelled `label`: an explicit LLM pick wins, then a
// matched free-text answer, then identity (country/location).
function dropdownWant(label: string, ctx: PrefillCtx): string | null {
  const p = (ctx.picks || []).find((p) => p.value && sameLabel(p.label, label));
  if (p) return p.value;
  const a = matchAnswer(label, ctx.qa);
  if (a) return a;
  if (/country|residence|\blocation\b|where.*based/i.test(label) && ctx.contact.location) return ctx.contact.location;
  return null;
}

// Score how well an option text matches what we want (3 exact ▸ 2 substring ▸ token overlap).
function optionScore(optText: string, want: string): number {
  const o = normLabel(optText), w = normLabel(want);
  if (!o || !w) return 0;
  if (o === w) return 3;
  if (o.includes(w) || w.includes(o)) return 2;
  const ot = new Set(o.split(" ")), wt = w.split(" ").filter((t) => t.length > 1);
  if (!wt.length) return 0;
  let inter = 0;
  for (const t of wt) if (ot.has(t)) inter++;
  return inter / wt.length; // 0..1
}

// Read the label associated with a react-select control (via its input's id → label[for],
// else the nearest ancestor label).
function comboLabel(control: any): Promise<string> {
  return control.evaluate((node: any) => {
    const input = node.querySelector("input");
    const id = input?.id;
    let lab = id ? (document.querySelector(`label[for="${id}"]`) as HTMLElement | null)?.innerText : "";
    if (!lab) {
      let p = node.parentElement, d = 0;
      while (p && d < 5) { const l = p.querySelector("label"); if (l) { lab = (l as HTMLElement).innerText; break; } p = p.parentElement; d++; }
    }
    return String(lab || "").replace(/\s+/g, " ").trim();
  });
}

// Demographic / EEO dropdowns we must NEVER auto-fill — they're voluntary and personal.
const DEMOGRAPHIC = /gender|hispanic|latino|race|ethnic|veteran|disability|sexual orientation|pronoun|transgender/i;
export const isDemographic = (label: string) => DEMOGRAPHIC.test(label);

// Find the option elements belonging to THIS react-select (scoped to its own listbox via
// the input's aria-controls), so we never read another dropdown's menu.
async function comboOptionSelector(control: any): Promise<string> {
  try {
    const input = await control.$("input");
    const listId = input ? await input.getAttribute("aria-controls") : null;
    if (listId && /^[\w-]+$/.test(listId)) return `#${listId} [role="option"], #${listId} [class*="option"]`;
  } catch {}
  return '[class*="select__menu"] [class*="select__option"], [class*="select__menu"] [role="option"]';
}

// the committed value of a react-select, read from its input's nearest control
const inputComboValue = (input: any): Promise<string> =>
  input.evaluate((n: any) => {
    const ctrl = n.closest('[class*="select__control"]');
    return (ctrl?.querySelector('[class*="single-value"]') as HTMLElement | null)?.textContent?.trim() || "";
  });

// Re-locate a combobox's control+input by matching its LABEL among freshly-queried
// controls (committing one dropdown re-renders the form and can show/hide others, so
// element handles go stale and indices shift — matching the live label is what's
// reliable). Falls back to index.
async function relocateControl(page: any, label: string, idx: number): Promise<{ control: any; input: any } | null> {
  const controls = await page.$$('div[class*="select__control"]');
  for (const c of controls) {
    const l = await comboLabel(c).catch(() => "");
    if (l && sameLabel(l, label)) {
      const input = await c.$('input:not([type="hidden"])');
      if (input) return { control: c, input };
    }
  }
  const fallback = controls[idx];
  if (fallback) { const input = await fallback.$('input:not([type="hidden"])'); if (input) return { control: fallback, input }; }
  return null;
}

// Select an option in a react-select. Options are portaled to the body and the list
// virtualizes (200-country lists never fully render), so we type into the filter to
// surface the wanted option, then press Enter (react-select commits the highlighted
// best match). Falls back to clicking the best scoped option. Returns the committed text.
async function selectInCombobox(page: any, label: string, idx: number, want: string): Promise<string | null> {
  // The LAST of several react-selects is flaky (prior commits re-render the form), so we
  // relocate fresh and retry the whole open→type→commit a few times.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const loc = await relocateControl(page, label, idx);
      if (!loc) return null;
      const { control, input } = loc;
      if (await inputComboValue(input)) return attempt === 0 ? null : await inputComboValue(input); // already set
      // react-select opens its menu on CONTROL click (the input is a 1px filter box).
      await control.scrollIntoViewIfNeeded().catch(() => {});
      await control.click();
      await page.waitForTimeout(250);
      await input.type(want.slice(0, 40), { delay: 20 });
      await page.waitForTimeout(800);
      // primary: Enter commits the highlighted (best-filtered) option
      await input.press("Enter").catch(() => {});
      await page.waitForTimeout(400);
      const v1 = await inputComboValue(input);
      if (v1) return v1;
      // fallback: click the best-matching option scoped to THIS dropdown's menu
      const listId = await input.getAttribute("aria-controls");
      const sel = listId && /^[\w-]+$/.test(listId)
        ? `#${listId} [role="option"], #${listId} [class*="option"]`
        : '[class*="select__menu"] [class*="select__option"], [class*="select__menu"] [role="option"]';
      const opts = await page.$$(sel);
      let best: any = null, best_s = 0;
      for (const o of opts) {
        const t = ((await o.innerText().catch(() => "")) || "").trim();
        if (!t || /^select\b/i.test(t)) continue;
        const s = optionScore(t, want);
        if (s > best_s) { best_s = s; best = o; }
      }
      if (best && best_s >= 0.5) {
        await best.click().catch(() => {});
        await page.waitForTimeout(150);
        const v2 = await inputComboValue(input);
        if (v2) return v2;
      }
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(200); // settle before retrying
    } catch {
      await page.keyboard.press("Escape").catch(() => {});
    }
  }
  return null;
}

// Read every dropdown (native <select> + react-select combobox) with its label and the
// list of option texts — so an LLM can choose the right option. Opens react-selects
// briefly to read their (virtualized) options, then closes them.
export async function collectDropdownOptions(page: any): Promise<{ label: string; options: string[] }[]> {
  const out: { label: string; options: string[] }[] = [];
  try {
    const selects = await page.$$("select");
    for (const el of selects) {
      const info = await el.evaluate((node: any) => {
        const labelEl = node.id ? document.querySelector(`label[for="${node.id}"]`) : null;
        const label = ((labelEl as HTMLElement | null)?.innerText || node.getAttribute("aria-label") || node.name || "").replace(/\s+/g, " ").trim();
        const visible = !!node.offsetParent && !node.disabled;
        return { label, visible, options: Array.from(node.options).map((o: any) => (o.text || "").trim()).filter(Boolean) };
      });
      if (info.visible && info.label) out.push({ label: info.label, options: info.options });
    }
  } catch {}
  try {
    const controls = await page.$$('div[class*="select__control"]');
    for (const c of controls) {
      const label = await comboLabel(c).catch(() => "");
      if (!label || isDemographic(label)) continue; // never auto-fill EEO/demographic
      let options: string[] = [];
      try {
        const sel = await comboOptionSelector(c);
        await c.click();
        await page.waitForTimeout(250);
        options = await page.$$eval(sel, (els: any[]) =>
          els.map((e) => (e.textContent || "").trim()).filter((t) => t && !/^select\b/i.test(t)).slice(0, 80)
        );
        await page.keyboard.press("Escape");
        await page.waitForTimeout(80);
      } catch {}
      out.push({ label, options });
    }
  } catch {}
  return out;
}

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
        // react-select renders a text input we must NOT type identity into — it's the
        // dropdown's filter box; handled separately as a combobox.
        const combo = node.getAttribute("role") === "combobox" || !!node.closest('[class*="select__control"]');
        return { tag, type, name: node.name || "", id: node.id || "", label: String(label).replace(/\s+/g, " ").trim(), visible, combo };
      });
      if (["hidden", "submit", "button", "search", "checkbox", "radio"].includes(meta.type)) continue;
      if (!meta.visible || meta.combo) continue;

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

  // --- native <select> dropdowns ---
  const selects = await page.$$("select");
  for (const el of selects) {
    try {
      const info = await el.evaluate((node: any) => {
        const labelEl = node.id ? document.querySelector(`label[for="${node.id}"]`) : null;
        const label = ((labelEl as HTMLElement | null)?.innerText || node.getAttribute("aria-label") || node.name || "").replace(/\s+/g, " ").trim();
        const visible = !!node.offsetParent && !node.disabled;
        return { label, visible, options: Array.from(node.options).map((o: any) => ({ value: o.value, text: (o.text || "").trim() })) };
      });
      if (!info.visible || !info.label || isDemographic(info.label)) continue;
      const want = dropdownWant(info.label, ctx);
      if (!want) { unfilled.push(info.label.slice(0, 50)); continue; }
      // best-matching option by score
      let best: any = null, best_s = 0;
      for (const o of info.options) { if (!o.value || !o.text) continue; const s = optionScore(o.text, want); if (s > best_s) { best_s = s; best = o; } }
      if (best && best_s > 0) {
        await el.selectOption(best.value);
        filled.push(`select: ${info.label.slice(0, 40)}`);
        log(`✓ select: ${info.label.slice(0, 40)} → ${best.text}`);
      } else unfilled.push(info.label.slice(0, 50));
    } catch { /* skip */ }
  }

  // --- react-select comboboxes (Greenhouse/Ashby custom dropdowns) ---
  // IMPORTANT: committing a react-select value re-renders the form and detaches the
  // other control handles, so we read all labels up front, then RE-QUERY a fresh handle
  // (by index) right before filling each one.
  const initial = await page.$$('div[class*="select__control"]');
  const metas: { idx: number; label: string }[] = [];
  for (let i = 0; i < initial.length; i++) {
    const info = await initial[i].evaluate((node: any) => {
      const input = node.querySelector("input");
      const id = input?.id || "";
      let lab = id ? (document.querySelector(`label[for="${id}"]`) as HTMLElement | null)?.innerText : "";
      if (!lab) { let p = node.parentElement, d = 0; while (p && d < 5) { const l = p.querySelector("label"); if (l) { lab = (l as HTMLElement).innerText; break; } p = p.parentElement; d++; } }
      return { id, label: String(lab || "").replace(/\s+/g, " ").trim() };
    }).catch(() => ({ id: "", label: "" }));
    metas.push({ idx: i, label: info.label });
  }
  for (const m of metas) {
    try {
      if (!m.label || isDemographic(m.label)) continue;
      const want = dropdownWant(m.label, ctx);
      if (!want) { unfilled.push(m.label.slice(0, 50)); continue; }
      const chosen = await selectInCombobox(page, m.label, m.idx, want);
      if (chosen) { filled.push(`select: ${m.label.slice(0, 40)}`); log(`✓ select: ${m.label.slice(0, 40)} → ${chosen}`); }
      else unfilled.push(m.label.slice(0, 50));
    } catch { /* skip */ }
  }

  return { filled, unfilled };
}
