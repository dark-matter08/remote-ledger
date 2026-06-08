// Job crawls, fully logged to the Crawl Shell. Three types:
//   find   — ask the runner to research fresh roles, upsert, scrape new JDs
//   update — re-scrape JDs for existing active jobs (refresh)
//   full   — find then update
// Works best with a CLI runner that has web access (e.g. Claude Code).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runLLM, defaultRunnerId, tryParseJson, logExternalCall } from "../llm/runner.server";
import { streamClaude } from "../llm/adapters.server";
import { getSetting } from "../sqlite.server";
import {
  upsertJobs,
  setMeta,
  getMeta,
  setJd,
  jobId,
  createCrawlRun,
  updateCrawlRun,
  crawlLog,
  activeCrawl,
} from "../db.server";
import { scrapeJds, verifyJobs } from "./scrape.server";

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

// Web-action budget for TIME mode. The agent can't perceive wall-clock, so it
// governs itself by counting tool calls. Following aggregator links through to the
// final employer page costs extra fetches, so we budget ~4 actions/minute.
export function actionBudget(timeoutMin: number): number {
  return Math.max(6, Math.round(timeoutMin * 4));
}

interface PromptOpts {
  mode: "time" | "count";
  timeoutMin?: number;       // time mode
  target?: number;           // count mode: overall goal
  remaining?: number;        // count mode: how many still needed this round
  exclude?: string[];        // count mode: "Company — Role" already found
}

function buildPrompt(o: PromptOpts): string {
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

  if (o.mode === "count") {
    const want = o.remaining ?? o.target ?? 5;
    const cap = Math.max(12, want * 6); // generous per-round safety cap on web actions
    const body = tmpl
      .replaceAll("{{location}}", loc)
      .replaceAll("{{stack}}", stack)
      .replaceAll("{{budget_min}}", "as long as it takes")
      .replaceAll("{{max_actions}}", String(cap));
    const exclude = (o.exclude || []).slice(0, 40);
    const footer =
      `\n\n[GOAL MODE — COUNT, NO TIME LIMIT] Your goal is to return AT LEAST ${want} concrete, ` +
      `VERIFIED-OPEN role(s), each with a working FINAL employer application URL (follow aggregator ` +
      `"Apply" links through to the employer's site/ATS and confirm the page is live). There is NO time ` +
      `budget — keep searching and opening pages until you have ${want} solid role(s). Do not stop early ` +
      `and do not pad with guesses; quality over speed. Stay under ${cap} web actions per turn as a safety ` +
      `limit.` +
      (exclude.length ? `\n\nDo NOT repeat these already-found roles:\n- ${exclude.join("\n- ")}` : "") +
      `\n\nWhen you have ${want} verified role(s), output ONLY the JSON array and stop.`;
    return body + footer;
  }

  const timeoutMin = o.timeoutMin ?? 15;
  const maxActions = actionBudget(timeoutMin);
  const body = tmpl
    .replaceAll("{{location}}", loc)
    .replaceAll("{{stack}}", stack)
    .replaceAll("{{budget_min}}", String(timeoutMin))
    .replaceAll("{{max_actions}}", String(maxActions));
  const footer = `\n\n[RUNTIME BUDGET — STRICT] You have about ${timeoutMin} minute(s) and AT MOST ${maxActions} web actions (searches + fetches combined). You cannot perceive time, so COUNT your actions: the moment you reach ${maxActions}, stop searching and output the final JSON array. Ending your turn WITHOUT the JSON array is a complete failure — when unsure, output what you have now.`;
  return body + footer;
}

// Run the research agent once and return its raw text. Streams live steps to the
// Crawl Shell for the Claude CLI; otherwise dispatches through the runner layer.
async function invokeAgent(
  prompt: string,
  timeoutMs: number,
  signal: AbortSignal,
  L: (kind: string, text: string) => void
): Promise<string> {
  const runner = (await defaultRunnerId()) || "(none)";
  if (runner === "claude-cli") {
    const cliModel = getSetting("model_claude-cli") || "";
    const t0 = Date.now();
    const sr = await streamClaude({
      prompt,
      allowWeb: true,
      model: cliModel || undefined,
      timeoutMs,
      signal,
      onEvent: (ev: any) => {
        if (ev.type === "assistant" && ev.message?.content) {
          for (const c of ev.message.content) {
            if (c.type === "tool_use") {
              const q = c.input?.query || c.input?.url || c.input?.prompt || "";
              L("step", `${c.name}${q ? `: ${String(q).slice(0, 110)}` : ""}`);
            } else if (c.type === "text" && c.text?.trim()) {
              L("reasoning", c.text.trim().replace(/\s+/g, " ").slice(0, 180));
            }
          }
        }
      },
    });
    logExternalCall({ runner: "claude-cli", model: "claude", purpose: "job-research", usage: { inTok: sr.usage.inTok || 0, outTok: sr.usage.outTok || 0, cachedTok: sr.usage.cachedTok || 0, costUsd: sr.usage.costUsd || 0, metered: false }, durationMs: Date.now() - t0 });
    L("step", `Claude finished in ${Math.round((Date.now() - t0) / 1000)}s.`);
    return sr.text;
  }
  L("step", `Invoking runner: ${runner}…`);
  const r = await runLLM({ purpose: "job-research", prompt, allowWeb: true, json: true, maxTokens: 8000, temperature: 0.3 });
  L("step", `Runner ${r.runner}/${r.model} returned ${r.text.length} chars in ${r.durationMs}ms.`);
  return r.text;
}

let running = false;
// active run controllers so a Stop can actually kill the underlying agent process
const controllers = new Map<number, AbortController>();

export function abortCrawl(runId: number): boolean {
  const ac = controllers.get(runId);
  if (ac) { ac.abort(); return true; }
  return false;
}

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
  const ac = new AbortController();
  controllers.set(runId, ac);
  const totals = { received: 0, inserted: 0, updated: 0, scraped: 0, errors: 0 };
  try {
    L("note", `Crawl started · type=${type}`);

    if (type === "find" || type === "full") {
      const loc = getSetting("profile_location") || "remote";
      const stack = getSetting("profile_stack") || "software";
      const mode = (getSetting("crawl_mode") || "time") as "time" | "count";

      // verified-open roles collected this run, keyed by company--role (dedup across rounds)
      const collected = new Map<string, { job: any; jd: string; jdHtml: string }>();
      const keyOf = (j: any) => jobId(j.company, j.role);

      if (mode === "count") {
        // GOAL MODE: keep searching (no time limit) until we have N verified roles.
        const target = Math.max(1, Math.min(25, Number(getSetting("crawl_target_count") || "5") || 5));
        const maxRounds = 6;
        L("reasoning", `Goal mode: collect ${target} verified-open role(s) in "${loc}" matching "${stack}" — no time limit (up to ${maxRounds} search rounds).`);
        for (let round = 1; round <= maxRounds && collected.size < target && !ac.signal.aborted; round++) {
          const remaining = target - collected.size;
          const exclude = Array.from(collected.values()).map((c) => `${c.job.company} — ${c.job.role}`);
          const prompt = buildPrompt({ mode: "count", target, remaining, exclude });
          L("step", `Round ${round}/${maxRounds}: searching for ${remaining} more verified role(s)…`);
          const text = await invokeAgent(prompt, 12 * 60000, ac.signal, L); // 12-min per-round safety net
          const parsed = tryParseJson(text);
          const jobs = Array.isArray(parsed) ? parsed : parsed?.jobs || [];
          if (!Array.isArray(jobs) || !jobs.length) { L("note", `Round ${round}: no parseable roles; retrying.`); continue; }
          totals.received += jobs.length;
          L("result", `Round ${round}: ${jobs.length} candidate(s) — verifying & following links to final pages…`);
          const { alive, dropped } = await verifyJobs(jobs, { limit: 40, signal: ac.signal, onLog: (line) => L("step", line) });
          totals.errors += dropped.length;
          for (const a of alive) { const k = keyOf(a.job); if (!collected.has(k)) collected.set(k, a); }
          L("result", `Verified ${collected.size}/${target} solid role(s) so far (this round added ${alive.length}).`);
        }
        if (collected.size < target)
          L("note", `Stopped with ${collected.size}/${target} after ${maxRounds} round(s) — couldn't verify more open roles right now.`);
      } else {
        // TIME MODE: single research pass bounded by an action budget derived from the timeout.
        const timeoutMin = Number(getSetting("crawl_timeout_min") || "15") || 15;
        const maxActions = actionBudget(timeoutMin);
        L("reasoning", `Target: roles in "${loc}" matching "${stack}" · budget ${timeoutMin} min / ${maxActions} web actions.`);
        L("step", `Invoking research agent (budget ${timeoutMin}m → ${maxActions} actions; hard stop only at ${timeoutMin * 2}m)…`);
        const text = await invokeAgent(buildPrompt({ mode: "time", timeoutMin }), timeoutMin * 2 * 60000, ac.signal, L);
        const parsed = tryParseJson(text);
        const jobs = Array.isArray(parsed) ? parsed : parsed?.jobs || [];
        if (!Array.isArray(jobs) || jobs.length === 0) {
          L("error", "Could not parse any jobs from the runner output.");
        } else {
          totals.received = jobs.length;
          L("result", `Parsed ${jobs.length} candidate roles — verifying every link is a live posting…`);
          const { alive, dropped } = await verifyJobs(jobs, { limit: 40, signal: ac.signal, onLog: (line) => L("step", line) });
          L("result", `Verified ${alive.length} live · dropped ${dropped.length} (dead link, closed, or unreachable).`);
          totals.errors += dropped.length;
          for (const a of alive) collected.set(keyOf(a.job), a);
        }
      }

      // Persist whatever we verified (both modes). Trust nothing the agent claimed —
      // only these survived re-opening + following to a live final page.
      const aliveJobs = Array.from(collected.values()).map((a) => a.job);
      if (!aliveJobs.length) {
        L("error", "No verified-open roles to save this run.");
        setMeta("last_crawl_status", "error");
        if (type === "find") {
          updateCrawlRun(runId, { status: "error", ended_at: new Date().toISOString(), note: "no verified jobs", ...totals });
          return { ok: false, runId, ...totals, message: "no verified jobs" };
        }
      } else {
        const res = upsertJobs(aliveJobs, now);
        totals.inserted = res.inserted;
        totals.updated = res.updated;
        totals.errors += res.errors.length;
        for (const e of res.errors.slice(0, 5)) L("error", `Rejected ${e.job}: ${e.error}`);
        // save the JD (text + sanitized rich HTML) captured during verification
        let saved = 0;
        for (const a of collected.values()) {
          try { setJd(jobId(a.job.company, a.job.role), a.jd, a.jdHtml || null); saved++; } catch {}
        }
        totals.scraped = saved;
        L("result", `Saved ${res.inserted} new, ${res.updated} updated · ${saved} JDs captured. Existing jobs are kept (add/update only).`);

        // NOTE: we intentionally do NOT deactivate jobs missing from this run — each crawl
        // only adds new and refreshes existing. Stale roles leave via the Expired tab
        // (closes_at) or manual withdraw, never by being wiped on the next crawl.
        const prev = getMeta("last_crawl");
        if (prev) setMeta("prev_crawl", prev);
        setMeta("last_crawl", now);
        setMeta("last_crawl_status", totals.errors ? "partial" : "ok");
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
    const msg = e?.message || String(e);
    L("error", msg);
    if (/timed out/i.test(msg)) L("note", "Tip: raise the crawl timeout in Settings → Scheduler, or make the search prompt more focused (fewer sources) so the agent returns sooner.");
    updateCrawlRun(runId, { status: "error", ended_at: new Date().toISOString(), note: msg.slice(0, 200), ...totals });
    setMeta("last_crawl_status", "error");
    return { ok: false, runId, ...totals, message: e?.message || String(e) };
  } finally {
    running = false;
    controllers.delete(runId);
  }
}
