import { useEffect, useState } from "react";
import { Form, Link, useNavigation, useRevalidator, useFetcher } from "react-router";
import { Check, X, Sparkles, ChevronLeft, ChevronRight } from "lucide-react";
import type { Route } from "./+types/knowledge";
import { Shell } from "../components/Shell";
import { Select } from "../components/Select";
import { DirPicker } from "../components/DirPicker";
import { ConfirmForm } from "../components/ConfirmForm";
import { GraphView } from "../components/graph/GraphView";
import { buildGraph } from "../services/graph.server";
import {
  kbItems,
  kbOpenQuestions,
  kbSuggestions,
  kbSuggestionClusters,
  kbScans,
  activeScan,
  listSources,
  linkableItems,
  addSource,
  rescanSource,
  removeSource,
  setSourceInterval,
  addManualNote,
  answerKbQuestion,
  deleteKbQuestion,
  redraftItem,
  draftKbAnswer,
  acceptSuggestion,
  dismissSuggestion,
  deleteKbItem,
} from "../services/kb.server";
import { loggedTask } from "../services/crawl.server";
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
    suggestionGroups: kbSuggestionClusters(),
    scans: kbScans(),
    scanning: !!activeScan(),
    sources: listSources(),
    linkable: linkableItems(),
    graph: buildGraph(),
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
    if (intent === "kb-add-source") {
      const linkRef = String(form.get("linkRef") || "");
      const r = addSource({
        path: String(form.get("path") || ""),
        label: String(form.get("label") || ""),
        kind: String(form.get("kind") || "project"),
        note: String(form.get("note") || ""),
        intervalHours: Number(form.get("interval") || "0") || 0,
        depth: String(form.get("depth") || "standard"),
        linkRef: linkRef && linkRef !== "0" ? linkRef : undefined,
      });
      if (r.error) return { error: r.error };
      return { ok: true, msg: linkRef && linkRef !== "0" ? "Folder linked to that project — scanning to enrich it." : "Folder added — scanning it in the background. It'll stay and can be re-scanned anytime." };
    }
    if (intent === "kb-rescan") { rescanSource(Number(form.get("id"))); return { ok: true, msg: "Re-scanning folder…" }; }
    if (intent === "kb-remove-source") { removeSource(Number(form.get("id"))); return { ok: true, msg: "Folder removed (its findings stay in the knowledge base)." }; }
    if (intent === "kb-interval") { setSourceInterval(Number(form.get("id")), Number(form.get("interval") || "0") || 0); return { ok: true, msg: "Re-scan interval updated." }; }
    if (intent === "kb-answer") {
      answerKbQuestion(Number(form.get("id")), String(form.get("answer") || "").trim());
      const itemId = Number(form.get("itemId")) || 0;
      if (itemId) await redraftItem(itemId);
      return { ok: true, msg: "Answer saved — refreshed the drafted bullets." };
    }
    if (intent === "kb-del-question") { deleteKbQuestion(Number(form.get("id"))); return { ok: true, msg: "Question removed." }; }
    if (intent === "kb-ai-answer") {
      const id = Number(form.get("id"));
      const r = await loggedTask("answers", "AI answer (KB question)", async (L) => { L("step", "Drafting from the project's code + your résumé…"); return draftKbAnswer(id); });
      return r.error ? { error: r.error } : { ok: true, draft: r.answer };
    }
    if (intent === "kb-accept") {
      const r = acceptSuggestion(Number(form.get("id")));
      // when accepting one from a stack, drop the near-duplicate siblings
      const dropped = String(form.get("dismiss") || "").split(",").map(Number).filter(Boolean);
      for (const oid of dropped) dismissSuggestion(oid);
      return r.ok ? { ok: true, msg: `${r.msg}${dropped.length ? ` (dismissed ${dropped.length} similar)` : ""}` } : { error: r.msg };
    }
    if (intent === "kb-dismiss") {
      String(form.get("id") || "").split(",").map(Number).filter(Boolean).forEach(dismissSuggestion);
      return { ok: true, msg: "Dismissed." };
    }
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
  const [view, setView] = useState<"manage" | "graph">("manage");

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

      <div className="tabs">
        <button className={`tab ${view === "manage" ? "on" : ""}`} onClick={() => setView("manage")}>Manage</button>
        <button className={`tab ${view === "graph" ? "on" : ""}`} onClick={() => setView("graph")}>Graph</button>
      </div>

      {view === "graph" && <GraphView data={kb.graph as any} />}

      <div style={{ display: view === "manage" ? "block" : "none" }}>
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

        <Form method="post">
          <input type="hidden" name="intent" value="kb-note" />
          <div className="field">
            <label>What are you building / working on?</label>
            <textarea name="text" placeholder="e.g. Building a Rust CLI that syncs Postgres → SQLite for offline-first apps; designed the WAL replication and shipped it to 3 teams." style={{ minHeight: 80 }} />
          </div>
          <button className="btn" disabled={busy || !kb.hasRunner}>Capture &amp; draft bullets</button>
        </Form>
      </div>

      {/* opt-in folder scan — read locally on the server, never uploaded */}
      <div className="panel kb">
        <h3>Scan a project folder {kb.scanning ? <span className="badge off">scanning…</span> : null}</h3>
        <p className="hint" style={{ textTransform: "none", letterSpacing: 0, fontSize: 13 }}>
          The runner reads README/manifests/source <strong>on this machine</strong> (skips node_modules, .git, build output) — nothing is uploaded, so it's safe for big folders. Added folders stay and can be re-scanned manually or on a schedule.
        </p>
        <Form method="post">
          <input type="hidden" name="intent" value="kb-add-source" />
          <div className="field">
            <label>Folder</label>
            <DirPicker name="path" placeholder="/Users/you/Projects/my-app  — or click Browse" />
          </div>
          <div className="row2">
            <div className="field">
              <label>This folder is…</label>
              <div className="radiocol">
                <label><input type="radio" name="kind" value="project" defaultChecked /> A single project I'm working on</label>
                <label><input type="radio" name="kind" value="company" /> A company folder with several projects</label>
              </div>
            </div>
            <div className="field">
              <label>Scan depth</label>
              <Select name="depth" defaultValue="standard" options={[
                { value: "quick", label: "Quick — README + manifests" },
                { value: "standard", label: "Standard — + file inventory" },
                { value: "deep", label: "Deep — read source to infer purpose" },
              ]} />
            </div>
          </div>
          <div className="row2">
            <div className="field">
              <label>Auto re-scan</label>
              <Select name="interval" defaultValue="0" options={[
                { value: "0", label: "Manual only" },
                { value: "24", label: "Daily" },
                { value: "168", label: "Weekly" },
                { value: "720", label: "Monthly" },
              ]} />
            </div>
            <div className="field">
              <label>Link to existing project (optional)</label>
              <Select name="linkRef" defaultValue="0" options={[
                { value: "0", label: "— Create a new item —" },
                ...kb.linkable.map((it: any) => ({ value: it.value, label: it.label })),
              ]} />
              <p className="hint" style={{ marginTop: 6 }}>Enrich an item already in your knowledge base (e.g. a project from your résumé) instead of creating a duplicate.</p>
            </div>
          </div>
          <div className="field">
            <label>A few words about this folder (optional)</label>
            <input type="text" name="label" placeholder="Label (e.g. Acme Corp)" style={{ marginBottom: 8 }} />
            <textarea name="note" placeholder="Context for the agent — e.g. 'My work at Acme; I led the billing service and the data pipeline.'" style={{ minHeight: 64 }} />
          </div>
          <button className="btn" disabled={busy || !kb.hasRunner || kb.scanning}>{kb.scanning ? "Scanning…" : "Add & scan folder"}</button>
        </Form>

        {kb.sources.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <h3 style={{ fontSize: 15 }}>Tracked folders <span className="badge ok">{kb.sources.length}</span></h3>
            <div className="kb-sources">
              {kb.sources.map((s: any) => (
                <div key={s.id} className="kb-source">
                  <div className="kb-source-head">
                    {s.label ? <strong>{s.label}</strong> : null}
                    <span className="badge off">{s.kind}</span>
                    <span className="kb-source-when">{s.last_scanned_at ? `scanned ${s.last_scanned_at.slice(5, 16).replace("T", " ")}` : "not scanned yet"}</span>
                  </div>
                  <code className="kb-source-path">{s.path}</code>
                  <div className="kb-source-actions">
                    <Form method="post" className="kb-source-interval">
                      <input type="hidden" name="intent" value="kb-interval" />
                      <input type="hidden" name="id" value={s.id} />
                      <Select name="interval" defaultValue={String(s.interval_hours)} options={[
                        { value: "0", label: "Manual" }, { value: "24", label: "Daily" }, { value: "168", label: "Weekly" }, { value: "720", label: "Monthly" },
                      ]} />
                      <button className="back-link" disabled={busy}>set</button>
                    </Form>
                    <Form method="post"><input type="hidden" name="intent" value="kb-rescan" /><input type="hidden" name="id" value={s.id} /><button className="back-link" disabled={busy || kb.scanning}>rescan</button></Form>
                    <ConfirmForm method="post" title="Stop tracking folder?" confirm="This folder won't be re-scanned, but everything it already found stays in your knowledge base." confirmLabel="Stop tracking"><input type="hidden" name="intent" value="kb-remove-source" /><input type="hidden" name="id" value={s.id} /><button className="back-link" disabled={busy}>remove</button></ConfirmForm>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {lastScan && (
          <p className="hint" style={{ marginTop: 4 }}>
            {kb.scanning ? "Scanning" : "Last scan"}: <code>{lastScan.path}</code> — {lastScan.status}
            {lastScan.found ? ` · ${lastScan.found} project(s)` : ""}
            {" · "}<Link to={`/crawl?run=${lastScan.id}`} className="entry-title-link">{kb.scanning ? "watch live logs ▸" : "view logs ▸"}</Link>
          </p>
        )}
      </div>

      {kb.questions.length > 0 && (
        <div className="panel">
          <h3>Questions for you <span className="badge warn">{kb.questions.length}</span></h3>
          <p className="hint">Answer the useful ones — it sharpens the drafted bullets and enriches the graph. Dismiss any that don't matter.</p>
          {kb.questions.map((q: any) => <KbQuestion key={q.id} q={q} />)}
        </div>
      )}

      {kb.suggestions.length > 0 && (
        <div className="panel">
          <h3>Drafted résumé bullets <span className="badge ok">{kb.suggestions.length}</span></h3>
          <p className="hint">Approve to add to your default résumé profile. Near-duplicate drafts are stacked — cycle and pick the one you like; accepting it drops the rest.</p>
          {kb.suggestionGroups.map((g: any[]) => <SuggestionStack key={g[0].id} group={g} busy={busy} />)}
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
                <ConfirmForm method="post" style={{ marginLeft: "auto" }} title="Remove from knowledge base?" confirm={`"${it.title}" and its drafted bullets/questions will be removed.`} confirmLabel="Remove">
                  <input type="hidden" name="intent" value="kb-delete" /><input type="hidden" name="id" value={it.id} />
                  <button className="back-link">remove</button>
                </ConfirmForm>
              </div>
              <p className="hint" style={{ textTransform: "none", letterSpacing: 0, fontSize: 13 }}>{it.summary}</p>
              {it.tags?.length ? <div className="kb-tags">{it.tags.map((t: string, i: number) => <span key={i} className="kb-tag">{t}</span>)}</div> : null}
            </div>
          ))
        )}
      </div>
      </div>
    </Shell>
  );
}

// One KB clarifying question: answer manually, dismiss, or have the AI draft an answer
// grounded in the project's code + your résumé.
function KbQuestion({ q }: { q: any }) {
  const ai = useFetcher<any>();
  const save = useFetcher<any>();
  const del = useFetcher<any>();
  const [text, setText] = useState("");
  const drafting = ai.state !== "idle";
  const saving = save.state !== "idle";

  useEffect(() => { if (ai.data?.draft) setText(ai.data.draft); }, [ai.data]);

  return (
    <div className="qpool">
      <div className="qpool-q">
        <span>{q.question} {q.title ? <span className="qpool-job">— {q.title}</span> : null}</span>
        <del.Form method="post" className="qpool-del">
          <input type="hidden" name="intent" value="kb-del-question" />
          <input type="hidden" name="id" value={q.id} />
          <button className="back-link" title="Remove this question" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><X size={12} /> dismiss</button>
        </del.Form>
      </div>
      <save.Form method="post">
        <input type="hidden" name="intent" value="kb-answer" />
        <input type="hidden" name="id" value={q.id} />
        <input type="hidden" name="itemId" value={q.item_id || ""} />
        <textarea name="answer" value={text} onChange={(e) => setText(e.target.value)} placeholder={drafting ? "Drafting from the project's code + your résumé…" : "Your answer…"} />
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button className="ghost-btn" disabled={saving || !text.trim()}>{saving ? "Saving…" : "Save answer"}</button>
          <button type="button" className="ghost-btn" disabled={drafting} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
            onClick={() => ai.submit({ intent: "kb-ai-answer", id: q.id }, { method: "post" })}>
            <Sparkles size={13} /> {drafting ? "Drafting…" : "AI draft"}
          </button>
          {ai.data?.error && <span className="hint" style={{ margin: 0, color: "var(--vermillion)" }}>{ai.data.error}</span>}
        </div>
      </save.Form>
    </div>
  );
}

// A stack of near-duplicate drafted bullets: cycle through and accept just one
// (accepting drops the siblings so you don't add two bullets that say the same thing).
function SuggestionStack({ group, busy }: { group: any[]; busy: boolean }) {
  const [i, setI] = useState(0);
  const cur = group[Math.min(i, group.length - 1)];
  const many = group.length > 1;
  const siblings = group.filter((g) => g.id !== cur.id).map((g) => g.id).join(",");
  const allIds = group.map((g) => g.id).join(",");
  return (
    <div className={`sugg-stack ${many ? "stacked" : ""}`}>
      <div className="kb-sugg-text">
        <span className="kb-sugg-sec">{cur.section}</span>
        {cur.bullet}
        {cur.title ? <span className="qpool-job"> — {cur.title}</span> : null}
      </div>
      <div className="sugg-stack-bar">
        {many && (
          <span className="sugg-cycle">
            <button type="button" className="back-link" onClick={() => setI((i - 1 + group.length) % group.length)} aria-label="Previous"><ChevronLeft size={13} /></button>
            <span className="sugg-count">{(i % group.length) + 1} / {group.length} similar</span>
            <button type="button" className="back-link" onClick={() => setI((i + 1) % group.length)} aria-label="Next"><ChevronRight size={13} /></button>
          </span>
        )}
        <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <Form method="post">
            <input type="hidden" name="intent" value="kb-accept" />
            <input type="hidden" name="id" value={cur.id} />
            {many && <input type="hidden" name="dismiss" value={siblings} />}
            <button className="ghost-btn" disabled={busy} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><Check size={13} /> Accept{many ? " this one" : ""}</button>
          </Form>
          <Form method="post">
            <input type="hidden" name="intent" value="kb-dismiss" />
            <input type="hidden" name="id" value={allIds} />
            <button className="ghost-btn" disabled={busy}>Dismiss{many ? " all" : ""}</button>
          </Form>
        </span>
      </div>
    </div>
  );
}
