import { useEffect, useRef } from "react";
import { Form, Link, redirect, useNavigation, useRevalidator } from "react-router";
import type { Route } from "./+types/crawl";
import { Shell } from "../components/Shell";
import { listCrawlRuns, activeCrawl, getCrawlRun, crawlLogs, updateCrawlRun, crawlLog } from "../db.server";
import { startCrawl, isCrawlRunning, abortCrawl, type CrawlType } from "../services/crawl.server";
import { availableRunners } from "../llm/runner.server";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Crawl Shell · The Remote & Ledger" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const runs = listCrawlRuns(25);
  const active = activeCrawl();
  const selId = Number(url.searchParams.get("run") || active?.id || runs[0]?.id || 0);
  const selected = selId ? getCrawlRun(selId) : null;
  const runners = await availableRunners();
  return {
    runs,
    active,
    selected,
    logs: selected ? crawlLogs(selected.id) : [],
    hasRunner: runners.length > 0,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  if (form.get("intent") === "start") {
    if (isCrawlRunning()) return { error: "A crawl is already running." };
    const type = (String(form.get("type") || "find") as CrawlType);
    const id = startCrawl(type, "manual");
    return redirect(`/crawl?run=${id}`);
  }
  if (form.get("intent") === "stop") {
    const a = activeCrawl();
    if (a) {
      const killed = abortCrawl(a.id); // actually terminate the agent process
      crawlLog(a.id, "error", killed ? "Stopped by user — agent process killed." : "Marked stopped (no live process in this server).");
      updateCrawlRun(a.id, { status: "error", ended_at: new Date().toISOString(), note: "stopped by user" });
    }
    return redirect(`/crawl?run=${a?.id ?? ""}`);
  }
  return { ok: true };
}

const TYPE_LABEL: Record<string, string> = { find: "Find new jobs", update: "Update descriptions", full: "Full refresh", scan: "Folder scan", email: "Email sync" };

export default function Crawl({ loaderData, actionData }: Route.ComponentProps) {
  const { runs, active, selected, logs, hasRunner } = loaderData;
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const revalidator = useRevalidator();
  const shellRef = useRef<HTMLDivElement>(null);
  const live = selected?.status === "running" || !!active;

  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => revalidator.revalidate(), 2500);
    return () => clearInterval(t);
  }, [live, selected?.id]);

  // keep the shell scrolled to the newest line while live
  useEffect(() => {
    if (live && shellRef.current) shellRef.current.scrollTop = shellRef.current.scrollHeight;
  }, [logs.length, live]);

  return (
    <Shell>
      <div className="page-head">
        <h1>Crawl Shell</h1>
        <div className="sub">Run crawls · watch the reasoning live · replay history</div>
      </div>
      <hr className="rule double" />

      {actionData?.error && <div className="notice err">{actionData.error}</div>}
      {!hasRunner && <div className="notice warn">No AI runner connected — a Find crawl needs one. <Link to="/settings" className="entry-title-link">Settings</Link>.</div>}

      <div className="panel">
        <h3>Run a crawl {active && <span className="badge warn">running #{active.id}</span>}</h3>
        <p className="hint">Find pulls fresh roles from the web. Update re-scrapes descriptions for jobs already on file. Full does both.</p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          {(["find", "update", "full"] as CrawlType[]).map((t) => (
            <Form method="post" key={t}>
              <input type="hidden" name="intent" value="start" />
              <input type="hidden" name="type" value={t} />
              <button className={t === "find" ? "btn" : "ghost-btn"} disabled={busy || !!active || (t !== "update" && !hasRunner)}>
                {busy ? "Starting…" : TYPE_LABEL[t]}
              </button>
            </Form>
          ))}
          {active && (
            <Form method="post" style={{ marginLeft: "auto" }}>
              <input type="hidden" name="intent" value="stop" />
              <button className="ghost-btn">■ Stop run #{active.id}</button>
            </Form>
          )}
        </div>
      </div>

      {/* live / replay shell */}
      {selected && (
        <div className="panel">
          <h3>
            Run #{selected.id} · {TYPE_LABEL[selected.type] || selected.type}{" "}
            <span className={`badge ${selected.status === "done" ? "ok" : selected.status === "error" ? "on" : "warn"}`}>{selected.status}</span>
            {selected.status === "running" && <span className="live-dot" style={{ marginLeft: 8 }} />}
          </h3>
          <p className="hint">
            {selected.started_at.slice(5, 16).replace("T", " ")} · {selected.received} found · {selected.inserted} new · {selected.updated} updated · {selected.scraped} scraped{selected.errors ? ` · ${selected.errors} errors` : ""}
          </p>
          <div className="shell" ref={shellRef}>
            {logs.length === 0 ? (
              <div className="ln"><span className="msg" style={{ opacity: 0.6 }}>waiting for output…</span></div>
            ) : (
              logs.map((l: any) => (
                <div className={`ln k-${l.kind}`} key={l.id}>
                  <span className="t">{l.ts.slice(11, 19)}</span>
                  <span className="kk">{l.kind}</span>
                  <span className="msg">{l.text}</span>
                </div>
              ))
            )}
            {live && <div className="ln"><span className="msg cursor">▋</span></div>}
          </div>
        </div>
      )}

      {/* history */}
      <div className="panel">
        <h3>Crawl history</h3>
        {runs.length === 0 ? <p className="hint">No crawls yet.</p> : (
          <table className="ledger-table">
            <thead><tr><th>#</th><th>When</th><th>Type</th><th>Status</th><th>New</th><th>Upd</th><th>Scraped</th><th>By</th><th></th></tr></thead>
            <tbody>
              {runs.map((r: any) => (
                <tr key={r.id} style={selected?.id === r.id ? { background: "var(--card)" } : undefined}>
                  <td>{r.id}</td>
                  <td>{r.started_at.slice(5, 16).replace("T", " ")}</td>
                  <td>{TYPE_LABEL[r.type] || r.type}</td>
                  <td><span className={`badge ${r.status === "done" ? "ok" : r.status === "error" ? "on" : "warn"}`}>{r.status}</span></td>
                  <td>{r.inserted}</td>
                  <td>{r.updated}</td>
                  <td>{r.scraped}</td>
                  <td>{r.trigger}</td>
                  <td><Link to={`/crawl?run=${r.id}`} className="back-link">view ▸</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Shell>
  );
}
