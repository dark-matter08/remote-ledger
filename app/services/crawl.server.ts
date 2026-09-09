// Job crawls, fully logged to the Crawl Shell. Three types:
//   find   — ask the runner to research fresh roles, upsert, scrape new JDs
//   update — re-scrape JDs for existing active jobs (refresh)
//   full   — find then update
// Works best with a CLI runner that has web access (e.g. Claude Code).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defaultRunnerId, logExternalCall, runLLM, runLLMWithTools, runnerCanSearchWeb, runnerCanUseTools, tryParseJson } from "../llm/runner.server";
import { streamClaude, adapterById, isPermanentModelError } from "../llm/adapters.server";
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
import { currentProfile, activeProfiles, getProfile, touchProfileCrawled, type Profile } from "../profiles.server";
import { WEB_TOOLS, executeTool, FetchLedger } from "../llm/tools.server";
import { searchAvailable } from "./search.server";
import { scrapeJds, verifyJobs, sanitizeJdHtml } from "./scrape.server";
import {
  activeCompanies,
  fetchBoard,
  markCompanyChecked,
  boardUrl,
  type AtsPosting,
  type Company,
} from "./ats.server";
import { fetchAllFeeds, type FeedPosting } from "./feeds.server";
import { webSearchAdvice } from "../llm/openrouter.server";
import { fieldById, fieldLabel, fieldNoun, inField, keywordHit, keywordTokens, type JobField } from "../fields";

export type CrawlType = "find" | "update" | "full" | "careers" | "feeds";

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
      tmpl = "Find remote roles in {{field}} for someone in {{location}} matching {{stack}}. Return a JSON array.";
    }
  }
  const loc = getSetting("profile_location") || "a remote-friendly location";
  const stack = getSetting("profile_stack") || "not stated";
  // The template used to say "remote software roles" outright; the field it actually
  // is now travels with the location and the keywords.
  const field = fieldNoun(getSetting("profile_field"));

  if (o.mode === "count") {
    const want = o.remaining ?? o.target ?? 5;
    const cap = Math.max(12, want * 6); // generous per-round safety cap on web actions
    const body = tmpl
      .replaceAll("{{location}}", loc)
      .replaceAll("{{field}}", field)
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
    .replaceAll("{{field}}", field)
    .replaceAll("{{stack}}", stack)
    .replaceAll("{{budget_min}}", String(timeoutMin))
    .replaceAll("{{max_actions}}", String(maxActions));
  const footer = `\n\n[RUNTIME BUDGET — STRICT] You have about ${timeoutMin} minute(s) and AT MOST ${maxActions} web actions (searches + fetches combined). You cannot perceive time, so COUNT your actions: the moment you reach ${maxActions}, stop searching and output the final JSON array. Ending your turn WITHOUT the JSON array is a complete failure — when unsure, output what you have now.`;
  return body + blocklistPrompt() + footer;
}

/**
 * The part of the search prompt the user's own answers write.
 *
 * Onboarding asks for a location and a stack, which on their own read like a form.
 * Showing the lines they become — the actual text an agent is about to be handed —
 * is the difference between filling a field and understanding what it does.
 */
export function targetPreview(): string {
  let tmpl = getSetting("search_prompt");
  if (!tmpl) {
    try {
      tmpl = readFileSync(resolve(process.cwd(), "scripts", "prompt.md"), "utf8");
    } catch {
      tmpl = "Find remote roles in {{field}} for someone in {{location}} matching {{stack}}.";
    }
  }
  const loc = getSetting("profile_location") || "(nowhere yet — fill in the box above)";
  const stack = getSetting("profile_stack") || "(nothing yet — fill in the box above)";
  const field = fieldNoun(getSetting("profile_field"));
  return tmpl
    .split("\n")
    .slice(0, 14)
    .join("\n")
    .replaceAll("{{location}}", loc)
    .replaceAll("{{field}}", field)
    .replaceAll("{{stack}}", stack)
    .trim();
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

// active run controllers so a Stop can actually kill the underlying agent process.
// This map is also the answer to "is a crawl running": a separate boolean drifted
// from it, and the drift is what made a stopped crawl go on blocking the next one.
const controllers = new Map<number, AbortController>();

export function abortCrawl(runId: number): boolean {
  const ac = controllers.get(runId);
  // Forgotten here, not when execute() finally unwinds. Aborting asks the agent to
  // stop; it can take a long time to agree — the hard stop is at twice the crawl
  // timeout — and for all of that time isCrawlRunning() went on reporting a crawl the
  // user had already stopped, so starting another was refused.
  controllers.delete(runId);
  if (ac) { ac.abort(); return true; }
  return false;
}

/**
 * One run searches for one profile.
 *
 * It used to search for all of them at once and divide the budget, which was the wrong
 * shape: a profile is a workspace with its own postings, résumés, mail and apply
 * history, so its crawl shell narrating another profile's search made no sense to read
 * and no sense to reason about. Each profile gets its own run, its own log, and its own
 * place in the schedule.
 *
 * That also returns the budget to what it was configured to be, per search, rather than
 * a fraction of it. Two profiles cost two crawls — which is the honest price of looking
 * for two things, and is now visibly two runs rather than one run doing half of each.
 */
async function executeOne(runId: number, type: CrawlType, only?: string): Promise<CrawlResult> {
  const profile = (only ? getProfile(only) : null) || currentProfile();
  touchProfileCrawled(profile.id);
  try {
    updateCrawlRun(runId, { profile_id: profile.id } as never);
  } catch {}
  return execute(runId, type, profile);
}

// public: synchronous (scheduler / CLI)
export async function runCrawl(type: CrawlType = "find", trigger = "cli", profileId?: string): Promise<CrawlResult> {
  const runId = createCrawlRun(type, trigger);
  return executeOne(runId, type, profileId);
}

// public: fire-and-forget (UI) — returns the run id immediately
export function startCrawl(type: CrawlType = "find", trigger = "manual", profileId?: string): number {
  const runId = createCrawlRun(type, trigger);
  void executeOne(runId, type, profileId).catch((e: any) => {
    try {
      crawlLog(runId, "error", String(e?.message || e));
      updateCrawlRun(runId, { status: "error", ended_at: new Date().toISOString() });
    } catch {}
  });
  return runId;
}

/**
 * Is a crawl running for this profile?
 *
 * Scoped, because profiles are separate searches on separate schedules: one crawling
 * must not grey out another's button. controllers is keyed by run, so it is asked about
 * this profile's run rather than any run at all.
 */
export function isCrawlRunning(profileId?: string): boolean {
  const scope = profileId ?? currentProfile().id;
  return !!activeCrawl(scope);
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

// A board that says remote:false is believed. Silence is not a no, so fall back to
// reading the location and title.
function remoteEligible(p: AtsPosting): boolean {
  if (p.remote === true) return true;
  if (p.remote === false) return false;
  return REMOTE_RE.test(`${p.location || ""} ${p.title}`);
}

/**
 * Which line of work this ledger is searching in, and the words to match on.
 *
 * Both come from the profile now. What was here before was a hardcoded engineering
 * regex that passed unconditionally, ahead of the user's own keywords — so on the
 * live boards a customer support specialist and a backend engineer got back the same
 * 35 postings, every one of them engineering, while seven real support roles in the
 * same pool were discarded. The profile was not being weighted lightly; outside
 * software it was not being read at all.
 */
function searchFor(profile?: Profile): { field: JobField | null; tokens: string[] } {
  const p = profile || currentProfile();
  return {
    field: fieldById(p.field),
    tokens: keywordTokens(p.stack || ""),
  };
}

/**
 * On the ATS path the net can be wide: the companies were chosen by the user, so a
 * keyword anywhere in the posting is a fair signal and the cost of a false positive
 * is one scoring slot on a board they asked to watch.
 */
function looksRelevant(p: AtsPosting, field: JobField | null, tokens: string[]): boolean {
  if (inField(field, p.title)) return true;
  const hay = `${p.title} ${p.description || ""}`.toLowerCase();
  return tokens.some((t) => hay.includes(t));
}

/**
 * On a public feed there is no such fence — the entire remote market arrives at once,
 * so a posting is judged by what it calls itself and by how its own board filed it.
 * Matching on the body out here lets "FedEx courier" through on the word "express" in
 * its own boilerplate and then spends a scoring slot on it.
 *
 * With neither a field nor a keyword there is nothing to filter ON, and quietly
 * keeping nothing would look like four dead boards. Everything goes through to the
 * scorer instead, which is the honest reading of an empty profile.
 */
function titleLooksRelevant(p: FeedPosting, field: JobField | null, tokens: string[]): boolean {
  if (!field && !tokens.length) return true;
  if (inField(field, p.title, p.categories)) return true;
  return keywordHit(`${p.title} · ${(p.categories || []).join(" · ")}`, tokens);
}

async function pooled<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

// What a scoring batch needs: a real posting, who is hiring, and where it was read
// from. Deliberately not a Company row — the same judgement serves a tracked
// employer's ATS feed and a job board's public feed, which has no row at all.
interface Candidate { companyName: string; source: string; posting: AtsPosting }

// Judge a batch of real postings. They are known to exist, so the model is only
// scoring fit — it is never asked for a URL and cannot invent one.
async function scoreCandidates(
  batch: Candidate[],
  loc: string,
  stack: string,
  field: string,
  L: (k: string, t: string) => void
): Promise<any[]> {
  const listing = batch
    .map((c, i) =>
      `${i}. ${c.companyName} — ${c.posting.title}\n   location: ${c.posting.location || "unstated"}\n   ${(c.posting.description || "").slice(0, 600)}`
    )
    .join("\n\n");

  const r = await runLLM({
    purpose: "job-research",
    json: true,
    temperature: 0.2,
    maxTokens: 3000,
    system:
      "You score real, already-verified job postings against one candidate. Every posting below exists and its link is known good, so never invent, alter or return a URL. Judge fit only, and be honest: a bad match scored highly wastes the candidate's time.",
    // "DROP anything that is not a software engineering role" used to be hardcoded
    // here, which deleted every posting a non-engineer was actually looking for —
    // the few support roles that got past the filter were then removed by the scorer
    // itself. The line the candidate works in comes from their profile now.
    prompt:
      `CANDIDATE\n- Based in: ${loc}. Needs roles workable remotely from there.\n` +
      `- Line of work: ${field}\n- Skills and keywords: ${stack}\n\nPOSTINGS\n${listing}\n\n` +
      `For each posting return an entry. DROP anything that is not a ${field} the candidate could do, ` +
      `or that cannot be worked remotely from their location.\n` +
      `Return ONLY JSON: { "jobs": [ { "i": 0, "category": "high|medium|stretch", "fit_score": 0-100, ` +
      `"stack": "the short fine-print that matters for THIS role — tools, systems, languages spoken, ` +
      `shift, certifications; e.g. 'TS · Node · Postgres' for engineering, 'Zendesk · Tier 2 · EMEA hours' ` +
      `for support", "eligibility": "short note e.g. 'Open worldwide'", "seniority": "Mid|Senior|Contract|Varies" } ] }\n` +
      `Omit an entry entirely to drop that posting. "high" means a strong match on their skills AND clearly eligible from ${loc}.`,
  });

  const parsed = (r.json?.jobs || []) as any[];
  const out: any[] = [];
  for (const row of parsed) {
    const c = batch[Number(row?.i)];
    if (!c) continue;
    out.push({
      company: c.companyName,
      role: c.posting.title,
      category: String(row.category || "medium").toLowerCase(),
      fit_score: Number(row.fit_score) || 0,
      stack: row.stack || null,
      eligibility: row.eligibility || null,
      seniority: row.seniority || null,
      apply_url: c.posting.url,
      source: c.source,
      // The feed already handed us the posting in full. Dropping it here is what sent
      // every ATS job to the ledger blank, to be re-fetched later with a headless
      // browser — a second download of text we were already holding.
      jd: c.posting.description,
      jd_html: c.posting.descriptionHtml,
    });
  }
  L("step", `Scored ${batch.length} posting(s) → kept ${out.length}.`);
  return out;
}

// Discovery with no browsing model in the loop. The boards publish what they have;
// we filter to remote + relevant here, and the model is left with the only job it
// can honestly do without the web — judging fit against the candidate. Nothing in
// this path can invent a posting, because nothing in it is asked to write a URL.
async function findViaFeeds(
  loc: string,
  stack: string,
  signal: AbortSignal,
  L: (kind: string, text: string) => void,
  profile: Profile = currentProfile()
): Promise<{ jobs: any[]; received: number; errors: number }> {
  const { field, tokens } = searchFor(profile);
  const fieldWords = fieldLabel(field?.id);
  let errors = 0;
  L("step", field
    ? `Looking for ${field.label.toLowerCase()} roles${tokens.length ? `, weighted to: ${tokens.slice(0, 6).join(", ")}` : ""}.`
    : "No field set in your profile, so every posting goes to the scorer. Settings → Profile narrows this a lot.");
  // ask each board for this field where it can answer that; the broad feed otherwise
  const sweep = await fetchAllFeeds(signal, field);
  for (const f of sweep.perFeed) L("step", `${f.name}: ${f.count} posting(s).`);
  for (const e of sweep.errors) {
    errors++;
    L("error", `${e.name} unavailable — ${e.error}`);
  }
  if (!sweep.postings.length) {
    L("error", "Every feed came back empty — nothing to score this run.");
    return { jobs: [], received: 0, errors };
  }

  const keep = sweep.postings.filter((p) => remoteEligible(p) && titleLooksRelevant(p, field, tokens));
  L("result", `${sweep.postings.length} posting(s) across ${sweep.perFeed.length} feed(s) → ${keep.length} remote + relevant.`);
  const shortlist: Candidate[] = keep
    .slice(0, MAX_CANDIDATES)
    .map((p) => ({ companyName: p.company, source: p.source, posting: p }));
  if (keep.length > shortlist.length)
    L("note", `Scoring the first ${shortlist.length} of ${keep.length} this run; the rest come round next time.`);

  const jobs: any[] = [];
  for (let i = 0; i < shortlist.length && !signal.aborted; i += SCORE_BATCH) {
    try {
      jobs.push(...(await scoreCandidates(shortlist.slice(i, i + SCORE_BATCH), loc, stack, fieldWords, L)));
    } catch (e: any) {
      errors++;
      const why = String(e?.message || e);
      // a model the runner cannot load will not load for the next batch either
      if (isPermanentModelError(why)) {
        L("error", why.slice(0, 400));
        L("note", `Stopping here — the remaining ${Math.max(0, shortlist.length - i - SCORE_BATCH)} posting(s) would fail the same way. The boards were read fine; only the scoring needs a working model.`);
        break;
      }
      L("error", `Scoring batch failed: ${why.slice(0, 200)}`);
    }
  }
  return { jobs, received: sweep.postings.length, errors };
}

/** A board's hostname, which is often what the agent writes in `source`. */
export function sourceHost(url: string | null): string | null {
  try {
    return new URL(url || "").hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Which tracked source a returned posting came from.
 *
 * The agent reads a batch of boards in one prompt and answers with one flat array, so
 * the only attribution available is the `source` the prompt asks it to fill in — the
 * agent's word, not a measurement. Matched against the board's name and its hostname,
 * and left uncredited when neither matches: a posting credited to no board is a count
 * that reads low, while one credited to the wrong board is a count that lies.
 *
 * The date beside it does not depend on any of this. That a source was read is a fact
 * about the run; how much came back through it is an estimate.
 */
export function creditSource(
  covered: { id: number; name: string; careers_url: string | null }[],
  job: any,
  into: Map<number, number>
): void {
  const src = String(job?.source || "").toLowerCase().trim();
  if (!src) return;
  for (const c of covered) {
    const host = sourceHost(c.careers_url);
    const name = c.name.toLowerCase();
    if ((name.length > 2 && src.includes(name)) || (host && src.includes(host))) {
      into.set(c.id, (into.get(c.id) || 0) + 1);
      return; // one posting, one board — first match wins rather than double-counting
    }
  }
}

async function runCareersCrawl(
  signal: AbortSignal,
  L: (kind: string, text: string) => void,
  profile: Profile = currentProfile()
): Promise<{ received: number; inserted: number; updated: number; errors: number }> {
  const loc = profile.location || "remote";
  const stack = profile.stack || "software engineering";
  const { field, tokens } = searchFor(profile);
  const fieldWords = fieldLabel(field?.id);
  const companies = activeCompanies(profile.id);
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
      const keep = posts.filter((p) => remoteEligible(p) && looksRelevant(p, field, tokens)).slice(0, MAX_PER_COMPANY);
      markCompanyChecked(c.id, keep.length);
      for (const p of keep)
        candidates.push({ companyName: c.name, source: c.ats ? `${c.name} (${c.ats})` : c.name, posting: p });
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
      scored.push(...(await scoreCandidates(shortlist.slice(i, i + SCORE_BATCH), loc, stack, fieldWords, L)));
    } catch (e: any) {
      errors++;
      const why = String(e?.message || e);
      if (isPermanentModelError(why)) {
        L("error", why.slice(0, 400));
        L("note", "Stopping here — every remaining batch would fail the same way.");
        break;
      }
      L("error", `Scoring batch failed: ${why.slice(0, 200)}`);
    }
  }

  // --- pages with no machine-readable feed, via the agent ----------------------
  const SHAPE = `Return ONLY a JSON array: [{"company","role","category":"high|medium|stretch","fit_score":0-100,"stack","eligibility","seniority","apply_url","source"}]`;

  /**
   * Read a batch of sources the agent has to visit itself, and record that it did.
   *
   * The recording is the point of `covered`. Only the ATS pass above used to mark a
   * source checked, so every job board in the registry read "never checked" while the
   * log two lines down said it had been mined — and one of them was the recorded
   * source of jobs sitting in the ledger. The column was wired to one of the three
   * ways a source gets read.
   *
   * It marks in a `finally`: a pass that failed, or came back empty, still looked.
   * "Checked, found nothing" and "never looked at" are different facts and the
   * registry should be able to tell them apart.
   */
  async function agentPass(label: string, prompt: string, covered: Company[]): Promise<void> {
    const credited = new Map<number, number>();
    try {
      const text = await invokeAgent(prompt, 10 * 60000, signal, L);
      const parsed = tryParseJson(text);
      const rows = Array.isArray(parsed) ? parsed : parsed?.jobs || [];
      if (!Array.isArray(rows) || !rows.length) return;
      received += rows.length;
      // the agent could have imagined these, so they go through link verification
      const { alive, dropped } = await verifyJobs(rows, { limit: 25, signal, onLog: (l) => L("step", l) });
      errors += dropped.length;
      for (const a of alive) creditSource(covered, a.job, credited);
      // verification already opened the page and read it; carry that through
      scored.push(...alive.map((a) => ({ ...a.job, jd: a.jd, jd_html: a.jdHtml })));
      L("result", `${label}: ${alive.length} verified, ${dropped.length} dropped.`);
    } catch (e: any) {
      errors++;
      L("error", `${label} pass failed: ${String(e?.message || e).slice(0, 100)}`);
    } finally {
      for (const c of covered) markCompanyChecked(c.id, credited.get(c.id) || 0);
    }
  }

  if (pages.length && !signal.aborted) {
    L("step", `Asking the agent to read ${pages.length} careers page(s) with no machine-readable feed…`);
    const list = pages.map((c) => `- ${c.name}: ${c.careers_url}`).join("\n");
    await agentPass(
      "Careers pages",
      `Open each careers page below and list the currently-open REMOTE software roles a candidate based in ${loc} could work, matching: ${stack}.\n\n${list}\n\n` +
        `Open every page. Follow through to each individual role's own posting URL — never return the careers index itself. Skip a company rather than guessing.\n\n${SHAPE}`,
      pages
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
        `- Where a board lists RULES, follow them exactly. They usually reflect what that site's robots.txt permits, so ignoring them is not a shortcut worth taking.\n\n${SHAPE}`,
      jobBoards
    );
  }

  if (!scored.length) {
    L("note", "Nothing new cleared the bar this run.");
    return { received, inserted: 0, updated: 0, errors };
  }
  const res = upsertJobs(scored, undefined, profile.id);
  for (const e of res.errors.slice(0, 5)) L("error", `Rejected ${e.job}: ${e.error}`);
  if (res.blocked) L("note", `${res.blocked} posting(s) skipped — you trashed them before.`);

  // upsertJobs ignores fields it does not know, so the description rides along on the
  // same row and is written here rather than left for a later scrape to go and find.
  let saved = 0;
  for (const j of scored) {
    if (!j.jd && !j.jd_html) continue;
    try {
      setJd(jobId(j.company, j.role), j.jd || "", j.jd_html ? sanitizeJdHtml(j.jd_html) : null);
      saved++;
    } catch {}
  }
  L("result", `Saved ${res.inserted} new, ${res.updated} refreshed from company career pages · ${saved} description(s) captured.`);
  return { received, inserted: res.inserted, updated: res.updated, errors: errors + res.errors.length };
}

/**
 * Put the runner and model on the run itself. Without it "found nothing" and "found
 * nine things that were not real" are the same row in the history, and the one
 * question worth asking of a bad run — what answered? — needs a join against
 * llm_calls on a time window to answer.
 */
async function recordRunner(runId: number): Promise<void> {
  try {
    const runner = await defaultRunnerId();
    if (!runner) return;
    const model = getSetting(`model_${runner}`) || (await adapterById(runner)?.info())?.defaultModel || null;
    updateCrawlRun(runId, { runner, model });
  } catch {
    // a run is not worth failing over its own bookkeeping
  }
}

// Where real postings actually live. A general web search for a job title returns
// aggregators, CV databases and blog posts; scoping to the boards that host postings
// is the difference between reading a job and reading an article about jobs.
const ATS_SITES = [
  "jobs.ashbyhq.com",
  "job-boards.greenhouse.io",
  "jobs.lever.co",
  "apply.workable.com",
  "jobs.workable.com",
  "boards.greenhouse.io",
];

/** A model handed a whole stack string searches for all of it at once and finds nothing. */
export function shortStack(stack: string): string {
  return stack
    .split(/[,/|]|\band\b/i)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(" ") || "engineer";
}

/**
 * Whatever the model returned, as a list of postings.
 *
 * Asked for an array it will hand back a single object when it found one role, or
 * wrap the array in {jobs: …} — and a 7B model does this often. Insisting on a bare
 * array threw away a posting it had genuinely opened and described correctly, which
 * looked exactly like the model failing when it was the parser being strict.
 */
export function asJobList(raw: any): any[] {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== "object") return [];
  for (const k of ["jobs", "roles", "results", "postings", "items", "data"]) {
    if (Array.isArray(raw[k])) return raw[k];
  }
  // one posting, returned unwrapped
  if (raw.apply_url || raw.company || raw.role) return [raw];
  return [];
}

/**
 * Research with tools, for a runner that cannot browse but can call functions.
 *
 * The model never touches the network. It asks for a search or a page, we perform it,
 * and it reasons over text we hold — so unlike a plain chat completion asked to
 * "search the job boards", every claim it makes can be checked against something that
 * was actually downloaded.
 *
 * And it is checked. A posting is kept only if its apply_url is one the tools really
 * fetched this run. That is the whole reason this is allowed to feed the crawl: a
 * model that names a role it never opened gets dropped, not saved.
 */
async function researchWithTools(
  loc: string,
  stack: string,
  want: number,
  signal: AbortSignal,
  L: (kind: string, text: string) => void
): Promise<{ jobs: any[]; fetched: number; unbacked: number }> {
  const ledger = new FetchLedger();
  const SHAPE = `Return ONLY a JSON array: [{"company","role","category":"high|medium|stretch","fit_score":0-100,"stack","eligibility","seniority","apply_url","source"}]`;

  L("reasoning", "The runner cannot browse, so it is being given search and fetch as tools — the app does the retrieving and it only ever reads pages we downloaded.");

  const res = await runLLMWithTools(
    {
      purpose: "job-research",
      system:
        "You find real, currently-open job postings. You cannot browse: call search_web to find pages and " +
        "fetch_url to read them. Never describe a posting you have not fetched. A search or listing page is " +
        "not a posting — follow through to the employer's own posting URL and fetch that.\n\n" +
        "How to search well:\n" +
        "- Postings live on applicant tracking systems. Scope your searches to them with site: — " +
        ATS_SITES.map((d) => `site:${d}`).join(", ") + ".\n" +
        "- Keep queries SHORT: a site: operator plus three or four words. Long queries match nothing.\n" +
        "- One idea per search. Run several narrow searches rather than one that lists every technology.\n" +
        "- A result whose URL has no job id is a listing page. Skip it rather than reading it.",
      prompt:
        `Find up to ${want} currently-open REMOTE software roles someone based in ${loc} could take, matching: ${stack}.\n\n` +
        `Start with searches shaped like:\n` +
        ATS_SITES.slice(0, 3).map((d) => `  site:${d} ${shortStack(stack)} remote`).join("\n") +
        `\n\nThen open each candidate posting and confirm from the page itself that it is real and still open. ` +
        `apply_url must be the exact URL you fetched.\n\n${SHAPE}`,
      json: true,
      maxTokens: 2500,
    },
    {
      tools: WEB_TOOLS,
      maxSteps: 8,
      execute: (c) => executeTool(c, { ledger, maxFetches: 12, onLog: L }),
      onLog: L,
    }
  );

  const list = asJobList(res.json ?? tryParseJson(res.text));
  const jobs: any[] = [];
  let unbacked = 0;
  for (const j of list) {
    const url = String(j?.apply_url || "").trim();
    if (url && ledger.has(url)) jobs.push({ ...j, apply_url: url, source: j.source || "web search" });
    else unbacked++;
  }

  L(
    "result",
    `Read ${ledger.size} page(s) over ${res.steps} turn(s). ${jobs.length} role(s) backed by a page we fetched` +
      (unbacked ? `, ${unbacked} dropped for naming a page it never opened.` : ".")
  );
  // Nothing kept and nothing dropped means it never produced a usable list at all,
  // which is a different failure from inventing one — and invisible without this.
  if (!jobs.length && !unbacked) {
    L("note", `It read pages but returned no list. Its answer began: ${String(res.text || "(empty)").replace(/\s+/g, " ").slice(0, 240)}`);
    if (ledger.size) L("note", `Pages it opened: ${ledger.urls().slice(0, 4).join(", ")}`);
  }
  return { jobs, fetched: ledger.size, unbacked };
}


async function execute(
  runId: number,
  type: CrawlType,
  profile: Profile = currentProfile(),
): Promise<CrawlResult> {
  const L = (kind: string, text: string) => crawlLog(runId, kind, text);
  const now = new Date().toISOString();
  const ac = new AbortController();
  controllers.set(runId, ac);
  const totals = { received: 0, inserted: 0, updated: 0, scraped: 0, errors: 0 };
  try {
    L("note", `Crawl started · type=${type}`);
    await recordRunner(runId);

    if (type === "find" || type === "full" || type === "feeds") {
      const loc = profile.location || "remote";
      const stack = profile.stack || "software";
      const mode = (getSetting("crawl_mode") || "time") as "time" | "count";

      // verified-open roles collected this run, keyed by company--role (dedup across rounds)
      const collected = new Map<string, { job: any; jd: string; jdHtml: string }>();
      const keyOf = (j: any) => jobId(j.company, j.role);

      // A runner that cannot browse is not a reason to stop. It is a reason to take
      // the postings from somewhere the app fetches itself — which is the better
      // source anyway: the boards are exact, and nothing in them is imagined. The old
      // behaviour refused the run and told you to go and pick another mode by hand,
      // which is a worse version of doing it for you.
      // Two different ways to research the live web, and the message has to tell them
      // apart. canSearch asks whether the PROVIDER browses for itself. canTools asks
      // whether we can browse on its behalf — we hold the results, so what comes back
      // is checkable, which the provider's own browsing is not.
      const canSearch = await runnerCanSearchWeb();
      const canTools = !canSearch && (await runnerCanUseTools()) && (await searchAvailable()).ok;
      if (type === "feeds" || !canSearch) {
        if (!canSearch && type !== "feeds") {
          const runner = (await defaultRunnerId()) || "(none)";
          if (canTools) {
            L("note", `${runner} cannot browse by itself, so the app searches and fetches for it — every page it reads is one we retrieved.`);
            L("note", "Reading the free job boards first, then researching for roles they do not carry.");
          } else {
            L("note", `${runner} cannot reach the live web, so there is nothing to research — reading the free job boards instead, where every posting is real.`);
            if (runner === "openrouter-api") for (const line of await webSearchAdvice()) L("note", line);
            else L("note", "An agent CLI can browse for itself. A plain API runner needs a search backend — set one up in Settings → Search and it can research too.");
          }
        }
        L("reasoning", "Reading the free public job boards — keyless, exact, and nothing in them is imagined. No agent is asked to find anything.");
        const fed = await findViaFeeds(loc, stack, ac.signal, L, profile);
        totals.received += fed.received;
        totals.errors += fed.errors;
        if (fed.jobs.length) {
          L("result", `${fed.jobs.length} role(s) worth keeping — following each through to the employer's own posting…`);
          // keepOnBoard only here. These came out of a board's own API with their
          // descriptions attached, so they cannot be imagined — unlike an agent's
          // links, which must be walked through to an employer or dropped.
          const { alive, dropped } = await verifyJobs(fed.jobs, { limit: 40, keepOnBoard: true, signal: ac.signal, onLog: (line) => L("step", line) });
          L("result", `Verified ${alive.length} live · dropped ${dropped.length} (dead link, closed, or never left the board).`);
          totals.errors += dropped.length;
          for (const a of alive) collected.set(keyOf(a.job), a);
        }
          // The boards are the reliable base. If the runner can also use tools and a
          // search backend is configured, top up with roles the boards do not carry.
          if (type !== "feeds" && canTools) {
            try {
              const want = Math.max(1, Math.min(10, Number(getSetting("crawl_target_count") || "5") || 5));
              const r = await researchWithTools(loc, stack, want, ac.signal, L);
              if (r.jobs.length) {
                const v = await verifyJobs(r.jobs, { limit: 20, signal: ac.signal, onLog: (line) => L("step", line) });
                L("result", `Verified ${v.alive.length} live · dropped ${v.dropped.length}.`);
                totals.errors += v.dropped.length;
                for (const a of v.alive) collected.set(keyOf(a.job), a);
              }
            } catch (e: any) {
              // research is a bonus pass; the boards already ran and must still be saved
              L("error", `Tool-assisted research failed: ${String(e?.message || e).slice(0, 200)}`);
            }
          }
      } else if (mode === "count") {
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
        const configured = Number(getSetting("crawl_timeout_min") || "15") || 15;
        const timeoutMin = configured;
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
        if (type !== "full") {
          updateCrawlRun(runId, { status: "error", ended_at: new Date().toISOString(), note: "no verified jobs", ...totals });
          return { ok: false, runId, ...totals, message: "no verified jobs" };
        }
      } else if (aliveJobs.length) {
        const res = upsertJobs(aliveJobs, now, profile.id);
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
      const r = await runCareersCrawl(ac.signal, L, profile);
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

    // Every stage breaks out of its loops on the abort signal rather than throwing, so
    // a stopped crawl arrives here just like a finished one — and reported "done",
    // overwriting the "stopped by user" the Stop button had already written.
    if (ac.signal.aborted) {
      L("note", "Crawl stopped.");
      updateCrawlRun(runId, { status: "error", ended_at: new Date().toISOString(), note: "stopped by user", ...totals });
      return { ok: false, runId, ...totals, message: "stopped by user" };
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
    controllers.delete(runId);
  }
}
