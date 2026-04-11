/**
 * /tools — dense list of registered tools, grouped by toolset.
 * Operator's Desk: hairline rows, mono ink, no card chrome.
 */

import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { api } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ToolInvokeDrawer } from "@/components/ToolInvokeDrawer";

export const Route = createFileRoute("/tools")({
  component: ToolsPage,
});

function ToolsPage() {
  const [filter, setFilter] = useState("");
  const [invokeTarget, setInvokeTarget] = useState<string | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ["dashboard", "tools"],
    queryFn: api.tools,
  });

  const filtered = useMemo(() => {
    const tools = data?.tools ?? [];
    if (!filter.trim()) return tools;
    const q = filter.toLowerCase();
    return tools.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        (t.toolset?.toLowerCase().includes(q) ?? false),
    );
  }, [data, filter]);

  const groups = useMemo(() => {
    const map = new Map<string, typeof filtered>();
    for (const t of filtered) {
      const key = t.toolset || "(ungrouped)";
      const existing = map.get(key) || [];
      existing.push(t);
      map.set(key, existing);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  return (
    <div className="bg-bg">
      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-6 border-b border-rule bg-bg-alt px-10 py-4 font-mono text-[10px] uppercase tracking-marker text-ink-muted">
        <div className="text-ink">TOOLS</div>
        <div className="flex items-center justify-center gap-7">
          <Meter label="Registered" value={String(data?.tools.length ?? 0)} />
          <Meter label="Filtered" value={String(filtered.length)} />
          <Meter label="Toolsets" value={String(groups.length)} />
        </div>
        <div className="text-ink-faint">REGISTRY</div>
      </div>

      <div className="px-10 pb-6 pt-9">
        <h1 className="page-stamp text-[56px]">
          tool <em>registry</em>
        </h1>
        <p className="mt-3 font-mono text-[10px] uppercase tracking-marker text-ink-muted">
          ─── HAIRLINE ROWS · GROUPED BY TOOLSET ──
        </p>
      </div>

      <div className="px-10 pb-16">
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="grep tools…"
          className="mb-8 max-w-md"
        />

        {isLoading && (
          <p className="font-mono text-[11px] uppercase tracking-marker text-ink-muted">
            loading tools<span className="loading-cursor ml-2" />
          </p>
        )}

        {invokeTarget && (
          <ToolInvokeDrawer
            open={!!invokeTarget}
            onOpenChange={(o) => !o && setInvokeTarget(null)}
            toolName={invokeTarget}
          />
        )}

        <div className="space-y-10">
          {groups.map(([group, tools]) => (
            <section key={group}>
              <div className="marker mb-3">
                <span className="marker-num">
                  {String(tools.length).padStart(2, "0")}
                </span>
                <span>{group}</span>
                <span className="marker-rule" />
              </div>
              <ul className="border-t border-rule">
                {tools.map((t) => (
                  <li
                    key={t.name}
                    className="flex items-center justify-between border-b border-rule px-1 py-2 font-mono text-[12px] tabular-nums text-ink transition-colors duration-120 ease-operator hover:bg-oxide-wash"
                  >
                    <span>{t.name}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setInvokeTarget(t.name)}
                    >
                      INVOKE
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

function Meter({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-baseline gap-2">
      <span>{label}</span>
      <span className="text-ink tabular-nums">{value}</span>
    </span>
  );
}
