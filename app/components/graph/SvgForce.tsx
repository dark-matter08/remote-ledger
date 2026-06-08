import { useEffect, useRef, useState } from "react";
import { forceSimulation, forceManyBody, forceLink, forceCenter, forceCollide, forceX, forceY } from "d3-force";
import type { GraphData, GraphNode } from "./palette";
import { TYPE_COLOR, themeColors } from "./palette";

// Hand-rolled SVG engine: d3-force simulation, custom pan/zoom/drag. No canvas.
export function SvgForce({ data, width, height, dim, onPick }: {
  data: GraphData; width: number; height: number; dim: Set<string> | null; onPick: (n: GraphNode | null) => void;
}) {
  const nodesRef = useRef<any[]>([]);
  const linksRef = useRef<any[]>([]);
  const simRef = useRef<any>(null);
  const [, setTick] = useState(0);
  const [view, setView] = useState({ k: 1, tx: 0, ty: 0 });
  const svgRef = useRef<SVGSVGElement>(null);
  const theme = themeColors();

  // (re)build the simulation when the node/link set changes
  useEffect(() => {
    const nodes = data.nodes.map((n) => ({ ...n }));
    const idmap = new Map(nodes.map((n) => [n.id, n]));
    const links = data.links.filter((l) => idmap.has(idof(l.source)) && idmap.has(idof(l.target))).map((l) => ({ ...l }));
    nodesRef.current = nodes; linksRef.current = links;
    const sim = forceSimulation(nodes)
      .force("charge", forceManyBody().strength(-34).distanceMax(260))
      .force("link", forceLink(links).id((d: any) => d.id).distance(38).strength(0.5))
      .force("center", forceCenter(width / 2, height / 2))
      .force("x", forceX(width / 2).strength(0.06))
      .force("y", forceY(height / 2).strength(0.06))
      .force("collide", forceCollide().radius((d: any) => radius(d) + 2))
      .on("tick", () => setTick((t) => t + 1));
    simRef.current = sim;
    return () => { sim.stop(); };
  }, [data, width, height]);

  // ---- pan / zoom ----
  function onWheel(e: React.WheelEvent) {
    e.preventDefault();
    const rect = svgRef.current!.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    setView((v) => {
      const k = Math.min(6, Math.max(0.2, v.k * (e.deltaY < 0 ? 1.1 : 0.9)));
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
          const s = l.source, t = l.target; if (s?.x == null || t?.x == null) return null;
          const lit = !dim || (dim.has(s.id) && dim.has(t.id));
          return <line key={i} x1={s.x} y1={s.y} x2={t.x} y2={t.y} stroke={theme.ruleFaint} strokeWidth={lit ? 1.2 : 0.5} opacity={lit ? 0.95 : 0.14} />;
        })}
        {nodesRef.current.map((n) => {
          const lit = !dim || dim.has(n.id);
          const r = radius(n);
          return (
            <g key={n.id} transform={`translate(${n.x || 0},${n.y || 0})`} opacity={lit ? 1 : 0.18}
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

const idof = (v: any) => (typeof v === "object" ? v.id : v);
const radius = (n: any) => Math.max(3, Math.sqrt(n.val) * 2.2);
