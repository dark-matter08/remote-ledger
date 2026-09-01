// Client-safe ATS vocabulary: the kinds, the human-facing board URL, and board
// recognition. All pure, so the Settings UI can use them without importing
// ats.server.ts — React Router only strips server code from loader/action, so a
// component-level import of a *.server module breaks the client build.

export type AtsKind = "greenhouse" | "lever" | "ashby" | "recruitee";
export const ATS_KINDS: AtsKind[] = ["greenhouse", "lever", "ashby", "recruitee"];

const HUMAN: Record<AtsKind, (slug: string) => string> = {
  greenhouse: (s) => `https://job-boards.greenhouse.io/${s}`,
  lever: (s) => `https://jobs.lever.co/${s}`,
  ashby: (s) => `https://jobs.ashbyhq.com/${s}`,
  recruitee: (s) => `https://${s}.recruitee.com`,
};

/** Where a person would go to see this board. */
export function boardUrl(ats: AtsKind, slug: string): string {
  return (HUMAN[ats] || ((s: string) => s))(slug);
}

// Every ATS posting already in the ledger names its company's board, which is how
// the registry seeds itself instead of starting empty.
const PATTERNS: { ats: AtsKind; re: RegExp }[] = [
  { ats: "greenhouse", re: /(?:job-)?boards(?:-api)?\.greenhouse\.io\/(?:embed\/job_app\?for=)?([a-z0-9_-]+)/i },
  { ats: "lever", re: /jobs\.lever\.co\/([a-z0-9_-]+)/i },
  { ats: "ashby", re: /jobs\.ashbyhq\.com\/([a-z0-9_.-]+)/i },
  { ats: "recruitee", re: /([a-z0-9-]+)\.recruitee\.com/i },
];

export function detectBoard(url: string): { ats: AtsKind; slug: string } | null {
  for (const { ats, re } of PATTERNS) {
    const m = re.exec(String(url || ""));
    if (m?.[1]) return { ats, slug: m[1].toLowerCase() };
  }
  return null;
}
