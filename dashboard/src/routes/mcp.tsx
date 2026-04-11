import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Network } from "lucide-react";

export const Route = createFileRoute("/mcp")({
  component: MCPPage,
});

function MCPPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["dashboard", "mcp"],
    queryFn: api.mcp,
  });

  const servers = data?.servers ?? [];

  return (
    <div className="p-6">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">MCP Servers</h1>
        <p className="text-sm text-muted-foreground">
          Model Context Protocol servers configured under <code>mcp_servers</code> in config.yaml.
        </p>
      </header>

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}

      <div className="grid gap-3 md:grid-cols-2">
        {servers.map((s) => (
          <Card key={s.name}>
            <CardHeader className="pb-2">
              <div className="flex items-start justify-between gap-2">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Network className="size-4 text-sky-400" />
                  {s.name}
                </CardTitle>
                <Badge variant={s.enabled ? "success" : "outline"}>
                  {s.enabled ? "enabled" : "disabled"}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="pt-0 space-y-2">
              {s.command && (
                <pre className="rounded bg-black/40 px-2 py-1 font-mono text-[10px] text-muted-foreground">
                  {s.command}
                </pre>
              )}
              {s.env_keys.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {s.env_keys.map((k) => (
                    <Badge key={k} variant="outline" className="text-[10px]">
                      {k}
                    </Badge>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {servers.length === 0 && !isLoading && (
        <p className="text-sm text-muted-foreground">No MCP servers configured.</p>
      )}
    </div>
  );
}
