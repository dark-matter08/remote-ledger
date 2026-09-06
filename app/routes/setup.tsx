import { useEffect, useRef, useState } from "react";
import { Form, Link, redirect, useNavigation, useSearchParams, useFetcher } from "react-router";
import { ArrowLeft, ArrowRight, Check, Play, Search, Trash2 } from "lucide-react";
import type { Route } from "./+types/setup";
import { Shell } from "../components/Shell";
import { Select } from "../components/Select";
import { FilePicker } from "../components/FilePicker";
import { ParseLoader } from "../components/ParseLoader";
import { RunnerChoice } from "../components/RunnerChoice";
import { listRunners } from "../llm/runner.server";
import { discoverModels, openRouterShortlist } from "../llm/models.server";
import { setSecret, hasSecret } from "../secrets.server";
import {
  listProfiles, getDefaultProfile, extractPdfText, parseResumeText, saveProfile,
} from "../resume/profiles.server";
import { getSetting, setSetting, getDb } from "../sqlite.server";
import { startCrawl, isCrawlRunning, targetPreview } from "../services/crawl.server";
import { listCompanies, addCompany, removeCompany } from "../services/ats.server";
import { FEEDS } from "../services/feeds.server";
import { getCrawlRun } from "../db.server";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Setting up · The Remote & Ledger" }];
}

const KEY_FIELDS = [
  { name: "openrouter_api_key", label: "OpenRouter" },
  { name: "anthropic_api_key", label: "Anthropic" },
  { name: "openai_api_key", label: "OpenAI" },
  { name: "google_api_key", label: "Google Gemini" },
  { name: "groq_api_key", label: "Groq" },
  { name: "mistral_api_key", label: "Mistral" },
];

// Settings the app can reasonably choose for someone. They used to be step one — a
// button whose only job was to write eight rows nobody was being asked about, which
// is a step that teaches nothing and can only be got wrong. They are applied on the
// first visit instead, and step 6 says what they are and where to change them.
const DEFAULTS: Record<string, string> = {
  budget_monthly_usd: "0",
  scheduler_enabled: "true",
  scheduler_interval_hours: "4",
  scrape_jds: "true",
  scrape_limit: "12",
  crawl_mode: "time",
  crawl_timeout_min: "15",
  stale_trash_days: "14",
  default_resume_style: "ats-plain",
};

function applyDefaultsOnce(): void {
  if (getSetting("defaults_initialized") === "true") return;
  for (const [k, v] of Object.entries(DEFAULTS)) if (getSetting(k) === null) setSetting(k, v);
  setSetting("defaults_initialized", "true");
}

export async function loader({ request }: Route.LoaderArgs) {
  applyDefaultsOnce();

  const runners = await listRunners();
  // Only the runners that can actually be picked need a model list — discovery is a
  // network call per provider, and the wizard should not wait on six of them.
  const modelOptions: Record<string, { value: string; label: string }[]> = {};
  await Promise.all(
    runners
      .filter((r) => r.available)
      .map(async (r) => {
        const opts =
          r.provider === "openrouter"
            ? await openRouterShortlist()
            : (await discoverModels(r.id, r.provider, r.kind)).map((m) => ({
                value: m,
                label: m === "default" ? "Default" : m,
              }));
        if (r.defaultModel && !opts.some((o) => o.value === r.defaultModel))
          opts.push({ value: r.defaultModel, label: r.defaultModel });
        modelOptions[r.id] = opts;
      })
  );

  const db = getDb();
  const profile = getDefaultProfile();
  const companies = listCompanies();
  const runId = Number(new URL(request.url).searchParams.get("run") || 0);

  return {
    runners,
    modelOptions,
    keys: KEY_FIELDS.map((k) => ({ ...k, set: hasSecret(k.name) })),
    defaultRunner: getSetting("default_runner") || "",
    models: Object.fromEntries(runners.map((r) => [r.id, getSetting(`model_${r.id}`) || ""])),
    resumeStyle: getSetting("default_resume_style") || "ats-plain",
    hasResume: listProfiles().length > 0,
    resume: profile
      ? {
          name: profile.name,
          contact: profile.data.contact ?? null,
          experience: (profile.data.experience ?? []).slice(0, 6).map((e: any) => ({
            company: e.company ?? "",
            title: e.title ?? e.role ?? "",
            start: e.start ?? e.start_date ?? "",
            end: e.end ?? e.end_date ?? "",
          })),
          roles: profile.data.experience?.length || 0,
          skills: (profile.data.skills ?? []).slice(0, 18),
          skillCount: profile.data.skills?.length || 0,
        }
      : null,
    location: getSetting("profile_location") || "",
    stack: getSetting("profile_stack") || "",
    autofilled: getSetting("target_autofilled") === "true",
    promptPreview: targetPreview(),
    // Split, not one list: the job boards are a handful and worth reading here, while
    // the employer career pages are however many a long-running ledger has accumulated
    // — 60 rows of them is a wall, and managing them is what Settings → Companies is.
    boards: companies
      .filter((c) => c.active && c.kind === "board")
      .map((c) => ({ id: c.id, name: c.name, url: c.careers_url, ats: c.ats, slug: c.slug })),
    companyCount: companies.filter((c) => c.active && c.kind !== "board").length,
    feedNames: FEEDS.map((f) => f.name),
    jobCount: Number((db.prepare("SELECT COUNT(*) n FROM jobs").get() as any).n),
    // Step 6 reports these back. Read live rather than echoing DEFAULTS: a returning
    // user has changed some of them, and a summary that quietly describes the shipped
    // values instead of theirs is worse than no summary.
    chosen: {
      schedulerOn: getSetting("scheduler_enabled") !== "false",
      interval: getSetting("scheduler_interval_hours") || "4",
      budget: getSetting("budget_monthly_usd") || "0",
      scrapeJds: getSetting("scrape_jds") !== "false",
      scrapeLimit: getSetting("scrape_limit") || "12",
      staleDays: getSetting("stale_trash_days") ?? "14",
    },
    tested: {
      runner: getSetting("setup_runner_tested"),
      feeds: getSetting("setup_feeds_tested"),
    },
    crawling: isCrawlRunning(),
    run: runId ? getCrawlRun(runId) : null,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  if (intent === "recheck") {
    // The loader re-runs either way, but a button that visibly does nothing when the
    // answer is "still nothing" reads as broken rather than as an answer.
    const found = (await listRunners()).filter((r) => r.available && r.kind === "cli");
    return found.length
      ? { ok: true, msg: `Found ${found.map((r) => r.label.replace(" (CLI)", "")).join(", ")}.` }
      : { error: "Still nothing on this machine's PATH. If you just installed one, the Ledger needs `npm run ledger restart` to see it." };
  }

  if (intent === "set-key") {
    const name = String(form.get("name") || "");
    const value = String(form.get("value") || "").trim();
    if (!value) return { error: "Paste the key first." };
    setSecret(name, value);
    return { ok: true, msg: `${name.replace(/_api_key$/, "")} key saved. It never leaves this machine except to that provider.` };
  }

  if (intent === "save-runner") {
    const runner = String(form.get("default_runner") || "");
    setSetting("default_runner", runner);
    // one Select serves whichever runner is chosen, so the key it writes to travels
    // with the form rather than being one field per runner
    const key = String(form.get("model_key") || "");
    const value = String(form.get("model_value") || "");
    if (key.startsWith("model_") && value) setSetting(key, value);
    return { ok: true, msg: `The Ledger will use ${runner}${value ? ` · ${value}` : ""}.` };
  }

  if (intent === "upload-resume") {
    try {
      const file = form.get("file") as File | null;
      if (!file || file.size === 0) return { error: "Choose a PDF first." };
      const buf = Buffer.from(await file.arrayBuffer());
      const text = await extractPdfText(buf);
      if (text.length < 40)
        return { error: "No text could be read from that PDF — it is probably a scan or an image. Export it from your editor as a text PDF and try again." };
      const { resume } = await parseResumeText(text);
      saveProfile({
        name:
          String(form.get("name") || "").trim() ||
          resume.contact?.name ||
          file.name.replace(/\.pdf$/i, "") ||
          "Résumé",
        data: resume,
        raw_text: text,
        source_file: file.name,
        makeDefault: true,
      });
      let filled = false;
      if (!getSetting("profile_location") && resume.contact?.location) {
        setSetting("profile_location", resume.contact.location);
        filled = true;
      }
      if (!getSetting("profile_stack") && resume.skills?.length) {
        setSetting("profile_stack", resume.skills.slice(0, 12).join(", "));
        filled = true;
      }
      if (filled) setSetting("target_autofilled", "true");
      return {
        ok: true,
        msg: `Read ${resume.experience?.length || 0} role(s) and ${resume.skills?.length || 0} skill(s) out of it.${filled ? " Step 3 is pre-filled from what it said." : ""}`,
      };
    } catch (e: any) {
      return { error: String(e?.message || e) };
    }
  }

  if (intent === "save-style") {
    setSetting("default_resume_style", String(form.get("default_resume_style") || "ats-plain"));
    return { ok: true, msg: "Template saved. Each job can still override it." };
  }

  if (intent === "save-profile") {
    setSetting("profile_location", String(form.get("location") || "").trim());
    setSetting("profile_stack", String(form.get("stack") || "").trim());
    return { ok: true, msg: "Saved. The prompt below is what an agent will actually be handed." };
  }

  if (intent === "board-add") {
    const r = addCompany({
      name: String(form.get("name") || ""),
      careersUrl: String(form.get("careers_url") || "") || null,
      kind: "board",
      ats: null,
      slug: null,
    });
    return r.error ? { error: r.error } : { ok: true, msg: "Added. The crawl will follow its listings through to the employer." };
  }
  if (intent === "board-remove") {
    removeCompany(Number(form.get("id")));
    return { ok: true, msg: "Removed. It stays removed across updates." };
  }

  if (intent === "start-crawl") {
    if (isCrawlRunning()) return { error: "A crawl is already running — watch it in the Crawl Shell." };
    const id = startCrawl("find", "setup");
    return redirect(`/setup?step=5&run=${id}`);
  }

  if (intent === "complete") {
    setSetting("setup_complete", "true");
    return redirect("/");
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------

const STEPS = [
  { n: 1, title: "The AI", hint: "Pick what does the thinking — a subscription you already pay for, your own key, or a model on this machine." },
  { n: 2, title: "Your résumé", hint: "One PDF. It is read once, into structured fields you can edit; the file itself is not uploaded anywhere." },
  { n: 3, title: "Your target", hint: "Where you can work from and what you work in. These two answers are written straight into the search." },
  { n: 4, title: "Where to look", hint: "The boards that get read. Some need no AI at all, which is what makes a free setup work." },
  { n: 5, title: "First jobs", hint: "Run it once, watch it, and see what lands on the board." },
  { n: 6, title: "You're set", hint: "What was decided for you, and the parts of the app this wizard did not cover." },
] as const;

const STYLE_NOTE: Record<string, string> = {
  "ats-plain": "Plain Arial, no columns, no rules. Ugly to you, legible to the screening software that reads it first. Pick this unless you know the human sees it.",
  letterpress: "The app's own Heritage Press face. Beautiful; not what an applicant tracking system wants to parse.",
  modern: "Clean sans-serif, single column.",
  compact: "Serif, tight leading — for long histories that must stay on one page.",
};

export default function Setup({ loaderData, actionData }: Route.ComponentProps) {
  const d = loaderData;
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const parsing = busy && nav.formData?.get("intent") === "upload-resume";
  const [params, setParams] = useSearchParams();

  const done: Record<number, boolean> = {
    1: d.runners.some((r) => r.available),
    2: d.hasResume,
    3: !!d.location.trim(),
    4: d.feedNames.length > 0 || d.boards.length > 0 || d.companyCount > 0,
    5: d.jobCount > 0,
    6: false,
  };
  const verified: Record<number, boolean> = { 1: !!d.tested.runner, 4: !!d.tested.feeds };

  // First unfinished step, so a returning user lands where they stopped.
  const firstOpen = STEPS.find((s) => !done[s.n])?.n ?? 6;
  const step = Math.min(6, Math.max(1, Number(params.get("step") || firstOpen)));
  const go = (n: number) => {
    const next = new URLSearchParams(params);
    next.set("step", String(n));
    next.delete("run");
    next.delete("cleared"); // a one-time banner, not a mode
    setParams(next, { preventScrollReset: true });
  };

  const cur = STEPS.find((s) => s.n === step)!;

  return (
    <Shell>
      <div className="page-head">
        <div className="eyebrow" style={{ marginBottom: 8 }}>First Edition · Setting up</div>
        <h1>Welcome to the Press</h1>
        <div className="sub">Six steps. Each one ends by proving it works.</div>
      </div>
      <hr className="rule double" />

      <div className="setup-rail">
        {STEPS.map((s) => (
          <button
            key={s.n}
            type="button"
            className={`setup-tick ${step === s.n ? "on" : ""} ${done[s.n] ? "done" : ""}`}
            onClick={() => go(s.n)}
          >
            <span className="setup-tick-n">{done[s.n] ? <Check size={13} strokeWidth={2.5} /> : s.n}</span>
            <span className="setup-tick-t">{s.title}</span>
            {verified[s.n] && <span className="setup-tick-v" title="proved by a real call">✓</span>}
          </button>
        ))}
      </div>

      {params.get("cleared") === "1" && (
        <div className="notice ok">
          Your ledger was cleared and a copy of everything as it was is in <code>data/backups/</code>. This is
          a fresh install now — nothing below is carried over except what is installed on this machine.
        </div>
      )}
      {actionData?.error && <div className="notice err">{actionData.error}</div>}
      {actionData?.msg && <div className="notice ok">{actionData.msg}</div>}

      <div className="panel setup-panel">
        <h3>{cur.n}. {cur.title}</h3>
        <p className="setup-lede">{cur.hint}</p>

        {step === 1 && (
          <RunnerChoice
            runners={d.runners as any}
            modelOptions={d.modelOptions}
            keys={d.keys}
            defaultRunner={d.defaultRunner}
            models={d.models}
            busy={busy}
          />
        )}

        {step === 2 && <ResumeStep d={d} busy={busy} parsing={parsing} />}
        {step === 3 && <TargetStep d={d} busy={busy} />}
        {step === 4 && <SourcesStep d={d} busy={busy} />}
        {step === 5 && <FirstJobsStep d={d} busy={busy} />}
        {step === 6 && <ReadyStep d={d} />}
      </div>

      <div className="setup-nav">
        <button type="button" className="ghost-btn" disabled={step === 1} onClick={() => go(step - 1)}>
          <ArrowLeft size={13} /> Back
        </button>
        <span className="setup-nav-mid">
          {done[step] ? "This step is done — you can move on." : "Nothing here is locked. You can skip it and come back."}
        </span>
        {step < 6 ? (
          <button type="button" className="btn" onClick={() => go(step + 1)}>
            Next <ArrowRight size={13} />
          </button>
        ) : (
          <Form method="post">
            <input type="hidden" name="intent" value="complete" />
            <button className="btn" disabled={busy}>Enter the Ledger <ArrowRight size={13} /></button>
          </Form>
        )}
      </div>
    </Shell>
  );
}

// ---- step 2 ---------------------------------------------------------------

function ResumeStep({ d, busy, parsing }: { d: any; busy: boolean; parsing: boolean }) {
  return (
    <>
      <p className="setup-prose">
        The PDF is read on this machine and turned into fields — contact, roles, dates, bullets, skills.
        Everything downstream works off those fields, so a role the parser missed is a role no tailored
        résumé will mention. Which is why this step shows you exactly what it read.
      </p>

      {parsing ? (
        <ParseLoader />
      ) : (
        <Form method="post" encType="multipart/form-data">
          <input type="hidden" name="intent" value="upload-resume" />
          <div className="row2">
            <div className="field">
              <label>Call this profile</label>
              <input type="text" name="name" placeholder="e.g. Backend / DevOps — optional" />
            </div>
            <div className="field">
              <label>Your résumé, as a PDF</label>
              <FilePicker name="file" accept="application/pdf" />
            </div>
          </div>
          <button className="btn" disabled={busy}>{d.hasResume ? "Replace it" : "Read it"}</button>
          <p className="hint" style={{ marginTop: 8 }}>
            It must be a text PDF, not a scan or a photo — if you cannot select the words in a PDF reader,
            neither can this. Export from Word, Docs or your CV tool rather than printing to image.
          </p>
        </Form>
      )}

      {d.resume && (
        <div className="setup-read">
          <h4>What it read</h4>
          <div className="stat-grid" style={{ margin: "0 0 14px" }}>
            <div className="stat"><div className="k">Name</div><div className="v" style={{ fontSize: 19 }}>{d.resume.contact?.name || "—"}</div></div>
            <div className="stat"><div className="k">Roles</div><div className="v">{d.resume.roles}</div></div>
            <div className="stat"><div className="k">Skills</div><div className="v">{d.resume.skillCount}</div></div>
          </div>
          {d.resume.experience.length > 0 && (
            <table className="ledger-table">
              <thead><tr><th>Company</th><th>Title</th><th>From</th><th>To</th></tr></thead>
              <tbody>
                {d.resume.experience.map((e: any, i: number) => (
                  <tr key={i}>
                    <td>{e.company || <span className="badge warn">missing</span>}</td>
                    <td>{e.title || <span className="badge warn">missing</span>}</td>
                    <td className="num">{e.start || "—"}</td>
                    <td className="num">{e.end || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {d.resume.skills.length > 0 && (
            <p style={{ margin: "12px 0 0" }}>
              {d.resume.skills.map((s: string) => <span key={s} className="kb-tag">{s}</span>)}
              {d.resume.skillCount > d.resume.skills.length && <span className="job-fine"> +{d.resume.skillCount - d.resume.skills.length} more</span>}
            </p>
          )}
          <p className="hint" style={{ marginTop: 12 }}>
            Anything wrong or missing is fixable by hand on the <Link to="/resume" className="entry-title-link">Résumés</Link> page — and
            worth fixing now, because every tailored version starts from this.
          </p>
        </div>
      )}

      <Form method="post" className="setup-read">
        <input type="hidden" name="intent" value="save-style" />
        <h4>What tailored résumés should look like</h4>
        <div className="field" style={{ maxWidth: 340 }}>
          <label>Template</label>
          <Select
            name="default_resume_style"
            defaultValue={d.resumeStyle}
            options={[
              { value: "ats-plain", label: "ATS-plain — recommended" },
              { value: "modern", label: "Modern" },
              { value: "compact", label: "Compact" },
              { value: "letterpress", label: "Letterpress" },
            ]}
          />
        </div>
        <p className="setup-prose" style={{ marginTop: 0 }}>{STYLE_NOTE[d.resumeStyle] || STYLE_NOTE["ats-plain"]}</p>
        <button className="ghost-btn" disabled={busy}>Save template</button>
      </Form>
    </>
  );
}

// ---- step 3 ---------------------------------------------------------------

function TargetStep({ d, busy }: { d: any; busy: boolean }) {
  return (
    <>
      <p className="setup-prose">
        Two answers, and they do more work than anything else you type here. <strong>Location</strong> is
        not where you want to move — it is where you will be sitting, so a role that says "remote, US only"
        can be ruled out before it wastes your afternoon. <strong>Stack</strong> is the words that appear in
        the postings you want, not a description of yourself.
      </p>

      {d.autofilled && (
        <div className="notice warn">Pre-filled from your résumé. Read it back — the parser guesses, and this is the one place a guess is expensive.</div>
      )}

      <Form method="post">
        <input type="hidden" name="intent" value="save-profile" />
        <div className="row2">
          <div className="field">
            <label>Where you will be working from</label>
            <input type="text" name="location" defaultValue={d.location} placeholder="e.g. Lagos, Nigeria — or Remote (UTC+1)" />
          </div>
          <div className="field">
            <label>Stack and keywords</label>
            <input type="text" name="stack" defaultValue={d.stack} placeholder="e.g. TypeScript, Node, React, Postgres, AWS" />
          </div>
        </div>
        <button className="btn" disabled={busy}>Save</button>
      </Form>

      <div className="setup-read">
        <h4>What that becomes</h4>
        <p className="setup-prose" style={{ marginTop: 0 }}>
          The opening of the brief an agent is handed on every crawl. Your two answers are in it verbatim,
          which is why a vague stack produces vague jobs.
        </p>
        <pre className="setup-pre">{d.promptPreview}</pre>
        <p className="hint" style={{ marginTop: 10 }}>
          The rest of it — the rules about verifying links and skipping talent networks — is in
          Settings → Prompt, and you can rewrite any of it.
        </p>
      </div>
    </>
  );
}

// ---- step 4 ---------------------------------------------------------------

function SourcesStep({ d, busy }: { d: any; busy: boolean }) {
  const test = useFetcher<{
    ok: boolean;
    msg: string;
    perFeed?: { name: string; count: number }[];
    errors?: { name: string; error: string }[];
    sample?: { company: string; title: string; source: string }[];
  }>();

  return (
    <>
      <p className="setup-prose">
        There are two ways roles reach your board, and they cost very different things. The{" "}
        <strong>free boards</strong> below publish openings as plain data — no key, no AI, no charge — and
        the Ledger reads them directly. The <strong>boards and career pages</strong> under them are crawled
        by whatever you chose in step 1, which is slower and, on a paid runner, not free.
      </p>

      <div className="setup-read" style={{ marginTop: 0 }}>
        <h4>Free boards, read without any AI <span className="badge ok">{d.feedNames.length}</span></h4>
        <p style={{ margin: "0 0 12px" }}>
          {d.feedNames.map((n: string) => <span key={n} className="kb-tag">{n}</span>)}
        </p>
        <button
          type="button"
          className="btn"
          disabled={test.state !== "idle"}
          onClick={() => {
            const fd = new FormData();
            fd.set("intent", "test-feeds");
            test.submit(fd, { method: "post", action: "/api/setup" });
          }}
        >
          <Search size={13} /> {test.state !== "idle" ? "Reading them…" : "Read them now"}
        </button>
        <span className="hint" style={{ marginLeft: 12 }}>Takes a couple of seconds. Nothing is saved — this only proves they answer.</span>

        {test.data && (
          <div className={`notice ${test.data.ok ? "ok" : "err"}`}>
            <strong>{test.data.msg}</strong>
            {!!test.data.perFeed?.length && (
              <div className="job-fine" style={{ marginTop: 6 }}>
                {test.data.perFeed.map((f) => `${f.name} ${f.count}`).join(" · ")}
                {test.data.errors?.map((e) => ` · ${e.name} failed (${e.error})`)}
              </div>
            )}
            {!!test.data.sample?.length && (
              <ul className="setup-sample">
                {test.data.sample.map((p, i) => (
                  <li key={i}><strong>{p.company}</strong> — {p.title} <span className="job-fine">· via {p.source}</span></li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <div className="setup-read">
        <h4>Job boards <span className="badge ok">{d.boards.length}</span></h4>
        <p className="setup-prose" style={{ marginTop: 0 }}>
          Boards the app ships with, plus any you add. These are not read as data — the runner from step 1
          opens them, follows each listing through to the employer&rsquo;s own posting, and files that link
          rather than the board&rsquo;s. Remove one and it stays removed, including through updates.
        </p>
        {d.boards.length === 0 ? (
          <p className="hint">None. The free boards above still work without any of these.</p>
        ) : (
          <table className="ledger-table">
            <thead><tr><th>Name</th><th>Address</th><th></th></tr></thead>
            <tbody>
              {d.boards.map((b: any) => (
                <tr key={b.id}>
                  <td>{b.name}</td>
                  <td className="job-fine" style={{ wordBreak: "break-all" }}>{b.url || `${b.ats}:${b.slug}`}</td>
                  <td style={{ width: 40 }}>
                    <Form method="post">
                      <input type="hidden" name="intent" value="board-remove" />
                      <input type="hidden" name="id" value={b.id} />
                      <button className="back-link" disabled={busy} style={{ color: "var(--vermillion)" }}><Trash2 size={12} /></button>
                    </Form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <Form method="post" className="setup-add">
          <input type="hidden" name="intent" value="board-add" />
          <div className="field" style={{ margin: 0, flex: "1 1 160px" }}>
            <label>Board name</label>
            <input type="text" name="name" placeholder="e.g. Remotiko" required />
          </div>
          <div className="field" style={{ margin: 0, flex: "2 1 260px" }}>
            <label>Address</label>
            <input type="text" name="careers_url" placeholder="https://…" required />
          </div>
          <button className="ghost-btn" disabled={busy}>Add a board</button>
        </Form>
      </div>

      <div className="setup-read">
        <h4>Company career pages <span className={`badge ${d.companyCount ? "ok" : "off"}`}>{d.companyCount}</span></h4>
        <p className="setup-prose" style={{ margin: 0 }}>
          {d.companyCount > 0 ? (
            <>
              A role appears on an employer&rsquo;s own board before it reaches any aggregator, and the big
              four &mdash; Greenhouse, Lever, Ashby, Recruitee &mdash; publish theirs as public data, so those
              are read directly: exact, instant and free. This ledger already tracks{" "}
              <strong>{d.companyCount}</strong> of them, picked up from jobs it has seen. Add, pause or
              remove them in <Link to="/settings" className="entry-title-link">Settings &rarr; Companies</Link> &mdash;
              there is nothing to do here.
            </>
          ) : (
            <>
              None yet, and nothing to do about it now. Once a crawl has found a few roles,{" "}
              <Link to="/settings" className="entry-title-link">Settings &rarr; Companies</Link> can read their
              employers back out and watch those boards directly &mdash; which is free, exact, and earlier
              than any aggregator.
            </>
          )}
        </p>
      </div>
    </>
  );
}

// ---- step 5 ---------------------------------------------------------------

function FirstJobsStep({ d, busy }: { d: any; busy: boolean }) {
  const poll = useFetcher<{ run: any; logs: { id: number; kind: string; text: string }[] }>();
  const load = useRef(poll.load);
  load.current = poll.load;
  const runId = d.run?.id;
  const live = (poll.data?.run ?? d.run)?.status === "running";

  useEffect(() => {
    if (!runId) return;
    load.current(`/api/setup?run=${runId}`);
  }, [runId]);
  useEffect(() => {
    if (!runId || !live) return;
    const t = setInterval(() => load.current(`/api/setup?run=${runId}`), 2000);
    return () => clearInterval(t);
  }, [runId, live]);

  const run = poll.data?.run ?? d.run;
  const logs = poll.data?.logs ?? [];
  const webRunner = d.runners.find((r: any) => r.id === (d.defaultRunner || "")) ?? d.runners.find((r: any) => r.available);

  return (
    <>
      <p className="setup-prose">
        {webRunner?.web
          ? <>Your runner, <strong>{webRunner.label}</strong>, can open live pages — so this searches, follows each listing through to the employer&rsquo;s own posting, and keeps only the ones whose application page actually loaded.</>
          : webRunner
            ? <>Your runner, <strong>{webRunner.label}</strong>, cannot browse. That is not a failure: the crawl reads the free boards from step 4 instead and uses the model only to score what it found. You get real postings; you just do not get research.</>
            : <>Nothing is set up to run this yet. Go back to step 1, or skip ahead &mdash; the board works fine empty and you can crawl at any time.</>}
      </p>

      {/* A crawl with nothing to aim at is not broken, it is just generic — and that
          is much cheaper to say now than to discover in the results. */}
      {!d.location.trim() && (
        <div className="notice warn">
          Step 3 is still blank, so this would search on generic defaults rather than on your location and
          stack. Two lines there make the difference between "remote developer jobs" and yours.
        </div>
      )}
      {!d.hasResume && (
        <div className="notice warn">
          No r&eacute;sum&eacute; yet, so postings will arrive scored on the target from step 3 alone. The
          match against your own experience is the part that needs step 2.
        </div>
      )}

      {!run && (
        <Form method="post">
          <input type="hidden" name="intent" value="start-crawl" />
          <button className="btn" disabled={busy || d.crawling || !webRunner}>
            <Play size={13} /> {d.crawling ? "A crawl is already running…" : "Find jobs now"}
          </button>
          <span className="hint" style={{ marginLeft: 12 }}>
            {webRunner
              ? "Runs here, live. Leaving this page does not stop it."
              : "Needs a runner from step 1 — even reading the free boards uses one to score what it finds."}
          </span>
        </Form>
      )}

      {run && (
        <div className="setup-read">
          <h4>
            Run #{run.id}{" "}
            {run.status === "running"
              ? <span className="badge on">running</span>
              : run.status === "done"
                ? <span className="badge ok">finished</span>
                : <span className="badge warn">{run.status}</span>}
          </h4>
          <div className="stat-grid" style={{ margin: "0 0 12px" }}>
            <div className="stat"><div className="k">Found</div><div className="v">{run.found ?? 0}</div></div>
            <div className="stat"><div className="k">New</div><div className="v">{run.added ?? 0}</div></div>
            <div className="stat"><div className="k">Errors</div><div className="v">{run.errors ?? 0}</div></div>
          </div>
          <pre className="setup-pre setup-log">
            {logs.length ? logs.map((l) => `${l.kind === "error" ? "! " : "· "}${l.text}`).join("\n") : "starting…"}
          </pre>
          <div className="setup-actions">
            <Link to={`/crawl?run=${run.id}`} className="ghost-btn">Watch it in the Crawl Shell</Link>
            {d.jobCount > 0 && <Link to="/board" className="ghost-btn">See the {d.jobCount} on the board</Link>}
          </div>
        </div>
      )}

      {!run && d.jobCount > 0 && (
        <p className="setup-prose">
          There are already <strong>{d.jobCount}</strong> jobs on your board. <Link to="/board" className="entry-title-link">Go and look</Link>.
        </p>
      )}
    </>
  );
}

// ---- step 6 ---------------------------------------------------------------

function ReadyStep({ d }: { d: any }) {
  return (
    <>
      <p className="setup-prose">
        That is the whole setup. Below is what was decided for you without asking, because there is a
        sensible answer and it can be changed in one place — and then the parts of the Ledger this wizard
        did not walk you through.
      </p>

      <div className="setup-read" style={{ marginTop: 0 }}>
        <h4>Chosen for you</h4>
        <table className="ledger-table">
          <tbody>
            <tr>
              <td>Crawl on a schedule</td>
              <td className="num">{d.chosen.schedulerOn ? `every ${d.chosen.interval} hours, while the app is open` : "off"}</td>
              <td className="job-fine">Settings → Scheduler</td>
            </tr>
            <tr>
              <td>Monthly spend cap</td>
              <td className="num">{Number(d.chosen.budget) > 0 ? `$${d.chosen.budget}` : "none"}</td>
              <td className="job-fine">Settings → Runners</td>
            </tr>
            <tr>
              <td>Full descriptions fetched</td>
              <td className="num">{d.chosen.scrapeJds ? `up to ${d.chosen.scrapeLimit} per crawl` : "off"}</td>
              <td className="job-fine">Settings → Scheduler</td>
            </tr>
            <tr>
              <td>Untouched jobs deleted after</td>
              <td className="num">{Number(d.chosen.staleDays) > 0 ? `${d.chosen.staleDays} days` : "never"}</td>
              <td className="job-fine">Settings → Scheduler</td>
            </tr>
            <tr>
              <td>Backups</td>
              <td className="num">every 6 hours, last 10 kept</td>
              <td className="job-fine">Settings → Danger zone</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="setup-read">
        <h4>What else is in here</h4>
        <ul className="setup-list">
          <li>
            <Link to="/knowledge" className="entry-title-link">The knowledge base</Link> — what your résumé
            does not say. Point it at a project folder, or just write notes; it uses them to close the gaps a
            posting opens up, with your own words rather than invented ones.
          </li>
          <li>
            <Link to="/clipper" className="entry-title-link">The clipper</Link> — a browser button that files
            any posting you are looking at, reads it in full, and scores it against your résumé.
          </li>
          <li>
            <Link to="/board" className="entry-title-link">The board</Link> — and inside any job, a guided
            application: match, close the gaps, tailor, cover letter, apply.
          </li>
          <li>
            <Link to="/usage" className="entry-title-link">Usage</Link> — every AI call, what it was for and
            what it cost. Nothing is billed anywhere you cannot see.
          </li>
          <li>
            <Link to="/settings" className="entry-title-link">Settings → Danger zone</Link> — clear the whole
            ledger and come back to this wizard. It takes a backup first, every time.
          </li>
        </ul>
      </div>

      {/* no button here: the one in the footer below is the same action, and two of
          them side by side reads as two different endings */}
      <p className="setup-prose setup-finish">
        {d.jobCount > 0
          ? <>There {d.jobCount === 1 ? "is" : "are"} <strong>{d.jobCount}</strong> job{d.jobCount === 1 ? "" : "s"} waiting on your board.</>
          : <>Your board is empty. A crawl or the clipper fills it, and neither is in a hurry.</>}
      </p>
    </>
  );
}
