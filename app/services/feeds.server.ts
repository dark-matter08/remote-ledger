// Remote-job feeds that are free, keyless, and machine-readable.
//
// The find crawl was built around an agent that searches the web, which is only
// true of a CLI runner holding WebSearch. An API runner (OpenRouter, Groq, an
// OpenAI-compatible endpoint) has no tools at all, so when it is told to "search
// the job boards" the only thing it can do is invent postings — and link
// verification then drops every one, spending a whole run to save nothing.
//
// These boards publish their entire listing as public JSON, no key and no scraping,
// which turns discovery back into reading a feed: exact, free, and impossible to
// hallucinate. It is the bet ats.server.ts makes about one company's own board,
// made one layer out across every employer at once. The model is still wanted to
// JUDGE a role, but it is no longer the thing that has to FIND one.
//
// A feed entry links to the BOARD's page, not the employer's. That is expected, not
// a defect: verifyJobs → resolveLive follows an aggregator through to the real
// application page and drops whatever never gets there (scrape.server.ts). Each of
// these boards asks to be credited as the source of a listing, which is what the
// `source` field carries into the ledger and onto the job card.
import type { AtsPosting } from "./ats.server";

/** An AtsPosting plus who is hiring and which board it was read from. */
export interface FeedPosting extends AtsPosting {
  company: string;
  source: string;
}

const UA = "the-remote-ledger (personal job tracker)";
const TIMEOUT_MS = 20_000;
const DESC_CAP = 4000;
const MAX_PER_FEED = 150;

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

// Every one of these ships descriptions as HTML.
function unhtml(s: unknown): string | null {
  if (typeof s !== "string" || !s) return null;
  const txt = s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return txt ? txt.slice(0, DESC_CAP) : null;
}

/** Feeds hand back locations as a string, a list, or nothing at all. */
function place(v: unknown): string | null {
  if (Array.isArray(v)) {
    const parts = v.map((x) => str(x)).filter(Boolean);
    return parts.length ? parts.join(", ") : null;
  }
  return str(v);
}

const first = (v: unknown): string | null => (Array.isArray(v) ? str(v[0]) : str(v));

// Boards date postings in seconds since the epoch as often as they do in ISO.
function when(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  if (/^\d{9,11}$/.test(s)) return new Date(Number(s) * 1000).toISOString();
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

interface Feed {
  id: string;
  name: string;
  url: string;
  parse: (json: any) => FeedPosting[];
}

// Remote-only boards, so `remote` is true by construction rather than by guessing
// at a location string. Ordering here is the order they are read in.
export const FEEDS: Feed[] = [
  {
    id: "remoteok",
    name: "RemoteOK",
    url: "https://remoteok.com/api",
    // element 0 is the API's legal notice, not a job — hence the title guard
    parse: (j) =>
      (Array.isArray(j) ? j : [])
        .filter((x: any) => str(x?.position) && str(x?.company))
        .map((x: any) => ({
          company: String(x.company).trim(),
          source: "RemoteOK",
          title: String(x.position).trim(),
          url: String(x?.url || x?.apply_url || "").trim(),
          location: place(x?.location),
          remote: true,
          employmentType: null,
          description: unhtml(x?.description),
          descriptionHtml: null, // verification fetches the employer's own page anyway
          updatedAt: when(x?.date) || when(x?.epoch),
        })),
  },
  {
    id: "remotive",
    name: "Remotive",
    url: "https://remotive.com/api/remote-jobs",
    parse: (j) =>
      (Array.isArray(j?.jobs) ? j.jobs : []).map((x: any) => ({
        company: String(x?.company_name || "").trim(),
        source: "Remotive",
        title: String(x?.title || "").trim(),
        url: String(x?.url || "").trim(),
        location: place(x?.candidate_required_location),
        remote: true,
        employmentType: str(x?.job_type),
        description: unhtml(x?.description),
        descriptionHtml: null,
        updatedAt: when(x?.publication_date),
      })),
  },
  {
    id: "himalayas",
    name: "Himalayas",
    url: "https://himalayas.app/jobs/api?limit=100",
    parse: (j) =>
      (Array.isArray(j?.jobs) ? j.jobs : []).map((x: any) => ({
        company: String(x?.companyName || "").trim(),
        source: "Himalayas",
        title: String(x?.title || "").trim(),
        url: String(x?.applicationLink || x?.guid || "").trim(),
        location: place(x?.locationRestrictions),
        remote: true,
        employmentType: str(x?.employmentType),
        description: unhtml(x?.description) || unhtml(x?.excerpt),
        descriptionHtml: null,
        updatedAt: when(x?.pubDate),
      })),
  },
  {
    id: "jobicy",
    name: "Jobicy",
    url: "https://jobicy.com/api/v2/remote-jobs?count=50",
    parse: (j) =>
      (Array.isArray(j?.jobs) ? j.jobs : []).map((x: any) => ({
        company: String(x?.companyName || "").trim(),
        source: "Jobicy",
        title: String(x?.jobTitle || "").trim(),
        url: String(x?.url || "").trim(),
        location: place(x?.jobGeo),
        remote: true,
        employmentType: first(x?.jobType),
        description: unhtml(x?.jobDescription) || unhtml(x?.jobExcerpt),
        descriptionHtml: null,
        updatedAt: when(x?.pubDate),
      })),
  },
];

/** Postings from one board. Throws if the feed is down or unreadable. */
export async function fetchFeed(feed: Feed, signal?: AbortSignal): Promise<FeedPosting[]> {
  const r = await fetch(feed.url, {
    headers: { "user-agent": UA, accept: "application/json" },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const parsed = feed.parse(await r.json());
  // a row with no employer or nowhere to apply cannot survive verification anyway
  return parsed.filter((p) => p.company && p.title && /^https?:\/\//.test(p.url)).slice(0, MAX_PER_FEED);
}

export interface FeedSweep {
  postings: FeedPosting[];
  perFeed: { name: string; count: number }[];
  errors: { name: string; error: string }[];
}

/**
 * Read every board at once. One board being down is a smaller result, never a
 * failed crawl, so each is settled independently.
 */
export async function fetchAllFeeds(signal?: AbortSignal): Promise<FeedSweep> {
  const results = await Promise.allSettled(FEEDS.map((f) => fetchFeed(f, signal)));
  const postings: FeedPosting[] = [];
  const perFeed: FeedSweep["perFeed"] = [];
  const errors: FeedSweep["errors"] = [];
  results.forEach((res, i) => {
    const feed = FEEDS[i];
    if (res.status === "fulfilled") {
      perFeed.push({ name: feed.name, count: res.value.length });
      postings.push(...res.value);
    } else {
      errors.push({ name: feed.name, error: String(res.reason?.message || res.reason).slice(0, 120) });
    }
  });
  return { postings: dedupe(postings), perFeed, errors };
}

// The same posting is syndicated to several boards, and paying to score it four
// times would be the whole saving given back. First board to carry it wins.
function dedupe(postings: FeedPosting[]): FeedPosting[] {
  const seen = new Set<string>();
  const out: FeedPosting[] = [];
  for (const p of postings) {
    const key = `${p.company.toLowerCase().replace(/[^a-z0-9]+/g, "")}::${p.title.toLowerCase().replace(/[^a-z0-9]+/g, "")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}
