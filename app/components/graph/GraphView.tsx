import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { X } from "lucide-react";
import { ForceCanvas } from "./ForceCanvas";
import { SvgForce } from "./SvgForce";
import { TYPE_COLOR, TYPE_LABEL, type GraphData, type GraphNode, type NodeType } from "./palette";

const ALL_TYPES: NodeType[] = ["self", "skill", "project", "job", "company", "source", "stage", "qa", "contact"];

export function GraphView({ data }: { data: GraphData }) {
  const [engine, setEngine] = useState<"canvas" | "svg">("canvas");
  const [active, setActive] = useState<Set<NodeType>>(new Set(ALL_TYPES));
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [query, setQuery] = useState("");
  const [charge, setCharge] = useState(-34);
  const [linkDist, setLinkDist] = useState(38);
  const [showForces, setShowForces] = useState(false);
  const [fitNonce, setFitNonce] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    if (!wrapRef.current) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.floor(e.contentRect.width), h: Math.floor(e.contentRect.height) }));
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  // filter to active types; keep only links whose endpoints survive
  const view = useMemo(() => {
    const nodes = data.nodes.filter((n) => active.has(n.type));
    const keep = new Set(nodes.map((n) => n.id));
    const links = data.links.filter((l) => keep.has(idof(l.source)) && keep.has(idof(l.target)));
    return { nodes, links } as GraphData;
  }, [data, active]);

  // brightness set: selected→neighbours; else search matches; else all
  const dim = useMemo(() => {
    if (selected) {
      const keep = new Set<string>([selected.id]);
      for (const l of data.links) { const s = idof(l.source), t = idof(l.target); if (s === selected.id) keep.add(t); if (t === selected.id) keep.add(s); }
      return keep;
    }
    const q = query.trim().toLowerCase();
    if (q) return new Set(view.nodes.filter((n) => n.label.toLowerCase().includes(q)).map((n) => n.id));
    return null;
  }, [selected, query, data, view]);

  const toggle = (t: NodeType) => setActive((cur) => { const n = new Set(cur); n.has(t) ? n.delete(t) : n.add(t); return n; });
  const ready = size.w > 0 && size.h > 0;
  const engineProps = { data: view, width: size.w, height: size.h, dim, charge, linkDist, fitNonce, onPick: setSelected };

  return (
    <div className="kg">
      <div className="kg-bar">
        <div className="kg-engine">
          <button className={engine === "canvas" ? "on" : ""} onClick={() => setEngine("canvas")}>Canvas</button>
          <button className={engine === "svg" ? "on" : ""} onClick={() => setEngine("svg")}>SVG</button>
        </div>
        <div className="kg-legend">
          {ALL_TYPES.map((t) => (
            <button key={t} className={`kg-chip ${active.has(t) ? "on" : "off"}`} onClick={() => toggle(t)} title={`Toggle ${TYPE_LABEL[t]}`}>
              <span className="kg-dot" style={{ background: TYPE_COLOR[t] }} />
              {TYPE_LABEL[t]} <em>{data.counts?.[t] || 0}</em>
            </button>
          ))}
        </div>
        <div className="kg-tools">
          <input className="kg-search" placeholder="search…" value={query} onChange={(e) => setQuery(e.target.value)} />
          <button className="kg-tool" onClick={() => setFitNonce((n) => n + 1)} title="Fit to view">Fit</button>
          <button className={`kg-tool ${showForces ? "on" : ""}`} onClick={() => setShowForces((s) => !s)} title="Force controls">Forces</button>
        </div>
      </div>

      {showForces && (
        <div className="kg-forces">
          <label>Repulsion <input type="range" min={-120} max={-8} value={charge} onChange={(e) => setCharge(Number(e.target.value))} /></label>
          <label>Link length <input type="range" min={20} max={120} value={linkDist} onChange={(e) => setLinkDist(Number(e.target.value))} /></label>
          <span className="kg-hint" style={{ marginLeft: "auto" }}>scroll to zoom · drag to pan · drag a node to pin · click to inspect</span>
        </div>
      )}

      <div className="kg-stage" ref={wrapRef}>
        {!ready ? null : view.nodes.length === 0 ? (
          <div className="graph-loading">Nothing to show — add résumé skills, run a crawl, or build the knowledge base.</div>
        ) : engine === "canvas" ? (
          <ForceCanvas key="canvas" {...engineProps} />
        ) : (
          <SvgForce key="svg" {...engineProps} />
        )}

        {selected && (
          <aside className="kg-panel">
            <div className="kg-panel-head">
              <span className="kg-dot" style={{ background: TYPE_COLOR[selected.type] }} />
              <span className="kg-panel-type">{TYPE_LABEL[selected.type]}</span>
              <button className="kg-close" onClick={() => setSelected(null)} aria-label="Close"><X size={15} /></button>
            </div>
            <h4>{selected.label}</h4>
            {selected.detail && <pre className="kg-detail">{selected.detail}</pre>}
            <div className="kg-neighbors">
              {neighborsOf(selected, data).slice(0, 14).map((n) => (
                <button key={n.id} className="kg-nb" onClick={() => setSelected(n)}>
                  <span className="kg-dot" style={{ background: TYPE_COLOR[n.type] }} />{n.label}
                </button>
              ))}
            </div>
            {selected.href && <Link to={selected.href} className="btn" style={{ marginTop: 12, display: "inline-block" }}>Open ▸</Link>}
          </aside>
        )}
      </div>
    </div>
  );
}

const idof = (v: any) => (typeof v === "object" && v ? v.id : v);
function neighborsOf(node: GraphNode, data: GraphData): GraphNode[] {
  const byId = new Map(data.nodes.map((n) => [n.id, n]));
  const ids = new Set<string>();
  for (const l of data.links) { const s = idof(l.source), t = idof(l.target); if (s === node.id) ids.add(t); if (t === node.id) ids.add(s); }
  return [...ids].map((id) => byId.get(id)!).filter(Boolean);
}
