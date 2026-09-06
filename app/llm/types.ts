// Shared types for the pluggable LLM Runner layer.

export type Purpose =
  | "job-research"
  | "resume-tailor"
  | "cover-letter"
  | "match"
  | "parse-resume"
  | "interview-prep"
  | "misc";

/** A function the model may ask us to run. JSON Schema, as every provider expects. */
export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** The model asking for one. `args` is already parsed — providers send it as a string. */
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, any>;
}

/**
 * A turn in a tool conversation. Only used when a caller drives the loop; the ordinary
 * single-shot path still passes `system` + `prompt` and never builds one of these.
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

export interface RunRequest {
  purpose: Purpose;
  system?: string;
  prompt: string;
  json?: boolean; // expect + parse JSON output
  jobId?: string;
  maxTokens?: number;
  temperature?: number;
  runnerId?: string; // override default runner
  model?: string; // override model
  allowWeb?: boolean; // let the runner reach the live web, where it can (for job research)
  /** Tools the model may call this turn. Adapters that cannot do tools ignore it. */
  tools?: ToolDef[];
  /** Full conversation, when a tool loop is driving. Overrides system + prompt. */
  messages?: ChatMessage[];
}

export interface Usage {
  inTok: number;
  outTok: number;
  cachedTok: number;
  costUsd: number;
  metered: boolean; // false = subscription/local (not billed per token)
}

export interface RunResult {
  text: string;
  json?: any;
  usage: Usage;
  runner: string;
  model: string;
  durationMs: number;
  callId?: number;
  /** Present when the model asked for tools rather than answering. */
  toolCalls?: ToolCall[];
}

export interface RunnerInfo {
  id: string;
  label: string;
  kind: "cli" | "api";
  provider: string; // anthropic | openai | google | groq | mistral | openrouter | ollama | cursor | codex | gemini
  available: boolean;
  needsKey?: string; // secret name required (api runners)
  defaultModel?: string;
  // Can this runner actually reach the live web? A CLI agent can; a plain chat
  // completion cannot, whatever the prompt asks of it. The find crawl reads this to
  // decide whether to research or to fall back to reading feeds.
  web?: boolean;
  /**
   * Can this runner be given tools? Distinct from `web`: `web` means the provider
   * browses for itself, `tools` means we can hand it functions and run them here.
   * A local model with tools support plus our own search is how a model that cannot
   * browse still works from live pages.
   */
  tools?: boolean;
  detail?: string; // human note (version, why unavailable, etc.)
}

export interface AdapterResult {
  text: string;
  usage: Partial<Usage>; // adapter fills what it knows; runner computes the rest
  model: string;
  /** What the model wants run before it will answer. Empty/absent = it is done. */
  toolCalls?: ToolCall[];
}

export interface RunnerAdapter {
  id: string;
  info(): Promise<RunnerInfo>;
  run(req: RunRequest, model: string): Promise<AdapterResult>;
}
