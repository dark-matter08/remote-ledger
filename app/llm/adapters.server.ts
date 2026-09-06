// Concrete runner adapters. Two families:
//   - CLI:  spawn an installed agent (claude/codex/cursor/gemini) — uses the user's
//           own subscription/local model. Usage parsed when available, else estimated.
//   - API:  direct HTTP with a BYO key — exact usage returned.
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import type { AdapterResult, ChatMessage, RunnerAdapter, RunnerInfo, RunRequest, ToolCall, Usage } from "./types";
import { getSecret } from "../secrets.server";
import { getSetting } from "../sqlite.server";
import {
  OPENROUTER_BASE,
  cachedCatalog,
  cachedModel,
  catalogCost,
  defaultFreeModelId,
  freeModels,
  isFreeModelId,
  openRouterCatalog,
} from "./openrouter.server";

// --- shell helpers ---------------------------------------------------------

function augmentedPath(): string {
  const extra = [
    dirname(process.execPath),
    `${process.env.HOME}/.nvm/versions/node/v18.18.2/bin`,
    `${process.env.HOME}/.nvm/versions/node/v22.22.2/bin`,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    `${process.env.HOME}/.local/bin`,
    "/usr/bin",
    "/bin",
  ];
  return [...new Set([...(process.env.PATH || "").split(":"), ...extra])]
    .filter(Boolean)
    .join(":");
}

function exec(
  cmd: string,
  args: string[],
  opts: { input?: string; timeoutMs?: number } = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveP) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, PATH: augmentedPath() },
    });
    let stdout = "",
      stderr = "";
    const timer = setTimeout(
      () => child.kill("SIGKILL"),
      opts.timeoutMs ?? 240000
    );
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolveP({ code: 127, stdout, stderr: stderr + String(e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveP({ code: code ?? 0, stdout, stderr });
    });
    if (opts.input) child.stdin.write(opts.input);
    child.stdin.end();
  });
}

async function which(cmd: string): Promise<boolean> {
  const r = await exec("bash", ["-lc", `command -v ${cmd}`], { timeoutMs: 8000 });
  return r.code === 0 && r.stdout.trim().length > 0;
}

// --- Claude Code CLI (rich: reports usage + cost) --------------------------

class ClaudeCliAdapter implements RunnerAdapter {
  id = "claude-cli";
  async info(): Promise<RunnerInfo> {
    return {
      id: this.id,
      label: "Claude Code (CLI)",
      kind: "cli",
      provider: "anthropic",
      available: await which("claude"),
      web: true, // WebSearch/WebFetch, when req.allowWeb asks for them
      detail: "Uses your Claude Code subscription. Reports tokens + cost.",
    };
  }
  async run(req: RunRequest, model?: string): Promise<AdapterResult> {
    const args = ["-p", "--output-format", "json"];
    if (model && model !== "default") args.push("--model", model);
    if (req.system) args.push("--append-system-prompt", req.system);
    if (req.allowWeb) args.push("--allowedTools", "WebSearch,WebFetch");
    const r = await exec("claude", args, {
      input: req.prompt,
      timeoutMs: 300000,
    });
    if (r.code !== 0 && !r.stdout) throw new Error(`claude exit ${r.code}: ${r.stderr.slice(0, 300)}`);
    // envelope: { result, usage:{input_tokens,output_tokens,cache_read_input_tokens}, total_cost_usd }
    try {
      const env = JSON.parse(r.stdout);
      const u = env.usage || {};
      return {
        text: typeof env.result === "string" ? env.result : r.stdout,
        model: env.model || "claude",
        usage: {
          inTok: u.input_tokens ?? 0,
          outTok: u.output_tokens ?? 0,
          cachedTok: u.cache_read_input_tokens ?? 0,
          costUsd: typeof env.total_cost_usd === "number" ? env.total_cost_usd : 0,
          metered: false, // subscription
        },
      };
    } catch {
      return { text: r.stdout.trim(), model: "claude", usage: { metered: false } };
    }
  }
}

// --- generic agent CLI (codex / cursor / gemini): best-effort, est. tokens --

class GenericCliAdapter implements RunnerAdapter {
  constructor(
    public id: string,
    private label: string,
    private provider: string,
    private bin: string,
    private buildArgs: (req: RunRequest, model?: string) => string[],
    private passViaStdin = true
  ) {}
  async info(): Promise<RunnerInfo> {
    return {
      id: this.id,
      label: this.label,
      kind: "cli",
      provider: this.provider,
      available: await which(this.bin),
      web: true, // every agent CLI we shell out to can open a page
      detail: `Uses your ${this.label} install. Tokens estimated (CLI does not report usage).`,
    };
  }
  async run(req: RunRequest, model?: string): Promise<AdapterResult> {
    const args = this.buildArgs(req, model);
    const text = [req.system ? `System:\n${req.system}\n\n` : "", req.prompt].join("");
    const r = await exec(this.bin, args, {
      input: this.passViaStdin ? text : undefined,
      timeoutMs: 300000,
    });
    if (r.code !== 0 && !r.stdout)
      throw new Error(`${this.bin} exit ${r.code}: ${r.stderr.slice(0, 300)}`);
    return { text: r.stdout.trim(), model: this.bin, usage: { metered: false } };
  }
}

// --- Anthropic API ---------------------------------------------------------

class AnthropicApiAdapter implements RunnerAdapter {
  id = "anthropic-api";
  defaultModel = "claude-sonnet-4-6";
  async info(): Promise<RunnerInfo> {
    return {
      id: this.id,
      label: "Anthropic API",
      kind: "api",
      provider: "anthropic",
      available: !!getSecret("anthropic_api_key"),
      needsKey: "anthropic_api_key",
      defaultModel: this.defaultModel,
    };
  }
  async run(req: RunRequest, model: string): Promise<AdapterResult> {
    const key = getSecret("anthropic_api_key");
    if (!key) throw new Error("anthropic_api_key not set");
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: req.maxTokens ?? 4096,
        temperature: req.temperature ?? 0.4,
        system: req.system,
        messages: [{ role: "user", content: req.prompt }],
      }),
    });
    const j: any = await res.json();
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${JSON.stringify(j).slice(0, 300)}`);
    const text = (j.content || []).map((c: any) => c.text || "").join("");
    return {
      text,
      model,
      usage: {
        inTok: j.usage?.input_tokens ?? 0,
        outTok: j.usage?.output_tokens ?? 0,
        cachedTok: j.usage?.cache_read_input_tokens ?? 0,
        metered: true,
      },
    };
  }
}

/** Our ChatMessage in the shape the OpenAI-compatible wire format expects. */
function toWireMessage(m: ChatMessage): any {
  if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
  if (m.role === "assistant" && m.toolCalls?.length) {
    return {
      role: "assistant",
      content: m.content || null,
      tool_calls: m.toolCalls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
      })),
    };
  }
  return { role: m.role, content: m.content };
}

/**
 * Tool calls out of a response message.
 *
 * `arguments` arrives as a JSON *string*, and a small model will sometimes emit one
 * that does not parse. A malformed call is not worth failing the turn over: hand back
 * empty arguments and let the tool say what it is missing, which the model can fix.
 */
function parseToolCalls(msg: any): ToolCall[] | undefined {
  const raw = msg?.tool_calls;
  if (!Array.isArray(raw) || !raw.length) return undefined;
  const out = raw
    .map((c: any, i: number) => {
      let args: Record<string, any> = {};
      try {
        const a = c?.function?.arguments;
        args = typeof a === "string" ? JSON.parse(a || "{}") : a && typeof a === "object" ? a : {};
      } catch {
        args = {};
      }
      return { id: String(c?.id || `call_${i}`), name: String(c?.function?.name || ""), args };
    })
    .filter((c: ToolCall) => c.name);
  return out.length ? out : undefined;
}

// A local runner has no key, so "is there a key?" cannot answer whether it is usable.
// Ollama is available when its daemon answers and not otherwise — install it, never
// start it, and the Runners table called it ready anyway, so it could be picked as the
// default and then fail every call with a connection error.
//
// The settings page asks every runner for its info on each render, so the answer is
// held for a few seconds. The setup tab probes directly instead, because right after
// pressing Start a stale "down" is exactly the wrong answer.
let ollamaProbe: { at: number; up: boolean } | null = null;
const OLLAMA_PROBE_MS = 5000;

export function resetOllamaProbe(): void {
  ollamaProbe = null;
}

export async function ollamaReachable(baseUrl: string): Promise<boolean> {
  const now = Date.now();
  if (ollamaProbe && now - ollamaProbe.at < OLLAMA_PROBE_MS) return ollamaProbe.up;
  let up = false;
  try {
    const res = await fetch(`${baseUrl.replace(/\/v1$/, "")}/api/version`, {
      signal: AbortSignal.timeout(1200),
    });
    up = res.ok;
  } catch {
    // not running, not installed, or bound elsewhere — all the same to a caller
  }
  ollamaProbe = { at: now, up };
  return up;
}

/**
 * A failure the same request will keep hitting.
 *
 * A model the server cannot load does not become loadable on the next batch, so
 * grinding through the remaining ones produces the identical 500 several times and
 * buries the one line that matters. Callers check this to stop rather than retry.
 */
export function isPermanentModelError(message: string): boolean {
  return /unknown model architecture|error loading model|llama-server process has terminated|model .*not found|no such model|does not support/i.test(
    String(message || "")
  );
}

/**
 * Turn a provider's 500 into something a person can act on.
 *
 * Ollama answers a model it cannot load with the raw llama-server stderr, which names
 * the architecture and nothing else — "unknown model architecture: 'mllama'" tells
 * you neither which model nor what to do. The model is ours to name, and the fix is
 * knowable from the shape of the error.
 */
function explainProviderError(label: string, provider: string, status: number, body: any, model: string): string {
  const raw = String(body?.error?.message || body?.error || JSON.stringify(body || {})).slice(0, 400);

  if (provider === "ollama") {
    if (/unknown model architecture/i.test(raw)) {
      const arch = /architecture:\s*'([^']+)'/i.exec(raw)?.[1];
      return (
        `Ollama cannot load "${model}"${arch ? ` — this build does not know the '${arch}' architecture` : ""}. ` +
        `Update Ollama (\`brew upgrade ollama\` or ollama.com/download), or pick a model it can run: ` +
        `\`ollama pull llama3.1:8b\`, then choose it in Settings → Runners. ` +
        `A text model is the better fit here in any case — this app asks for JSON, never images.`
      );
    }
    if (/model .*not found|no such model/i.test(raw))
      return `Ollama has no model called "${model}". Pull it first: \`ollama pull ${model}\` — or pick one you already have in Settings → Runners.`;
    if (/terminated|loading model/i.test(raw))
      return `Ollama failed to start "${model}": ${raw}. Try \`ollama run ${model}\` in a terminal to see the full reason.`;
  }
  return `${label} ${status}: ${raw}`;
}

// --- OpenAI-compatible (OpenAI, OpenRouter, Groq, Mistral, Ollama, ...) -----

class OpenAICompatAdapter implements RunnerAdapter {
  constructor(
    public id: string,
    private label: string,
    private provider: string,
    private baseUrl: string,
    private keyName: string | null, // null = no key (local)
    public defaultModel: string
  ) {}
  async info(): Promise<RunnerInfo> {
    const local = !this.keyName && this.provider === "ollama";
    const up = local ? await ollamaReachable(this.baseUrl) : false;
    return {
      id: this.id,
      label: this.label,
      kind: "api",
      provider: this.provider,
      available: this.keyName ? !!getSecret(this.keyName) : local ? up : true,
      // every OpenAI-compatible endpoint accepts the tools parameter; whether the
      // chosen *model* honours it is a per-model question the caller checks
      tools: true,
      needsKey: this.keyName ?? undefined,
      defaultModel: this.defaultModel,
      ...(local
        ? {
            detail: up
              ? "Running locally. No key, no cost, nothing leaves this machine."
              : "Not running — install and start it in Settings → Local.",
          }
        : {}),
    };
  }
  async run(req: RunRequest, model: string): Promise<AdapterResult> {
    const key = this.keyName ? getSecret(this.keyName) : null;
    if (this.keyName && !key) throw new Error(`${this.keyName} not set`);
    // A tool loop supplies the whole conversation; everything else is one turn.
    const messages = req.messages?.length
      ? req.messages.map(toWireMessage)
      : [
          ...(req.system ? [{ role: "system", content: req.system }] : []),
          { role: "user", content: req.prompt },
        ];
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: req.temperature ?? 0.4,
        // response_format and tools together confuse several providers: the model is
        // told to emit an object while also being offered functions, and some answer
        // with neither. While tools are on the table, let it talk.
        ...(req.json && !req.tools?.length ? { response_format: { type: "json_object" } } : {}),
        ...(req.tools?.length
          ? {
              tools: req.tools.map((t) => ({
                type: "function",
                function: { name: t.name, description: t.description, parameters: t.parameters },
              })),
              tool_choice: "auto",
            }
          : {}),
      }),
    });
    const j: any = await res.json();
    if (!res.ok) throw new Error(explainProviderError(this.label, this.provider, res.status, j, model));
    const msg = j.choices?.[0]?.message ?? {};
    const text = msg.content ?? "";
    return {
      text,
      toolCalls: parseToolCalls(msg),
      model,
      usage: {
        inTok: j.usage?.prompt_tokens ?? 0,
        outTok: j.usage?.completion_tokens ?? 0,
        cachedTok: j.usage?.prompt_tokens_details?.cached_tokens ?? 0,
        metered: this.provider !== "ollama",
      },
    };
  }
}

// --- OpenRouter ------------------------------------------------------------
//
// Its own adapter rather than the generic OpenAI-compatible one, because the free
// tier needs handling the generic path cannot give it:
//   - only send `response_format` when the catalogue says the model honours it —
//     most free models do not, and the runner already recovers JSON from prose;
//   - chain fallbacks so a rate-limited free model rolls to the next free model
//     instead of failing the user's crawl;
//   - ask OpenRouter for the real cost of the call, so free really reads as $0.00
//     on the Usage page instead of an estimate;
//   - translate 401/402/429 into what the person can actually do about it.

// OpenRouter rejects a `models` array longer than this outright — "'models' array
// must have 3 items or fewer", HTTP 400, before it looks at anything else. So it is a
// hard cap on the whole chain, primary included, not a count of spare tyres.
const OR_MAX_MODELS = 3;

// Longest we will wait for the catalogue before giving up and calling anyway. The
// fallback chain is a nice-to-have; the user's actual request is not.
const OR_WARM_MS = 2500;

/**
 * Make sure the catalogue is loaded, without letting it hold up the call.
 *
 * The free-fallback chain is read from the on-disk catalogue, and on a fresh install
 * nothing has fetched it yet — so the chain would be empty for the first run, which
 * is exactly the run most likely to meet the free tier's rate limit. Warming it here
 * costs one request, once, because the result is memoised and written to disk.
 */
async function warmCatalog(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    openRouterCatalog().catch(() => undefined),
    new Promise<void>((r) => {
      timer = setTimeout(r, OR_WARM_MS);
    }),
  ]);
  clearTimeout(timer);
}

// OpenRouter can run a search before the model answers, but there is no free tier
// for it: the Exa fallback bills per request and a native engine passes the
// provider's own search charge through, on free models too. So "free models only"
// has to win — it is a promise not to spend, and a silent $0.007 a call would break
// it. With web search off this runner honestly reports web:false, and the find
// crawl reads that and goes to the feeds instead (services/feeds.server.ts).
function webEngine(): "exa" | "native" | null {
  if (getSetting("openrouter_free_only") === "true") return null;
  const e = getSetting("openrouter_web_search") || "off";
  return e === "exa" || e === "native" ? e : null;
}

function webPlugin(): Record<string, unknown> | null {
  const engine = webEngine();
  if (!engine) return null;
  // native search is priced and shaped by the provider, so only the Exa path takes
  // a result count from us
  if (engine === "native") return { id: "web", engine: "native" };
  const max = Math.max(1, Math.min(20, Number(getSetting("openrouter_web_max_results") || "5") || 5));
  return { id: "web", engine: "exa", max_results: max };
}

class OpenRouterAdapter implements RunnerAdapter {
  id = "openrouter-api";

  async info(): Promise<RunnerInfo> {
    const free = freeModels().length;
    return {
      id: this.id,
      label: "OpenRouter API",
      kind: "api",
      provider: "openrouter",
      available: !!getSecret("openrouter_api_key"),
      needsKey: "openrouter_api_key",
      // the one API runner that can be given the live web — for a price
      web: !!getSecret("openrouter_api_key") && !!webEngine(),
      // Distinct from web above: web means OpenRouter searches for us and bills for it,
      // tools means we search and hand over what we found. The second costs nothing and
      // is checkable, so a free model with tools is the better of the two.
      tools: true,
      defaultModel: defaultFreeModelId(),
      detail: free
        ? `One key, every lab — including ${free} model${free === 1 ? "" : "s"} that cost nothing to run.`
        : "One key for every major lab, with a free tier.",
    };
  }

  // primary + free fallbacks, so a 429 on the free pool is a detour, not a dead end
  private modelChain(model: string, needsJson: boolean, needsTools = false): string[] {
    const chain = [model];
    const freeOnly = getSetting("openrouter_free_only") === "true";
    const configured = (getSetting("openrouter_fallbacks") || "")
      .split(",")
      .map((s) => s.trim())
      // a hand-written chain must not be a way round the free-only guard
      .filter((m) => m && (!freeOnly || isFreeModelId(m)));
    if (configured.length) {
      for (const m of configured) if (!chain.includes(m)) chain.push(m);
      return chain.slice(0, OR_MAX_MODELS); // a long hand-written list is a 400, not a longer chain
    }
    if (!isFreeModelId(model) || getSetting("openrouter_free_fallback") === "false") return chain;
    for (const m of freeModels()) {
      if (chain.length >= OR_MAX_MODELS) break;
      if (chain.includes(m.id)) continue;
      if (needsJson && !m.jsonMode) continue; // don't fall back into a model that can't answer in JSON
      // a model without tool support does not refuse a tool — it ignores it and
      // answers from memory, which is the failure this whole path exists to avoid
      if (needsTools && !m.tools) continue;
      chain.push(m.id);
    }
    return chain;
  }

  async run(req: RunRequest, model: string): Promise<AdapterResult> {
    const key = getSecret("openrouter_api_key");
    if (!key)
      throw new Error(
        "openrouter_api_key not set. Create a free key at openrouter.ai/keys and paste it into Settings → Keys."
      );
    if (getSetting("openrouter_free_only") === "true" && !isFreeModelId(model))
      throw new Error(
        `"${model}" is a paid model and OpenRouter is locked to free models. Pick a free model in Settings → OpenRouter, or turn off "free models only".`
      );

    // Only on a cold cache, and only when a chain would actually be built from it.
    if (!cachedCatalog().length && isFreeModelId(model)) await warmCatalog();

    const known = cachedModel(model);
    const chain = this.modelChain(model, !!req.json, !!req.tools?.length);
    const web = req.allowWeb ? webPlugin() : null;
    const messages = req.messages?.length
      ? req.messages.map(toWireMessage)
      : [
          ...(req.system ? [{ role: "system", content: req.system }] : []),
          { role: "user", content: req.prompt },
        ];

    const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
        // OpenRouter attribution — identifies the app on your dashboard/leaderboard
        "HTTP-Referer": "https://github.com/dark-matter08/remote-ledger",
        "X-Title": "The Remote Ledger",
      },
      body: JSON.stringify({
        model,
        ...(chain.length > 1 ? { models: chain } : {}),
        messages,
        temperature: req.temperature ?? 0.4,
        ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
        // only ask for JSON mode where the model actually supports it; elsewhere the
        // runner's tryParseJson pulls the object back out of prose
        // json mode only when no tools are on the table — asked for both, models answer
        // with neither. The loop turns tools off on its final turn to collect the object.
        ...(req.json && !req.tools?.length && (!known || known.jsonMode)
          ? { response_format: { type: "json_object" } }
          : {}),
        ...(req.tools?.length
          ? {
              tools: req.tools.map((t) => ({
                type: "function",
                function: { name: t.name, description: t.description, parameters: t.parameters },
              })),
              tool_choice: "auto",
            }
          : {}),
        ...(web ? { plugins: [web] } : {}), // billed per search, never on a free-only key
        usage: { include: true }, // return real, post-discount cost
      }),
    });

    // a body that will not parse is still a failure — without this the unreadable
    // `null` walks into the field reads below and surfaces as a bare TypeError
    const j: any = await res.json().catch(() => null);
    if (!res.ok || !j || j.error) throw new Error(openRouterError(res.status, j, model));

    const used = String(j.model || model);
    const message = j.choices?.[0]?.message ?? {};
    const text = message.content ?? "";
    const inTok = j.usage?.prompt_tokens ?? 0;
    const outTok = j.usage?.completion_tokens ?? 0;
    // OpenRouter reports the charge it actually made; fall back to catalogue rates,
    // and leave it undefined if we know neither so the runner tries pricing.json
    const cost =
      typeof j.usage?.cost === "number" ? j.usage.cost : catalogCost(used, inTok, outTok) ?? undefined;

    return {
      text,
      toolCalls: parseToolCalls(message),
      model: used,
      usage: {
        inTok,
        outTok,
        cachedTok: j.usage?.prompt_tokens_details?.cached_tokens ?? 0,
        costUsd: cost,
        metered: true,
      },
    };
  }
}

function openRouterError(status: number, body: any, model: string): string {
  const msg = String(body?.error?.message || body?.error || "").slice(0, 300);
  // a body-level error can arrive with HTTP 200, so prefer its code when numeric
  const inner = Number(body?.error?.code);
  const code = Number.isFinite(inner) && inner >= 100 ? inner : status;
  if (code === 401 || code === 403)
    return `OpenRouter rejected the key. Check it at openrouter.ai/keys. (${msg})`;
  if (code === 402)
    return `OpenRouter needs credit for "${model}". Switch to a free model in Settings → OpenRouter to keep working at no cost. (${msg})`;
  if (code === 429)
    return `OpenRouter rate-limited "${model}". Free models share a small per-minute allowance — wait a moment, pick another free model, or add credit to raise the cap. (${msg})`;
  if (code === 404)
    return `OpenRouter has no model called "${model}". Refresh the catalogue in Settings → OpenRouter.`;
  // the status codes above still read straight off an unparseable response; only a
  // body we could not read at all lands here, which is a proxy or a captive portal
  if (!body)
    return `OpenRouter answered ${status}, but not with JSON — something between you and openrouter.ai is rewriting the response. Check the connection and try again.`;
  return `OpenRouter ${code}: ${msg || "request failed"}`;
}

// --- Google Gemini API -----------------------------------------------------

class GoogleApiAdapter implements RunnerAdapter {
  id = "google-api";
  defaultModel = "gemini-1.5-flash";
  async info(): Promise<RunnerInfo> {
    return {
      id: this.id,
      label: "Google Gemini API",
      kind: "api",
      provider: "google",
      available: !!getSecret("google_api_key"),
      needsKey: "google_api_key",
      defaultModel: this.defaultModel,
    };
  }
  async run(req: RunRequest, model: string): Promise<AdapterResult> {
    const key = getSecret("google_api_key");
    if (!key) throw new Error("google_api_key not set");
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: req.system ? { parts: [{ text: req.system }] } : undefined,
        contents: [{ role: "user", parts: [{ text: req.prompt }] }],
        generationConfig: {
          temperature: req.temperature ?? 0.4,
          ...(req.json ? { responseMimeType: "application/json" } : {}),
        },
      }),
    });
    const j: any = await res.json();
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${JSON.stringify(j).slice(0, 300)}`);
    const text = (j.candidates?.[0]?.content?.parts || [])
      .map((p: any) => p.text || "")
      .join("");
    return {
      text,
      model,
      usage: {
        inTok: j.usageMetadata?.promptTokenCount ?? 0,
        outTok: j.usageMetadata?.candidatesTokenCount ?? 0,
        metered: true,
      },
    };
  }
}

// --- registry --------------------------------------------------------------

export const ADAPTERS: RunnerAdapter[] = [
  new ClaudeCliAdapter(),
  new GenericCliAdapter("codex-cli", "Codex (CLI)", "codex", "codex", (req, m) => [
    "exec",
    ...(m && m !== "default" ? ["--model", m] : []),
    req.prompt,
  ], false),
  new GenericCliAdapter("cursor-cli", "Cursor Agent (CLI)", "cursor", "cursor-agent", (_req, m) => [
    "-p",
    ...(m && m !== "default" ? ["--model", m] : []),
  ]),
  new GenericCliAdapter("gemini-cli", "Gemini (CLI)", "google", "gemini", (_req, m) => [
    "-p",
    ...(m && m !== "default" ? ["--model", m] : []),
  ]),
  new AnthropicApiAdapter(),
  new OpenAICompatAdapter(
    "openai-api",
    "OpenAI API",
    "openai",
    "https://api.openai.com/v1",
    "openai_api_key",
    "gpt-4o-mini"
  ),
  new GoogleApiAdapter(),
  new OpenRouterAdapter(),
  new OpenAICompatAdapter(
    "groq-api",
    "Groq API",
    "groq",
    "https://api.groq.com/openai/v1",
    "groq_api_key",
    "llama-3.3-70b-versatile"
  ),
  new OpenAICompatAdapter(
    "mistral-api",
    "Mistral API",
    "mistral",
    "https://api.mistral.ai/v1",
    "mistral_api_key",
    "mistral-large-latest"
  ),
  new OpenAICompatAdapter(
    "ollama-api",
    "Ollama (local)",
    "ollama",
    process.env.OLLAMA_URL || "http://localhost:11434/v1",
    null,
    "llama3.1"
  ),
];

export function adapterById(id: string): RunnerAdapter | undefined {
  return ADAPTERS.find((a) => a.id === id);
}

// Streaming Claude Code call for the Crawl Shell: emits each agent event (tool
// use, text) as it happens so the shell shows live reasoning instead of freezing
// for minutes on a long web-research turn.
export async function streamClaude(opts: {
  prompt: string;
  system?: string;
  model?: string;
  allowWeb?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  onEvent: (ev: any) => void;
}): Promise<{ text: string; usage: Partial<Usage> }> {
  return new Promise((resolveP, reject) => {
    const args = ["-p", "--output-format", "stream-json", "--verbose"];
    if (opts.model && opts.model !== "default") args.push("--model", opts.model);
    if (opts.system) args.push("--append-system-prompt", opts.system);
    if (opts.allowWeb) args.push("--allowedTools", "WebSearch,WebFetch");
    const child = spawn("claude", args, { env: { ...process.env, PATH: augmentedPath() } });
    let timedOut = false;
    let aborted = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, opts.timeoutMs ?? 600000);
    if (opts.signal) {
      const onAbort = () => { aborted = true; child.kill("SIGKILL"); };
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    let buf = "";
    let result: any = null;
    let text = "";
    let err = "";
    child.stdout.on("data", (d) => {
      buf += d.toString();
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let ev: any;
        try { ev = JSON.parse(line); } catch { continue; }
        try { opts.onEvent(ev); } catch {}
        if (ev.type === "result") {
          result = ev;
          if (typeof ev.result === "string") text = ev.result;
        }
      }
    });
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (result) {
        const u = result.usage || {};
        resolveP({
          text,
          usage: {
            inTok: u.input_tokens ?? 0,
            outTok: u.output_tokens ?? 0,
            cachedTok: u.cache_read_input_tokens ?? 0,
            costUsd: typeof result.total_cost_usd === "number" ? result.total_cost_usd : 0,
            metered: false,
          },
        });
      } else {
        reject(new Error(
          aborted
            ? "stopped by user"
            : timedOut
            ? `timed out after ${Math.round((opts.timeoutMs ?? 600000) / 60000)} min before the agent returned results`
            : signal
            ? `claude was killed by signal ${signal} before finishing (often the dev server reloading mid-crawl — use 'npm run build && npm run start' for uninterrupted crawls)`
            : `claude exited ${code}: ${err.slice(0, 200)}`
        ));
      }
    });
    child.stdin.write(opts.prompt);
    child.stdin.end();
  });
}
