import { useState } from "react";
import { Form, Link } from "react-router";
import { AlertTriangle, Archive, RotateCcw } from "lucide-react";

// Settings → Danger zone. Clear the ledger and start over.
//
// The gate is a typed phrase rather than a modal, and deliberately so: a modal asks
// you to click again, which is the same reflex that got you here. Typing ERASE is a
// different action from clicking, and it is the only one in the app that cannot be
// done by muscle memory.
//
// Nothing about this hides the cost. Each scope shows its live count before it is
// ticked, the backup path is stated up front, and the button says how many rows are
// about to go.

export interface ScopePreview {
  id: string;
  label: string;
  what: string;
  caution?: string;
  count: number;
  countLabel: string;
}

const PHRASE = "ERASE";

export function DangerZone({
  scopes,
  backups,
  busy,
}: {
  scopes: ScopePreview[];
  backups: { path: string; at: string; bytes: number }[];
  busy: boolean;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [typed, setTyped] = useState("");

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const all = picked.size === scopes.length;
  const armed = picked.size > 0 && typed.trim().toUpperCase() === PHRASE;

  // Deliberately not a row total. The counts beside each section are in their own
  // units — 138 jobs, 10 résumés — and adding them produces a number that matches
  // neither what you ticked nor what the app reports afterwards, which for the one
  // button in here that cannot be undone is the wrong kind of approximate.
  const chosen = scopes.filter((s) => picked.has(s.id));
  const buttonLabel = all
    ? "Clear everything"
    : chosen.length === 1
      ? `Clear ${chosen[0].label.toLowerCase()}`
      : `Clear ${chosen.length} sections`;

  return (
    <>
      <div className="panel danger-panel">
        <h3><AlertTriangle size={16} /> Clear the ledger and start over</h3>
        <p className="hint">
          Everything below lives in one file on this machine. There is no server copy, and nothing here is
          recoverable except from the backup this takes first.
        </p>

        <p className="setup-prose">
          A copy of the whole database is written to <code>data/backups/</code> before a single row is
          deleted — automatically, with no way to switch it off. That is the only reason this button is
          safe to offer, so it is worth knowing it is there before you use it.
        </p>

        <Form method="post">
          <input type="hidden" name="intent" value="reset" />
          <div className="danger-list">
            {scopes.map((s) => (
              <label key={s.id} className={`danger-row ${picked.has(s.id) ? "on" : ""}`}>
                <input
                  type="checkbox"
                  name="scope"
                  value={s.id}
                  checked={picked.has(s.id)}
                  onChange={() => toggle(s.id)}
                />
                <div>
                  <div className="danger-row-h">
                    <strong>{s.label}</strong>
                    <span className={`badge ${s.count ? "warn" : "off"}`}>
                      {s.count.toLocaleString()} {s.countLabel}
                    </span>
                  </div>
                  <div className="danger-row-w">{s.what}</div>
                  {s.caution && <div className="danger-row-c">{s.caution}</div>}
                </div>
              </label>
            ))}
          </div>

          <div className="danger-all">
            <button
              type="button"
              className="ghost-btn"
              onClick={() => setPicked(all ? new Set() : new Set(scopes.map((s) => s.id)))}
            >
              <RotateCcw size={13} /> {all ? "Tick nothing" : "Everything — a factory-fresh Ledger"}
            </button>
            <span className="hint" style={{ margin: 0 }}>
              {all
                ? "This is a brand-new install. You land back on the opening wizard."
                : picked.size
                  ? `${picked.size} of ${scopes.length} sections selected.`
                  : "Nothing selected."}
            </span>
          </div>

          <div className="danger-gate">
            <div className="field" style={{ margin: 0, maxWidth: 260 }}>
              <label>Type {PHRASE} to unlock</label>
              <input
                type="text"
                value={typed}
                autoComplete="off"
                spellCheck={false}
                placeholder={PHRASE}
                onChange={(e) => setTyped(e.target.value)}
              />
            </div>
            <button className="btn danger" disabled={!armed || busy}>
              {busy ? "Clearing…" : picked.size ? buttonLabel : "Clear"}
            </button>
          </div>
          {picked.size > 0 && !armed && (
            <p className="hint" style={{ marginTop: 10 }}>The button unlocks once the box says {PHRASE}.</p>
          )}
        </Form>
      </div>

      <div className="panel">
        <h3><Archive size={15} /> Backups on this machine <span className="badge ok">{backups.length}</span></h3>
        <p className="hint">
          Taken every six hours while the app runs, and always before a clear. The newest ten are kept.
        </p>
        {backups.length === 0 ? (
          <p className="setup-prose" style={{ margin: 0 }}>None yet. One is written the first time the app has run for six hours.</p>
        ) : (
          <table className="ledger-table">
            <thead><tr><th>Taken</th><th>Size</th><th>File</th></tr></thead>
            <tbody>
              {backups.map((b) => (
                <tr key={b.path}>
                  <td className="num">{b.at.slice(0, 16).replace("T", " ")}</td>
                  <td className="num">{Math.round(b.bytes / 1024).toLocaleString()} KB</td>
                  <td className="job-fine" style={{ wordBreak: "break-all" }}>{b.path}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="hint" style={{ marginTop: 12 }}>
          To restore one: stop the app, replace <code>data/jobs.db</code> with the file above, and start it
          again. Delete <code>jobs.db-wal</code> and <code>jobs.db-shm</code> alongside it if they are there.
        </p>
      </div>

      <div className="panel">
        <h3>Run the wizard again without clearing anything</h3>
        <p className="hint">Re-reads what is installed, what keys are set, and what the boards return.</p>
        <p className="setup-prose">
          The opening wizard is not a one-time thing — it is the shortest route to checking that a runner
          still answers and the boards still respond. It changes nothing on its own.
        </p>
        <Link to="/setup?step=1" className="ghost-btn">Open the wizard</Link>
      </div>
    </>
  );
}
