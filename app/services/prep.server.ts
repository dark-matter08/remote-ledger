// Interview prep, one session per round.
//
// An application is several conversations — a screening call, a technical round, a
// final — and each wants its own preparation. Before this there was one prep per job,
// and preparing for the second round overwrote the first.
//
// A session holds what you knew going in and what was prepared from it. The knowing
// is the interesting part: the invite, the recruiter's message, the brief, usually as
// a screenshot. Those are shown to the model, and the prep opens with what it read
// from them so you can check it against the original. When the model could not look
// — a local text model, a CLI with no way to pass a picture — the session says so
// rather than presenting a prep "from your screenshot" that was written blind.
//
// Answers, not only questions. The old prep listed eight questions and stopped. Each
// one here gets an answer built from the knowledge base, citing the entry it came
// from, and where the base has nothing the prep says that instead of inventing.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DB_PATH, getDb } from "../sqlite.server";
import { addEvent, answerBank, getJob, getMeta } from "../db.server";
import { rankKbForJob } from "../resume/build.server";
import { getDefaultProfile, getProfile as getResumeProfile } from "../resume/profiles.server";
import { interviewPrep, type PrepEvidence } from "../resume/ai.server";
import { runnerForImages } from "../llm/runner.server";
import type { ImageInput } from "../llm/types";

// Beside the database rather than under cwd, so wherever the data lives the pictures
// live with it — and a test pointed at a scratch DB does not write into the real data/.
export const PREP_DIR = resolve(dirname(DB_PATH), "prep");

/** The kinds of round. Free text would do, but a kind lets the prompt know the shape. */
export const STAGES = [
  { id: "screening", label: "Screening call" },
  { id: "recruiter", label: "Recruiter conversation" },
  { id: "technical", label: "Technical interview" },
  { id: "coding", label: "Live coding" },
  { id: "system-design", label: "System design" },
  { id: "take-home", label: "Take-home assignment" },
  { id: "behavioural", label: "Behavioural" },
  { id: "hiring-manager", label: "Hiring manager" },
  { id: "final", label: "Final round" },
  { id: "other", label: "Other" },
] as const;
export type StageId = (typeof STAGES)[number]["id"];

export const stageLabel = (id: string): string => STAGES.find((s) => s.id === id)?.label ?? "Other";

/** What the model APIs will take, and the size the strictest of them allows. */
export const IMAGE_MIMES: Record<string, ImageInput["mime"]> = {
  "image/png": "image/png",
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
  "image/webp": "image/webp",
  "image/gif": "image/gif",
};
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // Anthropic's per-image limit, the lowest of the lot
// Ten, not six: a colleague's account of a round arrives as a run of WhatsApp
// screenshots, and seven of them met the old cap on the first real use. Every provider
// takes far more than this in one request; the cap is about the token bill, not the API.
export const MAX_IMAGES = 10;

export interface PrepImage {
  /** position in the session; also the file's name on disk, so a path is never user-supplied */
  n: number;
  name: string;
  mime: ImageInput["mime"];
  bytes: number;
}

export interface PrepSession {
  id: number;
  job_id: string;
  stage: string;
  title: string;
  notes: string;
  images: PrepImage[];
  prep_md: string | null;
  vision: number;
  runner: string | null;
  model: string | null;
  llm_call_id: number | null;
  created_at: string;
  updated_at: string;
  /** what the call cost, from the ledger — null for a session generated before this existed */
  cost_usd: number | null;
}

function rowToSession(r: any): PrepSession {
  let images: PrepImage[] = [];
  try {
    const v = JSON.parse(String(r.images || "[]"));
    if (Array.isArray(v)) images = v;
  } catch {}
  return { ...r, images, cost_usd: r.cost_usd ?? null };
}

const SELECT =
  "SELECT s.*, c.cost_usd FROM prep_sessions s LEFT JOIN llm_calls c ON c.id = s.llm_call_id";

export function listSessions(jobId: string): PrepSession[] {
  return (getDb().prepare(`${SELECT} WHERE s.job_id=? ORDER BY s.created_at DESC, s.id DESC`).all(jobId) as any[]).map(rowToSession);
}

export function getSession(id: number): PrepSession | null {
  const r = getDb().prepare(`${SELECT} WHERE s.id=?`).get(id) as any;
  return r ? rowToSession(r) : null;
}

/** Where a session's images live. Named by id, so no part of the path comes from the user. */
export const sessionDir = (id: number) => resolve(PREP_DIR, String(id));

/** The absolute path of one image, or null if the session has no such image. */
export function imagePath(session: PrepSession, n: number): string | null {
  const img = session.images.find((i) => i.n === n);
  if (!img) return null;
  const ext = img.mime === "image/jpeg" ? "jpg" : img.mime.slice("image/".length);
  return resolve(sessionDir(session.id), `${n}.${ext}`);
}

export interface NewSession {
  jobId: string;
  stage: string;
  title: string;
  notes: string;
  files: { name: string; mime: string; buf: Buffer }[];
}

/**
 * Save a session and its images. Nothing is generated here — that is a model call,
 * and a session you can look at before paying for is worth the second step.
 */
export function createSession(o: NewSession): { id: number } | { error: string } {
  if (!getJob(o.jobId)) return { error: "no such posting" };
  const stage = STAGES.some((s) => s.id === o.stage) ? o.stage : "other";
  const title = o.title.trim() || stageLabel(stage);
  if (o.files.length > MAX_IMAGES) return { error: `At most ${MAX_IMAGES} screenshots per session.` };
  for (const f of o.files) {
    if (!IMAGE_MIMES[f.mime]) return { error: `"${f.name}" is not an image the models can read (PNG, JPEG, WebP or GIF).` };
    if (f.buf.length > MAX_IMAGE_BYTES)
      return { error: `"${f.name}" is ${(f.buf.length / 1048576).toFixed(1)} MB; the limit is 5 MB. Crop it, or screenshot the part that matters.` };
  }

  const now = new Date().toISOString();
  const info = getDb()
    .prepare(
      "INSERT INTO prep_sessions (job_id, stage, title, notes, images, created_at, updated_at) VALUES (?,?,?,?,'[]',?,?)"
    )
    .run(o.jobId, stage, title, o.notes.trim(), now, now);
  const id = Number(info.lastInsertRowid);

  // written after the row exists, so the directory is named by a real id
  const images: PrepImage[] = [];
  if (o.files.length) {
    mkdirSync(sessionDir(id), { recursive: true });
    o.files.forEach((f, i) => {
      const mime = IMAGE_MIMES[f.mime];
      const img: PrepImage = { n: i + 1, name: f.name, mime, bytes: f.buf.length };
      images.push(img);
      writeFileSync(imagePath({ id, images: [img] } as PrepSession, img.n)!, f.buf);
    });
    getDb().prepare("UPDATE prep_sessions SET images=? WHERE id=?").run(JSON.stringify(images), id);
  }
  addEvent(o.jobId, "prep_session", { stage, title, images: images.length });
  return { id };
}

export function deleteSession(id: number): void {
  const s = getSession(id);
  if (!s) return;
  getDb().prepare("DELETE FROM prep_sessions WHERE id=?").run(id);
  rmSync(sessionDir(id), { recursive: true, force: true });
}

/** The résumé everything is written from: the one built for this job, else the default. */
function baseResume(jobId: string) {
  const built = getResumeProfile(String(getMeta(`built:${jobId}`) || ""))?.data;
  return built || getDefaultProfile()?.data || null;
}

/** The knowledge base entries that bear on this posting, in the shape the prompt wants. */
export function evidenceFor(job: { id: string; company: string; role: string; stack?: string | null; jd?: string | null; profile_id?: string | null }): PrepEvidence[] {
  const ranked = rankKbForJob(`${job.role} ${job.company} ${job.stack || ""} ${job.jd || ""}`, 10, job.profile_id || undefined);
  return ranked.map(({ source }) => ({
    title: source.title,
    role: source.role,
    when: source.start_date ? `${source.start_date}${source.end_date ? ` – ${source.end_date}` : ""}` : null,
    summary: source.summary,
    tags: source.tags,
    bullets: source.bullets.slice(0, 6),
    context: source.context,
  }));
}

/**
 * Generate — or regenerate — the prep for a session.
 *
 * Picks the runner: the images go to one that can look, which on an install whose
 * default is a local text model means the fallback or another key. If nothing can
 * look, the prep is written from the notes and the posting alone and the session
 * records that, so the page can say it rather than imply the screenshots were read.
 */
export async function generatePrep(
  sessionId: number,
  log: (kind: string, text: string) => void = () => {}
): Promise<{ ok: true; sawImages: boolean; runner: string } | { ok: false; error: string }> {
  const s = getSession(sessionId);
  if (!s) return { ok: false, error: "no such session" };
  const job = getJob(s.job_id);
  if (!job) return { ok: false, error: "the posting is gone" };
  const base = baseResume(job.id);
  if (!base) return { ok: false, error: "Upload a base résumé first — the prep is written from it." };

  const images: ImageInput[] = s.images
    .map((i) => ({ path: imagePath(s, i.n)!, mime: i.mime }))
    .filter((i) => existsSync(i.path));

  let runnerId: string | undefined;
  if (images.length) {
    const seer = await runnerForImages();
    if (seer) {
      runnerId = seer.id;
      log("step", `${images.length} screenshot(s) — ${seer.label} will read them.`);
    } else {
      log("note", `${images.length} screenshot(s) attached, but no runner on this machine can look at a picture. Preparing from your notes and the posting.`);
    }
  }

  const evidence = evidenceFor(job as any);
  log("step", evidence.length ? `Drawing answers from ${evidence.length} knowledge-base entr${evidence.length === 1 ? "y" : "ies"}…` : "Nothing in the knowledge base matches this posting — the prep will say so where it matters.");

  const r = await interviewPrep(base, { id: job.id, company: job.company, role: job.role, stack: job.stack, eligibility: job.eligibility, jd: job.jd }, {
    stage: s.stage,
    stageLabel: stageLabel(s.stage),
    title: s.title,
    notes: s.notes,
    images: runnerId ? images : [],
    evidence,
    priorAnswers: answerBank().slice(0, 20),
    runnerId,
  });

  // an empty answer is not a prep; the session keeps whatever it had rather than a blank
  if (!r.text.trim()) return { ok: false, error: `${r.runner} (${r.model}) returned nothing. Try again, or pick a different model in Settings.` };

  getDb()
    .prepare("UPDATE prep_sessions SET prep_md=?, vision=?, runner=?, model=?, llm_call_id=?, updated_at=? WHERE id=?")
    .run(r.text, r.sawImages ? 1 : 0, r.runner, r.model, r.callId ?? null, new Date().toISOString(), sessionId);
  addEvent(job.id, "interview_prep", { session: sessionId, stage: s.stage, sawImages: r.sawImages });
  return { ok: true, sawImages: r.sawImages, runner: r.runner };
}
