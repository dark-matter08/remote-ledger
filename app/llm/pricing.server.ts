// Loads pricing.json (repo root, user-editable) and computes per-call cost.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type Rate = { in: number; out: number; cache?: number };
type Pricing = Record<string, Record<string, Rate>>;

let cache: { mtime: number; data: Pricing } | null = null;

function load(): Pricing {
  const path = resolve(process.cwd(), "pricing.json");
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as Pricing;
    return data;
  } catch {
    return {};
  }
}

function rate(provider: string, model: string): Rate | null {
  const data = (cache = cache || { mtime: 0, data: load() }).data;
  const p = data[provider];
  if (!p) return null;
  return p[model] || p["*"] || null;
}

// returns USD cost for the call, or null if the model isn't priced
export function costFor(
  provider: string,
  model: string,
  inTok: number,
  outTok: number,
  cachedTok = 0
): number | null {
  const r = rate(provider, model);
  if (!r) return null;
  const inCost = ((inTok - cachedTok) / 1e6) * r.in;
  const cacheCost = (cachedTok / 1e6) * (r.cache ?? r.in);
  const outCost = (outTok / 1e6) * r.out;
  return Math.max(0, inCost + cacheCost + outCost);
}

// rough token estimate when an adapter can't report usage (~4 chars/token)
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}
