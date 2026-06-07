import { Link } from "react-router";
import type { Route } from "./+types/analytics";
import { Shell } from "../components/Shell";
import { funnel, reminders, sourceStats } from "../db.server";
import { STAGE_LABEL } from "../stages";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Analytics · The Remote Ledger" }];
}

export async function loader() {
  return { funnel: funnel(), reminders: reminders(), sources: sourceStats() };
}

export default function Analytics({ loaderData }: Route.ComponentProps) {
  const { funnel: f, reminders: rem, sources } = loaderData;
  const stages = ["saved", "applied", "screening", "interview", "offer", "rejected", "withdrawn"] as const;
  const maxStage = Math.max(1, ...stages.map((s) => f.counts[s]));

  return (
    <Shell>
      <div className="page-head">
        <h1>Analytics</h1>
        <div className="sub">Funnel · Conversion · Reminders</div>
      </div>
      <hr className="rule double" />

      <div className="stat-grid">
        <div className="stat"><div className="k">Applied</div><div className="v">{f.applied}</div></div>
        <div className="stat"><div className="k">Interviewing+</div><div className="v">{f.interview}</div></div>
        <div className="stat"><div className="k">Offers</div><div className="v">{f.offer}</div></div>
        <div className="stat"><div className="k">Applied → Interview</div><div className="v">{f.appliedToInterview}<small>%</small></div></div>
        <div className="stat"><div className="k">Interview → Offer</div><div className="v">{f.interviewToOffer}<small>%</small></div></div>
      </div>

      <div className="panel">
        <h3>Pipeline funnel</h3>
        <div className="barchart">
          {stages.map((s) => (
            <div className="bar-row" key={s}>
              <span>{STAGE_LABEL[s]}</span>
              <span className="bar" style={{ width: `${Math.max(2, (f.counts[s] / maxStage) * 100)}%` }} />
              <span style={{ textAlign: "right" }}>{f.counts[s]}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="panel">
        <h3>By source</h3>
        <p className="hint">Where roles come from, and how many you've applied to / reached interview.</p>
        <table className="ledger-table">
          <thead><tr><th>Source</th><th>On file</th><th>Applied</th><th>Interview+</th></tr></thead>
          <tbody>
            {sources.map((s) => (
              <tr key={s.source}><td>{s.source}</td><td>{s.total}</td><td>{s.applied}</td><td>{s.interview}</td></tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <h3>Reminders &amp; nudges</h3>
        {rem.length === 0 ? (
          <p className="hint">All clear — nothing needs attention right now.</p>
        ) : (
          <ul className="timeline">
            {rem.map((r, i) => (
              <li key={i} style={{ gridTemplateColumns: "1fr 160px 90px" }}>
                <Link to={`/jobs/${r.job.id}`} className="entry-title-link">{r.job.company} — {r.job.role}</Link>
                <span className="t-type">{r.reason}</span>
                <span className="t-when" style={{ textAlign: "right" }}>{r.due ? r.due.slice(0, 10) : ""}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Shell>
  );
}
