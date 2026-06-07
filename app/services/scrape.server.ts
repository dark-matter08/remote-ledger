// Scrape a job posting page (SPA-aware via Playwright) and save the full job
// description + page info. This is what makes the engine collect everything that's
// on the application page, not just the index row from the crawl.
import { getDb } from "../sqlite.server";
import { getJob, setJd, addEvent } from "../db.server";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

export interface Scraped {
  title: string;
  text: string;
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

// Strip tags as a last-resort fallback if the browser can't reach the page.
async function fetchFallback(url: string): Promise<Scraped> {
  try {
    const res = await fetch(url, { headers: { "user-agent": UA } });
    const html = await res.text();
    const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || "";
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&[a-z]+;/gi, " ");
    return { title, text: clean(text), ok: res.ok };
  } catch (e: any) {
    return { title: "", text: "", ok: false, error: e.message };
  }
}

async function scrapeWithBrowser(browser: any, url: string): Promise<Scraped> {
  const page = await browser.newPage({ userAgent: UA });
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1800); // let SPA job portals (Lever/Ashby/Greenhouse/Workday) render
    const data = await page.evaluate(() => {
      const pick = (sel: string) => {
        const el = document.querySelector(sel) as HTMLElement | null;
        return el ? el.innerText : "";
      };
      let text = "";
      for (const s of [
        "main",
        "article",
        "[role=main]",
        "#job-description",
        ".job-description",
        "[class*=description]",
        "[class*=posting]",
        "[class*=job]",
        ".content",
      ]) {
        const t = pick(s);
        if (t && t.length > text.length) text = t;
      }
      if (text.length < 200) text = document.body.innerText;
      const meta =
        (document.querySelector('meta[name="description"]') as HTMLMetaElement | null)?.content || "";
      return { title: document.title, text: (meta ? meta + "\n\n" : "") + text };
    });
    return { title: data.title, text: clean(data.text), ok: clean(data.text).length > 60 };
  } finally {
    await page.close().catch(() => {});
  }
}

export async function scrapeJobPage(url: string): Promise<Scraped> {
  if (!/^https?:\/\//.test(url)) return { title: "", text: "", ok: false, error: "bad url" };
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
  if (!job) return { title: "", text: "", ok: false, error: "job not found", saved: false };
  const r = await scrapeJobPage(job.apply_url);
  if (r.ok && r.text) {
    setJd(jobId, r.text);
    addEvent(jobId, "jd_scraped", { chars: r.text.length, source: job.apply_url });
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
        setJd(row.id, r.text);
        addEvent(row.id, "jd_scraped", { chars: r.text.length });
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
