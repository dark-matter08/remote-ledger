// Knowledge base: what the agent knows about you, used to keep building your résumé.
// Two inputs feed it:
//   1) manual notes ("what I'm working on")
//   2) an opt-in folder scan — the local runner READS project files, summarizes each
//      project, drafts factual résumé bullets, and poses clarifying questions.
// Everything lands in a separate KB (kb_items/kb_questions/kb_suggestions). Drafted
// bullets are PROPOSALS — you approve them before they touch a résumé profile.
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, basename, extname, relative } from "node:path";
import { getDb } from "../sqlite.server";
import { runLLM, tryParseJson } from "../llm/runner.server";
import { getDefaultProfile, saveProfile } from "../resume/profiles.server";
import { createCrawlRun, crawlLog, updateCrawlRun } from "../db.server";

const NOW = () => new Date().toISOString();

export interface KbItem { id: number; kind: string; title: string; summary: string; tags: string[]; source: string; source_path: string | null; created_at: string; updated_at: string; }
export interface KbQuestion { id: number; item_id: number | null; question: string; answer: string | null; title?: string | null; }
export interface KbSuggestion { id: number; item_id: number | null; section: string; bullet: string; status: string; title?: string | null; }
export interface KbScan { id: number; path: string; status: string; found: number; note: string | null; started_at: string; ended_at: string | null; }

// ---------- reads ----------
export function kbItems(): KbItem[] {
  return (getDb().prepare("SELECT * FROM kb_items ORDER BY updated_at DESC").all() as any[]).map((r) => ({ ...r, tags: safeTags(r.tags) }));
}
export function kbOpenQuestions(): KbQuestion[] {
  return getDb().prepare("SELECT q.*, i.title FROM kb_questions q LEFT JOIN kb_items i ON i.id=q.item_id WHERE q.answer IS NULL ORDER BY q.created_at").all() as any[];
}
export function kbSuggestions(status = "pending"): KbSuggestion[] {
  return getDb().prepare("SELECT s.*, i.title FROM kb_suggestions s LEFT JOIN kb_items i ON i.id=s.item_id WHERE s.status=? ORDER BY s.created_at DESC").all(status) as any[];
}
// Scans are recorded as crawl_runs (type='scan') so they show in the Crawl Shell with
// live step logs. These map run rows back to the shape the KB page expects.
export function kbScans(limit = 5): KbScan[] {
  return (getDb().prepare("SELECT * FROM crawl_runs WHERE type='scan' ORDER BY id DESC LIMIT ?").all(limit) as any[])
    .map((r) => ({ id: r.id, path: r.note || "", status: r.status, found: r.scraped, note: null, started_at: r.started_at, ended_at: r.ended_at }));
}
export function activeScan(): KbScan | null {
  const r = getDb().prepare("SELECT * FROM crawl_runs WHERE type='scan' AND status='running' ORDER BY id DESC LIMIT 1").get() as any;
  return r ? { id: r.id, path: r.note || "", status: r.status, found: r.scraped, note: null, started_at: r.started_at, ended_at: r.ended_at } : null;
}
function safeTags(v: any): string[] { try { const t = JSON.parse(v); return Array.isArray(t) ? t : []; } catch { return []; } }

// ---------- writes ----------
function insertItem(o: { kind: string; title: string; summary: string; tags: string[]; source: string; source_path?: string | null }): number {
  const now = NOW();
  const info = getDb().prepare(
    "INSERT INTO kb_items (kind,title,summary,tags,source,source_path,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)"
  ).run(o.kind, o.title.slice(0, 200), (o.summary || "").slice(0, 4000), JSON.stringify((o.tags || []).slice(0, 30)), o.source, o.source_path ?? null, now, now);
  return Number(info.lastInsertRowid);
}
function addQuestions(itemId: number, qs: string[]) {
  const now = NOW();
  const stmt = getDb().prepare("INSERT INTO kb_questions (item_id,question,created_at) VALUES (?,?,?)");
  for (const q of (qs || []).slice(0, 6)) if (q && q.trim()) stmt.run(itemId, q.trim().slice(0, 400), now);
}
function addSuggestions(itemId: number, items: { section?: string; bullet: string }[]) {
  const now = NOW();
  const stmt = getDb().prepare("INSERT INTO kb_suggestions (item_id,section,bullet,created_at) VALUES (?,?,?,?)");
  for (const s of (items || []).slice(0, 8)) if (s.bullet && s.bullet.trim()) stmt.run(itemId, normalizeSection(s.section), s.bullet.trim().slice(0, 600), now);
}
const normalizeSection = (s?: string) => (["project", "experience", "skill", "summary"].includes(String(s)) ? String(s) : "project");

export function answerKbQuestion(id: number, answer: string): void {
  getDb().prepare("UPDATE kb_questions SET answer=?, answered_at=? WHERE id=?").run(answer.slice(0, 2000), NOW(), id);
}
export function deleteKbQuestion(id: number): void {
  getDb().prepare("DELETE FROM kb_questions WHERE id=?").run(id);
}
export function dismissSuggestion(id: number): void {
  getDb().prepare("UPDATE kb_suggestions SET status='dismissed' WHERE id=?").run(id);
}
export function deleteKbItem(id: number): void {
  const db = getDb();
  db.prepare("DELETE FROM kb_questions WHERE item_id=?").run(id);
  db.prepare("DELETE FROM kb_suggestions WHERE item_id=?").run(id);
  db.prepare("DELETE FROM kb_items WHERE id=?").run(id);
}

// Accept a drafted bullet into the default résumé profile (you approved it).
export function acceptSuggestion(id: number): { ok: boolean; msg: string } {
  const db = getDb();
  const s = db.prepare("SELECT s.*, i.title, i.tags FROM kb_suggestions s LEFT JOIN kb_items i ON i.id=s.item_id WHERE s.id=?").get(id) as any;
  if (!s) return { ok: false, msg: "suggestion not found" };
  const profile = getDefaultProfile();
  if (!profile) return { ok: false, msg: "No default résumé. Upload one first." };
  const data = profile.data;
  if (s.section === "skill") {
    data.skills = data.skills || [];
    const exists = data.skills.some((k) => k.toLowerCase() === s.bullet.toLowerCase());
    if (!exists) data.skills.push(s.bullet);
  } else if (s.section === "summary") {
    data.summary = ((data.summary || "") + " " + s.bullet).trim();
  } else {
    // project/experience → attach to a project entry named after the KB item
    data.projects = data.projects || [];
    const title = s.title || "Recent work";
    let proj = data.projects.find((p) => p.name.toLowerCase() === String(title).toLowerCase());
    if (!proj) { proj = { name: title, bullets: [] }; data.projects.unshift(proj); }
    proj.bullets = proj.bullets || [];
    if (!proj.bullets.includes(s.bullet)) proj.bullets.push(s.bullet);
  }
  saveProfile({ id: profile.id, name: profile.name, data });
  db.prepare("UPDATE kb_suggestions SET status='accepted' WHERE id=?").run(id);
  return { ok: true, msg: `Added to “${profile.name}”.` };
}

// ---------- LLM extraction ----------
// This is the USER'S OWN work — attribute everything to them ("you"), don't hedge about
// collaborators or claim the role is unclear; assume ownership unless evidence clearly says otherwise.
const SYSTEM = "You build a developer's personal knowledge base from THEIR OWN projects, for résumé writing. The folder and notes belong to the user — treat the user as the owner/primary author and write about it as their work ('you'/'your'). Do NOT speculate that the role is unclear or that collaborators may have done it; assume the user built it unless the evidence clearly contradicts that. Be concrete about WHAT the project is and DOES (purpose, what problem it solves, architecture, stack) — infer this from the code when the README is thin. Only invent nothing; when a specific metric/scope is genuinely unknown, put it in a question. Output ONLY valid JSON.";

interface Analysis { title: string; kind: string; summary: string; tags: string[]; bullets: string[]; questions: string[] }

async function analyze(mode: "note" | "project", title: string, body: string, note?: string, deep = false): Promise<Analysis> {
  const ctx = note ? `\n\nContext you gave about this work: "${note}"` : "";
  const deepNote = deep ? "\n\nSource files are included below — READ THEM to determine what the project actually does, especially if the README is thin or missing." : "";
  const cap = deep ? 60000 : 14000;
  const prompt = `${mode === "project" ? "Analyze YOUR OWN software project from its files" : "You described what you're working on"}:${ctx}${deepNote}\n\n"""${body.slice(0, cap)}"""\n\nReturn JSON:\n{\n  "title": "short project name",\n  "kind": "project|experience|skill",\n  "summary": "2-4 sentence summary: what the project IS and DOES (purpose, key features, architecture, stack) and your role building it — written about your own work, never in vague third person",\n  "tags": ["tech","stack","tools actually used"],\n  "bullets": ["2-4 résumé bullets, action-led, first-person-friendly, factual; quantify ONLY if the evidence gives numbers"],\n  "questions": ["1-3 questions ONLY for genuinely missing specifics (impact metrics, team size); do not ask who built it"]\n}`;
  const r = await runLLM({ purpose: "misc", system: SYSTEM, prompt, json: true, maxTokens: 1800, temperature: 0.3 });
  const j = tryParseJson(r.text) || {};
  return {
    title: String(j.title || title), kind: normalizeKind(j.kind), summary: String(j.summary || ""),
    tags: Array.isArray(j.tags) ? j.tags.map(String) : [],
    bullets: Array.isArray(j.bullets) ? j.bullets.map(String) : [],
    questions: Array.isArray(j.questions) ? j.questions.map(String) : [],
  };
}

// Compact KB context (your captured projects/skills) for grounding application answers.
export function kbContext(limit = 12): string {
  const items = kbItems().slice(0, limit);
  if (!items.length) return "";
  return items.map((i) => `- ${i.title} (${i.kind}): ${i.summary}${i.tags.length ? ` [${i.tags.join(", ")}]` : ""}`).join("\n");
}
const normalizeKind = (k?: string) => (["project", "experience", "skill", "fact"].includes(String(k)) ? String(k) : "project");

export async function addManualNote(text: string): Promise<number> {
  const a = await analyze("note", "Recent work", text);
  const id = insertItem({ kind: a.kind, title: a.title, summary: a.summary, tags: a.tags, source: "manual" });
  addSuggestions(id, a.bullets.map((b) => ({ section: "project", bullet: b })));
  addQuestions(id, a.questions);
  return id;
}

// Re-draft a few fresh bullets for an item after its questions get answered.
export async function redraftItem(itemId: number): Promise<void> {
  const db = getDb();
  const item = db.prepare("SELECT * FROM kb_items WHERE id=?").get(itemId) as any;
  if (!item) return;
  const qas = db.prepare("SELECT question, answer FROM kb_questions WHERE item_id=? AND answer IS NOT NULL").all(itemId) as any[];
  if (!qas.length) return;
  const prompt = `Project: ${item.title}\nSummary: ${item.summary}\nTech: ${safeTags(item.tags).join(", ")}\n\nThe developer answered clarifying questions:\n${qas.map((q) => `Q: ${q.question}\nA: ${q.answer}`).join("\n")}\n\nUsing ONLY these facts, write 2-3 stronger résumé bullets. Return JSON: {"bullets":["..."]}`;
  const r = await runLLM({ purpose: "misc", system: SYSTEM, prompt, json: true, maxTokens: 800, temperature: 0.3 });
  const j = tryParseJson(r.text) || {};
  addSuggestions(itemId, (Array.isArray(j.bullets) ? j.bullets : []).map((b: string) => ({ section: "project", bullet: String(b) })));
}

// ---------- folder scan ----------
const SKIP_DIR = new Set(["node_modules", ".git", "dist", "build", ".next", "out", "vendor", "target", ".venv", "venv", "__pycache__", ".turbo", "coverage", ".cache", ".idea", ".vscode"]);
const MANIFESTS = ["package.json", "pyproject.toml", "Cargo.toml", "go.mod", "requirements.txt", "composer.json", "Gemfile", "pom.xml", "build.gradle"];
const READMES = ["README.md", "README.MD", "Readme.md", "readme.md", "README.txt", "README"];

export type ScanDepth = "quick" | "standard" | "deep";
const CODE_EXT = /\.(ts|tsx|js|jsx|py|rs|go|java|rb|php|c|cc|cpp|h|hpp|cs|swift|kt|scala|sql|sh|vue|svelte|astro|ml|ex|exs|clj|prisma|graphql|proto)$/i;
const DOC_EXT = /\.(md|mdx|txt|toml|ya?ml|json)$/i;

// Rank a file by how much it reveals about the project's purpose (read these first in deep scans).
function fileScore(rel: string): number {
  const base = basename(rel).toLowerCase();
  let s = 0;
  if (/^(index|main|app|server|cli|mod|entry)\.(ts|tsx|js|jsx|py|go|rs|java|rb)$/.test(base)) s += 7;
  if (/(readme|architecture|design|spec|overview|openapi)/i.test(base)) s += 6;
  if (/\.(prisma|graphql|proto)$/i.test(base)) s += 4;
  if (/(schema|model|router|routes|service|api|core|config)/i.test(rel)) s += 2;
  if (/(^|\/)(src|app|lib|cmd|server|backend|api)\//i.test(rel)) s += 2;
  if (/\.(md|mdx)$/i.test(base)) s += 2;
  if (/(\.(test|spec)\.|(^|\/)(tests?|__tests__|e2e|fixtures?|mocks?)\/)/i.test(rel)) s -= 5;
  s -= (rel.split("/").length - 1) * 0.4; // prefer shallower files
  return s;
}

function gatherProjectText(dir: string, depth: ScanDepth = "standard"): { name: string; text: string } | null {
  const parts: string[] = [];
  // README
  for (const r of READMES) { const p = join(dir, r); if (existsSync(p)) { try { parts.push(`# ${r}\n` + readFileSync(p, "utf8").slice(0, 6000)); break; } catch {} } }
  // manifests
  for (const m of MANIFESTS) { const p = join(dir, m); if (existsSync(p)) { try { parts.push(`# ${m}\n` + readFileSync(p, "utf8").slice(0, 2500)); } catch {} } }

  if (depth !== "quick") {
    // walk once: language mix + a candidate file list (paths)
    const exts: Record<string, number> = {};
    const names: string[] = [];
    const candidates: string[] = [];
    const walk = (d: string, dd: number) => {
      if (dd > 4) return;
      let es: any[];
      try { es = readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of es) {
        if (e.name.startsWith(".") && dd === 0) continue;
        if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) walk(join(d, e.name), dd + 1); }
        else {
          const full = join(d, e.name); const ext = extname(e.name).toLowerCase();
          if (ext) exts[ext] = (exts[ext] || 0) + 1;
          if (names.length < 80) names.push(relative(dir, full));
          if (CODE_EXT.test(e.name) || DOC_EXT.test(e.name)) candidates.push(full);
        }
      }
    };
    walk(dir, 0);
    const langs = Object.entries(exts).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k}:${v}`).join(" ");
    if (langs) parts.push(`# files\nlanguages: ${langs}\nsample: ${names.slice(0, 50).join(", ")}`);

    // deep: read the most revealing source files so the LLM can infer the actual purpose
    if (depth === "deep") {
      const ranked = candidates
        .map((f) => ({ f, score: fileScore(relative(dir, f)) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 22);
      let budget = 48000;
      for (const { f } of ranked) {
        if (budget <= 800) break;
        try {
          const c = readFileSync(f, "utf8");
          if (c.indexOf(String.fromCharCode(0)) !== -1) continue; // skip binary
          const slice = c.slice(0, Math.min(3000, budget));
          parts.push(`# ${relative(dir, f)}\n${slice}`);
          budget -= slice.length;
        } catch {}
      }
    }
  }

  const text = parts.join("\n\n").trim();
  if (text.length < 40) return null;
  return { name: basename(dir), text };
}

// Enumerate candidate projects: the path itself (if it looks like a project) + its
// immediate subdirectories. Bounded so a big folder can't run forever.
function candidateProjects(root: string, max = 12): string[] {
  const out: string[] = [];
  const looksLikeProject = (d: string) => MANIFESTS.some((m) => existsSync(join(d, m))) || READMES.some((r) => existsSync(join(d, r)));
  if (looksLikeProject(root)) out.push(root);
  let entries: any[] = [];
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (out.length >= max) break;
    if (e.isDirectory() && !SKIP_DIR.has(e.name) && !e.name.startsWith(".")) {
      const d = join(root, e.name);
      if (looksLikeProject(d)) out.push(d);
    }
  }
  return out.slice(0, max);
}

// upsert a scanned project item keyed by (source_path, title) so re-scans REFRESH the
// item (summary/tags) instead of duplicating; returns whether it's newly discovered.
function upsertScanItem(o: { title: string; summary: string; tags: string[]; sourcePath: string }): { id: number; isNew: boolean } {
  const db = getDb();
  const ex = db.prepare("SELECT id FROM kb_items WHERE source='scan' AND source_path=? AND title=?").get(o.sourcePath, o.title) as any;
  if (ex) {
    db.prepare("UPDATE kb_items SET summary=?, tags=?, updated_at=? WHERE id=?").run(o.summary.slice(0, 4000), JSON.stringify(o.tags.slice(0, 30)), NOW(), ex.id);
    return { id: ex.id, isNew: false };
  }
  return { id: insertItem({ kind: "project", title: o.title, summary: o.summary, tags: o.tags, source: "scan", source_path: o.sourcePath }), isNew: true };
}

// ---------- sources: persistent, re-scannable folders ----------
export interface KbSource { id: number; path: string; label: string | null; kind: string; note: string | null; interval_hours: number; depth: string; link_item_id: number | null; last_scanned_at: string | null; created_at: string }
const expandPath = (p: string) => p.trim().replace(/^~(?=\/)/, process.env.HOME || "~");

export function listSources(): KbSource[] {
  return getDb().prepare("SELECT * FROM kb_sources ORDER BY created_at DESC").all() as any[];
}

// Register a folder and run its first scan. kind: 'project' (whole folder = one project)
// or 'company' (each sub-project scanned separately). note = free-text context.
export function addSource(o: { path: string; label?: string; kind?: string; note?: string; intervalHours?: number; depth?: string; linkItemId?: number }): { id: number; error?: string } {
  const path = expandPath(o.path || "");
  if (!path || !existsSync(path)) return { id: 0, error: "Folder not found on this machine." };
  try { if (!statSync(path).isDirectory()) return { id: 0, error: "That path is not a folder." }; } catch { return { id: 0, error: "Cannot read that path." }; }
  const kind = o.kind === "company" ? "company" : "project";
  const depth = ["quick", "standard", "deep"].includes(String(o.depth)) ? String(o.depth) : "standard";
  const link = o.linkItemId && Number.isFinite(o.linkItemId) ? Math.floor(o.linkItemId) : null;
  const id = Number(getDb().prepare(
    "INSERT INTO kb_sources (path,label,kind,note,interval_hours,depth,link_item_id,created_at) VALUES (?,?,?,?,?,?,?,?)"
  ).run(path, o.label?.trim() || null, kind, o.note?.trim() || null, Math.max(0, Math.floor(o.intervalHours || 0)), depth, link, NOW()).lastInsertRowid);
  startSourceScan(id);
  return { id };
}

// KB items a folder can be linked to (so a scan enriches an existing project).
export function linkableItems(): { id: number; title: string; kind: string }[] {
  return getDb().prepare("SELECT id, title, kind FROM kb_items ORDER BY updated_at DESC").all() as any[];
}

// Merge a fresh analysis into an EXISTING item (union tags, richer summary, new bullets/
// questions) instead of creating a new one — used when a source is linked to an item.
function mergeIntoItem(itemId: number, a: Analysis, sourcePath: string): boolean {
  const db = getDb();
  const item = db.prepare("SELECT * FROM kb_items WHERE id=?").get(itemId) as any;
  if (!item) return false;
  const tags = Array.from(new Set([...safeTags(item.tags), ...a.tags]));
  const summary = a.summary && a.summary.length > (item.summary || "").length ? a.summary : (item.summary || a.summary);
  db.prepare("UPDATE kb_items SET summary=?, tags=?, source_path=?, source=?, updated_at=? WHERE id=?")
    .run((summary || "").slice(0, 4000), JSON.stringify(tags.slice(0, 30)), sourcePath, item.source === "scan" ? "scan" : "manual+scan", NOW(), itemId);
  const haveBullets = new Set((db.prepare("SELECT bullet FROM kb_suggestions WHERE item_id=?").all(itemId) as any[]).map((r) => r.bullet));
  addSuggestions(itemId, a.bullets.filter((b) => !haveBullets.has(b)).map((b) => ({ section: "project", bullet: b })));
  const haveQs = new Set((db.prepare("SELECT question FROM kb_questions WHERE item_id=?").all(itemId) as any[]).map((r) => r.question));
  addQuestions(itemId, a.questions.filter((q) => !haveQs.has(q)));
  return true;
}
export function setSourceDepth(id: number, depth: string): void {
  const d = ["quick", "standard", "deep"].includes(String(depth)) ? String(depth) : "standard";
  getDb().prepare("UPDATE kb_sources SET depth=? WHERE id=?").run(d, id);
}
export function setSourceInterval(id: number, hours: number): void { getDb().prepare("UPDATE kb_sources SET interval_hours=? WHERE id=?").run(Math.max(0, Math.floor(hours || 0)), id); }
export function removeSource(id: number): void { getDb().prepare("DELETE FROM kb_sources WHERE id=?").run(id); }
export function rescanSource(id: number): void { startSourceScan(id); }

function startSourceScan(sourceId: number): number {
  const src = getDb().prepare("SELECT * FROM kb_sources WHERE id=?").get(sourceId) as KbSource | undefined;
  if (!src) return 0;
  // record as a crawl run so it streams in the Crawl Shell; note holds the path
  const runId = createCrawlRun("scan", "kb");
  updateCrawlRun(runId, { note: src.label ? `${src.label} · ${src.path}` : src.path });
  void runSourceScan(runId, src).catch((e: any) => {
    try { crawlLog(runId, "error", String(e?.message || e).slice(0, 300)); updateCrawlRun(runId, { status: "error", ended_at: NOW() }); } catch {}
  });
  return runId;
}

async function runSourceScan(runId: number, src: KbSource): Promise<void> {
  const db = getDb();
  const L = (kind: string, text: string) => crawlLog(runId, kind, text);
  const depth = (["quick", "standard", "deep"].includes(String(src.depth)) ? src.depth : "standard") as ScanDepth;
  L("note", `Folder scan started · ${src.kind === "company" ? "company folder" : "single project"} · ${depth} depth · ${src.path}`);
  if (depth === "deep") L("reasoning", "Deep scan: reading source files to determine the project's actual purpose.");
  if (src.note) L("reasoning", `Context you gave: ${src.note}`);

  const dirs = src.kind === "company" ? candidateProjects(src.path) : [src.path];
  if (!dirs.length) {
    L("error", "No projects with a README or manifest found here.");
    updateCrawlRun(runId, { status: "done", ended_at: NOW(), note: src.path });
    db.prepare("UPDATE kb_sources SET last_scanned_at=? WHERE id=?").run(NOW(), src.id);
    return;
  }
  L("result", `Found ${dirs.length} project folder(s) to read.`);
  const noteCtx = [src.note, src.kind === "company" && src.label ? `This is part of ${src.label}.` : ""].filter(Boolean).join(" ");

  const linkId = src.kind !== "company" && src.link_item_id ? Number(src.link_item_id) : null;
  let found = 0, added = 0, updated = 0;
  for (const dir of dirs) {
    const g = gatherProjectText(dir, depth);
    if (!g) { L("step", `skipped ${basename(dir)} — no readable README/manifest/source`); continue; }
    L("step", `reading ${g.name} (${g.text.length} chars, ${depth}) → analyzing…`);
    try {
      const a = await analyze("project", g.name, g.text, noteCtx || undefined, depth === "deep");
      const tags = [...a.tags]; if (src.kind === "company" && src.label) tags.push(src.label);
      if (linkId) {
        // link mode: enrich the existing KB item instead of creating a new one
        const ok = mergeIntoItem(linkId, a, dir);
        if (ok) { updated++; found++; L("result", `🔗 linked & enriched existing item #${linkId} · ${tags.length} skill(s)`); }
        else L("error", `linked item #${linkId} no longer exists — skipped`);
      } else {
        const { id, isNew } = upsertScanItem({ title: a.title || g.name, summary: a.summary, tags, sourcePath: dir });
        if (isNew) { addSuggestions(id, a.bullets.map((b) => ({ section: "project", bullet: b }))); addQuestions(id, a.questions); added++; }
        else updated++;
        found++;
        L("result", `${isNew ? "✓ added" : "↻ updated"} "${a.title || g.name}" · ${tags.length} skill(s)${isNew ? ` · ${a.bullets.length} bullet(s), ${a.questions.length} question(s)` : ""}`);
      }
      updateCrawlRun(runId, { received: dirs.length, scraped: found, inserted: added, updated });
    } catch (e: any) {
      L("error", `couldn't analyze ${g.name}: ${String(e?.message || e).slice(0, 80)}`);
    }
  }
  L("note", `Scan complete — ${found} project(s): ${added} new, ${updated} refreshed.`);
  updateCrawlRun(runId, { status: "done", ended_at: NOW(), received: dirs.length, scraped: found, inserted: added, updated });
  db.prepare("UPDATE kb_sources SET last_scanned_at=? WHERE id=?").run(NOW(), src.id);
}

// Scheduler hook: re-scan any source whose interval has elapsed.
export function runDueSources(): void {
  const now = Date.now();
  for (const s of getDb().prepare("SELECT * FROM kb_sources WHERE interval_hours>0").all() as KbSource[]) {
    if (activeScan()) break; // don't pile up scans
    const last = s.last_scanned_at ? new Date(s.last_scanned_at).getTime() : 0;
    if (now - last >= s.interval_hours * 3600 * 1000) startSourceScan(s.id);
  }
}
