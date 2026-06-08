import { Form, Link, redirect, useNavigation } from "react-router";
import { Check } from "lucide-react";
import type { Route } from "./+types/setup";
import { Shell } from "../components/Shell";
import { FilePicker } from "../components/FilePicker";
import { ParseLoader } from "../components/ParseLoader";
import { availableRunners } from "../llm/runner.server";
import { listProfiles, getDefaultProfile, extractPdfText, parseResumeText, saveProfile } from "../resume/profiles.server";
import { getSetting, setSetting, getDb } from "../sqlite.server";
import { startCrawl } from "../services/crawl.server";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Welcome · The Remote & Ledger" }];
}

export async function loader() {
  const runners = await availableRunners();
  const profiles = listProfiles();
  const def = getDefaultProfile();
  const jobCount = (getDb().prepare("SELECT COUNT(*) n FROM jobs").get() as any).n;
  return {
    runners: runners.map((r) => r.label),
    hasRunner: runners.length > 0,
    hasResume: profiles.length > 0,
    resume: def ? { name: def.name, roles: def.data.experience?.length || 0, skills: def.data.skills?.length || 0 } : null,
    jobCount,
    defaultsDone: getSetting("defaults_initialized") === "true",
    location: getSetting("profile_location") || "",
    stack: getSetting("profile_stack") || "",
    profileDone: !!getSetting("profile_location"),
    autofilled: getSetting("target_autofilled") === "true",
  };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "init-defaults") {
    const d: Record<string, string> = {
      default_runner: "", budget_monthly_usd: "0", scheduler_interval_hours: "4",
      scheduler_enabled: "true", scrape_jds: "true", scrape_limit: "12",
      default_resume_style: "letterpress", defaults_initialized: "true",
    };
    for (const [k, v] of Object.entries(d)) setSetting(k, v);
    return { ok: true, msg: "System defaults initialized." };
  }

  if (intent === "upload-resume") {
    try {
      const file = form.get("file") as File | null;
      if (!file || file.size === 0) return { error: "Choose a PDF first." };
      const buf = Buffer.from(await file.arrayBuffer());
      const text = await extractPdfText(buf);
      if (text.length < 40) return { error: "Couldn't read text from that PDF." };
      const { resume } = await parseResumeText(text);
      saveProfile({
        name: String(form.get("name") || "").trim() || file.name.replace(/\.pdf$/i, "") || resume.contact?.name || "Résumé",
        data: resume, raw_text: text, source_file: file.name, makeDefault: true,
      });
      // autofill target from the résumé (only if not set yet)
      let filled = false;
      if (!getSetting("profile_location") && resume.contact?.location) { setSetting("profile_location", resume.contact.location); filled = true; }
      if (!getSetting("profile_stack") && resume.skills?.length) { setSetting("profile_stack", resume.skills.slice(0, 12).join(", ")); filled = true; }
      if (filled) setSetting("target_autofilled", "true");
      return { ok: true, msg: `Parsed "${resume.contact?.name || file.name}" — ${resume.experience?.length || 0} roles, ${resume.skills?.length || 0} skills.${filled ? " Pre-filled your target below." : ""}` };
    } catch (e: any) {
      return { error: e.message || String(e) };
    }
  }

  if (intent === "save-profile") {
    setSetting("profile_location", String(form.get("location") || ""));
    setSetting("profile_stack", String(form.get("stack") || ""));
    return { ok: true, msg: "Target saved." };
  }
  if (intent === "crawl") {
    const id = startCrawl("find", "manual");
    return redirect(`/crawl?run=${id}`);
  }
  if (intent === "complete") {
    setSetting("setup_complete", "true");
    return redirect("/");
  }
  return { ok: true };
}

function Step({ n, done, title, children }: { n: number; done: boolean; title: string; children: React.ReactNode }) {
  return (
    <div className={`wz-step ${done ? "done" : ""}`}>
      <div className="wz-num">{done ? <Check size={15} /> : n}</div>
      <div className="wz-body">
        <h3>{title}{done && <span className="badge ok" style={{ marginLeft: 8 }}>done</span>}</h3>
        <div className="wz-content">{children}</div>
      </div>
    </div>
  );
}

export default function Setup({ loaderData, actionData }: Route.ComponentProps) {
  const d = loaderData;
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const parsing = nav.state !== "idle" && nav.formData?.get("intent") === "upload-resume";
  const ready = d.hasRunner && d.hasResume && d.defaultsDone;

  return (
    <Shell>
      <div className="page-head">
        <div className="eyebrow" style={{ marginBottom: 8 }}>First Edition · Setup</div>
        <h1>Welcome to the Press</h1>
        <div className="sub">Five steps and you're set in type</div>
      </div>
      <hr className="rule double" />
      {actionData?.error && <div className="notice err">{actionData.error}</div>}
      {actionData?.msg && <div className="notice ok">{actionData.msg}</div>}

      <div className="wizard">
        <Step n={1} done={d.defaultsDone} title="Initialize system defaults">
          Sets sensible defaults: auto-pick the best runner, 4-hour crawl with JD scraping on, letterpress résumé style, no budget cap.
          <div style={{ marginTop: 10 }}>
            <Form method="post"><input type="hidden" name="intent" value="init-defaults" /><button className="btn" disabled={busy}>{d.defaultsDone ? "Re-apply defaults" : "Initialize defaults"}</button></Form>
          </div>
        </Step>

        <Step n={2} done={d.hasRunner} title="Connect an AI runner">
          {d.hasRunner ? <>Ready: {d.runners.join(", ")}.</> : <>Install an agent CLI (Claude Code, Codex, Cursor, Gemini) or add an API key in <Link to="/settings" className="entry-title-link">Settings → Keys</Link>. CLI uses your subscription; API keys are metered on <Link to="/usage" className="entry-title-link">Usage</Link>.</>}
        </Step>

        <Step n={3} done={d.hasResume} title="Upload your résumé">
          {d.hasResume ? (
            <>Parsed &amp; saved{d.resume ? <> — <strong>{d.resume.name}</strong> · {d.resume.roles} roles · {d.resume.skills} skills</> : null}. Add more on <Link to="/resume" className="entry-title-link">Résumés</Link>.</>
          ) : parsing ? (
            <ParseLoader />
          ) : (
            <Form method="post" encType="multipart/form-data">
              <input type="hidden" name="intent" value="upload-resume" />
              <div className="row2">
                <div className="field"><label>Profile name</label><input type="text" name="name" placeholder="e.g. Backend / DevOps" /></div>
                <div className="field"><label>PDF file</label><FilePicker name="file" accept="application/pdf" /></div>
              </div>
              <button className="btn" disabled={busy}>Upload &amp; parse</button>
              <span className="hint" style={{ display: "block", marginTop: 8 }}>Parsed right here — no need to leave this page.</span>
            </Form>
          )}
        </Step>

        <Step n={4} done={d.profileDone} title="Tell us your target">
          {d.autofilled && <div className="notice ok" style={{ margin: "0 0 10px" }}>Pre-filled from your résumé — tweak anything below.</div>}
          <Form method="post">
            <input type="hidden" name="intent" value="save-profile" />
            <div className="row2">
              <div className="field"><label>Location</label><input type="text" name="location" defaultValue={d.location} placeholder="e.g. your city, country (or Remote)" /></div>
              <div className="field"><label>Target stack / keywords</label><input type="text" name="stack" defaultValue={d.stack} placeholder="e.g. TypeScript, Node, React, AWS" /></div>
            </div>
            <button className="btn" disabled={busy}>Save target</button>
          </Form>
        </Step>

        <Step n={5} done={d.jobCount > 0} title="Run your first crawl">
          {d.jobCount > 0 ? <>{d.jobCount} jobs on file.</> : <>Optional now — find live roles matching your target (needs a web-capable runner like Claude Code). Opens the Crawl Shell so you can watch it.</>}
          <div style={{ marginTop: 10 }}>
            <Form method="post"><input type="hidden" name="intent" value="crawl" /><button className="ghost-btn" disabled={busy || !d.hasRunner}>{busy ? "Starting…" : "Run first crawl ▸"}</button></Form>
          </div>
        </Step>
      </div>

      <div className="panel" style={{ textAlign: "center" }}>
        {!ready && <p className="hint" style={{ marginBottom: 12 }}>You can finish now and complete the rest anytime — or wrap up steps 1–3 first.</p>}
        <Form method="post"><input type="hidden" name="intent" value="complete" /><button className="btn" disabled={busy}>Enter the Ledger ▸</button></Form>
      </div>
    </Shell>
  );
}
