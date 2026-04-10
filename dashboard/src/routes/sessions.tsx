import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { compactNumber, formatCost, relTimeFromUnix } from "@/lib/utils";

export const Route = createFileRoute("/sessions")({
  component: SessionsList,
});

function SessionsList() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["dashboard", "sessions", "list"],
    queryFn: () => api.sessions({ limit: 50 }),
    refetchInterval: 15_000,
  });

  const sessions = data?.sessions ?? [];

  return (
    <div className="p-6">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Sessions</h1>
        <p className="text-sm text-muted-foreground">
          Every conversation the gateway has handled, newest first.
        </p>
      </header>

      {isLoading && (
        <p className="text-sm text-muted-foreground">Loading sessions…</p>
      )}
      {error && (
        <p className="text-sm text-destructive">
          Failed to load sessions: {(error as Error).message}
        </p>
      )}

      <div className="space-y-2">
        {sessions.map((s) => (
          <Link
            key={s.id}
            to="/sessions/$id"
            params={{ id: s.id }}
            className="block"
          >
            <Card className="transition-colors hover:bg-accent/30">
              <CardContent className="flex items-center gap-4 p-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-mono text-xs text-muted-foreground">
                      {s.id.slice(0, 28)}
                    </span>
                    <Badge variant="outline" className="text-[10px]">
                      {s.source}
                    </Badge>
                    {s.model && (
                      <Badge variant="secondary" className="text-[10px]">
                        {s.model}
                      </Badge>
                    )}
                  </div>
                  <p className="mt-1 truncate text-sm">
                    {s.title || s.preview || "(no preview)"}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end text-xs">
                  <span className="font-mono text-muted-foreground">
                    {compactNumber(s.message_count)} msgs ·{" "}
                    {compactNumber((s.input_tokens ?? 0) + (s.output_tokens ?? 0))} tok
                  </span>
                  <span className="font-mono text-muted-foreground">
                    {formatCost(s.estimated_cost_usd)}
                  </span>
                  <span className="mt-0.5 text-[11px] text-muted-foreground">
                    {relTimeFromUnix(s.last_active)}
                  </span>
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      {sessions.length === 0 && !isLoading && (
        <p className="text-sm text-muted-foreground">No sessions yet.</p>
      )}
    </div>
  );
}
