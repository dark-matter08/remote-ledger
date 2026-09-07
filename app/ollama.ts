// The local-model shelf: what to install, and what each one is actually good for.
//
// Client-safe on purpose — the settings tab renders this list, and React Router only
// strips server code out of loader/action, not out of a component's imports.
//
// A word on "capabilities". Ollama serves weights; it does not give a model the
// internet. `tools` means the model was trained to emit function calls, which is what
// the Ledger needs for structured work — it does NOT mean the model can browse. The
// crawl reads job boards over the network, so it still wants a runner with web access
// (a CLI agent, or a hosted API). Everything downstream of the crawl — scoring,
// tailoring, cover letters, interview prep — runs happily on a local model.

export type OllamaCapability = "tools" | "vision" | "reasoning" | "code" | "embedding";

export const CAPABILITY_LABEL: Record<OllamaCapability, string> = {
  tools: "Tools",
  vision: "Vision",
  reasoning: "Reasoning",
  code: "Code",
  embedding: "Embeddings",
};

export const CAPABILITY_BLURB: Record<OllamaCapability, string> = {
  tools: "Emits structured function calls — what the Ledger needs to score and tailor reliably.",
  vision: "Reads images. Useful for a screenshotted posting or a PDF page.",
  reasoning: "Thinks step by step before answering. Slower, better on judgement calls.",
  code: "Tuned on source. Sharper when your résumé is engineering-heavy.",
  embedding: "Turns text into vectors. Not a chat model — it cannot answer prompts.",
};

export interface OllamaModel {
  /** The exact `ollama pull` tag. */
  id: string;
  label: string;
  params: string;
  /** Download size in GB, as published. */
  sizeGb: number;
  /** Rough RAM the model wants resident, in GB. */
  ramGb: number;
  caps: OllamaCapability[];
  /** What this one is for, in the Ledger's terms. */
  blurb: string;
}

// Curated rather than fetched: Ollama publishes no stable machine-readable library
// index, and a scraped page would rot silently. These are long-lived tags. Anything
// missing can still be pulled by name — the tab takes free text too.
export const OLLAMA_MODELS: OllamaModel[] = [
  {
    id: "llama3.2:3b",
    label: "Llama 3.2",
    params: "3B",
    sizeGb: 2.0,
    ramGb: 4,
    caps: ["tools"],
    blurb: "The smallest model here that still calls tools properly. Start here on a laptop.",
  },
  {
    id: "qwen2.5:7b",
    label: "Qwen 2.5",
    params: "7B",
    sizeGb: 4.7,
    ramGb: 8,
    caps: ["tools", "code"],
    blurb: "The best all-rounder at this size. Good default once you have the RAM for it.",
  },
  {
    id: "qwen2.5:3b",
    label: "Qwen 2.5",
    params: "3B",
    sizeGb: 1.9,
    ramGb: 4,
    caps: ["tools", "code"],
    blurb: "Qwen's reasoning in a size that leaves room for everything else you have open.",
  },
  {
    id: "llama3.1:8b",
    label: "Llama 3.1",
    params: "8B",
    sizeGb: 4.7,
    ramGb: 8,
    caps: ["tools"],
    blurb: "Reliable, widely tested, long context. A safe pick for tailoring résumés.",
  },
  {
    id: "mistral:7b",
    label: "Mistral",
    params: "7B",
    sizeGb: 4.1,
    ramGb: 8,
    caps: ["tools"],
    blurb: "Fast and terse. Writes cover letters that need less trimming.",
  },
  {
    id: "phi3.5:3.8b",
    label: "Phi 3.5",
    params: "3.8B",
    sizeGb: 2.2,
    ramGb: 4,
    caps: ["tools"],
    blurb: "Punches above its size on structured output. Weak on open-ended prose.",
  },
  {
    id: "deepseek-r1:7b",
    label: "DeepSeek R1",
    params: "7B",
    sizeGb: 4.7,
    ramGb: 8,
    caps: ["reasoning", "tools"],
    blurb: "Reasons before it answers. Worth the wait for match scoring and interview prep.",
  },
  {
    id: "deepseek-r1:1.5b",
    label: "DeepSeek R1",
    params: "1.5B",
    sizeGb: 1.1,
    ramGb: 3,
    caps: ["reasoning"],
    blurb: "Reasoning on a very small budget. Fine for scoring, thin for writing.",
  },
  {
    id: "qwen2.5-coder:7b",
    label: "Qwen 2.5 Coder",
    params: "7B",
    sizeGb: 4.7,
    ramGb: 8,
    caps: ["code", "tools"],
    blurb: "Reads a codebase the way a reviewer would — the one to use for repo scans.",
  },
  {
    id: "llama3.2-vision:11b",
    label: "Llama 3.2 Vision",
    params: "11B",
    sizeGb: 7.9,
    ramGb: 12,
    caps: ["vision"],
    blurb: "Reads a screenshotted posting or a scanned CV page. Needs real memory.",
  },
  {
    id: "llava:7b",
    label: "LLaVA",
    params: "7B",
    sizeGb: 4.7,
    ramGb: 8,
    caps: ["vision"],
    blurb: "The established open vision model. Good enough to read a job ad from an image.",
  },
  {
    id: "moondream:1.8b",
    label: "Moondream",
    params: "1.8B",
    sizeGb: 1.7,
    ramGb: 3,
    caps: ["vision"],
    blurb: "Tiny vision model. Surprisingly capable at reading text out of a screenshot.",
  },
  {
    id: "nomic-embed-text",
    label: "Nomic Embed",
    params: "137M",
    sizeGb: 0.3,
    ramGb: 1,
    caps: ["embedding"],
    blurb: "Cheap semantic search over your knowledge base. Cannot chat — pair it with one above.",
  },
];

/** Fits comfortably in the machine's memory, with room for the rest of the desktop. */
export function fitsInRam(model: OllamaModel, totalRamGb: number): boolean {
  return totalRamGb > 0 ? model.ramGb <= totalRamGb - 2 : true;
}

/** What we suggest first, given the machine. Biggest tool-capable model that fits. */
/**
 * The model to suggest for this machine.
 *
 * Not simply the biggest that fits. On a modest laptop the largest model that
 * technically fits is the one that makes the app feel broken — every score, every
 * tailored bullet, every drafted answer waits on it, and a first-time user reads slow
 * as broken and stops. Below the comfortable line, capability is worth less than
 * finishing.
 *
 * Above ~16 GB there is headroom for the largest that fits. Below it, the pick is the
 * best model that leaves room to actually run — roughly half the machine's memory,
 * since the OS and a browser want the rest.
 */
export function recommendedModel(totalRamGb: number): OllamaModel {
  const usable = OLLAMA_MODELS.filter(
    (m) => m.caps.includes("tools") && !m.caps.includes("embedding") && fitsInRam(m, totalRamGb)
  );
  if (!usable.length) return OLLAMA_MODELS[0];
  // sizeGb is a decent proxy for capability inside this shelf
  const bySize = [...usable].sort((a, b) => b.sizeGb - a.sizeGb);
  if (totalRamGb >= 16) return bySize[0];
  const comfortable = bySize.filter((m) => m.ramGb <= totalRamGb / 2);
  return comfortable[0] ?? bySize[bySize.length - 1];
}

/** Will this be slow enough here to be worth warning about before it is downloaded? */
export function willBeSlow(model: OllamaModel, totalRamGb: number): boolean {
  return totalRamGb > 0 && model.ramGb > totalRamGb / 2;
}

/** `llama3.2:3b` and `llama3.2:3b` from /api/tags ("llama3.2:3b") are the same thing. */
export function sameModel(a: string, b: string): boolean {
  const norm = (s: string) => String(s || "").trim().toLowerCase().replace(/:latest$/, "");
  return norm(a) === norm(b);
}

export function prettyBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/**
 * Ollama's pull status is machine talk — "pulling 2bada8a74506" names the layer being
 * fetched, which changes several times per download and means nothing to the reader.
 * Turn it into the phase they actually care about.
 */
export function pullPhase(status: string): string {
  const s = String(status || "").toLowerCase().trim();
  if (!s) return "starting";
  if (s.includes("manifest")) return "resolving";
  if (s.startsWith("pulling")) return "downloading";
  if (s.includes("verifying")) return "verifying";
  if (s.includes("writing")) return "writing";
  if (s.includes("digest")) return "verifying";
  if (s === "success" || s === "done") return "done";
  if (s.includes("exist")) return "already here";
  return s;
}
