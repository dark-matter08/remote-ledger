// OpenRouter model catalog — the free tier of the Ledger.
//
// OpenRouter fronts every major lab behind one OpenAI-compatible endpoint, and a
// slice of that catalogue costs nothing to call. That matters here: the whole app
// assumes you can afford *some* model, and for a lot of people job-hunting, that is
// exactly the assumption that breaks. A free OpenRouter key makes the Ledger work
// end to end — crawl, tailor, cover letter, prep — for $0.
//
// The models list is a PUBLIC endpoint (no key), so we can show the full catalogue
// before the user has signed up for anything. It is cached on disk so the picker
// stays instant and keeps working offline.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DB_PATH, getSetting } from "../sqlite.server";

export const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const CATALOG_URL = `${OPENROUTER_BASE}/models`;
const CACHE_PATH = resolve(dirname(DB_PATH), "openrouter-models.json");
const TTL_MS = 6 * 60 * 60 * 1000; // 6h — the catalogue moves, but not by the minute
const RETRY_MS = 60 * 1000; // how long a failed refresh is held before trying again

// --- shape -----------------------------------------------------------------

// Price band. `free` is the point of this module; the rest exist so someone who
// *can* pay a little still gets a sane, sorted list instead of 400 raw ids.
export type Tier = "free" | "router" | "budget" | "standard" | "premium";

export const TIERS: { id: Tier; label: string; blurb: string }[] = [
  { id: "free", label: "Free", blurb: "$0 per token. Rate-limited, but genuinely free." },
  { id: "router", label: "Routers", blurb: "OpenRouter picks the model per request; price varies." },
  { id: "budget", label: "Budget", blurb: "Under $0.50 per million input tokens." },
  { id: "standard", label: "Standard", blurb: "$0.50–$3 per million input tokens." },
  { id: "premium", label: "Premium", blurb: "Over $3 per million input tokens — frontier models." },
];

export interface OrModel {
  id: string; // e.g. "google/gemma-4-31b-it:free"
  name: string; // vendor-supplied display name
  vendor: string; // id prefix, e.g. "google"
  vendorLabel: string; // "Google"
  blurb: string; // first sentence of the description, trimmed
  tier: Tier;
  free: boolean;
  /** USD per 1M prompt tokens. null = variable (routers). */
  inUsd: number | null;
  /** USD per 1M completion tokens. null = variable (routers). */
  outUsd: number | null;
  context: number; // context window in tokens
  maxOutput: number | null;
  vision: boolean;
  audio: boolean;
  tools: boolean;
  reasoning: boolean;
  /** Model honours `response_format` — the Ledger asks for JSON a lot. */
  jsonMode: boolean;
  /**
   * Native web search: the provider searches for itself, so the model can answer
   * from live pages. Any model can be given OpenRouter's Exa plugin instead, but
   * that is a search bolted on in front of it — this flag is the real thing.
   */
  web: boolean;
  /** USD per search request, flat, on top of tokens. null = the price is not published. */
  webSearchUsd: number | null;
  /** Artificial Analysis intelligence index, when OpenRouter publishes one. */
  intelligence: number | null;
  created: number; // unix seconds
}

export interface OrCatalog {
  models: OrModel[];
  fetchedAt: string; // ISO
  stale: boolean; // served from cache after a failed refresh
  error?: string;
}

// --- normalisation ---------------------------------------------------------

// The same lab can publish under more than one namespace: OpenRouter's "~vendor"
// shadow namespace holds the rolling `-latest` aliases, and Meta ships as both
// `meta` and `meta-llama`. Fold them together so the vendor filter lists each lab once.
const VENDOR_ALIASES: Record<string, string> = { "meta-llama": "meta" };

function vendorKey(prefix: string): string {
  const bare = prefix.replace(/^~/, "");
  return VENDOR_ALIASES[bare] ?? bare;
}

// Vendors whose slug does not title-case cleanly.
const VENDOR_LABELS: Record<string, string> = {
  ai21: "AI21",
  "aion-labs": "AionLabs",
  "arcee-ai": "Arcee AI",
  "bytedance-seed": "ByteDance Seed",
  bytedance: "ByteDance",
  cognitivecomputations: "Cognitive Computations",
  "dots-studio": "Dots Studio",
  deepseek: "DeepSeek",
  "ibm-granite": "IBM Granite",
  inclusionai: "InclusionAI",
  meta: "Meta",
  minimax: "MiniMax",
  mistralai: "Mistral AI",
  moonshotai: "Moonshot AI",
  "nex-agi": "Nex AGI",
  rekaai: "Reka AI",
  nousresearch: "Nous Research",
  nvidia: "NVIDIA",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  "sao10k": "Sao10K",
  stepfun: "StepFun",
  thedrummer: "TheDrummer",
  thinkingmachines: "Thinking Machines",
  "x-ai": "xAI",
  "z-ai": "Z.ai",
};

function vendorLabel(key: string): string {
  if (VENDOR_LABELS[key]) return VENDOR_LABELS[key];
  return key
    .split(/[-_]/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

// OpenRouter prices per token as a string; routers report "-1" for "it depends".
function perMillion(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return n * 1e6;
}

// Search is billed per request, not per token, so this one is not scaled.
function flatUsd(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// Vendor descriptions are markdown, and the picker renders plain text.
function stripMarkdown(text: string): string {
  return (text || "")
    .replace(/!?\[([^\]]*)\]\(<?[^)]*>?\)/g, "$1") // [Poolside](https://…) -> Poolside
    // Some descriptions are hand-written and get the syntax wrong — "Sonnet(https://…)"
    // with no bracket part. The pass above cannot match that, so the bare URL would
    // ride into the picker. Drop any parenthesised link, then any URL still standing.
    .replace(/\s*\((?:<?(?:https?:\/\/|www\.)[^)]*>?)\)/g, "")
    .replace(/<?\b(?:https?:\/\/|www\.)\S+>?/g, "")
    .replace(/[*_`]{1,3}/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1") // removing a link can strand its space
    .trim();
}

function firstSentence(text: string, max = 180): string {
  const flat = stripMarkdown(text);
  if (!flat) return "";
  // A sentence ends at a period followed by space or end-of-string, so version
  // numbers survive ("GPT-4.1", "Llama 3.3"). Ends that would leave a scrap are
  // skipped, which is what saves us from "e.g." and "Inc.".
  let cut = "";
  const ends = /\.(?=\s|$)/g;
  for (let m = ends.exec(flat); m; m = ends.exec(flat)) {
    if (m.index >= 30) {
      cut = flat.slice(0, m.index + 1);
      break;
    }
  }
  if (!cut) cut = flat;
  return cut.length > max ? `${cut.slice(0, max - 1).trimEnd()}…` : cut;
}

function tierFor(inUsd: number | null, outUsd: number | null): Tier {
  if (inUsd === null || outUsd === null) return "router";
  if (inUsd === 0 && outUsd === 0) return "free";
  if (inUsd < 0.5) return "budget";
  if (inUsd <= 3) return "standard";
  return "premium";
}

// Turn one raw catalogue entry into an OrModel, or null if it can't do the work the
// Ledger asks of a model (text in, text out).
export function normalizeModel(raw: any): OrModel | null {
  const id = String(raw?.id || "");
  if (!id) return null;
  const arch = raw.architecture || {};
  const input: string[] = arch.input_modalities || [];
  const output: string[] = arch.output_modalities || [];
  // Text in, text *only* out. A model that also emits images or audio is a
  // generator (Lyria, GPT Image) — it will happily take the prompt and hand back
  // something the Ledger cannot put on a résumé.
  if (!input.includes("text")) return null;
  if (output.length !== 1 || output[0] !== "text") return null;

  const params: string[] = raw.supported_parameters || [];
  const inUsd = perMillion(raw.pricing?.prompt);
  const outUsd = perMillion(raw.pricing?.completion);
  const vendor = vendorKey(id.split("/")[0] || "other");

  return {
    id,
    name: String(raw.name || id),
    vendor,
    vendorLabel: vendorLabel(vendor),
    blurb: firstSentence(raw.description || ""),
    tier: tierFor(inUsd, outUsd),
    free: inUsd === 0 && outUsd === 0,
    inUsd,
    outUsd,
    context: Number(raw.context_length || raw.top_provider?.context_length || 0),
    maxOutput: raw.top_provider?.max_completion_tokens ?? null,
    vision: input.includes("image"),
    audio: input.includes("audio"),
    tools: params.includes("tools"),
    reasoning: params.includes("reasoning") || params.includes("include_reasoning"),
    jsonMode: params.includes("response_format") || params.includes("structured_outputs"),
    web: params.includes("web_search_options"),
    webSearchUsd: flatUsd(raw.pricing?.web_search),
    intelligence:
      typeof raw.benchmarks?.artificial_analysis?.intelligence_index === "number"
        ? raw.benchmarks.artificial_analysis.intelligence_index
        : null,
    created: Number(raw.created || 0),
  };
}

// Best-first inside a tier: models that can actually do the Ledger's JSON + tool work
// float up, then measured intelligence, then the newest.
export function rankModels(models: OrModel[]): OrModel[] {
  return [...models].sort((a, b) => {
    const score = (m: OrModel) => (m.jsonMode ? 2 : 0) + (m.tools ? 1 : 0);
    if (score(a) !== score(b)) return score(b) - score(a);
    const ia = a.intelligence ?? -1;
    const ib = b.intelligence ?? -1;
    if (ia !== ib) return ib - ia;
    if (a.created !== b.created) return b.created - a.created;
    return a.id.localeCompare(b.id);
  });
}

export function normalizeCatalog(raw: any): OrModel[] {
  const list: any[] = Array.isArray(raw?.data) ? raw.data : [];
  const out: OrModel[] = [];
  const seen = new Set<string>();
  for (const r of list) {
    const m = normalizeModel(r);
    if (m && !seen.has(m.id)) {
      seen.add(m.id);
      out.push(m);
    }
  }
  return rankModels(out);
}

// --- cache + fetch ---------------------------------------------------------

// `checkedAt` is when openRouterCatalog last decided this copy was current. A memo
// seeded by the synchronous cachedCatalog() leaves it at 0, so the next async call
// still revalidates instead of inheriting that read's pessimistic `stale` flag.
let memo: {
  models: OrModel[];
  fetchedAt: string;
  checkedAt: number;
  stale: boolean;
  error?: string;
} | null = null;

// Bumped whenever OrModel gains a field. A cache written before the bump parses
// perfectly well and is entirely wrong — every model in it would report itself as
// unable to browse — so it is discarded rather than shown.
export const CACHE_VERSION = 2;

function readCache(): { fetchedAt: string; models: OrModel[] } | null {
  try {
    if (!existsSync(CACHE_PATH)) return null;
    const j = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
    if (Number(j?.version) !== CACHE_VERSION) return null;
    if (!Array.isArray(j?.models) || !j.models.length) return null;
    return { fetchedAt: String(j.fetchedAt || ""), models: j.models as OrModel[] };
  } catch {
    return null;
  }
}

function writeCache(models: OrModel[], fetchedAt: string): void {
  try {
    mkdirSync(dirname(CACHE_PATH), { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify({ version: CACHE_VERSION, fetchedAt, models }));
  } catch {
    // a read-only data dir just means we re-fetch next time
  }
}

/**
 * The catalogue, freshest-available. Network is best-effort: a stale disk cache
 * beats an empty picker, and an empty picker beats a crash.
 */
export async function openRouterCatalog(opts: { force?: boolean } = {}): Promise<OrCatalog> {
  const now = Date.now();
  // A failed refresh is held for a minute, not for the six-hour TTL: a network blip
  // must not leave the picker frozen long after the connection came back.
  if (!opts.force && memo && now - memo.checkedAt < (memo.stale ? RETRY_MS : TTL_MS))
    return { models: memo.models, fetchedAt: memo.fetchedAt, stale: memo.stale, error: memo.error };

  const cached = memo?.models.length ? { fetchedAt: memo.fetchedAt, models: memo.models } : readCache();
  if (!opts.force && cached) {
    const age = now - Date.parse(cached.fetchedAt || "");
    if (Number.isFinite(age) && age >= 0 && age < TTL_MS) {
      memo = { models: cached.models, fetchedAt: cached.fetchedAt, checkedAt: now, stale: false };
      return { models: cached.models, fetchedAt: cached.fetchedAt, stale: false };
    }
  }

  try {
    const res = await fetch(CATALOG_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`OpenRouter models ${res.status}`);
    const models = normalizeCatalog(await res.json());
    if (!models.length) throw new Error("OpenRouter returned an empty catalogue");
    const fetchedAt = new Date().toISOString();
    writeCache(models, fetchedAt);
    memo = { models, fetchedAt, checkedAt: now, stale: false };
    return { models, fetchedAt, stale: false };
  } catch (e: any) {
    const error = String(e?.message || e);
    // Nothing to serve is not worth remembering at all — the next caller retries
    // rather than inheriting an empty catalogue. A stale copy is worth holding
    // briefly, along with the reason, so the picker can say why it looks old.
    memo = cached?.models.length
      ? { models: cached.models, fetchedAt: cached.fetchedAt, checkedAt: now, stale: true, error }
      : null;
    return { models: cached?.models ?? [], fetchedAt: cached?.fetchedAt ?? "", stale: true, error };
  }
}

/** Synchronous view of whatever we already have. Never hits the network. */
export function cachedCatalog(): OrModel[] {
  if (memo) return memo.models;
  const cached = readCache();
  if (!cached) return [];
  // checkedAt 0 = "not validated" — openRouterCatalog will still do its own check
  memo = { models: cached.models, fetchedAt: cached.fetchedAt, checkedAt: 0, stale: true };
  return cached.models;
}

export function cachedModel(id: string): OrModel | null {
  return cachedCatalog().find((m) => m.id === id) ?? null;
}

/**
 * The least expensive model that can search for itself.
 *
 * `:batch` variants undercut everything and are the wrong answer: that is a delayed
 * queue, not something a crawl can sit and wait on. Routers price as null and are
 * skipped for the same reason a quote of "varies" is not a quote.
 */
export function cheapestWebModel(): OrModel | null {
  const priced = cachedCatalog().filter(
    (m) => m.web && m.inUsd !== null && m.outUsd !== null && !m.id.includes(":batch")
  );
  if (!priced.length) return null;
  return priced.sort((a, b) => a.inUsd! + a.outUsd! - (b.inUsd! + b.outUsd!))[0];
}

const money = (n: number) => `$${n.toFixed(2)}`;

/**
 * Why this key cannot search, and what it would take — written for the crawl log,
 * where someone is looking at a run that found nothing and wants to know whose fault
 * it is.
 *
 * An offer, not a scolding: free is the default here on purpose (see the header of
 * this file), and the boards it points at are not a degraded mode.
 *
 * Warms the catalogue when it is cold, because the naming-a-model line is the whole
 * point and a version bump or a fresh clone leaves nothing on disk to read. Bounded
 * tightly: the only caller is a run that has already decided to stop, and a price
 * lookup must not be what makes it look hung.
 */
export async function webSearchAdvice(): Promise<string[]> {
  if (!cachedCatalog().length) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      openRouterCatalog().catch(() => undefined),
      new Promise<void>((r) => { timer = setTimeout(r, 2500); }),
    ]);
    clearTimeout(timer);
  }
  return adviceLines();
}

function adviceLines(): string[] {
  const out: string[] = [
    "OpenRouter never includes the searching: the Exa plugin bills about $0.007 a request, and a native " +
      "engine passes the provider's own charge through. A :free model makes the tokens free, never the search.",
  ];

  if (getSetting("openrouter_free_only") === "true")
    out.push(
      '"Free models only" is on, so the Ledger holds web search off rather than spend behind a promise not to.'
    );
  else if ((getSetting("openrouter_web_search") || "off") === "off")
    out.push("Web search is switched off in Settings \u2192 OpenRouter.");

  const cheapest = cheapestWebModel();
  if (cheapest)
    out.push(
      `Cheapest model that can search for itself: ${cheapest.id} \u2014 ${money(cheapest.inUsd!)} in / ` +
        `${money(cheapest.outUsd!)} out per 1M tokens` +
        (cheapest.webSearchUsd !== null ? `, plus $${cheapest.webSearchUsd} a search` : "") +
        "."
    );

  out.push(
    "To switch: put credit on the account at openrouter.ai/credits, then in Settings \u2192 OpenRouter untick " +
      '"free models only", pick that model, and set Web search. Nothing here charges you until you do.'
  );
  return out;
}

// A `:free` id is free even before the catalogue has loaded — the suffix is
// OpenRouter's own marker, so the budget gate can trust it offline.
export function isFreeModelId(id: string): boolean {
  if (!id) return false;
  if (id.endsWith(":free") || id === "openrouter/free") return true;
  return cachedModel(id)?.free ?? false;
}

/** USD for one call, from the cached catalogue. null when the model is unknown. */
export function catalogCost(id: string, inTok: number, outTok: number): number | null {
  const m = cachedModel(id);
  if (!m || m.inUsd === null || m.outUsd === null) return null;
  return Math.max(0, (inTok / 1e6) * m.inUsd + (outTok / 1e6) * m.outUsd);
}

// --- grouping for the picker ----------------------------------------------

export interface TierGroup {
  tier: Tier;
  label: string;
  blurb: string;
  models: OrModel[];
}

export function groupByTier(models: OrModel[]): TierGroup[] {
  return TIERS.map((t) => ({
    tier: t.id,
    label: t.label,
    blurb: t.blurb,
    models: models.filter((m) => m.tier === t.id),
  })).filter((g) => g.models.length > 0);
}

export function vendorsOf(models: OrModel[]): { id: string; label: string; count: number }[] {
  const by = new Map<string, { id: string; label: string; count: number }>();
  for (const m of models) {
    const cur = by.get(m.vendor);
    if (cur) cur.count++;
    else by.set(m.vendor, { id: m.vendor, label: m.vendorLabel, count: 1 });
  }
  return [...by.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** Free models, best-first — what the free-tier defaults and fallback chain use. */
export function freeModels(models = cachedCatalog()): OrModel[] {
  return models.filter((m) => m.free);
}

// Sensible free pick when the user has never chosen one: OpenRouter's own free
// router, which spreads load across the free pool, else the best free model we know.
export const FREE_ROUTER_ID = "openrouter/free";

export function defaultFreeModelId(models = cachedCatalog()): string {
  const free = freeModels(models);
  if (free.some((m) => m.id === FREE_ROUTER_ID)) return FREE_ROUTER_ID;
  const usable = free.filter((m) => m.jsonMode && m.tools);
  return usable[0]?.id ?? free[0]?.id ?? FREE_ROUTER_ID;
}
