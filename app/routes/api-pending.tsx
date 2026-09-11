// Lightweight poll endpoint for the sidebar badge: open question count + running sessions.
import { openQuestions } from "../db.server";
import { getDb } from "../sqlite.server";
import { BUILD_ID } from "../build-id.server";

export async function loader() {
  let questions = 0;
  let running = 0;
  try {
    questions = openQuestions().length;
    running = (getDb().prepare("SELECT COUNT(*) n FROM apply_sessions WHERE status='running'").get() as any).n;
  } catch {}
  // `build` is the running process's id — a page that booted under a different one is
  // running old code, and the sidebar says so
  return Response.json({ questions, running, build: BUILD_ID }, { headers: { "cache-control": "no-store" } });
}
