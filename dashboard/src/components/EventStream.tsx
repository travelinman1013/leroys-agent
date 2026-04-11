/**
 * EventStream — Dozzle-style live-tail viewer for the dashboard event bus.
 *
 * Subscribes to /api/dashboard/events via SSE and renders a colored,
 * regex-filterable, auto-scrolling list. The buffer caps at 1000 events
 * so a long-running session doesn't blow React's render tree.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Pause, Play, Trash2, Filter } from "lucide-react";
import type { HermesEvent } from "@/lib/api";
import { subscribeEvents } from "@/lib/api";
import { cn, eventClass, eventShortLabel, relTimeFromIso } from "@/lib/utils";

const MAX_EVENTS = 1000;

type Props = {
  className?: string;
  compact?: boolean;
};

export function EventStream({ className, compact = false }: Props) {
  const [events, setEvents] = useState<HermesEvent[]>([]);
  const [filter, setFilter] = useState("");
  const [paused, setPaused] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const bufferRef = useRef<HermesEvent[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
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
  }, [paused]);

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

  // Regex filter
  const filtered = useMemo(() => {
    if (!filter.trim()) return events;
    try {
      const regex = new RegExp(filter, "i");
      return events.filter(
        (e) =>
          regex.test(e.type) ||
          regex.test(JSON.stringify(e.data)) ||
          (e.session_id && regex.test(e.session_id)),
      );
    } catch {
      // Invalid regex — fall back to substring match
      const lower = filter.toLowerCase();
      return events.filter(
        (e) =>
          e.type.toLowerCase().includes(lower) ||
          JSON.stringify(e.data).toLowerCase().includes(lower),
      );
    }
  }, [events, filter]);

  const handleClear = () => {
    bufferRef.current = [];
    setEvents([]);
  };

  return (
    <div className={cn("flex h-full flex-col", className)}>
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
            <EventRow key={`${event.ts}-${idx}`} event={event} compact={compact} />
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

function EventRow({ event, compact }: { event: HermesEvent; compact: boolean }) {
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
            <span className="mr-3 text-ink-faint">
              {String(event.session_id).slice(0, 8)}
            </span>
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
    default:
      return truncate(JSON.stringify(d), 120);
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + "…";
}

// Avoid "unused" warning on relTimeFromIso
void relTimeFromIso;
