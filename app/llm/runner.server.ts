// The LLM Runner: one entry point for all AI work. Resolves a runner, runs it,
// computes cost, logs to llm_calls, and enforces the monthly budget.
import { getDb, getSetting } from "../sqlite.server";
import { ADAPTERS, adapterById } from "./adapters.server";
import { costFor, estimateTokens } from "./pricing.server";
import type { RunRequest, RunResult, RunnerInfo, Usage } from "./types";

export async function listRunners(): Promise<RunnerInfo[]> {
  return Promise.all(ADAPTERS.map((a) => a.info()));
}

export async function availableRunners(): Promise<RunnerInfo[]> {
  return (await listRunners()).filter((r) => r.available);
}

export async function defaultRunnerId(): Promise<string | null> {
  const set = getSetting("default_runner");
  if (set && (await adapterById(set)?.info())?.available) return set;
  // auto-pick: prefer claude-cli, then any available
  const avail = await availableRunners();
  if (!avail.length) return null;
  return avail.find((r) => r.id === "claude-cli")?.id ?? avail[0].id;
}

function modelFor(runnerId: string, info: RunnerInfo, override?: string): string {
  return (
    override ||
    getSetting(`model_${runnerId}`) ||
    info.defaultModel ||
    "default"
  );
}

export function monthlySpend(): number {
  const ym = new Date().toISOString().slice(0, 7); // YYYY-MM
  const row = getDb()
    .prepare("SELECT COALESCE(SUM(cost_usd),0) s FROM llm_calls WHERE substr(ts,1,7)=? AND metered=1")
    .get(ym) as { s: number };
  return row.s || 0;
}

export function budgetCap(): number {
  return Number(getSetting("budget_monthly_usd") || "0") || 0;
}

export function budgetState(): { cap: number; spent: number; over: boolean; near: boolean } {
  const cap = budgetCap();
  const spent = monthlySpend();
  return {
    cap,
    spent,
    over: cap > 0 && spent >= cap,
    near: cap > 0 && spent >= cap * 0.8,
  };
}

function logCall(row: {
  runner: string;
  model: string;
  purpose: string;
  jobId?: string;
  usage: Usage;
  durationMs: number;
  status: string;
  error?: string;
}): number {
  const info = getDb()
    .prepare(
      `INSERT INTO llm_calls (ts,runner,model,purpose,job_id,in_tok,out_tok,cached_tok,cost_usd,metered,duration_ms,status,error)
       VALUES (@ts,@runner,@model,@purpose,@job_id,@in_tok,@out_tok,@cached_tok,@cost_usd,@metered,@duration_ms,@status,@error)`
    )
    .run({
      ts: new Date().toISOString(),
      runner: row.runner,
      model: row.model,
      purpose: row.purpose,
      job_id: row.jobId ?? null,
      in_tok: row.usage.inTok,
      out_tok: row.usage.outTok,
      cached_tok: row.usage.cachedTok,
      cost_usd: row.usage.costUsd,
      metered: row.usage.metered ? 1 : 0,
      duration_ms: row.durationMs,
      status: row.status,
      error: row.error ?? null,
    });
  return Number(info.lastInsertRowid);
}

async function runOne(req: RunRequest, runnerId: string): Promise<RunResult> {
  const adapter = adapterById(runnerId);
  if (!adapter) throw new Error(`unknown runner ${runnerId}`);
  const info = await adapter.info();
  if (!info.available) throw new Error(`${info.label} is not available`);
  const model = modelFor(runnerId, info, req.model);

  // budget gate (metered providers only)
  if (info.kind === "api" && info.provider !== "ollama") {
    const b = budgetState();
    if (b.over)
      throw new Error(
        `Monthly budget reached ($${b.spent.toFixed(2)} / $${b.cap.toFixed(2)}). Raise it in Settings.`
      );
  }

  const t0 = Date.now();
  try {
    const r = await adapter.run(req, model);
    const durationMs = Date.now() - t0;

    const inTok = r.usage.inTok ?? estimateTokens((req.system ?? "") + req.prompt);
    const outTok = r.usage.outTok ?? estimateTokens(r.text);
    const cachedTok = r.usage.cachedTok ?? 0;
    const metered = r.usage.metered ?? info.kind === "api";
    let costUsd = r.usage.costUsd ?? 0;
    if (!costUsd && metered) {
      costUsd = costFor(info.provider, r.model || model, inTok, outTok, cachedTok) ?? 0;
    }
    const usage: Usage = { inTok, outTok, cachedTok, costUsd, metered };

    const callId = logCall({
      runner: runnerId,
      model: r.model || model,
      purpose: req.purpose,
      jobId: req.jobId,
      usage,
      durationMs,
      status: "ok",
    });

    let json: any;
    if (req.json) json = tryParseJson(r.text);
    return { text: r.text, json, usage, runner: runnerId, model: r.model || model, durationMs, callId };
  } catch (e: any) {
    logCall({
      runner: runnerId,
      model,
      purpose: req.purpose,
      jobId: req.jobId,
      usage: { inTok: 0, outTok: 0, cachedTok: 0, costUsd: 0, metered: info.kind === "api" },
      durationMs: Date.now() - t0,
      status: "error",
      error: String(e?.message || e),
    });
    throw e;
  }
}

// main entry: run with the chosen/default runner, falling back if it errors
export async function runLLM(req: RunRequest): Promise<RunResult> {
  const primary = req.runnerId || (await defaultRunnerId());
  if (!primary)
    throw new Error("No LLM runner available. Add an API key or install a CLI in Settings.");
  try {
    return await runOne(req, primary);
  } catch (e) {
    const fb = getSetting("fallback_runner");
    if (fb && fb !== primary && (await adapterById(fb)?.info())?.available) {
      return runOne(req, fb);
    }
    throw e;
  }
}

export function tryParseJson(text: string): any {
  let t = (text || "").trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  if (!t.startsWith("[") && !t.startsWith("{")) {
    const a = t.indexOf("["),
      o = t.indexOf("{");
    const start = a === -1 ? o : o === -1 ? a : Math.min(a, o);
    if (start > 0) t = t.slice(start);
    const end = Math.max(t.lastIndexOf("]"), t.lastIndexOf("}"));
    if (end !== -1) t = t.slice(0, end + 1);
  }
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

// --- usage reporting -------------------------------------------------------

export interface UsageSummary {
  totalCost: number;
  monthCost: number;
  totalCalls: number;
  totalInTok: number;
  totalOutTok: number;
  byPurpose: { purpose: string; calls: number; cost: number; inTok: number; outTok: number }[];
  byRunner: { runner: string; calls: number; cost: number }[];
  byDay: { day: string; cost: number; calls: number }[];
  recent: any[];
  budget: { cap: number; spent: number; over: boolean; near: boolean };
}

export function usageSummary(): UsageSummary {
  const db = getDb();
  const tot = db
    .prepare(
      "SELECT COALESCE(SUM(cost_usd),0) c, COUNT(*) n, COALESCE(SUM(in_tok),0) i, COALESCE(SUM(out_tok),0) o FROM llm_calls"
    )
    .get() as any;
  const ym = new Date().toISOString().slice(0, 7);
  const month = db
    .prepare("SELECT COALESCE(SUM(cost_usd),0) c FROM llm_calls WHERE substr(ts,1,7)=?")
    .get(ym) as any;
  return {
    totalCost: tot.c,
    monthCost: month.c,
    totalCalls: tot.n,
    totalInTok: tot.i,
    totalOutTok: tot.o,
    byPurpose: db
      .prepare(
        "SELECT purpose, COUNT(*) calls, COALESCE(SUM(cost_usd),0) cost, COALESCE(SUM(in_tok),0) inTok, COALESCE(SUM(out_tok),0) outTok FROM llm_calls GROUP BY purpose ORDER BY cost DESC"
      )
      .all() as any,
    byRunner: db
      .prepare(
        "SELECT runner, COUNT(*) calls, COALESCE(SUM(cost_usd),0) cost FROM llm_calls GROUP BY runner ORDER BY calls DESC"
      )
      .all() as any,
    byDay: db
      .prepare(
        "SELECT substr(ts,1,10) day, COALESCE(SUM(cost_usd),0) cost, COUNT(*) calls FROM llm_calls GROUP BY day ORDER BY day DESC LIMIT 30"
      )
      .all() as any,
    recent: db
      .prepare(
        "SELECT ts,runner,model,purpose,job_id,in_tok,out_tok,cost_usd,metered,duration_ms,status,error FROM llm_calls ORDER BY id DESC LIMIT 40"
      )
      .all() as any,
    budget: budgetState(),
  };
}

// Record a call that was executed outside runOne (e.g. the streaming crawl) so it
// still shows up on the Usage page.
export function logExternalCall(o: {
  runner: string; model: string; purpose: string; jobId?: string;
  usage: Usage; durationMs: number;
}): void {
  logCall({ runner: o.runner, model: o.model, purpose: o.purpose, jobId: o.jobId, usage: o.usage, durationMs: o.durationMs, status: "ok" });
}
