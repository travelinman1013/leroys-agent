/**
 * EventStream — Dozzle-style live-tail viewer for the dashboard event bus.
 *
 * Subscribes to /api/dashboard/events via SSE and renders a colored,
 * regex-filterable, auto-scrolling list. The buffer caps at 1000 events
 * so a long-running session doesn't blow React's render tree.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Pause, Play, Trash2, Filter, Download } from "lucide-react";
import type { HermesEvent } from "@/lib/api";
import { subscribeEvents, api } from "@/lib/api";
import { cn, eventClass, eventShortLabel, relTimeFromIso } from "@/lib/utils";

const MAX_EVENTS = 1000;

const TIME_WINDOWS = [
  { label: "1H", seconds: 3600 },
  { label: "6H", seconds: 21600 },
  { label: "24H", seconds: 86400 },
  { label: "LIVE", seconds: 0 },
] as const;

type TimeWindowLabel = (typeof TIME_WINDOWS)[number]["label"];

const EVENT_CATEGORIES = [
  { label: "TURN", patterns: ["turn.started", "turn.ended"] },
  { label: "TOOL", patterns: ["tool.invoked", "tool.completed"] },
  { label: "LLM", patterns: ["llm.call"] },
  { label: "APPROVAL", patterns: ["approval.requested", "approval.resolved"] },
  { label: "COMPACT", patterns: ["compaction"] },
  { label: "CRON", patterns: ["cron.fired"] },
  { label: "SESSION", patterns: ["session.started", "session.ended", "session.spawned", "session.killed", "session.forked", "session.injected", "session.deleted", "session.exported", "session.reopened", "session.budget_exceeded"] },
  { label: "WORKFLOW", patterns: ["workflow.started", "workflow.state_changed", "workflow.completed", "workflow.step_error", "workflow.checkpoint_written", "workflow.file_change"] },
  { label: "MEMORY", patterns: ["memory.added", "memory.replaced", "memory.removed"] },
] as const;

type CategoryLabel = (typeof EVENT_CATEGORIES)[number]["label"];

type Props = {
  className?: string;
  compact?: boolean;
};

export function EventStream({ className, compact = false }: Props) {
  const [events, setEvents] = useState<HermesEvent[]>([]);
  const [filter, setFilter] = useState("");
  const [paused, setPaused] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [activeCats, setActiveCats] = useState<Set<CategoryLabel>>(
    () => new Set(EVENT_CATEGORIES.map((c) => c.label)),
  );
  const [timeWindow, setTimeWindow] = useState<TimeWindowLabel>("LIVE");
  const bufferRef = useRef<HermesEvent[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  const isCatActive = (label: CategoryLabel) => activeCats.has(label);
  const toggleCat = (label: CategoryLabel) =>
    setActiveCats((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });

  const matchesActiveCats = (type: string) => {
    for (const cat of EVENT_CATEGORIES) {
      if (cat.patterns.some((p) => type === p || type.startsWith(p))) {
        return activeCats.has(cat.label);
      }
    }
    return true; // unrecognized event types always pass
  };

  const isLive = timeWindow === "LIVE";

  // F12: Fetch historical events for non-live time windows
  useEffect(() => {
    if (isLive) return;
    let cancelled = false;
    const win = TIME_WINDOWS.find((w) => w.label === timeWindow);
    if (!win || win.seconds === 0) return;
    const from = Math.floor(Date.now() / 1000) - win.seconds;
    api.searchEvents({ from, limit: 1000 }).then((res) => {
      if (cancelled) return;
      setEvents(res.events ?? []);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [timeWindow, isLive]);

  // SSE subscription for live mode only
  useEffect(() => {
    if (!isLive) return;
    let cancelled = false;
    const cleanup = subscribeEvents(
      (event) => {
        if (cancelled) return;
        bufferRef.current = [...bufferRef.current, event].slice(-MAX_EVENTS);
        if (!paused) setEvents(bufferRef.current);
      },
      { replay: 100 },
    );
    return () => {
      cancelled = true;
      cleanup();
    };
  }, [paused, isLive]);

  // Sync the visible list when paused state flips off
  useEffect(() => {
    if (!paused) setEvents(bufferRef.current);
  }, [paused]);

  // Auto-scroll to bottom on new events
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events.length, autoScroll]);

  // Per-category live counts. Each event is counted against the
  // first category whose pattern list matches (patterns are
  // mutually exclusive in practice — a `tool.*` event never also
  // starts with `memory.`). Unrecognized types don't count against
  // any category, matching the behavior of `matchesActiveCats`.
  // Displayed inside each chip so the operator can see "where the
  // noise is coming from" without toggling chips on and off.
  const catCounts = useMemo(() => {
    const counts = new Map<CategoryLabel, number>();
    for (const cat of EVENT_CATEGORIES) counts.set(cat.label, 0);
    for (const e of events) {
      for (const cat of EVENT_CATEGORIES) {
        if (cat.patterns.some((p) => e.type === p || e.type.startsWith(p))) {
          counts.set(cat.label, (counts.get(cat.label) ?? 0) + 1);
          break;
        }
      }
    }
    return counts;
  }, [events]);

  // Filter pipeline: chip categories → text/regex
  const filtered = useMemo(() => {
    let base = events.filter((e) => matchesActiveCats(e.type));
    if (!filter.trim()) return base;
    try {
      const regex = new RegExp(filter, "i");
      return base.filter(
        (e) =>
          regex.test(e.type) ||
          regex.test(JSON.stringify(e.data)) ||
          (e.session_id && regex.test(e.session_id)),
      );
    } catch {
      const lower = filter.toLowerCase();
      return base.filter(
        (e) =>
          e.type.toLowerCase().includes(lower) ||
          JSON.stringify(e.data).toLowerCase().includes(lower),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, filter, activeCats]);

  const handleClear = () => {
    bufferRef.current = [];
    setEvents([]);
  };

  return (
    <div className={cn("flex h-full flex-col", className)}>
      {/* Chip filter row — each chip shows its live count so the
          operator can see which category is dominating the buffer
          without toggling others off (matches the /brain route's
          "160 NODES · 9 EDGES" stamp pattern per DESIGN.md §6). */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-rule px-4 py-2">
        {EVENT_CATEGORIES.map((cat) => {
          const active = isCatActive(cat.label);
          const count = catCounts.get(cat.label) ?? 0;
          return (
            <button
              key={cat.label}
              type="button"
              onClick={() => toggleCat(cat.label)}
              aria-pressed={active}
              className={cn(
                "inline-flex items-baseline gap-1.5 border px-2 py-0.5 font-mono text-[10px] uppercase tracking-marker transition-colors duration-120 ease-operator",
                active
                  ? "border-oxide-edge bg-oxide-wash text-oxide"
                  : "border-rule-strong text-ink-faint hover:border-oxide-edge hover:text-ink",
              )}
            >
              <span>{cat.label}</span>
              <span
                className={cn(
                  "tabular-nums",
                  active ? "text-oxide-deep" : "text-ink-faint",
                )}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>
      {/* F12: Time window pill bar */}
      <div className="flex items-center gap-1.5 border-b border-rule px-4 py-2">
        {TIME_WINDOWS.map((tw) => (
          <button
            key={tw.label}
            type="button"
            onClick={() => {
              setTimeWindow(tw.label);
              if (tw.label === "LIVE") {
                // Reset buffer so SSE starts fresh
                bufferRef.current = [];
                setEvents([]);
              }
            }}
            className={cn(
              "border px-2 py-0.5 font-mono text-[10px] uppercase tracking-marker transition-colors duration-120 ease-operator",
              timeWindow === tw.label
                ? "border-oxide-edge bg-oxide-wash text-oxide"
                : "border-rule-strong text-ink-faint hover:border-oxide-edge hover:text-ink",
            )}
          >
            {tw.label}
          </button>
        ))}
        {!isLive && (
          <span className="ml-2 font-mono text-[10px] uppercase tracking-marker text-ink-faint">
            HISTORICAL
          </span>
        )}
      </div>
      {/* Toolbar — hairline rule, mono, no chrome */}
      <div className="flex items-center gap-3 border-b border-rule px-4 py-2.5">
        <div className="relative flex-1">
          <Filter className="absolute left-2.5 top-1/2 size-3 -translate-y-1/2 text-ink-muted" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="grep events…"
            className="h-7 border-rule-strong bg-bg-alt pl-7 font-mono text-[11px] text-ink placeholder:text-ink-faint focus-visible:border-oxide focus-visible:ring-0"
          />
        </div>
        <span className="font-mono text-[10px] uppercase tracking-marker text-ink-muted tabular-nums">
          {filtered.length}
          {filtered.length !== events.length && ` / ${events.length}`}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-ink-muted hover:text-oxide"
          asChild
          title="Export filtered events as NDJSON (1h window)"
        >
          <a
            href={api.exportEventsUrl({
              from: Math.floor(Date.now() / 1000) - 3600,
            })}
            target="_blank"
            rel="noreferrer"
          >
            <Download className="size-3.5" />
          </a>
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-ink-muted hover:text-oxide"
          onClick={() => setPaused((p) => !p)}
          title={paused ? "Resume" : "Pause"}
        >
          {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-ink-muted hover:text-oxide"
          onClick={handleClear}
          title="Clear"
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>

      {/* Stream */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto bg-bg-alt"
        onScroll={(e) => {
          const el = e.currentTarget;
          const atBottom =
            el.scrollHeight - el.scrollTop - el.clientHeight < 50;
          setAutoScroll(atBottom);
        }}
      >
        {filtered.length === 0 && (
          <div className="flex h-full items-center justify-center font-mono text-[11px] uppercase tracking-marker text-ink-faint">
            <span>
              waiting for events
              <span className="loading-cursor" />
            </span>
          </div>
        )}
        <ul>
          {filtered.map((event, idx) => (
            <EventRow
              key={`${event.ts}-${idx}`}
              event={event}
              compact={compact}
              onSessionClick={(sid) => navigate({ to: "/sessions/$id", params: { id: sid } })}
            />
          ))}
        </ul>
      </div>

      {/* Pause hint */}
      {paused && (
        <div className="border-t border-rule bg-oxide-wash px-4 py-1.5 font-mono text-[10px] uppercase tracking-marker text-oxide">
          Paused · events buffered in background
        </div>
      )}
    </div>
  );
}

function EventRow({
  event,
  compact,
  onSessionClick,
}: {
  event: HermesEvent;
  compact: boolean;
  onSessionClick?: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const evtCls = eventClass(event.type);
  const label = eventShortLabel(event.type);
  const hasData = event.data && Object.keys(event.data).length > 0;

  return (
    <li
      className={cn(
        "event-stream-line cursor-pointer border-b border-rule/60 px-4 py-1.5 transition-colors duration-120 ease-operator hover:bg-oxide-wash",
        expanded && "bg-oxide-wash",
        evtCls,
      )}
      onClick={() => setExpanded((x) => !x)}
    >
      <div className="grid grid-cols-[80px_72px_1fr] items-baseline gap-3 font-mono text-[12px] leading-relaxed">
        <span className="text-ink-faint tabular-nums">
          {new Date(event.ts).toLocaleTimeString(undefined, {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
          })}
        </span>
        <span className="evt-label">{label}</span>
        <span className="evt-body truncate">
          {!compact && event.session_id && (
            <button
              type="button"
              className="mr-3 text-ink-faint hover:text-oxide"
              onClick={(e) => {
                e.stopPropagation();
                onSessionClick?.(event.session_id!);
              }}
              title="Open session"
            >
              {String(event.session_id).slice(0, 8)}
            </button>
          )}
          {summarizeData(event)}
        </span>
      </div>
      {expanded && hasData && (
        <pre className="mt-1.5 ml-[160px] whitespace-pre-wrap break-all border-l border-rule pl-3 font-mono text-[10px] text-ink-muted">
          {JSON.stringify(event.data, null, 2)}
        </pre>
      )}
    </li>
  );
}

function summarizeData(event: HermesEvent): string {
  const d = event.data;
  if (!d) return "";
  // Per-type human-readable summary
  switch (event.type) {
    case "tool.invoked":
      return `${d.tool}  args=${truncate(JSON.stringify(d.args_preview), 80)}`;
    case "tool.completed":
      return `${d.tool}  ${d.ok ? "✓" : "✗"}  ${d.latency_ms}ms`;
    case "approval.requested":
      return truncate(String(d.command || ""), 120);
    case "approval.resolved":
      return `${d.choice}  →  ${truncate(String(d.command || ""), 80)}`;
    case "turn.started":
      return truncate(String(d.message_preview || ""), 120);
    case "turn.ended":
      return `iterations=${d.iterations}  duration=${d.duration_ms}ms`;
    case "compaction":
      return `${d.phase}  ${d.tokens_before} → ${d.tokens_after || "…"}  tokens`;
    case "cron.fired":
      return `[${d.phase}]  ${d.job_name}`;
    case "session.started":
      return `${d.platform}  ${d.chat_type}`;
    case "session.ended":
      return String(d.reason || "ended");
    case "session.spawned":
      return `${d.source || "dashboard"}  ${truncate(String(d.message_preview || ""), 80)}`;
    case "session.killed":
      return String(d.reason || "killed");
    case "session.budget_exceeded":
      return `$${Number(d.estimated_cost || 0).toFixed(2)} > $${Number(d.budget_cap || 0).toFixed(2)} cap`;
    case "llm.call":
      return `${d.model || "?"}  ${d.input_tokens || 0}→${d.output_tokens || 0} tok  ${d.latency_ms || 0}ms`;
    case "memory.added":
    case "memory.replaced":
    case "memory.removed":
      return truncate(String(d.key || d.content || ""), 80);
    case "skill.installed":
    case "skill.removed":
    case "skill.reloaded":
      return String(d.name || d.skill || "");
    case "mcp.connected":
    case "mcp.disconnected":
      return String(d.server || d.name || "");
    default: {
      // Workflow events — extract human-readable parts
      if (event.type.startsWith("workflow.") || d.workflow_id) {
        const wf = String(d.workflow_id || d.workflow_name || "");
        const step = d.step_name ? ` → ${d.step_name}` : "";
        const status = d.status ? `  [${d.status}]` : "";
        const phase = d.phase ? `  (${d.phase})` : "";
        return `${wf}${step}${status}${phase}`;
      }
      // File change events from watcher
      if (d.path) {
        const p = String(d.path);
        const short = p.includes("/") ? p.split("/").slice(-2).join("/") : p;
        const evtType = d.event_type ? ` [${d.event_type}]` : "";
        return `${short}${evtType}`;
      }
      return truncate(JSON.stringify(d), 120);
    }
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + "…";
}

// Avoid "unused" warning on relTimeFromIso
void relTimeFromIso;
