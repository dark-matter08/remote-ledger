// In-process job crawl: ask the runner to research fresh roles, upsert into the DB.
// Works best with a CLI runner that has web access (e.g. Claude Code). API runners
// without web search may not find live postings.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runLLM } from "../llm/runner.server";
import { getSetting } from "../sqlite.server";
import { upsertJobs, deactivateMissing, setMeta, getMeta } from "../db.server";
import { scrapeMissingJds } from "./scrape.server";

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

export interface CrawlResult {
  ok: boolean;
  received: number;
  inserted: number;
  updated: number;
  errors: number;
  scraped?: number;
  message?: string;
}

let running = false;

export async function runCrawl(): Promise<CrawlResult> {
  if (running) return { ok: false, received: 0, inserted: 0, updated: 0, errors: 0, message: "already running" };
  running = true;
  const now = new Date().toISOString();
  try {
    const r = await runLLM({
      purpose: "job-research",
      prompt: buildPrompt(),
      allowWeb: true,
      json: true,
      maxTokens: 8000,
      temperature: 0.3,
    });
    const jobs = Array.isArray(r.json) ? r.json : r.json?.jobs || [];
    if (!Array.isArray(jobs) || jobs.length === 0) {
      setMeta("last_crawl_status", "error");
      return { ok: false, received: 0, inserted: 0, updated: 0, errors: 0, message: "no jobs parsed from runner output" };
    }
    const res = upsertJobs(jobs, now);
    deactivateMissing(now);
    const prev = getMeta("last_crawl");
    if (prev) setMeta("prev_crawl", prev);
    setMeta("last_crawl", now);
    setMeta("last_crawl_status", res.errors.length ? "partial" : "ok");
    setMeta("last_crawl_counts", JSON.stringify({ inserted: res.inserted, updated: res.updated, errors: res.errors.length }));

    // Collect the full job description from each new posting's page.
    let scraped = 0;
    if (getSetting("scrape_jds") !== "false") {
      const limit = Number(getSetting("scrape_limit") || "12") || 12;
      try {
        scraped = (await scrapeMissingJds(limit)).scraped;
      } catch {}
    }
    return { ok: true, received: jobs.length, inserted: res.inserted, updated: res.updated, errors: res.errors.length, scraped };
  } catch (e: any) {
    setMeta("last_crawl_status", "error");
    return { ok: false, received: 0, inserted: 0, updated: 0, errors: 0, message: e.message || String(e) };
  } finally {
    running = false;
  }
}
