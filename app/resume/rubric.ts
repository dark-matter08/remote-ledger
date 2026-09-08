// How a match score is arrived at.
//
// Before this, `analyzeMatch` asked the model to "be concrete and honest" and return a
// number. Nothing defined what 70 meant, or how it differed from 80, so two scores were
// not comparable to each other and the same job could score differently tomorrow. That
// is fine when a human reads the number and forms an impression. It is not fine once
// something refuses to apply for a job on the strength of it.
//
// So the model no longer produces the score. It scores five named dimensions and quotes
// the posting for each, and the total is arithmetic we do here. Three things follow:
// the number is reproducible, the reader can see why it is 62, and the weights can be
// retuned without re-running the model against anything.

/** Bumped when the dimensions or their weights change, so old scores are not silently compared to new ones. */
export const RUBRIC_VERSION = 1;

export interface RubricDimension {
  key: string;
  label: string;
  max: number;
  /** What the model is being asked to judge. Goes into the prompt verbatim. */
  asks: string;
}

/**
 * Fixed for now, and deliberately in one place.
 *
 * A design search weights domain familiarity differently from an engineering one, which
 * is an argument for making these per-profile. Against it: five more numbers to tune
 * before the feature does anything, and a default nobody changes is a simpler promise.
 * Kept as data so that decision stays cheap to revisit.
 */
export const RUBRIC: RubricDimension[] = [
  {
    key: "must_have",
    label: "Must-have skills",
    max: 40,
    asks: "the skills and tools the posting states as required — not the nice-to-haves",
  },
  {
    key: "seniority",
    label: "Seniority and years",
    max: 20,
    asks: "whether the candidate's level and years of experience meet what the posting asks for",
  },
  {
    key: "domain",
    label: "Domain familiarity",
    max: 15,
    asks: "experience in this industry, product area or problem space",
  },
  {
    key: "eligibility",
    label: "Location and eligibility",
    max: 15,
    asks: "location, time zone, work authorisation and any stated restriction",
  },
  {
    key: "nice_to_have",
    label: "Nice-to-haves",
    max: 10,
    asks: "the preferred-but-not-required items the posting lists",
  },
];

export const RUBRIC_TOTAL = RUBRIC.reduce((n, d) => n + d.max, 0); // 100

export interface ScoredDimension {
  key: string;
  label: string;
  score: number;
  max: number;
  /** A quote or close paraphrase from the posting. The reason to trust the number. */
  evidence: string;
}

/**
 * The total, computed here rather than taken from the model.
 *
 * Out-of-range sub-scores are clamped rather than rejected: a model that returns 45 out
 * of 40 has misread the instruction, not produced something unusable, and refusing the
 * whole analysis over it would cost a paid call to no purpose.
 */
export function scoreFromDimensions(dims: ScoredDimension[]): number {
  const byKey = new Map(dims.map((d) => [d.key, d]));
  let total = 0;
  for (const d of RUBRIC) {
    const got = byKey.get(d.key);
    const n = Number(got?.score);
    total += Number.isFinite(n) ? Math.max(0, Math.min(d.max, n)) : 0;
  }
  return Math.round(total);
}

/** Normalise whatever came back into exactly the five dimensions, in rubric order. */
export function normaliseDimensions(raw: unknown): ScoredDimension[] {
  const list = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
  const byKey = new Map(list.map((d) => [String(d?.key ?? ""), d]));
  return RUBRIC.map((d) => {
    const got = byKey.get(d.key);
    const n = Number(got?.score);
    return {
      key: d.key,
      label: d.label,
      max: d.max,
      score: Number.isFinite(n) ? Math.max(0, Math.min(d.max, Math.round(n))) : 0,
      evidence: String(got?.evidence ?? "").slice(0, 400),
    };
  });
}

/** The part of the prompt that defines the scale. */
export function rubricPrompt(): string {
  const rows = RUBRIC.map((d) => `- "${d.key}" (0-${d.max}): ${d.asks}`).join("\n");
  return (
    `Score each dimension out of its maximum, and quote the posting as evidence for each.\n` +
    `Do not return an overall score — it is computed from these.\n\n${rows}\n\n` +
    `Where the posting says nothing about a dimension, score it at roughly half and say so in the evidence, ` +
    `rather than guessing high or punishing the candidate for what was not asked.`
  );
}
