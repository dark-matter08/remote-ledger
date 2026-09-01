import { Form, Link, useNavigation } from "react-router";
import type { Route } from "./+types/archive";
import { Shell } from "../components/Shell";
import { getArchive, restoreJob, listBlocks, unblock } from "../db.server";
import { REASON_LABEL } from "../trash";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Archive · The Remote Ledger" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const q = new URL(request.url).searchParams.get("q") || "";
  return { jobs: getArchive(q), blocks: listBlocks(), q };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  if (form.get("intent") === "restore") {
    restoreJob(String(form.get("id")));
    return { ok: true, msg: "Restored to the ledger." };
  }
  if (form.get("intent") === "unblock") {
    unblock(Number(form.get("id")));
    return { ok: true, msg: "Un-blocked. Future crawls may surface it again." };
  }
  return { ok: true };
}

export default function Archive({ loaderData, actionData }: Route.ComponentProps) {
  const { jobs, blocks, q } = loaderData;
  const nav = useNavigation();
  const busy = nav.state !== "idle";

  return (
    <Shell>
      <div className="page-head">
        <h1>Archive</h1>
        <div className="sub">Found jobs no longer on the ledger · revisit, restore, or review what you blocked</div>
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

      <div className="panel">
        <h3>Blocked {blocks.length ? <span className="badge warn">{blocks.length}</span> : <span className="badge off">none</span>}</h3>
        <p className="hint">
          Trashed jobs are deleted, not archived, so no crawl can bring them back. Every entry here is
          also fed to the crawler as something you rejected and why. Un-block to let it be found again.
        </p>
        {blocks.length === 0 ? (
          <p className="hint">Nothing blocked. Trash a job from the ledger to teach the crawler what to skip.</p>
        ) : (
          <table className="ledger-table">
            <thead><tr><th>Blocked</th><th>Scope</th><th>Why</th><th>Your note</th><th>When</th><th></th></tr></thead>
            <tbody>
              {blocks.map((b: any) => (
                <tr key={b.id}>
                  <td>{b.scope === "domain" ? b.value : b.company || b.value}{b.scope === "job" && b.role ? <span className="hint" style={{ margin: 0 }}> — {b.role}</span> : null}</td>
                  <td>{b.scope === "job" ? "this posting" : b.scope === "company" ? "whole company" : "whole domain"}</td>
                  <td>{REASON_LABEL.get(b.reason) || b.reason}</td>
                  <td>{b.note || "—"}</td>
                  <td>{b.created_at ? b.created_at.slice(0, 10) : "—"}</td>
                  <td>
                    <Form method="post"><input type="hidden" name="intent" value="unblock" /><input type="hidden" name="id" value={b.id} /><button className="back-link" disabled={busy}>un-block</button></Form>
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
