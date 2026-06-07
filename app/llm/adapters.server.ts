// Concrete runner adapters. Two families:
//   - CLI:  spawn an installed agent (claude/codex/cursor/gemini) — uses the user's
//           own subscription/local model. Usage parsed when available, else estimated.
//   - API:  direct HTTP with a BYO key — exact usage returned.
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import type { AdapterResult, RunnerAdapter, RunnerInfo, RunRequest, Usage } from "./types";
import { getSecret } from "../secrets.server";

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
    return {
      id: this.id,
      label: this.label,
      kind: "api",
      provider: this.provider,
      available: this.keyName ? !!getSecret(this.keyName) : true,
      needsKey: this.keyName ?? undefined,
      defaultModel: this.defaultModel,
    };
  }
  async run(req: RunRequest, model: string): Promise<AdapterResult> {
    const key = this.keyName ? getSecret(this.keyName) : null;
    if (this.keyName && !key) throw new Error(`${this.keyName} not set`);
    const messages = [
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
        ...(req.json ? { response_format: { type: "json_object" } } : {}),
      }),
    });
    const j: any = await res.json();
    if (!res.ok) throw new Error(`${this.label} ${res.status}: ${JSON.stringify(j).slice(0, 300)}`);
    const text = j.choices?.[0]?.message?.content ?? "";
    return {
      text,
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
  new OpenAICompatAdapter(
    "openrouter-api",
    "OpenRouter API",
    "openrouter",
    "https://openrouter.ai/api/v1",
    "openrouter_api_key",
    "anthropic/claude-3.5-sonnet"
  ),
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
