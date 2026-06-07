// Discover available models per runner. Where a provider exposes a models endpoint
// and we have a key, we pull the real list live. For CLI agents (no key, subscription)
// we offer the aliases the CLI itself accepts (e.g. claude --model sonnet|opus|haiku).
import { getSecret } from "../secrets.server";

// model aliases each CLI agent accepts on `--model`
const CLI_ALIASES: Record<string, string[]> = {
  "claude-cli": ["default", "sonnet", "opus", "haiku"],
  "codex-cli": ["default", "gpt-5", "gpt-5-codex", "o4-mini"],
  "cursor-cli": ["default", "sonnet-4.5", "opus-4.1", "gpt-5"],
  "gemini-cli": ["default", "gemini-2.5-pro", "gemini-2.5-flash"],
};

const PROVIDER_FALLBACK: Record<string, string[]> = {
  anthropic: ["claude-sonnet-4-6", "claude-opus-4-8", "claude-haiku-4-5-20251001"],
  openai: ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "o4-mini"],
  google: ["gemini-1.5-flash", "gemini-1.5-pro", "gemini-2.0-flash"],
  groq: ["llama-3.3-70b-versatile"],
  mistral: ["mistral-large-latest"],
  openrouter: ["anthropic/claude-3.5-sonnet"],
  ollama: [],
};

async function openaiList(base: string, key: string | null): Promise<string[]> {
  try {
    const r = await fetch(`${base}/models`, { headers: key ? { authorization: `Bearer ${key}` } : {} });
    if (!r.ok) return [];
    const j: any = await r.json();
    return (j.data || []).map((m: any) => m.id).filter(Boolean);
  } catch {
    return [];
  }
}

async function liveModels(provider: string): Promise<string[]> {
  try {
    if (provider === "anthropic") {
      const key = getSecret("anthropic_api_key");
      if (!key) return [];
      const r = await fetch("https://api.anthropic.com/v1/models?limit=100", {
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      });
      if (!r.ok) return [];
      const j: any = await r.json();
      return (j.data || []).map((m: any) => m.id).filter(Boolean);
    }
    if (provider === "openai") return openaiList("https://api.openai.com/v1", getSecret("openai_api_key"));
    if (provider === "openrouter") return openaiList("https://openrouter.ai/api/v1", getSecret("openrouter_api_key"));
    if (provider === "groq") return openaiList("https://api.groq.com/openai/v1", getSecret("groq_api_key"));
    if (provider === "mistral") return openaiList("https://api.mistral.ai/v1", getSecret("mistral_api_key"));
    if (provider === "google") {
      const key = getSecret("google_api_key");
      if (!key) return [];
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
      if (!r.ok) return [];
      const j: any = await r.json();
      return (j.models || []).map((m: any) => String(m.name).replace(/^models\//, "")).filter(Boolean);
    }
    if (provider === "ollama") {
      const base = (process.env.OLLAMA_URL || "http://localhost:11434/v1").replace(/\/v1$/, "");
      const r = await fetch(`${base}/api/tags`);
      if (!r.ok) return [];
      const j: any = await r.json();
      return (j.models || []).map((m: any) => m.name).filter(Boolean);
    }
  } catch {}
  return [];
}

export async function discoverModels(runnerId: string, provider: string, kind: "cli" | "api"): Promise<string[]> {
  const aliases = kind === "cli" ? CLI_ALIASES[runnerId] || ["default"] : [];
  const live = await liveModels(provider);
  const fb = PROVIDER_FALLBACK[provider] || [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of [...aliases, ...live, ...fb]) {
    if (m && !seen.has(m)) { seen.add(m); out.push(m); }
  }
  if (!out.includes("default")) out.unshift("default");
  return out.slice(0, 50);
}
