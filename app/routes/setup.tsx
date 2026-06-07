import { Form, Link, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/setup";
import { Shell } from "../components/Shell";
import { availableRunners } from "../llm/runner.server";
import { listProfiles } from "../resume/profiles.server";
import { getSetting, setSetting, getDb } from "../sqlite.server";
import { runCrawl } from "../services/crawl.server";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Welcome · The Remote & Ledger" }];
}

export async function loader() {
  const runners = await availableRunners();
  const profiles = listProfiles();
  const jobCount = (getDb().prepare("SELECT COUNT(*) n FROM jobs").get() as any).n;
  return {
    runners: runners.map((r) => r.label),
    hasRunner: runners.length > 0,
    hasResume: profiles.length > 0,
    jobCount,
    defaultsDone: getSetting("defaults_initialized") === "true",
    location: getSetting("profile_location") || "",
    stack: getSetting("profile_stack") || "",
    profileDone: !!getSetting("profile_location"),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = form.get("intent");
  if (intent === "init-defaults") {
    const d: Record<string, string> = {
      default_runner: "",
      budget_monthly_usd: "0",
      scheduler_interval_hours: "4",
      scheduler_enabled: "true",
      scrape_jds: "true",
      scrape_limit: "12",
      default_resume_style: "letterpress",
      defaults_initialized: "true",
    };
    for (const [k, v] of Object.entries(d)) setSetting(k, v);
    return { ok: true, msg: "System defaults initialized." };
  }
  if (intent === "save-profile") {
    setSetting("profile_location", String(form.get("location") || ""));
    setSetting("profile_stack", String(form.get("stack") || ""));
    return { ok: true, msg: "Profile saved." };
  }
  if (intent === "crawl") {
    const r = await runCrawl();
    return { ok: r.ok, msg: r.ok ? `First crawl: ${r.inserted} jobs, ${r.scraped ?? 0} JDs scraped.` : `Crawl failed: ${r.message}` };
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
      <div className="wz-num">{done ? "✓" : n}</div>
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
  const ready = d.hasRunner && d.hasResume && d.defaultsDone;

  return (
    <Shell>
      <div className="page-head">
        <div className="eyebrow" style={{ marginBottom: 8 }}>First Edition · Setup</div>
        <h1>Welcome to the Press</h1>
        <div className="sub">Five steps and you're set in type</div>
      </div>
      <hr className="rule double" />
      {actionData?.msg && <div className="notice ok">{actionData.msg}</div>}

      <div className="wizard">
        <Step n={1} done={d.defaultsDone} title="Initialize system defaults">
          Sets sensible defaults: auto-pick the best runner, 4-hour crawl with JD scraping on, letterpress resume style, no budget cap.
          <div style={{ marginTop: 10 }}>
            <Form method="post"><input type="hidden" name="intent" value="init-defaults" /><button className="btn" disabled={busy}>{d.defaultsDone ? "Re-apply defaults" : "Initialize defaults"}</button></Form>
          </div>
        </Step>

        <Step n={2} done={d.hasRunner} title="Connect an AI runner">
          {d.hasRunner ? <>Ready: {d.runners.join(", ")}.</> : <>Install an agent CLI (Claude Code, Codex, Cursor, Gemini) or add an API key in <Link to="/settings" className="entry-title-link">Settings → Keys</Link>. CLI uses your subscription; API keys are metered on <Link to="/usage" className="entry-title-link">Usage</Link>.</>}
        </Step>

        <Step n={3} done={d.hasResume} title="Upload your résumé">
          {d.hasResume ? <>Base profile saved.</> : <>Upload a PDF on <Link to="/resume" className="entry-title-link">Résumés</Link> — it's parsed into structured sections for tailoring.</>}
        </Step>

        <Step n={4} done={d.profileDone} title="Tell us your target">
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
          {d.jobCount > 0 ? <>{d.jobCount} jobs on file.</> : <>Optional now — find live roles matching your target (needs a web-capable runner like Claude Code).</>}
          <div style={{ marginTop: 10 }}>
            <Form method="post"><input type="hidden" name="intent" value="crawl" /><button className="ghost-btn" disabled={busy || !d.hasRunner}>{busy ? "Crawling…" : "Run first crawl"}</button></Form>
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
