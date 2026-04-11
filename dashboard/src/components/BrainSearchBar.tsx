/**
 * F2 — Brain node search box.
 *
 * Frontend-only substring filter against node labels. Both stores
 * total ~3,500 chars across all nodes — no backend search route is
 * needed (validator finding #4).
 */

import { Input } from "@/components/ui/input";

export function BrainSearchBar({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <div className="flex items-center gap-3 border-b border-rule px-10 py-3">
      <span className="font-mono text-[10px] uppercase tracking-marker text-ink-faint">
        ─── SEARCH NODES ──
      </span>
      <Input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="filter by label…"
        className="h-8 max-w-xs"
      />
    </div>
  );
}
