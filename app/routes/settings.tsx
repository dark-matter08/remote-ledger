import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { useState } from "react";
import { Form, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/settings";
import { Shell } from "../components/Shell";
import { Select } from "../components/Select";
import { getSetting, setSetting } from "../sqlite.server";
import { listRunners } from "../llm/runner.server";
import { setSecret, deleteSecret, hasSecret } from "../secrets.server";
import { startCrawl } from "../services/crawl.server";

const KEY_FIELDS = [
  { name: "anthropic_api_key", label: "Anthropic" },
  { name: "openai_api_key", label: "OpenAI" },
  { name: "google_api_key", label: "Google Gemini" },
  { name: "openrouter_api_key", label: "OpenRouter" },
  { name: "groq_api_key", label: "Groq" },
  { name: "mistral_api_key", label: "Mistral" },
];
const RESUME_STYLES = ["letterpress", "modern", "compact", "ats-plain"];

function defaultPrompt(): string {
  try {
    return readFileSync(resolve(process.cwd(), "scripts", "prompt.md"), "utf8");
  } catch {
    return "";
  }
}

export async function loader() {
  const runners = await listRunners();
  return {
    runners,
    keys: KEY_FIELDS.map((k) => ({ ...k, set: hasSecret(k.name) })),
    settings: {
      default_runner: getSetting("default_runner") || "",
      fallback_runner: getSetting("fallback_runner") || "",
      models: Object.fromEntries(runners.map((r) => [r.id, getSetting(`model_${r.id}`) || ""])),
      budget: getSetting("budget_monthly_usd") || "0",
      schedulerInterval: getSetting("scheduler_interval_hours") || "4",
      schedulerEnabled: getSetting("scheduler_enabled") !== "false",
      scrapeJds: getSetting("scrape_jds") !== "false",
      scrapeLimit: getSetting("scrape_limit") || "12",
      crawlTimeout: getSetting("crawl_timeout_min") || "15",
      searchPrompt: getSetting("search_prompt") || defaultPrompt(),
      defaultStyle: getSetting("default_resume_style") || "letterpress",
      profileLocation: getSetting("profile_location") || "",
      profileStack: getSetting("profile_stack") || "",
    },
  };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const save = (k: string) => {
    const v = form.get(k);
    if (v !== null) setSetting(k, String(v));
  };

  if (intent === "set-key") {
    const name = String(form.get("name"));
    const value = String(form.get("value") || "").trim();
    if (value) setSecret(name, value);
    return { ok: true, msg: `Saved ${name}.` };
  }
  if (intent === "clear-key") {
    deleteSecret(String(form.get("name")));
    return { ok: true, msg: "Key cleared." };
  }
  if (intent === "crawl-now") {
    const id = startCrawl("find", "manual");
    return redirect(`/crawl?run=${id}`); // watch it live in the Crawl Shell
  }
  if (intent === "save-runner") {
    save("default_runner");
    save("fallback_runner");
    save("budget_monthly_usd");
    save("default_resume_style");
    for (const [k, v] of form.entries()) if (k.startsWith("model_")) setSetting(k, String(v));
    return { ok: true, msg: "Runner settings saved." };
  }
  if (intent === "save-scheduler") {
    save("scheduler_interval_hours");
    save("scrape_limit");
    save("crawl_timeout_min");
    setSetting("scheduler_enabled", form.get("scheduler_enabled") ? "true" : "false");
    setSetting("scrape_jds", form.get("scrape_jds") ? "true" : "false");
    return { ok: true, msg: "Scheduler settings saved." };
  }
  if (intent === "save-profile") {
    save("profile_location");
    save("profile_stack");
    return { ok: true, msg: "Profile saved." };
  }
  if (intent === "save-prompt") {
    save("search_prompt");
    return { ok: true, msg: "Prompt saved." };
  }
  return { ok: true };
}

const TABS = ["Runners", "Keys", "Scheduler", "Profile", "Prompt"] as const;
type Tab = (typeof TABS)[number];

export default function Settings({ loaderData, actionData }: Route.ComponentProps) {
  const { runners, keys, settings } = loaderData;
  const nav = useNavigation();
  const saving = nav.state !== "idle";
  const [tab, setTab] = useState<Tab>("Runners");
  const apiRunners = runners.filter((r) => r.kind === "api");
  const cliRunners = runners.filter((r) => r.kind === "cli");

  return (
    <Shell>
      <div className="page-head">
        <h1>Settings</h1>
        <div className="sub">Runners · Keys · Scheduler · Profile · Prompt</div>
      </div>
      <hr className="rule double" />
      {actionData?.msg && <div className="notice ok">{actionData.msg}</div>}

      <div className="tabs">
        {TABS.map((t) => (
          <button key={t} className={`tab ${tab === t ? "on" : ""}`} onClick={() => setTab(t)}>{t}</button>
        ))}
      </div>

      {tab === "Runners" && (
        <>
          <div className="panel">
            <h3>Detected runners</h3>
            <p className="hint">Agent CLI (your subscription) or direct API (your key). Green = ready.</p>
            <table className="ledger-table">
              <thead><tr><th>Runner</th><th>Type</th><th>Status</th><th>Default model</th></tr></thead>
              <tbody>
                {runners.map((r) => (
                  <tr key={r.id}>
                    <td>{r.label}</td><td>{r.kind.toUpperCase()}</td>
                    <td>{r.available ? <span className="badge ok">Ready</span> : <span className="badge off">{r.needsKey ? "Needs key" : "Not installed"}</span>}</td>
                    <td>{settings.models[r.id] || r.defaultModel || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Form method="post" className="panel">
            <input type="hidden" name="intent" value="save-runner" />
            <h3>Runner &amp; defaults</h3>
            <div className="row2">
              <div className="field"><label>Default runner</label>
                <Select name="default_runner" defaultValue={settings.default_runner} options={[{ value: "", label: "Auto (prefer Claude Code)" }, ...runners.map((r) => ({ value: r.id, label: `${r.label}${r.available ? "" : " (unavailable)"}`, disabled: !r.available }))]} />
              </div>
              <div className="field"><label>Fallback runner (on error)</label>
                <Select name="fallback_runner" defaultValue={settings.fallback_runner} options={[{ value: "", label: "None" }, ...runners.map((r) => ({ value: r.id, label: r.label, disabled: !r.available }))]} />
              </div>
            </div>
            <p className="hint" style={{ marginTop: 14 }}>Model override per API runner (blank = default)</p>
            <div className="row2">
              {apiRunners.map((r) => (
                <div className="field" key={r.id}><label>{r.label}</label><input type="text" name={`model_${r.id}`} defaultValue={settings.models[r.id]} placeholder={r.defaultModel} /></div>
              ))}
            </div>
            <div className="row2" style={{ marginTop: 8 }}>
              <div className="field"><label>Monthly budget cap (USD, 0 = none)</label><input type="number" step="0.01" name="budget_monthly_usd" defaultValue={settings.budget} /></div>
              <div className="field"><label>Default resume style</label><Select name="default_resume_style" defaultValue={settings.defaultStyle} options={RESUME_STYLES.map((s) => ({ value: s, label: s }))} /></div>
            </div>
            <button className="btn" disabled={saving}>Save</button>
          </Form>
        </>
      )}

      {tab === "Keys" && (
        <div className="panel">
          <h3>Bring your own keys</h3>
          <p className="hint">Encrypted on this machine (AES-256-GCM). Never committed; only sent to the provider you choose. Env vars (e.g. ANTHROPIC_API_KEY) override.</p>
          {keys.map((k) => (
            <Form method="post" key={k.name} className="field" style={{ display: "grid", gridTemplateColumns: "150px 1fr auto auto", gap: 10, alignItems: "end" }}>
              <label style={{ margin: 0 }}>{k.label} {k.set ? <span className="badge ok">set</span> : <span className="badge off">unset</span>}</label>
              <input type="password" name="value" placeholder={k.set ? "•••••••• (saved)" : "paste key"} autoComplete="off" />
              <input type="hidden" name="name" value={k.name} />
              <button className="ghost-btn" name="intent" value="set-key">Save</button>
              <button className="ghost-btn" name="intent" value="clear-key">Clear</button>
            </Form>
          ))}
          <p className="hint" style={{ marginTop: 12 }}>CLI runners ({cliRunners.map((r) => r.label).join(", ")}) need no key.</p>
        </div>
      )}

      {tab === "Scheduler" && (
        <Form method="post" className="panel">
          <input type="hidden" name="intent" value="save-scheduler" />
          <h3>Scheduler &amp; scraping</h3>
          <p className="hint">The built-in scheduler crawls for fresh jobs while the app runs, and scrapes each posting's full JD.</p>
          <div className="row2">
            <div className="field"><label>Crawl every (hours)</label><input type="number" min="1" name="scheduler_interval_hours" defaultValue={settings.schedulerInterval} /></div>
            <div className="field" style={{ display: "flex", alignItems: "flex-end" }}><label style={{ margin: 0 }}><input type="checkbox" name="scheduler_enabled" defaultChecked={settings.schedulerEnabled} /> Scheduler enabled</label></div>
          </div>
          <div className="row2">
            <div className="field" style={{ display: "flex", alignItems: "flex-end" }}><label style={{ margin: 0 }}><input type="checkbox" name="scrape_jds" defaultChecked={settings.scrapeJds} /> Scrape full JDs on crawl</label></div>
            <div className="field"><label>Max postings to scrape per crawl</label><input type="number" min="0" name="scrape_limit" defaultValue={settings.scrapeLimit} /></div>
          </div>
          <div className="row2">
            <div className="field"><label>Find-crawl timeout (minutes)</label><input type="number" min="2" max="60" name="crawl_timeout_min" defaultValue={settings.crawlTimeout} /></div>
            <div className="field" style={{ display: "flex", alignItems: "flex-end" }}><span className="hint" style={{ margin: 0 }}>How long the research agent may run before it's stopped. The prompt tells it to return results well within this.</span></div>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button className="btn" disabled={saving}>Save</button>
            <button className="ghost-btn" name="intent" value="crawl-now" formNoValidate>{saving ? "Crawling…" : "Run crawl now"}</button>
          </div>
        </Form>
      )}

      {tab === "Profile" && (
        <Form method="post" className="panel">
          <input type="hidden" name="intent" value="save-profile" />
          <h3>Your profile</h3>
          <p className="hint">Personalizes the job-search prompt and resume matching.</p>
          <div className="row2">
            <div className="field"><label>Location</label><input type="text" name="profile_location" defaultValue={settings.profileLocation} placeholder="e.g. your city, country" /></div>
            <div className="field"><label>Target stack / keywords</label><input type="text" name="profile_stack" defaultValue={settings.profileStack} placeholder="e.g. TypeScript, Node, React, AWS" /></div>
          </div>
          <button className="btn" disabled={saving}>Save</button>
        </Form>
      )}

      {tab === "Prompt" && (
        <Form method="post" className="panel">
          <input type="hidden" name="intent" value="save-prompt" />
          <h3>Job-search prompt</h3>
          <p className="hint">What the scheduler asks the AI to find each crawl. Uses {"{{location}}"} and {"{{stack}}"}.</p>
          <div className="field"><textarea name="search_prompt" defaultValue={settings.searchPrompt} style={{ minHeight: 300, fontFamily: "var(--mono)", fontSize: 12 }} /></div>
          <button className="btn" disabled={saving}>Save</button>
        </Form>
      )}
    </Shell>
  );
}
