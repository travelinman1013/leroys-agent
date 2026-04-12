/**
 * /desk — Session Control Plane (Phase 8b).
 *
 * Fleet view: running and recent sessions with live status,
 * spawn dialog, kill button, and browser approval notifications.
 *
 * DESIGN.md §6: dense scan-route. Hairline borders, mono throughout,
 * oxide accents on running sessions.
 */

import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, subscribeEvents, type HermesEvent, type SessionListRow } from "@/lib/api";
import { useApiMutation } from "@/lib/mutations";
import { useConfirm } from "@/lib/confirm";
import { useNotify } from "@/lib/notifications";
import {
  compactNumber,
  compactRelTimeFromUnix,
  formatUptime,
} from "@/lib/utils";

export const Route = createFileRoute("/desk")({
  component: DeskPage,
});

// ---------------------------------------------------------------------------
// Spawn Dialog
// ---------------------------------------------------------------------------

function SpawnDialog({
  open,
  onClose,
  onSpawn,
  isPending,
}: {
  open: boolean;
  onClose: () => void;
  onSpawn: (msg: string, title: string, timeout: number) => void;
  isPending: boolean;
}) {
  const [message, setMessage] = useState("");
  const [title, setTitle] = useState("");
  const [timeout, setTimeout_] = useState(1800);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) {
      setMessage("");
      setTitle("");
      setTimeout_(1800);
      // Focus after the dialog renders
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim()) return;
    onSpawn(message.trim(), title.trim(), timeout);
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-lg border border-rule bg-surface p-6"
      >
        <div className="mb-4 font-mono text-[10px] uppercase tracking-marker text-ink-muted">
          SPAWN SESSION
        </div>

        <label className="mb-1 block font-mono text-[11px] uppercase tracking-marker text-ink-2">
          Message
        </label>
        <textarea
          ref={textareaRef}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="What should Hermes do?"
          rows={4}
          className="mb-4 w-full border border-rule bg-bg px-3 py-2 font-mono text-[13px] text-ink placeholder:text-ink-faint focus:border-oxide-edge focus:outline-none"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              if (message.trim()) onSpawn(message.trim(), title.trim(), timeout);
            }
          }}
        />

        <div className="mb-4 grid grid-cols-2 gap-4">
          <div>
            <label className="mb-1 block font-mono text-[11px] uppercase tracking-marker text-ink-2">
              Title (optional)
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Auto-generated if empty"
              className="w-full border border-rule bg-bg px-3 py-1.5 font-mono text-[12px] text-ink placeholder:text-ink-faint focus:border-oxide-edge focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block font-mono text-[11px] uppercase tracking-marker text-ink-2">
              Timeout
            </label>
            <select
              value={timeout}
              onChange={(e) => setTimeout_(Number(e.target.value))}
              className="w-full border border-rule bg-bg px-3 py-1.5 font-mono text-[12px] text-ink focus:border-oxide-edge focus:outline-none"
            >
              <option value={300}>5 min</option>
              <option value={900}>15 min</option>
              <option value={1800}>30 min (default)</option>
              <option value={3600}>60 min (max)</option>
            </select>
          </div>
        </div>

        <div className="flex items-center justify-between">
          <span className="font-mono text-[10px] text-ink-faint">
            {"\u2318"}+Enter to submit
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="border border-rule px-4 py-1.5 font-mono text-[11px] uppercase tracking-marker text-ink-2 transition-colors duration-120 ease-operator hover:bg-surface-2"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!message.trim() || isPending}
              className="border border-oxide bg-oxide px-4 py-1.5 font-mono text-[11px] uppercase tracking-marker text-inverse transition-colors duration-120 ease-operator hover:bg-oxide-hover disabled:opacity-40"
            >
              {isPending ? "Spawning..." : "Spawn"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: string }) {
  if (status === "running") {
    return (
      <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-marker text-oxide">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-oxide animate-pulse" />
        Running
      </span>
    );
  }
  if (status === "idle") {
    return (
      <span className="font-mono text-[10px] uppercase tracking-marker text-ink-muted">
        Idle
      </span>
    );
  }
  return (
    <span className="font-mono text-[10px] uppercase tracking-marker text-ink-faint">
      Ended
    </span>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

function DeskPage() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const notify = useNotify();
  const navigate = useNavigate();

  const [showSpawn, setShowSpawn] = useState(false);
  const [notifPermission, setNotifPermission] = useState(
    typeof Notification !== "undefined" ? Notification.permission : "denied",
  );

  // Track running count from SSE for the ONE BIG NUMBER
  const [runningCount, setRunningCount] = useState<number | null>(null);

  // Fetch sessions with status enrichment (Phase 8a)
  const { data, isLoading, error } = useQuery({
    queryKey: ["dashboard", "desk", "sessions"],
    queryFn: () => api.sessions({ limit: 50 }),
    refetchInterval: 5_000, // faster polling for live view
  });

  const sessions = (data?.sessions ?? []) as SessionListRow[];
  const runningSessions = sessions.filter((s) => s.status === "running");
  const recentSessions = sessions.filter((s) => s.status !== "running").slice(0, 20);

  // Sync running count from query data
  useEffect(() => {
    setRunningCount(runningSessions.length);
  }, [runningSessions.length]);

  // SSE subscription for live updates + approval notifications
  useEffect(() => {
    const unsub = subscribeEvents(
      (event: HermesEvent) => {
        // Refresh desk on session lifecycle events
        if (
          event.type.startsWith("session.") ||
          event.type === "turn.started" ||
          event.type === "turn.ended"
        ) {
          queryClient.invalidateQueries({
            queryKey: ["dashboard", "desk", "sessions"],
          });
        }

        // Browser notification for approvals
        if (event.type === "approval.requested" && notifPermission === "granted") {
          const cmd = (event.data?.command as string) || "unknown command";
          const desc = (event.data?.description as string) || "";
          try {
            new Notification("Hermes: Approval Required", {
              body: desc ? `${cmd}\n${desc}` : cmd,
              tag: `approval-${event.data?.session_key ?? Date.now()}`,
            });
          } catch {
            // Notification API not available
          }
        }
      },
      { replay: 0 },
    );
    return unsub;
  }, [queryClient, notifPermission]);

  // Spawn mutation
  const spawnMut = useApiMutation({
    mutationFn: (body: { message: string; title?: string; timeout_seconds?: number }) =>
      api.spawnSession(body),
    invalidate: [["dashboard", "desk", "sessions"]],
    successMessage: (data) =>
      `Session spawned: ${data.session_id.slice(0, 8)}`,
  });

  const handleSpawn = useCallback(
    (message: string, title: string, timeout: number) => {
      spawnMut.mutate(
        {
          message,
          title: title || undefined,
          timeout_seconds: timeout,
        },
        {
          onSuccess: () => setShowSpawn(false),
        },
      );
    },
    [spawnMut],
  );

  // Kill mutation
  const killMut = useApiMutation({
    mutationFn: (id: string) => api.killSession(id),
    invalidate: [["dashboard", "desk", "sessions"]],
    successMessage: (data) =>
      data.killed
        ? `Killed ${data.session_id.slice(0, 8)}`
        : `Session was not running`,
  });

  const handleKill = useCallback(
    async (session: SessionListRow) => {
      const ok = await confirm({
        title: `Kill ${session.title || session.id.slice(0, 8)}?`,
        description: "The agent will be interrupted immediately.",
        destructive: true,
        confirmLabel: "KILL",
      });
      if (ok) killMut.mutate(session.id);
    },
    [confirm, killMut],
  );

  // Request notification permission
  const requestNotifPerm = useCallback(async () => {
    if (typeof Notification === "undefined") return;
    const result = await Notification.requestPermission();
    setNotifPermission(result);
    if (result === "granted") {
      notify.success("Approval notifications enabled");
    }
  }, [notify]);

  const bigNumber = runningCount ?? runningSessions.length;

  return (
    <div className="bg-bg">
      {/* Strip header */}
      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-6 border-b border-rule bg-bg-alt px-10 py-4 font-mono text-[10px] uppercase tracking-marker text-ink-muted">
        <div className="text-ink">DESK</div>
        <div className="flex items-center justify-center gap-7">
          <span className="flex items-baseline gap-2">
            <span>Running</span>
            <span className="text-oxide tabular-nums">{runningSessions.length}</span>
          </span>
          <span className="flex items-baseline gap-2">
            <span>Total</span>
            <span className="text-ink tabular-nums">{sessions.length}</span>
          </span>
        </div>
        <div className="flex items-center gap-4">
          {notifPermission !== "granted" && (
            <button
              type="button"
              onClick={requestNotifPerm}
              className="text-ink-faint transition-colors duration-120 hover:text-oxide"
              title="Enable browser notifications for approvals"
            >
              NOTIFY OFF
            </button>
          )}
          {notifPermission === "granted" && (
            <span className="text-success" title="Browser notifications active">
              NOTIFY ON
            </span>
          )}
          <span className="text-ink-faint">REFRESH 5s</span>
        </div>
      </div>

      {/* Stamp + ONE BIG NUMBER + spawn button */}
      <div className="flex items-end justify-between px-10 pb-6 pt-9">
        <div>
          <h1 className="page-stamp text-[56px]">
            operator's <em>desk</em>
          </h1>
          <div className="mt-2 flex items-baseline gap-4">
            <span
              className={
                "font-display text-[72px] leading-none tabular-nums " +
                (bigNumber > 0 ? "text-oxide" : "text-ink-muted")
              }
            >
              {bigNumber}
            </span>
            <span className="font-mono text-[11px] uppercase tracking-marker text-ink-muted">
              {bigNumber === 1 ? "session running" : "sessions running"}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setShowSpawn(true)}
          className="border border-oxide bg-oxide px-5 py-2 font-mono text-[11px] uppercase tracking-marker text-inverse transition-colors duration-120 ease-operator hover:bg-oxide-hover"
        >
          + Spawn Session
        </button>
      </div>

      {/* Running sessions */}
      {runningSessions.length > 0 && (
        <div className="px-10 pb-6">
          <div className="mb-3 flex items-center gap-3">
            <span className="font-mono text-[9px] uppercase tracking-marker text-ink-faint">
              ─── RUNNING ─────────────────────────────────
            </span>
          </div>
          <table className="w-full table-auto border-collapse font-mono text-[12px] tabular-nums text-ink [&_td]:break-words">
            <thead>
              <tr>
                <Th>STATUS</Th>
                <Th>ID</Th>
                <Th>TITLE</Th>
                <Th>SRC</Th>
                <Th align="right">ELAPSED</Th>
                <Th align="right">MSGS</Th>
                <Th align="right">TOK</Th>
                <Th align="right">ACTIONS</Th>
              </tr>
            </thead>
            <tbody>
              {runningSessions.map((s) => (
                <tr
                  key={s.id}
                  className="group border-b border-rule align-top bg-oxide-wash/30"
                >
                  <td className="px-3 py-2.5">
                    <StatusBadge status="running" />
                  </td>
                  <td
                    className="cursor-pointer px-3 py-2.5 text-ink-faint group-hover:text-oxide"
                    onClick={() =>
                      navigate({
                        to: "/sessions/$id",
                        params: { id: s.id },
                      })
                    }
                  >
                    {s.id.slice(0, 8)}
                  </td>
                  <td
                    className="cursor-pointer px-3 py-2.5 text-ink group-hover:text-oxide group-hover:underline group-hover:decoration-rule group-hover:underline-offset-4"
                    onClick={() =>
                      navigate({
                        to: "/sessions/$id",
                        params: { id: s.id },
                      })
                    }
                  >
                    {s.title || s.preview || "(spawning)"}
                  </td>
                  <td className="px-3 py-2.5 text-ink-2">{s.source}</td>
                  <td className="px-3 py-2.5 text-right text-oxide">
                    {s.running_since
                      ? formatUptime(Date.now() / 1000 - s.running_since)
                      : compactRelTimeFromUnix(s.started_at)}
                  </td>
                  <td className="px-3 py-2.5 text-right text-ink">
                    {compactNumber(s.message_count)}
                  </td>
                  <td className="px-3 py-2.5 text-right text-ink">
                    {compactNumber(
                      (s.input_tokens ?? 0) + (s.output_tokens ?? 0),
                    )}
                  </td>
                  <td
                    className="px-3 py-2.5 text-right"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      type="button"
                      onClick={() => handleKill(s)}
                      className="inline-flex items-baseline gap-1 font-mono text-[10px] uppercase tracking-marker text-danger hover:text-danger/80"
                      title="Kill this session"
                    >
                      <span aria-hidden>&#x2717;</span> KILL
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Recent sessions */}
      <div className="px-10 pb-16">
        <div className="mb-3 flex items-center gap-3">
          <span className="font-mono text-[9px] uppercase tracking-marker text-ink-faint">
            ─── RECENT ──────────────────────────────────
          </span>
        </div>

        {isLoading && (
          <p className="font-mono text-[11px] uppercase tracking-marker text-ink-muted">
            loading<span className="loading-cursor ml-2" />
          </p>
        )}
        {error && (
          <p className="font-mono text-[11px] uppercase tracking-marker text-danger">
            {(error as Error).message}
          </p>
        )}

        {recentSessions.length > 0 && (
          <table className="w-full table-auto border-collapse font-mono text-[12px] tabular-nums text-ink [&_td]:break-words">
            <thead className="sticky top-0 z-10 bg-bg">
              <tr>
                <Th>STATUS</Th>
                <Th>ID</Th>
                <Th>TITLE</Th>
                <Th>SRC</Th>
                <Th>MODEL</Th>
                <Th align="right">MSGS</Th>
                <Th align="right">TOK</Th>
                <Th align="right">COST</Th>
                <Th align="right">LAST</Th>
              </tr>
            </thead>
            <tbody>
              {recentSessions.map((s) => (
                <tr
                  key={s.id}
                  role="link"
                  tabIndex={0}
                  onClick={() =>
                    navigate({
                      to: "/sessions/$id",
                      params: { id: s.id },
                    })
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      navigate({
                        to: "/sessions/$id",
                        params: { id: s.id },
                      });
                    }
                  }}
                  className="group cursor-pointer border-b border-rule align-top transition-colors duration-120 ease-operator hover:bg-oxide-wash focus-visible:bg-oxide-wash focus-visible:outline-none"
                >
                  <td className="px-3 py-2.5">
                    <StatusBadge status={s.status ?? "ended"} />
                  </td>
                  <td className="px-3 py-2.5 text-ink-faint group-hover:text-oxide">
                    {s.id.slice(0, 8)}
                  </td>
                  <td className="px-3 py-2.5 text-ink group-hover:text-oxide group-hover:underline group-hover:decoration-rule group-hover:underline-offset-4">
                    {s.title || s.preview || "(no preview)"}
                  </td>
                  <td className="px-3 py-2.5 text-ink-2">{s.source}</td>
                  <td className="px-3 py-2.5 text-ink-2">
                    {s.model ? String(s.model).split("/").pop() : "---"}
                  </td>
                  <td className="px-3 py-2.5 text-right text-ink">
                    {compactNumber(s.message_count)}
                  </td>
                  <td className="px-3 py-2.5 text-right text-ink">
                    {compactNumber(
                      (s.input_tokens ?? 0) + (s.output_tokens ?? 0),
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right text-ink-2">
                    {s.estimated_cost_usd != null
                      ? `$${s.estimated_cost_usd < 0.01 ? s.estimated_cost_usd.toFixed(4) : s.estimated_cost_usd.toFixed(2)}`
                      : "---"}
                  </td>
                  <td className="px-3 py-2.5 text-right text-ink-faint">
                    {compactRelTimeFromUnix(s.last_active ?? s.started_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {recentSessions.length === 0 && !isLoading && runningSessions.length === 0 && (
          <p className="mt-6 font-mono text-[11px] uppercase tracking-marker text-ink-faint">
            no sessions yet
          </p>
        )}
      </div>

      {/* Spawn dialog */}
      <SpawnDialog
        open={showSpawn}
        onClose={() => setShowSpawn(false)}
        onSpawn={handleSpawn}
        isPending={spawnMut.isPending}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Table header (matches sessions.tsx Th)
// ---------------------------------------------------------------------------

function Th({
  children,
  align = "left",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th
      className="border-b border-rule px-3 py-3 text-[10px] font-medium uppercase tracking-marker text-ink-muted"
      style={{ textAlign: align }}
    >
      {children}
    </th>
  );
}
