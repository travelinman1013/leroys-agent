/**
 * BrainSourceTabs — radio buttons for vault / memories / sessions sources.
 *
 * Left pane top. Active source highlighted with oxide. Counts in
 * tabular-nums mono. 10px uppercase with tracking-marker.
 */

import { useQuery } from "@tanstack/react-query";
import { api, type BrainSource } from "@/lib/api";
import { cn } from "@/lib/utils";

type Props = {
  activeSource: string;
  onSourceChange: (source: string) => void;
};

function useBrainSources() {
  return useQuery({
    queryKey: ["dashboard", "brain", "sources"],
    queryFn: api.brainSources,
    staleTime: 60_000,
  });
}

export function BrainSourceTabs({ activeSource, onSourceChange }: Props) {
  const { data: sources, isLoading } = useBrainSources();

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-1">
        <span className="font-mono text-[10px] uppercase tracking-marker text-ink-faint loading-cursor">
          loading sources
        </span>
      </div>
    );
  }

  if (!sources || sources.length === 0) {
    return (
      <div className="py-1 font-mono text-[10px] uppercase tracking-marker text-ink-faint">
        no sources configured
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {sources.map((src: BrainSource) => {
        const active = activeSource === src.id;
        return (
          <button
            key={src.id}
            onClick={() => onSourceChange(src.id)}
            className={cn(
              "flex items-center justify-between px-2 py-1.5 text-left font-mono text-[10px] uppercase tracking-marker transition-colors duration-120 ease-operator",
              active
                ? "bg-oxide-wash text-oxide"
                : "text-ink-muted hover:text-ink",
            )}
          >
            <span>{src.label}</span>
            <span className="tabular-nums">{src.count}</span>
          </button>
        );
      })}
    </div>
  );
}
