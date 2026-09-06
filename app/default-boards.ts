// The job boards every install starts with.
//
// A board aggregates OTHER companies' openings, which is what makes it shippable:
// an employer's ATS feed is a personal bet on that company, but the same handful of
// boards is worth mining for anyone, so a fresh clone should not have to hand-enter
// a registry before its first crawl finds anything.
//
// `note` is not decoration — the careers crawl passes it to the agent verbatim as
// that board's rules (see crawl.server.ts), which is how Dice's robots.txt gets
// respected. Pure data, no imports, so the bootstrap in sqlite.server.ts can read it
// without a cycle.
export interface DefaultBoard {
  name: string;
  url: string;
  note: string;
}

export const DEFAULT_BOARDS: DefaultBoard[] = [
  {
    name: "Remotiko",
    url: "https://remotiko.com/",
    note: "remote roles open to Africa + worldwide",
  },
  {
    name: "Dynamite Jobs",
    url: "https://dynamitejobs.com/",
    note: "remote job board",
  },
  {
    name: "Dice",
    url: "https://www.dice.com/jobs",
    note:
      "robots.txt: /jobs and /job-detail are allowed; /jobs?q= and /jobs/?q= search URLs " +
      "and /apply-redirect* are disallowed. Browse the /jobs listing and follow /job-detail " +
      "links. Do not construct search-query URLs.",
  },
];
