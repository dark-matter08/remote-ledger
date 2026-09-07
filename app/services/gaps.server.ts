// The skills a posting asked for that your knowledge base cannot evidence.
//
// Step 1 already works this out — `missing` on the match analysis — and then nothing
// is done with it. The list is the most useful thing on the page and the least
// actionable: it tells you what is absent without offering anywhere to put it.
//
// So it is offered back. For each gap you say which job or project you actually did
// it in, and that goes to the knowledge base permanently: the skill onto that entry's
// tags, and a drafted bullet as a *pending suggestion* you accept on /knowledge. The
// next application already knows, and the one after that.
//
// Nothing here decides you have a skill. A gap is only ever closed by you naming the
// place you used it — the model's only job is wording the evidence you supplied.
import { getDb } from "../sqlite.server";
import { getMeta, setMeta } from "../db.server";
import { runLLM, tryParseJson } from "../llm/runner.server";
import { HUMAN_STYLE, stripAiTells } from "../llm/style";

/**
 * Not every gap is a skill.
 *
 * The analysis returns whatever the posting weighs against you, and a third of those
 * are not things a project can answer: where you live, what timezone you overlap,
 * how many years you have been doing it, what your GPA was. Offering "which project
 * did you do this in?" against "Location: Cameroon, role is Americas-only" is a
 * question with no true answer, and the only thing a model can do with it is invent
 * one.
 */
export type GapKind = "skill" | "eligibility" | "credential";

export interface Gap {
  skill: string;
  kind: GapKind;
  /** Entries this could plausibly attach to, best first. */
  candidates: { id: number; label: string }[];
}

// A gap is phrased by the analysis as the posting's requirement, so the skill line
// is the least trustworthy string in the whole exchange. Asked to describe
// "10+ years of software engineering experience (candidate has ~4-5 years)", a model
// will write "I have spent about ten years writing software" unless told plainly not
// to — inventing the exact fact the candidate is short of.
const GAP_LINE_GUARD =
  "The SKILL line is the POSTING's wording of what it wants. It is not a claim the candidate has made. " +
  "It routinely carries quantities, seniority levels and tool names they do not match, and restating any " +
  "of those as fact is the one thing you must never do. Take from it only the subject; every quantity, " +
  "duration, tool and outcome must come from the entries or the candidate's own notes, or be left out. ";

// Where you are, and whether you may work there. Nothing you have built changes it.
const ELIGIBILITY =
  /\b(location|locat(ed|ion)|time ?zone|utc[+-]|visa|work authoriz|authorisation|eligib|relocat|on-?site|hybrid|must (reside|be based)|based in|citizen|residen|work permit|overlap with)\b/i;
// A bar you clear or you do not. Naming a project adds evidence, never years.
const CREDENTIAL =
  /\b(\d+\s*\+?\s*years?|years? of (experience|professional)|degree|bachelor|master'?s|phd|academic|gpa|certification|clearance)\b/i;

export function classifyGap(phrase: string): GapKind {
  const s = String(phrase || "");
  if (ELIGIBILITY.test(s)) return "eligibility";
  if (CREDENTIAL.test(s)) return "credential";
  return "skill";
}

const norm = (s: string) => s.trim().toLowerCase();
const dismissKey = (jobId: string) => `gapdismiss:${jobId}`;

// Words that carry no signal about a skill, and would otherwise let a one-word tag
// swallow half the gap list.
const NOISE = new Set([
  "and", "or", "the", "a", "an", "of", "in", "on", "at", "for", "with", "to", "from",
  "explicit", "named", "common", "experience", "work", "context", "framing", "focused",
  "platforms", "platform", "based", "using", "use", "used", "strong", "solid", "deep",
]);

const words = (s: string): string[] =>
  norm(s)
    .split(/[^a-z0-9+#.]+/)
    .map((w) => w.replace(/^[.]+|[.]+$/g, ""))
    .filter((w) => w.length > 1 && !NOISE.has(w));

/**
 * Does something already in the knowledge base cover this gap?
 *
 * The analysis phrases a gap as a sentence — "Named headless CMS platforms common at
 * agencies (Contentful, Sanity, Strapi)" — while a tag is two words. Comparing them
 * as strings meant a gap you had already closed came back on the next posting, under
 * a name you would never recognise as the same thing.
 *
 * So it is containment either way: every meaningful word of the tag appearing in the
 * gap, or every meaningful word of the gap appearing in the tag. A single-word tag
 * has to be at least three characters, or "AI" would answer for everything.
 */
function covers(tag: string, gapWords: Set<string>, gapText: string): boolean {
  const t = words(tag);
  if (!t.length) return false;
  if (t.length === 1 && t[0].length < 3) return false;
  if (t.every((w) => gapWords.has(w))) return true;
  const tagWords = new Set(t);
  const g = words(gapText);
  return g.length > 0 && g.every((w) => tagWords.has(w));
}

/** Skills dismissed for THIS posting. Not having a skill for one job is not a fact
 *  about you; a global "never show this again" would quietly bury it forever. */
export function dismissedGaps(jobId: string): string[] {
  try {
    const raw = getMeta(dismissKey(jobId));
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export function dismissGap(jobId: string, skill: string): void {
  const next = Array.from(new Set([...dismissedGaps(jobId), skill.trim()])).filter(Boolean);
  setMeta(dismissKey(jobId), JSON.stringify(next.slice(0, 100)));
}

/**
 * What the posting wanted, minus what you already have, minus what you have waved
 * away for this job.
 */
export function gapsForJob(jobId: string, missing: string[]): Gap[] {
  const db = getDb();
  const items = db
    .prepare("SELECT id, title, kind, role, start_date, end_date, tags FROM kb_items ORDER BY kind, title")
    .all() as any[];

  const have: string[] = [];
  for (const i of items) {
    try {
      for (const t of JSON.parse(i.tags || "[]")) have.push(String(t));
    } catch {}
  }
  const waved = new Set(dismissedGaps(jobId).map(norm));

  const candidates = items.map((i) => ({
    id: Number(i.id),
    label: [
      i.title,
      i.role,
      i.kind === "experience" && (i.start_date || i.end_date)
        ? `${i.start_date || "?"}–${i.end_date || "present"}`
        : i.kind,
    ]
      .filter(Boolean)
      .join(" · "),
  }));

  const seen = new Set<string>();
  const out: Gap[] = [];
  for (const raw of missing || []) {
    const skill = String(raw || "").trim();
    if (!skill) continue;
    const k = norm(skill);
    if (waved.has(k) || seen.has(k)) continue;
    // already evidenced under whatever name it was recorded as
    const gapWords = new Set(words(skill));
    if (have.some((t) => covers(t, gapWords, skill))) continue;
    seen.add(k);
    out.push({ skill, kind: classifyGap(skill), candidates });
  }
  return out;
}

/**
 * What the gap list decided NOT to show you, and which tag decided it.
 *
 * The containment rule is the newest and least battle-tested thing here: if a gap you
 * expected stops appearing, this is the only way to see that "Headless CMS" swallowed
 * it rather than the analysis never raising it.
 */
export function coveredGaps(jobId: string, missing: string[]): { skill: string; byTag: string }[] {
  const db = getDb();
  const have: string[] = [];
  for (const i of db.prepare("SELECT tags FROM kb_items").all() as any[]) {
    try {
      for (const t of JSON.parse(i.tags || "[]")) have.push(String(t));
    } catch {}
  }
  const waved = new Set(dismissedGaps(jobId).map(norm));
  const out: { skill: string; byTag: string }[] = [];
  const seen = new Set<string>();
  for (const raw of missing || []) {
    const skill = String(raw || "").trim();
    if (!skill || waved.has(norm(skill)) || seen.has(norm(skill))) continue;
    seen.add(norm(skill));
    const gapWords = new Set(words(skill));
    const tag = have.find((t) => covers(t, gapWords, skill));
    if (tag) out.push({ skill, byTag: tag });
  }
  return out;
}

export interface FillResult {
  filled: { skill: string; entry: string }[];
  dismissed: string[];
  error?: string;
}

/**
 * Attach gaps to the entries you say you did them in.
 *
 * One model call for the whole batch: it is wording bullets, not deciding facts, and
 * a call per skill would be slow and no more accurate.
 */
export async function fillGaps(
  jobId: string,
  picks: { skill: string; itemId: number; note?: string }[],
  dismiss: string[],
  /**
   * Skills the candidate has but cannot attach to anything on their résumé, each
   * with whatever they wrote about it. There was no path for these at all: itemId
   * was required, so a skill picked up in a volunteer role, a job left off the CV,
   * a course or their own time had nowhere to go and the gap stayed open forever.
   */
  loose: { skill: string; note: string }[] = []
): Promise<FillResult> {
  for (const s of dismiss) dismissGap(jobId, s);
  const db = getDb();
  const filledLoose = recordLooseSkills(loose);
  if (!picks.length) return { filled: filledLoose, dismissed: dismiss };

  const rows = new Map<number, any>();
  for (const p of picks) {
    if (rows.has(p.itemId)) continue;
    const r = db.prepare("SELECT * FROM kb_items WHERE id=?").get(p.itemId) as any;
    if (r) rows.set(p.itemId, r);
  }

  const grouped = new Map<number, string[]>();
  const notes = new Map<number, string[]>();
  for (const p of picks) {
    if (!rows.has(p.itemId)) continue;
    grouped.set(p.itemId, [...(grouped.get(p.itemId) || []), p.skill]);
    const n = String(p.note || "").trim();
    // what they wrote about this skill at this entry beats anything inferred
    if (n && !(notes.get(p.itemId) || []).includes(n))
      notes.set(p.itemId, [...(notes.get(p.itemId) || []), n]);
  }
  if (!grouped.size) return { filled: [], dismissed: dismiss, error: "those entries no longer exist" };

  const blocks = [...grouped.entries()].map(([id, skills]) => {
    const r = rows.get(id);
    const own = (notes.get(id) || []).join(" ");
    return (
      `ENTRY ${id}: ${r.title}${r.role ? ` — ${r.role}` : ""}\n` +
      `What is already recorded: ${(r.summary || "(nothing yet)").slice(0, 700)}\n` +
      `The candidate says they used: ${skills.join(", ")}` +
      (own ? `\nIn their own words: ${own.slice(0, 1200)}` : "")
    );
  });

  const r = await runLLM({
    purpose: "misc",
    json: true,
    temperature: 0.3,
    maxTokens: 1400,
    system:
      "You write résumé bullets from facts the candidate has just supplied about their own work. " +
      "They have told you which job or project they used each skill in; that is a given, not something to hedge. " +
      "Write only what those facts support — never invent a metric, a team size, a customer or an outcome. " +
      GAP_LINE_GUARD +
      HUMAN_STYLE,
    prompt:
      `${blocks.join("\n\n")}\n\n` +
      `For each ENTRY, write ONE résumé bullet covering the skill(s) named for it. Where the candidate ` +
      `described the work in their own words, that description is the source — follow it and do not ` +
      `contradict or embellish it. Otherwise ground the bullet in what is already recorded about that entry. ` +
      `If the recorded summary gives you nothing to anchor to, write the plainest possible statement of the work and nothing more.\n\n` +
      `Also give each skill a short tag — the two or three words someone would actually list, not the ` +
      `phrase the analysis used. "Named headless CMS platforms common at agencies (Contentful, Sanity, ` +
      `Strapi)" is a description of a gap; "Headless CMS" is the skill.\n\n` +
      `Return ONLY JSON: { "bullets": [ { "entry": 123, "bullet": "...", "tags": ["Headless CMS"] } ] }`,
  });

  const parsed = tryParseJson(r.text);
  const bullets: { entry: number; bullet: string }[] = Array.isArray(parsed?.bullets) ? parsed.bullets : [];
  const byEntry = new Map<number, string>();
  const tagsByEntry = new Map<number, string[]>();
  for (const b of bullets as any[]) {
    const id = Number(b?.entry);
    if (!id || !grouped.has(id)) continue;
    const text = stripAiTells(String(b?.bullet || "")).trim();
    if (text) byEntry.set(id, text);
    const short = (Array.isArray(b?.tags) ? b.tags : []).map((t: unknown) => String(t).trim()).filter(Boolean);
    if (short.length) tagsByEntry.set(id, short.slice(0, 4));
  }

  const now = new Date().toISOString();
  const filled: FillResult["filled"] = [];
  for (const [id, skills] of grouped) {
    const row = rows.get(id);
    // The tags are the candidate's own claim and go on regardless of what the model
    // returned; the bullet is a draft and waits to be accepted like every other one.
    let tags: string[] = [];
    try {
      tags = JSON.parse(row.tags || "[]").map(String);
    } catch {}
    // The analysis phrases a gap as a sentence; a tag is what someone would list.
    // Fall back to the raw phrase only when nothing shorter came back.
    const merged = Array.from(new Set([...tags, ...(tagsByEntry.get(id) || skills)]));
    db.prepare("UPDATE kb_items SET tags=?, updated_at=? WHERE id=?").run(JSON.stringify(merged.slice(0, 40)), now, id);

    const bullet = byEntry.get(id);
    if (bullet) {
      const dupe = db
        .prepare("SELECT 1 FROM kb_suggestions WHERE item_id=? AND bullet=?")
        .get(id, bullet);
      if (!dupe)
        db.prepare("INSERT INTO kb_suggestions (item_id,section,bullet,created_at) VALUES (?,?,?,?)").run(
          id,
          row.kind === "experience" ? "experience" : "project",
          bullet,
          now
        );
    }
    for (const s of skills) filled.push({ skill: s, entry: row.title });
  }

  return { filled: [...filledLoose, ...filled], dismissed: dismiss };
}

/**
 * Keep a skill that belongs to the person, not to a job.
 *
 * One `kind: "skill"` entry per skill, holding their own words as its summary and
 * the skill as its tag — so `coveredGaps` recognises it next time and it stops being
 * a gap on every future posting. Deliberately not a model call: they wrote the
 * sentence, and there is no employer, project or outcome here to word anything
 * around. Attaching it to a company they did not name is the one thing this must
 * never do, and the safest way not to is never to involve a company.
 */
function recordLooseSkills(loose: { skill: string; note: string }[]): FillResult["filled"] {
  const out: FillResult["filled"] = [];
  if (!loose.length) return out;
  const db = getDb();
  const now = new Date().toISOString();
  const find = db.prepare("SELECT id, tags, summary FROM kb_items WHERE kind='skill' AND lower(title)=lower(?)");

  for (const l of loose) {
    const skill = String(l.skill || "").trim();
    if (!skill) continue;
    const note = String(l.note || "").trim();
    const existing = find.get(skill) as { id: number; tags: string; summary: string } | undefined;

    if (existing) {
      // Adding to what is already there rather than replacing it: the note they wrote
      // for this posting is not a correction of the one they wrote for the last.
      const summary = note && !String(existing.summary || "").includes(note)
        ? [existing.summary, note].filter(Boolean).join(" ").slice(0, 4000)
        : existing.summary;
      db.prepare("UPDATE kb_items SET summary=?, updated_at=? WHERE id=?").run(summary, now, existing.id);
    } else {
      db.prepare(
        "INSERT INTO kb_items (kind,title,summary,tags,source,created_at,updated_at) VALUES ('skill',?,?,?,'gap',?,?)"
      ).run(skill, note, JSON.stringify([skill]), now, now);
    }
    out.push({ skill, entry: "your own skills" });
  }
  return out;
}

/**
 * Draft "how you used it" for the candidate to correct.
 *
 * Writing, not deciding: they have already said which skill and which entries, and
 * this only puts words to it. With notes, the notes ARE the content and the model
 * tidies them. Without notes it stays deliberately thin — a sentence naming the work
 * and nothing invented around it, because there is nothing to invent from.
 */
export async function draftGapUsage(o: {
  skill: string;
  itemIds: number[];
  notes?: string;
}): Promise<{ text: string; error?: string }> {
  const db = getDb();
  const entries = o.itemIds
    .map((id) => db.prepare("SELECT title, role, summary FROM kb_items WHERE id=?").get(id) as any)
    .filter(Boolean);

  const own = String(o.notes || "").trim();

  // A skill does not have to belong to a job on your résumé. It is routinely
  // something learned in a volunteer role, a previous job you left off, a course or
  // your own time — and demanding you attribute it to a listed employer before the
  // draft would run was either a dead end or an invitation to put it somewhere it
  // did not happen. With notes, the notes are the whole content and no entry is
  // needed; with neither there is genuinely nothing to write from.
  if (!entries.length && !own)
    return {
      text: "",
      error: "Tick where you did this, or write a line about it — either one is enough, but there has to be one.",
    };

  const where = entries.length
    ? entries
        .map((e: any) => `- ${e.title}${e.role ? ` (${e.role})` : ""}: ${(e.summary || "no summary recorded").slice(0, 500)}`)
        .join("\n")
    : "(not tied to anything on their résumé — they picked up this skill elsewhere)";

  const r = await runLLM({
    purpose: "misc",
    temperature: 0.3,
    maxTokens: 400,
    system:
      "You put words to work someone has already told you they did. You never decide what they did, " +
      "never invent a metric, a team size, a customer or an outcome, and never hedge about whether they did it. " +
      GAP_LINE_GUARD +
      "Plain first person, one or two sentences. " +
      HUMAN_STYLE,
    prompt:
      `SKILL: ${o.skill}\n\nWHERE THEY USED IT:\n${where}\n\n` +
      (own
        ? `THEIR NOTES (this is the content — tidy it, do not add to it):\n${own.slice(0, 2000)}\n\n`
        : `They have not written notes. Say only what the entries above support, and keep it short rather than filling space.\n\n`) +
      (!entries.length
        ? `There is no entry behind this, so their notes are the ONLY source. Do not name an employer, a ` +
          `project or a team they did not name themselves, and do not imply where it happened.\n\n`
        : "") +
      `Write the description. Prose only — no preamble, no bullet marker, no quotes.`,
  });

  const text = stripAiTells(String(r.text || "")).trim().replace(/^["']|["']$/g, "");
  return text ? { text } : { text: "", error: "the runner returned nothing usable" };
}
