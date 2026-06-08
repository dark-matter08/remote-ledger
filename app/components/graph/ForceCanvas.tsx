import { useEffect, useRef, useState } from "react";
import type { GraphData, GraphNode } from "./palette";
import { TYPE_COLOR, themeColors } from "./palette";

// Canvas engine: react-force-graph-2d, loaded client-only (it touches window at import).
export function ForceCanvas({ data, width, height, dim, charge, linkDist, fitNonce, onPick }: {
  data: GraphData;
  width: number;
  height: number;
  dim: Set<string> | null;        // node ids to keep bright (neighbors of selected); null = all bright
  charge: number;
  linkDist: number;
  fitNonce: number;
  onPick: (n: GraphNode | null) => void;
}) {
  const [FG, setFG] = useState<any>(null);
  const theme = useThemeColors();
  const ref = useRef<any>(null);

  useEffect(() => {
    let alive = true;
    import("react-force-graph-2d").then((m) => { if (alive) setFG(() => m.default); });
    return () => { alive = false; };
  }, []);

  // live force tuning from the sliders
  useEffect(() => {
    const fg = ref.current; if (!fg) return;
    fg.d3Force("charge")?.strength(charge);
    fg.d3Force("link")?.distance(linkDist);
    fg.d3ReheatSimulation();
  }, [charge, linkDist, FG]);

  // external Fit trigger
  useEffect(() => { ref.current?.zoomToFit(400, 50); }, [fitNonce]);

  if (!FG) return <div className="graph-loading">loading graph engine…</div>;

  return (
    <FG
      ref={ref}
      graphData={data}
      width={width}
      height={height}
      backgroundColor={theme.paper}
      cooldownTicks={120}
      onEngineStop={() => ref.current?.zoomToFit(400, 50)}
      nodeRelSize={5}
      nodeVal={(n: any) => n.val}
      linkColor={() => theme.ruleFaint}
      linkWidth={(l: any) => (dim && isDimLink(l, dim) ? 0.4 : 1)}
      linkDirectionalParticles={0}
      onNodeClick={(n: any) => onPick(n)}
      onBackgroundClick={() => onPick(null)}
      onNodeDragEnd={(n: any) => { n.fx = n.x; n.fy = n.y; }}
      nodeCanvasObject={(node: any, ctx: CanvasRenderingContext2D, scale: number) => {
        const bright = !dim || dim.has(node.id);
        const r = Math.max(3, Math.sqrt(node.val) * 2.2);
        ctx.globalAlpha = bright ? 1 : 0.18;
        ctx.beginPath();
        ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
        ctx.fillStyle = TYPE_COLOR[node.type as keyof typeof TYPE_COLOR] || theme.ink;
        ctx.fill();
        if (node.type === "self") { ctx.lineWidth = 1.5 / scale; ctx.strokeStyle = theme.ink; ctx.stroke(); }
        // labels for hubs / when zoomed in
        if (bright && (node.val > 5 || scale > 2.4)) {
          const label = String(node.label).slice(0, 28);
          const fs = Math.min(13, 11 / scale) + 1;
          ctx.font = `${fs}px ui-monospace, monospace`;
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.fillStyle = theme.ink;
          ctx.fillText(label, node.x, node.y + r + 1.5);
        }
        ctx.globalAlpha = 1;
      }}
      nodePointerAreaPaint={(node: any, color: string, ctx: CanvasRenderingContext2D) => {
        const r = Math.max(3, Math.sqrt(node.val) * 2.2) + 3;
        ctx.fillStyle = color; ctx.beginPath(); ctx.arc(node.x, node.y, r, 0, 2 * Math.PI); ctx.fill();
      }}
    />
  );
}

function isDimLink(l: any, dim: Set<string>): boolean {
  const s = typeof l.source === "object" ? l.source.id : l.source;
  const t = typeof l.target === "object" ? l.target.id : l.target;
  return !(dim.has(s) && dim.has(t));
}

function useThemeColors() {
  const [c, setC] = useState(themeColors());
  useEffect(() => {
    setC(themeColors());
    const obs = new MutationObserver(() => setC(themeColors()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);
  return c;
}
