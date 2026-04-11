/**
 * F1 — Session list filters: search box, source dropdown, date range.
 * Operator's Desk: dense, mono labels, hairline borders.
 */

import React, { useState } from "react";
import { Input } from "@/components/ui/input";

export interface SessionFilterState {
  q: string;
  source: string;
  fromDays: number; // 0 = no filter
}

export function SessionFilters({
  value,
  onChange,
}: {
  value: SessionFilterState;
  onChange: (next: SessionFilterState) => void;
}) {
  const [localQ, setLocalQ] = useState(value.q);

  // Debounce the q text input so we don't fire one query per keystroke.
  React.useEffect(() => {
    const t = setTimeout(() => {
      if (localQ !== value.q) onChange({ ...value, q: localQ });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localQ]);

  return (
    <div className="grid grid-cols-[1fr_auto_auto] gap-3 border-b border-rule px-10 py-4">
      <Input
        type="search"
        value={localQ}
        onChange={(e) => setLocalQ(e.target.value)}
        placeholder="search title…"
        className="h-8 max-w-md"
      />
      <select
        value={value.source}
        onChange={(e) => onChange({ ...value, source: e.target.value })}
        className="h-8 border border-rule bg-bg px-2 font-mono text-[10px] uppercase tracking-marker text-ink"
      >
        <option value="">all sources</option>
        <option value="cli">cli</option>
        <option value="gateway">gateway</option>
        <option value="discord">discord</option>
        <option value="telegram">telegram</option>
        <option value="dashboard">dashboard</option>
      </select>
      <select
        value={String(value.fromDays)}
        onChange={(e) =>
          onChange({ ...value, fromDays: Number(e.target.value) })
        }
        className="h-8 border border-rule bg-bg px-2 font-mono text-[10px] uppercase tracking-marker text-ink"
      >
        <option value="0">all time</option>
        <option value="1">1d</option>
        <option value="7">7d</option>
        <option value="30">30d</option>
        <option value="90">90d</option>
      </select>
    </div>
  );
}
