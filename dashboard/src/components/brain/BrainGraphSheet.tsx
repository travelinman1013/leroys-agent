/**
 * BrainGraphSheet — the old star chart wrapped in a Sheet side panel.
 *
 * Opens from a header button. Imports the existing BrainGraph component.
 * Override Sheet content to rounded-none per DESIGN.md.
 */

import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type BrainNode } from "@/lib/api";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetBody,
} from "@/components/ui/sheet";
import { BrainGraph } from "@/components/BrainGraph";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const ALL_TYPES = new Set<BrainNode["type"]>([
  "memory",
  "session",
  "skill",
  "tool",
  "mcp",
  "cron",
]);

export function BrainGraphSheet({ open, onOpenChange }: Props) {
  const graph = useQuery({
    queryKey: ["dashboard", "brain", "graph"],
    queryFn: api.brainGraph,
    enabled: open,
    staleTime: 30_000,
  });

  const [pulses] = useState<Set<string>>(() => new Set());

  const handleNodeClick = useCallback((_node: BrainNode) => {
    // Node click in sheet is informational only for now
  }, []);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        width="w-[720px]"
        className="rounded-none"
      >
        <SheetHeader>
          <SheetTitle className="page-stamp text-[24px]">
            star <em>chart</em>
          </SheetTitle>
          <SheetDescription className="font-mono text-[10px] uppercase tracking-marker text-ink-muted">
            DETERMINISTIC SEED 0x4A &middot; DRAG TO PAN
          </SheetDescription>
        </SheetHeader>
        <SheetBody className="p-0">
          {graph.isLoading && (
            <div className="flex h-full items-center justify-center">
              <span className="font-mono text-[11px] uppercase tracking-marker text-ink-muted loading-cursor">
                loading graph
              </span>
            </div>
          )}
          {graph.error && (
            <div className="flex h-full items-center justify-center">
              <span className="font-mono text-[11px] uppercase tracking-marker text-danger">
                failed to load graph
              </span>
            </div>
          )}
          {graph.data && (
            <BrainGraph
              graph={graph.data}
              pulses={pulses}
              visibleTypes={ALL_TYPES}
              onNodeClick={handleNodeClick}
              className="h-full w-full"
            />
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
