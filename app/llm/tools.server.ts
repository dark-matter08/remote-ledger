// The two tools that let a model that cannot browse work from live pages.
//
// The model never reaches the network. It asks; the app performs the call and hands
// back the text. That distinction is the whole safety property: a page is real because
// we fetched it, not because a model recalled it. Anything the model then says about a
// posting can be checked against text we hold.
//
// Deliberately two tools, not ten. Every extra tool is another thing a 7B model can
// pick wrongly, and search + fetch already covers "find a page, then read it".
import { isCareersIndex, scrapeJobPage } from "../services/scrape.server";
import { searchWeb } from "../services/search.server";
import { urlKey } from "../job-identity";
import type { ToolCall, ToolDef } from "./types";

export const WEB_TOOLS: ToolDef[] = [
  {
    name: "search_web",
    description:
      "Search the live web and get back titles, URLs and snippets. Use this to find pages you do not " +
      "already have a URL for. It does not return the contents of any page — call fetch_url for that.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query. Operators like site: and quotes work.",
        },
        limit: { type: "integer", description: "How many results to return (1-15). Default 8." },
      },
      required: ["query"],
    },
  },
  {
    name: "fetch_url",
    description:
      "Fetch one web page and return its readable text. Use this to confirm a page exists and to read " +
      "what is actually on it before saying anything about it.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The absolute http(s) URL to fetch." },
      },
      required: ["url"],
    },
  },
];

/** Every URL a tool actually retrieved this run. The caller checks claims against it. */
export class FetchLedger {
  private readonly seen = new Map<string, string>();
  record(url: string, text: string) {
    this.seen.set(normalise(url), text);
  }
  has(url: string): boolean {
    return this.seen.has(normalise(url));
  }
  text(url: string): string | undefined {
    return this.seen.get(normalise(url));
  }
  get size(): number {
    return this.seen.size;
  }
  urls(): string[] {
    return [...this.seen.keys()];
  }
}

function normalise(u: string): string {
  try {
    const url = new URL(String(u).trim());
    return `${url.protocol}//${url.hostname.toLowerCase().replace(/^www\./, "")}${url.pathname.replace(/\/+$/, "")}${url.search}`;
  } catch {
    return String(u).trim();
  }
}

export interface ToolContext {
  ledger: FetchLedger;
  onLog?: (kind: string, text: string) => void;
  /** Hard ceiling on page fetches, which are slow and drive a browser. */
  maxFetches?: number;
}

/**
 * Run one tool call and return what the model should see.
 *
 * Always returns a string, never throws: a tool that blows up mid-loop would abort the
 * whole run, whereas an error the model can read is something it can route around.
 */
export async function executeTool(call: ToolCall, ctx: ToolContext): Promise<string> {
  const log = (t: string) => ctx.onLog?.("step", t);
  try {
    if (call.name === "search_web") {
      const query = String(call.args?.query || "").trim();
      if (!query) return "Error: search_web needs a non-empty `query`.";
      const limit = Math.max(1, Math.min(15, Number(call.args?.limit) || 8));
      log(`searching: ${query}`);
      const results = await searchWeb(query, { limit });
      if (!results.length) return `No results for "${query}". Try different words or fewer operators.`;
      log(`  ${results.length} result(s)`);
      return results
        .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
        .join("\n");
    }

    if (call.name === "fetch_url") {
      const url = String(call.args?.url || "").trim();
      if (!/^https?:\/\//i.test(url)) return "Error: fetch_url needs an absolute http(s) `url`.";
      if (ctx.maxFetches && ctx.ledger.size >= ctx.maxFetches)
        return `Error: fetch budget spent (${ctx.maxFetches} pages). Work with what you already read.`;
      log(`reading: ${url.slice(0, 100)}`);
      const page = await scrapeJobPage(url);
      if (!page.ok || !page.text) return `Could not read ${url}${page.error ? ` — ${page.error}` : ""}.`;
      ctx.ledger.record(url, page.text);
      const note = listingWarning(url);
      // enough to judge a posting, not so much that a small model loses the thread
      const body = page.text.replace(/\s+/g, " ").slice(0, 6000);
      log(`  ${page.text.length} chars`);
      return `# ${page.title || url}\nURL: ${url}\n\n${body}${note}`;
    }

    return `Error: no tool called "${call.name}". Available: ${WEB_TOOLS.map((t) => t.name).join(", ")}.`;
  } catch (e: any) {
    return `Error running ${call.name}: ${String(e?.message || e).slice(0, 300)}`;
  }
}

/**
 * Warn the model when it has fetched a page of results rather than a job.
 *
 * isCareersIndex knows company careers roots (/careers, /company/jobs). It does not
 * know an aggregator's search page — it reads ziprecruiter.com/Jobs/Remote-Typescript
 * and indeed.com/q-typescript-l-remote-jobs.html as postings. A 7B model fetched
 * exactly such a page, lifted a company name off the listing, and reported the search
 * URL as the posting: alive, plausible, and wrong.
 *
 * The tell is identity. A real posting carries the board's id for it — a Greenhouse
 * number, an Ashby UUID — which is the same signal the ledger already uses to tell two
 * crawl results apart. No id, no posting.
 */
function listingWarning(url: string): string {
  if (isCareersIndex(url))
    return "\n\nNOTE: this is a careers index, not one posting. A specific role has its own URL — find it and fetch that.";
  if (!urlKey(url))
    return (
      "\n\nNOTE: this URL carries no posting id, so it is a search or listing page rather than one job. " +
      "Anything you name from it is a guess. Follow through to the employer's own posting and fetch that URL instead."
    );
  return "";
}
