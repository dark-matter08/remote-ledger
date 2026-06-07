import type { Route } from "./+types/usage";
import { Shell } from "../components/Shell";
import { usageSummary } from "../llm/runner.server";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Usage · The Remote Ledger" }];
}

export async function loader() {
  return usageSummary();
}

const money = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;
const tok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export default function Usage({ loaderData }: Route.ComponentProps) {
  const u = loaderData;
  const maxPurpose = Math.max(1, ...u.byPurpose.map((p) => p.cost));
  return (
    <Shell>
      <div className="page-head">
        <h1>Usage &amp; Cost</h1>
        <div className="sub">Token &amp; spend tracking across every AI call</div>
      </div>
      <hr className="rule double" />

      {u.budget.cap > 0 && (
        <div className={`notice ${u.budget.over ? "err" : u.budget.near ? "warn" : "ok"}`}>
          Monthly budget: {money(u.budget.spent)} / {money(u.budget.cap)}{" "}
          {u.budget.over ? "— cap reached, metered calls are blocked" : u.budget.near ? "— approaching cap" : ""}
        </div>
      )}

      <div className="stat-grid">
        <div className="stat"><div className="k">This month</div><div className="v">{money(u.monthCost)}</div></div>
        <div className="stat"><div className="k">All time</div><div className="v">{money(u.totalCost)}</div></div>
        <div className="stat"><div className="k">Calls</div><div className="v">{u.totalCalls}</div></div>
        <div className="stat"><div className="k">Tokens in / out</div><div className="v" style={{ fontSize: 22 }}>{tok(u.totalInTok)} <small>/ {tok(u.totalOutTok)}</small></div></div>
      </div>

      <div className="panel">
        <h3>Spend by purpose</h3>
        {u.byPurpose.length === 0 ? (
          <p className="hint">No calls yet. Tailor a resume or run a crawl to see costs here.</p>
        ) : (
          <div className="barchart">
            {u.byPurpose.map((p) => (
              <div className="bar-row" key={p.purpose}>
                <span>{p.purpose}</span>
                <span className="bar" style={{ width: `${Math.max(2, (p.cost / maxPurpose) * 100)}%` }} />
                <span style={{ textAlign: "right" }}>{money(p.cost)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="panel">
        <h3>By runner</h3>
        <table className="ledger-table">
          <thead><tr><th>Runner</th><th>Calls</th><th>Cost</th></tr></thead>
          <tbody>
            {u.byRunner.map((r) => (
              <tr key={r.runner}><td>{r.runner}</td><td>{r.calls}</td><td>{money(r.cost)}</td></tr>
            ))}
            {u.byRunner.length === 0 && <tr><td colSpan={3}>—</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <h3>Recent calls</h3>
        <table className="ledger-table">
          <thead><tr><th>When</th><th>Runner</th><th>Purpose</th><th>In/Out</th><th>Cost</th><th>Status</th></tr></thead>
          <tbody>
            {u.recent.map((c: any, i: number) => (
              <tr key={i}>
                <td>{c.ts.slice(5, 16).replace("T", " ")}</td>
                <td>{c.runner}</td>
                <td>{c.purpose}</td>
                <td>{tok(c.in_tok)}/{tok(c.out_tok)}</td>
                <td>{c.metered ? money(c.cost_usd) : "sub"}</td>
                <td>{c.status === "ok" ? <span className="badge ok">ok</span> : <span className="badge on">err</span>}</td>
              </tr>
            ))}
            {u.recent.length === 0 && <tr><td colSpan={6}>No calls recorded yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </Shell>
  );
}
