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

async function scrapeWithBrowser(browser: any, url: string): Promise<Scraped> {
  const page = await browser.newPage({ userAgent: UA });
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(renderWaitFor(url)); // let SPA job portals (Lever/Ashby/Greenhouse/Workday) render
    const data = await page.evaluate(PICK_JD);
    const text = clean((data.meta ? data.meta + "\n\n" : "") + data.text);
    return { title: data.title, text, html: sanitizeJdHtml(data.html), ok: text.length > 60 };
  } finally {
    await page.close().catch(() => {});
  }
}

export async function scrapeJobPage(url: string): Promise<Scraped> {
  if (!/^https?:\/\//.test(url)) return { title: "", text: "", html: "", ok: false, error: "bad url" };
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
const AGGREGATOR = /(^|\.)(remotive\.com|weworkremotely\.com|remoteok\.(com|io)|wellfound\.com|angel\.co|linkedin\.com|indeed\.com|glassdoor\.[a-z.]+|remote\.co|jobspresso\.co|nodesk\.co|himalayas\.app|workingnomads\.com|jobicy\.com|dailyremote\.com|remoteok\.com|builtin\.com|otta\.com|dice\.com|ziprecruiter\.com|simplyhired\.com|google\.com)$/i;

// Real ATS hosts — a strong signal that an outbound link is the true apply page.
const ATS_HOST = /(greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|breezy\.hr|smartrecruiters\.com|jobvite\.com|bamboohr\.com|myworkdayjobs\.com|workday\.com|recruitee\.com|teamtailor\.com|pinpointhq\.com|join\.com|rippling\.com|gem\.com|paylocity\.com|icims\.com|ashby|greenhouse|lever)/i;

const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };

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
        await page.waitForTimeout(renderWaitFor(cur));
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
    if (AGGREGATOR.test(hostOf(finalUrl)))
      return { ok: false, status, finalUrl, reason: `could not resolve a final application link off ${hostOf(finalUrl)}`, hops, jdText: "", jdHtml: "" };
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

export async function verifyJobs(
  jobs: any[],
  opts: { onLog?: (line: string) => void; limit?: number; signal?: AbortSignal } = {}
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
    if (!r.ok) { drop(r.reason); continue; }

    // store the FINAL employer apply URL (not the aggregator/redirect we started at)
    const resolved = r.finalUrl && r.finalUrl !== url ? { ...job, apply_url: r.finalUrl } : job;
    if (r.hops.length) onLog(`  resolved ${company} → ${hostOf(r.finalUrl)} (final apply page)`);
    alive.push({ job: resolved, jd: r.jdText, jdHtml: r.jdHtml });
    onLog(`✓ ${company} — verified live (${r.jdText.length} chars)`);
  }
  if (browser) await browser.close().catch(() => {});
  return { alive, dropped };
}
