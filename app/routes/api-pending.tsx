// Lightweight poll endpoint for the sidebar badge: open question count + running sessions.
import { openQuestions } from "../db.server";
import { getDb } from "../sqlite.server";

export async function loader() {
  let questions = 0;
  let running = 0;
  try {
    questions = openQuestions().length;
    running = (getDb().prepare("SELECT COUNT(*) n FROM apply_sessions WHERE status='running'").get() as any).n;
  } catch {}
  return Response.json({ questions, running }, { headers: { "cache-control": "no-store" } });
}
