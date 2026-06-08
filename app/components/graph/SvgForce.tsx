import { useEffect, useMemo, useRef, useState } from "react";
import { forceSimulation, forceManyBody, forceLink, forceCenter, forceCollide, forceX, forceY } from "d3-force";
import type { GraphData, GraphNode } from "./palette";
import { TYPE_COLOR, themeColors } from "./palette";

// Hand-rolled SVG engine: d3-force simulation, custom pan/zoom/drag, auto-fit.
export function SvgForce({ data, width, height, dim, charge, linkDist, fitNonce, onPick }: {
  data: GraphData; width: number; height: number; dim: Set<string> | null;
  charge: number; linkDist: number; fitNonce: number; onPick: (n: GraphNode | null) => void;
}) {
  const nodesRef = useRef<any[]>([]);
  const linksRef = useRef<any[]>([]);
  const simRef = useRef<any>(null);
  const [, setTick] = useState(0);
  const [view, setView] = useState({ k: 1, tx: 0, ty: 0 });
  const svgRef = useRef<SVGSVGElement>(null);
  const theme = themeColors();

  // resolve line endpoints against the CURRENT node objects by id — never trust the
  // forceLink-mutated reference (StrictMode/HMR can leave it bound to a stale array)
  const byId = useMemo(() => new Map(nodesRef.current.map((n) => [n.id, n])), [nodesRef.current]);

  function fit() {
    const ns = nodesRef.current.filter((n) => n.x != null);
    if (!ns.length || !width) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of ns) { minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x); minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y); }
    const pad = 50, gw = maxX - minX || 1, gh = maxY - minY || 1;
    const k = Math.min(2.5, Math.max(0.2, Math.min((width - pad * 2) / gw, (height - pad * 2) / gh)));
    setView({ k, tx: width / 2 - ((minX + maxX) / 2) * k, ty: height / 2 - ((minY + maxY) / 2) * k });
  }

  // (re)build the simulation when the node/link set or size changes
  useEffect(() => {
    const nodes = data.nodes.map((n) => ({ ...n }));
    const ids = new Set(nodes.map((n) => n.id));
    const links = data.links.filter((l) => ids.has(idof(l.source)) && ids.has(idof(l.target))).map((l) => ({ source: idof(l.source), target: idof(l.target), kind: l.kind }));
    nodesRef.current = nodes; linksRef.current = links;
    const sim = forceSimulation(nodes)
      .force("charge", forceManyBody().strength(charge).distanceMax(280))
      .force("link", forceLink(links).id((d: any) => d.id).distance(linkDist).strength(0.5))
      .force("center", forceCenter(width / 2, height / 2))
      .force("x", forceX(width / 2).strength(0.06))
      .force("y", forceY(height / 2).strength(0.06))
      .force("collide", forceCollide().radius((d: any) => radius(d) + 2))
      .on("tick", () => setTick((t) => t + 1))
      .on("end", () => fit());
    simRef.current = sim;
    const fitTimer = setTimeout(fit, 1400);
    return () => { clearTimeout(fitTimer); sim.stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, width, height]);

  // live force tuning (sliders)
  useEffect(() => {
    const sim = simRef.current; if (!sim) return;
    sim.force("charge")?.strength(charge);
    sim.force("link")?.distance(linkDist);
    sim.alpha(0.6).restart();
  }, [charge, linkDist]);

  // external Fit trigger
  useEffect(() => { if (fitNonce) fit(); /* eslint-disable-next-line */ }, [fitNonce]);

  // ---- pan / zoom ----
  function onWheel(e: React.WheelEvent) {
    const rect = svgRef.current!.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    setView((v) => {
      const k = Math.min(6, Math.max(0.15, v.k * (e.deltaY < 0 ? 1.1 : 0.9)));
      return { k, tx: mx - ((mx - v.tx) / v.k) * k, ty: my - ((my - v.ty) / v.k) * k };
    });
  }
  const drag = useRef<{ mode: "pan" | "node" | null; node?: any; sx: number; sy: number; ox: number; oy: number }>({ mode: null, sx: 0, sy: 0, ox: 0, oy: 0 });
  const toGraph = (cx: number, cy: number) => { const r = svgRef.current!.getBoundingClientRect(); return { x: (cx - r.left - view.tx) / view.k, y: (cy - r.top - view.ty) / view.k }; };
  function onDown(e: React.PointerEvent, node?: any) {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    if (node) { drag.current = { mode: "node", node, sx: e.clientX, sy: e.clientY, ox: 0, oy: 0 }; simRef.current?.alphaTarget(0.3).restart(); }
    else drag.current = { mode: "pan", sx: e.clientX, sy: e.clientY, ox: view.tx, oy: view.ty };
  }
  function onMove(e: React.PointerEvent) {
    const d = drag.current; if (!d.mode) return;
    if (d.mode === "pan") setView((v) => ({ ...v, tx: d.ox + (e.clientX - d.sx), ty: d.oy + (e.clientY - d.sy) }));
    else if (d.node) { const g = toGraph(e.clientX, e.clientY); d.node.fx = g.x; d.node.fy = g.y; }
  }
  function onUp() { const d = drag.current; if (d.mode === "node") simRef.current?.alphaTarget(0); drag.current = { mode: null, sx: 0, sy: 0, ox: 0, oy: 0 }; }

  return (
    <svg ref={svgRef} width={width} height={height} style={{ background: theme.paper, cursor: drag.current.mode === "pan" ? "grabbing" : "default", touchAction: "none" }}
      onWheel={onWheel} onPointerDown={(e) => onDown(e)} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp}>
      <g transform={`translate(${view.tx},${view.ty}) scale(${view.k})`}>
        {linksRef.current.map((l, i) => {
          const s = byId.get(idof(l.source)), t = byId.get(idof(l.target));
          if (!s || !t || !Number.isFinite(s.x) || !Number.isFinite(s.y) || !Number.isFinite(t.x) || !Number.isFinite(t.y)) return null;
          const lit = !dim || (dim.has(s.id) && dim.has(t.id));
          return <line key={i} x1={s.x} y1={s.y} x2={t.x} y2={t.y} stroke={theme.ruleFaint} strokeWidth={lit ? 1.2 : 0.5} opacity={lit ? 0.9 : 0.12} />;
        })}
        {nodesRef.current.map((n) => {
          const lit = !dim || dim.has(n.id);
          const r = radius(n);
          return (
            <g key={n.id} transform={`translate(${n.x || 0},${n.y || 0})`} opacity={lit ? 1 : 0.16}
              style={{ cursor: "pointer" }} onPointerDown={(e) => { e.stopPropagation(); onDown(e, n); }}
              onClick={(e) => { e.stopPropagation(); onPick(n); }}>
              <circle r={r} fill={TYPE_COLOR[n.type as keyof typeof TYPE_COLOR]} stroke={n.type === "self" ? theme.ink : "none"} strokeWidth={1.5} />
              {(n.val > 5 || view.k > 2.2) && lit && (
                <text x={0} y={r + 9} textAnchor="middle" fontSize={9} fontFamily="ui-monospace, monospace" fill={theme.ink}>{String(n.label).slice(0, 26)}</text>
              )}
            </g>
          );
        })}
      </g>
    </svg>
  );
}

const idof = (v: any) => (typeof v === "object" && v ? v.id : v);
const radius = (n: any) => Math.max(3, Math.sqrt(n.val) * 2.2);
