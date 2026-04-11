/**
 * /approvals — Approval Command Center.
 *
 * Pending queue + bulk-resolve toolbar + history table + per-pattern
 * stats sidebar. Operator's Desk dense scan-route layout.
 *
 * Plan: cobalt-steering-heron F3.
 */

import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { api, type ApprovalHistoryRow, type PendingApproval } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { ApprovalCard } from "@/components/ApprovalCard";
import { useApiMutation } from "@/lib/mutations";
import { useNotify } from "@/lib/notifications";
import { compactRelTimeFromUnix } from "@/lib/utils";

export const Route = createFileRoute("/approvals")({
  component: ApprovalsPage,
});

function ApprovalsPage() {
  const pending = useQuery({
    queryKey: ["dashboard", "approvals"],
    queryFn: api.approvals,
    refetchInterval: 3_000,
  });

  const [filters, setFilters] = useState<{
    pattern: string;
    choice: string;
  }>({ pattern: "", choice: "" });

  const history = useQuery({
    queryKey: ["dashboard", "approvals", "history", filters],
    queryFn: () =>
      api.approvalsHistory({
        limit: 100,
        pattern: filters.pattern || undefined,
        choice: filters.choice || undefined,
      }),
    refetchInterval: 10_000,
  });

  const stats = useQuery({
    queryKey: ["dashboard", "approvals", "stats"],
    queryFn: () => api.approvalsStats("7d"),
    refetchInterval: 60_000,
  });

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const notify = useNotify();

  const bulk = useApiMutation({
    mutationFn: (choice: "once" | "session" | "always" | "deny") =>
      api.bulkResolveApprovals(Array.from(selected), choice),
    invalidate: [
      ["dashboard", "approvals"],
      ["dashboard", "approvals", "history"],
      ["dashboard", "approvals", "stats"],
    ],
    onSuccess: (data) => {
      const ok = data.results.filter((r) => r.ok).length;
      notify.success(`Resolved ${ok} approval${ok === 1 ? "" : "s"}`);
      setSelected(new Set());
    },
  });

  const items = (pending.data?.pending ?? []) as PendingApproval[];
  const allSelected =
    items.length > 0 && items.every((a) => selected.has(a.session_key));
  const toggleAll = () =>
    allSelected
      ? setSelected(new Set())
      : setSelected(new Set(items.map((a) => a.session_key)));
  const toggleOne = (key: string) =>
    setSelected((p) => {
      const next = new Set(p);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="bg-bg">
      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-6 border-b border-rule bg-bg-alt px-10 py-4 font-mono text-[10px] uppercase tracking-marker text-ink-muted">
        <div className="text-ink">APPROVALS</div>
        <div className="flex items-center justify-center gap-7">
          <span className="flex items-baseline gap-2">
            <span>Pending</span>
            <span className="text-ink tabular-nums">{items.length}</span>
          </span>
          <span className="flex items-baseline gap-2">
            <span>History</span>
            <span className="text-ink tabular-nums">
              {history.data?.rows.length ?? 0}
            </span>
          </span>
        </div>
        <div className="text-ink-faint">REFRESH 3s</div>
      </div>

      <div className="px-10 pb-6 pt-9">
        <h1 className="page-stamp text-[56px]">
          approval <em>queue</em>
        </h1>
      </div>

      <div className="grid grid-cols-1 gap-10 px-10 pb-16 lg:grid-cols-[1fr_300px]">
        <main className="space-y-10">
          {/* Pending queue */}
          <section>
            <div className="marker mb-4">
              <span className="marker-num">01</span>
              <span>PENDING · {items.length}</span>
              <span className="marker-rule" />
            </div>
            {items.length === 0 ? (
              <p className="font-mono text-[11px] uppercase tracking-marker text-ink-faint">
                ALL CLEAR
              </p>
            ) : (
              <>
                <div className="mb-3 flex items-center gap-2 border-b border-rule pb-2">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                    aria-label="Select all"
                    className="accent-oxide"
                  />
                  <span className="font-mono text-[10px] uppercase tracking-marker text-ink-muted">
                    {selected.size} SELECTED
                  </span>
                  {/*
                    Disabled state uses explicit `text-ink-faint` +
                    `border-rule` + `opacity-100` so the buttons read as
                    "intentionally off, waiting for a selection" rather
                    than the browser's generic opacity-50 fade (which on
                    an already-low-contrast `outline` variant made them
                    nearly invisible per the audit P7 finding).
                  */}
                  <div className="ml-auto flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!selected.size || bulk.isPending}
                      onClick={() => bulk.mutate("once")}
                      className="disabled:border-rule disabled:text-ink-faint disabled:opacity-100"
                    >
                      ONCE
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!selected.size || bulk.isPending}
                      onClick={() => bulk.mutate("session")}
                      className="disabled:border-rule disabled:text-ink-faint disabled:opacity-100"
                    >
                      SESSION
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!selected.size || bulk.isPending}
                      onClick={() => bulk.mutate("always")}
                      className="disabled:border-rule disabled:text-ink-faint disabled:opacity-100"
                    >
                      ALWAYS
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={!selected.size || bulk.isPending}
                      onClick={() => bulk.mutate("deny")}
                      className="disabled:border-rule disabled:text-ink-faint disabled:opacity-100"
                    >
                      DENY
                    </Button>
                  </div>
                </div>
                <div className="space-y-3">
                  {items.map((a) => (
                    <div
                      key={a.session_key}
                      className="flex items-start gap-3"
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(a.session_key)}
                        onChange={() => toggleOne(a.session_key)}
                        aria-label={`Select ${a.session_key}`}
                        className="mt-3 accent-oxide"
                      />
                      <div className="flex-1">
                        <ApprovalCard approval={a} />
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </section>

          {/* History */}
          <section>
            <div className="marker mb-4">
              <span className="marker-num">02</span>
              <span>HISTORY</span>
              <span className="marker-rule" />
            </div>
            <div className="mb-3 flex items-center gap-3 border-b border-rule pb-2">
              <input
                type="search"
                value={filters.pattern}
                onChange={(e) =>
                  setFilters((p) => ({ ...p, pattern: e.target.value }))
                }
                placeholder="filter pattern…"
                className="h-8 max-w-xs border border-rule bg-bg px-2 font-mono text-[11px] text-ink placeholder:text-ink-faint focus:outline-none"
              />
              <select
                value={filters.choice}
                onChange={(e) =>
                  setFilters((p) => ({ ...p, choice: e.target.value }))
                }
                className="h-8 border border-rule bg-bg px-2 font-mono text-[10px] uppercase tracking-marker text-ink"
              >
                <option value="">all choices</option>
                <option value="once">once</option>
                <option value="session">session</option>
                <option value="always">always</option>
                <option value="deny">deny</option>
              </select>
            </div>
            <ApprovalHistoryTable rows={history.data?.rows ?? []} />
          </section>
        </main>

        <aside>
          <ApprovalStatsSidebar
            stats={stats.data?.stats ?? {}}
            isLoading={stats.isLoading}
          />
        </aside>
      </div>
    </div>
  );
}

function ApprovalHistoryTable({ rows }: { rows: ApprovalHistoryRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="font-mono text-[11px] uppercase tracking-marker text-ink-faint">
        no history yet
      </p>
    );
  }
  return (
    <table className="w-full border-collapse font-mono text-[12px] tabular-nums text-ink">
      <thead>
        <tr>
          <th className="border-b border-rule px-4 py-2 text-left text-[10px] font-medium uppercase tracking-marker text-ink-muted">
            WHEN
          </th>
          <th className="border-b border-rule px-4 py-2 text-left text-[10px] font-medium uppercase tracking-marker text-ink-muted">
            PATTERN
          </th>
          <th className="border-b border-rule px-4 py-2 text-left text-[10px] font-medium uppercase tracking-marker text-ink-muted">
            COMMAND
          </th>
          <th className="border-b border-rule px-4 py-2 text-left text-[10px] font-medium uppercase tracking-marker text-ink-muted">
            CHOICE
          </th>
          <th className="border-b border-rule px-4 py-2 text-right text-[10px] font-medium uppercase tracking-marker text-ink-muted">
            WAIT
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} className="border-b border-rule hover:bg-oxide-wash">
            <td className="px-4 py-2 text-ink-faint">
              {compactRelTimeFromUnix(r.resolved_at)}
            </td>
            <td className="px-4 py-2 text-ink">{r.pattern_key ?? "—"}</td>
            <td className="max-w-[420px] truncate px-4 py-2 text-ink-2">
              {r.command}
            </td>
            <td className="px-4 py-2">
              <span
                className={
                  r.choice === "deny"
                    ? "text-danger"
                    : r.choice === "always"
                    ? "text-oxide"
                    : "text-ink-2"
                }
              >
                {r.choice.toUpperCase()}
              </span>
            </td>
            <td className="px-4 py-2 text-right text-ink-faint">
              {r.wait_ms != null ? `${r.wait_ms}ms` : "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ApprovalStatsSidebar({
  stats,
  isLoading,
}: {
  stats: Record<string, { count: number; denied: number; deny_rate: number; avg_wait_ms: number }>;
  isLoading: boolean;
}) {
  const entries = useMemo(
    () =>
      Object.entries(stats).sort((a, b) => b[1].count - a[1].count),
    [stats],
  );
  return (
    <div className="border border-rule bg-bg-alt p-5">
      <div className="font-mono text-[10px] uppercase tracking-marker text-ink-muted">
        STATS · 7d
      </div>
      <div className="mt-2 font-display text-[44px] font-bold leading-none tracking-big text-oxide tabular-nums">
        {entries.reduce((acc, [, v]) => acc + v.count, 0)}
      </div>
      <div className="mt-1 font-mono text-[10px] uppercase tracking-marker text-ink-faint">
        APPROVALS · {entries.length} PATTERNS
      </div>
      <div className="mt-5 space-y-3 border-t border-rule pt-4">
        {isLoading && (
          <p className="font-mono text-[10px] uppercase tracking-marker text-ink-faint">
            loading…
          </p>
        )}
        {entries.length === 0 && !isLoading && (
          <p className="font-mono text-[10px] uppercase tracking-marker text-ink-faint">
            no data
          </p>
        )}
        {entries.map(([pattern, v]) => (
          <div key={pattern} className="grid grid-cols-[1fr_auto] gap-3">
            <div className="min-w-0 truncate font-mono text-[11px] text-ink">
              {pattern}
            </div>
            <div className="text-right font-mono text-[10px] uppercase tracking-marker text-ink-muted">
              <span className="text-ink tabular-nums">{v.count}</span> ·{" "}
              <span
                className={
                  v.deny_rate > 0.5 ? "text-danger" : "text-ink-faint"
                }
              >
                {Math.round(v.deny_rate * 100)}% DENY
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
