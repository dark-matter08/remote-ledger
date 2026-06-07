// Job crawls, fully logged to the Crawl Shell. Three types:
//   find   — ask the runner to research fresh roles, upsert, scrape new JDs
//   update — re-scrape JDs for existing active jobs (refresh)
//   full   — find then update
// Works best with a CLI runner that has web access (e.g. Claude Code).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runLLM, defaultRunnerId } from "../llm/runner.server";
import { getSetting } from "../sqlite.server";
import {
  upsertJobs,
  deactivateMissing,
  setMeta,
  getMeta,
  createCrawlRun,
  updateCrawlRun,
  crawlLog,
  activeCrawl,
} from "../db.server";
import { scrapeJds } from "./scrape.server";

export type CrawlType = "find" | "update" | "full";

export interface CrawlResult {
  ok: boolean;
  runId: number;
  received: number;
  inserted: number;
  updated: number;
  scraped: number;
  errors: number;
  message?: string;
}

function buildPrompt(): string {
  let tmpl = getSetting("search_prompt");
  if (!tmpl) {
    try {
      tmpl = readFileSync(resolve(process.cwd(), "scripts", "prompt.md"), "utf8");
    } catch {
      tmpl = "Find remote jobs for {{location}} matching {{stack}}. Return a JSON array.";
    }
  }
  const loc = getSetting("profile_location") || "a remote-friendly location";
  const stack = getSetting("profile_stack") || "software engineering";
  return tmpl.replaceAll("{{location}}", loc).replaceAll("{{stack}}", stack);
}

let running = false;

// public: synchronous (scheduler / CLI)
export async function runCrawl(type: CrawlType = "find", trigger = "cli"): Promise<CrawlResult> {
  const runId = createCrawlRun(type, trigger);
  return execute(runId, type);
}

// public: fire-and-forget (UI) — returns the run id immediately
export function startCrawl(type: CrawlType = "find", trigger = "manual"): number {
  const runId = createCrawlRun(type, trigger);
  void execute(runId, type).catch((e: any) => {
    try {
      crawlLog(runId, "error", String(e?.message || e));
      updateCrawlRun(runId, { status: "error", ended_at: new Date().toISOString() });
    } catch {}
  });
  return runId;
}

export function isCrawlRunning(): boolean {
  return running || !!activeCrawl();
}

async function execute(runId: number, type: CrawlType): Promise<CrawlResult> {
  const L = (kind: string, text: string) => crawlLog(runId, kind, text);
  const now = new Date().toISOString();
  running = true;
  const totals = { received: 0, inserted: 0, updated: 0, scraped: 0, errors: 0 };
  try {
    L("note", `Crawl started · type=${type}`);

    if (type === "find" || type === "full") {
      const runner = (await defaultRunnerId()) || "(none)";
      const loc = getSetting("profile_location") || "remote";
      const stack = getSetting("profile_stack") || "software";
      L("reasoning", `Target: roles in "${loc}" matching "${stack}".`);
      L("step", `Invoking runner: ${runner} (web search enabled)…`);
      const r = await runLLM({ purpose: "job-research", prompt: buildPrompt(), allowWeb: true, json: true, maxTokens: 8000, temperature: 0.3 });
      L("step", `Runner ${r.runner}/${r.model} returned ${r.text.length} chars in ${r.durationMs}ms.`);
      const jobs = Array.isArray(r.json) ? r.json : r.json?.jobs || [];
      if (!Array.isArray(jobs) || jobs.length === 0) {
        L("error", "Could not parse any jobs from the runner output.");
        updateCrawlRun(runId, { status: "error", ended_at: new Date().toISOString(), note: "no jobs parsed" });
        setMeta("last_crawl_status", "error");
        return { ok: false, runId, ...totals, message: "no jobs parsed" };
      }
      L("result", `Parsed ${jobs.length} candidate roles.`);
      const res = upsertJobs(jobs, now);
      totals.received = jobs.length;
      totals.inserted = res.inserted;
      totals.updated = res.updated;
      totals.errors += res.errors.length;
      L("result", `Upserted: ${res.inserted} new, ${res.updated} updated${res.errors.length ? `, ${res.errors.length} rejected` : ""}.`);
      for (const e of res.errors.slice(0, 5)) L("error", `Rejected ${e.job}: ${e.error}`);
      deactivateMissing(now);
      const prev = getMeta("last_crawl");
      if (prev) setMeta("prev_crawl", prev);
      setMeta("last_crawl", now);
      setMeta("last_crawl_status", res.errors.length ? "partial" : "ok");

      if (getSetting("scrape_jds") !== "false") {
        const limit = Number(getSetting("scrape_limit") || "12") || 12;
        L("step", `Scraping full JDs for up to ${limit} new postings…`);
        const s = await scrapeJds({ limit, onlyMissing: true, onLog: (line) => L("step", line) });
        totals.scraped += s.scraped;
        L("result", `Scraped ${s.scraped} JD(s)${s.failed ? `, ${s.failed} failed` : ""}.`);
      }
    }

    if (type === "update" || type === "full") {
      const limit = Number(getSetting("scrape_limit") || "12") || 12;
      L("step", `Refreshing JDs for up to ${limit} existing active postings…`);
      const s = await scrapeJds({ limit, onlyMissing: false, onLog: (line) => L("step", line) });
      totals.scraped += s.scraped;
      totals.errors += s.failed;
      L("result", `Refreshed ${s.scraped} JD(s)${s.failed ? `, ${s.failed} failed` : ""}.`);
      if (type === "update") {
        setMeta("last_crawl", now);
        setMeta("last_crawl_status", "ok");
      }
    }

    L("note", "Crawl complete.");
    updateCrawlRun(runId, { status: "done", ended_at: new Date().toISOString(), ...totals });
    return { ok: true, runId, ...totals };
  } catch (e: any) {
    L("error", e?.message || String(e));
    updateCrawlRun(runId, { status: "error", ended_at: new Date().toISOString(), ...totals });
    setMeta("last_crawl_status", "error");
    return { ok: false, runId, ...totals, message: e?.message || String(e) };
  } finally {
    running = false;
  }
}
