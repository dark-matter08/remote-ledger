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
import { type JobField } from "../fields";

/** An AtsPosting plus who is hiring and which board it was read from. */
export interface FeedPosting extends AtsPosting {
  company: string;
  source: string;
  /**
   * How the board itself classified this posting.
   *
   * Every one of these feeds labels its own jobs and the app used to drop the lot:
   * RemoteOK tags them ("customer support", "non tech"), Remotive gives a category
   * ("Customer Service"), Himalayas a parentCategory ("Developer"), Jobicy an
   * industry ("Customer Support & Success"). Relevance was left guessing from the
   * title alone when the board had already answered the question.
   */
  categories: string[];
}

const UA = "the-remote-ledger (personal job tracker)";
const TIMEOUT_MS = 20_000;
const DESC_CAP = 4000;
const MAX_PER_FEED = 150;

/** Boards send titles and company names HTML-encoded — "1840 &#038; Company". */
function entities(s: string): string {
  return s
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#0?38;|&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? entities(v).trim() : null;

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

/** Board labels, in whatever shape that board sends them. */
function labels(...vals: unknown[]): string[] {
  const out: string[] = [];
  for (const v of vals) {
    if (Array.isArray(v)) for (const x of v) { const s = str(x); if (s) out.push(s); }
    else { const s = str(v); if (s) out.push(s); }
  }
  return [...new Set(out.map((s) => s.replace(/[-_]+/g, " ")))].slice(0, 12);
}

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
  /** The whole board, unfiltered. Always valid, always the fallback. */
  url: string;
  /**
   * The same board narrowed to one field, where that board takes a parameter and the
   * parameter was actually verified to work. Returning null means "no filter for this
   * field here" — a guessed slug comes back with zero jobs and looks like an outage.
   */
  fieldUrl?: (field: JobField) => string | null;
  parse: (json: any) => FeedPosting[];
}

// Remote-only boards, so `remote` is true by construction rather than by guessing
// at a location string. Ordering here is the order they are read in.
export const FEEDS: Feed[] = [
  {
    id: "remoteok",
    name: "RemoteOK",
    url: "https://remoteok.com/api",
    // No fieldUrl and no categories, both deliberate and both measured:
    //   · `?tag=customer support` and `?tag=dev` return the identical 99 postings,
    //     so the parameter is ignored and using it would only look like a filter.
    //   · Its tags are auto-applied and wrong off the tech path — "Kitchen Technician"
    //     comes tagged [payroll, vfx, customer support], "Police Officer" [education,
    //     customer support]. Trusting them as a classification kept 158 of 185
    //     postings for a support search and put a visual merchandiser in front of a
    //     backend engineer. The other three boards publish a real taxonomy; this one
    //     publishes keywords, so here the title is all we go on.
    // element 0 is the API's legal notice, not a job — hence the title guard
    parse: (j) =>
      (Array.isArray(j) ? j : [])
        .filter((x: any) => str(x?.position) && str(x?.company))
        .map((x: any) => ({
          company: entities(String(x.company)).trim(),
          source: "RemoteOK",
          title: entities(String(x.position)).trim(),
          url: String(x?.url || x?.apply_url || "").trim(),
          location: place(x?.location),
          remote: true,
          employmentType: null,
          description: unhtml(x?.description),
          descriptionHtml: null, // verification fetches the employer's own page anyway
          updatedAt: when(x?.date) || when(x?.epoch),
          categories: [],
        })),
  },
  {
    id: "remotive",
    name: "Remotive",
    url: "https://remotive.com/api/remote-jobs",
    fieldUrl: (f) =>
      f.feed?.remotive ? `https://remotive.com/api/remote-jobs?category=${f.feed.remotive}` : null,
    parse: (j) =>
      (Array.isArray(j?.jobs) ? j.jobs : []).map((x: any) => ({
        company: entities(String(x?.company_name || "")).trim(),
        source: "Remotive",
        title: entities(String(x?.title || "")).trim(),
        url: String(x?.url || "").trim(),
        location: place(x?.candidate_required_location),
        remote: true,
        employmentType: str(x?.job_type),
        description: unhtml(x?.description),
        descriptionHtml: null,
        updatedAt: when(x?.publication_date),
        categories: labels(x?.category),
      })),
  },
  {
    id: "himalayas",
    name: "Himalayas",
    url: "https://himalayas.app/jobs/api?limit=100",
    parse: (j) =>
      (Array.isArray(j?.jobs) ? j.jobs : []).map((x: any) => ({
        company: entities(String(x?.companyName || "")).trim(),
        source: "Himalayas",
        title: entities(String(x?.title || "")).trim(),
        url: String(x?.applicationLink || x?.guid || "").trim(),
        location: place(x?.locationRestrictions),
        remote: true,
        employmentType: str(x?.employmentType),
        description: unhtml(x?.description) || unhtml(x?.excerpt),
        descriptionHtml: null,
        updatedAt: when(x?.pubDate),
        // parentCategories is the coarse one (Design, Developer, Marketing,
        // Operations, Product, Sales); categories is per-role and very long-tailed
        categories: labels(x?.parentCategories, x?.categories),
      })),
  },
  {
    id: "jobicy",
    name: "Jobicy",
    url: "https://jobicy.com/api/v2/remote-jobs?count=50",
    fieldUrl: (f) =>
      f.feed?.jobicy ? `https://jobicy.com/api/v2/remote-jobs?count=50&industry=${f.feed.jobicy}` : null,
    parse: (j) =>
      (Array.isArray(j?.jobs) ? j.jobs : []).map((x: any) => ({
        company: entities(String(x?.companyName || "")).trim(),
        source: "Jobicy",
        title: entities(String(x?.jobTitle || "")).trim(),
        url: String(x?.url || "").trim(),
        location: place(x?.jobGeo),
        remote: true,
        employmentType: first(x?.jobType),
        description: unhtml(x?.jobDescription) || unhtml(x?.jobExcerpt),
        descriptionHtml: null,
        updatedAt: when(x?.pubDate),
        categories: labels(x?.jobIndustry, x?.jobType),
      })),
  },
];

async function readFeed(feed: Feed, url: string, signal?: AbortSignal): Promise<FeedPosting[]> {
  const r = await fetch(url, {
    headers: { "user-agent": UA, accept: "application/json" },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const parsed = feed.parse(await r.json());
  // a row with no employer or nowhere to apply cannot survive verification anyway
  return parsed.filter((p) => p.company && p.title && /^https?:\/\//.test(p.url)).slice(0, MAX_PER_FEED);
}

/**
 * Postings from one board, narrowed to a field where the board can do it.
 *
 * Asking the board for the right jobs beats asking for everything and discarding 80%
 * of it: the pool that comes back is bigger in the part that matters and costs the
 * same one request. But a filter is only worth using if it works — a slug the board
 * does not recognise returns an empty list that is indistinguishable from an outage,
 * so an empty targeted read falls back to the whole board rather than reporting zero.
 *
 * Throws only if the unfiltered read fails; that is a real outage.
 */
export async function fetchFeed(
  feed: Feed,
  signal?: AbortSignal,
  field?: JobField | null
): Promise<FeedPosting[]> {
  const targeted = field ? feed.fieldUrl?.(field) : null;
  if (targeted) {
    try {
      const narrowed = await readFeed(feed, targeted, signal);
      if (narrowed.length) return narrowed;
    } catch {
      // the board may not know this parameter at all; the broad read below is the answer
    }
  }
  return readFeed(feed, feed.url, signal);
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
export async function fetchAllFeeds(
  signal?: AbortSignal,
  field?: JobField | null
): Promise<FeedSweep> {
  const results = await Promise.allSettled(FEEDS.map((f) => fetchFeed(f, signal, field)));
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
