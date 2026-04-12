/**
 * BrainTimeline — chronological feed in the sidebar.
 *
 * Groups entries by day with UPPERCASE day headers (10px, tracking-marker).
 * Entries are 13px mono with relative timestamps. Memory events use
 * font-variant: small-caps per DESIGN.md.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { api, type BrainTimelineEntry } from "@/lib/api";
import { compactRelTimeFromUnix } from "@/lib/utils";
import { SectionMarker } from "./SectionMarker";

type Props = {
  source?: string;
  onSelect?: (source: string, path: string) => void;
};

type DayGroup = {
  day: string;
  entries: BrainTimelineEntry[];
};

export function BrainTimeline({ source, onSelect }: Props) {
  const timeline = useQuery({
    queryKey: ["dashboard", "brain", "timeline", source ?? "all"],
    queryFn: () => api.brainTimeline(undefined, 100),
    staleTime: 30_000,
  });

  const groups = useMemo<DayGroup[]>(() => {
    if (!timeline.data) return [];
    const entries = source
      ? timeline.data.filter((e) => e.source === source)
      : timeline.data;

    const map = new Map<string, BrainTimelineEntry[]>();
    for (const entry of entries) {
      const day = format(new Date(entry.ts * 1000), "yyyy-MM-dd");
      const existing = map.get(day);
      if (existing) {
        existing.push(entry);
      } else {
        map.set(day, [entry]);
      }
    }
    return Array.from(map.entries()).map(([day, dayEntries]) => ({
      day,
      entries: dayEntries,
    }));
  }, [timeline.data, source]);

  if (timeline.isLoading) {
    return (
      <div className="px-2 py-2 font-mono text-[10px] uppercase tracking-marker text-ink-faint loading-cursor">
        loading timeline
      </div>
    );
  }

  if (groups.length === 0) {
    return (
      <div className="px-2 py-2 font-mono text-[10px] uppercase tracking-marker text-ink-faint">
        no recent activity
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {groups.map((group) => {
        const dayLabel = format(new Date(group.day), "EEE, MMM d").toUpperCase();
        return (
          <div key={group.day}>
            <SectionMarker label={dayLabel} className="mb-1" />
            <div className="space-y-0.5">
              {group.entries.map((entry, i) => {
                const isMemory = entry.source === "memories";
                return (
                  <button
                    key={`${entry.path}-${entry.ts}-${i}`}
                    onClick={() => onSelect?.(entry.source, entry.path)}
                    className="flex w-full items-baseline gap-2 px-2 py-1 text-left font-mono text-[13px] transition-colors duration-120 ease-operator hover:bg-surface"
                  >
                    <span className="shrink-0 tabular-nums text-[10px] text-ink-faint">
                      {compactRelTimeFromUnix(entry.ts)}
                    </span>
                    <span className="shrink-0 text-[10px] uppercase tracking-marker text-ink-muted">
                      {entry.op}
                    </span>
                    <span
                      className="min-w-0 truncate text-ink-2"
                      style={isMemory ? { fontVariant: "small-caps" } : undefined}
                    >
                      {entry.title || entry.path}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
