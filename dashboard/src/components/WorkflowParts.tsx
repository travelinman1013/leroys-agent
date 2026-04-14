/**
 * Shared workflow display components used by both /cron and /workflows routes.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  api,
  type WorkflowRun,
  type WorkflowCheckpoint,
  type WorkflowCatalogEntry,
} from "@/lib/api";
import { compactRelTimeFromUnix } from "@/lib/utils";

/* ────────────────── Status badge ────────────────── */

export function StatusBadge({ status }: { status: string }) {
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

/* ────────────────── Duration formatter ────────────────── */

export function formatDuration(seconds: number): string {
  if (seconds < 0.01) return "<0.01s";
  if (seconds < 1) return `${(seconds * 1000).toFixed(0)}ms`;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s.toFixed(0)}s`;
}

/* ────────────────── Step row with expandable output ────────────────── */

export function StepRow({
  checkpoint,
  runDuration,
}: {
  checkpoint: WorkflowCheckpoint;
  runDuration?: number;
}) {
  const [showOutput, setShowOutput] = useState(false);
  const stepDuration =
    checkpoint.ended_at && checkpoint.started_at
      ? checkpoint.ended_at - checkpoint.started_at
      : 0;

  const durationPct =
    runDuration && runDuration > 0 && stepDuration > 0
      ? Math.min(100, (stepDuration / runDuration) * 100)
      : 0;

  const hasDetail = !!(checkpoint.output_summary || checkpoint.error);

  return (
    <div>
      <div
        className={`flex items-center gap-3 font-mono text-[11px] ${hasDetail ? "cursor-pointer" : ""}`}
        onClick={hasDetail ? () => setShowOutput(!showOutput) : undefined}
      >
        <span className="w-5 text-ink-faint">{checkpoint.step_index}</span>
        <StatusBadge status={checkpoint.status} />
        <span className="text-ink">{checkpoint.step_name}</span>
        <span className="w-16 text-right text-ink-muted">
          {stepDuration > 0 ? formatDuration(stepDuration) : "—"}
        </span>

        {durationPct > 0 && (
          <div className="h-1.5 w-24 rounded-sm bg-rule">
            <div
              className="h-full rounded-sm bg-oxide transition-all duration-300"
              style={{ width: `${durationPct}%` }}
            />
          </div>
        )}

        {!showOutput && checkpoint.output_summary && (
          <span className="max-w-[300px] truncate text-ink-faint">
            {checkpoint.output_summary}
          </span>
        )}
        {hasDetail && (
          <span className="text-ink-faint">{showOutput ? "▾" : "▸"}</span>
        )}
      </div>

      {showOutput && (
        <div className="ml-8 mt-1 mb-2 border-l-2 border-rule pl-3">
          {checkpoint.output_summary && (
            <pre className="whitespace-pre-wrap font-mono text-[10px] text-ink-muted">
              {checkpoint.output_summary}
            </pre>
          )}
          {checkpoint.error && (
            <pre className="mt-1 whitespace-pre-wrap font-mono text-[10px] text-danger">
              {checkpoint.error}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/* ────────────────── Workflow run row (for inline display in cron) ────────────────── */

export function WorkflowRunRow({ run }: { run: WorkflowRun }) {
  const [expanded, setExpanded] = useState(false);

  const { data: detail } = useQuery({
    queryKey: ["workflows", "detail", run.id],
    queryFn: () => api.workflowRunDetail(run.id),
    enabled: expanded,
  });

  const checkpoints = detail?.run?.checkpoints ?? [];
  const duration =
    run.ended_at && run.started_at
      ? formatDuration(run.ended_at - run.started_at)
      : "—";

  return (
    <div className="border-b border-rule last:border-b-0">
      <div
        className="flex cursor-pointer items-center gap-4 px-2 py-1.5 font-mono text-[11px] transition-colors hover:bg-oxide-wash"
        onClick={() => setExpanded(!expanded)}
      >
        <StatusBadge status={run.status} />
        <span className="text-ink-muted">
          {compactRelTimeFromUnix(run.started_at)}
        </span>
        <span className="text-ink-muted">{duration}</span>
        {run.result_summary && (
          <span className="max-w-[300px] truncate text-ink-faint">
            {run.result_summary}
          </span>
        )}
        <span className="text-ink-faint">{expanded ? "▾" : "▸"}</span>
      </div>

      {expanded && checkpoints.length > 0 && (
        <div className="bg-bg px-4 py-2 space-y-1">
          {checkpoints.map((cp) => (
            <StepRow
              key={cp.id}
              checkpoint={cp}
              runDuration={
                run.ended_at && run.started_at
                  ? run.ended_at - run.started_at
                  : undefined
              }
            />
          ))}
          {run.error && (
            <p className="mt-1 font-mono text-[10px] text-danger">
              {run.error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/* ────────────────── Catalog row (harness preview for create form) ────────────────── */

export function CatalogStepPreview({ entry }: { entry: WorkflowCatalogEntry }) {
  return (
    <div className="space-y-1 py-2">
      {entry.steps.map((step) => (
        <div
          key={step.index}
          className="flex items-center gap-3 font-mono text-[11px]"
        >
          <span className="w-5 text-ink-faint">{step.index}</span>
          <span className="text-ink">{step.name}</span>
          <span className="text-ink-muted">timeout {step.timeout_s}s</span>
          {step.skip_on_error && (
            <span className="text-ink-faint">(skip on error)</span>
          )}
        </div>
      ))}
    </div>
  );
}
