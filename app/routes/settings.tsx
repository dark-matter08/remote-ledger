import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { useState } from "react";
import { Form, redirect, useNavigation, useSearchParams } from "react-router";
import type { Route } from "./+types/settings";
import { Shell } from "../components/Shell";
import { Select } from "../components/Select";
import { FilePicker } from "../components/FilePicker";
import { DirPicker } from "../components/DirPicker";
import { ConfirmForm } from "../components/ConfirmForm";
import { pendingBoardSuggestions, submitBoardSuggestions, upstreamRepo } from "../services/contribute.server";
import { OpenRouterPicker } from "../components/OpenRouterPicker";
import { OllamaSetup } from "../components/OllamaSetup";
import { SearchSetup } from "../components/SearchSetup";
import { DangerZone } from "../components/DangerZone";
import { getSetting, setSetting } from "../sqlite.server";
import { listRunners } from "../llm/runner.server";
import { discoverModels, openRouterShortlist } from "../llm/models.server";
import { setSecret, deleteSecret, hasSecret } from "../secrets.server";
import { startCrawl } from "../services/crawl.server";
import { resetPreview, performReset, ALL_SCOPES, type ResetScope } from "../services/reset.server";
import { kbBuildSources } from "../resume/build.server";
import { listBackups, takeBackup, backupDir, backupKeep, backupEveryHours, writeScheduledExport } from "../services/backup.server";
import { listProfiles, createProfile, updateProfile, deleteProfile, profileKbIds, setProfileKb, copyProfileKb } from "../profiles.server";
import { readExport, importData, OMITTED } from "../services/portability.server";
import { currentVersion } from "../services/updates.server";
import {
  listCompanies,
  addCompany,
  removeCompany,
  setCompanyActive,
  bootstrapCompaniesFromJobs,
} from "../services/ats.server";
// the component renders these, so they must come from the client-safe module
import { boardUrl, ATS_KINDS } from "../ats";
import { JOB_FIELDS, DEFAULT_FIELD, fieldById } from "../fields";

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
  const modelOptions: Record<string, { value: string; label: string }[]> = {};
  await Promise.all(
    runners.map(async (r) => {
      // OpenRouter fronts 400+ models — the dropdown gets the free + cheapest ones
      // with their prices spelled out; the OpenRouter tab browses the rest.
      const opts =
        r.provider === "openrouter"
          ? await openRouterShortlist()
          : (await discoverModels(r.id, r.provider, r.kind)).map((m) => ({
              value: m,
              label: m === "default" ? "Default" : m,
            }));
      // The Select below falls back to the runner's own default, so that model has to
      // be one of the options or the control renders empty — which is what Ollama does
      // when it is not running and discovery comes back with nothing but "default".
      if (r.defaultModel && !opts.some((o) => o.value === r.defaultModel))
        opts.push({ value: r.defaultModel, label: r.defaultModel });
      modelOptions[r.id] = opts;
    })
  );
  return {
    version: currentVersion(),
    profiles: listProfiles().map((p) => ({ ...p, kb: profileKbIds(p.id) })),
    kbItems: kbBuildSources().map((k) => ({ id: k.id, kind: k.kind, title: k.title, tags: k.tags })),
    backup: {
      everyHours: backupEveryHours(),
      keep: backupKeep(),
      dir: backupDir(),
      exportDir: getSetting("backup_export_dir") || "",
    },
    // through the loader, not imported in the component: a *.server module referenced
    // from client code drags the whole thing into the browser bundle, and the build
    // stops rather than shipping it.
    omitted: Object.values(OMITTED),
    reset: { scopes: resetPreview(), backups: listBackups() },
    companies: listCompanies(),
    community: {
      on: getSetting("community_share") === "true",
      lastSubmit: getSetting("community_last_submit"),
      upstream: upstreamRepo()?.slug || null,
      pending: pendingBoardSuggestions(),
    },
    runners,
    modelOptions,
    keys: KEY_FIELDS.map((k) => ({ ...k, set: hasSecret(k.name) })),
    settings: {
      default_runner: getSetting("default_runner") || "",
      fallback_runner: getSetting("fallback_runner") || "",
      models: Object.fromEntries(runners.map((r) => [r.id, getSetting(`model_${r.id}`) || ""])),
      budget: getSetting("budget_monthly_usd") || "0",
      openrouterModel: getSetting("model_openrouter-api") || "",
      ollamaModel: getSetting("model_ollama-api") || "",
      openrouterFreeOnly: getSetting("openrouter_free_only") === "true",
      openrouterFreeFallback: getSetting("openrouter_free_fallback") !== "false",
      openrouterFallbacks: getSetting("openrouter_fallbacks") || "",
      openrouterWebSearch: getSetting("openrouter_web_search") || "off",
      openrouterWebMaxResults: getSetting("openrouter_web_max_results") || "5",
      schedulerInterval: getSetting("scheduler_interval_hours") || "4",
      schedulerEnabled: getSetting("scheduler_enabled") !== "false",
      scrapeJds: getSetting("scrape_jds") !== "false",
      scrapeLimit: getSetting("scrape_limit") || "12",
      staleTrashDays: getSetting("stale_trash_days") ?? "14",
      applyBrowser: getSetting("apply_browser") || "playwright",
      applyCdpUrl: getSetting("apply_cdp_url") || "http://127.0.0.1:9222",
      crawlMode: getSetting("crawl_mode") || "time",
      crawlTimeout: getSetting("crawl_timeout_min") || "15",
      crawlTarget: getSetting("crawl_target_count") || "5",
      searchPrompt: getSetting("search_prompt") || defaultPrompt(),
      defaultStyle: getSetting("default_resume_style") || "letterpress",
      profileLocation: getSetting("profile_location") || "",
      profileField: getSetting("profile_field") || "",
      profileStack: getSetting("profile_stack") || "",
    },
  };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  if (intent === "backup-settings") {
    for (const k of ["backup_every_hours", "backup_keep", "backup_dir", "backup_export_dir"]) {
      setSetting(k, String(form.get(k) || "").trim());
    }
    return { ok: true, msg: "Backup schedule saved." };
  }
  if (intent === "backup-now") {
    const b = takeBackup("manual");
    const exported = writeScheduledExport();
    return {
      ok: !!b,
      msg: b
        ? `Backed up (${Math.round(b.bytes / 1024)} KB)${exported ? `, and wrote a portable export to ${exported}` : ""}.`
        : "The backup failed — check the folder is writable.",
    };
  }
  if (intent === "import-data") {
    // Deliberately the only write path that takes a file. Everything about it is
    // "refuse rather than guess": the version check, the column filter, and merge
    // as the default so a mistaken import adds nothing it cannot also skip.
    const upload = form.get("file");
    if (!(upload instanceof File) || !upload.size) return { ok: false, msg: "Choose an export file first." };
    if (upload.size > 200 * 1024 * 1024) return { ok: false, msg: "That file is over 200 MB — it is not one of ours." };
    try {
      const buf = Buffer.from(await upload.arrayBuffer());
      const file = readExport(buf);
      const r = importData(file, form.get("mode") === "replace" ? "replace" : "merge");
      return { ok: true, msg: r.message };
    } catch (e: any) {
      return { ok: false, msg: e?.message || "That file could not be read." };
    }
  }

  if (intent === "profile-kb") {
    const id = String(form.get("id"));
    setProfileKb(id, form.getAll("item").map((v) => Number(v)));
    const n = profileKbIds(id).length;
    return { ok: true, msg: n ? `${n} entr${n === 1 ? "y" : "ies"} selected for this profile.` : "Using the whole knowledge base." };
  }
  if (intent === "profile-kb-copy") {
    const from = String(form.get("from"));
    const to = String(form.get("id"));
    // Nothing selected upstream means "everything", so copying it would look like it
    // did nothing. Say that instead of silently writing an empty set.
    if (!profileKbIds(from).length) {
      return { ok: false, msg: "That profile has no selection of its own — it already uses the whole knowledge base." };
    }
    const n = copyProfileKb(from, to);
    return { ok: true, msg: `Copied ${n} entr${n === 1 ? "y" : "ies"} across.` };
  }
  if (intent === "profile-create") {
    const name = String(form.get("name") || "").trim();
    if (!name) return { ok: false, msg: "Give the profile a name." };
    const p = createProfile({
      name,
      field: String(form.get("field") || DEFAULT_FIELD),
      location: String(form.get("location") || ""),
      stack: String(form.get("stack") || ""),
    });
    return { ok: true, msg: `Added ${p.name}. It starts with the shipped boards — edit them under Companies.` };
  }
  if (intent === "profile-save") {
    const p = updateProfile(String(form.get("id")), {
      name: String(form.get("name") || "").trim() || "Untitled",
      field: String(form.get("field") || DEFAULT_FIELD),
      location: String(form.get("location") || ""),
      stack: String(form.get("stack") || ""),
    });
    return { ok: true, msg: p ? `Saved ${p.name}.` : "That profile is gone." };
  }
  if (intent === "profile-active") {
    const p = updateProfile(String(form.get("id")), { active: form.get("active") ? 1 : 0 });
    return { ok: true, msg: p?.active ? `${p.name} is searched again.` : `${p?.name} is kept, but no longer searched.` };
  }
  if (intent === "profile-delete") {
    // Never silently: the postings are the expensive part, and "where did my board
    // go" is a worse surprise than an extra question on the way out.
    const id = String(form.get("id"));
    const moveTo = String(form.get("move_to") || "");
    const r = deleteProfile(id, moveTo ? { moveTo } : { deleteJobs: true });
    return {
      ok: true,
      msg: moveTo ? `Deleted. ${r.jobs} posting(s) moved.` : `Deleted, with ${r.jobs} posting(s).`,
    };
  }
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
  if (intent === "openrouter-use") {
    const model = String(form.get("model") || "").trim();
    if (model) setSetting("model_openrouter-api", model);
    return { ok: true, msg: `OpenRouter will use ${model}.` };
  }
  if (intent === "openrouter-save") {
    save("openrouter_fallbacks");
    setSetting("openrouter_web_search", String(form.get("openrouter_web_search") || "off"));
    // the field is only rendered for the engine that takes one, so keep the old value
    if (form.get("openrouter_web_max_results")) save("openrouter_web_max_results");
    setSetting("openrouter_free_only", form.get("openrouter_free_only") ? "true" : "false");
    setSetting("openrouter_free_fallback", form.get("openrouter_free_fallback") ? "true" : "false");
    return { ok: true, msg: "OpenRouter settings saved." };
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
    save("stale_trash_days");
    save("apply_browser");
    save("apply_cdp_url");
    save("crawl_mode");
    save("crawl_timeout_min");
    save("crawl_target_count");
    setSetting("scheduler_enabled", form.get("scheduler_enabled") ? "true" : "false");
    setSetting("scrape_jds", form.get("scrape_jds") ? "true" : "false");
    return { ok: true, msg: "Scheduler settings saved." };
  }
  if (intent === "save-prompt") {
    save("search_prompt");
    return { ok: true, msg: "Prompt saved." };
  }
  if (intent === "company-add") {
    const r = addCompany({
      name: String(form.get("name") || ""),
      ats: String(form.get("ats") || "") || null,
      slug: String(form.get("slug") || "") || null,
      careersUrl: String(form.get("careers_url") || "") || null,
      kind: String(form.get("kind") || "company"),
    });
    return r.error ? { ok: false, msg: r.error } : { ok: true, msg: "Company added." };
  }
  if (intent === "company-remove") { removeCompany(Number(form.get("id"))); return { ok: true, msg: "Company removed." }; }
  if (intent === "company-toggle") {
    setCompanyActive(Number(form.get("id")), String(form.get("active")) === "1");
    return { ok: true, msg: "Updated." };
  }
  if (intent === "community-toggle") {
    setSetting("community_share", form.get("community_share") ? "true" : "false");
    return { ok: true, msg: form.get("community_share") ? "Daily sharing on. Boards only, and only ones you keep." : "Daily sharing off." };
  }
  if (intent === "community-submit") {
    const urls = form.getAll("board").map(String);
    if (!urls.length) return { ok: false, msg: "Pick at least one board to offer." };
    const r = await submitBoardSuggestions(urls);
    return { ok: r.ok, msg: r.prUrl ? `${r.message} — ${r.prUrl}` : r.message };
  }
  if (intent === "company-bootstrap") {
    const r = bootstrapCompaniesFromJobs();
    return { ok: true, msg: `Scanned ${r.scanned} job(s), found ${r.boards} company board(s), added ${r.added} new.` };
  }
  if (intent === "careers-now") { startCrawl("careers", "manual"); return redirect("/crawl"); }
  if (intent === "reset") {
    const scopes = form.getAll("scope").map(String).filter((s): s is ResetScope => (ALL_SCOPES as string[]).includes(s));
    const r = await performReset(scopes);
    // Clearing the settings takes setup_complete with it, so the wizard is where this
    // person now belongs — landing them back on a Settings page describing an install
    // that no longer exists would be the wrong end of their own decision.
    if (r.ok && r.toSetup) return redirect("/setup?step=1&cleared=1");
    return { ok: r.ok, msg: r.message };
  }
  return { ok: true };
}

const TABS = ["Runners", "Keys", "OpenRouter", "Local", "Search", "Scheduler", "Companies", "Profiles", "Prompt", "Data", "Danger"] as const;
type Tab = (typeof TABS)[number];

export default function Settings({ loaderData, actionData }: Route.ComponentProps) {
  const { runners, modelOptions, keys, settings, companies, community, reset, version, profiles, omitted, backup, kbItems } = loaderData;
  const nav = useNavigation();
  const saving = nav.state !== "idle";
  // The tab lives in the URL, so a link can open one directly — the sidebar's
  // "Add another" points straight at ?tab=Profiles — and so reloading or sharing the
  // page keeps you where you were rather than snapping back to Runners.
  const [params, setParams] = useSearchParams();
  const asked = params.get("tab");
  const tab: Tab = (TABS as readonly string[]).includes(asked || "") ? (asked as Tab) : "Runners";
  const setTab = (t: Tab) => {
    const next = new URLSearchParams(params);
    if (t === "Runners") next.delete("tab");
    else next.set("tab", t);
    // replace, not push: flicking through tabs should not fill the back button
    setParams(next, { replace: true, preventScrollReset: true });
  };
  const [crawlMode, setCrawlMode] = useState(settings.crawlMode);
  const cliRunners = runners.filter((r) => r.kind === "cli");
  const availRunners = runners.filter((r) => r.available);

  return (
    <Shell>
      <div className="page-head">
        <h1>Settings</h1>
        <div className="sub">Runners · Keys · OpenRouter · Local · Search · Scheduler · Companies · Profiles · Prompt · Data · Danger</div>
        {/*
          In the head rather than inside a tab: the reason to look it up is usually
          that you are telling someone else what you are running, and hunting through
          nine tabs for it is not that.
        */}
        <div className="version" title="The release this copy is on, from git">{version}</div>
      </div>
      <hr className="rule double" />
      {actionData?.msg && <div className="notice ok">{actionData.msg}</div>}

      <div className="tabs">
        {TABS.map((t) => (
          <button key={t} className={`tab ${tab === t ? "on" : ""} ${t === "Danger" ? "danger" : ""}`} onClick={() => setTab(t)}>{t}</button>
        ))}
      </div>

      {tab === "Data" && (
        <>
          <div className="panel">
            <h3>Move to another machine</h3>
            <p className="hint">
              One file with your profiles, postings, applications, résumés, knowledge base and
              answers. Download it here, install the Ledger on the new machine, and read it back in below.
            </p>
            <p className="hint">
              <strong>Your keys are not in it.</strong> API keys and email passwords stay on this
              machine — they are not written to the file even though you asked for one. Re-enter them
              under Keys on the other side.
            </p>
            <div className="row2">
              <div className="field">
                <label>Everything</label>
                <a className="btn" href="/api/export">Download everything</a>
              </div>
              {profiles.length > 1 && (
                <div className="field">
                  <label>Or one profile</label>
                  <Select
                    name="export_profile"
                    defaultValue=""
                    onChange={(e: any) => {
                      const v = e.target.value;
                      if (v) window.location.href = `/api/export?profile=${encodeURIComponent(v)}`;
                    }}
                    options={[{ value: "", label: "Pick a profile to export…" }, ...profiles.map((p: any) => ({ value: p.id, label: p.name }))]}
                  />
                </div>
              )}
            </div>
            <p className="hint" style={{ marginTop: 18, marginBottom: 0 }}>Left out: {omitted.join(" · ")}</p>
          </div>
      
          <Form method="post" className="panel">
            <input type="hidden" name="intent" value="backup-settings" />
            <h3>Scheduled backups</h3>
            <p className="hint">
              A snapshot of the database is taken on a schedule and the oldest are pruned. Copies are
              made with VACUUM INTO rather than copying the file — this database runs in WAL mode, so
              the bytes on disk are not the whole story and a plain copy would miss the newest work.
            </p>
            <div className="row2">
              <div className="field">
                <label>How often</label>
                <Select
                  name="backup_every_hours"
                  defaultValue={String(backup.everyHours)}
                  options={[
                    { value: "1", label: "Every hour" },
                    { value: "6", label: "Every 6 hours" },
                    { value: "12", label: "Every 12 hours" },
                    { value: "24", label: "Daily" },
                    { value: "168", label: "Weekly" },
                  ]}
                />
              </div>
              <div className="field">
                <label>How many to keep</label>
                <Select
                  name="backup_keep"
                  defaultValue={String(backup.keep)}
                  options={[
                    { value: "5", label: "5 — about a day at 6-hourly" },
                    { value: "10", label: "10 — the default" },
                    { value: "30", label: "30" },
                    { value: "100", label: "100 — keep almost everything" },
                  ]}
                />
              </div>
            </div>
            <div className="field">
              <label>Where the snapshots go</label>
              <DirPicker name="backup_dir" placeholder={backup.dir} />
            </div>
            <div className="field">
              <label>Also write a portable export here (optional)</label>
              <DirPicker name="backup_export_dir" placeholder="e.g. your Dropbox or iCloud folder" />
            </div>
            <p className="hint">
              The snapshots above are for this machine. A portable export is the file you can carry to
              another laptop — put it somewhere that syncs and a new machine is one import away. It
              carries no keys either, the same as the download above.
            </p>
            <div className="row2">
              <button className="btn" disabled={saving}>Save schedule</button>
            </div>
            <p className="hint mono tiny" style={{ marginTop: 14, marginBottom: 0 }}>
              {reset.backups.length} snapshot(s) in {backup.dir}
              {backup.exportDir ? ` · portable exports to ${backup.exportDir}` : ""}
            </p>
          </Form>
          
          <Form method="post" className="panel">
            <input type="hidden" name="intent" value="backup-now" />
            <h3>Back up now</h3>
            <p className="hint">
              Takes one immediately, and writes the portable export too if you set a folder for it.
            </p>
            <button className="btn ghost" disabled={saving}>Back up now</button>
          </Form>
          
          <Form method="post" encType="multipart/form-data" className="panel">
            <input type="hidden" name="intent" value="import-data" />
            <h3>Read an export back in</h3>
            <p className="hint">
              Merge adds what is not already here and leaves the rest alone, so running the same file
              twice does nothing the second time. Replace empties these tables first — it takes a
              backup before it does, but it is the one thing here you cannot undo by importing again.
            </p>
            <div className="row2">
              <div className="field">
                <label>Export file</label>
                <FilePicker name="file" accept=".gz,.json" label="Choose export…" />
              </div>
              <div className="field">
                <label>How to read it</label>
                <Select
                  name="mode"
                  defaultValue="merge"
                  options={[
                    { value: "merge", label: "Merge — add what is missing" },
                    { value: "replace", label: "Replace — wipe first (backs up)" },
                  ]}
                />
              </div>
            </div>
            <button className="btn" disabled={saving}>Import</button>
          </Form>
        </>
      )}
      
      {tab === "Profiles" && (
        <>
          <div className="panel">
            <h3>Your searches</h3>
            <p className="hint">
              One per line of work. A crawl searches for every active profile in the same run and
              divides the budget between them, so looking for two things costs about what looking for
              one costs — each is searched a little less deeply. Pause one and it is kept, just not searched.
            </p>
            {profiles.map((p: any) => (
              <div key={p.id} className="profile-block">
                <div className="profile-row">
                  <Form method="post" className="profile-edit">
                    <input type="hidden" name="intent" value="profile-save" />
                    <input type="hidden" name="id" value={p.id} />
                    <div className="row2">
                      <div className="field"><label>Name</label><input type="text" name="name" defaultValue={p.name} /></div>
                      <div className="field"><label>Field</label>
                        <Select name="field" defaultValue={p.field} options={JOB_FIELDS.map((f) => ({ value: f.id, label: f.label }))} />
                      </div>
                    </div>
                    <div className="row2">
                      <div className="field"><label>Where</label><input type="text" name="location" defaultValue={p.location} placeholder="Remote" /></div>
                      <div className="field"><label>What you do</label><input type="text" name="stack" defaultValue={p.stack} placeholder="what you do" /></div>
                    </div>
                    <div className="profile-foot">
                      <span className="hint mono tiny">
                        {p.active ? "searched" : "paused"} · last searched {p.last_crawled_at ? p.last_crawled_at.slice(0, 10) : "never"}
                      </span>
                      <button className="btn small" disabled={saving}>Save</button>
                    </div>
                  </Form>

                  <div className="profile-acts">
                    <Form method="post">
                      <input type="hidden" name="intent" value="profile-active" />
                      <input type="hidden" name="id" value={p.id} />
                      {p.active ? null : <input type="hidden" name="active" value="1" />}
                      <button className="btn small ghost" disabled={saving}>{p.active ? "Pause" : "Resume"}</button>
                    </Form>
                    {profiles.length > 1 && (
                      <ConfirmForm
                        method="post"
                        confirm={`Delete "${p.name}" and every posting found under it? Its applications and notes go too.`}
                      >
                        <input type="hidden" name="intent" value="profile-delete" />
                        <input type="hidden" name="id" value={p.id} />
                        <button className="btn small danger" disabled={saving}>Delete</button>
                      </ConfirmForm>
                    )}
                  </div>
                </div>
                  <details className="profile-kb">
                    <summary>
                      Knowledge base — {p.kb.length ? `${p.kb.length} of ${kbItems.length} selected` : `all ${kbItems.length}`}
                    </summary>
                    <p className="hint">
                      The knowledge base is shared: everything you have ever added is available to every
                      profile, so a new one never starts empty. Selecting here narrows what <em>this</em>
                      {" "}profile builds résumés from. Select nothing and it uses all of it.
                    </p>
                    <Form method="post" className="profile-kb-form">
                      <input type="hidden" name="intent" value="profile-kb" />
                      <input type="hidden" name="id" value={p.id} />
                      <div className="kb-pick">
                        {kbItems.map((k: any) => (
                          <label key={k.id} className="kb-pick-item">
                            <input type="checkbox" name="item" value={k.id} defaultChecked={p.kb.includes(k.id)} />
                            <span className="kb-pick-kind">{k.kind}</span>
                            <span className="kb-pick-title">{k.title}</span>
                          </label>
                        ))}
                      </div>
                      <button className="btn small" disabled={saving}>Save selection</button>
                    </Form>
                    {profiles.length > 1 && (
                      <Form method="post" className="profile-kb-copy">
                        <input type="hidden" name="intent" value="profile-kb-copy" />
                        <input type="hidden" name="id" value={p.id} />
                        <Select
                          name="from"
                          defaultValue=""
                          options={[
                            { value: "", label: "Copy a selection from…" },
                            ...profiles.filter((o: any) => o.id !== p.id).map((o: any) => ({ value: o.id, label: o.name })),
                          ]}
                        />
                        <button className="btn small ghost" disabled={saving}>Copy</button>
                      </Form>
                    )}
                  </details>
              </div>
            ))}
          </div>
      
          <Form method="post" className="panel">
            <input type="hidden" name="intent" value="profile-create" />
            <h3>Add a search</h3>
            <p className="hint">
              It starts with the shipped job boards, and keeps its own postings — a role that suits
              two of your searches is collected under each, with its own stage and notes.
            </p>
            <div className="row2">
              <div className="field"><label>Name</label><input type="text" name="name" placeholder="Product design" required /></div>
              <div className="field"><label>Field</label>
                <Select name="field" defaultValue={DEFAULT_FIELD} options={JOB_FIELDS.map((f) => ({ value: f.id, label: f.label }))} />
              </div>
            </div>
            <div className="row2">
              <div className="field"><label>Where</label><input type="text" name="location" placeholder="Remote · Europe" /></div>
              <div className="field"><label>What you do</label><input type="text" name="stack" placeholder="Figma, user research, design systems" /></div>
            </div>
            <button className="btn" disabled={saving}>Add profile</button>
          </Form>
        </>
      )}
      
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
                    <td>
                      {r.label}
                      {r.detail && <div className="job-fine">{r.detail}</div>}
                    </td>
                    <td>{r.kind.toUpperCase()}</td>
                    {/* a local runner can be installed and simply not started, which is
                        neither a missing key nor a missing install */}
                    <td>{r.available ? <span className="badge ok">Ready</span> : <span className="badge off">{r.needsKey ? "Needs key" : r.kind === "api" ? "Not running" : "Not installed"}</span>}</td>
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
            <p className="hint" style={{ marginTop: 14 }}>
              Model per runner — pulled from the agent/provider. CLI agents list the aliases they accept (e.g. sonnet, opus); API runners list live models when a key is set. "Default" uses the agent's own default.
            </p>
            <div className="row2">
              {availRunners.map((r) => (
                <div className="field" key={r.id}>
                  <label>{r.label} {r.kind === "cli" ? <span className="badge off">cli</span> : null}</label>
                  {/* mirrors modelFor(): saved model, else the runner's own default */}
                  <Select name={`model_${r.id}`} defaultValue={settings.models[r.id] || r.defaultModel || "default"} options={modelOptions[r.id] || [{ value: "default", label: "Default" }]} />
                </div>
              ))}
            </div>
            {availRunners.some((r) => r.id === "openrouter-api") && (
              <p className="hint" style={{ marginTop: 0 }}>
                OpenRouter shows its free models and cheapest paid ones here.{" "}
                <button type="button" className="back-link" onClick={() => setTab("OpenRouter")} style={{ color: "var(--vermillion)" }}>Browse the full catalogue →</button>
              </p>
            )}
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
          <p className="hint" style={{ marginTop: 12 }}>
            No budget for any of these? <button type="button" className="back-link" onClick={() => setTab("OpenRouter")} style={{ color: "var(--vermillion)" }}>OpenRouter runs the whole Ledger free →</button>
          </p>
        </div>
      )}

      {tab === "OpenRouter" && (
        <OpenRouterPicker
          selected={settings.openrouterModel}
          freeOnly={settings.openrouterFreeOnly}
          freeFallback={settings.openrouterFreeFallback}
          fallbacks={settings.openrouterFallbacks}
          webSearch={settings.openrouterWebSearch}
          webMaxResults={settings.openrouterWebMaxResults}
          hasKey={keys.some((k) => k.name === "openrouter_api_key" && k.set)}
        />
      )}

      {tab === "Local" && <OllamaSetup currentModel={settings.ollamaModel} />}

      {tab === "Search" && <SearchSetup />}

      {tab === "Scheduler" && (
        <Form method="post" className="panel">
          <input type="hidden" name="intent" value="save-scheduler" />
          <h3>Scheduler &amp; scraping</h3>
          <p className="hint">The built-in scheduler crawls for fresh jobs while the app runs, and scrapes each posting's full JD.</p>
          {/* numbers pair with numbers, so the labels and boxes sit on one baseline */}
          <div className="row2">
            <div className="field"><label>Crawl every (hours)</label><input type="number" min="1" name="scheduler_interval_hours" defaultValue={settings.schedulerInterval} /></div>
            <div className="field"><label>Max postings to scrape per crawl</label><input type="number" min="0" name="scrape_limit" defaultValue={settings.scrapeLimit} /></div>
          </div>
          {/* the toggles belong together on their own line — a checkbox pushed to the
              bottom of a grid cell to meet an input's baseline never quite lands */}
          <div className="checkrow" style={{ margin: "16px 0 20px" }}>
            <label><input type="checkbox" name="scheduler_enabled" defaultChecked={settings.schedulerEnabled} /> Scheduler enabled</label>
            <label><input type="checkbox" name="scrape_jds" defaultChecked={settings.scrapeJds} /> Scrape full JDs on crawl</label>
          </div>
          <div className="row2">
            <div className="field">
              <label>Auto-apply browser</label>
              <Select
                name="apply_browser"
                defaultValue={settings.applyBrowser}
                options={[
                  { value: "playwright", label: "Fresh browser (nothing logged in)" },
                  { value: "attach", label: "My Chrome (opens a tab, keeps my logins)" },
                ]}
              />
            </div>
            <div className="field">
              <label>Chrome debugging address</label>
              <input type="text" name="apply_cdp_url" defaultValue={settings.applyCdpUrl} placeholder="http://127.0.0.1:9222" />
            </div>
          </div>
          {/* six lines of prose in a half-width cell is what left the other half empty */}
          <p className="hint" style={{ margin: "-2px 0 18px", textTransform: "none", letterSpacing: 0, fontSize: 12 }}>
            &ldquo;My Chrome&rdquo; opens the application as a tab in a Chrome you are already running, so the
            form loads with your cookies and autofill. Start it with <code>npm run apply-browser start</code>{" "}
            and log in there once. Chrome refuses a debugging port on your <em>default</em> profile, so this
            is a dedicated profile that remembers its sessions, not the exact window you have open.
          </p>
          {/* one control in a two-column grid left half the row blank; the note fills it */}
          <div className="row2">
            <div className="field">
              <label>Trash untouched jobs after (days)</label>
              <input type="number" min="0" name="stale_trash_days" defaultValue={settings.staleTrashDays} />
            </div>
            <p className="hint" style={{ margin: 0, alignSelf: "end", textTransform: "none", letterSpacing: 0, fontSize: 12 }}>
              A job still at &ldquo;Saved&rdquo; this long after it appeared is deleted for good and blocked, so a
              crawl cannot re-add it. Anything you touched is kept: moved past Saved, given notes, or
              had a r&eacute;sum&eacute; generated. <strong>0 turns this off.</strong>
            </p>
          </div>
          <div className="row2">
            <div className="field">
              <label>How the find-crawl stops</label>
              <Select
                name="crawl_mode"
                value={crawlMode}
                onChange={(v) => setCrawlMode(v)}
                options={[
                  { value: "time", label: "Time budget — run for N minutes" },
                  { value: "count", label: "Goal — run until N solid jobs (no time limit)" },
                ]}
              />
            </div>
            {crawlMode === "time" ? (
              <div className="field"><label>Find-crawl timeout (minutes)</label><input key="timeout" type="number" min="2" max="60" name="crawl_timeout_min" defaultValue={settings.crawlTimeout} /></div>
            ) : (
              <div className="field"><label>Target verified jobs</label><input key="target" type="number" min="1" max="25" name="crawl_target_count" defaultValue={settings.crawlTarget} /></div>
            )}
          </div>
          {/* keep the hidden field for the inactive mode so its saved value is preserved */}
          {crawlMode === "time"
            ? <input type="hidden" name="crawl_target_count" value={settings.crawlTarget} />
            : <input type="hidden" name="crawl_timeout_min" value={settings.crawlTimeout} />}
          <p className="hint" style={{ margin: "-2px 0 18px", textTransform: "none", letterSpacing: 0, fontSize: 12 }}>
            {crawlMode === "time"
              ? "Time budget: the agent self-paces by an action cap derived from this timeout, and is hard-stopped only at 2× if it runs away."
              : "Goal mode: the agent keeps searching and following links to employer pages over several rounds until it has this many verified-open roles. No time limit (a per-round safety net still applies)."}
          </p>
          <div style={{ display: "flex", gap: 10 }}>
            <button className="btn" disabled={saving}>Save</button>
            <button className="ghost-btn" name="intent" value="crawl-now" formNoValidate>{saving ? "Crawling…" : "Run crawl now"}</button>
          </div>
        </Form>
      )}


      {tab === "Companies" && (
        <div className="panel">
          <h3>Company career pages <span className="badge ok">{companies.filter((c: any) => c.active).length}</span></h3>
          <p className="hint">
            Roles are posted on a company&rsquo;s own board before they reach any aggregator. Greenhouse,
            Lever, Ashby and Recruitee publish theirs as public JSON, so those are read directly: exact,
            instant, and effectively free. A company with a bespoke careers page falls back to the agent.
            A <strong>job board</strong> is mined differently: the agent follows each listing through to the
            employer&rsquo;s own posting, so the board&rsquo;s link never ends up on your ledger.
          </p>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
            <Form method="post">
              <input type="hidden" name="intent" value="company-bootstrap" />
              <button className="ghost-btn" disabled={saving}>Find boards in my ledger</button>
            </Form>
            <Form method="post">
              <input type="hidden" name="intent" value="careers-now" />
              <button className="btn" disabled={saving || !companies.some((c: any) => c.active)}>Check career pages now</button>
            </Form>
          </div>

          <Form method="post" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 14 }}>
            <input type="hidden" name="intent" value="company-add" />
            <div className="field" style={{ margin: 0, flex: "1 1 150px" }}>
              <label>Name</label>
              <input type="text" name="name" placeholder="Acme" required />
            </div>
            <div className="field" style={{ margin: 0, flex: "0 0 130px" }}>
              <label>Type</label>
              <Select name="kind" options={[{ value: "company", label: "Company" }, { value: "board", label: "Job board" }]} />
            </div>
            <div className="field" style={{ margin: 0, flex: "0 0 130px" }}>
              <label>ATS</label>
              <Select name="ats" options={[{ value: "", label: "none / custom" }, ...ATS_KINDS.map((a) => ({ value: a, label: a }))]} />
            </div>
            <div className="field" style={{ margin: 0, flex: "1 1 140px" }}>
              <label>Board slug</label>
              <input type="text" name="slug" placeholder="acme" />
            </div>
            <div className="field" style={{ margin: 0, flex: "1 1 200px" }}>
              <label>or careers page URL</label>
              <input type="text" name="careers_url" placeholder="https://acme.com/careers" />
            </div>
            <button className="ghost-btn" disabled={saving}>Add</button>
          </Form>

          {companies.length === 0 ? (
            <p className="hint">None tracked yet. &ldquo;Find boards in my ledger&rdquo; seeds this from jobs you already have.</p>
          ) : (
            <table className="ledger-table">
              <thead><tr><th>Name</th><th>Type</th><th>Source</th><th>Last checked</th><th>Kept</th><th></th></tr></thead>
              <tbody>
                {companies.map((c: any) => (
                  <tr key={c.id} style={c.active ? undefined : { opacity: 0.5 }}>
                    <td>{c.name}</td>
                    <td>{c.kind === "board" ? <span className="badge warn">job board</span> : <span className="badge off">company</span>}</td>
                    <td>
                      {c.ats ? (
                        <a href={boardUrl(c.ats, c.slug)} target="_blank" rel="noreferrer" className="back-link">{c.ats}:{c.slug}</a>
                      ) : (
                        <a href={c.careers_url} target="_blank" rel="noreferrer" className="back-link">careers page</a>
                      )}
                    </td>
                    {/* "never looked at" and "looked at, nothing kept" are different
                        facts about a source, and both used to print as a dash. */}
                    <td>
                      {c.last_checked_at ? (
                        c.last_checked_at.slice(0, 10)
                      ) : (
                        <span style={{ color: "var(--ink-faint)" }}>never</span>
                      )}
                    </td>
                    <td>{c.last_checked_at ? c.last_found : "\u2014"}</td>
                    <td style={{ display: "flex", gap: 10 }}>
                      <Form method="post">
                        <input type="hidden" name="intent" value="company-toggle" />
                        <input type="hidden" name="id" value={c.id} />
                        <input type="hidden" name="active" value={c.active ? "0" : "1"} />
                        <button className="back-link" disabled={saving}>{c.active ? "pause" : "resume"}</button>
                      </Form>
                      <Form method="post">
                        <input type="hidden" name="intent" value="company-remove" />
                        <input type="hidden" name="id" value={c.id} />
                        <button className="back-link" disabled={saving} style={{ color: "var(--vermillion)" }}>remove</button>
                      </Form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === "Companies" && (
        <div className="panel">
          <h3>
            Give a board back{" "}
            {community.pending.length ? <span className="badge warn">{community.pending.length} to offer</span> : <span className="badge off">nothing new</span>}
          </h3>
          <p className="hint">
            The list every install ships with is short because one person wrote it. If you are using a
            board that is not in it, you can offer it back{community.upstream ? <> to <strong>{community.upstream}</strong></> : null} as a
            pull request, opened from your own GitHub login for the maintainer to read and merge.
          </p>

          {community.pending.length === 0 ? (
            <p className="hint" style={{ textTransform: "none", letterSpacing: 0, fontSize: 12 }}>
              Every board you track is already in the shipped list. Add one it does not have and it turns up here.
            </p>
          ) : (
            <Form method="post">
              <input type="hidden" name="intent" value="community-submit" />
              {/* the whole payload, per board, before any of it is published */}
              <table className="ledger-table">
                <thead><tr><th></th><th>Board</th><th>What would be sent</th><th>Roles found</th></tr></thead>
                <tbody>
                  {community.pending.map((b: any) => (
                    <tr key={b.url}>
                      <td><input type="checkbox" name="board" value={b.url} defaultChecked={b.jobsFound > 0} /></td>
                      <td>
                        <div style={{ fontWeight: 600 }}>{b.name}</div>
                        <div className="hint" style={{ margin: "3px 0 0", textTransform: "none", letterSpacing: 0 }}>{b.url}</div>
                      </td>
                      <td style={{ fontFamily: "var(--mono)", fontSize: 11, maxWidth: 420 }}>
                        {b.note ? b.note : <span style={{ color: "var(--ink-faint)" }}>no note</span>}
                      </td>
                      <td style={{ fontFamily: "var(--mono)", fontSize: 12 }}>{b.jobsFound}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="hint" style={{ textTransform: "none", letterSpacing: 0, fontSize: 12, margin: "10px 0 12px" }}>
                Exactly the four columns above leave this machine &mdash; name, address, note and count. Your
                jobs, r&eacute;sum&eacute;, profile and keys are never read. The note is text you wrote for
                yourself, so read it back before you send it: the pull request is public.
              </p>
              <button className="btn" disabled={saving}>{saving ? "Opening a pull request\u2026" : "Offer the ticked boards"}</button>
            </Form>
          )}

          <Form method="post" style={{ borderTop: "1.5px solid var(--rule-faint)", marginTop: 18, paddingTop: 16 }}>
            <input type="hidden" name="intent" value="community-toggle" />
            <div className="checkrow">
              <label><input type="checkbox" name="community_share" defaultChecked={community.on} /> Offer new boards automatically, once a day</label>
            </div>
            <p className="hint" style={{ textTransform: "none", letterSpacing: 0, fontSize: 12, margin: "10px 0 12px" }}>
              Off by default. With it on, a board you keep and have not yet offered goes up as a pull request
              once a day &mdash; same four fields, and only one open request at a time.
              {community.lastSubmit ? <> Last offered {community.lastSubmit.slice(0, 10)}.</> : null}
            </p>
            <button className="ghost-btn" disabled={saving}>Save sharing setting</button>
          </Form>
        </div>
      )}

      {tab === "Danger" && <DangerZone scopes={reset.scopes} backups={reset.backups} busy={saving} />}

      {tab === "Prompt" && (
        <Form method="post" className="panel">
          <input type="hidden" name="intent" value="save-prompt" />
          <h3>Job-search prompt</h3>
          <p className="hint">What the scheduler asks the AI to find each crawl. Uses {"{{location}}"}, {"{{field}}"} and {"{{stack}}"} from your profile.</p>
          <div className="field"><textarea name="search_prompt" defaultValue={settings.searchPrompt} style={{ minHeight: 300, fontFamily: "var(--mono)", fontSize: 12 }} /></div>
          <button className="btn" disabled={saving}>Save</button>
        </Form>
      )}

    </Shell>
  );
}

/**
 * Who this ledger is searching for.
 *
 * The field is not decoration: it selects the vocabulary the crawl filters on, it is
 * what the boards are asked for where they can answer that, and it is interpolated
 * into the scorer where "software engineering role" used to be hardcoded. Leaving it
 * unset is a valid answer and says so — everything then falls to the keywords.
 */
