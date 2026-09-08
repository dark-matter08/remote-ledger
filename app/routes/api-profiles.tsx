// The sidebar's switcher needs the profile list, and the sidebar is a client
// component — so it asks for it the same way it asks for pending questions and
// updates, rather than every page having to pass it down.
import { listProfiles, currentProfile, setCurrentProfile } from "../profiles.server";
import type { Route } from "./+types/api-profiles";

export async function loader() {
  return Response.json({
    profiles: listProfiles().map((p) => ({ id: p.id, name: p.name, active: !!p.active })),
    current: currentProfile().id,
  });
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const id = String(form.get("id") || "");
  // "all" is a board-level view, not a profile — it is not something to remember here.
  if (id && id !== "all") setCurrentProfile(id);
  return Response.json({ ok: true, current: currentProfile().id });
}
