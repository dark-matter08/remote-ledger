// Update notice + the button that takes one. GET answers "is there anything new",
// POST applies it and the server restarts underneath the response.
import { checkForUpdate, applyUpdate } from "../services/updates.server";
import type { Route } from "./+types/api-update";

export async function loader({ request }: Route.LoaderArgs) {
  const force = new URL(request.url).searchParams.get("force") === "1";
  return Response.json(await checkForUpdate(force));
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const r = await applyUpdate(String(form.get("to") || ""));
  return Response.json(r, { status: r.ok ? 200 : 409 });
}
