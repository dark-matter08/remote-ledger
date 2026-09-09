// What a batch is about to cost, from what this machine has actually spent.
//
// Autopilot on one posting is five or six model calls. On this install the average
// match is $0.37, a tailor $0.72 and a cover letter $0.41 — so a run of ten jobs is
// tens of dollars, not cents. That is worth seeing before you press the button rather
// than afterwards on the usage page.
//
// Estimated from your own llm_calls rather than a price table: the number that matters
// is what your runner and your model cost you, and you may be on a CLI subscription
// where several of these are already paid for and show as zero.
import { getDb } from "../sqlite.server";

/** The purposes an autopilot run spends on, in the order the steps run. */
const AUTOPILOT_PURPOSES = ["match", "resume-build", "resume-tailor", "cover-letter", "cover-letter"] as const;

export interface Estimate {
  jobs: number;
  calls: number;
  perJobUsd: number;
  totalUsd: number;
  /** How many past calls the average is drawn from. Zero means we are guessing. */
  samples: number;
}

/** Average spend per purpose on this machine, over the calls that were actually billed. */
function averages(): Map<string, { avg: number; n: number }> {
  const rows = getDb()
    .prepare(
      `SELECT purpose, AVG(cost_usd) AS avg, COUNT(*) AS n
         FROM llm_calls
        WHERE cost_usd > 0 AND status = 'ok'
        GROUP BY purpose`
    )
    .all() as { purpose: string; avg: number; n: number }[];
  return new Map(rows.map((r) => [String(r.purpose), { avg: Number(r.avg) || 0, n: Number(r.n) || 0 }]));
}

/**
 * What running autopilot over `jobs` postings is likely to cost.
 *
 * A purpose with no history falls back to the average of everything else rather than to
 * zero — a step that has never run is not a free step, and reporting it as one would
 * understate exactly the runs that are new to you.
 */
export function estimateAutopilot(jobs: number): Estimate {
  const avg = averages();
  const known = [...avg.values()].filter((v) => v.avg > 0);
  const fallback = known.length ? known.reduce((n, v) => n + v.avg, 0) / known.length : 0;

  let perJob = 0;
  let samples = 0;
  for (const purpose of AUTOPILOT_PURPOSES) {
    const hit = avg.get(purpose);
    perJob += hit?.avg || fallback;
    samples += hit?.n || 0;
  }

  return {
    jobs,
    calls: jobs * AUTOPILOT_PURPOSES.length,
    perJobUsd: perJob,
    totalUsd: perJob * jobs,
    samples,
  };
}

/** Money spent by one session so far, so a ceiling can be enforced while it runs. */
export function sessionSpendUsd(sinceIso: string): number {
  const r = getDb()
    .prepare("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM llm_calls WHERE ts >= ?")
    .get(sinceIso) as { total: number };
  return Number(r?.total) || 0;
}

export const money = (n: number) => (n >= 1 ? `$${n.toFixed(2)}` : `${Math.round(n * 100)}¢`);
