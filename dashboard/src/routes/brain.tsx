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
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, RefreshCw, X } from "lucide-react";
import {
  api,
  subscribeEvents,
  type BrainNode,
  type HermesEvent,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { BrainGraph } from "@/components/BrainGraph";
import { BrainSearchBar } from "@/components/BrainSearchBar";
import { BrainImportExportBar } from "@/components/BrainImportExportBar";
import { MemoryEditorSheet } from "@/components/MemoryEditorSheet";
import { useApiMutation } from "@/lib/mutations";
import { useConfirm } from "@/lib/confirm";

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

  // F2: search query for substring filter
  const [search, setSearch] = useState("");

  // F2: memory editor state — used for both Add and Edit modes
  const [editor, setEditor] = useState<{
    open: boolean;
    mode: "create" | "edit";
    store: "MEMORY.md" | "USER.md";
    hash?: string;
    initialContent?: string;
  }>({ open: false, mode: "create", store: "MEMORY.md" });

  const filteredGraph = useMemo(() => {
    if (!graph.data) return graph.data;
    const needle = search.trim().toLowerCase();
    if (!needle) return graph.data;
    const matchingIds = new Set<string>();
    for (const n of graph.data.nodes) {
      if (n.label.toLowerCase().includes(needle)) matchingIds.add(n.id);
    }
    return {
      ...graph.data,
      nodes: graph.data.nodes.filter((n) => matchingIds.has(n.id)),
      edges: graph.data.edges.filter(
        (e) => matchingIds.has(e.source) && matchingIds.has(e.target),
      ),
    };
  }, [graph.data, search]);

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
    <div className="flex h-full flex-col bg-bg">
      {/* Header — page stamp + ONE BIG NUMBER (node count) */}
      <header className="grid shrink-0 grid-cols-[1fr_auto] items-end gap-6 border-b border-rule px-10 pb-6 pt-9">
        <div>
          <h1 className="page-stamp text-[56px]">
            the <em>brain</em>
          </h1>
          <p className="mt-3 font-mono text-[10px] uppercase tracking-marker text-ink-muted">
            DETERMINISTIC SEED 0x4A · STAR CHART · DRAG TO PAN
          </p>
        </div>
        <div className="flex items-end gap-8">
          {stats && (
            <div className="text-right">
              <div className="font-display text-[72px] font-bold leading-none tracking-big tabular-nums text-oxide">
                {stats.memory + stats.session + stats.skill + stats.tool + stats.mcp + stats.cron}
              </div>
              <div className="mt-2 font-mono text-[10px] uppercase tracking-marker text-ink-muted">
                NODES · {stats.edges} EDGES
              </div>
            </div>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              setEditor({
                open: true,
                mode: "create",
                store: "MEMORY.md",
              })
            }
          >
            <Plus className="size-3" />
            ADD MEMORY
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => graph.refetch()}
            disabled={graph.isFetching}
            title="Refetch graph"
          >
            <RefreshCw className={cn("size-3.5", graph.isFetching && "animate-spin")} />
          </Button>
        </div>
      </header>

      <BrainImportExportBar />
      <BrainSearchBar value={search} onChange={setSearch} />

      {/* Filter chips — type/shape legend, no color */}
      <div className="flex shrink-0 items-center gap-3 border-b border-rule bg-bg-alt px-10 py-3">
        <span className="font-mono text-[10px] uppercase tracking-marker text-ink-faint">
          ─── FILTER BY TYPE ──
        </span>
        {ALL_TYPES.map((type) => {
          const active = visibleTypes.has(type);
          const count = stats?.[type] ?? 0;
          return (
            <button
              key={type}
              onClick={() => toggleType(type)}
              className={cn(
                "flex items-baseline gap-2 rounded-sm border px-2.5 py-1 font-mono text-[10px] uppercase tracking-marker transition-colors duration-120 ease-operator",
                active
                  ? "border-oxide-edge bg-oxide-wash text-oxide"
                  : "border-rule-strong text-ink-faint hover:border-oxide-edge hover:text-ink",
              )}
            >
              <span>{TYPE_LABELS[type]}</span>
              <span className="tabular-nums">{count}</span>
            </button>
          );
        })}
      </div>

      {/* Main canvas + selection drawer */}
      <div className="relative flex min-h-0 flex-1">
        <div className="relative min-h-0 flex-1">
          {graph.isLoading && (
            <div className="absolute inset-0 grid place-items-center font-mono text-[11px] uppercase tracking-marker text-ink-muted">
              loading brain snapshot
              <span className="loading-cursor ml-2" />
            </div>
          )}
          {graph.error && (
            <div className="absolute inset-0 grid place-items-center font-mono text-[11px] uppercase tracking-marker text-danger">
              failed to load: {String(graph.error)}
            </div>
          )}
          {filteredGraph && (
            <BrainGraph
              graph={filteredGraph}
              pulses={pulses}
              visibleTypes={visibleTypes}
              onNodeClick={setSelected}
              className="absolute inset-0"
            />
          )}
        </div>

        {selected && (
          <div className="w-80 shrink-0 overflow-y-auto border-l border-rule bg-bg-alt p-6">
            <BrainNodeDetailCard
              node={selected}
              onClose={() => setSelected(null)}
              onEdit={(store, hash, content) =>
                setEditor({
                  open: true,
                  mode: "edit",
                  store,
                  hash,
                  initialContent: content,
                })
              }
            />
          </div>
        )}
      </div>

      <MemoryEditorSheet
        open={editor.open}
        onOpenChange={(o) => setEditor((p) => ({ ...p, open: o }))}
        mode={editor.mode}
        store={editor.store}
        hash={editor.hash}
        initialContent={editor.initialContent}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  onEdit,
}: {
  node: BrainNode;
  onClose: () => void;
  onEdit: (store: "MEMORY.md" | "USER.md", hash: string, content: string) => void;
}) {
  const meta = node.metadata as Record<string, unknown>;
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const isMemory = node.type === "memory";

  // Memory nodes encode their store + hash in metadata: store="MEMORY.md"|"USER.md"
  // and the hash is the prefix of node.id after "memory:".
  const memoryStore: "MEMORY.md" | "USER.md" =
    (meta.store as "MEMORY.md" | "USER.md") || "MEMORY.md";
  const memoryHash = node.id.replace(/^memory:/, "");
  const memoryContent = (meta.content as string) || (meta.preview as string) || "";

  const del = useApiMutation({
    mutationFn: () => api.deleteMemory(memoryHash, memoryStore),
    successMessage: `Removed entry from ${memoryStore}`,
    onSuccess: () => {
      onClose();
      queryClient.invalidateQueries({
        queryKey: ["dashboard", "brain", "graph"],
      });
    },
  });

  return (
    <div className="border border-rule bg-bg p-5">
      <div className="flex items-start justify-between gap-2 border-b border-rule pb-3">
        <div className="min-w-0">
          <div className="font-mono text-[10px] uppercase tracking-marker text-oxide">
            {node.type}
          </div>
          <div className="mt-1 break-words font-stamp text-[28px] italic leading-tight text-ink">
            {node.label}
          </div>
        </div>
        <button
          onClick={onClose}
          className="text-ink-muted transition-colors duration-120 ease-operator hover:text-oxide"
          aria-label="close"
        >
          <X className="size-4" />
        </button>
      </div>
      <div className="mt-4 space-y-3">
        <MetadataList meta={meta} />
        {node.type === "session" && (
          <Link
            to="/sessions/$id"
            params={{ id: node.id.replace(/^session:/, "") }}
            className="inline-flex items-center font-mono text-[11px] uppercase tracking-marker text-oxide transition-colors duration-120 ease-operator hover:text-oxide-hover"
          >
            VIEW TRANSCRIPT →
          </Link>
        )}
        {isMemory && (
          <div className="flex items-center gap-2 pt-3">
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                onEdit(memoryStore, memoryHash, memoryContent)
              }
            >
              EDIT
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={async () => {
                const ok = await confirm({
                  title: "Delete memory entry?",
                  description: "Cannot be undone.",
                  destructive: true,
                  confirmLabel: "DELETE",
                });
                if (ok) del.mutate();
              }}
              disabled={del.isPending}
            >
              DELETE
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function MetadataList({ meta }: { meta: Record<string, unknown> }) {
  const entries = Object.entries(meta).filter(
    ([, v]) => v !== null && v !== undefined && v !== "",
  );
  if (entries.length === 0) {
    return (
      <p className="font-mono text-[10px] uppercase tracking-marker text-ink-faint">
        no metadata
      </p>
    );
  }
  return (
    <dl className="space-y-1.5">
      {entries.map(([k, v]) => (
        <div key={k} className="grid grid-cols-3 gap-3 border-b border-rule/60 py-1">
          <dt className="col-span-1 truncate font-mono text-[10px] uppercase tracking-marker text-ink-muted">
            {k}
          </dt>
          <dd className="col-span-2 break-words font-mono text-[11px] tabular-nums text-ink">
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
