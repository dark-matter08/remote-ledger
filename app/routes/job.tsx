import { useState } from "react";
import { Form, Link, useNavigation } from "react-router";
import type { Route } from "./+types/job";
import { Shell } from "../components/Shell";
import { Select } from "../components/Select";
import {
  getJob,
  ensureApplication,
  getEvents,
  setStage,
  setNextAction,
  addEvent,
  setJd,
  getMeta,
  setMeta,
  jobApplyActivity,
} from "../db.server";
import { STAGES, STAGE_LABEL, type Stage } from "../stages";
import { listProfiles, getProfile, getDefaultProfile } from "../resume/profiles.server";
import { tailorResume, coverLetter, interviewPrep, analyzeMatch, applicationAnswers, type JobCtx } from "../resume/ai.server";
import { detectFormFields, questionFields, assistApply } from "../services/apply.server";
import { createVersion, listVersions, setVersionPdf } from "../resume/versions.server";
import { scrapeAndSave } from "../services/scrape.server";
import { renderResumePdf } from "../resume/pdf.server";
import { RESUME_STYLES, type ResumeStyle } from "../resume/templates.server";

export function meta({ data }: Route.MetaArgs) {
  return [{ title: data?.job ? `${data.job.company} · The Remote Ledger` : "Job" }];
}

export async function loader({ params }: Route.LoaderArgs) {
  const job = getJob(params.id);
  if (!job) throw new Response("Not found", { status: 404 });
  ensureApplication(job.id);
  return {
    job: getJob(job.id)!,
    events: getEvents(job.id),
    versions: listVersions(job.id),
    profiles: listProfiles(),
    defaultProfileId: getDefaultProfile()?.id ?? null,
    storedMatch: getMeta(`match:${job.id}`) ? JSON.parse(getMeta(`match:${job.id}`)!) : null,
    storedPrep: getMeta(`prep:${job.id}`),
    storedAnswers: getMeta(`answers:${job.id}`) ? JSON.parse(getMeta(`answers:${job.id}`)!) : null,
    applyActivity: jobApplyActivity(job.id),
    styles: RESUME_STYLES,
    stages: STAGES,
    stageLabels: STAGE_LABEL,
    defaultStyle: getMeta("default_resume_style") || "letterpress",
  };
}

function ctx(job: any): JobCtx {
  return { id: job.id, company: job.company, role: job.role, stack: job.stack, eligibility: job.eligibility, jd: job.jd };
}

export async function action({ request, params }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = form.get("intent");
  const job = getJob(params.id);
  if (!job) throw new Response("Not found", { status: 404 });
  try {
    if (intent === "save-jd") {
      setJd(job.id, String(form.get("jd") || ""));
      return { ok: true, msg: "Job description saved." };
    }
    if (intent === "scrape-jd") {
      const r = await scrapeAndSave(job.id);
      return r.saved
        ? { ok: true, msg: `Fetched ${r.text.length} chars from the posting.` }
        : { error: `Couldn't read the posting: ${r.error || "no text found"}. Paste it manually.` };
    }
    if (intent === "stage") {
      setStage(job.id, String(form.get("stage")) as Stage, {
        subStage: (form.get("sub_stage") as string) || null,
        note: (form.get("note") as string) || undefined,
      });
      return { ok: true, msg: "Stage updated." };
    }
    if (intent === "next-action") {
      setNextAction(job.id, String(form.get("action") || ""), (form.get("at") as string) || null);
      return { ok: true, msg: "Reminder set." };
    }
    if (intent === "note") {
      const t = String(form.get("text") || "").trim();
      if (t) addEvent(job.id, "note", { text: t });
      return { ok: true, msg: "Note added." };
    }
    const base = (form.get("profileId") ? getProfile(String(form.get("profileId"))) : getDefaultProfile())?.data;
    if (intent === "tailor") {
      if (!base) return { error: "Upload a base résumé first (Résumés page)." };
      const style = (String(form.get("style") || "letterpress") as ResumeStyle);
      const t = await tailorResume(base, ctx(job));
      const vid = createVersion({
        jobId: job.id,
        profileId: String(form.get("profileId") || ""),
        kind: "resume",
        style,
        data: t.resume,
        flags: t.flags,
        match: t.match,
        llmCallId: t.callId ?? null,
      });
      const pdf = await renderResumePdf(t.resume, style, `${job.id}-v${vid}`);
      setVersionPdf(vid, pdf.path);
      setMeta(`match:${job.id}`, JSON.stringify(t.match));
      addEvent(job.id, "resume_generated", { versionId: vid, style, score: t.match.score });
      return { ok: true, msg: `Tailored résumé ready (match ${t.match.score}).` };
    }
    if (intent === "cover") {
      if (!base) return { error: "Upload a base résumé first." };
      const c = await coverLetter(base, ctx(job));
      createVersion({ jobId: job.id, kind: "cover-letter", content_md: c.text, llmCallId: c.callId ?? null });
      addEvent(job.id, "cover_generated", {});
      return { ok: true, msg: "Cover letter generated." };
    }
    if (intent === "match") {
      if (!base) return { error: "Upload a base résumé first." };
      const m = await analyzeMatch(base, ctx(job));
      setMeta(`match:${job.id}`, JSON.stringify(m.match));
      return { ok: true, msg: `Match analyzed (${m.match.score}).` };
    }
    if (intent === "interview") {
      if (!base) return { error: "Upload a base résumé first." };
      const p = await interviewPrep(base, ctx(job));
      setMeta(`prep:${job.id}`, p.text);
      addEvent(job.id, "interview_prep", {});
      return { ok: true, msg: "Interview prep generated." };
    }
    if (intent === "draft-answers") {
      if (!base) return { error: "Upload a base résumé first." };
      const fields = await detectFormFields(job.apply_url);
      const qs = questionFields(fields);
      const a = await applicationAnswers(base, ctx(job), qs);
      setMeta(`answers:${job.id}`, JSON.stringify({ fieldCount: fields.length, detected: qs.length, answers: a.answers }));
      addEvent(job.id, "answers_drafted", { questions: a.answers.length, formFields: fields.length });
      return { ok: true, msg: `Drafted ${a.answers.length} answer(s)${fields.length ? ` from ${fields.length} detected form fields` : " (form not readable — used generic questions)"}.` };
    }
    if (intent === "assist-apply") {
      const r = await assistApply(job.id);
      return r.ok ? { ok: true, msg: r.message } : { error: r.message };
    }
  } catch (e: any) {
    return { error: e.message || String(e) };
  }
  return { ok: true };
}

const TABS = ["Overview", "Tailor", "Cover", "Apply", "Prep", "Application", "History"] as const;
type Tab = (typeof TABS)[number];

export default function JobDetail({ loaderData, actionData }: Route.ComponentProps) {
  const { job, events, versions, profiles, defaultProfileId, storedMatch, storedPrep, storedAnswers, applyActivity, styles, stages, stageLabels, defaultStyle } = loaderData;
  const [tab, setTab] = useState<Tab>("Overview");
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const resumeVersions = versions.filter((v) => v.kind === "resume");
  const coverVersions = versions.filter((v) => v.kind === "cover-letter");
  const catCls = job.category === "high" ? "sh-high" : job.category === "medium" ? "sh-medium" : "sh-stretch";

  return (
    <Shell>
      <Link to="/" className="back-link">← Back to the ledger</Link>
      <div className="job-head">
        <div className={`job-cat ${catCls}`}>{job.category} · fit {job.fit_score}/100 · {stageLabels[job.stage]}</div>
        <h1 className="job-title">{job.company}</h1>
        <div className="job-role">{job.role}</div>
        <div className="job-fine">{job.stack}{job.eligibility ? ` · ${job.eligibility}` : ""}{job.closes_at ? ` · closes ${job.closes_at}` : ""}</div>
        <div style={{ marginTop: 14, display: "flex", gap: 10, flexWrap: "wrap" }}>
          <a className="stamp" href={job.apply_url} target="_blank" rel="noreferrer">Apply ▸</a>
          <Form method="post" style={{ display: "inline" }}>
            <input type="hidden" name="intent" value="stage" />
            <input type="hidden" name="stage" value="applied" />
            <button className="ghost-btn" disabled={job.stage !== "saved"}>Mark applied</button>
          </Form>
        </div>
      </div>
      <hr className="rule double" />

      {actionData?.error && <div className="notice err">{actionData.error}</div>}
      {actionData?.msg && <div className="notice ok">{actionData.msg}</div>}
      {busy && <div className="notice warn">Working… AI calls can take a moment.</div>}

      <div className="tabs">
        {TABS.map((t) => (
          <button key={t} className={`tab ${tab === t ? "on" : ""}`} onClick={() => setTab(t)}>{t}</button>
        ))}
      </div>

      {tab === "Overview" && (
        <>
          <div className="panel">
            <h3>Job description {job.jd ? <span className="badge ok">{job.jd.length} chars</span> : <span className="badge off">empty</span>}</h3>
            <p className="hint">Auto-collected from the posting, or paste it. Powers tailoring, match &amp; prep.</p>
            <Form method="post" style={{ display: "inline-block", marginBottom: 12 }}>
              <input type="hidden" name="intent" value="scrape-jd" />
              <button className="ghost-btn" disabled={busy}>{busy ? "Fetching…" : "⟳ Fetch from posting"}</button>
            </Form>
            <Form method="post">
              <input type="hidden" name="intent" value="save-jd" />
              <div className="field"><textarea name="jd" defaultValue={job.jd || ""} placeholder="Paste or fetch the full job description…" style={{ minHeight: 200 }} /></div>
              <button className="btn" disabled={busy}>Save description</button>
            </Form>
          </div>
          <MatchPanel match={storedMatch} busy={busy} profiles={profiles} defaultProfileId={defaultProfileId} />
        </>
      )}

      {tab === "Tailor" && (
        <div className="panel">
          <h3>Tailor a résumé</h3>
          <p className="hint">Reorders & rewords your base résumé for this role. Never invents facts — a guard flags anything new.</p>
          <Form method="post">
            <input type="hidden" name="intent" value="tailor" />
            <div className="row2">
              <div className="field">
                <label>Base profile</label>
                <Select
                  name="profileId"
                  defaultValue={defaultProfileId || ""}
                  options={profiles.length === 0 ? [{ value: "", label: "(none — upload on Résumés)" }] : profiles.map((p) => ({ value: p.id, label: p.name }))}
                />
              </div>
              <div className="field">
                <label>Style</label>
                <Select name="style" defaultValue={defaultStyle} options={styles.map((s) => ({ value: s, label: s }))} />
              </div>
            </div>
            <button className="btn" disabled={busy || profiles.length === 0}>{busy ? "Tailoring…" : "Tailor & build PDF"}</button>
          </Form>

          {resumeVersions.length === 0 ? (
            <p className="hint" style={{ marginTop: 16 }}>No tailored résumés yet.</p>
          ) : (
            resumeVersions.map((v) => (
              <div key={v.id} className="version">
                <div className="version-head">
                  <strong>v{v.id}</strong> · {v.style} · {v.created_at.slice(0, 16).replace("T", " ")}
                  {v.match ? <span className="badge ok" style={{ marginLeft: 8 }}>match {v.match.score}</span> : null}
                  <a className="ghost-btn" style={{ marginLeft: "auto" }} href={`/version/${v.id}/resume.pdf`} target="_blank" rel="noreferrer">Download PDF ▸</a>
                </div>
                {v.flags?.map((f, i) => (
                  <div key={i} className={`notice ${f.severity === "warn" ? "warn" : "ok"}`} style={{ margin: "8px 0" }}>{f.message}</div>
                ))}
                {v.match && (
                  <div className="hint" style={{ marginTop: 6 }}>
                    Matched: {v.match.matched.slice(0, 6).join(", ") || "—"}<br />
                    Missing: {v.match.missing.slice(0, 6).join(", ") || "—"}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {tab === "Cover" && (
        <div className="panel">
          <h3>Cover letter</h3>
          <Form method="post"><input type="hidden" name="intent" value="cover" /><button className="btn" disabled={busy}>{busy ? "Writing…" : "Generate cover letter"}</button></Form>
          {coverVersions.map((v) => (
            <div key={v.id} className="version">
              <div className="version-head"><strong>v{v.id}</strong> · {v.created_at.slice(0, 16).replace("T", " ")}</div>
              <pre className="letter">{v.content_md}</pre>
            </div>
          ))}
        </div>
      )}

      {tab === "Apply" && (
        <div className="panel">
          <h3>Auto-apply assist</h3>
          <p className="hint" style={{ textTransform: "none", letterSpacing: 0, fontSize: 13 }}>
            Reads the application form, drafts an answer for every question in your voice, and can open the
            posting in a real browser and prefill it. <strong>It never submits</strong> — you review and click submit.
          </p>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", margin: "12px 0" }}>
            <Form method="post"><input type="hidden" name="intent" value="draft-answers" /><button className="btn" disabled={busy}>{busy ? "Working…" : "Detect form & draft answers"}</button></Form>
            <Form method="post"><input type="hidden" name="intent" value="assist-apply" /><button className="ghost-btn" disabled={busy || !storedAnswers}>Open &amp; prefill in browser ▸</button></Form>
          </div>

          {applyActivity.sessions.length > 0 && (
            <div className="version" style={{ borderTop: "1.5px solid var(--rule)", marginTop: 8 }}>
              <h3 style={{ fontSize: 16, marginTop: 10 }}>In auto-apply sessions</h3>
              {applyActivity.sessions.map((s: any) => (
                <div key={s.session_id} className="version-head" style={{ marginTop: 6 }}>
                  <Link to={`/apply?session=${s.session_id}`} className="entry-title-link">Session #{s.session_id}</Link>
                  <span className={`badge ${s.status === "drafted" ? "ok" : s.status === "needs_input" ? "warn" : "off"}`}>{s.status}</span>
                  <span>· {s.questions} q · {s.unanswered} unanswered</span>
                </div>
              ))}
              {applyActivity.pooled.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <p className="hint">Questions the agent pooled for this job:</p>
                  {applyActivity.pooled.map((q: any) => (
                    <div key={q.id} className="hint" style={{ textTransform: "none", letterSpacing: 0, fontSize: 13, margin: "4px 0" }}>
                      {q.answer ? "✓" : "○"} {q.question}{q.answer ? <> — <em>{q.answer}</em></> : <> — <Link to="/apply" className="entry-title-link">answer in the Apply room</Link></>}
                    </div>
                  ))}
                </div>
              )}
              {applyActivity.answers.length > 0 && (
                <details style={{ marginTop: 10 }}>
                  <summary style={{ cursor: "pointer", fontFamily: "var(--mono)", fontSize: 11, textTransform: "uppercase", letterSpacing: ".1em", color: "var(--ink-faint)" }}>
                    Drafted answers from sessions ({applyActivity.answers.length})
                  </summary>
                  {applyActivity.answers.map((a: any, i: number) => (
                    <pre key={i} className="letter" style={{ marginTop: 8 }}>{a.text}</pre>
                  ))}
                </details>
              )}
            </div>
          )}

          {storedAnswers ? (
            <>
              <p className="hint">{storedAnswers.detected ? `${storedAnswers.detected} question(s) detected on the form · ${storedAnswers.fieldCount} fields` : "form not readable — generic questions used"}</p>
              {storedAnswers.answers.map((qa: any, i: number) => (
                <div key={i} className="version">
                  <div className="version-head">Q{i + 1} · {qa.question}</div>
                  <pre className="letter">{qa.answer}</pre>
                </div>
              ))}
            </>
          ) : (
            <p className="hint" style={{ marginTop: 10 }}>No drafted answers yet.</p>
          )}
        </div>
      )}

      {tab === "Prep" && (
        <div className="panel">
          <h3>Interview prep</h3>
          <Form method="post"><input type="hidden" name="intent" value="interview" /><button className="btn" disabled={busy}>{busy ? "Preparing…" : "Generate prep"}</button></Form>
          {storedPrep ? <pre className="letter">{storedPrep}</pre> : <p className="hint" style={{ marginTop: 12 }}>No prep yet.</p>}
        </div>
      )}

      {tab === "Application" && (
        <div className="panel">
          <h3>Application stage</h3>
          <Form method="post">
            <input type="hidden" name="intent" value="stage" />
            <div className="row2">
              <div className="field">
                <label>Stage</label>
                <Select name="stage" defaultValue={job.stage} options={stages.map((s) => ({ value: s, label: stageLabels[s] }))} />
              </div>
              <div className="field">
                <label>Sub-stage (interview round)</label>
                <Select
                  name="sub_stage"
                  defaultValue={job.sub_stage || ""}
                  options={[{ value: "", label: "—" }, ...["phone", "technical", "system-design", "final"].map((s) => ({ value: s, label: s }))]}
                />
              </div>
            </div>
            <div className="field"><label>Note (optional)</label><input type="text" name="note" placeholder="e.g. recruiter call booked" /></div>
            <button className="btn" disabled={busy}>Update stage</button>
          </Form>
          <h3 style={{ marginTop: 20 }}>Reminder / next action</h3>
          <Form method="post">
            <input type="hidden" name="intent" value="next-action" />
            <div className="row2">
              <div className="field"><label>Action</label><input type="text" name="action" placeholder="Follow up with recruiter" /></div>
              <div className="field"><label>Due date</label><input type="text" name="at" placeholder="YYYY-MM-DD" /></div>
            </div>
            <button className="btn" disabled={busy}>Set reminder</button>
          </Form>
        </div>
      )}

      {tab === "History" && (
        <div className="panel">
          <h3>History</h3>
          {events.length === 0 ? <p className="hint">Nothing yet.</p> : (
            <ul className="timeline">
              {events.map((e) => (
                <li key={e.id}>
                  <span className="t-when">{e.ts.slice(0, 16).replace("T", " ")}</span>
                  <span className="t-type">{e.type.replace(/_/g, " ")}</span>
                  <span className="t-pay">{e.payload ? Object.entries(e.payload).map(([k, v]) => `${k}: ${v}`).join(" · ") : ""}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Shell>
  );
}

function MatchPanel({ match, busy, profiles, defaultProfileId }: any) {
  return (
    <div className="panel">
      <h3>Match &amp; gap</h3>
      <Form method="post" style={{ marginBottom: 12 }}>
        <input type="hidden" name="intent" value="match" />
        <input type="hidden" name="profileId" value={defaultProfileId || ""} />
        <button className="ghost-btn" disabled={busy || profiles.length === 0}>Analyze match</button>
      </Form>
      {match ? (
        <>
          <div className="stat-grid">
            <div className="stat"><div className="k">Fit</div><div className="v">{match.score}<small>/100</small></div></div>
            <div className="stat"><div className="k">Matched</div><div className="v">{match.matched.length}</div></div>
            <div className="stat"><div className="k">Missing</div><div className="v">{match.missing.length}</div></div>
          </div>
          <p className="hint">✓ {match.matched.join(", ") || "—"}</p>
          <p className="hint">✗ {match.missing.join(", ") || "—"}</p>
          <p className="hint">ATS keywords: {match.atsKeywords?.join(", ") || "—"}</p>
        </>
      ) : (
        <p className="hint">Run an analysis to see how your résumé matches this role.</p>
      )}
    </div>
  );
}
