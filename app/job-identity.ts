// What makes two crawl results the same job.
//
// The obvious answer — the `company--role` slug — is wrong, and the ledger has the
// scars to prove it. Titles reach us through the model that reads the board, so the
// same posting comes back written differently on different days:
//
//   "Senior Full Stack Engineer"            "Senior Full Stack Engineer (React/TypeScript)"
//   "Senior Software Engineer: … — MetaMask"  "Senior Software Engineer: … - MetaMask"
//   company "Consensys (MetaMask)"           company "Consensys"
//
// Every one of those mints a new slug, so a job the user had already applied to came
// back as a fresh row with no application against it. The apply URL, meanwhile, was
// byte-identical in all of them: it carries the board's own id for the posting.
//
// So identity is the apply URL, normalised — but only when the URL actually points at
// a posting. A bare careers or signup page is one URL shared by every role behind it,
// and keying on that would collapse unrelated jobs into one. When we cannot tell, we
// return null and the caller falls back to the slug, which is wrong slightly rather
// than wrong catastrophically.

// Params that describe how you arrived, not what you arrived at.
const TRACKING = /^(utm_|gh_src$|ref$|referer$|referrer$|src$|source$|campaign$|fbclid$|gclid$)/i;

/**
 * Does this look like a link to one specific posting, rather than a careers landing
 * page? Boards put an opaque id in the path or query — a Greenhouse number, an Ashby
 * UUID, a Jobot hash — so that is what we look for.
 */
function identifying(s: string): boolean {
  for (const tok of s.split(/[^0-9a-z]+/i)) {
    if (/^\d{4,}$/.test(tok)) return true; // greenhouse 7673273003, remotive …-4512
    // an opaque hex token (ashby uuid, jobot f1f1484906). Digits required, so ordinary
    // words that happen to use only a-f ("facade", "decade") are not mistaken for ids.
    if (tok.length >= 8 && /^[0-9a-f]+$/i.test(tok) && /\d/.test(tok)) return true;
  }
  return false;
}

/**
 * Stable identity for a posting, or null when the URL cannot provide one.
 *
 * Normalises the parts that drift between crawls (case, `www.`, trailing slash,
 * tracking params, param order) and keeps the parts that identify the job — including
 * query ids like `gh_jid`, which is the whole address on some boards.
 */
export function urlKey(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(String(raw || "").trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;

  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const path = u.pathname.replace(/\/+$/, "").toLowerCase();
  const params = [...u.searchParams.entries()]
    .filter(([k]) => !TRACKING.test(k))
    .map(([k, v]) => [k.toLowerCase(), v.toLowerCase()] as const)
    .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));

  const query = params.map(([k, v]) => `${k}=${v}`).join("&");
  if (!identifying(`${path}${query ? `?${query}` : ""}`)) return null;
  return `${host}${path}${query ? `?${query}` : ""}`;
}
