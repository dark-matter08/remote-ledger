// Settings → Search. Give a model that cannot browse a way to work from live pages.
//
// SearXNG runs here as a plain local process — no Docker, no account, no key. It asks
// the public engines on your behalf and returns JSON, which is the piece that lets the
// app do the searching and hand the model only text we actually fetched.
import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { Download, Play, RefreshCw, Search, Square, Trash2 } from "lucide-react";

interface Status {
  installed: boolean;
  running: boolean;
  port: number;
  url: string;
  home: string;
  pid: number | null;
  jsonEnabled: boolean;
  hasUv: boolean;
  hasGit: boolean;
  python: string | null;
  pythonVersion: string | null;
  pythonTooNew: boolean;
  pythonInstall: string | null;
  canInstall: boolean;
  version: string | null;
}
interface Step { step: string; ok: boolean; output?: string }
interface Feed {
  status: Status;
  provider: string;
  searxngUrl: string;
  available: boolean;
  why: string;
  install: { running: boolean; steps: Step[]; ok: boolean | null } | null;
  log: string;
}
interface Result { title: string; url: string; snippet: string; engine?: string }

const PROVIDERS = [
  { id: "searxng", label: "SearXNG", hint: "Open source, runs on this machine, no key. Asks the public engines for you." },
  { id: "brave", label: "Brave API", hint: "2,000 queries a month free. One key, nothing to run." },
  { id: "tavily", label: "Tavily", hint: "Returns cleaned page text rather than links. One key, nothing to run." },
  { id: "none", label: "Off", hint: "No web search. The crawl still reads the job boards directly." },
];

export function SearchSetup() {
  const poll = useFetcher<Feed>();
  const act = useFetcher<{ ok: boolean; msg: string; results?: Result[]; intent?: string }>();
  const [q, setQ] = useState("remote typescript engineer");
  const [key, setKey] = useState("");
  const [url, setUrl] = useState("");

  const d = poll.data;
  const s = d?.status;
  const busy = act.state !== "idle";
  const installing = !!d?.install?.running;

  const load = useRef(poll.load);
  load.current = poll.load;
  useEffect(() => { load.current("/api/search"); }, []);
  useEffect(() => {
    const t = setInterval(() => load.current("/api/search"), installing || busy ? 1500 : 15000);
    return () => clearInterval(t);
  }, [installing, busy]);

  const run = (intent: string, fields: Record<string, string> = {}) => {
    const fd = new FormData();
    fd.set("intent", intent);
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    act.submit(fd, { method: "post", action: "/api/search" });
  };

  const provider = d?.provider ?? "none";

  return (
    <>
      {act.data?.msg && <div className={`notice ${act.data.ok ? "ok" : ""}`}>{act.data.msg}</div>}

      <div className="panel">
        <h3>Web search</h3>
        <p className="hint">
          A local model has no internet. This gives it one that is honest: <strong>the app does the
          searching and the fetching</strong>, and the model only ever sees pages we actually
          retrieved — so a posting is real because it was downloaded, not because a model recalled it.
        </p>

        <div className="toolbar" style={{ gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
          {PROVIDERS.map((p) => (
            <button
              key={p.id}
              type="button"
              title={p.hint}
              className={`chip ${provider === p.id ? "on" : ""}`}
              disabled={busy}
              onClick={() => run("provider", { provider: p.id })}
            >
              {p.label}
            </button>
          ))}
        </div>
        <p className="hint">{PROVIDERS.find((p) => p.id === provider)?.hint}</p>

        {d && (
          <div className={`notice ${d.available ? "ok" : ""}`} style={{ marginTop: 12 }}>
            {d.available ? "Search is working." : d.why || "Search is not configured."}
          </div>
        )}
      </div>

      {provider === "searxng" && (
        <div className="panel">
          <h3>SearXNG, on this machine</h3>
          <div className="stat-grid">
            <div className="stat">
              <div className="k">Installed</div>
              <div className="v">{s ? (s.installed ? "Yes" : "No") : "…"}</div>
            </div>
            <div className="stat">
              <div className="k">Process</div>
              <div className="v">{s ? (s.running ? "Running" : "Stopped") : "…"}</div>
            </div>
            <div className="stat">
              <div className="k">Port</div>
              <div className="v">{s?.port ?? "…"}</div>
            </div>
            <div className="stat">
              <div className="k">JSON API</div>
              <div className="v">{s ? (s.jsonEnabled ? "On" : "Off") : "…"}</div>
            </div>
          </div>

          {s && !s.installed && (
            <>
              <p className="hint">
                Installs to <code>{s.home}</code> — a shallow clone and an isolated Python
                environment, roughly 300 MB. No Docker, nothing system-wide, and nothing that starts
                without you.
              </p>
              <p className="hint">
                {s.hasUv
                  ? "uv is installed, so this pins its own Python 3.12 and takes about a minute."
                  : s.python
                    ? `Using ${s.python}${s.pythonVersion ? ` (Python ${s.pythonVersion})` : ""} with a virtualenv.${
                        s.pythonTooNew
                          ? " That is newer than SearXNG pins for, so the install may fail on a missing wheel. You can try it anyway, or install uv and it will fetch its own Python 3.12:"
                          : " Installing uv would make this faster."
                      }`
                    : "No Python found. Install uv and it will fetch its own Python 3.12:"}
                {!s.hasGit && " git is required and was not found."}
              </p>
              {/* the command for THIS machine — Homebrew is not an instruction you can follow on Linux */}
              {s.pythonInstall && <pre className="jd-rendered" style={{ padding: 10, marginTop: -4 }}>{s.pythonInstall}</pre>}
              <button className="btn" disabled={busy || installing || !s.canInstall} onClick={() => run("install")}>
                <Download size={13} /> {installing ? "Installing…" : "Install SearXNG"}
              </button>
            </>
          )}

          {!!d?.install?.steps?.length && (
            <div style={{ marginTop: 12 }}>
              {d.install.steps.map((st, i) => (
                <div key={i} className="job-fine" style={{ color: st.ok ? "var(--green)" : "var(--vermillion)" }}>
                  {st.ok ? "✓" : "✗"} {st.step}
                  {!st.ok && st.output && (
                    <pre className="jd-rendered" style={{ padding: 10, marginTop: 6, maxHeight: 200, overflow: "auto" }}>
                      {st.output}
                    </pre>
                  )}
                </div>
              ))}
              {installing && <div className="job-fine">working…</div>}
            </div>
          )}

          {s?.installed && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
              {s.running ? (
                <button className="ghost-btn" disabled={busy} onClick={() => run("stop")}>
                  <Square size={13} /> Stop
                </button>
              ) : (
                <button className="btn" disabled={busy} onClick={() => run("start")}>
                  <Play size={13} /> Start
                </button>
              )}
              <button className="ghost-btn" disabled={busy} onClick={() => run("install")}>
                <RefreshCw size={13} /> Update
              </button>
              <button className="ghost-btn" disabled={busy} onClick={() => run("remove")}>
                <Trash2 size={13} /> Remove
              </button>
              <span className="hint" style={{ alignSelf: "center" }}>
                {s.running && s.pid ? `pid ${s.pid} · ` : ""}
                {s.url}
              </span>
            </div>
          )}

          {s?.installed && !s.jsonEnabled && (
            <p className="hint" style={{ color: "var(--vermillion)", marginTop: 10 }}>
              JSON output is off in settings.yml, so the API will answer 403. Re-run Update to rewrite it.
            </p>
          )}

          {!!d?.log && (
            <details style={{ marginTop: 12 }}>
              <summary className="hint">Why it is not running</summary>
              <pre className="jd-rendered" style={{ padding: 10, maxHeight: 220, overflow: "auto" }}>{d.log}</pre>
            </details>
          )}

          <div className="field" style={{ marginTop: 16 }}>
            <label>Or point at an instance you already run</label>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                type="text"
                placeholder={s?.url || "http://127.0.0.1:8899"}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
              <button className="ghost-btn" style={{ whiteSpace: "nowrap" }} disabled={busy} onClick={() => run("url", { url })}>
                Save
              </button>
            </div>
            <p className="hint">
              Any SearXNG with <code>json</code> in <code>search.formats</code>. Leave blank to use the one above.
            </p>
          </div>
        </div>
      )}

      {(provider === "brave" || provider === "tavily") && (
        <div className="panel">
          <h3>{provider === "brave" ? "Brave Search" : "Tavily"} key</h3>
          <div className="field">
            <div style={{ display: "flex", gap: 8 }}>
              <input type="password" placeholder="paste the key" value={key} onChange={(e) => setKey(e.target.value)} />
              <button
                className="ghost-btn"
                style={{ whiteSpace: "nowrap" }}
                disabled={busy || !key.trim()}
                onClick={() => { run("key", { name: `${provider}_api_key`, value: key.trim() }); setKey(""); }}
              >
                Save
              </button>
            </div>
            <p className="hint">Stored encrypted on this machine, like every other key here.</p>
          </div>
        </div>
      )}

      {provider !== "none" && (
        <div className="panel">
          <h3>Try it</h3>
          <div className="field">
            <div style={{ display: "flex", gap: 8 }}>
              <input type="text" value={q} onChange={(e) => setQ(e.target.value)} />
              <button className="btn" style={{ whiteSpace: "nowrap" }} disabled={busy} onClick={() => run("test", { q })}>
                <Search size={13} /> Search
              </button>
            </div>
          </div>
          {!!act.data?.results?.length && (
            <table className="ledger-table">
              <thead><tr><th>Result</th><th style={{ width: 120 }}>Engine</th></tr></thead>
              <tbody>
                {act.data.results.map((r) => (
                  <tr key={r.url}>
                    <td>
                      <a href={r.url} target="_blank" rel="noreferrer">{r.title}</a>
                      <div className="job-fine">{r.url}</div>
                      <div className="job-fine">{r.snippet}</div>
                    </td>
                    <td className="job-fine">{r.engine || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </>
  );
}
