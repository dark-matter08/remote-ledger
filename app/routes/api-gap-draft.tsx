// POST /api/gap-draft — draft "how you used it" without leaving the form.
//
// A normal action would re-render the page and throw away every other row's
// selections, which on a nine-gap posting is most of the work the user has done.
// This answers with the text and nothing else; the row fills its own field.
import { draftGapUsage } from "../services/gaps.server";
import type { Route } from "./+types/api-gap-draft";

export async function action({ request }: Route.ActionArgs) {
  const f = await request.formData();
  const skill = String(f.get("skill") || "").trim();
  const itemIds = f.getAll("itemId").map((v) => Number(v)).filter((n) => Number.isFinite(n) && n > 0);
  const notes = String(f.get("notes") || "");
  if (!skill) return Response.json({ error: "no skill" }, { status: 400 });

  const r = await draftGapUsage({ skill, itemIds, notes });
  return Response.json(r, { status: r.error ? 409 : 200 });
}
