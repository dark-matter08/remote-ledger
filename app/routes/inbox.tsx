import { useEffect } from "react";
import { Form, Link, useNavigation, useRevalidator } from "react-router";
import { Check } from "lucide-react";
import type { Route } from "./+types/inbox";
import { Shell } from "../components/Shell";
import { Select } from "../components/Select";
import { ConfirmForm } from "../components/ConfirmForm";
import {
  listAccounts, addAccount, removeAccount, setAccountInterval,
  pendingEmails, recentEmails, startSync, applyEmailUpdate, dismissEmail,
} from "../services/email.server";
import { getDb, getSetting, setSetting } from "../sqlite.server";
import { availableRunners } from "../llm/runner.server";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Application Mail · The Remote Ledger" }];
}

export async function loader() {
  const runners = await availableRunners();
  const db = getDb();
  return {
    hasRunner: runners.length > 0,
    accounts: listAccounts(),
    pending: pendingEmails(),
    recent: recentEmails(),
    syncing: !!db.prepare("SELECT 1 FROM crawl_runs WHERE type='email' AND status='running' LIMIT 1").get(),
    lastEmailRun: db.prepare("SELECT id,status FROM crawl_runs WHERE type='email' ORDER BY id DESC LIMIT 1").get() as any,
    autoApply: getSetting("email_autoapply") === "true",
    autoMin: getSetting("email_autoapply_min") || "85",
    scanLimit: getSetting("email_scan_limit") || "50",
    ingestAlerts: getSetting("email_ingest_alerts") !== "false",
  };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  if (intent === "add-account") {
    const r = addAccount({
      label: String(form.get("label") || ""),
      host: String(form.get("host") || ""),
      port: Number(form.get("port") || "993") || 993,
      secure: form.get("secure") !== "off",
      username: String(form.get("username") || ""),
      password: String(form.get("password") || ""),
      mailbox: String(form.get("mailbox") || "INBOX"),
      intervalMin: Number(form.get("interval") || "0") || 0,
    });
    if (r.error) return { error: r.error };
    startSync(r.id); // first read-only sync immediately
    return { ok: true, msg: "Mailbox connected (read-only). Syncing recent mail in the background…" };
  }
  if (intent === "sync") { startSync(Number(form.get("id"))); return { ok: true, msg: "Syncing…" }; }
  if (intent === "remove-account") { removeAccount(Number(form.get("id"))); return { ok: true, msg: "Mailbox disconnected and its queued mail removed." }; }
  if (intent === "interval") { setAccountInterval(Number(form.get("id")), Number(form.get("interval") || "0") || 0); return { ok: true, msg: "Auto-sync interval updated." }; }
  if (intent === "apply") { const r = applyEmailUpdate(Number(form.get("id"))); return r.ok ? { ok: true, msg: r.msg } : { error: r.msg }; }
  if (intent === "dismiss") { dismissEmail(Number(form.get("id"))); return { ok: true, msg: "Dismissed." }; }
  if (intent === "automation") {
    setSetting("email_autoapply", form.get("autoapply") ? "true" : "false");
    setSetting("email_autoapply_min", String(Number(form.get("autoMin") || "85") || 85));
    setSetting("email_scan_limit", String(Math.max(1, Math.min(500, Number(form.get("scanLimit") || "50") || 50))));
    setSetting("email_ingest_alerts", form.get("ingestAlerts") ? "true" : "false");
    return { ok: true, msg: "Automation settings saved." };
  }
  return { ok: true };
}

const CAT_BADGE: Record<string, string> = { offer: "ok", interview: "ok", screening: "warn", recruiter: "warn", receipt: "off", rejection: "on", other: "off" };

export default function Inbox({ loaderData, actionData }: Route.ComponentProps) {
  const { accounts, pending, recent, hasRunner, syncing, lastEmailRun, autoApply, autoMin, scanLimit, ingestAlerts } = loaderData;
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const revalidator = useRevalidator();

  useEffect(() => {
    if (!syncing) return;
    const t = setInterval(() => revalidator.revalidate(), 3000);
    return () => clearInterval(t);
  }, [syncing]);

  return (
    <Shell>
      <div className="page-head">
        <h1>Application Mail</h1>
        <div className="sub">Read-only · classifies job mail · proposes pipeline updates you approve</div>
      </div>
      <hr className="rule double" />

      {actionData?.error && <div className="notice err">{actionData.error}</div>}
      {actionData?.msg && <div className="notice ok">{actionData.msg}</div>}
      {!hasRunner && <div className="notice warn">Connect an AI runner in <Link to="/settings" className="entry-title-link">Settings</Link> to classify mail.</div>}

      <div className="notice warn" style={{ textTransform: "none", letterSpacing: 0 }}>
        <strong>Security:</strong> connect a <strong>dedicated job-application mailbox</strong> (or a <code>you+jobs@</code> alias), not your primary inbox. Access is <strong>read-only</strong> — nothing is sent, flagged, or deleted. Your password is encrypted on this machine; email bodies are treated as untrusted and never allowed to trigger actions. Every change waits for your approval below.
      </div>

      {/* connect a mailbox */}
      <div className="panel">
        <h3>Connect a mailbox (IMAP){syncing ? <span className="badge off">syncing…</span> : null}</h3>
        <p className="hint" style={{ textTransform: "none", letterSpacing: 0, fontSize: 13 }}>
          Use an <strong>app password</strong>, never your main account password. Gmail: enable 2FA, then create one at{" "}
          <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener noreferrer" className="entry-title-link">myaccount.google.com/apppasswords</a>{" "}
          (and turn on IMAP in Gmail settings). Fastmail/others: create an app password in your account settings.
        </p>
        <Form method="post">
          <input type="hidden" name="intent" value="add-account" />
          <div className="row2">
            <div className="field"><label>Label</label><input type="text" name="label" placeholder="Job applications" /></div>
            <div className="field"><label>IMAP host</label><input type="text" name="host" placeholder="imap.gmail.com" /></div>
          </div>
          <div className="row2">
            <div className="field"><label>Email / username</label><input type="text" name="username" placeholder="you+jobs@gmail.com" /></div>
            <div className="field"><label>App password</label><input type="password" name="password" placeholder="xxxx xxxx xxxx xxxx" autoComplete="off" /></div>
          </div>
          <div className="row2">
            <div className="field"><label>Mailbox</label><input type="text" name="mailbox" defaultValue="INBOX" /></div>
            <div className="field"><label>Auto-sync</label>
              <Select name="interval" defaultValue="0" options={[
                { value: "0", label: "Manual only" }, { value: "15", label: "Every 15 min" }, { value: "60", label: "Hourly" }, { value: "360", label: "Every 6 hours" },
              ]} />
            </div>
          </div>
          <input type="hidden" name="port" value="993" />
          <button className="btn" disabled={busy || !hasRunner}>Connect &amp; sync (read-only)</button>
        </Form>

        {accounts.length > 0 && (
          <div className="kb-sources" style={{ marginTop: 16 }}>
            {accounts.map((a: any) => (
              <div key={a.id} className="kb-source">
                <div className="kb-source-head">
                  {a.label ? <strong>{a.label}</strong> : null}
                  <span className="badge off">{a.username}</span>
                  <span className="kb-source-when">{a.last_synced_at ? `synced ${a.last_synced_at.slice(5, 16).replace("T", " ")}` : "not synced yet"}</span>
                </div>
                <code className="kb-source-path">{a.host}:{a.port} · {a.mailbox} · read-only</code>
                <div className="kb-source-actions">
                  <Form method="post" className="kb-source-interval">
                    <input type="hidden" name="intent" value="interval" /><input type="hidden" name="id" value={a.id} />
                    <Select name="interval" defaultValue={String(a.interval_min)} options={[
                      { value: "0", label: "Manual" }, { value: "15", label: "15 min" }, { value: "60", label: "Hourly" }, { value: "360", label: "6 hours" },
                    ]} />
                    <button className="back-link" disabled={busy}>set</button>
                  </Form>
                  <Form method="post"><input type="hidden" name="intent" value="sync" /><input type="hidden" name="id" value={a.id} /><button className="back-link" disabled={busy || syncing}>{syncing ? "syncing…" : "sync now"}</button></Form>
                  {lastEmailRun && <Link to={`/crawl?run=${lastEmailRun.id}`} className="back-link">logs</Link>}
                  <ConfirmForm method="post" title="Disconnect mailbox?" confirm="Removes the saved (encrypted) credentials and any queued mail for this account. Your pipeline stays." confirmLabel="Disconnect"><input type="hidden" name="intent" value="remove-account" /><input type="hidden" name="id" value={a.id} /><button className="back-link" disabled={busy}>remove</button></ConfirmForm>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* automation */}
      {accounts.length > 0 && (
        <div className="panel">
          <h3>Automation</h3>
          <p className="hint" style={{ textTransform: "none", letterSpacing: 0, fontSize: 13 }}>
            With auto-apply on, high-confidence matches advance the matched application's <strong>stage</strong> automatically during sync (and set an interview reminder if a time is found). It only moves pipeline stages — it never applies to a job or sends anything, and every move is logged and reversible. Off by default; review everything yourself.
          </p>
          <Form method="post">
            <input type="hidden" name="intent" value="automation" />
            <div className="row2">
              <div className="field"><label>Scan latest N emails per sync</label><input type="number" name="scanLimit" min="1" max="500" defaultValue={scanLimit} /></div>
              <div className="field"><label>Auto-apply minimum confidence</label><input type="number" name="autoMin" min="50" max="100" defaultValue={autoMin} /></div>
            </div>
            <div className="field" style={{ marginTop: 4 }}>
              <label style={{ margin: 0 }}><input type="checkbox" name="ingestAlerts" defaultChecked={ingestAlerts} /> Ingest job alerts — verify links in recruiter/job-board emails and add live roles to the ledger</label>
            </div>
            <div className="field">
              <label style={{ margin: 0 }}><input type="checkbox" name="autoapply" defaultChecked={autoApply} /> Auto-apply high-confidence stage updates</label>
            </div>
            <button className="btn" disabled={busy}>Save automation</button>
          </Form>
        </div>
      )}

      {/* review queue */}
      <div className="panel">
        <h3>To review {pending.length ? <span className="badge warn">{pending.length}</span> : <span className="badge ok">clear</span>}</h3>
        <p className="hint">Classified job mail. Approve to update the matched application's stage, or dismiss.</p>
        {pending.length === 0 ? (
          <p className="hint">Nothing waiting. Connect a mailbox and sync to populate this.</p>
        ) : (
          pending.map((m: any) => (
            <div key={m.id} className="mailrow">
              <div className="mailrow-head">
                <span className={`badge ${CAT_BADGE[m.category] || "off"}`}>{m.category}</span>
                <strong className="mailrow-subj">{m.subject || "(no subject)"}</strong>
                <span className="mailrow-when">{m.sent_at ? m.sent_at.slice(5, 16).replace("T", " ") : ""}</span>
              </div>
              <div className="mailrow-meta">from {m.from_name || m.from_addr}{m.confidence ? ` · ${m.confidence}% sure` : ""}</div>
              {m.summary && <p className="mailrow-sum">{m.summary}</p>}
              <div className="mailrow-foot">
                {m.job_id ? (
                  <span className="mailrow-match">→ <Link to={`/jobs/${m.job_id}`} className="entry-title-link">{m.job_id}</Link>{m.proposed_stage ? <> · suggest <strong>{m.proposed_stage}</strong></> : null}</span>
                ) : (
                  <span className="mailrow-match" style={{ color: "var(--ink-faint)" }}>no matching application</span>
                )}
                <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                  {m.job_id && m.proposed_stage && (
                    <Form method="post"><input type="hidden" name="intent" value="apply" /><input type="hidden" name="id" value={m.id} /><button className="ghost-btn" disabled={busy} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><Check size={13} /> Apply</button></Form>
                  )}
                  <Form method="post"><input type="hidden" name="intent" value="dismiss" /><input type="hidden" name="id" value={m.id} /><button className="back-link" disabled={busy}>dismiss</button></Form>
                </span>
              </div>
            </div>
          ))
        )}
        {recent.length > 0 && (
          <details style={{ marginTop: 12 }}>
            <summary style={{ cursor: "pointer", fontFamily: "var(--mono)", fontSize: 11, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--ink-faint)" }}>Processed ({recent.length})</summary>
            {recent.map((m: any) => (
              <div key={m.id} className="hint" style={{ textTransform: "none", letterSpacing: 0, fontSize: 13, margin: "6px 0" }}>
                <span className={`badge ${m.status === "applied" ? "ok" : "off"}`}>{m.status}</span> {m.category} — {m.subject}
              </div>
            ))}
          </details>
        )}
      </div>
    </Shell>
  );
}
