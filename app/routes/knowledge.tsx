import { useEffect } from "react";
import { Form, Link, useNavigation, useRevalidator } from "react-router";
import type { Route } from "./+types/knowledge";
import { Shell } from "../components/Shell";
import { FolderScan } from "../components/FolderScan";
import {
  kbItems,
  kbOpenQuestions,
  kbSuggestions,
  kbScans,
  activeScan,
  addManualNote,
  startScanFromUpload,
  answerKbQuestion,
  redraftItem,
  acceptSuggestion,
  dismissSuggestion,
  deleteKbItem,
} from "../services/kb.server";
import { availableRunners } from "../llm/runner.server";
import { getDefaultProfile } from "../resume/profiles.server";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Knowledge Base · The Remote Ledger" }];
}

export async function loader() {
  const runners = await availableRunners();
  return {
    hasRunner: runners.length > 0,
    hasProfile: !!getDefaultProfile(),
    items: kbItems(),
    questions: kbOpenQuestions(),
    suggestions: kbSuggestions("pending"),
    scans: kbScans(),
    scanning: !!activeScan(),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  try {
    if (intent === "kb-note") {
      const text = String(form.get("text") || "").trim();
      if (text.length < 12) return { error: "Tell me a bit more about what you're working on." };
      await addManualNote(text);
      return { ok: true, msg: "Captured. Drafted bullets and a few questions for you below." };
    }
    if (intent === "kb-scan") {
      let parsed: any = null;
      try { parsed = JSON.parse(String(form.get("payload") || "")); } catch {}
      if (!parsed?.projects?.length) return { error: "Pick a folder that has at least one project (a README or manifest)." };
      const r = startScanFromUpload(parsed.label || "folder", parsed.projects);
      if (r.error) return { error: r.error };
      return { ok: true, msg: `Scanning ${parsed.projects.length} project(s) in the background…` };
    }
    if (intent === "kb-answer") {
      answerKbQuestion(Number(form.get("id")), String(form.get("answer") || "").trim());
      const itemId = Number(form.get("itemId")) || 0;
      if (itemId) await redraftItem(itemId);
      return { ok: true, msg: "Answer saved — refreshed the drafted bullets." };
    }
    if (intent === "kb-accept") {
      const r = acceptSuggestion(Number(form.get("id")));
      return r.ok ? { ok: true, msg: r.msg } : { error: r.msg };
    }
    if (intent === "kb-dismiss") { dismissSuggestion(Number(form.get("id"))); return { ok: true, msg: "Dismissed." }; }
    if (intent === "kb-delete") { deleteKbItem(Number(form.get("id"))); return { ok: true, msg: "Removed from knowledge base." }; }
  } catch (e: any) {
    return { error: e.message || String(e) };
  }
  return { ok: true };
}

export default function Knowledge({ loaderData, actionData }: Route.ComponentProps) {
  const kb = loaderData;
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const revalidator = useRevalidator();

  useEffect(() => {
    if (!kb.scanning) return;
    const t = setInterval(() => revalidator.revalidate(), 3000);
    return () => clearInterval(t);
  }, [kb.scanning]);

  const lastScan = kb.scans[0];

  return (
    <Shell>
      <div className="page-head">
        <h1>Knowledge Base</h1>
        <div className="sub">What the agent knows about your work · drives your résumé &amp; the graph</div>
      </div>
      <hr className="rule double" />

      {actionData?.error && <div className="notice err">{actionData.error}</div>}
      {actionData?.msg && <div className="notice ok">{actionData.msg}</div>}
      {!kb.hasRunner && <div className="notice warn">Connect an AI runner in <Link to="/settings" className="entry-title-link">Settings</Link> to build your knowledge base.</div>}
      {!kb.hasProfile && <div className="notice warn">Upload a base résumé on <Link to="/resume" className="entry-title-link">Résumés</Link> so accepted bullets have somewhere to land.</div>}

      <div className="panel kb">
        <h3>
          Add to your knowledge{" "}
          {kb.scanning
            ? <span className="badge off">scanning…</span>
            : <span className="badge ok">{kb.items.length} item{kb.items.length === 1 ? "" : "s"}</span>}
        </h3>
        <p className="hint" style={{ textTransform: "none", letterSpacing: 0, fontSize: 13 }}>
          Tell the agent what you're building, or point it at a project folder. It reads your work, drafts
          résumé bullets, and asks what it can't infer. Nothing touches a résumé until you accept it.
        </p>

        <div className="row2" style={{ marginTop: 12 }}>
          <Form method="post">
            <input type="hidden" name="intent" value="kb-note" />
            <div className="field">
              <label>What are you building / working on?</label>
              <textarea name="text" placeholder="e.g. Building a Rust CLI that syncs Postgres → SQLite for offline-first apps; designed the WAL replication and shipped it to 3 teams." style={{ minHeight: 90 }} />
            </div>
            <button className="btn" disabled={busy || !kb.hasRunner}>Capture &amp; draft bullets</button>
          </Form>

          <Form method="post">
            <input type="hidden" name="intent" value="kb-scan" />
            <div className="field">
              <label>Scan a project folder (opt-in)</label>
              <FolderScan disabled={busy || !kb.hasRunner || kb.scanning} />
              <p className="hint" style={{ marginTop: 6 }}>The runner reads README/manifests/source in each project. Picked in your browser, filtered locally (no node_modules), sent only to your chosen runner.</p>
            </div>
            <button className="btn" disabled={busy || !kb.hasRunner || kb.scanning}>{kb.scanning ? "Scanning…" : "Scan folder"}</button>
          </Form>
        </div>

        {lastScan && (
          <p className="hint" style={{ marginTop: 4 }}>
            Last scan: <code>{lastScan.path}</code> — {lastScan.status}
            {lastScan.found ? ` · ${lastScan.found} project(s)` : ""}{lastScan.note ? ` · ${lastScan.note}` : ""}
          </p>
        )}
      </div>

      {kb.questions.length > 0 && (
        <div className="panel">
          <h3>Questions for you <span className="badge warn">{kb.questions.length}</span></h3>
          <p className="hint">Answer once — sharpens the drafted bullets and enriches the graph.</p>
          {kb.questions.map((q: any) => (
            <Form method="post" key={q.id} className="qpool">
              <input type="hidden" name="intent" value="kb-answer" />
              <input type="hidden" name="id" value={q.id} />
              <input type="hidden" name="itemId" value={q.item_id || ""} />
              <div className="qpool-q">{q.question} {q.title ? <span className="qpool-job">— {q.title}</span> : null}</div>
              <textarea name="answer" placeholder="Your answer…" />
              <button className="ghost-btn" disabled={busy}>Save answer</button>
            </Form>
          ))}
        </div>
      )}

      {kb.suggestions.length > 0 && (
        <div className="panel">
          <h3>Drafted résumé bullets <span className="badge ok">{kb.suggestions.length}</span></h3>
          <p className="hint">Approve to add to your default résumé profile.</p>
          {kb.suggestions.map((s: any) => (
            <div key={s.id} className="kb-sugg">
              <div className="kb-sugg-text">
                <span className="kb-sugg-sec">{s.section}</span>
                {s.bullet}
                {s.title ? <span className="qpool-job"> — {s.title}</span> : null}
              </div>
              <div className="kb-sugg-actions">
                <Form method="post"><input type="hidden" name="intent" value="kb-accept" /><input type="hidden" name="id" value={s.id} /><button className="ghost-btn" disabled={busy}>✓ Accept</button></Form>
                <Form method="post"><input type="hidden" name="intent" value="kb-dismiss" /><input type="hidden" name="id" value={s.id} /><button className="ghost-btn" disabled={busy}>Dismiss</button></Form>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="panel">
        <h3>What the agent knows {kb.items.length ? <span className="badge ok">{kb.items.length}</span> : <span className="badge off">empty</span>}</h3>
        {kb.items.length === 0 ? (
          <p className="hint">Nothing yet. Capture a note or scan a folder above to begin.</p>
        ) : (
          kb.items.map((it: any) => (
            <div key={it.id} className="version" style={{ marginTop: 8 }}>
              <div className="version-head" style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <strong>{it.title}</strong>
                <span className="badge off">{it.kind}</span>
                <span className="hint" style={{ margin: 0 }}>{it.source}</span>
                <Form method="post" style={{ marginLeft: "auto" }} onSubmit={(e) => { if (!confirm("Remove this from the knowledge base?")) e.preventDefault(); }}>
                  <input type="hidden" name="intent" value="kb-delete" /><input type="hidden" name="id" value={it.id} />
                  <button className="back-link">remove</button>
                </Form>
              </div>
              <p className="hint" style={{ textTransform: "none", letterSpacing: 0, fontSize: 13 }}>{it.summary}</p>
              {it.tags?.length ? <div className="kb-tags">{it.tags.map((t: string, i: number) => <span key={i} className="kb-tag">{t}</span>)}</div> : null}
            </div>
          ))
        )}
      </div>
    </Shell>
  );
}
