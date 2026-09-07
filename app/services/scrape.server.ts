// Scrape a job posting page (SPA-aware via Playwright) and save the full job
// description + page info. This is what makes the engine collect everything that's
// on the application page, not just the index row from the crawl.
import { getDb } from "../sqlite.server";
import { getJob, setJd, addEvent } from "../db.server";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

// JS-heavy SPA ATSes hydrate their content client-side and need longer to paint;
// give them extra render time so we don't misread a live posting as "thin".
const SLOW_ATS = /(ashbyhq|greenhouse|lever\.co|workable|myworkdayjobs|workday|smartrecruiters|icims|inhire|teamtailor|recruitee|bamboohr|breezy|jobvite|pinpointhq|rippling|join\.com)/i;
export const renderWaitFor = (url: string): number => (SLOW_ATS.test(url) ? 5000 : 3000);

export interface Scraped {
  title: string;
  text: string;
  html: string; // sanitized rich markup of the JD container (empty if unavailable)
  ok: boolean;
  error?: string;
}

function clean(text: string): string {
  return text
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 20000);
}

// Picks the JD container in the page and returns its text + raw innerHTML.
// Runs inside the browser (page.evaluate), so it can only use DOM globals.
const PICK_JD = () => {
  const cands = [
    "#job-description", ".job-description", "[data-testid*=description]",
    "[class*=description]", "[class*=posting]", "[class*=job-details]",
    "article", "main", "[role=main]", "[class*=job]", ".content",
  ];
  let best: HTMLElement | null = null;
  let bestLen = 0;
  for (const s of cands) {
    const el = document.querySelector(s) as HTMLElement | null;
    if (el) {
      const t = el.innerText || "";
      if (t.length > bestLen) { bestLen = t.length; best = el; }
    }
  }
  const body = document.body;
  if (!best || bestLen < 200) best = body;
  const meta = (document.querySelector('meta[name="description"]') as HTMLMetaElement | null)?.content || "";
  return {
    title: document.title,
    meta,
    text: best.innerText || "",
    html: best.innerHTML || "",
    bodyText: body.innerText || "",
  };
};

// Whitelist sanitizer: keeps the posting's structure (headings, lists, tables,
// emphasis, links, images) but drops scripts/styles/event handlers and every
// presentational attribute (style/class/color/bgcolor) so the JD always renders
// in our Heritage Press skin on paper — never the source site's chrome.
const ALLOWED = new Set([
  "h1","h2","h3","h4","h5","h6","p","br","hr","strong","b","em","i","u","s","small","sub","sup","mark",
  "ul","ol","li","dl","dt","dd","blockquote","a","img","figure","figcaption",
  "table","thead","tbody","tfoot","tr","td","th","caption","colgroup","col",
  "code","pre","span","div","section","article","details","summary",
]);

export function sanitizeJdHtml(html: string): string {
  if (!html) return "";
  let out = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|template|svg|head|link|meta|iframe|object|embed|form|input|button|select|textarea|nav|header|footer|video|audio|canvas)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<(script|style|link|meta|iframe|object|embed|input|br|hr|img|col)\b[^>]*\/?>/gi, (m, tag) =>
      /^(br|hr|img|col)$/i.test(tag) ? m : ""
    );
  out = out.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (_m, rawTag: string, attrs: string) => {
    const tag = rawTag.toLowerCase();
    if (!ALLOWED.has(tag)) return ""; // drop the tag wrapper, keep its inner text
    const closing = /^<\//.test(_m);
    if (closing) return `</${tag}>`;
    const selfClose = /\/>$/.test(_m) || /^(br|hr|img|col)$/.test(tag);
    let keep = "";
    if (tag === "a") {
      const href = /href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
      const url = href ? (href[2] || href[3] || href[4] || "").trim() : "";
      if (/^(https?:|mailto:)/i.test(url)) keep = ` href="${url.replace(/"/g, "&quot;")}" target="_blank" rel="noopener noreferrer"`;
    } else if (tag === "img") {
      const src = /src\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
      const url = src ? (src[2] || src[3] || src[4] || "").trim() : "";
      const alt = /alt\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs);
      if (/^https?:/i.test(url)) keep = ` src="${url.replace(/"/g, "&quot;")}"${alt ? ` alt="${(alt[2] || alt[3] || "").replace(/"/g, "&quot;")}"` : ""} loading="lazy"`;
      else return "";
    } else if (tag === "td" || tag === "th") {
      const cs = /colspan\s*=\s*"?(\d+)"?/i.exec(attrs);
      const rs = /rowspan\s*=\s*"?(\d+)"?/i.exec(attrs);
      if (cs) keep += ` colspan="${cs[1]}"`;
      if (rs) keep += ` rowspan="${rs[1]}"`;
    }
    return `<${tag}${keep}${selfClose ? " /" : ""}>`;
  });
  // collapse empty wrappers left behind and runaway whitespace
  out = out.replace(/(\s*<(?:div|span|p)>\s*<\/(?:div|span|p)>)+/gi, "").replace(/\n{3,}/g, "\n\n");
  return out.trim().slice(0, 120000);
}

// Strip tags as a last-resort fallback if the browser can't reach the page.
async function fetchFallback(url: string): Promise<Scraped> {
  try {
    const res = await fetch(url, { headers: { "user-agent": UA } });
    const html = await res.text();
    const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || "";
    const bodyHtml = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] || html;
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&[a-z]+;/gi, " ");
    return { title, text: clean(text), html: sanitizeJdHtml(bodyHtml), ok: res.ok };
  } catch (e: any) {
    return { title: "", text: "", html: "", ok: false, error: e.message };
  }
}

/**
 * A page that embeds a Greenhouse job, read from Greenhouse instead.
 *
 * Plenty of employers host the posting on their own careers page and let a script
 * paint the real content in afterwards. Waiting for that is a race nobody wins
 * reliably: jamasoftware.com/company/careers/posting/8164690 renders 2.8k of chrome
 * and navigation, and the posting itself — 5.2k, the part with the job in it —
 * arrives later, or not at all under a headless browser.
 *
 * The embed names its own board (`job_board/js?for=jamasoftware`) and the URL names
 * the job (`gh_jid=8164690`), which is everything needed to ask Greenhouse directly
 * through the same public API the careers crawl already reads. Exact, complete, and
 * with no timing in it at all.
 */
async function greenhouseEmbed(url: string): Promise<Scraped | null> {
  // /<board>/jobs/<id> on greenhouse itself, or ?gh_jid= on somebody else's page
  const direct = /(?:job-)?boards\.greenhouse\.io\/([A-Za-z0-9_-]+)\/jobs\/(\d+)/i.exec(url);
  let board = direct?.[1] || "";
  const id = direct?.[2] || /[?&]gh_jid=(\d+)/i.exec(url)?.[1] || "";
  if (!id) return null;

  if (!board) {
    try {
      const r = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) return null;
      board = /job_board\/js\?for=([A-Za-z0-9_-]+)/i.exec(await r.text())?.[1] || "";
    } catch {
      return null;
    }
  }
  if (!board) return null;

  try {
    const api = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs/${encodeURIComponent(id)}?content=true`;
    const r = await fetch(api, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) return null;
    const j: any = await r.json();
    // greenhouse escapes the body; unescaping gives back the markup, and stripping
    // that gives the text
    const markup = String(j?.content || "")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
    const text = clean(markup.replace(/<[^>]+>/g, " "));
    if (text.length < 200) return null;
    const where = j?.location?.name ? ` · ${j.location.name}` : "";
    return { title: `${String(j?.title || "").trim()}${where}`, text, html: sanitizeJdHtml(markup), ok: true };
  } catch {
    return null;
  }
}

/**
 * Wait for the page to stop changing, rather than for a number somebody guessed.
 *
 * A flat timeout is wrong in both directions: too long for a server-rendered page,
 * and too short for one that fetches its content after load — which is the case that
 * silently files half a posting.
 */
async function waitForContent(page: any, budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs;
  let last = -1;
  let stable = 0;
  while (Date.now() < deadline) {
    const n: number = await page.evaluate(() => document.body?.innerText?.length || 0).catch(() => 0);
    // two identical samples on something substantial: it has finished arriving
    if (n > 400 && n === last && ++stable >= 2) return;
    if (n !== last) stable = 0;
    last = n;
    await page.waitForTimeout(400);
  }
}

async function scrapeWithBrowser(browser: any, url: string): Promise<Scraped> {
  const page = await browser.newPage({ userAgent: UA });
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await waitForContent(page, renderWaitFor(url) * 3); // SPA portals paint after load
    const data = await page.evaluate(PICK_JD);
    const text = clean((data.meta ? data.meta + "\n\n" : "") + data.text);
    return { title: data.title, text, html: sanitizeJdHtml(data.html), ok: text.length > 60 };
  } finally {
    await page.close().catch(() => {});
  }
}

export async function scrapeJobPage(url: string): Promise<Scraped> {
  if (!/^https?:\/\//.test(url)) return { title: "", text: "", html: "", ok: false, error: "bad url" };
  // exact beats rendered, and costs one request
  const gh = await greenhouseEmbed(url);
  if (gh) return gh;
  let browser: any;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
    const r = await scrapeWithBrowser(browser, url);
    if (r.ok) return r;
    return await fetchFallback(url);
  } catch (e: any) {
    return await fetchFallback(url);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// Scrape one job by id and persist its JD.
export async function scrapeAndSave(jobId: string): Promise<Scraped & { saved: boolean }> {
  const job = getJob(jobId);
  if (!job) return { title: "", text: "", html: "", ok: false, error: "job not found", saved: false };
  const r = await scrapeJobPage(job.apply_url);
  if (r.ok && r.text) {
    setJd(jobId, r.text, r.html || null);
    addEvent(jobId, "jd_scraped", { chars: r.text.length, rich: !!r.html, source: job.apply_url });
    return { ...r, saved: true };
  }
  return { ...r, saved: false };
}

// Batch JD scrape. onlyMissing=true → jobs without a JD (find crawl); false → all
// active jobs (update/refresh crawl). onLog gets a line per job for the Crawl Shell.
export async function scrapeJds(opts: {
  limit?: number;
  onlyMissing?: boolean;
  onLog?: (line: string) => void;
}): Promise<{ scraped: number; failed: number }> {
  const limit = opts.limit ?? 12;
  const onLog = opts.onLog ?? (() => {});
  const where = opts.onlyMissing
    ? "active=1 AND (jd IS NULL OR length(jd) < 60)"
    : "active=1";
  const rows = getDb()
    .prepare(`SELECT id, company, apply_url FROM jobs WHERE ${where} ORDER BY fit_score DESC LIMIT ?`)
    .all(limit) as { id: string; company: string; apply_url: string }[];
  if (!rows.length) return { scraped: 0, failed: 0 };

  let scraped = 0,
    failed = 0,
    browser: any;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
  } catch {
    /* fall back to fetch per row below */
  }
  for (const row of rows) {
    try {
      let r = browser ? await scrapeWithBrowser(browser, row.apply_url) : await fetchFallback(row.apply_url);
      if (!r.ok) r = await fetchFallback(row.apply_url);
      if (r.ok && r.text) {
        setJd(row.id, r.text, r.html || null);
        addEvent(row.id, "jd_scraped", { chars: r.text.length, rich: !!r.html });
        scraped++;
        onLog(`scraped ${row.company} — ${r.text.length} chars`);
      } else {
        failed++;
        onLog(`could not read ${row.company} (${r.error || "no text"})`);
      }
    } catch (e: any) {
      failed++;
      onLog(`error on ${row.company}: ${e.message}`);
    }
  }
  if (browser) await browser.close().catch(() => {});
  return { scraped, failed };
}

// back-compat
export async function scrapeMissingJds(limit = 12): Promise<{ scraped: number; failed: number }> {
  return scrapeJds({ limit, onlyMissing: true });
}

// Verify each crawled job actually points to a live, open posting (don't trust the
// agent's claim). Renders the apply_url, checks HTTP status + page content for
// dead/closed markers, and captures the JD in the same visit. Returns the live jobs
// (with JD) and the dropped ones with a reason — so the Crawl Shell can show both.
const DEAD = /(posting|job|position|page|role|listing)\s+(you('?re| are) looking for\s+)?(is\s+)?(no longer|not)\s+(found|available|open|active|accepting)|no longer (available|accepting|active|open)|(position|posting|role|job|listing) (has been|is|was)\s+(filled|closed|removed|expired|deactivated)|this (job|posting|position|role|listing) (is|has|was) (closed|expired|filled|removed|no longer)|404 (not found|error)|we can'?t find|does ?n'?t exist|page you are looking for (can'?t|cannot|could not) be found|application (is |are )?(now )?closed|applications? (are )?closed|stopped accepting applications|opportunity (is )?no longer/i;

// Aggregator / job-board hosts whose pages are NOT a real application — they link
// out to the employer's ATS. We must follow through to that final page.
const AGGREGATOR = /(^|\.)(remotive\.com|weworkremotely\.com|remoteok\.(com|io)|wellfound\.com|angel\.co|linkedin\.com|indeed\.com|glassdoor\.[a-z.]+|remote\.co|jobspresso\.co|nodesk\.co|himalayas\.app|workingnomads\.com|jobicy\.com|trulyremotework\.com|dailyremote\.com|remoteok\.com|builtin\.com|otta\.com|dice\.com|ziprecruiter\.com|simplyhired\.com|google\.com)$/i;

// Real ATS hosts — a strong signal that an outbound link is the true apply page.
const ATS_HOST = /(greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|breezy\.hr|smartrecruiters\.com|jobvite\.com|bamboohr\.com|myworkdayjobs\.com|workday\.com|recruitee\.com|teamtailor\.com|pinpointhq\.com|join\.com|rippling\.com|gem\.com|paylocity\.com|icims\.com|ashby|greenhouse|lever)/i;

const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };

// A company's careers INDEX is not an application either — it is the aggregator
// problem wearing the employer's own domain. It matters because a model with no web
// access, asked to find roles, answers with companies it remembers and a guessed
// careers URL for each: plaid.com/careers, render.com/careers, vercel.com/careers.
// Those pages are always live, so liveness alone waves every one of them through.
// A real posting has a slug; an index is the bare word.
const INDEX_WORDS = /^(careers?|jobs?|join|join-us|work-with-us|working-here|opportunities|open-roles|open-positions|positions|vacancies|hiring|life|company|about|en|us)$/i;

export function isCareersIndex(u: string): boolean {
  let path: string;
  try { path = new URL(u).pathname; } catch { return false; }
  const parts = path.split("/").filter(Boolean).filter((p) => !/^index\.html?$/i.test(p));
  // the root of a careers site, or one level of nesting under it (/company/careers)
  if (!parts.length || parts.length > 2) return false;
  return parts.every((p) => INDEX_WORDS.test(p)) && /careers?|jobs?|join|hiring|positions|roles|vacancies|opportunities/i.test(parts[parts.length - 1]);
}

// Runs in the browser: pick the best outbound "Apply" link on an aggregator page.
const FIND_APPLY = () => {
  const here = location.hostname.replace(/^www\./, "");
  const ats = /(greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|breezy\.hr|smartrecruiters\.com|jobvite\.com|bamboohr\.com|myworkdayjobs\.com|workday|recruitee\.com|teamtailor\.com|pinpointhq\.com|join\.com|rippling\.com|icims\.com)/i;
  let best = "";
  let bestScore = 0;
  for (const a of Array.from(document.querySelectorAll("a[href]")) as HTMLAnchorElement[]) {
    const href = a.href;
    if (!/^https?:/i.test(href)) continue;
    let host = "";
    try { host = new URL(href).hostname.replace(/^www\./, ""); } catch { continue; }
    const txt = (a.innerText || a.textContent || "").trim().toLowerCase();
    let s = 0;
    if (ats.test(href)) s += 8;
    if (host !== here && host.indexOf("remotive") < 0) s += 3;
    if (/\bapply\b/.test(txt)) s += 5;
    if (/apply|application/i.test(href)) s += 2;
    if (/career|jobs?|positions?/i.test(href)) s += 1;
    if (s > bestScore) { bestScore = s; best = href; }
  }
  return bestScore >= 3 ? best : "";
};

export interface LiveCheck {
  ok: boolean;
  status: number;
  finalUrl: string;
  reason: string;        // empty when ok
  hops: string[];        // intermediate URLs walked (aggregator → employer)
  jdText: string;
  jdHtml: string;
  /**
   * The board's page loaded and reads like a live posting, but no link off it led to
   * the employer's own application form. Distinct from a failure: it is the ordinary
   * shape of several boards — Jobicy's page links to the company homepage and keeps
   * the apply button internal — and for a posting that came out of that board's own
   * API, the board's URL is a real place to apply rather than a dead end.
   */
  boardOnly?: boolean;
}

// Walk a URL to its FINAL application page (following redirects and aggregator
// "Apply" links) and confirm it's a live, open posting. Reuses one browser across
// calls. This is the single source of truth for "is this job still applyable?".
export async function resolveLive(browser: any, startUrl: string, onLog?: (s: string) => void): Promise<LiveCheck> {
  const hops: string[] = [];
  let cur = startUrl;
  let status = 0;
  let finalUrl = startUrl;

  for (let hop = 0; hop < 3; hop++) {
    let bodyText = "", jdText = "", jdHtml = "";
    if (browser) {
      const page = await browser.newPage({ userAgent: UA });
      try {
        const resp = await page.goto(cur, { waitUntil: "domcontentloaded", timeout: 30000 });
        status = resp ? resp.status() : 0;
        await waitForContent(page, renderWaitFor(cur) * 3);
        finalUrl = page.url();
        const cap = await page.evaluate(PICK_JD);
        bodyText = cap.bodyText || "";
        jdText = cap.text || cap.bodyText || "";
        jdHtml = cap.html || "";
        // if still on an aggregator, try to find the outbound apply link before giving up
        if (AGGREGATOR.test(hostOf(finalUrl))) {
          const applyHref = await page.evaluate(FIND_APPLY);
          if (applyHref && applyHref !== cur) {
            hops.push(finalUrl);
            onLog?.(`  ↪ following ${hostOf(finalUrl)} → ${hostOf(applyHref)}`);
            cur = applyHref;
            continue; // walk to the employer page
          }
        }
      } catch (e: any) {
        return { ok: false, status, finalUrl, reason: `unreachable (${String(e.message).slice(0, 40)})`, hops, jdText: "", jdHtml: "" };
      } finally {
        await page.close().catch(() => {});
      }
    } else {
      try {
        const r = await fetch(cur, { headers: { "user-agent": UA }, redirect: "follow" });
        status = r.status;
        finalUrl = r.url || cur;
        const raw = await r.text();
        const bodyHtml = raw.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] || raw;
        bodyText = raw.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ");
        jdText = bodyText;
        jdHtml = bodyHtml;
        if (AGGREGATOR.test(hostOf(finalUrl))) {
          const m = raw.match(/href=["']([^"']*(?:greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com|myworkdayjobs\.com)[^"']*)["']/i);
          if (m && m[1] && m[1] !== cur) { hops.push(finalUrl); cur = m[1]; continue; }
        }
      } catch (e: any) {
        return { ok: false, status, finalUrl, reason: `unreachable (${String(e.message).slice(0, 40)})`, hops, jdText: "", jdHtml: "" };
      }
    }

    const clean = bodyText.replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim();
    if (status >= 400) return { ok: false, status, finalUrl, reason: `HTTP ${status}`, hops, jdText: "", jdHtml: "" };
    if (DEAD.test(clean.slice(0, 6000))) return { ok: false, status, finalUrl, reason: "posting closed / no longer open", hops, jdText: "", jdHtml: "" };
    if (AGGREGATOR.test(hostOf(finalUrl))) {
      const clean2 = clean.slice(0, 6000);
      return {
        ok: false,
        status,
        finalUrl,
        reason: `could not resolve a final application link off ${hostOf(finalUrl)}`,
        hops,
        // Hand back what was read anyway. The caller decides whether a posting that
        // never leaves its board is worth keeping; that depends on where the posting
        // came from, which is not knowable here.
        jdText: jdText.replace(/\s+\n/g, "\n").trim().slice(0, 16000),
        jdHtml: sanitizeJdHtml(jdHtml),
        boardOnly: clean2.length >= 400,
      };
    }
    if (isCareersIndex(finalUrl))
      return { ok: false, status, finalUrl, reason: "that is a careers index, not a posting", hops, jdText: "", jdHtml: "" };
    // Same trick as the fetch path: an employer page that paints a Greenhouse job in
    // afterwards leaves us holding its chrome. Verification is the one place that
    // captures the JD for a crawl, so it should not settle for the shell either.
    if (clean.length < 1200 || /[?&]gh_jid=\d/i.test(finalUrl)) {
      const gh = await greenhouseEmbed(finalUrl);
      if (gh && gh.text.length > jdText.length) {
        onLog?.(`  ↪ read ${hostOf(finalUrl)} from greenhouse directly (${gh.text.length} chars)`);
        return { ok: true, status: status || 200, finalUrl, reason: "", hops, jdText: gh.text, jdHtml: gh.html };
      }
    }
    if (clean.length < 220) return { ok: false, status, finalUrl, reason: `page too thin (${clean.length} chars) — likely dead/redirect`, hops, jdText: "", jdHtml: "" };

    return { ok: true, status, finalUrl, reason: "", hops, jdText: jdText.replace(/\s+\n/g, "\n").trim().slice(0, 16000), jdHtml: sanitizeJdHtml(jdHtml) };
  }
  return { ok: false, status, finalUrl, reason: "too many redirects — never reached a real posting", hops, jdText: "", jdHtml: "" };
}

// On-demand liveness check for a single apply URL (launches its own browser).
// Used right before auto-apply so we never act on a closed posting.
export async function verifyApplyUrl(url: string): Promise<LiveCheck> {
  if (!/^https?:\/\//.test(url)) return { ok: false, status: 0, finalUrl: url, reason: "no/invalid apply URL", hops: [], jdText: "", jdHtml: "" };
  let browser: any;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
  } catch { /* fall back to fetch inside resolveLive */ }
  try {
    return await resolveLive(browser, url);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

export interface VerifyResult {
  alive: { job: any; jd: string; jdHtml: string }[];
  dropped: { company: string; role: string; url: string; reason: string }[];
}

/**
 * @param opts.keepOnBoard Accept a posting that never leaves the board it came from.
 *
 * On by default for feed crawls and off for agent research, because the two produce
 * different risks. An agent can imagine a job, so its links must be walked through to
 * an employer or thrown away. A feed posting came out of the board's own API with its
 * description attached — it cannot be imagined, and several boards deliberately keep
 * the apply button internal. Dropping those meant a support crawl that scored seven
 * real, open roles saved none of them, which is what "no jobs were added" looked like.
 */
export async function verifyJobs(
  jobs: any[],
  opts: { onLog?: (line: string) => void; limit?: number; signal?: AbortSignal; keepOnBoard?: boolean } = {}
): Promise<VerifyResult> {
  const onLog = opts.onLog ?? (() => {});
  const list = jobs.slice(0, opts.limit ?? 40);
  const alive: VerifyResult["alive"] = [];
  const dropped: VerifyResult["dropped"] = [];
  let browser: any;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
  } catch {}

  for (const job of list) {
    if (opts.signal?.aborted) break;
    const company = job.company || "?";
    const role = job.role || "";
    const url = String(job.apply_url || job.url || "").trim();
    const drop = (reason: string) => { dropped.push({ company, role, url, reason }); onLog(`✗ dropped ${company} — ${reason}`); };

    if (!/^https?:\/\//.test(url)) { drop("no/invalid apply URL"); continue; }

    const r = await resolveLive(browser, url, onLog);
    if (!r.ok) {
      if (!(opts.keepOnBoard && r.boardOnly)) { drop(r.reason); continue; }
      // Apply through the board. Said plainly on the card rather than silently, so
      // nobody is surprised by where the link goes.
      alive.push({ job: { ...job, apply_url: r.finalUrl || url }, jd: r.jdText, jdHtml: r.jdHtml });
      onLog(`✓ ${company} — live on ${hostOf(r.finalUrl || url)}; apply through the board (no employer link published)`);
      continue;
    }

    // store the FINAL employer apply URL (not the aggregator/redirect we started at)
    const resolved = r.finalUrl && r.finalUrl !== url ? { ...job, apply_url: r.finalUrl } : job;
    if (r.hops.length) onLog(`  resolved ${company} → ${hostOf(r.finalUrl)} (final apply page)`);
    alive.push({ job: resolved, jd: r.jdText, jdHtml: r.jdHtml });
    onLog(`✓ ${company} — verified live (${r.jdText.length} chars)`);
  }
  if (browser) await browser.close().catch(() => {});
  return { alive, dropped };
}
