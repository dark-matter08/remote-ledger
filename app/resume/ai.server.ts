// AI operations on a resume against a job: tailor (with anti-hallucination
// guard), match/gap analysis, cover letter, interview prep.
import { runLLM } from "../llm/runner.server";
import { RESUME_JSON_SHAPE, type Resume, type MatchAnalysis, type TailorFlag } from "./types";

export interface JobCtx {
  id: string;
  company: string;
  role: string;
  stack?: string | null;
  eligibility?: string | null;
  jd?: string | null; // pasted/fetched job description
}

function jobBlock(job: JobCtx) {
  return `COMPANY: ${job.company}\nROLE: ${job.role}\nSTACK/MATCH: ${job.stack || "-"}\nELIGIBILITY: ${job.eligibility || "-"}\nJOB DESCRIPTION:\n${(job.jd || "(no full description provided; use role + stack)").slice(0, 8000)}`;
}

// ---- anti-hallucination guard --------------------------------------------

const NUM = /\b\d[\d.,%+xX]*\b/g;

function baseFacts(base: Resume) {
  const companies = new Set((base.experience || []).map((e) => norm(e.company)));
  const schools = new Set((base.education || []).map((e) => norm(e.school)));
  const allText = JSON.stringify(base).toLowerCase();
  const numbers = new Set((allText.match(NUM) || []).map((s) => s.replace(/[.,]/g, "")));
  return { companies, schools, allText, numbers };
}
const norm = (s?: string) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

export function guardTailored(base: Resume, tailored: Resume): TailorFlag[] {
  const f = baseFacts(base);
  const flags: TailorFlag[] = [];
  for (const e of tailored.experience || []) {
    if (!f.companies.has(norm(e.company)))
      flags.push({ severity: "warn", message: `New employer not in base resume: "${e.company}"` });
  }
  for (const e of tailored.education || []) {
    if (!f.schools.has(norm(e.school)))
      flags.push({ severity: "warn", message: `New school not in base resume: "${e.school}"` });
  }
  // numbers introduced by tailoring that don't appear anywhere in the base
  const tailoredNums = new Set(
    (JSON.stringify(tailored).toLowerCase().match(NUM) || []).map((s) => s.replace(/[.,]/g, ""))
  );
  const invented = [...tailoredNums].filter((n) => n.length > 1 && !f.numbers.has(n));
  if (invented.length)
    flags.push({
      severity: "warn",
      message: `Metrics not in base resume (verify before sending): ${invented.slice(0, 8).join(", ")}`,
    });
  if (!flags.length) flags.push({ severity: "info", message: "No invented employers, schools, or new metrics detected." });
  return flags;
}

// ---- tailor ---------------------------------------------------------------

export async function tailorResume(
  base: Resume,
  job: JobCtx
): Promise<{ resume: Resume; match: MatchAnalysis; flags: TailorFlag[]; callId?: number }> {
  const r = await runLLM({
    purpose: "resume-tailor",
    jobId: job.id,
    json: true,
    temperature: 0.3,
    maxTokens: 4096,
    system:
      "You are an expert resume editor. You tailor an existing resume to a job by REORDERING, REWEIGHTING, and REWORDING existing content to surface the most relevant experience and keywords. ABSOLUTE RULE: never invent employers, titles, dates, degrees, or metrics. Only use facts present in the base resume. You may rephrase and emphasize, not fabricate.",
    prompt: `BASE RESUME (JSON):\n${JSON.stringify(base)}\n\nTARGET JOB:\n${jobBlock(job)}\n\nReturn ONLY JSON of this shape:\n{ "resume": ${RESUME_JSON_SHAPE}, "match": { "score": 0, "matched": ["..."], "missing": ["..."], "atsKeywords": ["..."] } }\nThe resume must be the tailored version (same factual content, reordered/reworded). match.score is 0-100 fit. matched = requirements the candidate clearly meets; missing = gaps; atsKeywords = exact keywords from the JD the resume should include.`,
  });
  const out = r.json || {};
  const resume: Resume = out.resume || base;
  const match: MatchAnalysis = out.match || { score: 0, matched: [], missing: [], atsKeywords: [] };
  const flags = guardTailored(base, resume);
  return { resume, match, flags, callId: r.callId };
}

// ---- draft a single application answer -------------------------------------
// Answer one application question in the candidate's voice using ONLY résumé facts.
export async function draftAnswer(base: Resume, question: string, job?: JobCtx, kb?: string): Promise<{ text: string; callId?: number }> {
  const r = await runLLM({
    purpose: "misc",
    temperature: 0.4,
    maxTokens: 600,
    system:
      "You answer a job-application question in the candidate's voice (first person), using ONLY facts from their résumé AND their knowledge base (recent projects they've captured). Prefer the most relevant and recent evidence. Be specific and concise. NEVER invent employers, projects, dates, or metrics. If the evidence lacks the detail, give an honest, reasonable answer without fabricating specifics.",
    prompt: `CANDIDATE RÉSUMÉ (JSON):\n${JSON.stringify(base)}\n${kb ? `\nKNOWLEDGE BASE — recent projects & skills the candidate captured (use these too, they may be newer than the résumé):\n${kb}\n` : ""}${job ? `\nROLE: ${job.company} — ${job.role}\n${job.jd ? `JOB DESCRIPTION (excerpt):\n${job.jd.slice(0, 1500)}\n` : ""}` : ""}\nAPPLICATION QUESTION:\n${question}\n\nWrite a strong, truthful answer (2–4 sentences) in first person. Plain text only.`,
  });
  return { text: (r.text || "").trim(), callId: r.callId };
}

// ---- conversational résumé edit -------------------------------------------
// Apply a natural-language instruction to the structured résumé and return the full
// updated JSON + a one-line summary. Never fabricates facts.
export async function editResume(current: Resume, instruction: string): Promise<{ resume: Resume; summary: string; callId?: number }> {
  const r = await runLLM({
    purpose: "resume-tailor",
    json: true,
    temperature: 0.2,
    maxTokens: 4096,
    system:
      "You edit a structured résumé (JSON). Apply the user's instruction to the résumé. ABSOLUTE RULE: use ONLY facts the user states in the instruction or that already exist in the résumé — never invent employers, titles, dates, degrees, or metrics. Keep the exact same JSON shape. If the instruction would require inventing facts, do the safe part and note what you need in the summary.",
    prompt: `CURRENT RÉSUMÉ (JSON):\n${JSON.stringify(current)}\n\nINSTRUCTION:\n${instruction}\n\nReturn ONLY JSON: { "resume": ${RESUME_JSON_SHAPE}, "summary": "one short sentence on exactly what changed (or what you need from the user)" }`,
  });
  const out = r.json || {};
  const jr = out.resume || {};
  const resume: Resume = {
    contact: jr.contact || current.contact,
    summary: typeof jr.summary === "string" ? jr.summary : current.summary,
    skills: Array.isArray(jr.skills) ? jr.skills.map(String) : current.skills,
    experience: Array.isArray(jr.experience) ? jr.experience : current.experience,
    projects: Array.isArray(jr.projects) ? jr.projects : current.projects,
    education: Array.isArray(jr.education) ? jr.education : current.education,
  };
  return { resume, summary: (out.summary || "Updated your résumé.").toString(), callId: r.callId };
}

// ---- match-only -----------------------------------------------------------

export async function analyzeMatch(base: Resume, job: JobCtx): Promise<{ match: MatchAnalysis; callId?: number }> {
  const r = await runLLM({
    purpose: "match",
    jobId: job.id,
    json: true,
    temperature: 0.2,
    maxTokens: 1500,
    system: "You assess how well a candidate's resume matches a job. Be concrete and honest.",
    prompt: `RESUME (JSON):\n${JSON.stringify(base)}\n\nJOB:\n${jobBlock(job)}\n\nReturn ONLY JSON: { "score": 0, "matched": ["..."], "missing": ["..."], "atsKeywords": ["..."] }`,
  });
  return { match: r.json || { score: 0, matched: [], missing: [], atsKeywords: [] }, callId: r.callId };
}

// ---- cover letter ---------------------------------------------------------

export async function coverLetter(base: Resume, job: JobCtx): Promise<{ text: string; callId?: number }> {
  const r = await runLLM({
    purpose: "cover-letter",
    jobId: job.id,
    temperature: 0.6,
    maxTokens: 1200,
    system:
      "You write concise, specific cover letters in the candidate's voice. 3 short paragraphs, no clichés, only facts from the resume. Plain text.",
    prompt: `CANDIDATE RESUME (JSON):\n${JSON.stringify(base)}\n\nJOB:\n${jobBlock(job)}\n\nWrite a tailored cover letter (max ~250 words). Plain text only.`,
  });
  return { text: r.text.trim(), callId: r.callId };
}

// ---- application answers (auto-apply) -------------------------------------

const GENERIC_QUESTIONS = [
  "Why are you interested in this role?",
  "Why do you want to work at this company?",
  "Tell us about a relevant project or achievement.",
  "What makes you a good fit for this position?",
  "How did you hear about this role?",
];

export async function applicationAnswers(
  base: Resume,
  job: JobCtx,
  questions: string[]
): Promise<{ answers: { question: string; answer: string }[]; callId?: number }> {
  const qs = (questions && questions.length ? questions : GENERIC_QUESTIONS).slice(0, 20);
  const r = await runLLM({
    purpose: "cover-letter",
    jobId: job.id,
    json: true,
    temperature: 0.55,
    maxTokens: 2500,
    system:
      "You draft answers to job application form questions in the candidate's voice. " +
      "Posture: 'I'm choosing you' — confident, selective, never arrogant. Rules: 2-4 sentences each; " +
      "specific and concrete (reference something REAL from the JD and something REAL from the resume); " +
      "no fluff ('passionate about', 'would love the opportunity'); the hook is the proof, not the claim. " +
      "Use ONLY facts from the resume — never invent. Answer in the language of the JD (default English).",
    prompt: `RESUME (JSON):\n${JSON.stringify(base)}\n\nJOB:\n${jobBlock(job)}\n\nQUESTIONS:\n${qs
      .map((q, i) => `${i + 1}. ${q}`)
      .join("\n")}\n\nReturn ONLY JSON: { "answers": [ { "question": "...", "answer": "..." } ] } covering every question in order.`,
  });
  const answers = (r.json?.answers || []).filter((a: any) => a && a.question && a.answer);
  return { answers, callId: r.callId };
}

// Choose the best option for each dropdown on an application form, picking ONLY from
// each dropdown's real option list (so we can fill react-select/native dropdowns like
// "years of experience", "salary band", "country of residence", "business domain").
export async function chooseSelectOptions(
  base: Resume,
  job: JobCtx,
  items: { question: string; options: string[] }[],
  kb?: string
): Promise<{ question: string; choice: string }[]> {
  const useful = items.filter((i) => i.options && i.options.length).slice(0, 25);
  if (!useful.length) return [];
  const r = await runLLM({
    purpose: "cover-letter",
    jobId: job.id,
    json: true,
    temperature: 0.2,
    maxTokens: 1500,
    system:
      "You fill dropdown menus on a job application using ONLY facts about the candidate " +
      "(their resume + profile notes + the job). For each question choose EXACTLY ONE option " +
      "from its provided list, copying the option text VERBATIM. Make a reasonable, honest " +
      "choice for things like years of experience, business domain, country of residence, and " +
      "salary band (infer a band from seniority/role if not explicitly stated). Return an empty " +
      "string ONLY when no option could possibly apply or it would be a fabrication. NEVER " +
      "return text that is not one of the listed options.",
    prompt:
      `CANDIDATE RESUME (JSON):\n${JSON.stringify(base)}\n` +
      (kb ? `\nPROFILE NOTES:\n${kb.slice(0, 4000)}\n` : "") +
      `\nJOB:\n${jobBlock(job)}\n\nDROPDOWNS:\n` +
      useful.map((it, i) => `${i + 1}. ${it.question}\n   options: ${it.options.map((o) => JSON.stringify(o)).join(", ")}`).join("\n") +
      `\n\nReturn ONLY JSON: { "picks": [ { "question": "<question text>", "choice": "<exact option text, or empty>" } ] } covering every dropdown in order.`,
  });
  return ((r.json?.picks as any[]) || []).filter((p) => p && p.question && typeof p.choice === "string");
}

// Like applicationAnswers, but flags questions it can't answer truthfully from the
// resume (work authorization, salary, clearance, years with a tool not listed…) so a
// session can pool them for the user. `known` are answers already in the answer bank.
export async function draftSessionAnswers(
  base: Resume,
  job: JobCtx,
  questions: string[],
  known: Record<string, string> = {}
): Promise<{ items: { question: string; answer: string; needsInput: boolean }[]; callId?: number }> {
  const qs = questions.slice(0, 25);
  const knownBlock = Object.keys(known).length
    ? `\n\nKNOWN ANSWERS (reuse verbatim where the question matches):\n${Object.entries(known).map(([q, a]) => `Q: ${q}\nA: ${a}`).join("\n")}`
    : "";
  const r = await runLLM({
    purpose: "cover-letter",
    jobId: job.id,
    json: true,
    temperature: 0.5,
    maxTokens: 3000,
    system:
      "You draft job-application answers in the candidate's voice ('I'm choosing you' — confident, selective, specific, no fluff, proof over claims). " +
      "Use ONLY facts from the resume. CRITICAL: if a question cannot be answered truthfully from the resume — e.g. work authorization, visa, salary expectation, security clearance, years with a specific tool not in the resume, demographic questions — set answer to \"\" and needsInput to true. Never guess these.",
    prompt: `RESUME (JSON):\n${JSON.stringify(base)}\n\nJOB:\n${jobBlock(job)}${knownBlock}\n\nQUESTIONS:\n${qs
      .map((q, i) => `${i + 1}. ${q}`)
      .join("\n")}\n\nReturn ONLY JSON: { "items": [ { "question": "...", "answer": "...", "needsInput": false } ] } covering every question in order.`,
  });
  const items = (r.json?.items || []).map((x: any) => ({
    question: String(x.question || ""),
    answer: String(x.answer || ""),
    needsInput: !!x.needsInput || !String(x.answer || "").trim(),
  }));
  return { items, callId: r.callId };
}

// ---- interview prep -------------------------------------------------------

export async function interviewPrep(base: Resume, job: JobCtx): Promise<{ text: string; callId?: number }> {
  const r = await runLLM({
    purpose: "interview-prep",
    jobId: job.id,
    temperature: 0.5,
    maxTokens: 2000,
    system: "You are an interview coach. Output clean markdown.",
    prompt: `RESUME (JSON):\n${JSON.stringify(base)}\n\nJOB:\n${jobBlock(job)}\n\nProduce: (1) a 3-sentence company/role brief, (2) 8 likely interview questions tailored to this JD and resume, (3) 3 STAR-story prompts drawn from the candidate's real experience, (4) 3 smart questions for the candidate to ask. Markdown with headers.`,
  });
  return { text: r.text.trim(), callId: r.callId };
}
