// Make generated prose stop reading like generated prose. Everything here ends up
// in front of a recruiter, so the tells are expensive.
//
// Two halves doing deliberately different jobs:
//   HUMAN_STYLE  steers the model: vocabulary, rhythm, sentence shape. Only the
//                model can fix those, and only before it writes.
//   stripAiTells cleans what it emits anyway: punctuation and boilerplate. Those
//                are mechanical, so a regex fixes them without risking meaning.
//
// Deliberately NOT done here: rewriting phrasing ("not just X, but Y") by regex.
// That needs to understand the sentence, and getting it wrong corrupts the user's
// claims about their own work. The prompt handles that instead.

export const HUMAN_STYLE = `
WRITE LIKE A PERSON, NOT AN ASSISTANT. These are hard rules:
- No em dashes or en dashes anywhere in prose. Use commas, periods, or parentheses. (Date ranges like 2021-2024 are fine.)
- Never open with "Certainly", "Sure", "Of course", "Absolutely", "Great question", or by restating the question.
- Never close with an offer of more help ("I hope this helps", "Let me know if...", "Feel free to...").
- No "not just X, but Y", "not only X but also Y", "it's not about X, it's about Y", "X isn't just Y".
- Banned words: delve, leverage (as a verb), robust, seamless, cutting-edge, harness, tapestry, testament, underscore, pivotal, realm, landscape, intricate, meticulous, showcase, spearhead, unlock, empower, elevate, streamline, game-changer, deep dive, navigate the complexities, in today's fast-paced.
- No three-item lists used for rhythm rather than because there are exactly three things.
- Vary sentence length. Short sentences are good. Do not start consecutive sentences the same way.
- Be concrete and specific. Cut filler adjectives. State the thing, do not build up to it.
`.trim();

// Date/number ranges are real typography, not a tell, so they survive the dash
// pass: 2021-2024, 2021-Present, 10-15.
const RANGE = /\b\d{1,4}\s*[–—]\s*(?:\d{1,4}\b|present\b|current\b|now\b|today\b)/gi;
const DASHES = /\s*[–—]+\s*/g;

// Private-use codepoints: a bare index would be clobbered by any other number in
// the prose ("89 point events"), so the placeholder has to be unmistakable.
const PARKED = /(\d+)/g;

const OPENER =
  /^\s*(?:certainly|sure|of course|absolutely|great question|good question|excellent question|happy to help|i'?d be happy to(?: help)?)\s*[!,.:;–—-]*\s*/i;
const CLOSER =
  /\s*(?:i hope (?:this|that) helps|hope (?:this|that) helps|let me know if[^.!?]*|feel free to[^.!?]*|please let me know[^.!?]*)[.!?]*\s*$/i;

/**
 * Strip the mechanical tells from one block of generated prose.
 * Idempotent: a second pass changes nothing the first one did.
 */
export function stripAiTells(text: string): string {
  if (!text) return text;
  let t = String(text);

  t = t.replace(OPENER, "");
  t = t.replace(CLOSER, "");

  // Park real ranges, turn every remaining dash into a comma, then restore them.
  const parked: string[] = [];
  t = t.replace(RANGE, (m) => `${parked.push(m) - 1}`);
  t = t.replace(DASHES, ", ");
  t = t.replace(PARKED, (_, i) => parked[Number(i)] ?? "");

  // Stray markdown emphasis in what is supposed to be plain text.
  t = t.replace(/\*\*([\s\S]+?)\*\*/g, "$1");

  // Tidy what the dash pass can leave behind: ", ,"  " ,"  ", ."
  t = t.replace(/,[\s,]*(?=,)/g, "");
  t = t.replace(/\s+,/g, ",");
  t = t.replace(/,\s*(?=[.!?;:])/g, "");
  t = t.replace(/^[ \t]*,[ \t]*/gm, "");
  t = t.replace(/[ \t]{2,}/g, " ");
  t = t.replace(/[ \t]+$/gm, "");

  return t.trim();
}

/** Apply stripAiTells to every string inside a value. */
export function stripAiTellsDeep<T>(value: T): T {
  if (typeof value === "string") return stripAiTells(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => stripAiTellsDeep(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = stripAiTellsDeep(v);
    return out as unknown as T;
  }
  return value;
}

/**
 * Clean only the prose fields of a résumé. Names, dates, emails, URLs and skill
 * tokens are left exactly as the user wrote them, so the anti-hallucination guard
 * still compares like for like.
 */
export function cleanResumeProse<
  T extends {
    summary?: string;
    experience?: { bullets?: string[] }[];
    projects?: { bullets?: string[] }[];
  }
>(resume: T): T {
  if (!resume || typeof resume !== "object") return resume;
  const clean = (list?: { bullets?: string[] }[]) =>
    (list || []).map((e) => (e?.bullets ? { ...e, bullets: e.bullets.map(stripAiTells) } : e));
  return {
    ...resume,
    ...(resume.summary ? { summary: stripAiTells(resume.summary) } : {}),
    ...(resume.experience ? { experience: clean(resume.experience) } : {}),
    ...(resume.projects ? { projects: clean(resume.projects) } : {}),
  };
}
