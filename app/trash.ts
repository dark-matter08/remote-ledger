// Client-safe trash vocabulary. Lives outside db.server.ts for the same reason
// ./stages does: the ledger card and the blocklist UI need these labels, and
// importing them from a *.server module would drag the DB layer into the browser
// bundle.

export type BlockScope = "job" | "company" | "domain";

// `rule` is the sentence the crawler is shown when this reason is fed back into the
// prompt, so it describes the posting rather than how irritating it was.
export const TRASH_REASONS: { code: string; label: string; rule: string }[] = [
  { code: "irrelevant", label: "Not relevant to me", rule: "off-target for the candidate's stack or interests" },
  { code: "availability", label: "Wrong about availability", rule: "advertised as open to the candidate's region when it is not" },
  { code: "not-remote", label: "Not actually remote", rule: "not genuinely remote (hybrid, or on-site with a remote label)" },
  { code: "seniority", label: "Seniority mismatch", rule: "aimed at a seniority the candidate is not targeting" },
  { code: "dead", label: "Dead or closed posting", rule: "already closed, filled, or expired" },
  { code: "agency", label: "Staffing agency / talent network", rule: "a staffing agency, talent network, or aggregator rather than a real employer posting" },
  { code: "other", label: "Other", rule: "unwanted" },
];

export const REASON_RULE = new Map(TRASH_REASONS.map((r) => [r.code, r.rule]));
export const REASON_LABEL = new Map(TRASH_REASONS.map((r) => [r.code, r.label]));

/** Hostname of an apply URL, or null when it will not parse. */
export function hostOf(url: string): string | null {
  try {
    return new URL(String(url)).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}
