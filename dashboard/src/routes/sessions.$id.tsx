/**
 * /sessions/$id — Operator's Desk editorial transcript.
 *
 * 100px gutter for timestamp + speaker, body in Söhne, tool calls as
 * oxide-edged callouts, tool output in left-bordered mono blocks. Lab
 * notebook layout. See DESIGN.md §6 row `/sessions/$id` and preview §06.
 */

import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { ArrowLeft, GitBranch } from "lucide-react";
import { compactNumber, formatCost, formatUnix } from "@/lib/utils";
import { useApiMutation } from "@/lib/mutations";
import { useConfirm } from "@/lib/confirm";
import { ForkDialog } from "@/components/ForkDialog";
import { InjectComposer } from "@/components/InjectComposer";

export const Route = createFileRoute("/sessions/$id")({
  component: SessionDetail,
});

function SessionDetail() {
  const { id } = Route.useParams();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["dashboard", "sessions", id],
    queryFn: () => api.sessionDetail(id),
  });

  return (
    <div className="bg-bg">
      <div className="border-b border-rule px-10 pt-7">
        <Button asChild variant="ghost" size="sm" className="-ml-2 mb-3">
          <Link to="/sessions">
            <ArrowLeft className="size-3" />
            BACK TO SESSIONS
          </Link>
        </Button>
      </div>

      {isLoading && (
        <p className="px-10 py-12 font-mono text-[11px] uppercase tracking-marker text-ink-muted">
          loading transcript
          <span className="loading-cursor ml-2" />
        </p>
      )}
      {error && (
        <p className="px-10 py-12 font-mono text-[11px] uppercase tracking-marker text-danger">
          {(error as Error).message}
        </p>
      )}

      {data && (
        <SessionBody
          sessionId={id}
          session={data.session as Record<string, any>}
          messages={data.messages as Array<Record<string, any>>}
          refetch={refetch}
        />
      )}
    </div>
  );
}

function SessionBody({
  sessionId,
  session,
  messages,
  refetch,
}: {
  sessionId: string;
  session: Record<string, any>;
  messages: Array<Record<string, any>>;
  refetch: () => void;
}) {
  const id = String(session.id ?? sessionId);
  const navigate = useNavigate();
  const confirm = useConfirm();
  const isEnded = session.ended_at != null;

  const [forkDialog, setForkDialog] = useState<{ open: boolean; turnIdx: number }>({
    open: false,
    turnIdx: 0,
  });

  const fork = useApiMutation({
    mutationFn: ({ turnIdx, title }: { turnIdx: number; title: string }) =>
      api.forkSession(id, {
        up_to_turn: turnIdx,
        title: title || undefined,
      }),
    successMessage: "Forked",
    onSuccess: (data) => {
      setForkDialog({ open: false, turnIdx: 0 });
      navigate({ to: "/sessions/$id", params: { id: data.id } });
    },
  });

  const inject = useApiMutation({
    mutationFn: (content: string) => api.injectMessage(id, { content }),
    successMessage: "Message injected — session reopened",
    onSuccess: () => refetch(),
  });

  const reopen = useApiMutation({
    mutationFn: () => api.reopenSession(id),
    successMessage: "Session reopened",
    onSuccess: () => refetch(),
  });

  const del = useApiMutation({
    mutationFn: () => api.deleteSession(id),
    successMessage: "Deleted",
    onSuccess: () => navigate({ to: "/sessions" }),
  });
  const title = session.title || session.preview || "untitled session";
  const startedAt = session.started_at;
  const startedDate = startedAt
    ? new Date(startedAt * 1000).toLocaleDateString(undefined, {
        month: "short",
        day: "2-digit",
      })
    : null;
  const startedTime = startedAt
    ? new Date(startedAt * 1000).toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : null;

  return (
    <article className="px-10 pb-24 pt-6">
      {/* ── editorial head ── */}
      <header className="mb-9 grid grid-cols-[100px_1fr_auto] items-baseline gap-6 border-b border-rule pb-7">
        <span className="font-mono text-[10px] uppercase tracking-label text-ink-faint">
          {id.slice(0, 8)}
        </span>
        <h1 className="font-stamp text-[36px] italic leading-tight text-ink">
          "{title}"
        </h1>
        <div className="text-right font-mono text-[10px] uppercase leading-relaxed tracking-label text-ink-muted">
          {startedTime && (
            <>
              {startedTime} CT · {startedDate}
              <br />
            </>
          )}
          {session.model && <>{String(session.model).toUpperCase()}<br /></>}
          MSGS{" "}
          <span className="text-oxide tabular-nums">
            {compactNumber(session.message_count)}
          </span>
        </div>
      </header>

      {/* ── F1 actions ── */}
      <div className="mb-9 flex flex-wrap items-center gap-2">
        <Button asChild size="sm" variant="outline">
          <a href={api.exportSessionUrl(id, "json")} target="_blank" rel="noreferrer">
            EXPORT JSON
          </a>
        </Button>
        <Button asChild size="sm" variant="outline">
          <a href={api.exportSessionUrl(id, "md")} target="_blank" rel="noreferrer">
            EXPORT MD
          </a>
        </Button>
        {isEnded && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => reopen.mutate()}
            disabled={reopen.isPending}
          >
            {reopen.isPending ? "REOPENING…" : "REOPEN"}
          </Button>
        )}
        <Button
          size="sm"
          variant="destructive"
          onClick={async () => {
            const ok = await confirm({
              title: `Delete ${id.slice(0, 8)}?`,
              description: "Cannot be undone. Child sessions will be orphaned.",
              destructive: true,
              confirmLabel: "DELETE",
            });
            if (ok) del.mutate();
          }}
          disabled={del.isPending}
        >
          DELETE
        </Button>
      </div>

      {/* ── meters strip ── */}
      <div className="mb-10 grid grid-cols-2 gap-x-10 gap-y-3 border-b border-rule pb-6 md:grid-cols-4">
        <Metric
          label="Started"
          value={session.started_at ? formatUnix(session.started_at) : "—"}
        />
        <Metric
          label="Ended"
          value={session.ended_at ? formatUnix(session.ended_at) : "active"}
        />
        <Metric
          label="In tok"
          value={compactNumber(session.input_tokens)}
        />
        <Metric
          label="Out tok"
          value={compactNumber(session.output_tokens)}
        />
        <Metric
          label="Cache"
          value={compactNumber(session.cache_read_tokens)}
        />
        <Metric
          label="Reason"
          value={compactNumber(session.reasoning_tokens)}
        />
        <Metric label="Cost" value={formatCost(session.estimated_cost_usd)} />
        <Metric label="Source" value={String(session.source ?? "—")} />
      </div>

      {/* ── editorial transcript ── */}
      <div className="marker mb-6">
        <span className="marker-num">01</span>
        <span>TRANSCRIPT · {messages.length} TURNS</span>
        <span className="marker-rule" />
      </div>

      <div className="divide-y divide-rule">
        {messages.map((m, idx) => (
          <Turn
            key={idx}
            index={idx}
            message={m}
            canFork={isEnded && m.role === "assistant"}
            onFork={() => setForkDialog({ open: true, turnIdx: idx })}
          />
        ))}
        {messages.length === 0 && (
          <p className="py-6 font-mono text-[11px] uppercase tracking-marker text-ink-faint">
            no messages in this session
          </p>
        )}
      </div>

      {isEnded && (
        <InjectComposer
          isPending={inject.isPending}
          onSubmit={(content) => inject.mutate(content)}
        />
      )}

      <ForkDialog
        open={forkDialog.open}
        onOpenChange={(o) => setForkDialog((p) => ({ ...p, open: o }))}
        upToTurn={forkDialog.turnIdx}
        defaultTitle={session.title ? `${session.title} (fork)` : ""}
        isPending={fork.isPending}
        onConfirm={(t) =>
          fork.mutate({ turnIdx: forkDialog.turnIdx, title: t })
        }
      />
    </article>
  );
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="font-mono text-[10px] uppercase tracking-marker text-ink-muted">
        {label}
      </div>
      <div className="mt-1 font-mono text-[14px] tabular-nums text-ink">
        {value}
      </div>
    </div>
  );
}

function Turn({
  index,
  message,
  canFork,
  onFork,
}: {
  index: number;
  message: Record<string, any>;
  canFork: boolean;
  onFork: () => void;
}) {
  const role = String(message.role || "unknown");
  const isUser = role === "user";
  const isTool = role === "tool" || message.tool_name;
  const speaker = isTool ? "TOOL" : isUser ? "USER" : "HERMES";
  const ts = message.created_at
    ? new Date(message.created_at * 1000).toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      })
    : "";

  const content = message.content ?? "";
  const preview =
    typeof content === "string" ? content : JSON.stringify(content, null, 2);
  const hasToolCalls = Boolean(message.tool_calls);

  return (
    <div className="group grid grid-cols-[100px_1fr] gap-6 py-6">
      <div className="text-right font-mono text-[10px] uppercase leading-relaxed tracking-label text-ink-faint">
        {ts && <div className="tabular-nums">{ts}</div>}
        <div
          className={
            isUser ? "text-oxide" : isTool ? "text-ink-2" : "text-ink-muted"
          }
        >
          {speaker}
        </div>
        <div className="tabular-nums text-ink-faint">#{index + 1}</div>
      </div>
      <div className="min-w-0 text-[15px] leading-relaxed text-ink-2">
        {canFork && (
          <button
            type="button"
            onClick={onFork}
            className="float-right ml-4 inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-marker text-ink-muted opacity-0 transition-opacity duration-120 ease-operator hover:text-oxide group-hover:opacity-100"
            title={`Fork from turn ${index + 1}`}
          >
            <GitBranch className="size-3" />
            FORK FROM HERE
          </button>
        )}
        {message.tool_name && (
          <ToolCallout
            name={String(message.tool_name)}
            args={message.tool_args ?? message.arguments}
          />
        )}
        {preview && !isTool && (
          <div className="whitespace-pre-wrap break-words text-ink-2">
            {preview}
          </div>
        )}
        {preview && isTool && <ToolOutput body={preview} />}
        {hasToolCalls && (
          <ToolCallout
            name="tool_calls"
            args={message.tool_calls}
          />
        )}
      </div>
    </div>
  );
}

function ToolCallout({ name, args }: { name: string; args: unknown }) {
  const argsString =
    typeof args === "string" ? args : JSON.stringify(args, null, 2);
  return (
    <div className="mt-3 border-l border-oxide-edge bg-oxide-wash px-4 py-2.5">
      <div className="font-mono text-[10px] uppercase tracking-marker text-oxide">
        {name}
      </div>
      {argsString && (
        <div className="mt-1 font-mono text-[12px] text-ink-2">
          {argsString}
        </div>
      )}
    </div>
  );
}

function ToolOutput({ body }: { body: string }) {
  return (
    <div className="mt-2 border-l border-rule pl-4 font-mono text-[11px] leading-relaxed tabular-nums text-ink-muted">
      <pre className="whitespace-pre-wrap break-words">{body}</pre>
    </div>
  );
}
