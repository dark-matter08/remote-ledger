// Settings → Local. Install Ollama, start it, pull weights, and point the Ledger at
// them — without leaving the app or reading a single doc page.
//
// This is the only runner the Ledger can set up for you end to end, because it is the
// only one with nothing to sign up for. Everything here is explicit: the install
// command is printed before it can be run, and nothing is pulled without a click.
import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { Check, Download, HardDrive, Play, RefreshCw, Trash2, Zap } from "lucide-react";
import {
  CAPABILITY_BLURB,
  CAPABILITY_LABEL,
  OLLAMA_MODELS,
  type OllamaCapability,
  fitsInRam,
  prettyBytes,
  pullPhase,
  recommendedModel,
  sameModel,
} from "../ollama";

interface Status {
  installed: boolean;
  binPath: string | null;
  version: string | null;
  running: boolean;
  models: { name: string; sizeBytes: number; modified: string }[];
  totalRamGb: number;
  platform: string;
  installCmd: string | null;
  hasBrew: boolean;
}

interface ActResult {
  ok: boolean;
  msg: string;
  intent?: string;
  model?: string;
  output?: string;
}

interface Pull {
  model: string;
  status: string;
  percent: number | null;
  completed: number;
  total: number;
  done: boolean;
  error?: string;
}

const CAPS: OllamaCapability[] = ["tools", "vision", "reasoning", "code", "embedding"];

/**
 * Ollama's pull errors in words that say what to do. "pull model manifest: file does
 * not exist" is what it says for a tag it has never heard of — which is nearly always
 * a typo, and the fix is to check the library page.
 */
function explainPull(error: string, model: string): string {
  const base = model.split(":")[0];
  if (/manifest.*does not exist|not found/i.test(error))
    return `no model with that tag on ollama.com. Check the exact name and size at ollama.com/library/${base} — tags look like qwen3:32b, not qwen-3.8:27b.`;
  if (/no space|disk/i.test(error)) return `not enough disk for it (${error}).`;
  if (/connection|ECONNREFUSED|fetch failed/i.test(error)) return "Ollama stopped answering while pulling — start it again and pull once more; it resumes where it left off.";
  return error;
}

export function OllamaSetup({ currentModel }: { currentModel: string }) {
  const poll = useFetcher<{ status: Status; pulls: Pull[] }>();
  const act = useFetcher<ActResult>();
  const [caps, setCaps] = useState<Set<OllamaCapability>>(new Set());
  const [custom, setCustom] = useState("");
  const [showAll, setShowAll] = useState(false);

  const status = poll.data?.status;
  const pulls = poll.data?.pulls ?? [];
  const busy = act.state !== "idle";
  const pulling = pulls.some((p) => !p.done);

  // Which row is mid-action, and which row the last answer belongs to. Without this
  // the only feedback was a notice at the top of the tab — and the table is well below
  // the fold, so pressing Test looked like it did nothing at all.
  const inFlight = busy
    ? { intent: String(act.formData?.get("intent") || ""), model: String(act.formData?.get("model") || "") }
    : null;
  const VERB: Record<string, string> = {
    test: "Testing",
    pull: "Starting",
    remove: "Removing",
    use: "Switching",
  };
  // Clear the box once the pull is under way, not on the click: text vanishing the
  // instant a button is pressed, with nothing else changing, reads as a glitch.
  useEffect(() => {
    if (!busy && act.data?.intent === "pull" && act.data.ok && lastCustom && sameModel(String(act.data.model || ""), lastCustom)) setCustom("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, act.data]);

  const rowState = (id: string) => {
    if (inFlight && inFlight.model && sameModel(inFlight.model, id))
      return { pending: `${VERB[inFlight.intent] ?? "Working"}…` };
    if (!busy && act.data?.model && sameModel(act.data.model, id) && act.data.intent !== "pull")
      return { result: act.data };
    return {};
  };

  // Poll while something is moving. A pull runs for minutes, and Ollama keeps going
  // whether or not this tab is open, so the interval only drives the display.
  // The fetcher is a new object on every state change, so holding it in the deps
  // below tore the interval down and rebuilt it on each poll — the timer kept being
  // reset before it could fire. Reach for it through a ref and depend only on the
  // things that should actually change the cadence.
  const load = useRef(poll.load);
  load.current = poll.load;
  useEffect(() => {
    load.current("/api/ollama");
  }, []);
  useEffect(() => {
    const every = pulling || busy ? 1000 : 10000;
    const t = setInterval(() => load.current("/api/ollama"), every);
    return () => clearInterval(t);
  }, [pulling, busy]);
  // The moment an action answers, ask again. A pull that fails in under a second —
  // a tag that does not exist — used to sit unseen for up to ten seconds, because the
  // slow cadence was still in force and nothing on the page had a reason to refresh.
  useEffect(() => {
    if (!busy && act.data) load.current("/api/ollama");
  }, [busy, act.data]);

  // Pulls of names that are not on the shelf. A shelf row shows its own progress; a
  // pasted name had no row, so a custom pull showed nothing while it ran and its
  // failure landed in a panel at the foot of the page. It is shown under the box.
  const customPulls = pulls.filter((p) => !OLLAMA_MODELS.some((m) => sameModel(m.id, p.model)));
  const [lastCustom, setLastCustom] = useState<string | null>(null);
  // the one just asked for; else whichever is running; else the most recent (the
  // server lists them newest first)
  const customLine = customPulls.find((p) => lastCustom && sameModel(p.model, lastCustom)) ?? customPulls.find((p) => !p.done) ?? customPulls[0];

  const installedNames = useMemo(() => (status?.models ?? []).map((m) => m.name), [status]);
  const isInstalled = (id: string) => installedNames.some((n) => sameModel(n, id));
  const pullOf = (id: string) => pulls.find((p) => sameModel(p.model, id) && !p.done);

  const shelf = useMemo(() => {
    const list = OLLAMA_MODELS.filter((m) => caps.size === 0 || m.caps.some((c) => caps.has(c)));
    if (showAll || !status?.totalRamGb) return list;
    return list.filter((m) => fitsInRam(m, status.totalRamGb) || isInstalled(m.id));
  }, [caps, showAll, status, installedNames]);

  const suggested = status?.totalRamGb ? recommendedModel(status.totalRamGb) : null;

  const run = (intent: string, model?: string) => {
    const fd = new FormData();
    fd.set("intent", intent);
    if (model) fd.set("model", model);
    act.submit(fd, { method: "post", action: "/api/ollama" });
  };

  return (
    <>
      {act.data?.msg && <div className={`notice ${act.data.ok ? "ok" : ""}`}>{act.data.msg}</div>}

      {/* ---- where things stand ---- */}
      <div className="panel">
        <h3>Run the Ledger on your own machine</h3>
        <p className="hint">
          Ollama serves open models locally. No key, no account, no per-token cost, and nothing you
          write ever leaves this computer — which for a résumé and a salary history is the whole point.
        </p>

        <div className="stat-grid">
          <div className="stat">
            <div className="k">Ollama</div>
            <div className="v">
              {status ? (status.installed ? <>Installed <small>{status.version || ""}</small></> : "Not found") : "…"}
            </div>
          </div>
          <div className="stat">
            <div className="k">Daemon</div>
            <div className="v">{status ? (status.running ? "Running" : "Stopped") : "…"}</div>
          </div>
          <div className="stat">
            <div className="k">Models</div>
            <div className="v">{status ? status.models.length : "…"}</div>
          </div>
          <div className="stat">
            <div className="k">Memory</div>
            <div className="v">{status?.totalRamGb ? <>{status.totalRamGb}<small> GB</small></> : "…"}</div>
          </div>
        </div>

        {status && !status.installed && (
          <>
            {status.installCmd ? (
              <>
                <p className="hint" style={{ marginTop: 12 }}>
                  This is the command that will run. {status.hasBrew
                    ? "Homebrew, so nothing is piped into a shell."
                    : "It downloads Ollama's official installer and runs it — read it before you click."}
                </p>
                <pre className="jd-rendered" style={{ padding: 12, marginBottom: 12 }}>{status.installCmd}</pre>
                <button className="btn" disabled={busy} onClick={() => run("install")}>
                  <Download size={13} /> {busy ? "Installing…" : "Install Ollama"}
                </button>
              </>
            ) : (
              <p className="hint" style={{ marginTop: 12 }}>
                Nothing here can install it for you. Get it from{" "}
                <a href="https://ollama.com/download" target="_blank" rel="noreferrer">ollama.com/download</a>, then come back.
              </p>
            )}
          </>
        )}

        {status?.installed && !status.running && (
          <div style={{ marginTop: 12 }}>
            <button className="btn" disabled={busy} onClick={() => run("start")}>
              <Play size={13} /> {busy ? "Starting…" : "Start Ollama"}
            </button>
            <span className="hint" style={{ marginLeft: 12 }}>Installed at {status.binPath}</span>
          </div>
        )}

        {status?.running && suggested && !isInstalled(suggested.id) && (
          <p className="hint" style={{ marginTop: 12 }}>
            With {status.totalRamGb} GB, <strong>{suggested.label} {suggested.params}</strong> is the
            most capable model that comfortably fits.
          </p>
        )}

        {act.data?.output && (
          <details style={{ marginTop: 12 }}>
            <summary className="hint">Installer output</summary>
            <pre className="jd-rendered" style={{ padding: 12, maxHeight: 240, overflow: "auto" }}>{act.data.output}</pre>
          </details>
        )}
      </div>

      {/* ---- the honest bit ---- */}
      <div className="panel">
        <h3>What a local model can and cannot do here</h3>
        <p className="hint">
          Everything downstream of the crawl runs fine locally: scoring a posting, tailoring the
          résumé, drafting a cover letter, interview prep. <strong>Finding new jobs does not.</strong>{" "}
          A local model has no internet — <em>Tools</em> below means it can emit structured function
          calls, not that it can browse. Keep a CLI runner or a web-capable API as your crawl runner
          and let Ollama do the rest, which is where nearly all the tokens go anyway.
        </p>
      </div>

      {/* ---- the shelf ---- */}
      <div className="panel">
        <h3>Models</h3>
        <div className="toolbar" style={{ gap: 8, flexWrap: "wrap" }}>
          {CAPS.map((c) => (
            <button
              key={c}
              type="button"
              title={CAPABILITY_BLURB[c]}
              className={`chip ${caps.has(c) ? "on" : ""}`}
              onClick={() =>
                setCaps((prev) => {
                  const next = new Set(prev);
                  next.has(c) ? next.delete(c) : next.add(c);
                  return next;
                })
              }
            >
              {CAPABILITY_LABEL[c]}
            </button>
          ))}
          <button type="button" className={`chip ${showAll ? "on" : ""}`} onClick={() => setShowAll((v) => !v)}>
            {showAll ? "All sizes" : `Fits ${status?.totalRamGb ?? "?"} GB`}
          </button>
          <button type="button" className="ghost-btn" onClick={() => poll.load("/api/ollama")}>
            <RefreshCw size={13} /> Refresh
          </button>
        </div>

        <table className="ledger-table">
          <thead>
            <tr>
              <th>Model</th>
              <th>Size</th>
              <th>Can do</th>
              <th style={{ width: "32%" }}>Good for</th>
              {/* fixed, so a row switching from a button to a progress meter does not
                  resize every other column in the table */}
              <th style={{ width: 210 }}></th>
            </tr>
          </thead>
          <tbody>
            {shelf.map((m) => {
              const here = isInstalled(m.id);
              const p = pullOf(m.id);
              const inUse = sameModel(currentModel, m.id);
              const tooBig = status?.totalRamGb ? !fitsInRam(m, status.totalRamGb) : false;
              const row = rowState(m.id);
              return (
                <tr key={m.id}>
                  <td>
                    <strong>{m.label}</strong> <span className="job-fine">{m.params}</span>
                    {inUse && <> <span className="badge on">In use</span></>}
                    {suggested?.id === m.id && !here && <> <span className="badge ok">Suggested</span></>}
                    <div className="job-fine">{m.id}</div>
                  </td>
                  <td className="num">
                    {m.sizeGb} GB
                    <div className="job-fine" style={{ color: tooBig ? "var(--vermillion)" : undefined }}>
                      {m.ramGb} GB RAM{tooBig ? " — tight here" : ""}
                    </div>
                  </td>
                  <td>
                    {m.caps.map((c) => (
                      <span key={c} className="kb-tag" title={CAPABILITY_BLURB[c]}>{CAPABILITY_LABEL[c]}</span>
                    ))}
                  </td>
                  <td className="job-fine">{m.blurb}</td>
                  <td style={{ textAlign: "right" }}>
                    {row.pending ? (
                      <span className="job-fine">{row.pending}</span>
                    ) : p ? (
                      <div>
                        <div className="meter-row" style={{ marginTop: 0 }}>
                          <div className="meter">
                            <div className="fill live" style={{ ["--target" as any]: `${p.percent ?? 0}%` }} />
                          </div>
                          <span className="meter-val">{p.percent === null ? "…" : `${p.percent}%`}</span>
                        </div>
                        <div className="job-fine">
                          {pullPhase(p.status)}
                          {p.total > 0 && <> · {prettyBytes(p.completed)} / {prettyBytes(p.total)}</>}
                        </div>
                      </div>
                    ) : here ? (
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                        {!inUse && !m.caps.includes("embedding") && (
                          <button className="btn" disabled={busy} onClick={() => run("use", m.id)}>
                            <Check size={13} /> Use
                          </button>
                        )}
                        <button className="ghost-btn" disabled={busy} onClick={() => run("test", m.id)}>
                          <Zap size={13} /> Test
                        </button>
                        <button className="ghost-btn" disabled={busy} onClick={() => run("remove", m.id)}>
                          <Trash2 size={13} />
                        </button>
                      </div>
                    ) : (
                      <button
                        className="ghost-btn"
                        disabled={busy || !status?.installed}
                        title={!status?.installed ? "Install Ollama first" : `ollama pull ${m.id}`}
                        onClick={() => run("pull", m.id)}
                      >
                        <Download size={13} /> Pull
                      </button>
                    )}
                    {row.result && (
                      <div
                        className="job-fine"
                        style={{ marginTop: 6, color: row.result.ok ? "var(--green)" : "var(--vermillion)" }}
                      >
                        {row.result.msg}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <div className="field" style={{ marginTop: 16 }}>
          <label>Pull something else</label>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="text"
              value={custom}
              placeholder="e.g. gemma3:4b — any tag from ollama.com/library"
              onChange={(e) => setCustom(e.target.value)}
            />
            <button
              className="ghost-btn"
              style={{ whiteSpace: "nowrap" }}
              disabled={busy || !custom.trim() || !status?.installed}
              onClick={() => { setLastCustom(custom.trim()); run("pull", custom.trim()); }}
            >
              <Download size={13} /> Pull
            </button>
          </div>
          {inFlight?.intent === "pull" && lastCustom && sameModel(inFlight.model, lastCustom) && (
            <p className="job-fine" style={{ marginTop: 8 }}>Starting…</p>
          )}
          {customLine && !customLine.error && !customLine.done && (
            <div style={{ marginTop: 8 }}>
              <div className="meter-row" style={{ marginTop: 0 }}>
                <div className="meter">
                  <div className="fill live" style={{ ["--target" as any]: `${customLine.percent ?? 0}%` }} />
                </div>
                <span className="meter-val">{customLine.percent === null ? "…" : `${customLine.percent}%`}</span>
              </div>
              <div className="job-fine">
                <strong>{customLine.model}</strong> · {pullPhase(customLine.status)}
                {customLine.total > 0 && <> · {prettyBytes(customLine.completed)} / {prettyBytes(customLine.total)}</>}
              </div>
            </div>
          )}
          {customLine?.done && !customLine.error && (
            <p className="job-fine" style={{ marginTop: 8, color: "var(--green)" }}>
              <strong>{customLine.model}</strong> is on disk — it is in the list below.
            </p>
          )}
          {customLine?.error && (
            <p className="job-fine" style={{ marginTop: 8, color: "var(--vermillion)" }}>
              <strong>{customLine.model}</strong> — {explainPull(customLine.error, customLine.model)}
            </p>
          )}
          <p className="hint">The shelf above is a starting point, not the whole library.</p>
        </div>
      </div>

      {/* ---- what is actually on disk ---- */}
      {!!status?.models.length && (
        <div className="panel">
          <h3><HardDrive size={15} /> On this machine</h3>
          <table className="ledger-table">
            <thead><tr><th>Model</th><th>Size</th><th style={{ width: 210 }}></th></tr></thead>
            <tbody>
              {status.models.map((m) => {
                const row = rowState(m.name);
                return (
                <tr key={m.name}>
                  <td>
                    {m.name}
                    {sameModel(currentModel, m.name) && <> <span className="badge on">In use</span></>}
                  </td>
                  <td className="num">{prettyBytes(m.sizeBytes)}</td>
                  <td style={{ textAlign: "right" }}>
                    {row.pending ? (
                      <span className="job-fine">{row.pending}</span>
                    ) : (
                      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                        {!sameModel(currentModel, m.name) && (
                          <button className="btn" disabled={busy} onClick={() => run("use", m.name)}>Use</button>
                        )}
                        <button className="ghost-btn" disabled={busy} onClick={() => run("test", m.name)}>Test</button>
                        <button className="ghost-btn" disabled={busy} onClick={() => run("remove", m.name)}>
                          <Trash2 size={13} />
                        </button>
                      </div>
                    )}
                    {row.result && (
                      <div
                        className="job-fine"
                        style={{ marginTop: 6, color: row.result.ok ? "var(--green)" : "var(--vermillion)" }}
                      >
                        {row.result.msg}
                      </div>
                    )}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
          <p className="hint">
            Weights live in <code>~/.ollama/models</code>. Removing one here frees that disk immediately.
          </p>
        </div>
      )}

      {/* shelf rows only show progress, so their failures are collected here; a custom
          pull already says so under its own box */}
      {pulls.some((p) => p.error && !customPulls.includes(p)) && (
        <div className="panel">
          <h3>Failed pulls</h3>
          {pulls.filter((p) => p.error && !customPulls.includes(p)).map((p) => (
            <p key={p.model} className="hint"><strong>{p.model}</strong> — {p.error}</p>
          ))}
        </div>
      )}
    </>
  );
}
