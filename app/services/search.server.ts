// Web search, as something the app does — not something the model claims to have done.
//
// This is the whole trick behind letting a local model work on live postings. The
// model never browses. It asks for a search, the app performs it, and the model only
// ever sees text we fetched ourselves. That keeps the property the crawl is built on:
// a posting is real because we retrieved it, not because a model remembered it.
import { getSetting } from "../sqlite.server";
import { searxngRunning, searxngUrl } from "./searxng.server";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  engine?: string;
}

export type SearchProvider = "searxng" | "brave" | "tavily" | "none";

export function searchProvider(): SearchProvider {
  const p = (getSetting("search_provider") || "none").toLowerCase();
  return (["searxng", "brave", "tavily"] as const).includes(p as any) ? (p as SearchProvider) : "none";
}

export function searxngBase(): string {
  return (getSetting("searxng_url") || searxngUrl()).replace(/\/+$/, "");
}

/** Is a search actually possible right now? The UI and the crawl both ask. */
export async function searchAvailable(): Promise<{ ok: boolean; why: string }> {
  const p = searchProvider();
  if (p === "none") return { ok: false, why: "No search backend configured." };
  if (p === "searxng") {
    const base = searxngBase();
    const up = /127\.0\.0\.1|localhost/.test(base) ? await searxngRunning() : await reachable(base);
    return up ? { ok: true, why: "" } : { ok: false, why: `SearXNG is not answering at ${base}.` };
  }
  const key = p === "brave" ? getSetting("brave_api_key_set") : getSetting("tavily_api_key_set");
  return key === "true" ? { ok: true, why: "" } : { ok: false, why: `No ${p} API key set.` };
}

async function reachable(base: string, ms = 2500): Promise<boolean> {
  try {
    const r = await fetch(base, { signal: AbortSignal.timeout(ms) });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Run a search. Returns [] rather than throwing when nothing is configured — a caller
 * that cannot search should degrade, not explode mid-crawl.
 */
export async function searchWeb(query: string, opts: { limit?: number } = {}): Promise<SearchResult[]> {
  const limit = Math.max(1, Math.min(20, opts.limit ?? 8));
  const q = String(query || "").trim();
  if (!q) return [];

  switch (searchProvider()) {
    case "searxng":
      return searxngSearch(q, limit);
    case "brave":
      return braveSearch(q, limit);
    case "tavily":
      return tavilySearch(q, limit);
    default:
      return [];
  }
}

async function searxngSearch(q: string, limit: number): Promise<SearchResult[]> {
  const url = new URL("/search", searxngBase());
  url.searchParams.set("q", q);
  url.searchParams.set("format", "json");
  url.searchParams.set("safesearch", "0");
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (r.status === 403) {
    // the signature of settings.yml without `json` in search.formats
    throw new Error("SearXNG refused the JSON API (403) — enable json under search.formats in settings.yml.");
  }
  if (!r.ok) throw new Error(`SearXNG answered ${r.status}`);
  const j: any = await r.json();
  return (j.results || []).slice(0, limit).map((x: any) => ({
    title: String(x.title || "").slice(0, 300),
    url: String(x.url || ""),
    snippet: String(x.content || "").replace(/\s+/g, " ").slice(0, 500),
    engine: x.engine ? String(x.engine) : undefined,
  })).filter((x: SearchResult) => x.url);
}

async function braveSearch(q: string, limit: number): Promise<SearchResult[]> {
  const { getSecret } = await import("../secrets.server");
  const key = getSecret("brave_api_key");
  if (!key) throw new Error("brave_api_key not set.");
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", q);
  url.searchParams.set("count", String(limit));
  const r = await fetch(url, {
    headers: { accept: "application/json", "x-subscription-token": key },
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`Brave answered ${r.status}`);
  const j: any = await r.json();
  return (j.web?.results || []).slice(0, limit).map((x: any) => ({
    title: String(x.title || "").slice(0, 300),
    url: String(x.url || ""),
    snippet: String(x.description || "").replace(/<[^>]+>/g, "").slice(0, 500),
    engine: "brave",
  }));
}

async function tavilySearch(q: string, limit: number): Promise<SearchResult[]> {
  const { getSecret } = await import("../secrets.server");
  const key = getSecret("tavily_api_key");
  if (!key) throw new Error("tavily_api_key not set.");
  const r = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: key, query: q, max_results: limit }),
    signal: AbortSignal.timeout(25000),
  });
  if (!r.ok) throw new Error(`Tavily answered ${r.status}`);
  const j: any = await r.json();
  return (j.results || []).slice(0, limit).map((x: any) => ({
    title: String(x.title || "").slice(0, 300),
    url: String(x.url || ""),
    snippet: String(x.content || "").replace(/\s+/g, " ").slice(0, 500),
    engine: "tavily",
  }));
}
