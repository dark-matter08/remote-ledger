// If dropport (https://github.com/dark-matter08/dropport) is fronting this app at a
// real hostname, send anyone who arrives on the raw port to the clean URL instead.
//
// The proxy cannot do this itself: it never sees :5173, because this app owns that
// port. So the app has to notice and redirect.
//
// It only fires when dropport genuinely maps THIS hostname to THIS port. Reaching the
// app at localhost:5173, at an IP, or on a port dropport knows nothing about, is left
// completely alone.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const REGISTRY = process.env.DROPPORT_REGISTRY || resolve(homedir(), ".dropport", "apps.json");

interface DropportApp {
  host: string;
  port: number;
  tls?: boolean;
}

// Re-reading a small JSON file on every request would be silly, and never re-reading
// it would mean a restart after every `dropport add`. Watch the mtime instead.
let cache: { mtime: number; apps: DropportApp[] } | null = null;

function registry(): DropportApp[] {
  try {
    const mtime = statSync(REGISTRY).mtimeMs;
    if (cache?.mtime === mtime) return cache.apps;
    const apps = (JSON.parse(readFileSync(REGISTRY, "utf8")).apps || []) as DropportApp[];
    cache = { mtime, apps };
    return apps;
  } catch {
    cache = null; // not installed, or unreadable: behave as if it does not exist
    return [];
  }
}

/**
 * Where this request should go instead, or null to leave it alone.
 *
 * GET only. Redirecting a POST would drop the body, and a form submission silently
 * losing its payload is a far worse outcome than an ugly URL.
 */
export function dropportRedirect(request: Request): string | null {
  if (request.method !== "GET") return null;

  const hostHeader = request.headers.get("host") || "";
  const [name, port] = hostHeader.split(":");
  if (!name || !port) return null; // already on a clean URL

  const app = registry().find((a) => a.host.toLowerCase() === name.toLowerCase());
  if (!app || String(app.port) !== port) return null;

  const url = new URL(request.url);
  const scheme = app.tls === false ? "http" : "https";
  return `${scheme}://${app.host}${url.pathname}${url.search}`;
}
