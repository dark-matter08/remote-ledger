// The quick filters above the board.
//
// They used to be three hardcoded groups — Node/TS, Infra, AI/LLM — which were the right
// filters for exactly one kind of job hunt and furniture for every other. A designer's
// board offered to narrow by Kubernetes. This is the last of the developer assumptions
// that fields.ts was written to remove; see that file for the same argument at length.
//
// Two rules make the derived version usable rather than merely honest:
//
//   1. A tag that matches nothing on the board is not a filter, it is a dead button. So
//      they are counted against the postings actually on screen and the empty ones are
//      dropped.
//   2. Ranked by that count and capped. A profile may list twenty skills; twenty chips
//      is not a filter bar, and the six that match two jobs each are not the ones you
//      reach for.

export interface StackTag {
  label: string;
  test: RegExp;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whole-word, so "Go" does not match "Django" and "R" does not match everything.
 *
 * With one accommodation: a tool whose name ends in JS is written three ways and people
 * do not agree on which. Measured against the 177 postings on this install, matching the
 * user's "NodeJS" literally found **1**; allowing Node / Node.js / NodeJS found **80**.
 * "ReactJS" found 1 against 101. "NextJS" found 0 against 20. Every one of those extra
 * matches was the real technology — the postings write stacks as `React · Node · TS`, and
 * there were no false hits at all, not one "next" used as an English word.
 *
 * So a keyword is matched on its stem with the suffix optional. Nothing broader: this is
 * one naming inconsistency in one family of names, not a general fuzzy match.
 */
function wordTest(word: string): RegExp {
  const stem = word.match(/^(.+?)[ .]?js$/i)?.[1];
  return stem && stem.length > 1
    ? new RegExp(`\\b${escape(stem)}(?:[ .]?js)?\\b`, "i")
    : new RegExp(`\\b${escape(word)}\\b`, "i");
}

/**
 * Build the filter chips from the keywords this profile searches for, keeping only those
 * that match something on the board, most-matched first.
 *
 * `keywords` is the profile's own `stack` field — the comma-separated list the user typed
 * in Settings, which is also what the crawl searches for. Same source, so a filter cannot
 * offer something the search would never bring back.
 */
export function stackTagsFor(keywords: string, haystacks: string[], limit = 4): StackTag[] {
  const seen = new Set<string>();
  const words = keywords
    .split(/[,;|\n]/)
    .map((w) => w.trim())
    .filter((w) => w.length > 1)
    .filter((w) => {
      const k = w.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

  return words
    .map((label) => {
      const test = wordTest(label);
      return { label, test, n: haystacks.filter((h) => test.test(h)).length };
    })
    .filter((t) => t.n > 0)
    .sort((a, b) => b.n - a.n || a.label.localeCompare(b.label))
    .slice(0, limit)
    .map(({ label, test }) => ({ label, test }));
}
