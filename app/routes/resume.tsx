import { useEffect } from "react";
import { Form, useNavigation, useRevalidator } from "react-router";
import type { Route } from "./+types/resume";
import { Shell } from "../components/Shell";
import { FilePicker } from "../components/FilePicker";
import {
  listProfiles,
  saveProfile,
  setDefaultProfile,
  deleteProfile,
  getProfile,
  getDefaultProfile,
  extractPdfText,
  parseResumeText,
} from "../resume/profiles.server";
import {
  kbItems,
  kbOpenQuestions,
  kbSuggestions,
  kbScans,
  activeScan,
  addManualNote,
  startScan,
  answerKbQuestion,
  redraftItem,
  acceptSuggestion,
  dismissSuggestion,
  deleteKbItem,
} from "../services/kb.server";
import { availableRunners } from "../llm/runner.server";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Resume · The Remote Ledger" }];
}

export async function loader() {
  const runners = await availableRunners();
  return {
    profiles: listProfiles(),
    hasRunner: runners.length > 0,
    hasProfile: !!getDefaultProfile(),
    kb: { items: kbItems(), questions: kbOpenQuestions(), suggestions: kbSuggestions("pending"), scans: kbScans(), scanning: !!activeScan() },
  };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = form.get("intent");
  try {
    if (intent === "upload") {
      const file = form.get("file") as File | null;
      const name = String(form.get("name") || "").trim();
      if (!file || file.size === 0) return { error: "Choose a PDF file." };
      const buf = Buffer.from(await file.arrayBuffer());
      const text = await extractPdfText(buf);
      if (text.length < 40) return { error: "Could not read text from that PDF." };
      const { resume } = await parseResumeText(text);
      const id = saveProfile({
        name: name || file.name.replace(/\.pdf$/i, "") || resume.contact?.name || "Resume",
        data: resume,
        raw_text: text,
        source_file: file.name,
        makeDefault: true,
      });
      return { ok: true, msg: `Parsed and saved "${name || file.name}".`, id };
    }
    if (intent === "paste") {
      const text = String(form.get("text") || "").trim();
      const name = String(form.get("name") || "Pasted resume").trim();
      if (text.length < 40) return { error: "Paste more resume text." };
      const { resume } = await parseResumeText(text);
      saveProfile({ name, data: resume, raw_text: text, makeDefault: true });
      return { ok: true, msg: `Parsed and saved "${name}".` };
    }
    if (intent === "default") {
      setDefaultProfile(String(form.get("id")));
      return { ok: true, msg: "Default profile updated." };
    }
    if (intent === "delete") {
      deleteProfile(String(form.get("id")));
      return { ok: true, msg: "Profile deleted." };
    }
    if (intent === "save-json") {
      const id = String(form.get("id"));
      const p = getProfile(id);
      if (!p) return { error: "Profile not found." };
      const data = JSON.parse(String(form.get("json")));
      saveProfile({ id, name: String(form.get("name") || p.name), data });
      return { ok: true, msg: "Profile saved." };
    }
    // ---- knowledge base ----
    if (intent === "kb-note") {
      const text = String(form.get("text") || "").trim();
      if (text.length < 12) return { error: "Tell me a bit more about what you're working on." };
      await addManualNote(text);
      return { ok: true, msg: "Captured. Drafted bullets and a few questions for you below." };
    }
    if (intent === "kb-scan") {
      const path = String(form.get("path") || "").trim();
      const r = startScan(path);
      if (r.error) return { error: r.error };
      return { ok: true, msg: "Scanning… reading projects in the background." };
    }
    if (intent === "kb-answer") {
      const id = Number(form.get("id"));
      const itemId = Number(form.get("itemId")) || 0;
      answerKbQuestion(id, String(form.get("answer") || "").trim());
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

export default function ResumePage({ loaderData, actionData }: Route.ComponentProps) {
  const { profiles, kb, hasRunner } = loaderData;
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const revalidator = useRevalidator();

  // live-refresh while a folder scan runs in the background
  useEffect(() => {
    if (!kb.scanning) return;
    const t = setInterval(() => revalidator.revalidate(), 3000);
    return () => clearInterval(t);
  }, [kb.scanning]);

  return (
    <Shell>
      <div className="page-head">
        <h1>Base Résumés</h1>
        <div className="sub">Upload once · tailor per job · keep building from your work</div>
      </div>
      <hr className="rule double" />

      {actionData?.error && <div className="notice err">{actionData.error}</div>}
      {actionData?.msg && <div className="notice ok">{actionData.msg}</div>}
      {!hasRunner && <div className="notice warn">Connect an AI runner in Settings to build your knowledge base.</div>}

      <KnowledgeBase kb={kb} busy={busy} hasRunner={hasRunner} />

      <div className="panel">
        <h3>Upload a résumé (PDF)</h3>
        <p className="hint">Parsed into structured sections by your default AI runner. Becomes the default profile.</p>
        <Form method="post" encType="multipart/form-data">
          <input type="hidden" name="intent" value="upload" />
          <div className="row2">
            <div className="field"><label>Profile name</label><input type="text" name="name" placeholder="e.g. Backend / DevOps" /></div>
            <div className="field"><label>PDF file</label><FilePicker name="file" accept="application/pdf" /></div>
          </div>
          <button className="btn" disabled={busy}>{busy ? "Parsing…" : "Upload & parse"}</button>
        </Form>
      </div>

      <details className="panel">
        <summary style={{ cursor: "pointer", fontFamily: "var(--mono)", fontSize: 12, letterSpacing: ".1em", textTransform: "uppercase" }}>
          …or paste résumé text
        </summary>
        <Form method="post" style={{ marginTop: 12 }}>
          <input type="hidden" name="intent" value="paste" />
          <div className="field"><label>Profile name</label><input type="text" name="name" placeholder="Pasted resume" /></div>
          <div className="field"><label>Résumé text</label><textarea name="text" /></div>
          <button className="btn" disabled={busy}>{busy ? "Parsing…" : "Parse text"}</button>
        </Form>
      </details>

      {profiles.length === 0 ? (
        <p className="colophon" style={{ marginTop: 30 }}>No profiles yet. Upload your résumé to begin.</p>
      ) : (
        profiles.map((p) => (
          <div className="panel" key={p.id}>
            <h3>
              {p.name} {p.is_default ? <span className="badge on">default</span> : null}
            </h3>
            <p className="hint">
              {p.data.contact?.name || "—"} · {p.data.experience?.length || 0} roles · {p.data.projects?.length || 0} projects · {p.data.skills?.length || 0} skills
            </p>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", margin: "10px 0" }}>
              {!p.is_default && (
                <Form method="post"><input type="hidden" name="intent" value="default" /><input type="hidden" name="id" value={p.id} /><button className="ghost-btn">Make default</button></Form>
              )}
              <Form method="post" onSubmit={(e) => { if (!confirm("Delete this profile?")) e.preventDefault(); }}>
                <input type="hidden" name="intent" value="delete" /><input type="hidden" name="id" value={p.id} />
                <button className="ghost-btn">Delete</button>
              </Form>
            </div>
            <details>
              <summary style={{ cursor: "pointer", fontFamily: "var(--mono)", fontSize: 11, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--ink-faint)" }}>
                Edit structured JSON
              </summary>
              <Form method="post" style={{ marginTop: 10 }}>
                <input type="hidden" name="intent" value="save-json" />
                <input type="hidden" name="id" value={p.id} />
                <div className="field"><label>Name</label><input type="text" name="name" defaultValue={p.name} /></div>
                <div className="field"><textarea name="json" defaultValue={JSON.stringify(p.data, null, 2)} style={{ fontFamily: "var(--mono)", fontSize: 11, minHeight: 240 }} /></div>
                <button className="btn" disabled={busy}>Save JSON</button>
              </Form>
            </details>
          </div>
        ))
      )}
    </Shell>
  );
}

function KnowledgeBase({ kb, busy, hasRunner }: { kb: any; busy: boolean; hasRunner: boolean }) {
  const lastScan = kb.scans[0];
  return (
    <div className="panel kb">
      <h3>
        Knowledge base{" "}
        {kb.scanning
          ? <span className="badge off">scanning…</span>
          : <span className="badge ok">{kb.items.length} item{kb.items.length === 1 ? "" : "s"}</span>}
      </h3>
      <p className="hint" style={{ textTransform: "none", letterSpacing: 0, fontSize: 13 }}>
        Tell the agent what you're building, or point it at a project folder. It reads your work, drafts
        résumé bullets, and asks what it can't infer. Nothing touches a résumé until you accept it.
      </p>

      <div className="row2" style={{ marginTop: 12 }}>
        {/* capture what you're working on */}
        <Form method="post">
          <input type="hidden" name="intent" value="kb-note" />
          <div className="field">
            <label>What are you building / working on?</label>
            <textarea name="text" placeholder="e.g. Building a Rust CLI that syncs Postgres → SQLite for offline-first apps; designed the WAL replication and shipped it to 3 teams." style={{ minHeight: 90 }} />
          </div>
          <button className="btn" disabled={busy || !hasRunner}>Capture &amp; draft bullets</button>
        </Form>

        {/* opt-in folder scan */}
        <Form method="post">
          <input type="hidden" name="intent" value="kb-scan" />
          <div className="field">
            <label>Scan a project folder (opt-in)</label>
            <input type="text" name="path" placeholder="/Users/you/Projects/my-app  or  ~/code" />
            <p className="hint" style={{ marginTop: 6 }}>The local runner reads README/manifests/source in each project. Contents stay on your machine — sent only to your chosen runner.</p>
          </div>
          <button className="btn" disabled={busy || !hasRunner || kb.scanning}>{kb.scanning ? "Scanning…" : "Scan folder"}</button>
        </Form>
      </div>

      {lastScan && (
        <p className="hint" style={{ marginTop: 4 }}>
          Last scan: <code>{lastScan.path}</code> — {lastScan.status}
          {lastScan.found ? ` · ${lastScan.found} project(s)` : ""}{lastScan.note ? ` · ${lastScan.note}` : ""}
        </p>
      )}

      {/* questions the agent needs answered */}
      {kb.questions.length > 0 && (
        <div className="version" style={{ borderTop: "1.5px solid var(--rule)", marginTop: 14, paddingTop: 12 }}>
          <h3 style={{ fontSize: 15 }}>Questions for you <span className="badge warn">{kb.questions.length}</span></h3>
          {kb.questions.map((q: any) => (
            <Form method="post" key={q.id} className="qpool">
              <input type="hidden" name="intent" value="kb-answer" />
              <input type="hidden" name="id" value={q.id} />
              <input type="hidden" name="itemId" value={q.item_id || ""} />
              <div className="qpool-q">{q.question} {q.title ? <span className="qpool-job">— {q.title}</span> : null}</div>
              <textarea name="answer" placeholder="Your answer (sharpens the drafted bullets)…" />
              <button className="ghost-btn" disabled={busy}>Save answer</button>
            </Form>
          ))}
        </div>
      )}

      {/* drafted résumé bullets awaiting approval */}
      {kb.suggestions.length > 0 && (
        <div className="version" style={{ borderTop: "1.5px solid var(--rule)", marginTop: 14, paddingTop: 12 }}>
          <h3 style={{ fontSize: 15 }}>Drafted résumé bullets <span className="badge ok">{kb.suggestions.length}</span></h3>
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

      {/* what the agent knows */}
      {kb.items.length > 0 && (
        <details style={{ marginTop: 14 }}>
          <summary style={{ cursor: "pointer", fontFamily: "var(--mono)", fontSize: 11, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--ink-faint)" }}>
            What the agent knows ({kb.items.length})
          </summary>
          {kb.items.map((it: any) => (
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
          ))}
        </details>
      )}
    </div>
  );
}
