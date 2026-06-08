import { Form, Link, useNavigation } from "react-router";
import type { Route } from "./+types/resume";
import { Shell } from "../components/Shell";
import { FilePicker } from "../components/FilePicker";
import { ConfirmForm } from "../components/ConfirmForm";
import {
  listProfiles,
  saveProfile,
  setDefaultProfile,
  deleteProfile,
  getProfile,
  extractPdfText,
  parseResumeText,
} from "../resume/profiles.server";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Resume · The Remote Ledger" }];
}

export async function loader() {
  return { profiles: listProfiles() };
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
  } catch (e: any) {
    return { error: e.message || String(e) };
  }
  return { ok: true };
}

export default function ResumePage({ loaderData, actionData }: Route.ComponentProps) {
  const { profiles } = loaderData;
  const nav = useNavigation();
  const busy = nav.state !== "idle";

  return (
    <Shell>
      <div className="page-head">
        <h1>Base Résumés</h1>
        <div className="sub">Upload once · tailor per job · multiple profiles</div>
      </div>
      <hr className="rule double" />

      {actionData?.error && <div className="notice err">{actionData.error}</div>}
      {actionData?.msg && <div className="notice ok">{actionData.msg}</div>}

      <div className="notice ok" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <span>Keep building your résumé from what you've worked on.</span>
        <Link to="/knowledge" className="entry-title-link">Open Knowledge Base ▸</Link>
      </div>

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
              <ConfirmForm method="post" title="Delete profile?" confirm={`"${p.name}" and its tailored versions will be deleted. This can't be undone.`} confirmLabel="Delete">
                <input type="hidden" name="intent" value="delete" /><input type="hidden" name="id" value={p.id} />
                <button className="ghost-btn">Delete</button>
              </ConfirmForm>
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
