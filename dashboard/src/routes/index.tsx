import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { EventStream } from "@/components/EventStream";
import { ApprovalCard } from "@/components/ApprovalCard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { relTimeFromUnix, compactNumber, formatCost } from "@/lib/utils";

export const Route = createFileRoute("/")({
  component: LiveConsole,
});

function LiveConsole() {
  return (
    <div className="flex h-full">
      {/* Main event stream */}
      <div className="flex-1 border-r">
        <div className="border-b bg-card/30 px-6 py-3">
          <h1 className="text-lg font-semibold tracking-tight">Live Console</h1>
          <p className="text-xs text-muted-foreground">
            Realtime stream of every turn, tool call, LLM call, approval, and cron tick.
          </p>
        </div>
        <div className="h-[calc(100%-64px)]">
          <EventStream />
        </div>
      </div>

      {/* Right sidebar: approvals + active sessions */}
      <aside className="w-96 shrink-0 overflow-y-auto bg-card/20 p-4">
        <ApprovalQueueSection />
        <div className="mt-6">
          <ActiveSessionsSection />
        </div>
      </aside>
    </div>
  );
}

function ApprovalQueueSection() {
  const { data } = useQuery({
    queryKey: ["dashboard", "approvals"],
    queryFn: api.approvals,
    refetchInterval: 3_000,
  });
  const pending = data?.pending ?? [];

  return (
    <section>
      <header className="mb-3 flex items-center gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Approval Queue
        </h2>
        <Badge variant={pending.length > 0 ? "warn" : "outline"}>
          {pending.length}
        </Badge>
      </header>
      {pending.length === 0 ? (
        <p className="rounded-md border border-dashed bg-card/30 px-3 py-6 text-center text-xs text-muted-foreground">
          No pending approvals
        </p>
      ) : (
        <div className="space-y-2">
          {pending.map((a, idx) => (
            <ApprovalCard key={`${a.session_key}-${idx}`} approval={a} />
          ))}
        </div>
      )}
    </section>
  );
}

function ActiveSessionsSection() {
  const { data } = useQuery({
    queryKey: ["dashboard", "state"],
    queryFn: api.state,
    refetchInterval: 5_000,
  });
  const sessions = data?.active_sessions ?? [];

  return (
    <section>
      <header className="mb-3 flex items-center gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Recent Sessions
        </h2>
        <Badge variant="outline">{sessions.length}</Badge>
      </header>
      <div className="space-y-2">
        {sessions.slice(0, 8).map((s: any) => (
          <Card key={String(s.id)} className="bg-card/40">
            <CardHeader className="p-3 pb-1.5">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="truncate text-xs font-mono">
                  {String(s.id).slice(0, 24)}
                </CardTitle>
                <Badge variant="outline" className="text-[10px]">
                  {s.source}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="p-3 pt-0">
              <p className="truncate text-[11px] text-muted-foreground">
                {s.preview || "(no preview)"}
              </p>
              <div className="mt-1 flex gap-3 text-[10px] text-muted-foreground">
                <span>{compactNumber(s.message_count)} msgs</span>
                <span>
                  {compactNumber((s.input_tokens ?? 0) + (s.output_tokens ?? 0))} tok
                </span>
                <span>{formatCost(s.estimated_cost_usd)}</span>
                <span className="ml-auto">{relTimeFromUnix(s.last_active)}</span>
              </div>
            </CardContent>
          </Card>
        ))}
        {sessions.length === 0 && (
          <p className="rounded-md border border-dashed bg-card/30 px-3 py-6 text-center text-xs text-muted-foreground">
            No active sessions
          </p>
        )}
      </div>
    </section>
  );
}
