/**
 * /sessions — F1 session list with search, filters, bulk actions.
 *
 * DESIGN.md §6 row `/sessions` — Operator's Desk dense table, mono
 * throughout, hairline borders, no row shadows.
 */

import {
  createFileRoute,
  Outlet,
  useMatchRoute,
  useNavigate,
} from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { api } from "@/lib/api";
import {
  compactNumber,
  compactRelTimeFromUnix,
  formatCost,
} from "@/lib/utils";
import { useApiMutation } from "@/lib/mutations";
import { useConfirm } from "@/lib/confirm";
import { useNotify } from "@/lib/notifications";
import {
  SessionFilters,
  type SessionFilterState,
} from "@/components/SessionFilters";
import { BulkActionsBar } from "@/components/BulkActionsBar";

export const Route = createFileRoute("/sessions")({
  component: SessionsList,
});

function SessionsList() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const notify = useNotify();
  const navigate = useNavigate();
  // Session detail (`/sessions/$id`) is registered as a child of this
  // route in `routeTree.gen.ts`. Without an explicit <Outlet />, the
  // parent layout always rendered the list — clicking a session title
  // updated the URL to `/sessions/<id>` but the view never swapped.
  // That was Maxwell's "clicking the title doesn't lead anywhere"
  // report. We render the child exclusively when one is matched
  // (REPLACE master-detail: the list is dense enough that a
  // side-by-side at 1024 would starve both panes). The match lookup
  // MUST happen inside the same render pass as every other hook —
  // React's rules of hooks require a stable hook order, so the
  // early-return comes AFTER all hook calls below.
  const matchRoute = useMatchRoute();

  const [filters, setFilters] = useState<SessionFilterState>({
    q: "",
    source: "",
    fromDays: 0,
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const { fromUnix } = useMemo(() => {
    if (!filters.fromDays) return { fromUnix: undefined };
    const now = Date.now() / 1000;
    return { fromUnix: now - filters.fromDays * 86400 };
  }, [filters.fromDays]);

  const isFiltered = Boolean(filters.q || filters.source || fromUnix);

  const { data, isLoading, error } = useQuery({
    queryKey: ["dashboard", "sessions", "list", filters],
    queryFn: () =>
      isFiltered
        ? api.searchSessions({
            q: filters.q || undefined,
            source: filters.source || undefined,
            from: fromUnix,
            limit: 100,
          })
        : api.sessions({ limit: 100 }),
    refetchInterval: 15_000,
  });

  const sessions = (data?.sessions ?? []) as Array<Record<string, any>>;
  const allSelected =
    sessions.length > 0 && sessions.every((s) => selected.has(String(s.id)));

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: ["dashboard", "sessions", "list"],
    });

  const deleteOne = useApiMutation({
    mutationFn: (id: string) => api.deleteSession(id),
    invalidate: [["dashboard", "sessions", "list"]],
    successMessage: (_, id) => `Deleted ${String(id).slice(0, 8)}`,
  });

  const bulk = useApiMutation({
    mutationFn: (body: { ids: string[]; action: "delete" | "export" }) =>
      api.bulkSessions(body),
    invalidate: [["dashboard", "sessions", "list"]],
  });

  const toggleAll = () => {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(sessions.map((s) => String(s.id))));
    }
  };
  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleBulkDelete = async () => {
    const ids = Array.from(selected);
    const ok = await confirm({
      title: `Delete ${ids.length} session${ids.length === 1 ? "" : "s"}?`,
      description: "Child sessions will be orphaned. Cannot be undone.",
      destructive: true,
      confirmLabel: "DELETE",
    });
    if (!ok) return;
    const result = await bulk.mutateAsync({ ids, action: "delete" });
    const ok_count = result.results.filter((r) => r.ok).length;
    const fail = result.results.length - ok_count;
    if (fail) {
      notify.error(`Deleted ${ok_count}, failed ${fail}`);
    } else {
      notify.success(`Deleted ${ok_count} sessions`);
    }
    setSelected(new Set());
    invalidate();
  };

  const handleBulkExport = async () => {
    const ids = Array.from(selected);
    // Trigger one download per session via its export URL
    for (const id of ids) {
      window.open(api.exportSessionUrl(id, "json"), "_blank");
    }
    notify.success(`Triggered ${ids.length} downloads`);
  };

  // Swap the list out for the child when a detail route is active.
  // All hooks above have run on every render — safe to early-return.
  if (matchRoute({ to: "/sessions/$id" })) {
    return <Outlet />;
  }

  return (
    <div className="bg-bg">
      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-6 border-b border-rule bg-bg-alt px-10 py-4 font-mono text-[10px] uppercase tracking-marker text-ink-muted">
        <div className="text-ink">SESSIONS</div>
        <div className="flex items-center justify-center gap-7">
          <span className="flex items-baseline gap-2">
            <span>Total</span>
            <span className="text-ink tabular-nums">{sessions.length}</span>
          </span>
          {isFiltered && (
            <span className="flex items-baseline gap-2">
              <span>Filter</span>
              <span className="text-oxide">ON</span>
            </span>
          )}
        </div>
        <div className="text-ink-faint">REFRESH 15s</div>
      </div>

      <div className="px-10 pb-6 pt-9">
        <h1 className="page-stamp text-[56px]">
          all <em>sessions</em>
        </h1>
      </div>

      <SessionFilters value={filters} onChange={setFilters} />
      <BulkActionsBar
        selectedCount={selected.size}
        onDelete={handleBulkDelete}
        onExport={handleBulkExport}
        onClear={() => setSelected(new Set())}
      />

      {isLoading && (
        <p className="px-10 font-mono text-[11px] uppercase tracking-marker text-ink-muted">
          loading sessions<span className="loading-cursor ml-2" />
        </p>
      )}
      {error && (
        <p className="px-10 font-mono text-[11px] uppercase tracking-marker text-danger">
          {(error as Error).message}
        </p>
      )}

      {/*
        V1 (viewport overflow) + D1/D2 (dead row click surface + weak
        title affordance) from ashen-tempering-ibis §1 and Maxwell's
        follow-up feedback after Commit 3:

        Commit 3 used a horizontal-scroll container with a `min-w`
        on the table and a right-edge fade. Maxwell pushed back —
        he wants zero horizontal scroll, all 10 columns fitted into
        whatever viewport width is available, matching the /approvals
        layout where cells wrap their own text across multiple lines
        (e.g. "about 4 hours ago" → 4 lines at narrow widths).

        Changes vs Commit 3:
        - dropped `min-w-[1120px]` on the table — it now shrinks
          to fit its container
        - dropped the `overflow-x-auto` / `relative` / fade sibling
          wrapper — no scroll container
        - dropped `max-w-[420px] truncate` on the TITLE cell — it
          wraps naturally at `break-word` now
        - tightened cell padding from `px-4 py-3` to `px-3 py-2.5`
          so more content fits before any cell has to wrap at all
        - unchanged from Commit 3: sticky thead, whole-row click
          with keyboard a11y, title / id group-hover affordances
      */}
      <div className="px-10 pb-16">
        <table className="w-full table-auto border-collapse font-mono text-[12px] tabular-nums text-ink [&_td]:break-words">
            <thead className="sticky top-0 z-10 bg-bg">
              <tr>
                <Th align="left">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                    aria-label="Select all"
                    className="accent-oxide"
                  />
                </Th>
                <Th>ID</Th>
                <Th>TITLE</Th>
                <Th>SRC</Th>
                <Th>MODEL</Th>
                <Th align="right">MSGS</Th>
                <Th align="right">TOK</Th>
                <Th align="right">COST</Th>
                <Th align="right">LAST</Th>
                <Th align="right">ACTIONS</Th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => {
                const sid = String(s.id);
                const checked = selected.has(sid);
                const goDetail = () =>
                  navigate({ to: "/sessions/$id", params: { id: sid } });
                return (
                  <tr
                    key={sid}
                    role="link"
                    tabIndex={0}
                    onClick={goDetail}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        goDetail();
                      }
                    }}
                    className="group cursor-pointer border-b border-rule align-top transition-colors duration-120 ease-operator hover:bg-oxide-wash focus-visible:bg-oxide-wash focus-visible:outline-none"
                  >
                    <td
                      className="px-3 py-2.5"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleOne(sid)}
                        aria-label={`Select ${sid}`}
                        className="accent-oxide"
                      />
                    </td>
                    <td className="px-3 py-2.5 text-ink-faint group-hover:text-oxide">
                      {sid.slice(0, 8)}
                    </td>
                    <td className="px-3 py-2.5 text-ink group-hover:text-oxide group-hover:underline group-hover:decoration-rule group-hover:underline-offset-4">
                      {s.title || s.preview || "(no preview)"}
                    </td>
                    <td className="px-3 py-2.5 text-ink-2">{s.source}</td>
                    <td className="px-3 py-2.5 text-ink-2">
                      {s.model ? String(s.model).split("/").pop() : "—"}
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
                      {formatCost(s.estimated_cost_usd)}
                    </td>
                    <td className="px-3 py-2.5 text-right text-ink-faint">
                      {compactRelTimeFromUnix(
                        s.last_active ?? s.started_at,
                      )}
                    </td>
                    <td
                      className="px-3 py-2.5 text-right"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <a
                        href={api.exportSessionUrl(sid, "json")}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono text-[10px] uppercase tracking-marker text-ink-muted hover:text-oxide"
                      >
                        EXPORT
                      </a>
                      <button
                        type="button"
                        onClick={async (e) => {
                          e.stopPropagation();
                          const ok = await confirm({
                            title: `Delete ${sid.slice(0, 8)}?`,
                            description: "Cannot be undone.",
                            destructive: true,
                            confirmLabel: "DELETE",
                          });
                          if (ok) deleteOne.mutate(sid);
                        }}
                        className="ml-3 font-mono text-[10px] uppercase tracking-marker text-ink-muted hover:text-danger"
                      >
                        DELETE
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        {sessions.length === 0 && !isLoading && (
          <p className="mt-6 font-mono text-[11px] uppercase tracking-marker text-ink-faint">
            no sessions match
          </p>
        )}
      </div>
    </div>
  );
}

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
