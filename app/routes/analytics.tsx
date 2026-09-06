import { Link } from "react-router";
import type { Route } from "./+types/analytics";
import { Shell } from "../components/Shell";
import { funnel, reminders, sourceStats, channelStats} from "../db.server";
import { STAGE_LABEL } from "../stages";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Analytics · The Remote Ledger" }];
}

export async function loader() {
  return {
    channels: channelStats(), funnel: funnel(), reminders: reminders(), sources: sourceStats() };
}

export default function Analytics({ loaderData }: Route.ComponentProps) {
  const { funnel: f, reminders: rem, sources, channels } = loaderData;
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
        <h3>By channel</h3>
        <p className="hint">
          How a role reached you, rather than who was hiring. Counted across every job, closed ones
          included &mdash; an application to a posting that has since closed is the most informative row there is.
        </p>
        <table className="ledger-table">
          <thead><tr><th>Channel</th><th>Found</th><th>Applied</th><th>Applied %</th><th>Interview+</th><th>Offer</th></tr></thead>
          <tbody>
            {channels.map((c: any) => (
              <tr key={c.channel}>
                <td>{c.channel}</td>
                <td>{c.found}</td>
                <td>{c.applied}</td>
                <td style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--ink-faint)" }}>
                  {c.found ? `${Math.round((c.applied / c.found) * 100)}%` : "—"}
                </td>
                <td>{c.interview}</td>
                <td>{c.offer}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <h3>By posting</h3>
        <p className="hint">The raw source line on each posting. Useful for spotting one company or board carrying the ledger.</p>
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
