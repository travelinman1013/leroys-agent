/**
 * /sessions — dense table list (DESIGN.md §6 row `/sessions`).
 * Mono throughout. Editorial chrome: id, title, model, turns, dur, last activity.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
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
    <div className="bg-bg">
      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-6 border-b border-rule bg-bg-alt px-10 py-4 font-mono text-[10px] uppercase tracking-marker text-ink-muted">
        <div className="text-ink">SESSIONS</div>
        <div className="flex items-center justify-center gap-7">
          <span className="flex items-baseline gap-2">
            <span>Total</span>
            <span className="text-ink tabular-nums">{sessions.length}</span>
          </span>
        </div>
        <div className="text-ink-faint">REFRESH 15s</div>
      </div>

      <div className="px-10 pb-6 pt-9">
        <h1 className="page-stamp text-[56px]">
          all <em>sessions</em>
        </h1>
      </div>

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

      <div className="px-10 pb-16">
        <table className="w-full border-collapse font-mono text-[12px] tabular-nums text-ink">
          <thead>
            <tr>
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
            {sessions.map((s) => (
              <tr
                key={s.id}
                className="border-b border-rule transition-colors duration-120 ease-operator hover:bg-oxide-wash"
              >
                <td className="px-4 py-3 text-ink-faint">
                  <Link
                    to="/sessions/$id"
                    params={{ id: s.id }}
                    className="hover:text-oxide"
                  >
                    {s.id.slice(0, 8)}
                  </Link>
                </td>
                <td className="max-w-[420px] truncate px-4 py-3 text-ink">
                  <Link
                    to="/sessions/$id"
                    params={{ id: s.id }}
                    className="hover:text-oxide"
                  >
                    {s.title || s.preview || "(no preview)"}
                  </Link>
                </td>
                <td className="px-4 py-3 text-ink-2">{s.source}</td>
                <td className="px-4 py-3 text-ink-2">
                  {s.model ? s.model.split("/").pop() : "—"}
                </td>
                <td className="px-4 py-3 text-right text-ink">
                  {compactNumber(s.message_count)}
                </td>
                <td className="px-4 py-3 text-right text-ink">
                  {compactNumber(
                    (s.input_tokens ?? 0) + (s.output_tokens ?? 0),
                  )}
                </td>
                <td className="px-4 py-3 text-right text-ink-2">
                  {formatCost(s.estimated_cost_usd)}
                </td>
                <td className="px-4 py-3 text-right text-ink-faint">
                  {relTimeFromUnix(s.last_active)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {sessions.length === 0 && !isLoading && (
          <p className="mt-6 font-mono text-[11px] uppercase tracking-marker text-ink-faint">
            no sessions yet
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
      className="border-b border-rule px-4 py-3.5 text-[10px] font-medium uppercase tracking-marker text-ink-muted"
      style={{ textAlign: align }}
    >
      {children}
    </th>
  );
}
