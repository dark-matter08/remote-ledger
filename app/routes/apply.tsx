import { useEffect } from "react";
import { Form, Link, redirect, useNavigation, useRevalidator } from "react-router";
import type { Route } from "./+types/apply";
import { Shell } from "../components/Shell";
import { Select } from "../components/Select";
import { ConfirmForm } from "../components/ConfirmForm";
import {
  listSessions,
  getSession,
  sessionJobs,
  sessionLogs,
  openQuestions,
  answeredQuestions,
  answerPooledQuestion,
  clearQuestionPool,
  answerBank,
} from "../db.server";
import { startSession, resumeSession, type ApplyRules } from "../services/apply-session.server";
import { availableRunners } from "../llm/runner.server";
import { getDefaultProfile } from "../resume/profiles.server";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Auto-Apply · The Remote Ledger" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const sel = Number(url.searchParams.get("session") || "0");
  const runners = await availableRunners();
  const active = sel ? getSession(sel) : null;
  return {
    ready: { hasRunner: runners.length > 0, hasProfile: !!getDefaultProfile() },
    sessions: listSessions(),
    pool: openQuestions(),
    bankCount: answerBank().length,
    recentAnswers: answeredQuestions(8),
    active,
    activeJobs: active ? sessionJobs(active.id) : [],
    activeLogs: active ? sessionLogs(active.id) : [],
  };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = form.get("intent");
  if (intent === "answer") {
    answerPooledQuestion(Number(form.get("id")), String(form.get("answer") || "").trim());
    return { ok: true, msg: "Answer saved to your context bank." };
  }
  if (intent === "clear-pool") {
    const n = clearQuestionPool();
    return { ok: true, msg: n ? `Cleared ${n} pooled question(s).` : "Pool already empty." };
  }
  if (intent === "resume") {
    const sid = Number(form.get("sessionId"));
    resumeSession(sid);
    return redirect(`/apply?session=${sid}`);
  }
  if (intent === "start") {
    const rules: ApplyRules = {
      categories: form.getAll("cat").map(String),
      minFit: Number(form.get("minFit") || "0") || 0,
      stages: form.getAll("stage").map(String),
      max: Math.min(12, Number(form.get("max") || "5") || 5),
      requireJd: !!form.get("requireJd"),
    };
    const mode = (String(form.get("mode") || "draft") as "draft" | "assist");
    const id = startSession(mode, rules); // returns immediately; runs in background
    return redirect(`/apply?session=${id}`);
  }
  return { ok: true };
}

const STATUS_BADGE: Record<string, string> = {
  drafted: "ok",
  needs_input: "warn",
  failed: "on",
  applying: "off",
  queued: "off",
};

export default function Apply({ loaderData, actionData }: Route.ComponentProps) {
  const { ready, sessions, pool, bankCount, recentAnswers, active, activeJobs, activeLogs } = loaderData;
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const revalidator = useRevalidator();

  // live monitor: while a session is running, poll for updates
  useEffect(() => {
    if (active?.status !== "running") return;
    const t = setInterval(() => revalidator.revalidate(), 3500);
    return () => clearInterval(t);
  }, [active?.status, active?.id]);

  return (
    <Shell>
      <div className="page-head">
        <h1>Auto-Apply</h1>
        <div className="sub">Manual sessions · rule-based · fully logged · never submits</div>
      </div>
      <hr className="rule double" />

      {actionData?.msg && <div className="notice ok">{actionData.msg}</div>}
      {(!ready.hasRunner || !ready.hasProfile) && (
        <div className="notice warn">
          {!ready.hasProfile && <>Upload a base résumé on <Link to="/resume" className="entry-title-link">Résumés</Link>. </>}
          {!ready.hasRunner && <>Connect a runner in <Link to="/settings" className="entry-title-link">Settings</Link>.</>}
        </div>
      )}

      {/* start a session */}
      <Form method="post" className="panel">
        <input type="hidden" name="intent" value="start" />
        <h3>Start a session</h3>
        <p className="hint">The agent opens each matching posting, screenshots it, drafts an answer per question, and pools anything it can't answer. It does not submit.</p>
        <div className="field">
          <label>Apply to which categories</label>
          <div className="checkrow">
            {["high", "medium", "stretch"].map((c) => (
              <label key={c}><input type="checkbox" name="cat" value={c} defaultChecked={c !== "stretch"} /> {c}</label>
            ))}
          </div>
        </div>
        <div className="field">
          <label>Only these stages</label>
          <div className="checkrow">
            {["saved", "applied", "interview"].map((s) => (
              <label key={s}><input type="checkbox" name="stage" value={s} defaultChecked={s === "saved"} /> {s}</label>
            ))}
          </div>
        </div>
        <div className="row2">
          <div className="field"><label>Minimum fit score</label><input type="number" name="minFit" defaultValue="75" min="0" max="100" /></div>
          <div className="field"><label>Max applications this session</label><input type="number" name="max" defaultValue="5" min="1" max="12" /></div>
        </div>
        <div className="row2">
          <div className="field"><label>Mode</label>
            <Select name="mode" defaultValue="draft" options={[{ value: "draft", label: "Draft (headless, capture + answers)" }, { value: "assist", label: "Assist (also captures JD)" }]} />
          </div>
          <div className="field" style={{ display: "flex", alignItems: "flex-end" }}>
            <label style={{ margin: 0 }}><input type="checkbox" name="requireJd" defaultChecked /> Capture full JD if missing</label>
          </div>
        </div>
        <button className="btn" disabled={busy || !ready.hasRunner || !ready.hasProfile}>{busy ? "Starting…" : "▶ Start session"}</button>
      </Form>

      {/* question pool */}
      <div className="panel">
        <h3 style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span>Question pool</span>
          {pool.length ? (
            <>
              <span className="badge warn">{pool.length} open</span>
              <ConfirmForm method="post" title="Clear question pool?" confirm={`Discard all ${pool.length} unanswered pooled question(s)? Already-answered ones in your context bank stay.`} confirmLabel="Clear pool" style={{ marginLeft: "auto" }}>
                <input type="hidden" name="intent" value="clear-pool" />
                <button className="ghost-btn" disabled={busy}>Clear</button>
              </ConfirmForm>
            </>
          ) : (
            <span className="badge ok">empty</span>
          )}
        </h3>
        <p className="hint">Questions the agent couldn't answer truthfully. Answer once — saved to your context bank ({bankCount}) and reused automatically next time.</p>
        {pool.length === 0 ? (
          <p className="hint">Nothing waiting on you.</p>
        ) : (
          pool.map((q: any) => (
            <Form method="post" key={q.id} className="qpool">
              <input type="hidden" name="intent" value="answer" />
              <input type="hidden" name="id" value={q.id} />
              <div className="qpool-q">{q.question} {q.company ? <span className="qpool-job">— {q.company}</span> : null}</div>
              <textarea name="answer" placeholder="Your answer (saved for reuse)…" />
              <button className="ghost-btn" disabled={busy}>Save answer</button>
            </Form>
          ))
        )}
        {recentAnswers.length > 0 && (
          <details style={{ marginTop: 12 }}>
            <summary style={{ cursor: "pointer", fontFamily: "var(--mono)", fontSize: 11, textTransform: "uppercase", letterSpacing: ".1em", color: "var(--ink-faint)" }}>Answered context bank</summary>
            {recentAnswers.map((q: any) => (
              <div key={q.id} className="version"><div className="version-head">{q.question}</div><pre className="letter">{q.answer}</pre></div>
            ))}
          </details>
        )}
      </div>

      {/* sessions list */}
      <div className="panel">
        <h3>Sessions</h3>
        {sessions.length === 0 ? <p className="hint">No sessions yet.</p> : (
          <table className="ledger-table">
            <thead><tr><th>#</th><th>When</th><th>Mode</th><th>Status</th><th>Done</th><th>Needs input</th><th></th></tr></thead>
            <tbody>
              {sessions.map((s: any) => (
                <tr key={s.id}>
                  <td>{s.id}</td>
                  <td>{s.started_at.slice(5, 16).replace("T", " ")}</td>
                  <td>{s.mode}</td>
                  <td><span className={`badge ${s.status === "done" ? "ok" : s.status === "error" ? "on" : "off"}`}>{s.status}</span></td>
                  <td>{s.processed}/{s.total}</td>
                  <td>{s.needs_input}</td>
                  <td><Link to={`/apply?session=${s.id}`} className="back-link">view ▸</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* session detail */}
      {active && (
        <div className="panel">
          <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
            <h3 style={{ margin: 0 }}>Session #{active.id} — monitor</h3>
            {activeJobs.some((j: any) => j.status === "needs_input") && (
              <Form method="post" style={{ marginLeft: "auto" }}>
                <input type="hidden" name="intent" value="resume" />
                <input type="hidden" name="sessionId" value={active.id} />
                <button className="btn" disabled={busy} title="Apply your pooled answers and complete the remaining jobs">
                  {busy ? "Resuming…" : "▶ Resume session"}
                </button>
              </Form>
            )}
          </div>
          <p className="hint">{active.mode} · {active.status} · {active.processed}/{active.total} processed · {active.needs_input} need input</p>
          {active.needs_input > 0 && (
            <p className="hint">Answer the open questions in the pool above, then Resume — answered jobs flip to <strong>drafted</strong>.</p>
          )}
          <table className="ledger-table">
            <thead><tr><th>Job</th><th>Status</th><th>Qs</th><th>Unanswered</th><th>Shot</th></tr></thead>
            <tbody>
              {activeJobs.map((j: any) => (
                <tr key={j.id}>
                  <td><Link to={`/jobs/${j.job_id}`} className="entry-title-link">{j.company || j.job_id}</Link></td>
                  <td><span className={`badge ${STATUS_BADGE[j.status] || "off"}`}>{j.status}</span></td>
                  <td>{j.questions}</td>
                  <td>{j.unanswered}</td>
                  <td>{j.shot_path ? <a className="back-link" href={`/apply/shot/${logIdFor(activeLogs, j.job_id)}`} target="_blank" rel="noreferrer">view</a> : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3 style={{ marginTop: 18 }}>Activity log</h3>
          <ul className="timeline">
            {activeLogs.map((l: any) => (
              <li key={l.id} style={{ gridTemplateColumns: "120px 100px 1fr" }}>
                <span className="t-when">{l.ts.slice(11, 19)}</span>
                <span className="t-type">{l.kind}</span>
                <span className="t-pay">
                  {l.kind === "screenshot" ? <a className="back-link" href={`/apply/shot/${l.id}`} target="_blank" rel="noreferrer">open screenshot ▸</a> : (l.text || "")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Shell>
  );
}

function logIdFor(logs: any[], jobId: string): number | string {
  const l = logs.find((x) => x.job_id === jobId && x.kind === "screenshot");
  return l ? l.id : "0";
}
