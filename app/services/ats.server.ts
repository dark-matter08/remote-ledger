// Company career pages, read straight from the source.
//
// Greenhouse, Lever, Ashby and Recruitee all publish every open role as public JSON
// with no key and no scraping. That makes this path categorically better than asking
// an agent to browse: it is exact, it costs nothing, hallucinated postings are
// impossible, and it is fast enough to poll often. The LLM is still needed to JUDGE
// a role against the candidate, but no longer to FIND one.
//
// Companies with a bespoke careers page have no such feed; those fall back to the
// agent (see the careers crawl in crawl.server.ts).
import { getDb } from "../sqlite.server";
import { detectBoard, ATS_KINDS, type AtsKind } from "../ats";

// re-exported so server callers need only one import
export { detectBoard, boardUrl, ATS_KINDS, type AtsKind } from "../ats";

export interface AtsPosting {
  title: string;
  url: string;
  location: string | null;
  /** null when the board does not say, which is not the same as "no". */
  remote: boolean | null;
  employmentType: string | null;
  description: string | null;
  updatedAt: string | null;
}

const UA = "the-remote-ledger (personal job tracker)";
const TIMEOUT_MS = 15_000;
const DESC_CAP = 4000;

async function getJson(url: string): Promise<any> {
  const r = await fetch(url, {
    headers: { "user-agent": UA, accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// Greenhouse ships job bodies as escaped HTML; the rest give plain text already.
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
const plain = (s: unknown): string | null =>
  typeof s === "string" && s.trim() ? s.replace(/\s+/g, " ").trim().slice(0, DESC_CAP) : null;

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

interface Adapter {
  board: (slug: string) => string;
  parse: (json: any) => AtsPosting[];
}

const ADAPTERS: Record<AtsKind, Adapter> = {
  greenhouse: {
    board: (s) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(s)}/jobs?content=true`,
    parse: (j) =>
      (Array.isArray(j?.jobs) ? j.jobs : []).map((x: any) => ({
        title: String(x?.title || "").trim(),
        url: String(x?.absolute_url || "").trim(),
        location: str(x?.location?.name),
        remote: null, // greenhouse has no remote flag; the location string is all we get
        employmentType: null,
        description: unhtml(x?.content),
        updatedAt: str(x?.updated_at),
      })),
  },
  lever: {
    board: (s) => `https://api.lever.co/v0/postings/${encodeURIComponent(s)}?mode=json`,
    parse: (j) =>
      (Array.isArray(j) ? j : []).map((x: any) => ({
        title: String(x?.text || "").trim(),
        url: String(x?.hostedUrl || "").trim(),
        location: str(x?.categories?.location),
        remote: typeof x?.workplaceType === "string" ? /remote/i.test(x.workplaceType) : null,
        employmentType: str(x?.categories?.commitment),
        description: plain(x?.descriptionPlain),
        updatedAt: x?.createdAt ? new Date(Number(x.createdAt)).toISOString() : null,
      })),
  },
  ashby: {
    board: (s) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(s)}`,
    parse: (j) =>
      (Array.isArray(j?.jobs) ? j.jobs : [])
        .filter((x: any) => x?.isListed !== false)
        .map((x: any) => ({
          title: String(x?.title || "").trim(),
          url: String(x?.jobUrl || x?.applyUrl || "").trim(),
          location: str(x?.location),
          remote:
            typeof x?.isRemote === "boolean"
              ? x.isRemote
              : typeof x?.workplaceType === "string"
                ? /remote/i.test(x.workplaceType)
                : null,
          employmentType: str(x?.employmentType),
          description: plain(x?.descriptionPlain),
          updatedAt: str(x?.publishedAt),
        })),
  },
  recruitee: {
    board: (s) => `https://${encodeURIComponent(s)}.recruitee.com/api/offers/`,
    parse: (j) =>
      (Array.isArray(j?.offers) ? j.offers : []).map((x: any) => ({
        title: String(x?.title || "").trim(),
        url: String(x?.careers_url || x?.careers_apply_url || "").trim(),
        location: str(x?.location) || [str(x?.city), str(x?.country_code)].filter(Boolean).join(", ") || null,
        remote: typeof x?.remote === "boolean" ? x.remote : null,
        employmentType: str(x?.employment_type_code),
        description: unhtml(x?.description),
        updatedAt: str(x?.published_at) || str(x?.created_at),
      })),
  },
};

/** Every currently open role on one company board. Throws if the board is gone. */
export async function fetchBoard(ats: AtsKind, slug: string): Promise<AtsPosting[]> {
  const a = ADAPTERS[ats];
  if (!a) throw new Error(`unknown ATS "${ats}"`);
  const postings = a.parse(await getJson(a.board(slug)));
  return postings.filter((p) => p.title && /^https?:\/\//.test(p.url));
}

// Board recognition lives in ../ats so the Settings UI can use it too.

// --- the company registry ---------------------------------------------------

export type CompanyKind = "company" | "board";

export interface Company {
  id: number;
  name: string;
  /** "board" is an aggregator we mine for other employers' postings, not an employer. */
  kind: CompanyKind;
  ats: AtsKind | null;
  slug: string | null;
  careers_url: string | null;
  active: number;
  last_checked_at: string | null;
  last_found: number;
  note: string | null;
  created_at: string;
}

export function listCompanies(): Company[] {
  return getDb()
    .prepare("SELECT * FROM companies ORDER BY active DESC, name COLLATE NOCASE")
    .all() as Company[];
}

export function activeCompanies(): Company[] {
  return listCompanies().filter((c) => c.active);
}

export function addCompany(o: {
  name: string;
  ats?: string | null;
  slug?: string | null;
  careersUrl?: string | null;
  note?: string | null;
  kind?: string | null;
}): { id: number; error?: string } {
  const name = (o.name || "").trim();
  if (!name) return { id: 0, error: "A company name is required." };

  let ats = ATS_KINDS.includes(o.ats as AtsKind) ? (o.ats as AtsKind) : null;
  let slug = (o.slug || "").trim().toLowerCase() || null;
  const careers = (o.careersUrl || "").trim() || null;

  // paste a board URL into either field and we work the rest out
  const detected = detectBoard(careers || "") || detectBoard(slug || "");
  if (!ats && detected) { ats = detected.ats; slug = detected.slug; }
  if (ats && !slug) return { id: 0, error: "That ATS needs a board slug." };
  if (!ats && !careers) return { id: 0, error: "Give either an ATS board or a careers page URL." };
  const kind: CompanyKind = o.kind === "board" ? "board" : "company";

  try {
    const id = Number(
      getDb()
        .prepare(
          "INSERT INTO companies (name,kind,ats,slug,careers_url,active,note,created_at) VALUES (?,?,?,?,?,1,?,?)"
        )
        .run(name, kind, ats, slug, careers, (o.note || "").trim() || null, new Date().toISOString()).lastInsertRowid
    );
    return { id };
  } catch (e: any) {
    if (String(e?.message || "").includes("UNIQUE")) return { id: 0, error: "That board is already tracked." };
    throw e;
  }
}

export function removeCompany(id: number): void {
  getDb().prepare("DELETE FROM companies WHERE id=?").run(id);
}
export function setCompanyActive(id: number, active: boolean): void {
  getDb().prepare("UPDATE companies SET active=? WHERE id=?").run(active ? 1 : 0, id);
}
export function markCompanyChecked(id: number, found: number): void {
  getDb()
    .prepare("UPDATE companies SET last_checked_at=?, last_found=? WHERE id=?")
    .run(new Date().toISOString(), found, id);
}

/**
 * Seed the registry from jobs already in the ledger. Every ATS posting you have
 * names its company's board, so the crawler starts with real companies instead of
 * an empty list and a form to fill in.
 */
export function bootstrapCompaniesFromJobs(): { scanned: number; added: number; boards: number } {
  const db = getDb();
  const rows = db.prepare("SELECT company, apply_url FROM jobs").all() as
    { company: string; apply_url: string }[];

  const found = new Map<string, { ats: AtsKind; slug: string; name: string }>();
  for (const r of rows) {
    const d = detectBoard(r.apply_url);
    if (!d) continue;
    const key = `${d.ats}:${d.slug}`;
    if (!found.has(key)) found.set(key, { ...d, name: (r.company || d.slug).trim() });
  }

  const have = new Set(
    (db.prepare("SELECT ats, slug FROM companies WHERE ats IS NOT NULL").all() as { ats: string; slug: string }[])
      .map((c) => `${c.ats}:${c.slug}`)
  );

  let added = 0;
  for (const [key, c] of found) {
    if (have.has(key)) continue;
    const r = addCompany({ name: c.name, ats: c.ats, slug: c.slug, note: "found in your ledger" });
    if (r.id) added++;
  }
  return { scanned: rows.length, added, boards: found.size };
}
