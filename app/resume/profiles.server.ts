// Base resume profiles: extract text from an uploaded PDF, parse to structured
// JSON with the runner, and CRUD them in resume_profiles.
import { currentProfile } from "../profiles.server";

/** Which search a posting belongs to, so work made for it is filed with it. */
function jobProfile(jobId: string): string {
  const r = getDb().prepare("SELECT profile_id FROM jobs WHERE id=?").get(jobId) as { profile_id?: string } | undefined;
  return r?.profile_id || currentProfile().id;
}
import { getDb } from "../sqlite.server";
import { runLLM } from "../llm/runner.server";
import { RESUME_JSON_SHAPE, emptyResume, type Resume } from "./types";

export interface ResumeProfile {
  id: string;
  name: string;
  is_default: number;
  data: Resume;
  raw_text: string | null;
  source_file: string | null;
  created_at: string;
  updated_at: string;
}

export async function extractPdfText(buffer: Buffer): Promise<string> {
  const mod: any = await import("pdf-parse");
  const PDFParse = mod.PDFParse || mod.default?.PDFParse;
  const parser = new PDFParse({ data: buffer });
  const res = await parser.getText();
  return (res.text || "").trim();
}

export async function parseResumeText(rawText: string): Promise<{ resume: Resume; llmCallId?: number }> {
  const r = await runLLM({
    purpose: "parse-resume",
    json: true,
    temperature: 0.1,
    maxTokens: 4096,
    system:
      "You convert raw resume text into clean structured JSON. Extract ONLY what is present. Do not invent. Keep bullet wording faithful.",
    prompt: `Convert this resume into JSON matching exactly this shape (omit empty optional fields):\n${RESUME_JSON_SHAPE}\n\nRESUME TEXT:\n"""\n${rawText.slice(0, 16000)}\n"""\n\nReturn ONLY the JSON object.`,
  });
  const data = (r.json as Resume) || emptyResume();
  // normalize
  data.skills = data.skills || [];
  data.experience = data.experience || [];
  data.projects = data.projects || [];
  data.education = data.education || [];
  if (!data.contact) data.contact = { name: "" };
  return { resume: data };
}

function rowToProfile(row: any): ResumeProfile {
  return { ...row, data: JSON.parse(row.data_json) };
}

export function listProfiles(profileId?: string): ResumeProfile[] {
  const scope = profileId ?? currentProfile().id;
  return (
    getDb()
      .prepare("SELECT * FROM resume_profiles WHERE profile_id=? ORDER BY is_default DESC, updated_at DESC")
      .all(scope) as any[]
  ).map(
    rowToProfile
  );
}

export function getProfile(id: string): ResumeProfile | null {
  const row = getDb().prepare("SELECT * FROM resume_profiles WHERE id=?").get(id) as any;
  return row ? rowToProfile(row) : null;
}

export function getDefaultProfile(profileId?: string): ResumeProfile | null {
  const scope = profileId ?? currentProfile().id;
  const row =
    (getDb().prepare("SELECT * FROM resume_profiles WHERE is_default=1 AND profile_id=?").get(scope) as any) ||
    (getDb().prepare("SELECT * FROM resume_profiles WHERE profile_id=? ORDER BY updated_at DESC LIMIT 1").get(scope) as any) ||
    // A profile with no résumé of its own falls back to the default one rather than to
    // nothing: a new search should be able to tailor on day one, before you have made
    // it a résumé of its own.
    (getDb().prepare("SELECT * FROM resume_profiles WHERE is_default=1").get() as any);
  return row ? rowToProfile(row) : null;
}

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "profile";
}

export function saveProfile(opts: {
  id?: string;
  name: string;
  data: Resume;
  raw_text?: string;
  source_file?: string;
  makeDefault?: boolean;
  /** set when the guided flow assembles a profile for one posting */
  builtForJobId?: string | null;
}): string {
  const db = getDb();
  const now = new Date().toISOString();
  const id = opts.id || `${slug(opts.name)}-${Date.now().toString(36)}`;
  const exists = db.prepare("SELECT 1 FROM resume_profiles WHERE id=?").get(id);
  if (exists) {
    db.prepare(
      "UPDATE resume_profiles SET name=?, data_json=?, raw_text=COALESCE(?,raw_text), source_file=COALESCE(?,source_file), built_for_job_id=COALESCE(?,built_for_job_id), updated_at=? WHERE id=?"
    ).run(opts.name, JSON.stringify(opts.data), opts.raw_text ?? null, opts.source_file ?? null, opts.builtForJobId ?? null, now, id);
  } else {
    const count = (db.prepare("SELECT COUNT(*) n FROM resume_profiles").get() as any).n;
    db.prepare(
      "INSERT INTO resume_profiles (id,name,is_default,data_json,raw_text,source_file,built_for_job_id,created_at,updated_at,profile_id) VALUES (?,?,?,?,?,?,?,?,?,?)"
    ).run(
      id,
      opts.name,
      count === 0 || opts.makeDefault ? 1 : 0,
      JSON.stringify(opts.data),
      opts.raw_text ?? null,
      opts.source_file ?? null,
      opts.builtForJobId ?? null,
      now,
      now,
      // a résumé built for a posting belongs to that posting's search, not to whichever
      // profile happened to be selected when the guided flow ran
      opts.builtForJobId ? jobProfile(opts.builtForJobId) : currentProfile().id
    );
  }
  if (opts.makeDefault) setDefaultProfile(id);
  return id;
}

export function setDefaultProfile(id: string): void {
  const db = getDb();
  db.prepare("UPDATE resume_profiles SET is_default=0").run();
  db.prepare("UPDATE resume_profiles SET is_default=1 WHERE id=?").run(id);
}

export function deleteProfile(id: string): void {
  getDb().prepare("DELETE FROM resume_profiles WHERE id=?").run(id);
}
