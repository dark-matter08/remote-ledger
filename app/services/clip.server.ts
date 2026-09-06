// What happens after the browser clipper hands over a page.
//
// The clip endpoint used to be the whole feature: take a url, guess a company and a
// role out of the tab title, drop the page's innerText in as the description, and
// write "clipped — run match in the job page" into the field meant for the tech
// fine-print. A clipped job therefore arrived as a link and a wall of text, sitting
// at the bottom of the ledger with a fit score of zero, and every bit of the work
// the crawl does for free had to be done again by hand.
//
// A job that arrives by clipper should look exactly like one the crawl found. That
// means the real description in both text and markup, a company and role read from
// the posting rather than from the tab title, and the same judgement — category, fit,
// stack, eligibility, seniority — applied to it.
//
// It runs after the response, as its own Crawl Shell run: the popup gets an id back
// in milliseconds, and the reading happens where every other piece of AI work in the
// app is already visible.
import { getSetting } from "../sqlite.server";
import { upsertJobs, setJd, setMeta } from "../db.server";
import { runLLM, tryParseJson } from "../llm/runner.server";
import { loggedTask } from "./crawl.server";
import { scrapeJobPage, sanitizeJdHtml } from "./scrape.server";
import { getDefaultProfile } from "../resume/profiles.server";
import { analyzeMatch } from "../resume/ai.server";

/** Below this, whatever the page handed over is a nav bar and a cookie banner. */
const THIN_JD = 400;

interface Read {
  company: string;
  role: string;
  category: string;
  fit_score: number;
  stack: string | null;
  eligibility: string | null;
  seniority: string | null;
}

const VALID = new Set(["high", "medium", "stretch"]);

async function readPosting(jd: string, fallbackCompany: string, fallbackRole: string): Promise<Read | null> {
  const loc = getSetting("profile_location") || "a remote-friendly location";
  const stack = getSetting("profile_stack") || "software engineering";

  const r = await runLLM({
    purpose: "job-research",
    json: true,
    temperature: 0.2,
    maxTokens: 900,
    system:
      "You read one job posting the candidate has already found and saved. The posting is real and its link is known good, so never invent or alter a URL. Name the employer and the role as the posting itself does, and judge the fit honestly — a bad match scored highly wastes the candidate's time.",
    prompt:
      `CANDIDATE\n- Based in: ${loc}. Needs roles workable remotely from there.\n- Target stack: ${stack}\n\n` +
      `The page was titled as "${fallbackRole}" at "${fallbackCompany}", which may be wrong — prefer what the posting says.\n\n` +
      `POSTING\n${jd.slice(0, 6000)}\n\n` +
      `Return ONLY JSON: { "company": "the employer", "role": "the job title", "category": "high|medium|stretch", ` +
      `"fit_score": 0-100, "stack": "short tech fine-print e.g. 'TS · Node · Postgres'", ` +
      `"eligibility": "short note e.g. 'Open worldwide'", "seniority": "Mid|Senior|Contract|Varies" }\n` +
      `"high" means a strong stack match AND clearly eligible from ${loc}.`,
  });

  const j = tryParseJson(r.text);
  // A judgement nobody made is not a judgement of zero. Say so rather than filing
  // the posting as a bad match the runner never actually assessed.
  if (!j || typeof j !== "object") return null;
  const category = String(j.category || "").toLowerCase();
  return {
    company: String(j.company || "").trim() || fallbackCompany,
    role: String(j.role || "").trim() || fallbackRole,
    category: VALID.has(category) ? category : "medium",
    fit_score: Math.max(0, Math.min(100, Number(j.fit_score) || 0)),
    stack: String(j.stack || "").trim() || null,
    eligibility: String(j.eligibility || "").trim() || null,
    seniority: String(j.seniority || "").trim() || null,
  };
}

/**
 * Turn a clipped link into a job the ledger can actually use.
 *
 * Never throws at the caller: the row already exists by the time this runs, so a
 * failure here leaves a saved job that is merely unenriched, which is what the
 * clipper produced on its best day before.
 */
export async function enrichClip(o: {
  id: string;
  url: string;
  jd: string;
  jdHtml: string;
  company: string;
  role: string;
}): Promise<void> {
  await loggedTask("clip", `Clipped · ${o.company} — ${o.role}`, async (L) => {
    let text = o.jd || "";
    let html = o.jdHtml || "";
    L("note", `From the page: ${text.length} characters of text, ${html.length} of markup.`);

    // The extension sends the selection or the main element. On a posting behind a
    // tab, an accordion or a "show more", that is a headline and little else —
    // so fetch the page properly rather than judging the role on a fragment.
    if (text.length < THIN_JD) {
      L("step", "That is too thin to judge a role on — opening the posting to read it in full…");
      const s = await scrapeJobPage(o.url);
      if (s.ok && s.text.length > text.length) {
        text = s.text;
        html = s.html || html;
        L("result", `read ${text.length} characters from the posting itself`);
      } else {
        L("note", `could not read more from the page${s.error ? ` (${s.error})` : ""} — going on with what was clipped`);
      }
    }

    if (text) {
      setJd(o.id, text, html ? sanitizeJdHtml(html) : null);
      L("result", `description saved${html ? " with its formatting" : " as plain text"}.`);
    } else {
      L("error", "no description could be captured — the rest of this will be guesswork");
    }

    if (!text) return;

    L("step", "Reading the posting: who is hiring, for what, and how well it fits you…");
    const read = await readPosting(text, o.company, o.role);
    if (!read) {
      L("error", "the runner did not answer with anything readable — the posting is saved in full, but you will have to score it yourself.");
      return;
    }

    // Keyed by the id it already has, so correcting the company or the role renames
    // the row instead of minting a second one beside it.
    upsertJobs([
      {
        id: o.id,
        company: read.company,
        role: read.role,
        category: read.category,
        fit_score: read.fit_score,
        stack: read.stack,
        eligibility: read.eligibility,
        seniority: read.seniority,
        apply_url: o.url,
        source: "clipped",
      },
    ]);
    L("result", `${read.company} — ${read.role} · ${read.category} · fit ${read.fit_score}/100${read.stack ? ` · ${read.stack}` : ""}`);

    // The one thing the job page still asked for by hand. It needs a résumé, so it
    // is the only step that can be skipped on a perfectly good clip.
    const base = getDefaultProfile();
    if (!base) {
      L("note", "No base résumé yet, so the match analysis is the one thing left to run yourself.");
      return;
    }
    L("step", "Comparing your résumé against it…");
    const m = await analyzeMatch(base.data, {
      id: o.id,
      company: read.company,
      role: read.role,
      stack: read.stack,
      eligibility: read.eligibility,
      jd: text,
    });
    setMeta(`match:${o.id}`, JSON.stringify(m.match));
    L("result", `match ${m.match.score}/100 · ${m.match.matched?.length || 0} matched, ${m.match.missing?.length || 0} missing.`);
  }).catch(() => {
    // loggedTask has already written the failure to the run; the job row survives
  });
}
