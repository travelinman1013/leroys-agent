import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Wrench } from "lucide-react";

export const Route = createFileRoute("/tools")({
  component: ToolsPage,
});

function ToolsPage() {
  const [filter, setFilter] = useState("");
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

  // Group by toolset
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
    <div className="p-6">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Tools</h1>
        <p className="text-sm text-muted-foreground">
          {data?.tools.length ?? 0} tools registered in the agent's tool registry.
        </p>
      </header>

      <Input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter tools…"
        className="mb-6 max-w-md"
      />

      {isLoading && (
        <p className="text-sm text-muted-foreground">Loading tools…</p>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {groups.map(([group, tools]) => (
          <Card key={group}>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Wrench className="size-4 text-blue-400" />
                {group}
                <Badge variant="outline" className="ml-auto">
                  {tools.length}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <ul className="space-y-1">
                {tools.map((t) => (
                  <li
                    key={t.name}
                    className="font-mono text-xs text-muted-foreground"
                  >
                    {t.name}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
