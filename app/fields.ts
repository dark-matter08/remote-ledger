// What line of work someone is in.
//
// The crawl used to decide relevance with one hardcoded regex — engineer, developer,
// devops, SRE — that passed unconditionally, before the user's own keywords were
// consulted at all. Measured against the live boards, a customer support specialist
// and a backend engineer got back the *same 35 postings*, all of them engineering,
// while seven real support roles sitting in the same pool were thrown away. The app
// was not filtering badly; for anyone outside software it was not filtering on them
// at all.
//
// A field fixes that by being the thing the filter is derived FROM. Two other pieces
// fall out of it for free: the boards can be asked for that field directly rather
// than for everything, and the scorer can be told which kind of role to keep instead
// of the hardcoded "software engineering role".
//
// Client-safe on purpose — the setup wizard and Settings both render the picker.

export interface JobField {
  id: string;
  label: string;
  /** The placeholder in the keywords box: what someone in this field would type. */
  example: string;
  /**
   * Titles and board categories belonging to this field.
   *
   * Tested against the job title AND whatever categories the board published for it.
   * Every feed labels its own postings — RemoteOK tags them ("customer support",
   * "non tech"), Remotive gives a category ("Customer Service"), Himalayas a
   * parentCategory ("Developer"), Jobicy an industry ("Customer Support & Success")
   * — and all four vocabularies are plain English, so one regex per field reads all
   * four without a per-board mapping table to go stale.
   */
  match: RegExp;
  /**
   * Board-side filters, ONLY where the parameter was verified to return that field's
   * jobs. A wrong slug silently returns zero, so an unverified guess is worse than
   * no filter — feeds.server.ts falls back to the broad fetch when one comes back empty.
   */
  feed?: { remotive?: string; jobicy?: string };
}

export const JOB_FIELDS: JobField[] = [
  {
    id: "software",
    label: "Software & Engineering",
    example: "TypeScript, Node, React, Postgres, AWS",
    match:
      /\b(engineer|engineering|developer|programmer|architect|sre|devops|full[- ]?stack|back[- ]?end|front[- ]?end|software|firmware|mobile|android|ios|qa|sdet|tech(nical)? lead|cyber ?security|infosec)\b/i,
    feed: { remotive: "software-development", jobicy: "dev" },
  },
  {
    id: "support",
    label: "Customer Support & Success",
    example: "customer support, Zendesk, Intercom, escalations, SaaS, CSAT",
    match:
      /\b(customer (support|success|service|experience|care)|client (success|services|relations)|support (specialist|agent|advisor|representative|rep|associate|analyst|engineer|manager)|technical support|help ?desk|service ?desk|csm|account manager|community manager|onboarding specialist)\b/i,
    feed: { remotive: "customer-service", jobicy: "supporting" },
  },
  {
    id: "design",
    label: "Design & Creative",
    example: "Figma, UI design, UX research, design systems, prototyping",
    match:
      /\b(design(er|ing)?|ux|ui|user experience|user interface|creative|art director|illustrat(or|ion)|brand|graphic|motion|visual)\b/i,
    feed: { remotive: "design" },
  },
  {
    id: "marketing",
    label: "Marketing & Content",
    example: "SEO, content marketing, email campaigns, HubSpot, analytics",
    match:
      /\b(marketing|growth|seo|sem|content (marketing|strateg)|social media|brand manager|demand gen|campaign|copywrit|communications|pr manager|public relations)\b/i,
    feed: { remotive: "marketing", jobicy: "marketing" },
  },
  {
    id: "sales",
    label: "Sales & Business Development",
    example: "B2B sales, SaaS, pipeline, Salesforce, quota, closing",
    match:
      /\b(sales|account executive|business development|bdr|sdr|partnerships|revenue|quota|closer|pre[- ]?sales|solutions consultant)\b/i,
    feed: { remotive: "sales", jobicy: "sales" },
  },
  {
    id: "data",
    label: "Data & Analytics",
    example: "SQL, Excel, dashboards, Tableau, reporting, forecasting",
    match:
      /\b(data (analyst|scientist|engineer)|analytics|analyst|business intelligence|bi developer|statistic|machine learning|reporting)\b/i,
    feed: { remotive: "data" },
  },
  {
    id: "product",
    label: "Product & Project Management",
    example: "roadmaps, discovery, Jira, stakeholders, agile, delivery",
    match:
      /\b(product (manager|owner|lead)|program manager|project manager|delivery manager|scrum master|agile coach|pmo|technical program)\b/i,
    feed: { remotive: "project-management" },
  },
  {
    id: "finance",
    label: "Finance & Accounting",
    example: "bookkeeping, reconciliation, QuickBooks, payroll, AP/AR, audit",
    match:
      /\b(financ(e|ial)|account(ant|ing)|bookkeep|payroll|audit|controller|treasur|tax|billing|accounts (payable|receivable)|fp&a)\b/i,
    feed: { remotive: "finance" },
  },
  {
    id: "hr",
    label: "People, HR & Recruiting",
    example: "recruiting, onboarding, HRIS, employee relations, sourcing",
    match:
      /\b(recruit(er|ing|ment)|talent (acquisition|partner)|human resources|hr (manager|generalist|business partner)|people (ops|operations|partner)|sourcer|compensation|benefits)\b/i,
    feed: { remotive: "human-resources", jobicy: "hr" },
  },
  {
    id: "writing",
    label: "Writing & Editing",
    example: "copywriting, editing, technical writing, blogs, style guides",
    match:
      /\b(writer|writing|copywrit|editor|editorial|content (creator|producer|specialist)|technical writ|journalis|proofread)\b/i,
    feed: { remotive: "writing" },
  },
  {
    id: "operations",
    label: "Operations & Admin",
    example: "scheduling, process improvement, vendor management, logistics",
    match:
      /\b(operations|ops (manager|specialist|associate)|administrat(or|ive)|executive assistant|virtual assistant|office manager|logistics|supply chain|procurement|facilities|back ?office)\b/i,
    feed: { remotive: "operations" },
  },
  {
    id: "healthcare",
    label: "Healthcare & Medical",
    example: "patient care, medical coding, HIPAA, telehealth, EHR",
    match:
      /\b(nurse|nursing|clinical|medical|health(care)?|patient|physician|therapist|pharmac|telehealth|medical (coder|coding|biller)|care coordinator)\b/i,
    feed: { remotive: "medical" },
  },
  {
    id: "education",
    label: "Teaching & Training",
    example: "curriculum, tutoring, ESL, instructional design, e-learning",
    match:
      /\b(teach(er|ing)|tutor|instructor|educat(or|ion)|curriculum|instructional design|trainer|training specialist|e-?learning|professor|lectur)\b/i,
    feed: { remotive: "education" },
  },
  {
    id: "legal",
    label: "Legal & Compliance",
    example: "contracts, compliance, paralegal, privacy, GDPR, review",
    match:
      /\b(legal|lawyer|attorney|paralegal|counsel|compliance|contract (manager|specialist)|privacy|regulatory|litigation)\b/i,
    feed: { remotive: "legal" },
  },
  {
    id: "other",
    label: "Something else",
    // Nothing generic to suggest, so ask for the words that appear in the postings.
    example: "the words that show up in the job titles you want",
    // Matches nothing on its own: with no field vocabulary, relevance falls entirely
    // to the keywords the user typed, which is the honest answer when we do not know
    // the field. Deliberately not /.*/ — that would keep the whole market.
    match: /(?!)/,
  },
];

export const DEFAULT_FIELD = "software";

export function fieldById(id: string | null | undefined): JobField | null {
  if (!id) return null;
  return JOB_FIELDS.find((f) => f.id === id) ?? null;
}

/**
 * The words to drop into a prompt where "software engineering role" used to be
 * hardcoded. Reads as a noun phrase so callers can write "not a ${fieldLabel(id)}".
 */
export function fieldLabel(id: string | null | undefined): string {
  const f = fieldById(id);
  if (!f || f.id === "other") return "role in the candidate's own line of work";
  return `${f.label.toLowerCase()} role`;
}

/**
 * Keywords, split into things worth matching a title against.
 *
 * Both the phrase and its words: "Customer Support Specialist" typed as one comma-free
 * string used to become a single token that had to appear verbatim in a title, so it
 * matched nothing and the user contributed nothing to their own search. The phrase is
 * still the strongest signal, but the words on their own are what actually catch
 * "Support Specialist, Tier 2".
 */
const TOKEN_NOISE = new Set([
  "and", "the", "for", "with", "from", "our", "you", "your", "any", "all",
  "experience", "skills", "role", "roles", "job", "jobs", "work", "working",
  "senior", "junior", "mid", "level", "years", "year",
  // Words that describe the SHAPE of a job, never its subject. Measured: splitting
  // "Customer Support Specialist" left "specialist" free to match on its own, which
  // is how an Amazon Specialist, a Campaign Operations Specialist Trader and an HR
  // Systems Integration Engineer all landed in a customer-support search. The whole
  // phrase is still a token, so "onboarding specialist" typed deliberately still works.
  "specialist", "manager", "associate", "coordinator", "assistant", "executive",
  "officer", "consultant", "director", "head", "lead", "principal", "staff",
  "intern", "contractor", "freelance", "remote", "position", "full", "part", "time",
]);

export function keywordTokens(keywords: string): string[] {
  const out = new Set<string>();
  for (const phrase of String(keywords || "").split(/[,/·|;]+/)) {
    const p = phrase.trim().toLowerCase();
    if (p.length > 1) out.add(p);
    // a two-word phrase is usually the useful unit; its parts widen the net
    if (p.includes(" ")) {
      for (const w of p.split(/\s+/)) {
        if (w.length >= 3 && !TOKEN_NOISE.has(w)) out.add(w);
      }
    }
  }
  return [...out];
}

const escape = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whole-word, so "Express" is not read out of "Expression of Interest". */
export function keywordHit(text: string, tokens: string[]): boolean {
  return tokens.some((t) => new RegExp(`\\b${escape(t)}\\b`, "i").test(text));
}

/**
 * Is this posting in the user's line of work?
 *
 * Board categories count as much as the title, because the board is the one that
 * classified it — a posting Jobicy files under "Customer Support & Success" belongs
 * to a support search even when its title is "Escalations Lead, Tier 2".
 */
export function inField(
  field: JobField | null,
  title: string,
  categories: string[] = []
): boolean {
  if (!field) return false;
  const hay = [title, ...categories].filter(Boolean).join(" · ");
  return field.match.test(hay);
}
