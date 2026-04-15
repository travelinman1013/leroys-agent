/**
 * ToolsPanel — collapsible tool reference panel.
 * Embeds in SpawnDialog and CronCreateForm so operators can browse
 * available tools while writing prompts. Each tool name has a
 * hover tooltip showing its full description from the OpenAI schema.
 *
 * Extracted from the former /tools route page.
 */

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ToolInvokeDrawer } from "@/components/ToolInvokeDrawer";

export function ToolsPanel() {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [invokeTarget, setInvokeTarget] = useState<string | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ["dashboard", "tools"],
    queryFn: api.tools,
    enabled: open,
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

  const toolCount = data?.tools.length ?? 0;

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="font-mono text-[10px] uppercase tracking-marker text-ink-muted transition-colors hover:text-oxide"
      >
        {open ? "HIDE TOOLS" : `TOOLS (${toolCount})`}
      </button>

      {open && (
        <TooltipProvider delayDuration={300}>
          <div className="mt-2 max-h-64 overflow-y-auto border border-rule bg-bg p-3">
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="grep tools…"
              className="mb-3"
            />

            {isLoading && (
              <p className="font-mono text-[11px] uppercase tracking-marker text-ink-muted">
                loading tools<span className="loading-cursor ml-2" />
              </p>
            )}

            {!isLoading && filtered.length === 0 && (
              <p className="font-mono text-[11px] text-ink-muted">
                {toolCount === 0 ? "No tools registered" : "No matches"}
              </p>
            )}

            <div className="space-y-4">
              {groups.map(([group, tools]) => (
                <section key={group}>
                  <div className="marker mb-1">
                    <span className="marker-num">
                      {String(tools.length).padStart(2, "0")}
                    </span>
                    <span>{group}</span>
                    <span className="marker-rule" />
                  </div>
                  <ul className="border-t border-rule">
                    {tools.map((t) => (
                      <ToolRow
                        key={t.name}
                        name={t.name}
                        onInvoke={() => setInvokeTarget(t.name)}
                      />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </div>
        </TooltipProvider>
      )}

      {invokeTarget && (
        <ToolInvokeDrawer
          open={!!invokeTarget}
          onOpenChange={(o) => !o && setInvokeTarget(null)}
          toolName={invokeTarget}
        />
      )}
    </div>
  );
}

function ToolRow({
  name,
  onInvoke,
}: {
  name: string;
  onInvoke: () => void;
}) {
  const [hovered, setHovered] = useState(false);

  const { data: schema, isLoading } = useQuery({
    queryKey: ["dashboard", "tool-schema", name],
    queryFn: () => api.toolSchema(name),
    enabled: hovered,
    staleTime: 60_000,
  });

  const description =
    (schema?.spec as { description?: string } | undefined)?.description ??
    null;

  return (
    <li className="flex items-center justify-between border-b border-rule px-1 py-1.5 font-mono text-[12px] tabular-nums text-ink transition-colors duration-120 ease-operator hover:bg-oxide-wash">
      <Tooltip
        onOpenChange={setHovered}
        open={hovered}
      >
        <TooltipTrigger asChild>
          <span className="cursor-default">{name}</span>
        </TooltipTrigger>
        <TooltipContent side="right" className="max-w-sm">
          {isLoading ? (
            <span className="loading-cursor" />
          ) : description ? (
            description
          ) : (
            <span className="text-ink-muted">No description</span>
          )}
        </TooltipContent>
      </Tooltip>
      <Button
        size="sm"
        variant="ghost"
        className="h-5 px-1.5 text-[9px]"
        onClick={onInvoke}
      >
        INVOKE
      </Button>
    </li>
  );
}
