import { useState } from "react";
import { Folder, Home, ArrowUp } from "lucide-react";

// Path field with a server-side folder browser. Browsing hits /api/dirs (which reads
// the real filesystem on this machine), so you click into the folder you want and it
// fills the exact absolute path — no upload, safe for huge trees. You can also just type.
interface DirData { ok: boolean; path: string; parent: string; home: string; dirs: string[]; error?: string }

export function DirPicker({ name, placeholder }: { name: string; placeholder?: string }) {
  const [path, setPath] = useState("");
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<DirData | null>(null);
  const [loading, setLoading] = useState(false);

  async function load(p: string) {
    setLoading(true);
    try {
      const r = await fetch(`/api/dirs?path=${encodeURIComponent(p)}`);
      setData(await r.json());
    } catch { setData({ ok: false, path: p, parent: p, home: "", dirs: [], error: "Could not read folder." }); }
    setLoading(false);
  }
  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && !data) load(path || "");
  }

  const sep = data && data.path.includes("\\") ? "\\" : "/";
  const join = (base: string, name: string) => (base.endsWith(sep) ? base + name : base + sep + name);

  return (
    <div className="dirpick">
      <input type="text" name={name} value={path} onChange={(e) => setPath(e.target.value)} placeholder={placeholder} className="dirpick-input" />
      <button type="button" className="filepick-btn" onClick={toggle}>{open ? "Close" : "Browse…"}</button>

      {open && (
        <div className="dirpick-panel">
          <div className="dirpick-bar">
            <button type="button" className="back-link dirpick-nav" onClick={() => load(data?.home || "")}><Home size={13} /> Home</button>
            <button type="button" className="back-link dirpick-nav" onClick={() => data && load(data.parent)} disabled={!data || data.path === data.parent}><ArrowUp size={13} /> Up</button>
            <code className="dirpick-cwd">{data?.path || "…"}</code>
          </div>
          <div className="dirpick-list">
            {loading ? (
              <div className="dirpick-empty">reading…</div>
            ) : data?.error ? (
              <div className="dirpick-empty">{data.error}</div>
            ) : data && data.dirs.length === 0 ? (
              <div className="dirpick-empty">no subfolders here</div>
            ) : (
              data?.dirs.map((d) => (
                <button type="button" key={d} className="dirpick-dir" onClick={() => load(join(data.path, d))}><Folder size={14} /> {d}</button>
              ))
            )}
          </div>
          <div className="dirpick-foot">
            <span className="dirpick-pick">Use: <code>{data?.path}</code></span>
            <button type="button" className="ghost-btn" disabled={!data?.ok} onClick={() => { if (data) setPath(data.path); setOpen(false); }}>Select this folder</button>
          </div>
        </div>
      )}
    </div>
  );
}
