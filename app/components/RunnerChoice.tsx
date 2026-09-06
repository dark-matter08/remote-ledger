import { useEffect, useRef, useState } from "react";
import { Form, useFetcher } from "react-router";
import { Check, Copy, Download, Play, RefreshCw, TerminalSquare, Zap } from "lucide-react";
import { Select } from "./Select";
import { recommendedModel, sameModel } from "../ollama";

// Step one of the wizard: pick the AI that does the work.
//
// This used to be a sentence telling you to go to Settings, which meant the first step
// of setup was to leave setup. Worse, it named Claude Code and nothing else, so the
// only readable answer was "install the thing the author uses" — for anyone without a
// subscription, the wizard's first instruction was one they could not follow.
//
// There are three real routes and they cost different things, so all three are here,
// side by side, with the work for each one done in place: the install line to copy,
// the key field to paste into, the local daemon to start. The step then ends where
// every step should — a button that makes a real call and prints what came back.

export interface RunnerRow {
  id: string;
  label: string;
  kind: string;
  provider: string;
  available: boolean;
  needsKey?: string | null;
  defaultModel?: string | null;
  web?: boolean | null;
  detail?: string | null;
}

interface Opt { value: string; label: string }

/**
 * How each agent is normally installed.
 *
 * Printed rather than run: this is a global install on someone's machine and they
 * should see the line before it happens. The docs link is there because these
 * commands are the vendors' to change, not ours.
 */
const CLI_INSTALL: Record<string, { cmd: string; docs: string; note: string }> = {
  "claude-cli": {
    cmd: "npm install -g @anthropic-ai/claude-code",
    docs: "https://docs.claude.com/en/docs/claude-code/setup",
    note: "Included with a Claude Pro or Max subscription. Searches the web, which is what the job crawl needs.",
  },
  "codex-cli": {
    cmd: "npm install -g @openai/codex",
    docs: "https://github.com/openai/codex",
    note: "Included with a ChatGPT Plus or Pro subscription.",
  },
  "cursor-cli": {
    cmd: "curl https://cursor.com/install -fsS | bash",
    docs: "https://cursor.com/docs/cli",
    note: "Included with a Cursor subscription.",
  },
  "gemini-cli": {
    cmd: "npm install -g @google/gemini-cli",
    docs: "https://github.com/google-gemini/gemini-cli",
    note: "Free tier available with a Google account.",
  },
};

const KEY_NOTE: Record<string, string> = {
  openrouter_api_key:
    "One key, 400+ models, and a shelf of them free. The cheapest way in if you are not paying for anything yet.",
  anthropic_api_key: "Pay per token for Claude. Exact usage comes back on every call.",
  openai_api_key: "Pay per token for GPT.",
  google_api_key: "Gemini has a free tier that is generous enough to run this app.",
  groq_api_key: "Very fast, open models, free tier.",
  mistral_api_key: "Pay per token, European hosting.",
};

function CopyLine({ text }: { text: string }) {
  const [hit, setHit] = useState(false);
  return (
    <div className="setup-cmd">
      <code>{text}</code>
      <button
        type="button"
        className="ghost-btn"
        onClick={() => {
          navigator.clipboard?.writeText(text).then(
            () => { setHit(true); setTimeout(() => setHit(false), 1600); },
            () => {}
          );
        }}
      >
        {hit ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy</>}
      </button>
    </div>
  );
}

// ---- route C: the local daemon, in the few controls onboarding needs ----------

interface OllamaStatus {
  installed: boolean;
  running: boolean;
  version: string | null;
  models: { name: string }[];
  totalRamGb: number;
  installCmd: string | null;
  hasBrew: boolean;
}

function LocalPane() {
  const poll = useFetcher<{ status: OllamaStatus; pulls: { model: string; percent: number | null; done: boolean }[] }>();
  const act = useFetcher<{ ok: boolean; msg: string }>();
  const load = useRef(poll.load);
  load.current = poll.load;

  const s = poll.data?.status;
  const pulls = poll.data?.pulls ?? [];
  const pulling = pulls.find((p) => !p.done);
  const busy = act.state !== "idle";

  useEffect(() => { load.current("/api/ollama"); }, []);
  useEffect(() => {
    const t = setInterval(() => load.current("/api/ollama"), pulling || busy ? 1200 : 12000);
    return () => clearInterval(t);
  }, [pulling, busy]);

  const run = (intent: string, model?: string) => {
    const fd = new FormData();
    fd.set("intent", intent);
    if (model) fd.set("model", model);
    act.submit(fd, { method: "post", action: "/api/ollama" });
  };

  // What onboarding should pull: the biggest model that fits this machine's memory.
  // Computed here rather than passed in, because the memory figure only exists once
  // the daemon has answered — the server has no business guessing at it.
  const suggested = s?.totalRamGb ? recommendedModel(s.totalRamGb) : null;
  const pick = suggested?.id;
  const have = (s?.models ?? []).some((m) => !!pick && sameModel(m.name, pick));

  return (
    <>
      <p className="setup-prose">
        Ollama runs an open model on this computer. No account, no key, no per-token cost, and nothing
        you write — résumé, salary history, the notes you keep about your own work — ever leaves the
        machine. The trade is speed and one real limitation: <strong>a local model cannot browse</strong>,
        so it does everything except find new jobs. Step 4 covers what finds jobs without one.
      </p>

      {act.data?.msg && <div className={`notice ${act.data.ok ? "ok" : "err"}`}>{act.data.msg}</div>}

      <div className="stat-grid" style={{ margin: "14px 0" }}>
        <div className="stat"><div className="k">Ollama</div><div className="v">{s ? (s.installed ? "Yes" : "No") : "…"}</div></div>
        <div className="stat"><div className="k">Running</div><div className="v">{s ? (s.running ? "Yes" : "No") : "…"}</div></div>
        <div className="stat"><div className="k">Models</div><div className="v">{s ? s.models.length : "…"}</div></div>
        <div className="stat"><div className="k">Memory</div><div className="v">{s?.totalRamGb ? <>{s.totalRamGb}<small> GB</small></> : "…"}</div></div>
      </div>

      {s && !s.installed && (
        s.installCmd ? (
          <>
            <p className="setup-prose">
              This is the command that will run. {s.hasBrew ? "Homebrew, so nothing is piped into a shell." : "It downloads Ollama's official installer and runs it — read it before you click."}
            </p>
            <CopyLine text={s.installCmd} />
            <button type="button" className="btn" disabled={busy} onClick={() => run("install")}>
              <Download size={13} /> {busy ? "Installing…" : "Install Ollama"}
            </button>
          </>
        ) : (
          <p className="setup-prose">
            On Windows, install it from <a href="https://ollama.com/download" target="_blank" rel="noreferrer">ollama.com/download</a>, then come back to this step.
          </p>
        )
      )}

      {s?.installed && !s.running && (
        <button type="button" className="btn" disabled={busy} onClick={() => run("start")}>
          <Play size={13} /> {busy ? "Starting…" : "Start Ollama"}
        </button>
      )}

      {s?.running && suggested && (
        <div style={{ marginTop: 6 }}>
          <p className="setup-prose">
            With {s.totalRamGb} GB of memory, <strong>{suggested.label} {suggested.params}</strong> is the most
            capable model that comfortably fits — it wants about {suggested.ramGb} GB to run.
          </p>
          {pulling ? (
            <p className="hint">Downloading {pulling.model} — {pulling.percent ?? 0}%. It keeps going if you move on.</p>
          ) : have ? (
            <button type="button" className="btn" disabled={busy} onClick={() => run("use", pick)}>
              <Check size={13} /> Run the Ledger on {suggested.label}
            </button>
          ) : (
            <button type="button" className="btn" disabled={busy} onClick={() => run("pull", pick)}>
              <Download size={13} /> Download {suggested.label} ({suggested.params})
            </button>
          )}
          <p className="hint" style={{ marginTop: 10 }}>
            The full shelf — every size, what each is good at, what fits — is in Settings → Local.
          </p>
        </div>
      )}
    </>
  );
}

// ---- the step -----------------------------------------------------------------

type Route = "cli" | "key" | "local";

export function RunnerChoice({
  runners,
  modelOptions,
  keys,
  defaultRunner,
  models,
  busy,
}: {
  runners: RunnerRow[];
  modelOptions: Record<string, Opt[]>;
  keys: { name: string; label: string; set: boolean }[];
  defaultRunner: string;
  models: Record<string, string>;
  busy: boolean;
}) {
  const avail = runners.filter((r) => r.available);
  const clis = runners.filter((r) => r.kind === "cli");
  const test = useFetcher<{ ok: boolean; msg: string; answer?: string; cost?: number; metered?: boolean }>();

  // Open on the route that is closest to working, so someone who already has an agent
  // is not asked to read about API keys they do not need.
  const [route, setRoute] = useState<Route>(() => {
    if (clis.some((r) => r.available)) return "cli";
    if (keys.some((k) => k.set)) return "key";
    return "cli";
  });

  // The chosen runner drives which model list is shown, so it has to be state.
  const [picked, setPicked] = useState(
    () => defaultRunner || avail.find((r) => r.id === "claude-cli")?.id || avail[0]?.id || ""
  );
  const pickedRunner = runners.find((r) => r.id === picked);
  const opts = modelOptions[picked] || [];
  const [model, setModel] = useState(() => models[picked] || pickedRunner?.defaultModel || "default");

  const choose = (id: string) => {
    setPicked(id);
    const r = runners.find((x) => x.id === id);
    setModel(models[id] || r?.defaultModel || "default");
  };

  const runTest = () => {
    const fd = new FormData();
    fd.set("intent", "test-runner");
    fd.set("runner", picked);
    if (model) fd.set("model", model);
    test.submit(fd, { method: "post", action: "/api/setup" });
  };

  return (
    <>
      <div className="setup-routes">
        {([
          ["cli", "An agent I already have", "Free with a subscription you pay for anyway"],
          ["key", "My own API key", "Paid per token, or free on the right model"],
          ["local", "On this machine", "No account, no cost, nothing leaves the computer"],
        ] as const).map(([id, title, sub]) => (
          <button
            key={id}
            type="button"
            className={`setup-route ${route === id ? "on" : ""}`}
            onClick={() => setRoute(id)}
          >
            <span className="setup-route-t">{title}</span>
            <span className="setup-route-s">{sub}</span>
          </button>
        ))}
      </div>

      {route === "cli" && (
        <>
          <p className="setup-prose">
            If you pay for Claude, ChatGPT, Cursor or Gemini, their command-line agent is part of that
            subscription and the Ledger will use it — no key, no per-token bill. These also reach the live
            web, which is the one thing the job crawl genuinely needs.
          </p>
          <table className="ledger-table">
            <thead><tr><th>Agent</th><th>On this machine</th><th>If it is not</th></tr></thead>
            <tbody>
              {clis.map((r) => {
                const inst = CLI_INSTALL[r.id];
                return (
                  <tr key={r.id}>
                    <td>
                      <strong>{r.label.replace(" (CLI)", "")}</strong>
                      <div className="job-fine">{inst?.note || r.detail}</div>
                    </td>
                    <td>{r.available ? <span className="badge ok">Found</span> : <span className="badge off">Not found</span>}</td>
                    <td>
                      {r.available ? (
                        <span className="job-fine">Nothing to do.</span>
                      ) : inst ? (
                        <>
                          <CopyLine text={inst.cmd} />
                          <a href={inst.docs} target="_blank" rel="noreferrer" className="back-link">
                            {r.label.replace(" (CLI)", "")} install docs →
                          </a>
                        </>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <Form method="post">
            <input type="hidden" name="intent" value="recheck" />
            <button className="ghost-btn" disabled={busy}>
              <RefreshCw size={13} /> {busy ? "Looking…" : "I installed one — look again"}
            </button>
          </Form>
          <p className="hint" style={{ marginTop: 10 }}>
            Installed in a terminal that was already open? The Ledger reads your PATH when it starts, so a
            brand-new install may need <code>npm run ledger restart</code> before it turns up here.
          </p>
        </>
      )}

      {route === "key" && (
        <>
          <p className="setup-prose">
            Keys are encrypted with a key that never leaves this machine, and are only ever sent to the
            provider you picked. Paste one and the runner below turns on.
          </p>
          {keys.map((k) => {
            const r = runners.find((x) => x.needsKey === k.name);
            return (
              <Form method="post" key={k.name} className="setup-key">
                <input type="hidden" name="intent" value="set-key" />
                <input type="hidden" name="name" value={k.name} />
                <div>
                  <div className="setup-key-l">
                    {k.label} {k.set ? <span className="badge ok">saved</span> : null}
                  </div>
                  <div className="job-fine">{KEY_NOTE[k.name]}</div>
                </div>
                <input type="password" name="value" placeholder={k.set ? "•••••••• saved — paste to replace" : "paste key"} autoComplete="off" />
                <button className="ghost-btn" disabled={busy}>Save</button>
                {r?.available ? <span className="badge ok">ready</span> : <span className="badge off">{k.set ? "—" : "unset"}</span>}
              </Form>
            );
          })}
          <p className="hint" style={{ marginTop: 12 }}>
            Not paying for anything? OpenRouter carries free models that run this whole app. Settings →
            OpenRouter lists them with their prices, and marks the few that can browse.
          </p>
        </>
      )}

      {route === "local" && <LocalPane />}

      {/* ---- the choice, and the proof ---- */}
      <div className="setup-pick">
        <h4>Which one should the Ledger use?</h4>
        {avail.length === 0 ? (
          <p className="setup-prose" style={{ margin: 0 }}>
            Nothing is ready yet — install an agent, paste a key, or start Ollama above, and this fills in.
            You can also carry on and set it later; only step 5 needs it.
          </p>
        ) : (
          <Form method="post">
            <input type="hidden" name="intent" value="save-runner" />
            <div className="row2">
              <div className="field">
                <label>Runner</label>
                <Select
                  name="default_runner"
                  value={picked}
                  onChange={choose}
                  options={avail.map((r) => ({ value: r.id, label: r.label }))}
                />
              </div>
              <div className="field">
                <label>Model</label>
                <Select
                  name="model_value"
                  value={model}
                  onChange={setModel}
                  options={opts.length ? opts : [{ value: model || "default", label: model || "Default" }]}
                />
              </div>
            </div>
            {/* the settings key is per runner, so it can only be named once one is picked */}
            <input type="hidden" name="model_key" value={picked ? `model_${picked}` : ""} />
            <p className="hint" style={{ margin: "0 0 12px" }}>
              {pickedRunner?.web
                ? "This one reaches the live web, so step 5 can research employers directly."
                : "This one cannot browse. Everything else works; step 5 reads the free job boards instead."}
            </p>
            <div className="setup-actions">
              <button className="btn" disabled={busy}>Use this one</button>
              <button
                type="button"
                className="ghost-btn"
                disabled={test.state !== "idle" || !picked}
                onClick={runTest}
              >
                <Zap size={13} /> {test.state !== "idle" ? "Asking it…" : "Test it"}
              </button>
            </div>
          </Form>
        )}

        {test.data && (
          <div className={`notice ${test.data.ok ? "ok" : "err"}`} style={{ marginBottom: 0 }}>
            <strong>{test.data.msg}</strong>
            {test.data.answer && (
              <div className="setup-answer">
                <TerminalSquare size={13} /> <span>{test.data.answer}</span>
              </div>
            )}
            {test.data.ok && (
              <div className="job-fine" style={{ marginTop: 6 }}>
                {test.data.metered
                  ? `That call cost $${(test.data.cost || 0).toFixed(5)}. Every call is priced and logged on the Usage page.`
                  : "No per-token charge — this runner is on a subscription or runs locally."}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
