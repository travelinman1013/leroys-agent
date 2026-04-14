/**
 * /cron — Operator's Desk dense tabular cron view.
 *
 * Mono table; cron strings rendered in oxide; hover rows use --oxide-wash;
 * refresh marker in the meters strip. See DESIGN.md §6 row `/cron`.
 *
 * Consolidated: workflow harness picker in create form, expandable rows
 * with inline workflow run history for workflow jobs and prompt preview
 * for prompt jobs. Replaces the standalone /workflows route.
 */

import { createFileRoute } from "@tanstack/react-router";
import { useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { ToolsPanel } from "@/components/ToolsPanel";
import { Button } from "@/components/ui/button";
import { Play, Pause, Trash2, Plus, ChevronUp } from "lucide-react";
import { compactRelTime } from "@/lib/utils";
import { cronSearch, useSyncSearchToStorage } from "@/lib/searchParams";
import {
  WorkflowRunRow,
  CatalogStepPreview,
} from "@/components/WorkflowParts";

export const Route = createFileRoute("/cron")({
  component: CronPage,
  validateSearch: cronSearch,
});

function CronPage() {
  const { expanded } = Route.useSearch();
  useSyncSearchToStorage("cron", { expanded });
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["cron", "jobs"],
    queryFn: api.cronJobs,
    refetchInterval: 10_000,
  });

  const pause = useMutation({
    mutationFn: (id: string) => api.pauseJob(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cron"] }),
  });
  const resume = useMutation({
    mutationFn: (id: string) => api.resumeJob(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cron"] }),
  });
  const run = useMutation({
    mutationFn: (id: string) => api.runJob(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cron"] }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteJob(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cron"] }),
  });

  const jobs = (data?.jobs ?? []) as Array<Record<string, any>>;
  const running = jobs.filter((j) => j.state === "running").length;
  const workflowJobs = jobs.filter((j) => j.workflow).length;
  const next = jobs
    .map((j) => j.next_run_at as string | number | undefined)
    .filter((t): t is string | number => t != null && t !== "")
    .sort((a, b) => {
      const ta = typeof a === "number" ? a * 1000 : new Date(a).getTime();
      const tb = typeof b === "number" ? b * 1000 : new Date(b).getTime();
      return ta - tb;
    })[0];

  return (
    <div className="bg-bg">
      {/* meters strip */}
      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-6 border-b border-rule bg-bg-alt px-10 py-4 font-mono text-[10px] uppercase tracking-marker text-ink-muted">
        <div className="text-ink">SCHEDULE</div>
        <div className="flex items-center justify-center gap-7">
          <Meter label="Jobs" value={String(jobs.length)} />
          <Meter label="Workflows" value={String(workflowJobs)} />
          <Meter label="Running" value={String(running)} warm={running > 0} />
          <Meter label="Next" value={next ? compactRelTime(next) : "—"} />
        </div>
        <div className="text-ink-faint">REFRESH 10s</div>
      </div>

      <div className="px-10 pb-6 pt-9">
        <h1 className="page-stamp">
          <em>scheduled</em> tasks
        </h1>
        <p className="mt-3 font-mono text-[10px] uppercase tracking-marker text-ink-muted">
          ─── {jobs.length - workflowJobs} PROMPT{jobs.length - workflowJobs !== 1 ? "S" : ""} · {workflowJobs} WORKFLOW{workflowJobs !== 1 ? "S" : ""} ──
        </p>
      </div>

      <CronCreateForm
        onCreated={() => qc.invalidateQueries({ queryKey: ["cron", "jobs"] })}
      />

      {isLoading && (
        <p className="px-10 py-4 font-mono text-[11px] uppercase tracking-marker text-ink-muted">
          loading jobs<span className="loading-cursor ml-2" />
        </p>
      )}
      {error && (
        <p className="px-10 py-4 font-mono text-[11px] uppercase tracking-marker text-danger">
          {(error as Error).message}
        </p>
      )}

      <div className="px-10 pb-16">
        <div className="responsive-table-wrap">
        <table className="w-full border-collapse font-mono text-[12px] tabular-nums text-ink">
          <thead>
            <tr>
              <Th>ID</Th>
              <Th>JOB</Th>
              <Th>SCHEDULE</Th>
              <Th>NEXT</Th>
              <Th>LAST</Th>
              <Th align="right">RUNS</Th>
              <Th align="right">ACTIONS</Th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <JobRow
                key={String(j.id ?? "")}
                job={j}
                onPause={(id) => pause.mutate(id)}
                onResume={(id) => resume.mutate(id)}
                onRun={(id) => run.mutate(id)}
                onRemove={(id) => {
                  if (confirm(`Delete cron job "${j.name}"?`)) {
                    remove.mutate(id);
                  }
                }}
                mutating={
                  pause.isPending ||
                  resume.isPending ||
                  run.isPending ||
                  remove.isPending
                }
              />
            ))}
          </tbody>
        </table>
        </div>

        {jobs.length === 0 && !isLoading && (
          <p className="mt-6 font-mono text-[11px] uppercase tracking-marker text-ink-faint">
            no cron jobs scheduled. create one via{" "}
            <span className="text-oxide">hermes cron add</span> or the form
            above.
          </p>
        )}
      </div>
    </div>
  );
}

/* ────────────────── Expandable job row ────────────────── */

function JobRow({
  job,
  onPause,
  onResume,
  onRun,
  onRemove,
  mutating,
}: {
  job: Record<string, any>;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onRun: (id: string) => void;
  onRemove: (id: string) => void;
  mutating: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const id = String(job.id ?? "");
  const isRunning = job.state === "running";
  const isPaused = job.state === "paused" || !job.enabled;
  const isWorkflow = !!job.workflow;

  return (
    <>
      <tr
        className="cursor-pointer border-b border-rule transition-colors duration-120 ease-operator hover:bg-oxide-wash"
        onClick={() => setExpanded(!expanded)}
      >
        <Td className="text-ink-faint">{id.slice(0, 8)}</Td>
        <Td className="text-ink">
          {String(job.name ?? "—")}
          {isWorkflow && (
            <span className="ml-2 rounded border border-oxide/30 bg-oxide-wash px-1 py-0.5 font-mono text-[9px] uppercase tracking-marker text-oxide">
              workflow
            </span>
          )}
        </Td>
        <Td className="text-oxide">
          {job.schedule_display || JSON.stringify(job.schedule)}
        </Td>
        <Td className="text-ink-2">
          {job.next_run_at ? compactRelTime(job.next_run_at) : "—"}
        </Td>
        <Td className="text-ink-2">
          {job.last_run_at ? compactRelTime(job.last_run_at) : "—"}
          {job.last_status && (
            <span className="ml-2 text-ink-faint">· {job.last_status}</span>
          )}
        </Td>
        <Td align="right" className="text-ink-2">
          {String(job.run_count ?? 0)}
        </Td>
        <Td align="right">
          <div
            className="flex justify-end gap-1"
            onClick={(e) => e.stopPropagation()}
          >
            <Button
              size="icon"
              variant="ghost"
              onClick={() => onRun(id)}
              disabled={mutating}
              title="Run now"
            >
              <Play className="size-3" />
            </Button>
            {!isPaused && (
              <Button
                size="icon"
                variant="ghost"
                onClick={() => onPause(id)}
                disabled={mutating}
                title="Pause"
              >
                <Pause className="size-3" />
              </Button>
            )}
            {isPaused && !isRunning && (
              <Button
                size="icon"
                variant="ghost"
                onClick={() => onResume(id)}
                disabled={mutating}
                title="Resume"
              >
                <Play className="size-3" />
              </Button>
            )}
            <Button
              size="icon"
              variant="ghost"
              onClick={() => onRemove(id)}
              disabled={mutating}
              title="Delete"
            >
              <Trash2 className="size-3" />
            </Button>
          </div>
        </Td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={7} className="border-b border-rule bg-bg-alt px-6 py-4">
            {isWorkflow ? (
              <WorkflowJobDetail workflowId={String(job.workflow)} />
            ) : (
              <PromptJobDetail job={job} />
            )}
          </td>
        </tr>
      )}
    </>
  );
}

/* ────────────────── Workflow job detail (inline run history) ────────────────── */

function WorkflowJobDetail({ workflowId }: { workflowId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["workflows", "runs", "byWorkflow", workflowId],
    queryFn: () =>
      api.workflowRuns({ limit: 10, workflow_id: workflowId }),
    staleTime: 10_000,
  });

  const runs = data?.runs ?? [];

  return (
    <div>
      <div className="mb-2 font-mono text-[10px] uppercase tracking-marker text-ink-muted">
        HARNESS: <span className="text-oxide">{workflowId}</span> · RECENT RUNS
      </div>
      {isLoading && (
        <p className="font-mono text-[10px] text-ink-faint">
          loading runs<span className="loading-cursor ml-2" />
        </p>
      )}
      {!isLoading && runs.length === 0 && (
        <p className="font-mono text-[10px] text-ink-faint">
          no runs yet for this harness.
        </p>
      )}
      {runs.length > 0 && (
        <div className="border border-rule">
          {runs.map((run) => (
            <WorkflowRunRow key={run.id} run={run} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ────────────────── Prompt job detail ────────────────── */

function PromptJobDetail({ job }: { job: Record<string, any> }) {
  const prompt = String(job.prompt ?? "");
  const deliver = String(job.deliver ?? "local");
  const skills = (job.skills as string[] | undefined) ?? [];

  return (
    <div className="space-y-2">
      <div className="flex gap-4 font-mono text-[10px] uppercase tracking-marker text-ink-muted">
        <span>
          DELIVER: <span className="text-ink-faint normal-case">{deliver}</span>
        </span>
        {skills.length > 0 && (
          <span>
            SKILLS:{" "}
            <span className="text-ink-faint normal-case">
              {skills.join(", ")}
            </span>
          </span>
        )}
      </div>
      {prompt && (
        <pre className="whitespace-pre-wrap border-l-2 border-rule pl-3 font-mono text-[11px] text-ink-muted">
          {prompt.length > 500 ? prompt.slice(0, 500) + "..." : prompt}
        </pre>
      )}
    </div>
  );
}

/* ────────────────── Create form with workflow mode ────────────────── */

function CronCreateForm({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"prompt" | "workflow">("prompt");
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [schedule, setSchedule] = useState("");
  const [deliver, setDeliver] = useState("origin");
  const [workflow, setWorkflow] = useState("");
  const [schedulePreview, setSchedulePreview] = useState("");
  const [error, setError] = useState("");

  const { data: catalogData } = useQuery({
    queryKey: ["workflows", "catalog"],
    queryFn: () => api.workflowCatalog(),
    staleTime: 60_000,
    enabled: open,
  });
  const catalog = catalogData?.catalog ?? [];
  const selectedHarness = catalog.find((c) => c.id === workflow);

  const validateSchedule = useCallback(async (expr: string) => {
    if (!expr.trim()) {
      setSchedulePreview("");
      return;
    }
    try {
      const result = await api.parseCronSchedule(expr.trim());
      const p = result.parsed as Record<string, unknown>;
      const nextRun = p.next_run_at ?? p.next_run;
      setSchedulePreview(
        nextRun
          ? `Next: ${new Date((nextRun as number) * 1000).toLocaleString()}`
          : "Valid schedule",
      );
      setError("");
    } catch {
      setSchedulePreview("");
      setError("Invalid cron expression");
    }
  }, []);

  const canCreate =
    schedule.trim() &&
    (mode === "prompt" ? prompt.trim() : workflow);

  const createMut = useMutation({
    mutationFn: () =>
      api.createJob({
        prompt:
          mode === "workflow"
            ? `Run workflow harness: ${workflow}`
            : prompt.trim(),
        schedule: schedule.trim(),
        name: name.trim() || (mode === "workflow" ? workflow : prompt.trim().slice(0, 30)),
        deliver,
        ...(mode === "workflow" ? { workflow } : {}),
      }),
    onSuccess: () => {
      setOpen(false);
      setName("");
      setPrompt("");
      setSchedule("");
      setDeliver("origin");
      setWorkflow("");
      setMode("prompt");
      setSchedulePreview("");
      setError("");
      onCreated();
    },
    onError: (e) => setError(String(e)),
  });

  if (!open) {
    return (
      <div className="px-10 pb-4">
        <button
          onClick={() => setOpen(true)}
          className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-marker text-ink-muted transition-colors hover:text-oxide"
        >
          <Plus size={12} /> NEW JOB
        </button>
      </div>
    );
  }

  return (
    <div className="mx-10 mb-6 border border-rule bg-bg-alt p-6">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <span className="font-mono text-[10px] uppercase tracking-marker text-ink-muted">
            NEW JOB
          </span>
          {/* Mode toggle */}
          <div className="flex rounded border border-rule">
            <button
              onClick={() => setMode("prompt")}
              className={`px-2 py-0.5 font-mono text-[10px] uppercase tracking-marker transition-colors ${
                mode === "prompt"
                  ? "bg-oxide-wash text-oxide"
                  : "text-ink-muted hover:text-ink-faint"
              }`}
            >
              Prompt
            </button>
            <button
              onClick={() => setMode("workflow")}
              className={`border-l border-rule px-2 py-0.5 font-mono text-[10px] uppercase tracking-marker transition-colors ${
                mode === "workflow"
                  ? "bg-oxide-wash text-oxide"
                  : "text-ink-muted hover:text-ink-faint"
              }`}
            >
              Workflow
            </button>
          </div>
        </div>
        <button
          onClick={() => setOpen(false)}
          className="text-ink-faint hover:text-ink"
        >
          <ChevronUp size={14} />
        </button>
      </div>

      <div className="space-y-3">
        <input
          type="text"
          placeholder="Name (optional)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full border border-rule bg-bg px-3 py-1.5 font-mono text-[12px] text-ink placeholder:text-ink-faint focus:border-oxide-edge focus:outline-none"
        />

        {mode === "prompt" ? (
          <>
            <textarea
              placeholder="What should the agent do on each run?"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              className="w-full resize-y border border-rule bg-bg px-3 py-1.5 font-mono text-[12px] text-ink placeholder:text-ink-faint focus:border-oxide-edge focus:outline-none"
            />
            <ToolsPanel />
          </>
        ) : (
          <div>
            <select
              value={workflow}
              onChange={(e) => setWorkflow(e.target.value)}
              className="w-full border border-rule bg-bg px-3 py-1.5 font-mono text-[12px] text-ink focus:border-oxide-edge focus:outline-none"
            >
              <option value="">Select a workflow harness...</option>
              {catalog.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.step_count} steps, {c.trigger_type})
                </option>
              ))}
            </select>
            {selectedHarness && (
              <div className="mt-2 border border-rule bg-bg px-3 py-1">
                <CatalogStepPreview entry={selectedHarness} />
              </div>
            )}
          </div>
        )}

        <div className="grid grid-cols-[1fr_120px_auto] items-end gap-3">
          <div>
            <input
              type="text"
              placeholder="0 9 * * * or 30m"
              value={schedule}
              onChange={(e) => {
                setSchedule(e.target.value);
                validateSchedule(e.target.value);
              }}
              className="w-full border border-rule bg-bg px-3 py-1.5 font-mono text-[12px] text-ink placeholder:text-ink-faint focus:border-oxide-edge focus:outline-none"
            />
            {schedulePreview && (
              <p className="mt-1 font-mono text-[10px] text-success">
                {schedulePreview}
              </p>
            )}
          </div>
          <select
            value={deliver}
            onChange={(e) => setDeliver(e.target.value)}
            className="border border-rule bg-bg px-3 py-1.5 font-mono text-[12px] text-ink focus:border-oxide-edge focus:outline-none"
          >
            <option value="origin">Origin</option>
            <option value="discord">Discord</option>
            <option value="telegram">Telegram</option>
            <option value="slack">Slack</option>
            <option value="email">Email</option>
          </select>
          <Button
            onClick={() => createMut.mutate()}
            disabled={!canCreate || createMut.isPending}
            className="whitespace-nowrap"
          >
            {createMut.isPending ? "Creating..." : "Create"}
          </Button>
        </div>
        {error && (
          <p className="font-mono text-[11px] text-destructive">{error}</p>
        )}
      </div>
    </div>
  );
}

/* ────────────────── Table primitives ────────────────── */

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

function Td({
  children,
  align = "left",
  className = "",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  return (
    <td className={`px-4 py-3 ${className}`} style={{ textAlign: align }}>
      {children}
    </td>
  );
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
    <span className="flex items-baseline gap-2">
      <span>{label}</span>
      <span
        className={warm ? "text-oxide tabular-nums" : "text-ink tabular-nums"}
      >
        {value}
      </span>
    </span>
  );
}
