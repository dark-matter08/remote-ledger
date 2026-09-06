// The job boards every install starts with.
//
// A board aggregates OTHER companies' openings, which is what makes it shippable:
// an employer's ATS feed is a personal bet on that company, but the same handful of
// boards is worth mining for anyone, so a fresh clone should not have to hand-enter
// a registry before its first crawl finds anything.
//
// `note` is not decoration — the careers crawl passes it to the agent verbatim as
// that board's rules (see crawl.server.ts), which is how Dice's robots.txt gets
// respected.
//
// The list itself lives in default-boards.json rather than in this file. Anyone
// running the Ledger can offer a board back (see services/contribute.server.ts), and
// a pull request that appends to a JSON array is three lines of data to read — where
// one that rewrites TypeScript would mean generating source on a stranger's machine
// and trusting it to still compile.
import boards from "./default-boards.json";

export interface DefaultBoard {
  name: string;
  url: string;
  note: string;
}

export const DEFAULT_BOARDS: DefaultBoard[] = boards;
