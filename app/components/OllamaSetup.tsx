// Settings → Local. Install Ollama, start it, pull weights, and point the Ledger at
// them — without leaving the app or reading a single doc page.
//
// This is the only runner the Ledger can set up for you end to end, because it is the
// only one with nothing to sign up for. Everything here is explicit: the install
// command is printed before it can be run, and nothing is pulled without a click.
import { useEffect, useMemo, useState } from "react";
import { useFetcher } from "react-router";
import { Check, Download, HardDrive, Play, RefreshCw, Trash2, Zap } from "lucide-react";
import {
  CAPABILITY_BLURB,
  CAPABILITY_LABEL,
  OLLAMA_MODELS,
  type OllamaCapability,
  fitsInRam,
  prettyBytes,
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

export function OllamaSetup({ currentModel }: { currentModel: string }) {
  const poll = useFetcher<{ status: Status; pulls: Pull[] }>();
  const act = useFetcher<{ ok: boolean; msg: string; output?: string }>();
  const [caps, setCaps] = useState<Set<OllamaCapability>>(new Set());
  const [custom, setCustom] = useState("");
  const [showAll, setShowAll] = useState(false);

  const status = poll.data?.status;
  const pulls = poll.data?.pulls ?? [];
  const busy = act.state !== "idle";
  const pulling = pulls.some((p) => !p.done);

  // Poll while something is moving. A pull runs for minutes, and Ollama keeps going
  // whether or not this tab is open, so the interval only drives the display.
  useEffect(() => {
    if (poll.state === "idle" && !poll.data) poll.load("/api/ollama");
  }, [poll]);
  useEffect(() => {
    const every = pulling || busy ? 1000 : 10000;
    const t = setInterval(() => poll.load("/api/ollama"), every);
    return () => clearInterval(t);
  }, [pulling, busy, poll]);

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
                On Windows, install it from <a href="https://ollama.com/download" target="_blank" rel="noreferrer">ollama.com/download</a>, then come back.
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
              <th style={{ width: "34%" }}>Good for</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {shelf.map((m) => {
              const here = isInstalled(m.id);
              const p = pullOf(m.id);
              const inUse = sameModel(currentModel, m.id);
              const tooBig = status?.totalRamGb ? !fitsInRam(m, status.totalRamGb) : false;
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
                  <td>
                    {p ? (
                      <div style={{ minWidth: 150 }}>
                        <div className="meter-row">
                          <div className="meter"><div className="fill" style={{ width: `${p.percent ?? 0}%` }} /></div>
                          <span className="meter-val">{p.percent === null ? "…" : `${p.percent}%`}</span>
                        </div>
                        <div className="job-fine">
                          {p.status}
                          {p.total > 0 && <> · {prettyBytes(p.completed)} / {prettyBytes(p.total)}</>}
                        </div>
                      </div>
                    ) : here ? (
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
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
              disabled={busy || !custom.trim() || !status?.installed}
              onClick={() => { run("pull", custom.trim()); setCustom(""); }}
            >
              <Download size={13} /> Pull
            </button>
          </div>
          <p className="hint">The shelf above is a starting point, not the whole library.</p>
        </div>
      </div>

      {/* ---- what is actually on disk ---- */}
      {!!status?.models.length && (
        <div className="panel">
          <h3><HardDrive size={15} /> On this machine</h3>
          <table className="ledger-table">
            <thead><tr><th>Model</th><th>Size</th><th></th></tr></thead>
            <tbody>
              {status.models.map((m) => (
                <tr key={m.name}>
                  <td>
                    {m.name}
                    {sameModel(currentModel, m.name) && <> <span className="badge on">In use</span></>}
                  </td>
                  <td className="num">{prettyBytes(m.sizeBytes)}</td>
                  <td>
                    <div style={{ display: "flex", gap: 6 }}>
                      {!sameModel(currentModel, m.name) && (
                        <button className="btn" disabled={busy} onClick={() => run("use", m.name)}>Use</button>
                      )}
                      <button className="ghost-btn" disabled={busy} onClick={() => run("test", m.name)}>Test</button>
                      <button className="ghost-btn" disabled={busy} onClick={() => run("remove", m.name)}>
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint">
            Weights live in <code>~/.ollama/models</code>. Removing one here frees that disk immediately.
          </p>
        </div>
      )}

      {pulls.some((p) => p.error) && (
        <div className="panel">
          <h3>Failed pulls</h3>
          {pulls.filter((p) => p.error).map((p) => (
            <p key={p.model} className="hint"><strong>{p.model}</strong> — {p.error}</p>
          ))}
        </div>
      )}
    </>
  );
}
