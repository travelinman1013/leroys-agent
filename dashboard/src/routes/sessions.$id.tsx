import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ArrowLeft, User, Bot, Wrench } from "lucide-react";
import { compactNumber, formatCost, formatUnix } from "@/lib/utils";

export const Route = createFileRoute("/sessions/$id")({
  component: SessionDetail,
});

function SessionDetail() {
  const { id } = Route.useParams();
  const { data, isLoading, error } = useQuery({
    queryKey: ["dashboard", "sessions", id],
    queryFn: () => api.sessionDetail(id),
  });

  return (
    <div className="p-6">
      <Button asChild variant="ghost" size="sm" className="mb-4">
        <Link to="/sessions">
          <ArrowLeft className="size-4" />
          Back to sessions
        </Link>
      </Button>

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {error && (
        <p className="text-sm text-destructive">
          {(error as Error).message}
        </p>
      )}

      {data && <SessionBody session={data.session} messages={data.messages} />}
    </div>
  );
}

function SessionBody({
  session,
  messages,
}: {
  session: Record<string, any>;
  messages: Array<Record<string, any>>;
}) {
  return (
    <>
      <Card className="mb-4">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2">
            <span className="font-mono text-sm">{session.id}</span>
            <Badge variant="outline">{session.source}</Badge>
            {session.model && (
              <Badge variant="secondary">{session.model}</Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4 text-xs text-muted-foreground md:grid-cols-4">
          <Metric label="Started" value={formatUnix(session.started_at)} />
          <Metric
            label="Ended"
            value={session.ended_at ? formatUnix(session.ended_at) : "active"}
          />
          <Metric
            label="Messages"
            value={compactNumber(session.message_count)}
          />
          <Metric
            label="Cost"
            value={formatCost(session.estimated_cost_usd)}
          />
          <Metric
            label="Input tok"
            value={compactNumber(session.input_tokens)}
          />
          <Metric
            label="Output tok"
            value={compactNumber(session.output_tokens)}
          />
          <Metric
            label="Cache read"
            value={compactNumber(session.cache_read_tokens)}
          />
          <Metric
            label="Reasoning"
            value={compactNumber(session.reasoning_tokens)}
          />
        </CardContent>
      </Card>

      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        Transcript ({messages.length})
      </h2>
      <div className="space-y-2">
        {messages.map((m, idx) => (
          <MessageRow key={idx} message={m} />
        ))}
        {messages.length === 0 && (
          <p className="text-sm text-muted-foreground">No messages in this session.</p>
        )}
      </div>
    </>
  );
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider">{label}</div>
      <div className="text-sm font-semibold text-foreground">{value}</div>
    </div>
  );
}

function MessageRow({ message }: { message: Record<string, any> }) {
  const role = message.role || "unknown";
  const icon =
    role === "user" ? (
      <User className="size-4 text-emerald-400" />
    ) : role === "assistant" ? (
      <Bot className="size-4 text-indigo-400" />
    ) : (
      <Wrench className="size-4 text-amber-400" />
    );

  const content = message.content ?? "";
  const hasToolCalls = Boolean(message.tool_calls);
  const preview = typeof content === "string" ? content : JSON.stringify(content);

  return (
    <Card className="bg-card/40">
      <CardContent className="flex gap-3 p-4">
        <div className="mt-0.5 shrink-0">{icon}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase text-muted-foreground">
              {role}
            </span>
            {message.tool_name && (
              <Badge variant="outline" className="text-[10px]">
                {message.tool_name}
              </Badge>
            )}
            {message.token_count && (
              <span className="text-[10px] text-muted-foreground">
                {compactNumber(message.token_count)} tok
              </span>
            )}
          </div>
          {preview && (
            <pre className="mt-1 whitespace-pre-wrap break-words text-sm text-foreground/90">
              {preview}
            </pre>
          )}
          {hasToolCalls && (
            <details className="mt-2">
              <summary className="cursor-pointer text-[10px] text-muted-foreground hover:text-foreground">
                tool_calls
              </summary>
              <pre className="mt-1 whitespace-pre-wrap break-all rounded bg-black/40 p-2 text-[10px] text-muted-foreground">
                {typeof message.tool_calls === "string"
                  ? message.tool_calls
                  : JSON.stringify(message.tool_calls, null, 2)}
              </pre>
            </details>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
