// POST /api/crawl — run a job crawl now (Settings "Run now" button, OS scheduler).
import type { Route } from "./+types/api-crawl";
import { runCrawl } from "../services/crawl.server";

export async function action(_: Route.ActionArgs) {
  const r = await runCrawl();
  return Response.json(r);
}

export async function loader() {
  return Response.json({ ok: false, message: "POST to run a crawl" }, { status: 405 });
}
