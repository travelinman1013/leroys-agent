/**
 * /workflows — Phase 7 workflow runs inspector.
 *
 * Dense table of workflow runs with inline step accordion. Status badges
 * follow Operator's Desk palette: completed=green, running=oxide-pulse,
 * failed=red, pending=muted. See DESIGN.md §6 "scan-routes" density.
 */

import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type WorkflowRun, type WorkflowCheckpoint } from "@/lib/api";
import { compactRelTimeFromUnix } from "@/lib/utils";
import { workflowsSearch, useSyncSearchToStorage } from "@/lib/searchParams";

export const Route = createFileRoute("/workflows")({
  component: WorkflowsPage,
  validateSearch: workflowsSearch,
});

function WorkflowsPage() {
  const { status: statusFilter } = Route.useSearch();
  useSyncSearchToStorage("workflows", { status: statusFilter });

  const { data, isLoading, error } = useQuery({
    queryKey: ["workflows", "runs", statusFilter],
    queryFn: () => api.workflowRuns({ limit: 100, status: statusFilter || undefined }),
    refetchInterval: 10_000,
  });

  const runs = data?.runs ?? [];
  const running = runs.filter((r) => r.status === "running").length;
  const completed = runs.filter((r) => r.status === "completed").length;
  const failed = runs.filter((r) => r.status === "failed").length;

  return (
    <div className="bg-bg">
      {/* Meters strip */}
      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-6 border-b border-rule bg-bg-alt px-10 py-4 font-mono text-[10px] uppercase tracking-marker text-ink-muted">
        <div className="text-ink">WORKFLOWS</div>
        <div className="flex items-center justify-center gap-7">
          <Meter label="Total" value={String(runs.length)} />
          <Meter label="Running" value={String(running)} warm={running > 0} />
          <Meter label="Completed" value={String(completed)} />
          <Meter label="Failed" value={String(failed)} warm={failed > 0} />
        </div>
        <div className="text-ink-faint">REFRESH 10s</div>
      </div>

      {/* Page header */}
      <div className="px-10 pb-6 pt-9">
        <h1 className="page-stamp text-[56px]">
          <em>workflow</em> runs
        </h1>
        <p className="mt-3 font-mono text-[10px] uppercase tracking-marker text-ink-muted">
          ─── {runs.length} RUNS · PHASE 7 RECON · TWO HARNESSES ──
        </p>
      </div>

      {isLoading && (
        <p className="px-10 py-4 font-mono text-[11px] uppercase tracking-marker text-ink-muted">
          loading runs<span className="loading-cursor ml-2" />
        </p>
      )}
      {error && (
        <p className="px-10 py-4 font-mono text-[11px] uppercase tracking-marker text-danger">
          {(error as Error).message}
        </p>
      )}

      {!isLoading && runs.length > 0 && (
        <div className="px-10 pb-10">
          <table className="w-full border-collapse font-mono text-[12px] tabular-nums text-ink">
            <thead>
              <tr className="border-b border-rule text-left font-mono text-[10px] uppercase tracking-marker text-ink-muted">
                <Th>ID</Th>
                <Th>Workflow</Th>
                <Th>Trigger</Th>
                <Th>Status</Th>
                <Th>Started</Th>
                <Th>Duration</Th>
                <Th>Steps</Th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <RunRow key={run.id} run={run} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!isLoading && runs.length === 0 && (
        <p className="px-10 py-4 font-mono text-[11px] uppercase tracking-marker text-ink-muted">
          no workflow runs yet. configure a cron job with{" "}
          <code className="text-oxide">workflow: morning-repo-scan</code> to get started.
        </p>
      )}
    </div>
  );
}

/* ────────────────── Run row with expandable steps ────────────────── */

function RunRow({ run }: { run: WorkflowRun }) {
  const [expanded, setExpanded] = useState(false);

  const { data: detail } = useQuery({
    queryKey: ["workflows", "detail", run.id],
    queryFn: () => api.workflowRunDetail(run.id),
    enabled: expanded,
  });

  const checkpoints = detail?.run?.checkpoints ?? [];
  const duration =
    run.ended_at && run.started_at
      ? `${((run.ended_at - run.started_at) / 1).toFixed(1)}s`
      : "—";

  return (
    <>
      <tr
        className="cursor-pointer border-b border-rule transition-colors duration-120 ease-operator hover:bg-oxide-wash"
        onClick={() => setExpanded(!expanded)}
      >
        <Td className="text-ink-faint">{run.id.slice(0, 12)}</Td>
        <Td className="text-ink">{run.workflow_name}</Td>
        <Td className="text-ink-muted">{run.trigger_type}</Td>
        <Td>
          <StatusBadge status={run.status} />
        </Td>
        <Td className="text-ink-muted">
          {compactRelTimeFromUnix(run.started_at)}
        </Td>
        <Td className="text-ink-muted">{duration}</Td>
        <Td className="text-ink-muted">
          {checkpoints.length > 0
            ? `${checkpoints.filter((c) => c.status === "completed").length}/${checkpoints.length}`
            : run.step_count != null && run.step_count > 0
              ? String(run.step_count)
              : "—"}
        </Td>
      </tr>
      {expanded && checkpoints.length > 0 && (
        <tr>
          <td colSpan={7} className="bg-bg-alt px-6 py-3">
            <div className="space-y-2">
              {checkpoints.map((cp) => (
                <StepRow key={cp.id} checkpoint={cp} />
              ))}
            </div>
            {run.error && (
              <p className="mt-2 font-mono text-[11px] text-danger">
                Error: {run.error}
              </p>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

/* ────────────────── Step row inside accordion ────────────────── */

function StepRow({ checkpoint }: { checkpoint: WorkflowCheckpoint }) {
  const duration =
    checkpoint.ended_at && checkpoint.started_at
      ? `${((checkpoint.ended_at - checkpoint.started_at)).toFixed(2)}s`
      : "—";

  return (
    <div className="flex items-center gap-4 font-mono text-[11px]">
      <span className="w-5 text-ink-faint">{checkpoint.step_index}</span>
      <StatusBadge status={checkpoint.status} />
      <span className="text-ink">{checkpoint.step_name}</span>
      <span className="text-ink-muted">{duration}</span>
      {checkpoint.output_summary && (
        <span className="truncate text-ink-faint max-w-[400px]">
          {checkpoint.output_summary}
        </span>
      )}
      {checkpoint.error && (
        <span className="text-danger truncate max-w-[300px]">
          {checkpoint.error}
        </span>
      )}
    </div>
  );
}

/* ────────────────── Shared components ────────────────── */

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    pending: "text-ink-muted",
    running: "text-oxide animate-pulse",
    completed: "text-green-500",
    failed: "text-danger",
    cancelled: "text-ink-faint",
    skipped: "text-ink-faint",
  };

  return (
    <span
      className={`inline-block rounded font-mono text-[10px] uppercase tracking-marker ${colors[status] ?? "text-ink-muted"}`}
    >
      {status}
    </span>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-3 py-2 text-left font-mono text-[10px] font-normal uppercase tracking-marker">
      {children}
    </th>
  );
}

function Td({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <td className={`px-3 py-2 ${className}`}>{children}</td>;
}

function Meter({
  label,
  value,
  warm,
}: {
  label: string;
  value: string;
  warm?: boolean;
}) {
  return (
    <span>
      {label}{" "}
      <strong className={warm ? "text-oxide" : "text-ink"}>{value}</strong>
    </span>
  );
}
