/**
 * /brain — Hermes' brain visualization.
 *
 * A force-directed graph of typed knowledge nodes (memory / session /
 * skill / tool / mcp / cron) with real-time pulses driven by the
 * existing EventBus SSE multiplexer. The graph itself is rendered by
 * <BrainGraph>; this file owns the page layout, the live event
 * subscription that maps events → node IDs for pulses, the type-filter
 * chips, the inline legend, and the right-side detail card.
 *
 * Plan reference: ~/.claude/plans/stateful-noodling-reddy.md (Wave 2 / R3)
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { Brain, RefreshCw, X } from "lucide-react";
import {
  api,
  subscribeEvents,
  type BrainNode,
  type HermesEvent,
} from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { BrainGraph, BRAIN_NODE_COLORS } from "@/components/BrainGraph";

export const Route = createFileRoute("/brain")({
  component: BrainPage,
});

const ALL_TYPES: BrainNode["type"][] = [
  "memory",
  "session",
  "skill",
  "tool",
  "mcp",
  "cron",
];

const TYPE_LABELS: Record<BrainNode["type"], string> = {
  memory: "Memory",
  session: "Sessions",
  skill: "Skills",
  tool: "Tools",
  mcp: "MCP",
  cron: "Cron",
};

function BrainPage() {
  const graph = useQuery({
    queryKey: ["dashboard", "brain", "graph"],
    queryFn: api.brainGraph,
    refetchInterval: 30_000, // server-side lru_cache buckets requests anyway
  });

  // Selected node detail (null when nothing is open)
  const [selected, setSelected] = useState<BrainNode | null>(null);

  // Type-filter chips — start with everything visible
  const [visibleTypes, setVisibleTypes] = useState<Set<BrainNode["type"]>>(
    () => new Set(ALL_TYPES),
  );

  // Pulse state — set of node IDs currently glowing. Each pulse self-clears
  // after 2 seconds. We use a Set instead of an array for O(1) membership
  // checks inside BrainGraph's per-frame canvas paint.
  const [pulses, setPulses] = useState<Set<string>>(() => new Set());
  const pulseTimeouts = useRef<Map<string, number>>(new Map());

  const triggerPulse = useCallback((nodeId: string) => {
    setPulses((prev) => {
      const next = new Set(prev);
      next.add(nodeId);
      return next;
    });
    // Cancel any in-flight clear so a quick second event doesn't end the
    // pulse early. Then schedule a fresh 2-second timer.
    const existing = pulseTimeouts.current.get(nodeId);
    if (existing) window.clearTimeout(existing);
    const handle = window.setTimeout(() => {
      setPulses((prev) => {
        const next = new Set(prev);
        next.delete(nodeId);
        return next;
      });
      pulseTimeouts.current.delete(nodeId);
    }, 2000);
    pulseTimeouts.current.set(nodeId, handle);
  }, []);

  // Live event subscription — translate each event to a node ID and pulse it
  useEffect(() => {
    const cleanup = subscribeEvents((event) => {
      const nodeId = mapEventToNodeId(event);
      if (nodeId) triggerPulse(nodeId);
    }, { replay: 0 });
    return () => {
      cleanup();
      // Clear any pending pulse timers on unmount
      pulseTimeouts.current.forEach((h) => window.clearTimeout(h));
      pulseTimeouts.current.clear();
    };
  }, [triggerPulse]);

  const stats = graph.data?.stats;

  const toggleType = (type: BrainNode["type"]) => {
    setVisibleTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <header className="flex shrink-0 items-center justify-between border-b bg-card/30 p-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Brain className="size-6 text-violet-400" />
            Brain
          </h1>
          <p className="text-sm text-muted-foreground">
            Hermes' typed knowledge graph — memory, sessions, capabilities,
            and live activity. Click any node for details.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {stats && (
            <div className="hidden gap-2 text-xs text-muted-foreground md:flex">
              <StatPill label="memory" value={stats.memory} />
              <StatPill label="sessions" value={stats.session} />
              <StatPill label="skills" value={stats.skill} />
              <StatPill label="tools" value={stats.tool} />
              <StatPill label="mcp" value={stats.mcp} />
              <StatPill label="cron" value={stats.cron} />
            </div>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => graph.refetch()}
            disabled={graph.isFetching}
            title="Refetch graph (server cache buckets requests every 5s)"
          >
            <RefreshCw className={cn("size-4", graph.isFetching && "animate-spin")} />
          </Button>
        </div>
      </header>

      {/* Filter chips */}
      <div className="flex shrink-0 items-center gap-2 border-b bg-card/10 p-2">
        {ALL_TYPES.map((type) => {
          const active = visibleTypes.has(type);
          return (
            <button
              key={type}
              onClick={() => toggleType(type)}
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
                active
                  ? "border-foreground/30 bg-secondary text-secondary-foreground"
                  : "border-border text-muted-foreground hover:bg-secondary/40",
              )}
            >
              <span
                className="size-2 rounded-full"
                style={{ backgroundColor: BRAIN_NODE_COLORS[type] }}
              />
              {TYPE_LABELS[type]}
            </button>
          );
        })}
      </div>

      {/* Main canvas + selection drawer */}
      <div className="relative flex min-h-0 flex-1">
        <div className="relative min-h-0 flex-1">
          {graph.isLoading && (
            <div className="absolute inset-0 grid place-items-center text-sm text-muted-foreground">
              Loading brain snapshot…
            </div>
          )}
          {graph.error && (
            <div className="absolute inset-0 grid place-items-center text-sm text-destructive">
              Failed to load: {String(graph.error)}
            </div>
          )}
          {graph.data && (
            <BrainGraph
              graph={graph.data}
              pulses={pulses}
              visibleTypes={visibleTypes}
              onNodeClick={setSelected}
              className="absolute inset-0"
            />
          )}
        </div>

        {selected && (
          <div className="w-80 shrink-0 overflow-y-auto border-l bg-card/40 p-4">
            <BrainNodeDetailCard
              node={selected}
              onClose={() => setSelected(null)}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function StatPill({ label, value }: { label: string; value: number }) {
  return (
    <span className="rounded-md border border-border/60 bg-card/50 px-2 py-0.5 font-mono">
      {label} <span className="text-foreground">{value}</span>
    </span>
  );
}

/**
 * Translate a HermesEvent into a brain graph node ID. Returns null when
 * the event has no matching node (which is fine — most events don't).
 */
function mapEventToNodeId(event: HermesEvent): string | null {
  const data = (event.data ?? {}) as Record<string, unknown>;
  switch (event.type) {
    case "tool.invoked":
    case "tool.completed": {
      const tool = typeof data.tool === "string" ? data.tool : null;
      return tool ? `tool:${tool}` : null;
    }
    case "memory.added":
    case "memory.replaced":
    case "memory.removed": {
      const hash = typeof data.hash === "string" ? data.hash : null;
      return hash ? `memory:${hash}` : null;
    }
    case "session.started":
    case "session.ended":
    case "turn.started":
    case "turn.ended": {
      return event.session_id ? `session:${event.session_id}` : null;
    }
    case "skill.installed":
    case "skill.removed": {
      const name = typeof data.skill === "string" ? data.skill : null;
      return name ? `skill:${name}` : null;
    }
    case "mcp.connected":
    case "mcp.disconnected": {
      const name = typeof data.server_name === "string" ? data.server_name : null;
      return name ? `mcp:${name}` : null;
    }
    case "cron.fired": {
      const id = typeof data.job_id === "string" ? data.job_id : null;
      return id ? `cron:${id}` : null;
    }
    default:
      return null;
  }
}

/**
 * Inline node detail card. Shows redacted metadata only — for session
 * nodes it links out to the existing /sessions/$id route (which is
 * also redacted by R2 of the brain viz plan).
 */
function BrainNodeDetailCard({
  node,
  onClose,
}: {
  node: BrainNode;
  onClose: () => void;
}) {
  const meta = node.metadata as Record<string, unknown>;
  return (
    <Card className="border-border/60">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <span
              className="size-3 rounded-full"
              style={{ backgroundColor: BRAIN_NODE_COLORS[node.type] }}
            />
            {node.label}
          </CardTitle>
          <Button size="sm" variant="ghost" onClick={onClose} className="h-6 w-6 p-0">
            <X className="size-3.5" />
          </Button>
        </div>
        <Badge variant="secondary" className="mt-1 w-fit font-mono text-[10px]">
          {node.type}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-3 pt-0 text-xs">
        <MetadataList meta={meta} />

        {node.type === "session" && (
          <Link
            to="/sessions/$id"
            params={{ id: node.id.replace(/^session:/, "") }}
            className="inline-flex items-center text-xs text-cyan-400 hover:underline"
          >
            View transcript →
          </Link>
        )}
      </CardContent>
    </Card>
  );
}

function MetadataList({ meta }: { meta: Record<string, unknown> }) {
  const entries = Object.entries(meta).filter(
    ([, v]) => v !== null && v !== undefined && v !== "",
  );
  if (entries.length === 0) {
    return <p className="text-muted-foreground">No metadata.</p>;
  }
  return (
    <dl className="space-y-1.5">
      {entries.map(([k, v]) => (
        <div key={k} className="grid grid-cols-3 gap-2">
          <dt className="col-span-1 truncate text-muted-foreground">{k}</dt>
          <dd className="col-span-2 break-words font-mono text-[11px] text-foreground">
            {formatMetaValue(v)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function formatMetaValue(v: unknown): string {
  if (typeof v === "number") {
    // Heuristic: timestamps in seconds get rendered as ISO strings.
    if (v > 1_000_000_000 && v < 9_999_999_999) {
      try {
        return new Date(v * 1000).toISOString();
      } catch {
        return String(v);
      }
    }
    return String(v);
  }
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "true" : "false";
  return JSON.stringify(v);
}
