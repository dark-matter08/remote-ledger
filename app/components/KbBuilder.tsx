import { useState } from "react";
import { Form, Link } from "react-router";
import { Select } from "./Select";

// Pick what goes on the résumé. The Knowledge Base already holds your projects, the
// companies you worked at and the skills your code actually shows — but until now
// the only way any of it reached a résumé was accepting a drafted bullet on
// /knowledge, which silently appended to whichever profile happened to be default.
// This makes the connection explicit and yours to drive.
export interface KbSourceView {
  id: number;
  kind: string;
  title: string;
  summary: string;
  tags: string[];
  role: string | null;
  start_date: string | null;
  end_date: string | null;
  bullets: string[];
}

export function KbBuilder({
  sources,
  skills,
  profiles,
  busy,
  jobTitle,
  suggestedIds,
}: {
  sources: KbSourceView[];
  skills: string[];
  profiles: { id: string; name: string; is_default?: number | boolean }[];
  busy: boolean;
  /** set on a job page: the build is being scoped to one role */
  jobTitle?: string;
  /** pre-ticked because they scored as relevant to that role */
  suggestedIds?: number[];
}) {
  const [open, setOpen] = useState(!!jobTitle);
  const [picked, setPicked] = useState<Set<number>>(new Set(suggestedIds || []));
  const [pickedSkills, setPickedSkills] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<"new" | "merge">("new");
  const [include, setInclude] = useState<"base-plus" | "kb-only">("base-plus");

  const toggle = <T,>(set: Set<T>, v: T, fn: (s: Set<T>) => void) => {
    const next = new Set(set);
    next.has(v) ? next.delete(v) : next.add(v);
    fn(next);
  };

  const experience = sources.filter((s) => s.kind === "experience");
  const projects = sources.filter((s) => s.kind !== "experience");
  const nothing = sources.length === 0 && skills.length === 0;

  if (!profiles.length) {
    return (
      <div className="notice ok" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <span>Upload a résumé first, then you can build on it from your Knowledge Base.</span>
        <Link to="/knowledge" className="entry-title-link">Open Knowledge Base ▸</Link>
      </div>
    );
  }

  const Row = ({ s }: { s: KbSourceView }) => (
    <label
      key={s.id}
      className="kb-pick"
      style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "8px 0", borderTop: "1px solid var(--rule-faint)", cursor: "pointer" }}
    >
      <input
        type="checkbox"
        name="itemId"
        value={s.id}
        checked={picked.has(s.id)}
        onChange={() => toggle(picked, s.id, setPicked)}
        style={{ marginTop: 4 }}
      />
      <span style={{ flex: 1 }}>
        <strong>{s.title}</strong>{" "}
        {s.role ? <span className="hint" style={{ margin: 0 }}>{s.role}</span> : null}
        {s.start_date ? <span className="hint" style={{ margin: 0 }}> · {s.start_date}{s.end_date ? `-${s.end_date}` : ""}</span> : null}
        <span className="hint" style={{ margin: 0, display: "block", textTransform: "none", letterSpacing: 0, fontSize: 13 }}>
          {s.bullets.length} bullet{s.bullets.length === 1 ? "" : "s"}
          {s.tags.length ? ` · ${s.tags.slice(0, 6).join(", ")}` : ""}
        </span>
      </span>
    </label>
  );

  return (
    <div className="panel">
      <h3>
        Build from your Knowledge Base{" "}
        {sources.length ? <span className="badge ok">{sources.length}</span> : <span className="badge off">empty</span>}
      </h3>
      <p className="hint">
        {jobTitle
          ? `Pick the work that best answers ${jobTitle}. Ticked entries scored as relevant to the posting; change anything you disagree with.`
          : "Your projects, roles and skills as captured on /knowledge. Choose what belongs on this résumé — identity, contact and education stay as they are on the base profile."}
      </p>

      {nothing ? (
        <p className="hint">
          Nothing captured yet. <Link to="/knowledge" className="entry-title-link">Scan a folder or describe a project ▸</Link>
        </p>
      ) : !open ? (
        <button type="button" className="ghost-btn" onClick={() => setOpen(true)}>
          Choose what to include
        </button>
      ) : (
        <Form method="post">
          <input type="hidden" name="intent" value="kb-build" />
          <input type="hidden" name="mode" value={mode} />
          <input type="hidden" name="include" value={include} />

          {experience.length > 0 && (
            <>
              <div className="field" style={{ marginBottom: 0 }}><label>Experience</label></div>
              {experience.map((s) => <Row key={s.id} s={s} />)}
            </>
          )}
          {projects.length > 0 && (
            <>
              <div className="field" style={{ marginBottom: 0, marginTop: 14 }}><label>Projects</label></div>
              {projects.map((s) => <Row key={s.id} s={s} />)}
            </>
          )}

          {skills.length > 0 && (
            <div className="field" style={{ marginTop: 16 }}>
              <label>Skills</label>
              <div className="kb-tags">
                {skills.map((k) => (
                  <label key={k} className="kb-tag" style={{ cursor: "pointer", opacity: pickedSkills.has(k) ? 1 : 0.55 }}>
                    <input
                      type="checkbox"
                      name="skill"
                      value={k}
                      checked={pickedSkills.has(k)}
                      onChange={() => toggle(pickedSkills, k, setPickedSkills)}
                      style={{ marginRight: 6 }}
                    />
                    {k}
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className="row2" style={{ marginTop: 16 }}>
            <div className="field">
              <label>Save as</label>
              <Select
                name="_mode"
                value={mode}
                onChange={(v) => setMode(v as "new" | "merge")}
                options={[
                  { value: "new", label: "A new résumé profile" },
                  { value: "merge", label: "Add into an existing profile" },
                ]}
              />
            </div>
            {mode === "merge" ? (
              <div className="field">
                <label>Add into</label>
                <Select
                  name="targetProfileId"
                  defaultValue={profiles.find((p) => p.is_default)?.id || profiles[0]?.id}
                  options={profiles.map((p) => ({ value: p.id, label: p.name }))}
                />
              </div>
            ) : (
              <div className="field">
                <label>Identity and education from</label>
                <Select
                  name="baseProfileId"
                  defaultValue={profiles.find((p) => p.is_default)?.id || profiles[0]?.id}
                  options={profiles.map((p) => ({ value: p.id, label: p.name }))}
                />
              </div>
            )}
          </div>

          {mode === "new" && (
            <div className="row2">
              <div className="field">
                <label>New profile name</label>
                <input type="text" name="name" placeholder={jobTitle ? `For ${jobTitle}` : "e.g. Projects-led"} />
              </div>
              <div className="field">
                <label>Existing content</label>
                <Select
                  name="_include"
                  value={include}
                  onChange={(v) => setInclude(v as "base-plus" | "kb-only")}
                  options={[
                    { value: "base-plus", label: "Keep the base résumé and add these" },
                    { value: "kb-only", label: "Only what I picked (keeps contact + education)" },
                  ]}
                />
              </div>
            </div>
          )}

          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <button className="btn" disabled={busy || (picked.size === 0 && pickedSkills.size === 0)}>
              {busy ? "Building…" : "Build résumé"}
            </button>
            <span className="hint" style={{ margin: 0 }}>
              {picked.size} entr{picked.size === 1 ? "y" : "ies"}, {pickedSkills.size} skill{pickedSkills.size === 1 ? "" : "s"} selected
            </span>
          </div>
        </Form>
      )}
    </div>
  );
}
