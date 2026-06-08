// Shared types + Heritage-Press earth-tone palette for both graph engines.
export type NodeType = "self" | "skill" | "project" | "job" | "company" | "source" | "stage" | "qa" | "contact";
export interface GraphNode { id: string; type: NodeType; label: string; val: number; href?: string; detail?: string; meta?: Record<string, any>; x?: number; y?: number; }
export interface GraphLink { source: any; target: any; kind: string }
export interface GraphData { nodes: GraphNode[]; links: GraphLink[]; counts?: Record<string, number> }

// On-brand categorical colours (antique earth tones, not Obsidian neon).
export const TYPE_COLOR: Record<NodeType, string> = {
  self: "#b23a2e",     // vermillion — you
  skill: "#b8893a",    // ochre
  project: "#6f7a45",  // olive
  job: "#1a1714",      // ink — the dark hubs
  company: "#5a6b7a",  // slate
  source: "#9a8460",   // taupe
  stage: "#a64b3a",    // sienna
  qa: "#8c7e68",       // faint ink
  contact: "#7a5c8a",  // muted plum — recruiters/people
};

export const TYPE_LABEL: Record<NodeType, string> = {
  self: "You", skill: "Skills", project: "Projects", job: "Jobs",
  company: "Companies", source: "Sources", stage: "Stages", qa: "Answers", contact: "Contacts",
};

export function themeColors() {
  if (typeof window === "undefined") return { paper: "#efe6d2", ink: "#1a1714", ruleFaint: "#c8bba0", vermillion: "#b23a2e" };
  const cs = getComputedStyle(document.documentElement);
  const g = (n: string, f: string) => (cs.getPropertyValue(n).trim() || f);
  return {
    paper: g("--paper", "#efe6d2"),
    ink: g("--ink", "#1a1714"),
    ruleFaint: g("--rule-faint", "#c8bba0"),
    vermillion: g("--vermillion", "#b23a2e"),
  };
}
