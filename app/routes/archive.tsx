import { Form, Link, useNavigation } from "react-router";
import type { Route } from "./+types/archive";
import { Shell } from "../components/Shell";
import { getArchive, restoreJob } from "../db.server";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Archive · The Remote Ledger" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const q = new URL(request.url).searchParams.get("q") || "";
  return { jobs: getArchive(q), q };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  if (form.get("intent") === "restore") {
    restoreJob(String(form.get("id")));
    return { ok: true, msg: "Restored to the ledger." };
  }
  return { ok: true };
}

export default function Archive({ loaderData, actionData }: Route.ComponentProps) {
  const { jobs, q } = loaderData;
  const nav = useNavigation();
  const busy = nav.state !== "idle";

  return (
    <Shell>
      <div className="page-head">
        <h1>Archive</h1>
        <div className="sub">Found jobs no longer on the ledger · revisit or restore</div>
      </div>
      <hr className="rule double" />

      {actionData?.msg && <div className="notice ok">{actionData.msg}</div>}

      <Form method="get" className="panel" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <input type="text" name="q" defaultValue={q} placeholder="Search company or role…" style={{ flex: 1, minWidth: 220 }} />
        <button className="ghost-btn" disabled={busy}>Search</button>
        <span className="hint" style={{ margin: 0 }}>{jobs.length} archived</span>
      </Form>

      <div className="panel">
        <p className="hint">These were found earlier but later went inactive (cleared by an old crawl, or marked closed when a link went dead). Restore any to bring it back to the ledger.</p>
        {jobs.length === 0 ? (
          <p className="hint">{q ? "No archived jobs match that search." : "Nothing archived."}</p>
        ) : (
          <table className="ledger-table">
            <thead><tr><th>Role</th><th>Cat</th><th>Fit</th><th>Source</th><th>Last seen</th><th></th></tr></thead>
            <tbody>
              {jobs.map((j: any) => (
                <tr key={j.id}>
                  <td><Link to={`/jobs/${j.id}`} className="entry-title-link">{j.company} — {j.role}</Link></td>
                  <td>{j.category}</td>
                  <td>{j.fit_score}</td>
                  <td>{j.source || "—"}</td>
                  <td>{j.last_seen ? j.last_seen.slice(0, 10) : "—"}</td>
                  <td style={{ display: "flex", gap: 10 }}>
                    <Form method="post"><input type="hidden" name="intent" value="restore" /><input type="hidden" name="id" value={j.id} /><button className="back-link" disabled={busy}>restore</button></Form>
                    <Link to={`/jobs/${j.id}`} className="back-link">open</Link>
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
