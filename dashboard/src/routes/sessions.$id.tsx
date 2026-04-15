/**
 * /sessions/$id — Operator's Desk editorial transcript.
 *
 * 100px gutter for timestamp + speaker, body in Söhne, tool calls as
 * oxide-edged callouts, tool output in left-bordered mono blocks. Lab
 * notebook layout. See DESIGN.md §6 row `/sessions/$id` and preview §06.
 */

import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
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

  // F13: In-session message search
  const [msgSearch, setMsgSearch] = useState("");
  const msgSearchLower = msgSearch.trim().toLowerCase();
  const matchingIndices = useMemo(() => {
    if (!msgSearchLower) return new Set<number>();
    const set = new Set<number>();
    messages.forEach((m, idx) => {
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
      if (content.toLowerCase().includes(msgSearchLower)) set.add(idx);
    });
    return set;
  }, [messages, msgSearchLower]);
  const firstMatchRef = useRef<HTMLDivElement>(null);
  const hasScrolled = useRef(false);

  useEffect(() => {
    hasScrolled.current = false;
  }, [msgSearch]);

  useEffect(() => {
    if (msgSearchLower && matchingIndices.size > 0 && !hasScrolled.current && firstMatchRef.current) {
      firstMatchRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
      hasScrolled.current = true;
    }
  }, [msgSearchLower, matchingIndices]);

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
        <Button size="sm" variant="outline" onClick={() => api.downloadSession(id, "json")}>
            EXPORT JSON
        </Button>
        <Button size="sm" variant="outline" onClick={() => api.downloadSession(id, "md")}>
            EXPORT MD
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

      {/* ── metadata strip ── */}
      <div className="mb-10 border-b border-rule pb-6">
        <div className="grid grid-cols-3 gap-x-10 gap-y-3 md:grid-cols-5">
          <Metric label="Model" value={session.model ? String(session.model).split("/").pop()?.toUpperCase() ?? "—" : "—"} />
          <Metric label="Source" value={String(session.source ?? "—")} />
          <Metric
            label="Started"
            value={session.started_at ? formatUnix(session.started_at) : "—"}
          />
          <Metric
            label="Ended"
            value={session.ended_at ? formatUnix(session.ended_at) : "active"}
          />
          <Metric label="Messages" value={compactNumber(session.message_count)} />
        </div>
        <div className="mt-3 grid grid-cols-3 gap-x-10 gap-y-3 md:grid-cols-5">
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
        </div>
      </div>

      {/* ── editorial transcript ── */}
      <div className="marker mb-6">
        <span className="marker-num">01</span>
        <span>TRANSCRIPT · {messages.length} TURNS</span>
        <span className="marker-rule" />
      </div>

      {/* F13: In-session message search */}
      <div className="mb-6 flex items-center gap-3">
        <input
          type="text"
          value={msgSearch}
          onChange={(e) => setMsgSearch(e.target.value)}
          placeholder="search transcript..."
          className="w-full max-w-sm border border-rule bg-bg-alt px-3 py-1.5 font-mono text-[12px] text-ink placeholder:text-ink-faint focus:border-oxide-edge focus:outline-none"
        />
        {msgSearchLower && (
          <span className="font-mono text-[10px] uppercase tracking-marker text-ink-muted tabular-nums">
            {matchingIndices.size} match{matchingIndices.size !== 1 ? "es" : ""}
          </span>
        )}
      </div>

      <div className="divide-y divide-rule">
        {messages.map((m, idx) => {
          const isMatch = matchingIndices.has(idx);
          const isFirstMatch = isMatch && idx === Math.min(...matchingIndices);
          return (
            <div
              key={idx}
              ref={isFirstMatch ? firstMatchRef : undefined}
              className={isMatch ? "ring-1 ring-oxide-edge" : undefined}
            >
              <Turn
                index={idx}
                message={m}
                canFork={isEnded && m.role === "assistant"}
                onFork={() => setForkDialog({ open: true, turnIdx: idx })}
                highlightQuery={msgSearchLower}
              />
            </div>
          );
        })}
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
  highlightQuery,
}: {
  index: number;
  message: Record<string, any>;
  canFork: boolean;
  onFork: () => void;
  highlightQuery?: string;
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
        {/*
          Fork affordance lives in the margin gutter rather than
          floated into the content column. Previously it was
          `opacity-0 group-hover:opacity-100` inside the assistant
          body, which gave it zero discoverability — users couldn't
          tell the feature existed until they happened to hover over
          an assistant turn on an ended session. The gutter form is
          always visible on every eligible turn (assistant + ended
          session), faint by default, brightening to oxide on hover.
          Uses the same 100px gutter that holds the timestamp /
          speaker / index so it shares the editorial-transcript
          rhythm per DESIGN.md §6 /sessions/$id row.
        */}
        {canFork && (
          <button
            type="button"
            onClick={onFork}
            className="mt-1 inline-flex items-center gap-1 font-mono text-[9px] uppercase tracking-marker text-ink-faint transition-colors duration-120 ease-operator hover:text-oxide"
            title={`Fork from turn ${index + 1}`}
            aria-label={`Fork session from turn ${index + 1}`}
          >
            <GitBranch className="size-2.5" />
            FORK
          </button>
        )}
      </div>
      <div className="min-w-0 text-[15px] leading-relaxed text-ink-2">
        {/* Fork button relocated to the margin gutter above. */}
        {message.tool_name && (
          <ToolCallout
            name={String(message.tool_name)}
            args={message.tool_args ?? message.arguments}
          />
        )}
        {preview && !isTool && (
          <div className="whitespace-pre-wrap break-words text-ink-2">
            {highlightQuery ? <HighlightText text={preview} query={highlightQuery} /> : preview}
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
  const [expanded, setExpanded] = useState(false);
  const argsString =
    typeof args === "string" ? args : JSON.stringify(args, null, 2);
  const hasArgs = argsString && argsString.length > 2;
  return (
    <div className="mt-3 border-l border-oxide-edge bg-oxide-wash px-4 py-2.5">
      <button
        type="button"
        onClick={() => hasArgs && setExpanded(!expanded)}
        className="flex w-full items-center gap-2 text-left font-mono text-[10px] uppercase tracking-marker text-oxide"
      >
        {name}
        {hasArgs && (
          <span className="text-ink-faint text-[9px] normal-case tracking-normal">
            {expanded ? "(collapse)" : "(args)"}
          </span>
        )}
      </button>
      {expanded && argsString && (
        <div className="mt-1 max-h-[300px] overflow-auto font-mono text-[12px] text-ink-2">
          <pre className="whitespace-pre-wrap break-words">{argsString}</pre>
        </div>
      )}
    </div>
  );
}

function ToolOutput({ body }: { body: string }) {
  const [showAll, setShowAll] = useState(false);
  const lines = body.split("\n");
  const truncated = lines.length > 50;
  const displayBody = truncated && !showAll ? lines.slice(0, 10).join("\n") : body;
  return (
    <div className="mt-2 border-l border-rule pl-4 font-mono text-[11px] leading-relaxed tabular-nums text-ink-muted">
      <pre className="whitespace-pre-wrap break-words">{displayBody}</pre>
      {truncated && (
        <button
          type="button"
          onClick={() => setShowAll(!showAll)}
          className="mt-1 font-mono text-[10px] text-oxide hover:underline"
        >
          {showAll ? "Collapse" : `Show all (${lines.length} lines)`}
        </button>
      )}
    </div>
  );
}

// F13: Highlight matching text within transcript messages
function HighlightText({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  try {
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`(${escaped})`, "gi");
    const parts = text.split(regex);
    return (
      <>
        {parts.map((part, i) =>
          regex.test(part) ? (
            <mark key={i} className="bg-oxide-wash text-oxide">
              {part}
            </mark>
          ) : (
            <span key={i}>{part}</span>
          ),
        )}
      </>
    );
  } catch {
    return <>{text}</>;
  }
}
