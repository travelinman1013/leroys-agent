/**
 * F1 — Bulk actions bar shown above the sessions table when one or
 * more rows are selected.
 */

import { Button } from "@/components/ui/button";

export function BulkActionsBar({
  selectedCount,
  onDelete,
  onExport,
  onClear,
}: {
  selectedCount: number;
  onDelete: () => void;
  onExport: () => void;
  onClear: () => void;
}) {
  if (selectedCount === 0) return null;
  return (
    <div className="flex items-center justify-between border-b border-rule bg-bg-alt px-10 py-2 font-mono text-[10px] uppercase tracking-marker text-ink">
      <div>
        <span className="text-oxide tabular-nums">{selectedCount}</span>{" "}
        SELECTED
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={onExport}>
          EXPORT
        </Button>
        <Button size="sm" variant="destructive" onClick={onDelete}>
          DELETE
        </Button>
        <Button size="sm" variant="ghost" onClick={onClear}>
          CLEAR
        </Button>
      </div>
    </div>
  );
}
