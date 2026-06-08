// Serve the screenshot of the last assisted-prefill run for a job (evidence the form
// was actually filled). Saved by apply.server at data/apply/assist-<jobId>.png.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Route } from "./+types/assist-shot";

export async function loader({ params }: Route.LoaderArgs) {
  const id = String(params.id || "").replace(/[^a-zA-Z0-9_-]/g, ""); // no path traversal
  const path = resolve(process.cwd(), "data", "apply", `assist-${id}.png`);
  if (!existsSync(path)) throw new Response("Not found", { status: 404 });
  const buf = readFileSync(path);
  return new Response(new Uint8Array(buf), {
    headers: { "content-type": "image/png", "cache-control": "no-cache" },
  });
}
