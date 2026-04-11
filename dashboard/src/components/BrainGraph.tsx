/**
 * BrainGraph — force-directed visualization of Hermes' typed knowledge graph.
 *
 * Wraps react-force-graph-2d (canvas) and adds:
 *   - Type-based node coloring with a stable palette per node type
 *   - Pulse halo animation when a node ID is in the `pulses` set
 *   - Click → onNodeClick callback (used by brain.tsx for the detail card)
 *   - Layout settles in ~3 seconds via cooldownTicks
 *
 * Lives in dashboard/src/components/ — used only by routes/brain.tsx.
 */
import { useEffect, useMemo, useRef } from "react";
import ForceGraph2D from "react-force-graph-2d";
import type { BrainGraph as BrainGraphData, BrainNode, BrainEdge } from "@/lib/api";

type Props = {
  graph: BrainGraphData;
  onNodeClick?: (node: BrainNode) => void;
  pulses: Set<string>;
  visibleTypes: Set<BrainNode["type"]>;
  className?: string;
};

// Tailwind palette equivalents (oklch values) for each node type. Kept here
// instead of in lib/utils so the dashboard's existing eventColorClass is
// not overloaded with brain-specific entries.
const NODE_COLORS: Record<BrainNode["type"], string> = {
  memory: "#fbbf24",   // amber-400
  session: "#22d3ee",  // cyan-400
  skill: "#a78bfa",    // violet-400
  tool: "#34d399",     // emerald-400
  mcp: "#fb7185",      // rose-400
  cron: "#fb923c",     // orange-400
};

const EDGE_COLOR = "rgba(148, 163, 184, 0.35)"; // slate-400/35
const PULSE_COLOR = "rgba(255, 255, 255, 0.9)";

type FGNode = BrainNode & { x?: number; y?: number; vx?: number; vy?: number };
type FGLink = BrainEdge;

export function BrainGraph({
  graph,
  onNodeClick,
  pulses,
  visibleTypes,
  className,
}: Props) {
  const fgRef = useRef<unknown>(null);

  // Filter the graph by visibleTypes — keep edges only when both endpoints
  // are still visible after filtering. The filter runs over a fresh data
  // copy each render, but typing is intentionally loose since
  // react-force-graph mutates the node objects in place to add x/y/vx/vy.
  const data = useMemo(() => {
    const visibleNodes = graph.nodes.filter((n) => visibleTypes.has(n.type));
    const visibleIds = new Set(visibleNodes.map((n) => n.id));
    const visibleLinks = graph.edges.filter(
      (e) => visibleIds.has(e.source) && visibleIds.has(e.target),
    );
    return {
      nodes: visibleNodes as FGNode[],
      links: visibleLinks as FGLink[],
    };
  }, [graph, visibleTypes]);

  // Pulse animation: re-render at ~30fps while there are active pulses
  // so the halo visibly fades. We don't do timestamp tweening here — the
  // brain.tsx page just removes pulses from the Set after a 2-second
  // setTimeout, so re-rendering on each tick is enough.
  useEffect(() => {
    if (pulses.size === 0) return;
    const handle = setInterval(() => {
      // Force a refresh by toggling a no-op cooldown nudge.
      // react-force-graph re-paints automatically when its data prop
      // changes, but for pulse halos we just need a paint loop.
      const fg = fgRef.current as { refresh?: () => void } | null;
      fg?.refresh?.();
    }, 33);
    return () => clearInterval(handle);
  }, [pulses]);

  return (
    <div className={className}>
      <ForceGraph2D
        ref={fgRef as never}
        graphData={data}
        nodeId="id"
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        linkSource={"source" as any}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        linkTarget={"target" as any}
        backgroundColor="rgba(0,0,0,0)"
        linkColor={() => EDGE_COLOR}
        linkWidth={(link: object) => Math.min(3, Math.max(0.5, ((link as FGLink).weight ?? 1) / 2))}
        nodeRelSize={4}
        nodeVal={(node: object) => {
          const n = node as FGNode;
          const w = n.weight ?? 1;
          return Math.max(1, Math.log(w + 1) * 4);
        }}
        cooldownTicks={100}
        d3VelocityDecay={0.35}
        onNodeClick={(node: object) => onNodeClick?.(node as BrainNode)}
        nodeCanvasObject={(node: object, ctx: CanvasRenderingContext2D, scale: number) => {
          const n = node as FGNode;
          const radius = Math.max(3, Math.log((n.weight ?? 1) + 1) * 4);
          const x = n.x ?? 0;
          const y = n.y ?? 0;

          // Pulse halo (drawn UNDER the node so the dot stays visible)
          if (pulses.has(n.id)) {
            ctx.beginPath();
            ctx.arc(x, y, radius + 6, 0, 2 * Math.PI);
            ctx.fillStyle = PULSE_COLOR;
            ctx.globalAlpha = 0.35;
            ctx.fill();
            ctx.globalAlpha = 1;
          }

          // Node body
          ctx.beginPath();
          ctx.arc(x, y, radius, 0, 2 * Math.PI);
          ctx.fillStyle = NODE_COLORS[n.type] ?? "#94a3b8";
          ctx.fill();

          // Label only when zoomed in enough to read it (avoids screen
          // clutter at default zoom levels)
          if (scale > 1.5) {
            ctx.font = `${10 / scale}px sans-serif`;
            ctx.fillStyle = "rgba(226, 232, 240, 0.85)";
            ctx.textAlign = "center";
            ctx.textBaseline = "top";
            const label = (n.label || n.id).slice(0, 24);
            ctx.fillText(label, x, y + radius + 1);
          }
        }}
      />
    </div>
  );
}

export const BRAIN_NODE_COLORS = NODE_COLORS;
