// Knowledge base: what the agent knows about you, used to keep building your résumé.
// Two inputs feed it:
//   1) manual notes ("what I'm working on")
//   2) an opt-in folder scan — the local runner READS project files, summarizes each
//      project, drafts factual résumé bullets, and poses clarifying questions.
// Everything lands in a separate KB (kb_items/kb_questions/kb_suggestions). Drafted
// bullets are PROPOSALS — you approve them before they touch a résumé profile.
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { getDb } from "../sqlite.server";
import { runLLM, tryParseJson } from "../llm/runner.server";
import { getDefaultProfile, saveProfile } from "../resume/profiles.server";

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
export function kbScans(limit = 5): KbScan[] {
  return getDb().prepare("SELECT * FROM kb_scans ORDER BY started_at DESC LIMIT ?").all(limit) as any[];
}
export function activeScan(): KbScan | null {
  return (getDb().prepare("SELECT * FROM kb_scans WHERE status='running' ORDER BY started_at DESC LIMIT 1").get() as any) || null;
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
const SYSTEM = "You build a developer's knowledge base for résumé writing. Be strictly factual: only state what the evidence supports. When the contribution or impact is unclear, ASK a question rather than inventing detail. Output ONLY valid JSON.";

async function extractFromText(kind: "note" | "project", title: string, body: string, sourcePath?: string): Promise<number> {
  const prompt = `${kind === "project" ? "Analyze this software project from its files" : "The developer described what they're working on"}:\n\n"""${body.slice(0, 12000)}"""\n\nReturn JSON:\n{\n  "title": "short project/work name",\n  "kind": "project|experience|skill",\n  "summary": "2-3 sentence factual summary of what it is and the developer's role",\n  "tags": ["tech","stack","tools"],\n  "bullets": ["2-4 résumé bullets, action-led, factual, quantify ONLY if the evidence gives numbers"],\n  "questions": ["2-3 specific questions to clarify the developer's contribution, scope, or measurable impact"]\n}`;
  const r = await runLLM({ purpose: "misc", system: SYSTEM, prompt, json: true, maxTokens: 1500, temperature: 0.3 });
  const j = tryParseJson(r.text) || {};
  const itemId = insertItem({
    kind: normalizeKind(j.kind),
    title: (j.title || title).toString(),
    summary: (j.summary || "").toString(),
    tags: Array.isArray(j.tags) ? j.tags.map(String) : [],
    source: kind === "project" ? "scan" : "manual",
    source_path: sourcePath ?? null,
  });
  addSuggestions(itemId, (Array.isArray(j.bullets) ? j.bullets : []).map((b: string) => ({ section: "project", bullet: String(b) })));
  addQuestions(itemId, Array.isArray(j.questions) ? j.questions.map(String) : []);
  return itemId;
}
const normalizeKind = (k?: string) => (["project", "experience", "skill", "fact"].includes(String(k)) ? String(k) : "project");

export async function addManualNote(text: string): Promise<number> {
  return extractFromText("note", "Recent work", text);
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

function gatherProjectText(dir: string): { name: string; text: string } | null {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return null; }
  const parts: string[] = [];
  // README
  for (const r of READMES) { const p = join(dir, r); if (existsSync(p)) { try { parts.push(`# ${r}\n` + readFileSync(p, "utf8").slice(0, 6000)); break; } catch {} } }
  // manifests
  for (const m of MANIFESTS) { const p = join(dir, m); if (existsSync(p)) { try { parts.push(`# ${m}\n` + readFileSync(p, "utf8").slice(0, 2000)); } catch {} } }
  // source file inventory (names + language mix)
  const exts: Record<string, number> = {};
  const names: string[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 2) return;
    let es: any[];
    try { es = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      if (e.name.startsWith(".") && depth === 0) continue;
      if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) walk(join(d, e.name), depth + 1); }
      else { const ext = extname(e.name).toLowerCase(); if (ext) exts[ext] = (exts[ext] || 0) + 1; if (names.length < 60) names.push(e.name); }
    }
  };
  walk(dir, 0);
  const langs = Object.entries(exts).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `${k}:${v}`).join(" ");
  if (langs) parts.push(`# files\nlanguages: ${langs}\nsample: ${names.slice(0, 40).join(", ")}`);
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

export function startScan(path: string): { id: number; error?: string } {
  const clean = path.trim().replace(/^~(?=\/)/, process.env.HOME || "~");
  if (!clean || !existsSync(clean)) return { id: 0, error: "Folder not found on this machine." };
  try { if (!statSync(clean).isDirectory()) return { id: 0, error: "That path is not a folder." }; } catch { return { id: 0, error: "Cannot read that path." }; }
  const id = Number(getDb().prepare("INSERT INTO kb_scans (path,status,started_at) VALUES (?,?,?)").run(clean, "running", NOW()).lastInsertRowid);
  void runScan(id, clean).catch((e: any) => {
    try { getDb().prepare("UPDATE kb_scans SET status='error', note=?, ended_at=? WHERE id=?").run(String(e?.message || e).slice(0, 300), NOW(), id); } catch {}
  });
  return { id };
}

// Scan projects whose text was gathered + filtered in the browser (folder picker)
// and uploaded as JSON. Same extraction as the path scan, but contents arrive from
// the client instead of being read off disk by path.
export interface UploadedProject { name: string; readme?: string; manifests?: { name: string; content: string }[]; files?: string[] }

function bodyFromUpload(p: UploadedProject): string {
  const parts: string[] = [];
  if (p.readme) parts.push("# README\n" + String(p.readme).slice(0, 6000));
  for (const m of (p.manifests || []).slice(0, 6)) parts.push(`# ${m.name}\n` + String(m.content).slice(0, 2000));
  if (p.files?.length) {
    const exts: Record<string, number> = {};
    for (const f of p.files) { const e = (f.match(/\.[a-z0-9]+$/i) || [""])[0].toLowerCase(); if (e) exts[e] = (exts[e] || 0) + 1; }
    const langs = Object.entries(exts).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `${k}:${v}`).join(" ");
    parts.push(`# files\nlanguages: ${langs}\nsample: ${p.files.slice(0, 40).join(", ")}`);
  }
  return parts.join("\n\n").trim();
}

export function startScanFromUpload(label: string, projects: UploadedProject[]): { id: number; error?: string } {
  if (!projects?.length) return { id: 0, error: "No projects with a README or manifest found in that folder." };
  const id = Number(getDb().prepare("INSERT INTO kb_scans (path,status,started_at) VALUES (?,?,?)").run(label || "folder", "running", NOW()).lastInsertRowid);
  void runUploadScan(id, projects.slice(0, 12), label).catch((e: any) => {
    try { getDb().prepare("UPDATE kb_scans SET status='error', note=?, ended_at=? WHERE id=?").run(String(e?.message || e).slice(0, 300), NOW(), id); } catch {}
  });
  return { id };
}

async function runUploadScan(scanId: number, projects: UploadedProject[], label: string): Promise<void> {
  const db = getDb();
  let found = 0;
  for (const p of projects) {
    const body = bodyFromUpload(p);
    if (body.length < 40) continue;
    try {
      await extractFromText("project", p.name || "project", body, label || undefined);
      found++;
      db.prepare("UPDATE kb_scans SET found=? WHERE id=?").run(found, scanId);
    } catch { /* skip a project the runner choked on */ }
  }
  db.prepare("UPDATE kb_scans SET status='done', found=?, ended_at=? WHERE id=?").run(found, NOW(), scanId);
}

async function runScan(scanId: number, root: string): Promise<void> {
  const db = getDb();
  const projects = candidateProjects(root);
  if (!projects.length) {
    db.prepare("UPDATE kb_scans SET status='done', note=?, ended_at=? WHERE id=?").run("No projects (no README/manifest) found here.", NOW(), scanId);
    return;
  }
  let found = 0;
  for (const dir of projects) {
    const g = gatherProjectText(dir);
    if (!g) continue;
    try {
      await extractFromText("project", g.name, g.text, dir);
      found++;
      db.prepare("UPDATE kb_scans SET found=? WHERE id=?").run(found, scanId);
    } catch { /* skip a project the runner choked on */ }
  }
  db.prepare("UPDATE kb_scans SET status='done', found=?, ended_at=? WHERE id=?").run(found, NOW(), scanId);
}
