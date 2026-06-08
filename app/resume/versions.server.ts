// CRUD for tailored resumes / cover letters per job (resume_versions).
import { getDb } from "../sqlite.server";
import type { Resume, MatchAnalysis, TailorFlag } from "./types";

export interface ResumeVersion {
  id: number;
  job_id: string;
  profile_id: string | null;
  kind: "resume" | "cover-letter";
  style: string;
  data: Resume | null;
  content_md: string | null;
  flags: TailorFlag[] | null;
  match: MatchAnalysis | null;
  llm_call_id: number | null;
  pdf_path: string | null;
  created_at: string;
}

function rowTo(row: any): ResumeVersion {
  return {
    ...row,
    data: row.data_json ? JSON.parse(row.data_json) : null,
    flags: row.flags_json ? JSON.parse(row.flags_json) : null,
    match: row.match_json ? JSON.parse(row.match_json) : null,
  };
}

export function createVersion(v: {
  jobId: string;
  profileId?: string | null;
  kind: "resume" | "cover-letter";
  style?: string;
  data?: Resume | null;
  content_md?: string | null;
  flags?: TailorFlag[] | null;
  match?: MatchAnalysis | null;
  llmCallId?: number | null;
  pdfPath?: string | null;
}): number {
  const info = getDb()
    .prepare(
      `INSERT INTO resume_versions (job_id,profile_id,kind,style,data_json,content_md,flags_json,match_json,llm_call_id,pdf_path,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      v.jobId,
      v.profileId ?? null,
      v.kind,
      v.style ?? "letterpress",
      v.data ? JSON.stringify(v.data) : null,
      v.content_md ?? null,
      v.flags ? JSON.stringify(v.flags) : null,
      v.match ? JSON.stringify(v.match) : null,
      v.llmCallId ?? null,
      v.pdfPath ?? null,
      new Date().toISOString()
    );
  return Number(info.lastInsertRowid);
}

export function setVersionPdf(id: number, pdfPath: string): void {
  getDb().prepare("UPDATE resume_versions SET pdf_path=? WHERE id=?").run(pdfPath, id);
}

export function listVersions(jobId: string): ResumeVersion[] {
  return (getDb().prepare("SELECT * FROM resume_versions WHERE job_id=? ORDER BY id DESC").all(jobId) as any[]).map(rowTo);
}

// All generated versions across every job, newest first, with the job's company/role
// joined on — for the "Generated for jobs" review list on the Résumés page.
export interface VersionRow extends ResumeVersion { company: string | null; role: string | null }
export function listAllVersions(kind?: "resume" | "cover-letter"): VersionRow[] {
  const where = kind ? "WHERE v.kind=?" : "";
  const rows = getDb()
    .prepare(`SELECT v.*, j.company, j.role FROM resume_versions v LEFT JOIN jobs j ON j.id=v.job_id ${where} ORDER BY v.id DESC`)
    .all(...(kind ? [kind] : [])) as any[];
  return rows.map((r) => ({ ...rowTo(r), company: r.company ?? null, role: r.role ?? null }));
}

export function getVersion(id: number): ResumeVersion | null {
  const row = getDb().prepare("SELECT * FROM resume_versions WHERE id=?").get(id) as any;
  return row ? rowTo(row) : null;
}

export function latestVersion(jobId: string, kind: "resume" | "cover-letter"): ResumeVersion | null {
  const row = getDb()
    .prepare("SELECT * FROM resume_versions WHERE job_id=? AND kind=? ORDER BY id DESC LIMIT 1")
    .get(jobId, kind) as any;
  return row ? rowTo(row) : null;
}
