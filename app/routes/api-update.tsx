// Update notice + the button that takes one. GET answers "is there anything new",
// POST applies it and the server restarts underneath the response.
import { checkForUpdate, applyUpdate, updateLogTail, currentCommit } from "../services/updates.server";
import type { Route } from "./+types/api-update";

export async function loader({ request }: Route.LoaderArgs) {
  const q = new URL(request.url).searchParams;
  // what the poll asks while an update runs: local only, so it cannot race the pull
  if (q.get("local") === "1") return Response.json({ current: currentCommit(), log: updateLogTail() });
  const state = await checkForUpdate(q.get("force") === "1");
  // only while something is watching an update run — the poll is the one caller
  // that needs to be able to say what went wrong
  return Response.json(q.get("log") === "1" ? { ...state, log: updateLogTail() } : state);
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const r = await applyUpdate(String(form.get("to") || ""));
  return Response.json(r, { status: r.ok ? 200 : 409 });
}
