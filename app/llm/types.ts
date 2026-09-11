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
  /**
   * Pictures the model should look at alongside the prompt — a screenshot of an
   * interview invite, a recruiter's message. An adapter that cannot show its model an
   * image leaves them out and says so in `sawImages`; it never pretends.
   */
  images?: ImageInput[];
  /**
   * "low": this call wants the model to write, not deliberate. Long-form output — a
   * prep, a cover letter — on a reasoning model can spend the whole output budget
   * thinking and hand back nothing. Providers with no such knob ignore it.
   */
  thinking?: "low";
}

export interface ImageInput {
  /** absolute path on this machine */
  path: string;
  mime: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
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
  /** True only when the images in the request actually reached the model. */
  sawImages?: boolean;
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
  /**
   * Can the model this runner will use look at a picture? A per-model fact, not a
   * per-provider one: Ollama with qwen2.5 cannot, Ollama with qwen2.5vl can. Unknown
   * reads as false, because claiming to have read a screenshot and not having done so
   * is the one failure this flag exists to prevent.
   */
  vision?: boolean;
  detail?: string; // human note (version, why unavailable, etc.)
}

export interface AdapterResult {
  text: string;
  usage: Partial<Usage>; // adapter fills what it knows; runner computes the rest
  model: string;
  /** What the model wants run before it will answer. Empty/absent = it is done. */
  toolCalls?: ToolCall[];
  /** Set by adapters that were given images: did they go to the model? */
  sawImages?: boolean;
}

export interface RunnerAdapter {
  id: string;
  info(): Promise<RunnerInfo>;
  run(req: RunRequest, model: string): Promise<AdapterResult>;
  /** Whether this model, on this runner, can look at a picture. Absent = no. */
  vision?(model: string): Promise<boolean>;
}
