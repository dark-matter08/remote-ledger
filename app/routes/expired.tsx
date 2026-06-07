import { Form, Link, useNavigation } from "react-router";
import type { Route } from "./+types/expired";
import { Shell } from "../components/Shell";
import { getExpired, getClosingSoon, setClosesAt, setStage } from "../db.server";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Expired · The Remote Ledger" }];
}

export async function loader() {
  return { expired: getExpired(), soon: getClosingSoon(7) };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const id = String(form.get("id"));
  if (form.get("intent") === "reopen") {
    setClosesAt(id, null); // clears the deadline -> back to the ledger
    return { ok: true, msg: "Reopened — deadline cleared." };
  }
  if (form.get("intent") === "withdraw") {
    setStage(id, "withdrawn");
    return { ok: true, msg: "Withdrawn." };
  }
  return { ok: true };
}

function daysLeft(closes: string): number {
  return Math.ceil((new Date(closes + "T00:00:00Z").getTime() - Date.now()) / 864e5);
}

export default function Expired({ loaderData, actionData }: Route.ComponentProps) {
  const { expired, soon } = loaderData;
  const nav = useNavigation();
  const busy = nav.state !== "idle";

  return (
    <Shell>
      <div className="page-head">
        <h1>Expired &amp; Closing</h1>
        <div className="sub">Deadlines watched · expired roles leave the ledger automatically</div>
      </div>
      <hr className="rule double" />
      {actionData?.msg && <div className="notice ok">{actionData.msg}</div>}

      <div className="panel">
        <h3>Closing soon {soon.length ? <span className="badge warn">{soon.length}</span> : null}</h3>
        <p className="hint">Still open, deadline within 7 days. Apply before they expire.</p>
        {soon.length === 0 ? <p className="hint">Nothing closing this week.</p> : (
          <table className="ledger-table">
            <thead><tr><th>Company</th><th>Role</th><th>Closes</th><th>Left</th><th></th></tr></thead>
            <tbody>
              {soon.map((j) => (
                <tr key={j.id}>
                  <td><Link to={`/jobs/${j.id}`} className="entry-title-link">{j.company}</Link></td>
                  <td>{j.role}</td>
                  <td>{j.closes_at}</td>
                  <td><span className="badge warn">{daysLeft(j.closes_at!)}d</span></td>
                  <td><a className="back-link" href={j.apply_url} target="_blank" rel="noreferrer">apply ▸</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel">
        <h3>Expired {expired.length ? <span className="badge off">{expired.length}</span> : null}</h3>
        <p className="hint">Deadline passed — hidden from the ledger &amp; pipeline. Reopen if the posting is still live.</p>
        {expired.length === 0 ? <p className="hint">No expired roles.</p> : (
          <table className="ledger-table">
            <thead><tr><th>Company</th><th>Role</th><th>Closed</th><th>Fit</th><th></th></tr></thead>
            <tbody>
              {expired.map((j) => (
                <tr key={j.id}>
                  <td><Link to={`/jobs/${j.id}`} className="entry-title-link">{j.company}</Link></td>
                  <td>{j.role}</td>
                  <td>{j.closes_at}</td>
                  <td>{j.fit_score}</td>
                  <td style={{ display: "flex", gap: 8 }}>
                    <Form method="post"><input type="hidden" name="intent" value="reopen" /><input type="hidden" name="id" value={j.id} /><button className="back-link" disabled={busy}>reopen</button></Form>
                    <Form method="post"><input type="hidden" name="intent" value="withdraw" /><input type="hidden" name="id" value={j.id} /><button className="back-link" disabled={busy}>withdraw</button></Form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Shell>
  );
}
