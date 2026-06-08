// Job + application data layer. Uses the shared connection in sqlite.server.ts.
// Stage/Category/Job + label constants live in the client-safe ./stages module.
import { getDb } from "./sqlite.server";
import { STAGES, type Stage, type Category, type Job } from "./stages";

export { STAGES, QUICK_STAGES, STAGE_LABEL } from "./stages";
export type { Stage, Category, Job } from "./stages";

// --- meta (crawl bookkeeping) ---------------------------------------------

export function getMeta(key: string): string | null {
  const row = getDb().prepare("SELECT value FROM meta WHERE key=?").get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}
export function setMeta(key: string, value: string): void {
  getDb()
    .prepare("INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(key, String(value));
}

// --- ledger ----------------------------------------------------------------

export interface LedgerData {
  groups: Record<Category, Job[]>;
  counts: Record<Category, number>;
  total: number;
  lastCrawl: string | null;
  lastCrawlStatus: string | null;
  newCount: number;
}

const ORDER: Category[] = ["high", "medium", "stretch"];

const SELECT_JOB = `
  SELECT j.*, COALESCE(a.stage,'saved') stage, a.sub_stage, a.applied_at
  FROM jobs j LEFT JOIN applications a ON a.job_id = j.id
`;

const TODAY = () => new Date().toISOString().slice(0, 10);

export function getLedger(): LedgerData {
  const rows = getDb()
    .prepare(
      `${SELECT_JOB} WHERE j.active = 1 AND (j.closes_at IS NULL OR j.closes_at >= ?) ORDER BY j.fit_score DESC, j.company ASC`
    )
    .all(TODAY()) as Job[];

  const prevCrawl = getMeta("prev_crawl");
  const soonCutoff = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
  const groups: Record<Category, Job[]> = { high: [], medium: [], stretch: [] };
  let newCount = 0;
  for (const j of rows) {
    j.is_new = !!(prevCrawl && j.first_seen > prevCrawl);
    j.closing_soon = !!(j.closes_at && j.closes_at <= soonCutoff);
    if (j.is_new) newCount++;
    if (groups[j.category]) groups[j.category].push(j);
  }
  return {
    groups,
    counts: { high: groups.high.length, medium: groups.medium.length, stretch: groups.stretch.length },
    total: rows.length,
    lastCrawl: getMeta("last_crawl"),
    lastCrawlStatus: getMeta("last_crawl_status"),
    newCount,
  };
}

export function getJob(id: string): Job | null {
  const row = getDb().prepare(`${SELECT_JOB} WHERE j.id = ?`).get(id) as Job | undefined;
  return row ?? null;
}

// expired = has a closing date that's already passed (still active in the DB)
export function getExpired(): Job[] {
  return getDb()
    .prepare(`${SELECT_JOB} WHERE j.active = 1 AND j.closes_at IS NOT NULL AND j.closes_at < ? ORDER BY j.closes_at DESC`)
    .all(TODAY()) as Job[];
}

// closing within `days` and not yet expired
export function getClosingSoon(days = 7): Job[] {
  const today = TODAY();
  const cutoff = new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);
  return getDb()
    .prepare(
      `${SELECT_JOB} WHERE j.active = 1 AND j.closes_at IS NOT NULL AND j.closes_at >= ? AND j.closes_at <= ? ORDER BY j.closes_at ASC`
    )
    .all(today, cutoff) as Job[];
}

export function setClosesAt(id: string, closesAt: string | null): void {
  getDb().prepare("UPDATE jobs SET closes_at=?, updated_at=? WHERE id=?").run(closesAt, new Date().toISOString(), id);
}

// Persist the JD. Pass `html` (sanitized rich markup) to also store the rendered
// version shown in the job page; omit it to leave any existing jd_html untouched,
// or pass null to clear it (e.g. a manual plain-text paste).
export function setJd(id: string, jd: string, html?: string | null): void {
  const now = new Date().toISOString();
  if (html === undefined) {
    getDb().prepare("UPDATE jobs SET jd=?, updated_at=? WHERE id=?").run(jd.slice(0, 16000), now, id);
  } else {
    getDb()
      .prepare("UPDATE jobs SET jd=?, jd_html=?, updated_at=? WHERE id=?")
      .run(jd.slice(0, 16000), html ? html.slice(0, 120000) : null, now, id);
  }
}

export function updateNotes(id: string, notes: string): boolean {
  const info = getDb()
    .prepare("UPDATE jobs SET notes=?, updated_at=? WHERE id=?")
    .run(notes.slice(0, 4000), new Date().toISOString(), id);
  return info.changes > 0;
}

// --- applications / pipeline ----------------------------------------------

export function ensureApplication(jobId: string): void {
  const db = getDb();
  const exists = db.prepare("SELECT 1 FROM applications WHERE job_id=?").get(jobId);
  if (!exists) {
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO applications (job_id,stage,updated_at) VALUES (?, 'saved', ?)"
    ).run(jobId, now);
    addEvent(jobId, "created", { stage: "saved" });
  }
}

export function setStage(
  jobId: string,
  stage: Stage,
  opts: { subStage?: string | null; note?: string } = {}
): boolean {
  if (!STAGES.includes(stage)) return false;
  const db = getDb();
  ensureApplication(jobId);
  const now = new Date().toISOString();
  const prev = db.prepare("SELECT stage, applied_at FROM applications WHERE job_id=?").get(jobId) as
    | { stage: Stage; applied_at: string | null }
    | undefined;
  const appliedAt =
    stage === "applied" && !prev?.applied_at ? now : prev?.applied_at ?? null;
  db.prepare(
    "UPDATE applications SET stage=?, sub_stage=?, applied_at=?, updated_at=? WHERE job_id=?"
  ).run(stage, opts.subStage ?? null, appliedAt, now, jobId);
  if (prev?.stage !== stage)
    addEvent(jobId, "stage_change", { from: prev?.stage ?? null, to: stage, subStage: opts.subStage });
  if (opts.note) addEvent(jobId, "note", { text: opts.note });
  return true;
}

export function setNextAction(jobId: string, action: string, at: string | null): void {
  ensureApplication(jobId);
  getDb()
    .prepare("UPDATE applications SET next_action=?, next_action_at=?, updated_at=? WHERE job_id=?")
    .run(action || null, at || null, new Date().toISOString(), jobId);
}

export interface AppEvent {
  id: number;
  job_id: string;
  ts: string;
  type: string;
  payload: any;
}

export function addEvent(jobId: string, type: string, payload?: any): void {
  getDb()
    .prepare("INSERT INTO application_events (job_id,ts,type,payload_json) VALUES (?,?,?,?)")
    .run(jobId, new Date().toISOString(), type, payload ? JSON.stringify(payload) : null);
}

export function getEvents(jobId: string): AppEvent[] {
  const rows = getDb()
    .prepare("SELECT * FROM application_events WHERE job_id=? ORDER BY id DESC")
    .all(jobId) as any[];
  return rows.map((r) => ({ ...r, payload: r.payload_json ? JSON.parse(r.payload_json) : null }));
}

// kanban: jobs grouped by stage (active jobs that are in the pipeline OR all)
export function getBoard(): Record<Stage, Job[]> {
  const rows = getDb()
    .prepare(`${SELECT_JOB} WHERE j.active = 1 AND (j.closes_at IS NULL OR j.closes_at >= ?)`)
    .all(TODAY()) as Job[];
  const board = Object.fromEntries(STAGES.map((s) => [s, [] as Job[]])) as Record<Stage, Job[]>;
  for (const j of rows) board[j.stage]?.push(j);
  for (const s of STAGES) board[s].sort((a, b) => b.fit_score - a.fit_score);
  return board;
}

// --- analytics -------------------------------------------------------------

export interface Funnel {
  counts: Record<Stage, number>;
  applied: number;
  screening: number;
  interview: number;
  offer: number;
  rejected: number;
  appliedToInterview: number; // %
  interviewToOffer: number; // %
}

export function funnel(): Funnel {
  const rows = getDb()
    .prepare("SELECT stage, COUNT(*) n FROM applications GROUP BY stage")
    .all() as { stage: Stage; n: number }[];
  const counts = Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<Stage, number>;
  for (const r of rows) counts[r.stage] = r.n;
  // cumulative reached-at-least counts
  const everApplied = counts.applied + counts.screening + counts.interview + counts.offer;
  const everInterview = counts.interview + counts.offer;
  return {
    counts,
    applied: everApplied,
    screening: counts.screening,
    interview: everInterview,
    offer: counts.offer,
    rejected: counts.rejected,
    appliedToInterview: everApplied ? Math.round((everInterview / everApplied) * 100) : 0,
    interviewToOffer: everInterview ? Math.round((counts.offer / everInterview) * 100) : 0,
  };
}

export interface SourceStat { source: string; total: number; applied: number; interview: number }
export function sourceStats(): SourceStat[] {
  return getDb()
    .prepare(
      `SELECT COALESCE(j.source,'—') source, COUNT(*) total,
        SUM(CASE WHEN a.stage IN ('applied','screening','interview','offer') THEN 1 ELSE 0 END) applied,
        SUM(CASE WHEN a.stage IN ('interview','offer') THEN 1 ELSE 0 END) interview
       FROM jobs j LEFT JOIN applications a ON a.job_id=j.id
       WHERE j.active=1 GROUP BY j.source ORDER BY total DESC`
    )
    .all() as SourceStat[];
}

// reminders: applications with a due next action, or applied-with-no-movement
export function reminders(): { job: Job; reason: string; due?: string }[] {
  const db = getDb();
  const out: { job: Job; reason: string; due?: string }[] = [];
  const today = new Date().toISOString().slice(0, 10);
  const dueRows = db
    .prepare(
      `${SELECT_JOB} JOIN applications a2 ON a2.job_id=j.id WHERE a2.next_action_at IS NOT NULL AND a2.next_action_at <= ?`
    )
    .all(today + "T23:59:59Z") as Job[];
  for (const j of dueRows) out.push({ job: j, reason: "Action due", due: (j as any).next_action_at });

  // applied > 7 days ago, still in 'applied'
  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString();
  const stale = db
    .prepare(
      `${SELECT_JOB} JOIN applications a3 ON a3.job_id=j.id WHERE a3.stage='applied' AND a3.applied_at < ?`
    )
    .all(weekAgo) as Job[];
  for (const j of stale) out.push({ job: j, reason: "Applied 7+ days ago — follow up" });

  // closing soon and not yet applied
  const soon = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
  const closing = db
    .prepare(
      `${SELECT_JOB} WHERE j.active=1 AND j.closes_at IS NOT NULL AND j.closes_at <= ? AND COALESCE(stage,'saved') IN ('saved')`
    )
    .all(soon) as Job[];
  for (const j of closing) out.push({ job: j, reason: "Closing soon — not applied", due: j.closes_at! });
  return out;
}

// --- crawl upsert (TS, used by in-process scheduler / run-crawl) -----------

const VALID_CATEGORY = new Set(["high", "medium", "stretch"]);
function slugify(s: string) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
export function jobId(company: string, role: string) {
  return `${slugify(company)}--${slugify(role)}`;
}

export function upsertJobs(
  jobs: any[],
  now = new Date().toISOString()
): { inserted: number; updated: number; errors: { job: string; error: string }[] } {
  const db = getDb();
  const existing = db.prepare("SELECT id FROM jobs WHERE id=?");
  const insert = db.prepare(`
    INSERT INTO jobs (id,company,role,category,fit_score,stack,eligibility,seniority,apply_url,source,closes_at,active,first_seen,last_seen,updated_at)
    VALUES (@id,@company,@role,@category,@fit_score,@stack,@eligibility,@seniority,@apply_url,@source,@closes_at,1,@now,@now,@now)`);
  const update = db.prepare(`
    UPDATE jobs SET company=@company, role=@role, category=@category, fit_score=@fit_score, stack=@stack,
      eligibility=@eligibility, seniority=@seniority, apply_url=@apply_url, source=@source, closes_at=@closes_at,
      active=1, last_seen=@now, updated_at=@now WHERE id=@id`);
  let inserted = 0,
    updated = 0;
  const errors: { job: string; error: string }[] = [];
  const tx = db.transaction((rows: any[]) => {
    for (const raw of rows) {
      try {
        const company = (raw.company || "").trim();
        const role = (raw.role || "").trim();
        const category = (raw.category || "").trim().toLowerCase();
        const apply_url = (raw.apply_url || raw.url || "").trim();
        if (!company || !role) throw new Error("missing company/role");
        if (!VALID_CATEGORY.has(category)) throw new Error(`bad category "${category}"`);
        if (!/^https?:\/\//.test(apply_url)) throw new Error("apply_url must be http(s)");
        let fit = Number(raw.fit_score);
        if (!Number.isFinite(fit)) fit = 0;
        fit = Math.max(0, Math.min(100, Math.round(fit)));
        const row = {
          id: raw.id || jobId(company, role),
          company,
          role,
          category,
          fit_score: fit,
          stack: (raw.stack || "").trim() || null,
          eligibility: (raw.eligibility || "").trim() || null,
          seniority: (raw.seniority || "").trim() || null,
          apply_url,
          source: (raw.source || "").trim() || null,
          closes_at: (raw.closes_at || "").trim() || null,
          now,
        };
        if (existing.get(row.id)) {
          update.run(row);
          updated++;
        } else {
          insert.run(row);
          inserted++;
        }
      } catch (e: any) {
        errors.push({ job: `${raw.company} / ${raw.role}`, error: e.message });
      }
    }
  });
  tx(jobs);
  return { inserted, updated, errors };
}

export function deactivateMissing(now: string): number {
  return getDb().prepare("UPDATE jobs SET active=0 WHERE last_seen < ? AND active=1").run(now)
    .changes;
}

// --- answer bank (reusable Q->A context) ----------------------------------

export function normQ(q: string): string {
  return q.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 120);
}
export function lookupAnswer(question: string): string | null {
  const row = getDb().prepare("SELECT answer FROM answer_bank WHERE key=?").get(normQ(question)) as
    | { answer: string }
    | undefined;
  return row?.answer ?? null;
}
export function saveAnswer(question: string, answer: string): void {
  getDb()
    .prepare(
      "INSERT INTO answer_bank (key,question,answer,updated_at) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET answer=excluded.answer, question=excluded.question, updated_at=excluded.updated_at"
    )
    .run(normQ(question), question, answer, new Date().toISOString());
}
export function answerBank(): { question: string; answer: string; updated_at: string }[] {
  return getDb().prepare("SELECT question,answer,updated_at FROM answer_bank ORDER BY updated_at DESC").all() as any[];
}

// --- apply sessions --------------------------------------------------------

export interface ApplySession {
  id: number;
  started_at: string;
  ended_at: string | null;
  status: string;
  mode: string;
  rules_json: string | null;
  total: number;
  processed: number;
  needs_input: number;
  note: string | null;
}

export function createSession(mode: string, rules: any): number {
  const info = getDb()
    .prepare("INSERT INTO apply_sessions (started_at,status,mode,rules_json) VALUES (?,?,?,?)")
    .run(new Date().toISOString(), "running", mode, JSON.stringify(rules));
  return Number(info.lastInsertRowid);
}
export function updateSession(id: number, patch: Partial<ApplySession>): void {
  const fields = Object.keys(patch);
  if (!fields.length) return;
  const set = fields.map((f) => `${f}=@${f}`).join(", ");
  getDb().prepare(`UPDATE apply_sessions SET ${set} WHERE id=@id`).run({ ...patch, id });
}
export function getSession(id: number): ApplySession | null {
  return (getDb().prepare("SELECT * FROM apply_sessions WHERE id=?").get(id) as ApplySession) || null;
}
export function listSessions(limit = 20): ApplySession[] {
  return getDb().prepare("SELECT * FROM apply_sessions ORDER BY id DESC LIMIT ?").all(limit) as ApplySession[];
}

export function addSessionJob(sessionId: number, jobId: string): number {
  const info = getDb()
    .prepare("INSERT INTO apply_session_jobs (session_id,job_id,status,started_at) VALUES (?,?,?,?)")
    .run(sessionId, jobId, "applying", new Date().toISOString());
  return Number(info.lastInsertRowid);
}
export function updateSessionJob(id: number, patch: any): void {
  const fields = Object.keys(patch);
  if (!fields.length) return;
  const set = fields.map((f) => `${f}=@${f}`).join(", ");
  getDb().prepare(`UPDATE apply_session_jobs SET ${set} WHERE id=@id`).run({ ...patch, id });
}
export function sessionJobs(sessionId: number): any[] {
  return getDb()
    .prepare(
      "SELECT sj.*, j.company, j.role FROM apply_session_jobs sj LEFT JOIN jobs j ON j.id=sj.job_id WHERE sj.session_id=? ORDER BY sj.id"
    )
    .all(sessionId);
}

export function addLog(sessionId: number, kind: string, opts: { jobId?: string; text?: string; shot?: string } = {}): void {
  getDb()
    .prepare("INSERT INTO apply_logs (session_id,job_id,ts,kind,text,shot_path) VALUES (?,?,?,?,?,?)")
    .run(sessionId, opts.jobId ?? null, new Date().toISOString(), kind, opts.text ?? null, opts.shot ?? null);
}
export function sessionLogs(sessionId: number): any[] {
  return getDb().prepare("SELECT * FROM apply_logs WHERE session_id=? ORDER BY id").all(sessionId);
}
export function getLog(id: number): any {
  return getDb().prepare("SELECT * FROM apply_logs WHERE id=?").get(id);
}

// --- question pool ---------------------------------------------------------

export function addQuestion(q: { sessionId?: number; jobId?: string; question: string }): void {
  // de-dupe open questions with the same normalized text
  const dup = getDb()
    .prepare("SELECT 1 FROM apply_questions WHERE answer IS NULL AND lower(question)=lower(?)")
    .get(q.question);
  if (dup) return;
  getDb()
    .prepare("INSERT INTO apply_questions (session_id,job_id,question,created_at) VALUES (?,?,?,?)")
    .run(q.sessionId ?? null, q.jobId ?? null, q.question, new Date().toISOString());
}
export function openQuestions(): any[] {
  return getDb()
    .prepare(
      "SELECT q.*, j.company, j.role FROM apply_questions q LEFT JOIN jobs j ON j.id=q.job_id WHERE q.answer IS NULL ORDER BY q.id DESC"
    )
    .all();
}
export function answeredQuestions(limit = 50): any[] {
  return getDb()
    .prepare("SELECT * FROM apply_questions WHERE answer IS NOT NULL ORDER BY answered_at DESC LIMIT ?")
    .all(limit);
}
export function answerPooledQuestion(id: number, answer: string): void {
  const row = getDb().prepare("SELECT question FROM apply_questions WHERE id=?").get(id) as { question: string } | undefined;
  if (!row) return;
  getDb().prepare("UPDATE apply_questions SET answer=?, answered_at=? WHERE id=?").run(answer, new Date().toISOString(), id);
  saveAnswer(row.question, answer); // remember for next time
  // also resolve any other open copies of the same question
  getDb()
    .prepare("UPDATE apply_questions SET answer=?, answered_at=? WHERE answer IS NULL AND lower(question)=lower(?)")
    .run(answer, new Date().toISOString(), row.question);
}

// --- crawl runs + logs (Crawl Shell) --------------------------------------

export interface CrawlRun {
  id: number; type: string; started_at: string; ended_at: string | null; status: string;
  received: number; inserted: number; updated: number; scraped: number; errors: number;
  trigger: string | null; note: string | null;
}

export function createCrawlRun(type: string, trigger = "manual"): number {
  const info = getDb()
    .prepare("INSERT INTO crawl_runs (type,started_at,status,trigger) VALUES (?,?,?,?)")
    .run(type, new Date().toISOString(), "running", trigger);
  return Number(info.lastInsertRowid);
}
export function updateCrawlRun(id: number, patch: Partial<CrawlRun>): void {
  const f = Object.keys(patch);
  if (!f.length) return;
  getDb().prepare(`UPDATE crawl_runs SET ${f.map((k) => `${k}=@${k}`).join(", ")} WHERE id=@id`).run({ ...patch, id });
}
export function crawlLog(runId: number, kind: string, text: string): void {
  getDb().prepare("INSERT INTO crawl_logs (run_id,ts,kind,text) VALUES (?,?,?,?)").run(runId, new Date().toISOString(), kind, text);
}
export function getCrawlRun(id: number): CrawlRun | null {
  return (getDb().prepare("SELECT * FROM crawl_runs WHERE id=?").get(id) as CrawlRun) || null;
}
export function listCrawlRuns(limit = 25): CrawlRun[] {
  return getDb().prepare("SELECT * FROM crawl_runs ORDER BY id DESC LIMIT ?").all(limit) as CrawlRun[];
}
export function activeCrawl(): CrawlRun | null {
  return (getDb().prepare("SELECT * FROM crawl_runs WHERE status='running' ORDER BY id DESC LIMIT 1").get() as CrawlRun) || null;
}
export function crawlLogs(runId: number): { id: number; ts: string; kind: string; text: string }[] {
  return getDb().prepare("SELECT id,ts,kind,text FROM crawl_logs WHERE run_id=? ORDER BY id").all(runId) as any[];
}

// Everything the auto-apply sessions have done for ONE job — so the job page can show
// which sessions touched it, the drafted answers, and any pooled questions.
export function jobApplyActivity(jobId: string): {
  sessions: any[];
  answers: { session_id: number; ts: string; text: string }[];
  pooled: { id: number; question: string; answer: string | null }[];
} {
  const db = getDb();
  return {
    sessions: db
      .prepare(
        "SELECT sj.session_id, sj.status, sj.questions, sj.unanswered, s.mode, s.status AS session_status, sj.ended_at FROM apply_session_jobs sj JOIN apply_sessions s ON s.id=sj.session_id WHERE sj.job_id=? ORDER BY sj.id DESC"
      )
      .all(jobId) as any[],
    answers: db
      .prepare("SELECT session_id, ts, text FROM apply_logs WHERE job_id=? AND kind='answer' ORDER BY id DESC LIMIT 40")
      .all(jobId) as any[],
    pooled: db
      .prepare("SELECT id, question, answer FROM apply_questions WHERE job_id=? ORDER BY id DESC")
      .all(jobId) as any[],
  };
}
