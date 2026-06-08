// Lists immediate subdirectories of a path on THIS machine, so the Knowledge Base
// folder picker can browse the real filesystem (local-first) and capture the exact
// absolute path — without uploading anything. Localhost, single-user app.
import { readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { Route } from "./+types/api-dirs";

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  let p = (url.searchParams.get("path") || "").trim();
  p = p.replace(/^~(?=\/|$)/, homedir());
  if (!p) p = homedir();
  const home = homedir();
  try {
    if (!statSync(p).isDirectory()) p = dirname(p);
    const dirs = readdirSync(p, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name)
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
      .slice(0, 1000);
    return { ok: true, path: p, parent: dirname(p), home, dirs };
  } catch (e: any) {
    return { ok: false, path: p, parent: dirname(p), home, dirs: [], error: e.message || "Cannot read that folder." };
  }
}
