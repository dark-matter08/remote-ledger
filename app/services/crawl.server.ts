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
  blocklistPrompt,
} from "../db.server";
import { scrapeJds, verifyJobs } from "./scrape.server";
import {
  activeCompanies,
  fetchBoard,
  markCompanyChecked,
  boardUrl,
  type AtsPosting,
  type Company,
} from "./ats.server";

export type CrawlType = "find" | "update" | "full" | "careers";

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
    return body + blocklistPrompt() + footer;
  }

  const timeoutMin = o.timeoutMin ?? 15;
  const maxActions = actionBudget(timeoutMin);
  const body = tmpl
    .replaceAll("{{location}}", loc)
    .replaceAll("{{stack}}", stack)
    .replaceAll("{{budget_min}}", String(timeoutMin))
    .replaceAll("{{max_actions}}", String(maxActions));
  const footer = `\n\n[RUNTIME BUDGET — STRICT] You have about ${timeoutMin} minute(s) and AT MOST ${maxActions} web actions (searches + fetches combined). You cannot perceive time, so COUNT your actions: the moment you reach ${maxActions}, stop searching and output the final JSON array. Ending your turn WITHOUT the JSON array is a complete failure — when unsure, output what you have now.`;
  return body + blocklistPrompt() + footer;
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

// Wrap any short LLM task as a crawl_run so it's monitorable in the Crawl Shell
// (status + step logs + history). Runs inline; the run row commits immediately so a
// shell open in another tab sees it live. Returns the task's result.
export async function loggedTask<T>(
  type: string,
  label: string,
  fn: (log: (kind: string, text: string) => void) => Promise<T>
): Promise<T> {
  const runId = createCrawlRun(type, "job");
  updateCrawlRun(runId, { note: label });
  const L = (kind: string, text: string) => crawlLog(runId, kind, text);
  L("note", `${label} — started`);
  try {
    const r = await fn(L);
    L("note", "Done.");
    updateCrawlRun(runId, { status: "done", ended_at: new Date().toISOString() });
    return r;
  } catch (e: any) {
    L("error", String(e?.message || e).slice(0, 300));
    updateCrawlRun(runId, { status: "error", ended_at: new Date().toISOString(), note: label });
    throw e;
  }
}

// --- career pages ------------------------------------------------------------
// Public ATS feeds are exact and free, so finding roles needs no agent at all. The
// model is still needed to JUDGE a role against the candidate, but that is one
// batched call over pre-filtered rows instead of an hour of browsing.

const MAX_PER_COMPANY = 25;   // one big board must not crowd out every other company
const MAX_CANDIDATES = 120;   // ceiling on what we pay to score
const SCORE_BATCH = 20;
const BOARD_CONCURRENCY = 6;

const REMOTE_RE = /\b(remote|anywhere|worldwide|global|distributed|work from home|wfh)\b/i;
const ENGINEERING_RE =
  /\b(engineer|engineering|developer|programmer|architect|sre|devops|platform|full[- ]?stack|back[- ]?end|front[- ]?end|software|data|infrastructure)\b/i;

// A board that says remote:false is believed. Silence is not a no, so fall back to
// reading the location and title.
function remoteEligible(p: AtsPosting): boolean {
  if (p.remote === true) return true;
  if (p.remote === false) return false;
  return REMOTE_RE.test(`${p.location || ""} ${p.title}`);
}

function stackTokens(stack: string): string[] {
  return stack
    .split(/[,/·|]+/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 1);
}

function looksRelevant(p: AtsPosting, tokens: string[]): boolean {
  if (ENGINEERING_RE.test(p.title)) return true;
  const hay = `${p.title} ${p.description || ""}`.toLowerCase();
  return tokens.some((t) => hay.includes(t));
}

async function pooled<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

interface Candidate { company: Company; posting: AtsPosting }

// Judge a batch of real postings. They are known to exist, so the model is only
// scoring fit — it is never asked for a URL and cannot invent one.
async function scoreCandidates(
  batch: Candidate[],
  loc: string,
  stack: string,
  L: (k: string, t: string) => void
): Promise<any[]> {
  const listing = batch
    .map((c, i) =>
      `${i}. ${c.company.name} — ${c.posting.title}\n   location: ${c.posting.location || "unstated"}\n   ${(c.posting.description || "").slice(0, 600)}`
    )
    .join("\n\n");

  const r = await runLLM({
    purpose: "job-research",
    json: true,
    temperature: 0.2,
    maxTokens: 3000,
    system:
      "You score real, already-verified job postings against one candidate. Every posting below exists and its link is known good, so never invent, alter or return a URL. Judge fit only, and be honest: a bad match scored highly wastes the candidate's time.",
    prompt: `CANDIDATE\n- Based in: ${loc}. Needs roles workable remotely from there.\n- Target stack: ${stack}\n\nPOSTINGS\n${listing}\n\nFor each posting return an entry. DROP anything that is not a software engineering role the candidate could do, or that cannot be worked remotely from their location.\nReturn ONLY JSON: { "jobs": [ { "i": 0, "category": "high|medium|stretch", "fit_score": 0-100, "stack": "short tech fine-print e.g. 'TS · Node · Postgres'", "eligibility": "short note e.g. 'Open worldwide'", "seniority": "Mid|Senior|Contract|Varies" } ] }\nOmit an entry entirely to drop that posting. "high" means strong stack match AND clearly eligible from ${loc}.`,
  });

  const parsed = (r.json?.jobs || []) as any[];
  const out: any[] = [];
  for (const row of parsed) {
    const c = batch[Number(row?.i)];
    if (!c) continue;
    out.push({
      company: c.company.name,
      role: c.posting.title,
      category: String(row.category || "medium").toLowerCase(),
      fit_score: Number(row.fit_score) || 0,
      stack: row.stack || null,
      eligibility: row.eligibility || null,
      seniority: row.seniority || null,
      apply_url: c.posting.url,
      source: c.company.ats ? `${c.company.name} (${c.company.ats})` : c.company.name,
    });
  }
  L("step", `Scored ${batch.length} posting(s) → kept ${out.length}.`);
  return out;
}

async function runCareersCrawl(
  signal: AbortSignal,
  L: (kind: string, text: string) => void
): Promise<{ received: number; inserted: number; updated: number; errors: number }> {
  const loc = getSetting("profile_location") || "remote";
  const stack = getSetting("profile_stack") || "software engineering";
  const tokens = stackTokens(stack);
  const companies = activeCompanies();
  const boards = companies.filter((c) => c.ats && c.slug);
  const pages = companies.filter((c) => c.kind !== "board" && !c.ats && c.careers_url);
  // aggregators: mined for OTHER employers' postings, so they need their own rules
  const jobBoards = companies.filter((c) => c.kind === "board" && c.careers_url);

  if (!companies.length) {
    L("error", "No companies tracked yet. Add some in Settings, or seed them from your ledger.");
    return { received: 0, inserted: 0, updated: 0, errors: 0 };
  }
  L("reasoning", `Reading ${boards.length} company board(s) straight from their ATS feeds — no agent, no tokens. ${pages.length} bespoke careers page(s) and ${jobBoards.length} job board(s) fall back to the agent.`);

  // --- deterministic pass -----------------------------------------------------
  let received = 0, errors = 0;
  const candidates: Candidate[] = [];
  await pooled(boards, BOARD_CONCURRENCY, async (c) => {
    if (signal.aborted) return;
    try {
      const posts = await fetchBoard(c.ats as any, c.slug!);
      received += posts.length;
      const keep = posts.filter((p) => remoteEligible(p) && looksRelevant(p, tokens)).slice(0, MAX_PER_COMPANY);
      markCompanyChecked(c.id, keep.length);
      for (const p of keep) candidates.push({ company: c, posting: p });
      L("step", `${c.name}: ${posts.length} open → ${keep.length} remote + relevant`);
    } catch (e: any) {
      errors++;
      markCompanyChecked(c.id, 0);
      L("error", `${c.name} (${c.ats}:${c.slug}) — ${String(e?.message || e).slice(0, 80)}`);
    }
  });

  L("result", `${received} open posting(s) across ${boards.length} board(s) → ${candidates.length} worth scoring.`);

  // --- judge, in batches ------------------------------------------------------
  const scored: any[] = [];
  const shortlist = candidates.slice(0, MAX_CANDIDATES);
  if (candidates.length > shortlist.length)
    L("note", `Scoring the first ${shortlist.length} of ${candidates.length} candidates this run; the rest will be picked up next time.`);
  for (let i = 0; i < shortlist.length && !signal.aborted; i += SCORE_BATCH) {
    try {
      scored.push(...(await scoreCandidates(shortlist.slice(i, i + SCORE_BATCH), loc, stack, L)));
    } catch (e: any) {
      errors++;
      L("error", `Scoring batch failed: ${String(e?.message || e).slice(0, 100)}`);
    }
  }

  // --- pages with no machine-readable feed, via the agent ----------------------
  const SHAPE = `Return ONLY a JSON array: [{"company","role","category":"high|medium|stretch","fit_score":0-100,"stack","eligibility","seniority","apply_url","source"}]`;

  async function agentPass(label: string, prompt: string): Promise<void> {
    try {
      const text = await invokeAgent(prompt, 10 * 60000, signal, L);
      const parsed = tryParseJson(text);
      const rows = Array.isArray(parsed) ? parsed : parsed?.jobs || [];
      if (!Array.isArray(rows) || !rows.length) return;
      received += rows.length;
      // the agent could have imagined these, so they go through link verification
      const { alive, dropped } = await verifyJobs(rows, { limit: 25, signal, onLog: (l) => L("step", l) });
      errors += dropped.length;
      scored.push(...alive.map((a) => a.job));
      L("result", `${label}: ${alive.length} verified, ${dropped.length} dropped.`);
    } catch (e: any) {
      errors++;
      L("error", `${label} pass failed: ${String(e?.message || e).slice(0, 100)}`);
    }
  }

  if (pages.length && !signal.aborted) {
    L("step", `Asking the agent to read ${pages.length} careers page(s) with no machine-readable feed…`);
    const list = pages.map((c) => `- ${c.name}: ${c.careers_url}`).join("\n");
    await agentPass(
      "Careers pages",
      `Open each careers page below and list the currently-open REMOTE software roles a candidate based in ${loc} could work, matching: ${stack}.\n\n${list}\n\n` +
        `Open every page. Follow through to each individual role's own posting URL — never return the careers index itself. Skip a company rather than guessing.\n\n${SHAPE}`
    );
  }

  // A board lists OTHER companies' jobs. Returning the board's own link is the exact
  // failure that filled the ledger with jobot.com and remotive.com entries, so the
  // employer's page is the only acceptable apply_url here.
  if (jobBoards.length && !signal.aborted) {
    L("step", `Mining ${jobBoards.length} job board(s) for employer postings…`);
    const hosts = jobBoards
      .map((c) => { try { return new URL(c.careers_url!).hostname.replace(/^www\./, ""); } catch { return c.name; } })
      .join(", ");
    // A board's note is where per-site rules live — most usefully what its robots.txt
    // disallows. Without passing it through, the agent has no way to know that e.g.
    // Dice permits /jobs and /job-detail but not /jobs?q= search URLs.
    const list = jobBoards
      .map((c) => `- ${c.name}: ${c.careers_url}${c.note ? `\n    RULES FOR THIS BOARD (obey exactly): ${c.note}` : ""}`)
      .join("\n");
    await agentPass(
      "Job boards",
      `These are job BOARDS that aggregate other companies' openings. They are NOT employers.\n\n${list}\n\n` +
        `Search each board for currently-open REMOTE software roles a candidate based in ${loc} could work, matching: ${stack}.\n\n` +
        `A board listing is not an application. For every role: open its listing, find the apply link, and FOLLOW IT THROUGH to the employer's own posting (their ATS — Greenhouse, Lever, Ashby, Workable — or their careers site). Confirm that page is live and still open.\n` +
        `- "company" is the actual EMPLOYER, never the board's name.\n` +
        `- "apply_url" is the employer's URL. Never return a link on ${hosts}.\n` +
        `- "source" is the board you found it on.\n` +
        `- If you cannot reach a live employer posting, SKIP the role. A board link is worthless here.\n` +
        `- Where a board lists RULES, follow them exactly. They usually reflect what that site's robots.txt permits, so ignoring them is not a shortcut worth taking.\n\n${SHAPE}`
    );
  }

  if (!scored.length) {
    L("note", "Nothing new cleared the bar this run.");
    return { received, inserted: 0, updated: 0, errors };
  }
  const res = upsertJobs(scored);
  for (const e of res.errors.slice(0, 5)) L("error", `Rejected ${e.job}: ${e.error}`);
  if (res.blocked) L("note", `${res.blocked} posting(s) skipped — you trashed them before.`);
  L("result", `Saved ${res.inserted} new, ${res.updated} refreshed from company career pages.`);
  return { received, inserted: res.inserted, updated: res.updated, errors: errors + res.errors.length };
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

    if (type === "careers") {
      const r = await runCareersCrawl(ac.signal, L);
      totals.received += r.received;
      totals.inserted += r.inserted;
      totals.updated += r.updated;
      totals.errors += r.errors;
      setMeta("last_careers_crawl", now);
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
