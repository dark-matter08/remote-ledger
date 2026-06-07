// Serve a screenshot captured during an apply session (by apply_logs id).
import { existsSync, readFileSync } from "node:fs";
import type { Route } from "./+types/apply-shot";
import { getLog } from "../db.server";

export async function loader({ params }: Route.LoaderArgs) {
  const log = getLog(Number(params.id));
  const path = log?.shot_path;
  if (!path || !existsSync(path)) throw new Response("Not found", { status: 404 });
  const buf = readFileSync(path);
  return new Response(new Uint8Array(buf), {
    headers: { "content-type": "image/png", "cache-control": "no-cache" },
  });
}
