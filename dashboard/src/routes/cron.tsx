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
import { useState, useCallback, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { ToolsPanel } from "@/components/ToolsPanel";
import { Button } from "@/components/ui/button";
import { Play, Pause, Trash2, Plus, ChevronUp, Pencil, Settings } from "lucide-react";
import { compactRelTime, compactRelTimeFromUnix } from "@/lib/utils";
import type { EventWatcher } from "@/lib/api";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { cronSearch, useSyncSearchToStorage } from "@/lib/searchParams";
import {
  WorkflowRunRow,
  CatalogStepPreview,
} from "@/components/WorkflowParts";
import { InfoTip } from "@/components/InfoTip";
import { ScheduleBuilder } from "@/components/ScheduleBuilder";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetBody,
  SheetFooter,
} from "@/components/ui/sheet";
import { useApiMutation } from "@/lib/mutations";

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

  const [harnessCreatorOpen, setHarnessCreatorOpen] = useState(false);

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

  const { data: watcherData } = useQuery({
    queryKey: ["watchers"],
    queryFn: api.eventWatchers,
    refetchInterval: 10_000,
  });
  const watchers = watcherData?.watchers ?? [];
  const activeWatchers = watchers.filter((w) => w.status === "running").length;

  const jobs = (data?.jobs ?? []) as Array<Record<string, any>>;
  const running = jobs.filter((j) => j.state === "running").length;
  const workflowJobs = jobs.filter((j) => j.workflow).length;
  const workflowJobsList = jobs.filter((j) => j.workflow);
  const promptJobs = jobs.filter((j) => !j.workflow);
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
          <Meter label="Watchers" value={String(activeWatchers)} warm={activeWatchers > 0} />
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
          ─── {jobs.length - workflowJobs} JOB{jobs.length - workflowJobs !== 1 ? "S" : ""} · {workflowJobs} WORKFLOW{workflowJobs !== 1 ? "S" : ""} ──
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

      <Tabs defaultValue="watchers" className="px-10 pb-16">
        <TabsList className="mb-6 w-full justify-start">
          <TabsTrigger value="watchers">
            WATCHERS{" "}
            <span className="ml-1.5 text-ink-faint">{activeWatchers}</span>
            <span className="ml-1"><InfoTip text="File system monitors that watch directories for changes and trigger workflows automatically. They run continuously — not on a schedule." /></span>
          </TabsTrigger>
          <TabsTrigger value="workflows">
            WORKFLOWS{" "}
            <span className="ml-1.5 text-ink-faint">{workflowJobsList.length}</span>
            <span className="ml-1"><InfoTip text="Multi-step harnesses that execute a sequence of predefined Python steps on a cron schedule. Each harness is a fixed pipeline (e.g., repo scan, research digest)." /></span>
          </TabsTrigger>
          <TabsTrigger value="jobs">
            JOBS{" "}
            <span className="ml-1.5 text-ink-faint">{promptJobs.length}</span>
            <span className="ml-1"><InfoTip text="Scheduled prompts — text instructions sent to the agent on a cron schedule. The agent executes the prompt as if you typed it." /></span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="watchers">
          <EventWatchersSection watchers={watchers} />
        </TabsContent>

        <TabsContent value="workflows">
          <div className="mb-3 flex items-center justify-end">
            <button
              onClick={() => setHarnessCreatorOpen(true)}
              className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-marker text-ink-muted transition-colors hover:text-oxide"
            >
              <Plus size={12} /> New Harness
            </button>
          </div>
          <HarnessCreatorSheet
            open={harnessCreatorOpen}
            onOpenChange={setHarnessCreatorOpen}
          />
          <JobsTable
            jobs={workflowJobsList}
            onPause={(id) => pause.mutate(id)}
            onResume={(id) => resume.mutate(id)}
            onRun={(id) => run.mutate(id)}
            onRemove={(id, name) => {
              if (confirm(`Delete cron job "${name}"?`)) remove.mutate(id);
            }}
            mutating={pause.isPending || resume.isPending || run.isPending || remove.isPending}
          />
          {workflowJobsList.length === 0 && !isLoading && (
            <p className="mt-4 font-mono text-[11px] uppercase tracking-marker text-ink-faint">
              no workflow jobs scheduled.
            </p>
          )}
        </TabsContent>

        <TabsContent value="jobs">
          <JobsTable
            jobs={promptJobs}
            onPause={(id) => pause.mutate(id)}
            onResume={(id) => resume.mutate(id)}
            onRun={(id) => run.mutate(id)}
            onRemove={(id, name) => {
              if (confirm(`Delete cron job "${name}"?`)) remove.mutate(id);
            }}
            mutating={pause.isPending || resume.isPending || run.isPending || remove.isPending}
          />
          {promptJobs.length === 0 && !isLoading && (
            <p className="mt-4 font-mono text-[11px] uppercase tracking-marker text-ink-faint">
              no jobs scheduled. create one via{" "}
              <span className="text-oxide">hermes cron add</span> or the form
              above.
            </p>
          )}
        </TabsContent>
      </Tabs>
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
  const [editOpen, setEditOpen] = useState(false);
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
              onClick={() => setEditOpen(true)}
              disabled={mutating}
              title="Edit"
            >
              <Pencil className="size-3" />
            </Button>
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
      <JobEditSheet job={job} open={editOpen} onOpenChange={setEditOpen} />
    </>
  );
}

/* ────────────────── Job Edit Sheet ────────────────── */

function JobEditSheet({
  job,
  open,
  onOpenChange,
}: {
  job: Record<string, any>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const id = String(job.id ?? "");
  const isWorkflow = !!job.workflow;

  const [name, setName] = useState(String(job.name ?? ""));
  const [schedule, setSchedule] = useState(
    job.schedule_display || (typeof job.schedule === "string" ? job.schedule : ""),
  );
  const [prompt, setPrompt] = useState(String(job.prompt ?? ""));
  const [deliver, setDeliver] = useState(String(job.deliver ?? "origin"));
  const [enabled, setEnabled] = useState(job.enabled !== false);
  const [schedulePreview, setSchedulePreview] = useState("");
  const [scheduleError, setScheduleError] = useState("");

  // Reset form when sheet opens with new job
  useEffect(() => {
    if (open) {
      setName(String(job.name ?? ""));
      setSchedule(
        job.schedule_display || (typeof job.schedule === "string" ? job.schedule : ""),
      );
      setPrompt(String(job.prompt ?? ""));
      setDeliver(String(job.deliver ?? "origin"));
      setEnabled(job.enabled !== false);
      setSchedulePreview("");
      setScheduleError("");
    }
  }, [open, job]);

  const validateSchedule = useCallback(async (expr: string) => {
    if (!expr.trim()) {
      setSchedulePreview("");
      setScheduleError("");
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
      setScheduleError("");
    } catch {
      setSchedulePreview("");
      setScheduleError("Invalid schedule expression");
    }
  }, []);

  const update = useApiMutation({
    mutationFn: () =>
      api.updateJob(id, {
        name: name.trim(),
        schedule: schedule.trim(),
        ...(isWorkflow ? {} : { prompt: prompt.trim() }),
        deliver,
        enabled,
      }),
    successMessage: "Job updated",
    onSuccess: () => {
      onOpenChange(false);
      qc.invalidateQueries({ queryKey: ["cron"] });
    },
  });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle className="font-mono text-[11px] uppercase tracking-marker">
            Edit Job — {id.slice(0, 8)}
          </SheetTitle>
        </SheetHeader>
        <SheetBody>
          <div className="space-y-4">
            <div>
              <label className="mb-1 block font-mono text-[10px] uppercase tracking-marker text-ink-muted">
                Name
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full border border-rule bg-bg px-3 py-1.5 font-mono text-[12px] text-ink focus:border-oxide-edge focus:outline-none"
              />
            </div>

            <div>
              <label className="mb-1 block font-mono text-[10px] uppercase tracking-marker text-ink-muted">
                Schedule
              </label>
              <ScheduleBuilder
                value={schedule}
                onChange={(v) => {
                  setSchedule(v);
                  validateSchedule(v);
                }}
                preview={schedulePreview}
                error={scheduleError}
              />
            </div>

            {!isWorkflow && (
              <div>
                <label className="mb-1 block font-mono text-[10px] uppercase tracking-marker text-ink-muted">
                  Prompt
                </label>
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  rows={4}
                  className="w-full resize-y border border-rule bg-bg px-3 py-1.5 font-mono text-[12px] text-ink focus:border-oxide-edge focus:outline-none"
                />
              </div>
            )}

            {isWorkflow && (
              <div>
                <label className="mb-1 block font-mono text-[10px] uppercase tracking-marker text-ink-muted">
                  Workflow
                </label>
                <p className="rounded border border-oxide/30 bg-oxide-wash px-3 py-1.5 font-mono text-[12px] text-oxide">
                  {job.workflow}
                </p>
              </div>
            )}

            <div>
              <label className="mb-1 block font-mono text-[10px] uppercase tracking-marker text-ink-muted">
                Deliver
              </label>
              <select
                value={deliver}
                onChange={(e) => setDeliver(e.target.value)}
                className="w-full border border-rule bg-bg px-3 py-1.5 font-mono text-[12px] text-ink focus:border-oxide-edge focus:outline-none"
              >
                <option value="origin">Origin</option>
                <option value="discord">Discord</option>
                <option value="telegram">Telegram</option>
                <option value="slack">Slack</option>
                <option value="email">Email</option>
              </select>
            </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                className="accent-oxide"
              />
              <label className="font-mono text-[11px] text-ink-2">Enabled</label>
            </div>
          </div>
        </SheetBody>
        <SheetFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            className="font-mono text-[11px]"
          >
            Cancel
          </Button>
          <Button
            onClick={() => update.mutate()}
            disabled={update.isPending || !schedule.trim()}
            className="font-mono text-[11px]"
          >
            {update.isPending ? "Saving..." : "Save"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
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

        <div className="space-y-3">
          <ScheduleBuilder
            value={schedule}
            onChange={(v) => {
              setSchedule(v);
              validateSchedule(v);
            }}
            preview={schedulePreview}
            error={error && error.includes("cron") ? error : undefined}
          />
          <div className="flex items-end gap-3">
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
        </div>
        {error && (
          <p className="font-mono text-[11px] text-destructive">{error}</p>
        )}
      </div>
    </div>
  );
}

/* ────────────────── Jobs table (shared by workflows + prompts tabs) ── */

function JobsTable({
  jobs,
  onPause,
  onResume,
  onRun,
  onRemove,
  mutating,
}: {
  jobs: Array<Record<string, any>>;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onRun: (id: string) => void;
  onRemove: (id: string, name: string) => void;
  mutating: boolean;
}) {
  if (jobs.length === 0) return null;

  return (
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
              onPause={onPause}
              onResume={onResume}
              onRun={onRun}
              onRemove={(id) => onRemove(id, j.name)}
              mutating={mutating}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ────────────────── Event Watchers ────────────────── */

function EventWatchersSection({ watchers }: { watchers: EventWatcher[] }) {
  const [configOpen, setConfigOpen] = useState(false);

  return (
    <div>
      <div className="mb-3 flex items-center justify-end">
        <button
          onClick={() => setConfigOpen(true)}
          className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-marker text-ink-muted transition-colors hover:text-oxide"
        >
          <Settings size={12} /> Edit Configuration
        </button>
      </div>
      <WatcherConfigDialog open={configOpen} onOpenChange={setConfigOpen} />
      {watchers.length === 0 ? (
        <p className="mt-4 font-mono text-[11px] uppercase tracking-marker text-ink-faint">
          no event watchers active.
        </p>
      ) : null}
      {watchers.length > 0 && <div className="responsive-table-wrap">
        <table className="w-full border-collapse font-mono text-[12px] tabular-nums text-ink">
          <thead>
            <tr>
              <Th>NAME</Th>
              <Th>TYPE</Th>
              <Th>STATUS</Th>
              <Th>PATHS</Th>
              <Th>DEBOUNCE</Th>
              <Th align="right">24H</Th>
              <Th align="right">LAST TRIGGER</Th>
            </tr>
          </thead>
          <tbody>
            {watchers.map((w) => (
              <tr
                key={w.id}
                className="border-b border-rule hover:bg-oxide-wash"
              >
                <Td>
                  {w.name}
                  <span className="ml-2 rounded border border-oxide/30 bg-oxide-wash px-1 py-0.5 text-[10px] uppercase">
                    {w.workflow_id}
                  </span>
                </Td>
                <Td>
                  <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase">
                    {w.type.replace("_", " ")}
                  </span>
                </Td>
                <Td>
                  <span
                    className={
                      w.status === "running"
                        ? "text-green-500"
                        : "text-ink-muted"
                    }
                  >
                    {w.status === "running" ? "RUNNING" : "STOPPED"}
                  </span>
                </Td>
                <Td>
                  <span
                    className="text-ink-muted"
                    title={w.watched_paths.join("\n")}
                  >
                    {w.watched_paths
                      .map((p) => p.replace(/^\/Users\/[^/]+\//, "~/"))
                      .join(", ")}
                  </span>
                </Td>
                <Td>{w.debounce_s}s</Td>
                <Td align="right">{w.recent_runs_24h ?? 0}</Td>
                <Td align="right">
                  {w.last_trigger_at
                    ? compactRelTimeFromUnix(w.last_trigger_at)
                    : "\u2014"}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>}
    </div>
  );
}

/* ────────────────── Harness Creator Sheet ────────────────── */

type StepSpec = {
  name: string;
  type: "shell" | "http" | "file_write" | "event" | "python";
  config: Record<string, string>;
  timeout_s: number;
  skip_on_error: boolean;
};

const EMPTY_STEP: StepSpec = {
  name: "",
  type: "shell",
  config: { command: "" },
  timeout_s: 60,
  skip_on_error: false,
};

function HarnessCreatorSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [triggerType, setTriggerType] = useState("cron");
  const [steps, setSteps] = useState<StepSpec[]>([{ ...EMPTY_STEP }]);

  const harnessId = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  const updateStep = (i: number, patch: Partial<StepSpec>) => {
    setSteps((prev) => {
      const next = [...prev];
      next[i] = { ...next[i], ...patch };
      // Reset config when type changes
      if (patch.type && patch.type !== prev[i].type) {
        const defaults: Record<string, Record<string, string>> = {
          shell: { command: "" },
          http: { url: "", method: "GET" },
          file_write: { path: "", content: "" },
          event: { event_type: "", data: "{}" },
          python: { code: "" },
        };
        next[i].config = defaults[patch.type] ?? {};
      }
      return next;
    });
  };

  const updateStepConfig = (i: number, key: string, val: string) => {
    setSteps((prev) => {
      const next = [...prev];
      next[i] = { ...next[i], config: { ...next[i].config, [key]: val } };
      return next;
    });
  };

  const create = useApiMutation({
    mutationFn: () =>
      api.createHarness({
        id: harnessId,
        name: name.trim(),
        trigger_type: triggerType,
        steps,
      }),
    successMessage: `Harness "${harnessId}" created`,
    onSuccess: () => {
      onOpenChange(false);
      setName("");
      setSteps([{ ...EMPTY_STEP }]);
      qc.invalidateQueries({ queryKey: ["workflows", "catalog"] });
    },
  });

  const canCreate =
    harnessId.length >= 3 &&
    steps.length > 0 &&
    steps.every((s) => s.name.trim());

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="font-mono text-[11px] uppercase tracking-marker">
            Create Custom Harness
          </SheetTitle>
        </SheetHeader>
        <SheetBody>
          <div className="space-y-4">
            {/* Name + ID */}
            <div>
              <label className="mb-1 block font-mono text-[10px] uppercase tracking-marker text-ink-muted">
                Harness Name
              </label>
              <input
                type="text"
                placeholder="My Custom Workflow"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full border border-rule bg-bg px-3 py-1.5 font-mono text-[12px] text-ink placeholder:text-ink-faint focus:border-oxide-edge focus:outline-none"
              />
              {harnessId && (
                <p className="mt-1 font-mono text-[10px] text-ink-faint">
                  ID: <span className="text-oxide">{harnessId}</span>
                </p>
              )}
            </div>

            {/* Trigger type */}
            <div>
              <label className="mb-1 block font-mono text-[10px] uppercase tracking-marker text-ink-muted">
                Trigger Type
              </label>
              <select
                value={triggerType}
                onChange={(e) => setTriggerType(e.target.value)}
                className="w-full border border-rule bg-bg px-3 py-1.5 font-mono text-[12px] text-ink focus:border-oxide-edge focus:outline-none"
              >
                <option value="cron">Cron (scheduled)</option>
                <option value="manual">Manual (on-demand)</option>
              </select>
            </div>

            {/* Steps */}
            <div>
              <label className="mb-2 block font-mono text-[10px] uppercase tracking-marker text-ink-muted">
                Steps ({steps.length})
              </label>
              {steps.map((step, i) => (
                <div
                  key={i}
                  className="mb-3 border border-rule bg-bg p-3"
                >
                  <div className="mb-2 flex items-center justify-between">
                    <span className="font-mono text-[9px] uppercase tracking-marker text-ink-faint">
                      Step {i + 1}
                    </span>
                    {steps.length > 1 && (
                      <button
                        onClick={() =>
                          setSteps((p) => p.filter((_, j) => j !== i))
                        }
                        className="font-mono text-[10px] text-ink-faint hover:text-danger"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                  <div className="space-y-2">
                    <input
                      type="text"
                      placeholder="step_name (snake_case)"
                      value={step.name}
                      onChange={(e) =>
                        updateStep(i, { name: e.target.value })
                      }
                      className="w-full border border-rule bg-bg-alt px-2 py-1 font-mono text-[11px] text-ink placeholder:text-ink-faint focus:border-oxide-edge focus:outline-none"
                    />
                    <select
                      value={step.type}
                      onChange={(e) =>
                        updateStep(i, {
                          type: e.target.value as StepSpec["type"],
                        })
                      }
                      className="w-full border border-rule bg-bg-alt px-2 py-1 font-mono text-[11px] text-ink focus:border-oxide-edge focus:outline-none"
                    >
                      <option value="shell">Shell Command</option>
                      <option value="http">HTTP Request</option>
                      <option value="file_write">File Write</option>
                      <option value="event">Event Publish</option>
                      <option value="python">Python (Advanced)</option>
                    </select>

                    {/* Type-specific config */}
                    {step.type === "shell" && (
                      <textarea
                        placeholder="command to run"
                        value={step.config.command ?? ""}
                        onChange={(e) =>
                          updateStepConfig(i, "command", e.target.value)
                        }
                        rows={2}
                        className="w-full resize-y border border-rule bg-bg-alt px-2 py-1 font-mono text-[11px] text-ink placeholder:text-ink-faint focus:border-oxide-edge focus:outline-none"
                      />
                    )}
                    {step.type === "http" && (
                      <>
                        <div className="flex gap-2">
                          <select
                            value={step.config.method ?? "GET"}
                            onChange={(e) =>
                              updateStepConfig(i, "method", e.target.value)
                            }
                            className="w-24 border border-rule bg-bg-alt px-2 py-1 font-mono text-[11px] text-ink focus:border-oxide-edge focus:outline-none"
                          >
                            <option value="GET">GET</option>
                            <option value="POST">POST</option>
                            <option value="PUT">PUT</option>
                            <option value="DELETE">DELETE</option>
                          </select>
                          <input
                            type="text"
                            placeholder="https://api.example.com/data"
                            value={step.config.url ?? ""}
                            onChange={(e) =>
                              updateStepConfig(i, "url", e.target.value)
                            }
                            className="flex-1 border border-rule bg-bg-alt px-2 py-1 font-mono text-[11px] text-ink placeholder:text-ink-faint focus:border-oxide-edge focus:outline-none"
                          />
                        </div>
                        <textarea
                          placeholder="request body (optional)"
                          value={step.config.body ?? ""}
                          onChange={(e) =>
                            updateStepConfig(i, "body", e.target.value)
                          }
                          rows={2}
                          className="w-full resize-y border border-rule bg-bg-alt px-2 py-1 font-mono text-[11px] text-ink placeholder:text-ink-faint focus:border-oxide-edge focus:outline-none"
                        />
                      </>
                    )}
                    {step.type === "file_write" && (
                      <>
                        <input
                          type="text"
                          placeholder="file path"
                          value={step.config.path ?? ""}
                          onChange={(e) =>
                            updateStepConfig(i, "path", e.target.value)
                          }
                          className="w-full border border-rule bg-bg-alt px-2 py-1 font-mono text-[11px] text-ink placeholder:text-ink-faint focus:border-oxide-edge focus:outline-none"
                        />
                        <textarea
                          placeholder="file content"
                          value={step.config.content ?? ""}
                          onChange={(e) =>
                            updateStepConfig(i, "content", e.target.value)
                          }
                          rows={3}
                          className="w-full resize-y border border-rule bg-bg-alt px-2 py-1 font-mono text-[11px] text-ink placeholder:text-ink-faint focus:border-oxide-edge focus:outline-none"
                        />
                      </>
                    )}
                    {step.type === "event" && (
                      <>
                        <input
                          type="text"
                          placeholder="event.type"
                          value={step.config.event_type ?? ""}
                          onChange={(e) =>
                            updateStepConfig(i, "event_type", e.target.value)
                          }
                          className="w-full border border-rule bg-bg-alt px-2 py-1 font-mono text-[11px] text-ink placeholder:text-ink-faint focus:border-oxide-edge focus:outline-none"
                        />
                        <textarea
                          placeholder='{"key": "value"}'
                          value={step.config.data ?? "{}"}
                          onChange={(e) =>
                            updateStepConfig(i, "data", e.target.value)
                          }
                          rows={2}
                          className="w-full resize-y border border-rule bg-bg-alt px-2 py-1 font-mono text-[11px] text-ink placeholder:text-ink-faint focus:border-oxide-edge focus:outline-none"
                        />
                      </>
                    )}
                    {step.type === "python" && (
                      <>
                        <div className="border border-warning/30 bg-warning/5 px-2 py-1 font-mono text-[9px] text-warning">
                          Advanced: runs arbitrary Python in the gateway process
                        </div>
                        <textarea
                          placeholder={'# ctx dict has outputs from previous steps\nitems = ctx.get("prev_step", {}).get("data", [])\nreturn {"count": len(items)}'}
                          value={step.config.code ?? ""}
                          onChange={(e) =>
                            updateStepConfig(i, "code", e.target.value)
                          }
                          rows={5}
                          className="w-full resize-y border border-rule bg-bg-alt px-2 py-1 font-mono text-[11px] text-ink placeholder:text-ink-faint focus:border-oxide-edge focus:outline-none"
                        />
                      </>
                    )}

                    {/* Timeout + skip */}
                    <div className="flex items-center gap-3">
                      <label className="flex items-center gap-1 font-mono text-[10px] text-ink-faint">
                        Timeout:
                        <input
                          type="number"
                          min={5}
                          value={step.timeout_s}
                          onChange={(e) =>
                            updateStep(i, {
                              timeout_s: parseInt(e.target.value, 10) || 60,
                            })
                          }
                          className="w-16 border border-rule bg-bg-alt px-1 py-0.5 font-mono text-[10px] text-ink focus:border-oxide-edge focus:outline-none"
                        />
                        s
                      </label>
                      <label className="flex items-center gap-1 font-mono text-[10px] text-ink-faint">
                        <input
                          type="checkbox"
                          checked={step.skip_on_error}
                          onChange={(e) =>
                            updateStep(i, {
                              skip_on_error: e.target.checked,
                            })
                          }
                          className="accent-oxide"
                        />
                        Skip on error
                      </label>
                    </div>
                  </div>
                </div>
              ))}
              <button
                onClick={() => setSteps([...steps, { ...EMPTY_STEP }])}
                className="font-mono text-[10px] text-ink-muted hover:text-oxide"
              >
                + Add step
              </button>
            </div>
          </div>
        </SheetBody>
        <SheetFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            className="font-mono text-[11px]"
          >
            Cancel
          </Button>
          <Button
            onClick={() => create.mutate()}
            disabled={!canCreate || create.isPending}
            className="font-mono text-[11px]"
          >
            {create.isPending ? "Creating..." : "Create Harness"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

/* ────────────────── Watcher Config Dialog ────────────────── */

function WatcherConfigDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data } = useQuery({
    queryKey: ["dashboard", "config"],
    queryFn: api.config,
    enabled: open,
  });

  const cfg = data?.config ?? {};
  const fw = (cfg.workflows as Record<string, any>)?.file_watcher ?? {};

  const [paths, setPaths] = useState<string[]>([]);
  const [excludes, setExcludes] = useState<string[]>([]);
  const [debounce, setDebounce] = useState("2");

  useEffect(() => {
    if (open && fw) {
      setPaths(Array.isArray(fw.paths) ? [...fw.paths] : []);
      setExcludes(
        Array.isArray(fw.exclude_dirs)
          ? [...fw.exclude_dirs]
          : typeof fw.exclude_dirs === "object"
            ? Object.keys(fw.exclude_dirs)
            : [],
      );
      setDebounce(String(fw.debounce_s ?? "2"));
    }
  }, [open, JSON.stringify(fw)]);

  const save = useApiMutation({
    mutationFn: () =>
      api.putConfig({
        "workflows.file_watcher.paths": paths.filter((p) => p.trim()),
        "workflows.file_watcher.debounce_s": parseFloat(debounce) || 2,
        "workflows.file_watcher.exclude_dirs": excludes.filter((e) => e.trim()),
      }),
    successMessage: "Watcher config saved. Restart gateway to apply.",
    onSuccess: () => onOpenChange(false),
  });

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50"
      onClick={() => onOpenChange(false)}
    >
      <div
        className="w-full max-w-lg border border-rule bg-bg p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-2 font-mono text-[11px] uppercase tracking-marker text-ink-muted">
          File Watcher Configuration
        </h3>
        <p className="mb-4 font-mono text-[10px] leading-relaxed text-ink-faint">
          The file watcher monitors directories for changes and triggers the watch-and-notify workflow.
          Debounce controls how long to wait after the last file change before triggering (prevents
          rapid-fire triggers during bulk saves). Changes here require a gateway restart to take effect.
        </p>

        {/* Watched Paths */}
        <div className="mb-4">
          <label className="mb-1 block font-mono text-[10px] uppercase tracking-marker text-ink-faint">
            Watched Paths
          </label>
          {paths.map((p, i) => (
            <div key={i} className="mb-1 flex gap-1">
              <input
                type="text"
                value={p}
                onChange={(e) => {
                  const next = [...paths];
                  next[i] = e.target.value;
                  setPaths(next);
                }}
                className="flex-1 border border-rule bg-bg px-2 py-1 font-mono text-[12px] text-ink focus:border-oxide-edge focus:outline-none"
              />
              <button
                onClick={() => setPaths(paths.filter((_, j) => j !== i))}
                className="px-2 font-mono text-[12px] text-ink-faint hover:text-danger"
              >
                -
              </button>
            </div>
          ))}
          <button
            onClick={() => setPaths([...paths, ""])}
            className="mt-1 font-mono text-[10px] text-ink-muted hover:text-oxide"
          >
            + Add path
          </button>
        </div>

        {/* Exclude Dirs */}
        <div className="mb-4">
          <label className="mb-1 block font-mono text-[10px] uppercase tracking-marker text-ink-faint">
            Exclude Directories
          </label>
          {excludes.map((e, i) => (
            <div key={i} className="mb-1 flex gap-1">
              <input
                type="text"
                value={e}
                onChange={(ev) => {
                  const next = [...excludes];
                  next[i] = ev.target.value;
                  setExcludes(next);
                }}
                className="flex-1 border border-rule bg-bg px-2 py-1 font-mono text-[12px] text-ink focus:border-oxide-edge focus:outline-none"
              />
              <button
                onClick={() => setExcludes(excludes.filter((_, j) => j !== i))}
                className="px-2 font-mono text-[12px] text-ink-faint hover:text-danger"
              >
                -
              </button>
            </div>
          ))}
          <button
            onClick={() => setExcludes([...excludes, ""])}
            className="mt-1 font-mono text-[10px] text-ink-muted hover:text-oxide"
          >
            + Add directory
          </button>
        </div>

        {/* Debounce */}
        <div className="mb-6">
          <label className="mb-1 block font-mono text-[10px] uppercase tracking-marker text-ink-faint">
            Debounce (seconds)
          </label>
          <input
            type="number"
            min={0.5}
            step={0.5}
            value={debounce}
            onChange={(e) => setDebounce(e.target.value)}
            className="w-24 border border-rule bg-bg px-2 py-1 font-mono text-[12px] text-ink focus:border-oxide-edge focus:outline-none"
          />
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => save.mutate()}
            disabled={save.isPending}
          >
            {save.isPending ? "Saving..." : "Save"}
          </Button>
        </div>
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
