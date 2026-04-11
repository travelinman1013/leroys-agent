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
import { Badge } from "@/components/ui/badge";
import { Pause, Play, Trash2, Filter } from "lucide-react";
import type { HermesEvent } from "@/lib/api";
import { subscribeEvents } from "@/lib/api";
import { cn, eventColorClass, relTimeFromIso } from "@/lib/utils";

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
      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <div className="relative flex-1">
          <Filter className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by regex or substring…"
            className="h-8 pl-8 text-xs"
          />
        </div>
        <Badge variant="outline" className="font-mono">
          {filtered.length}
          {filtered.length !== events.length && ` / ${events.length}`}
        </Badge>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={() => setPaused((p) => !p)}
          title={paused ? "Resume" : "Pause"}
        >
          {paused ? <Play className="size-4" /> : <Pause className="size-4" />}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={handleClear}
          title="Clear"
        >
          <Trash2 className="size-4" />
        </Button>
      </div>

      {/* Stream */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto bg-black/20 font-mono text-xs"
        onScroll={(e) => {
          const el = e.currentTarget;
          const atBottom =
            el.scrollHeight - el.scrollTop - el.clientHeight < 50;
          setAutoScroll(atBottom);
        }}
      >
        {filtered.length === 0 && (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <span>Waiting for events…</span>
          </div>
        )}
        <ul className="divide-y divide-border/40">
          {filtered.map((event, idx) => (
            <EventRow key={`${event.ts}-${idx}`} event={event} compact={compact} />
          ))}
        </ul>
      </div>

      {/* Pause hint */}
      {paused && (
        <div className="border-t bg-amber-950/30 px-3 py-1 text-[10px] font-medium text-amber-300">
          Paused — new events buffered in the background.
        </div>
      )}
    </div>
  );
}

function EventRow({ event, compact }: { event: HermesEvent; compact: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const colorClass = eventColorClass(event.type);
  const hasData = event.data && Object.keys(event.data).length > 0;

  return (
    <li
      className={cn(
        "event-stream-line cursor-pointer px-3 py-1 hover:bg-white/5",
        expanded && "bg-white/5",
      )}
      onClick={() => setExpanded((x) => !x)}
    >
      <div className="flex items-start gap-2">
        <span className="w-20 shrink-0 text-[10px] text-muted-foreground">
          {new Date(event.ts).toLocaleTimeString(undefined, {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          })}
        </span>
        <span className={cn("w-40 shrink-0 font-semibold", colorClass)}>
          {event.type}
        </span>
        {!compact && event.session_id && (
          <span className="w-36 shrink-0 truncate text-[10px] text-muted-foreground">
            {event.session_id}
          </span>
        )}
        <span className="flex-1 truncate text-muted-foreground">
          {summarizeData(event)}
        </span>
      </div>
      {expanded && hasData && (
        <pre className="mt-1 whitespace-pre-wrap break-all rounded bg-black/40 p-2 text-[10px] text-muted-foreground">
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
