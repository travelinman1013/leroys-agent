/**
 * BrainGraph — Operator's Desk star chart.
 *
 * Replaces the previous react-force-graph-2d "blob" with a deterministic
 * seeded SVG layout. Read it like a Palomar plate. See DESIGN.md §6 row
 * `/brain` and §10 (decisions log: "Brain renders as star chart with
 * deterministic seeded layout").
 *
 *   - Layout: stable hash → polar coordinates per node id, packed into a
 *     16:9 viewport. No force iterations, no jitter, no animation drift.
 *   - Edges: hairlines at 16% ink opacity.
 *   - Nodes: oxide crosshair / dot / hollow ring depending on type. Active
 *     pulse renders a faint oxide halo on top.
 *   - Labels: tiny mono, ink @ ~70% opacity. RA/Dec chrome corners.
 *   - Interaction: pan via drag, click → onNodeClick.
 */

import { useMemo, useRef, useState, useCallback } from "react";
import type {
  BrainGraph as BrainGraphData,
  BrainNode,
} from "@/lib/api";
import { useThemedPalette } from "@/lib/theme";

type Props = {
  graph: BrainGraphData;
  onNodeClick?: (node: BrainNode) => void;
  pulses: Set<string>;
  visibleTypes: Set<BrainNode["type"]>;
  className?: string;
};

const VIEW_W = 1280;
const VIEW_H = 720;
const PADDING = 90;

// Node shape vocabulary — Operator's Desk anti-rainbow rule (DESIGN.md §4 r3).
type Shape = "dot" | "ring" | "crosshair";
const SHAPE: Record<BrainNode["type"], Shape> = {
  memory: "dot",
  session: "crosshair",
  skill: "ring",
  tool: "dot",
  mcp: "ring",
  cron: "crosshair",
};

// Palette constants previously hardcoded dark-mode values
// (`#C96B2C` / `#E7E2D8` / ...). They now come from
// `useThemedPalette()` inside the component so the canvas flips
// with the Appearance toggle in /config. See DESIGN.md §4 for
// the full Bone & Iron Oxide token set.

/**
 * Cheap deterministic hash → 32-bit float in [0, 1). Stable across renders
 * because it depends only on the node id string. Switching the seed prefix
 * gives a different layout for the same graph (the chosen seed is `0x4A`
 * to match the preview chrome).
 */
function hash01(str: string, salt: number): number {
  let h = 0x811c9dc5 ^ salt;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // squish to [0, 1)
  return ((h >>> 0) % 0x100000) / 0x100000;
}

type LaidOutNode = BrainNode & { x: number; y: number; r: number };

function layout(nodes: BrainNode[]): LaidOutNode[] {
  // Polar packing: each node lands at (rho, theta) drawn from two hashes.
  // Square-root mapping on rho gives even areal density across the disc.
  const cx = VIEW_W / 2;
  const cy = VIEW_H / 2;
  // Use a slightly oblong radius so the disc fills the 16:9 stage.
  const rxMax = (VIEW_W - PADDING * 2) / 2;
  const ryMax = (VIEW_H - PADDING * 2) / 2;

  // Sort by weight DESC so heavy nodes hash first → tend to land near the center.
  const sorted = [...nodes].sort((a, b) => (b.weight ?? 1) - (a.weight ?? 1));

  return sorted.map((n, idx) => {
    const u = hash01(n.id, 0x4a);
    const v = hash01(n.id, 0x4a + 1);
    // Heavy nodes get pulled inward; light nodes drift to the edge.
    const inwardBias = idx < 8 ? 0.4 : 1;
    const rho = Math.sqrt(u) * inwardBias;
    const theta = v * Math.PI * 2;
    const x = cx + Math.cos(theta) * rho * rxMax;
    const y = cy + Math.sin(theta) * rho * ryMax;
    const r = Math.max(1.6, Math.log((n.weight ?? 1) + 1) * 2.4);
    return { ...n, x, y, r };
  });
}

export function BrainGraph({
  graph,
  onNodeClick,
  pulses,
  visibleTypes,
  className,
}: Props) {
  const palette = useThemedPalette();
  const OXIDE = palette.oxide;
  const INK = palette.ink;
  const RULE = palette.rule;
  const RULE_STRONG = palette.ruleStrong;
  const FAINT = palette.inkFaint;

  // Filter & lay out — both stable for a given graph + visibleTypes pair.
  const data = useMemo(() => {
    const visibleNodes = graph.nodes.filter((n) => visibleTypes.has(n.type));
    const visibleIds = new Set(visibleNodes.map((n) => n.id));
    const visibleEdges = graph.edges.filter(
      (e) => visibleIds.has(e.source) && visibleIds.has(e.target),
    );
    const laid = layout(visibleNodes);
    const byId = new Map(laid.map((n) => [n.id, n]));
    return { nodes: laid, edges: visibleEdges, byId };
  }, [graph, visibleTypes]);

  // Pan state (viewBox translate). Zoom is a single user gesture deferred
  // to v2 — for now the layout is always tuned to fit the viewport.
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragging = useRef<{ startX: number; startY: number; px: number; py: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    dragging.current = { startX: e.clientX, startY: e.clientY, px: pan.x, py: pan.y };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }, [pan.x, pan.y]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    const dx = e.clientX - dragging.current.startX;
    const dy = e.clientY - dragging.current.startY;
    setPan({ x: dragging.current.px + dx, y: dragging.current.py + dy });
  }, []);

  const onPointerUp = useCallback(() => {
    dragging.current = null;
  }, []);

  const resetPan = useCallback(() => setPan({ x: 0, y: 0 }), []);

  const transform = `translate(${pan.x}, ${pan.y})`;

  return (
    <div className={className}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="xMidYMid meet"
        className="block h-full w-full select-none touch-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={resetPan}
        style={{ background: palette.bgAlt, cursor: dragging.current ? "grabbing" : "grab" }}
      >
        <defs>
          <pattern id="brain-grid" width="60" height="60" patternUnits="userSpaceOnUse">
            <path d="M60 0H0V60" fill="none" stroke={RULE} strokeWidth="0.5" />
          </pattern>
        </defs>

        <rect width={VIEW_W} height={VIEW_H} fill="url(#brain-grid)" opacity="0.6" />

        {/* coordinate axes (dashed cross-hairs) */}
        <g stroke={RULE_STRONG} strokeWidth="0.5">
          <line
            x1="0"
            y1={VIEW_H / 2}
            x2={VIEW_W}
            y2={VIEW_H / 2}
            strokeDasharray="2,6"
          />
          <line
            x1={VIEW_W / 2}
            y1="0"
            x2={VIEW_W / 2}
            y2={VIEW_H}
            strokeDasharray="2,6"
          />
        </g>

        <g transform={transform}>
          {/* edges — single hairline pass at 16% opacity */}
          <g stroke={INK} strokeOpacity="0.16" strokeWidth="0.7" fill="none">
            {data.edges.map((e, i) => {
              const a = data.byId.get(e.source);
              const b = data.byId.get(e.target);
              if (!a || !b) return null;
              return (
                <line
                  key={`e-${i}`}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                />
              );
            })}
          </g>

          {/* pulse halos (oxide, behind nodes) */}
          {data.nodes
            .filter((n) => pulses.has(n.id))
            .map((n) => (
              <circle
                key={`p-${n.id}`}
                cx={n.x}
                cy={n.y}
                r={n.r + 6}
                fill={OXIDE}
                fillOpacity="0.32"
              />
            ))}

          {/* nodes */}
          <g fill={OXIDE} stroke={OXIDE}>
            {data.nodes.map((n) => (
              <NodeMark
                key={n.id}
                node={n}
                oxide={OXIDE}
                onClick={() => onNodeClick?.(n)}
              />
            ))}
          </g>

          {/* labels — only the heaviest get a rendered label */}
          <g fill={INK} fillOpacity="0.78" fontFamily="ui-monospace, JetBrains Mono, monospace" fontSize="11">
            {data.nodes.slice(0, 18).map((n) => (
              <text
                key={`l-${n.id}`}
                x={n.x + n.r + 6}
                y={n.y - n.r - 2}
                pointerEvents="none"
              >
                {(n.label || n.id).slice(0, 24).toUpperCase()}
              </text>
            ))}
          </g>
        </g>

        {/* RA/Dec chrome corners (overlay, not affected by pan) */}
        <g fill={FAINT} fontFamily="ui-monospace, JetBrains Mono, monospace" fontSize="9" letterSpacing="1.5">
          <text x="22" y="26" textAnchor="start">
            BRAIN · KNOWLEDGE GRAPH · DETERMINISTIC SEED 0x4A
          </text>
          <text x={VIEW_W - 22} y="26" textAnchor="end">
            RA 12h ─ Dec +47°
          </text>
          <text x="22" y={VIEW_H - 18} textAnchor="start">
            DRAG · DOUBLE-CLICK TO RESET
          </text>
          <text x={VIEW_W - 22} y={VIEW_H - 18} textAnchor="end">
            N={data.nodes.length} · E={data.edges.length}
          </text>
        </g>
      </svg>
    </div>
  );
}

function NodeMark({
  node,
  oxide,
  onClick,
}: {
  node: LaidOutNode;
  oxide: string;
  onClick: () => void;
}) {
  const shape = SHAPE[node.type];
  const r = node.r;
  const arm = r + 4;
  return (
    <g
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      style={{ cursor: "pointer" }}
    >
      {shape === "dot" && <circle cx={node.x} cy={node.y} r={r} />}
      {shape === "ring" && (
        <circle
          cx={node.x}
          cy={node.y}
          r={r}
          fill="none"
          stroke={oxide}
          strokeWidth="0.9"
        />
      )}
      {shape === "crosshair" && (
        <>
          <circle cx={node.x} cy={node.y} r={Math.max(1.4, r - 0.4)} />
          <line
            x1={node.x - arm}
            y1={node.y}
            x2={node.x + arm}
            y2={node.y}
            strokeWidth="0.6"
          />
          <line
            x1={node.x}
            y1={node.y - arm}
            x2={node.x}
            y2={node.y + arm}
            strokeWidth="0.6"
          />
        </>
      )}
    </g>
  );
}
