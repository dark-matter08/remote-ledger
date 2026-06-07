// Shared types for the pluggable LLM Runner layer.

export type Purpose =
  | "job-research"
  | "resume-tailor"
  | "cover-letter"
  | "match"
  | "parse-resume"
  | "interview-prep"
  | "misc";

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
  allowWeb?: boolean; // CLI runners: allow WebSearch/WebFetch (for job research)
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
}

export interface RunnerInfo {
  id: string;
  label: string;
  kind: "cli" | "api";
  provider: string; // anthropic | openai | google | groq | mistral | openrouter | ollama | cursor | codex | gemini
  available: boolean;
  needsKey?: string; // secret name required (api runners)
  defaultModel?: string;
  detail?: string; // human note (version, why unavailable, etc.)
}

export interface AdapterResult {
  text: string;
  usage: Partial<Usage>; // adapter fills what it knows; runner computes the rest
  model: string;
}

export interface RunnerAdapter {
  id: string;
  info(): Promise<RunnerInfo>;
  run(req: RunRequest, model: string): Promise<AdapterResult>;
}
