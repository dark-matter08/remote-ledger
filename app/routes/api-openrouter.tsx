// The OpenRouter catalogue, for the Settings → OpenRouter picker.
//
// Served on demand rather than through the Settings loader: it is 400+ models, and
// nobody visiting the Scheduler tab should pay for that payload. `?refresh=1` forces
// a re-fetch from OpenRouter, otherwise the 6h disk cache answers instantly.
import { openRouterCatalog, vendorsOf, TIERS } from "../llm/openrouter.server";
import type { Route } from "./+types/api-openrouter";

export async function loader({ request }: Route.LoaderArgs) {
  const refresh = new URL(request.url).searchParams.get("refresh") === "1";
  const { models, fetchedAt, stale, error } = await openRouterCatalog({ force: refresh });
  return Response.json(
    {
      models, // already ranked best-first
      tiers: TIERS,
      vendors: vendorsOf(models),
      counts: { total: models.length, free: models.filter((m) => m.free).length },
      fetchedAt,
      stale,
      error,
    },
    { headers: { "cache-control": "no-store" } }
  );
}
