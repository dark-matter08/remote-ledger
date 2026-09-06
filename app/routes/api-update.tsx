// Update notice + the button that takes one. GET answers "is there anything new",
// POST applies it and the server restarts underneath the response.
import { checkForUpdate, applyUpdate, updateLogTail } from "../services/updates.server";
import type { Route } from "./+types/api-update";

export async function loader({ request }: Route.LoaderArgs) {
  const q = new URL(request.url).searchParams;
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
