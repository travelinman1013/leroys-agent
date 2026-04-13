/**
 * /cron — Operator's Desk dense tabular cron view.
 *
 * Mono table; cron strings rendered in oxide; hover rows use --oxide-wash;
 * refresh marker in the meters strip. See DESIGN.md §6 row `/cron`.
 */

import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Play, Pause, Trash2 } from "lucide-react";
import { compactRelTimeFromUnix, relTimeFromUnix } from "@/lib/utils";
import { cronSearch, useSyncSearchToStorage } from "@/lib/searchParams";

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
  const next = jobs
    .map((j) => j.next_run_at)
    .filter((t): t is number => typeof t === "number")
    .sort((a, b) => a - b)[0];

  return (
    <div className="bg-bg">
      {/* meters strip — chrome-style header */}
      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-6 border-b border-rule bg-bg-alt px-10 py-4 font-mono text-[10px] uppercase tracking-marker text-ink-muted">
        <div className="text-ink">CRON</div>
        <div className="flex items-center justify-center gap-7">
          <Meter label="Jobs" value={String(jobs.length)} />
          <Meter label="Running" value={String(running)} warm={running > 0} />
          <Meter label="Next" value={next ? relTimeFromUnix(next) : "—"} />
        </div>
        <div className="text-ink-faint">REFRESH 10s</div>
      </div>

      <div className="px-10 pb-6 pt-9">
        <h1 className="page-stamp text-[56px]">
          <em>scheduled</em> tasks
        </h1>
        <p className="mt-3 font-mono text-[10px] uppercase tracking-marker text-ink-muted">
          ─── {jobs.length} JOBS · MONO TABLE · CRON IN OXIDE ──
        </p>
      </div>

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
            {jobs.map((j) => {
              const id = String(j.id ?? "");
              const isRunning = j.state === "running";
              const isPaused = j.state === "paused" || !j.enabled;
              return (
                <tr
                  key={id}
                  className="border-b border-rule transition-colors duration-120 ease-operator hover:bg-oxide-wash"
                >
                  <Td className="text-ink-faint">{id.slice(0, 8)}</Td>
                  <Td className="text-ink">{String(j.name ?? "—")}</Td>
                  <Td className="text-oxide">
                    {j.schedule_display || JSON.stringify(j.schedule)}
                  </Td>
                  <Td className="text-ink-2">
                    {j.next_run_at ? compactRelTimeFromUnix(j.next_run_at) : "—"}
                  </Td>
                  <Td className="text-ink-2">
                    {j.last_run_at ? compactRelTimeFromUnix(j.last_run_at) : "—"}
                    {j.last_status && (
                      <span className="ml-2 text-ink-faint">
                        · {j.last_status}
                      </span>
                    )}
                  </Td>
                  <Td align="right" className="text-ink-2">
                    {String(j.run_count ?? 0)}
                  </Td>
                  <Td align="right">
                    <div className="flex justify-end gap-1">
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => run.mutate(id)}
                        disabled={run.isPending}
                        title="Run now"
                      >
                        <Play className="size-3" />
                      </Button>
                      {!isPaused && (
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => pause.mutate(id)}
                          disabled={pause.isPending}
                          title="Pause"
                        >
                          <Pause className="size-3" />
                        </Button>
                      )}
                      {isPaused && !isRunning && (
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => resume.mutate(id)}
                          disabled={resume.isPending}
                          title="Resume"
                        >
                          <Play className="size-3" />
                        </Button>
                      )}
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => {
                          if (confirm(`Delete cron job "${j.name}"?`)) {
                            remove.mutate(id);
                          }
                        }}
                        disabled={remove.isPending}
                        title="Delete"
                      >
                        <Trash2 className="size-3" />
                      </Button>
                    </div>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {jobs.length === 0 && !isLoading && (
          <p className="mt-6 font-mono text-[11px] uppercase tracking-marker text-ink-faint">
            no cron jobs scheduled. create one via{" "}
            <span className="text-oxide">hermes cron add</span>
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
    <td
      className={`px-4 py-3 ${className}`}
      style={{ textAlign: align }}
    >
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
      <span className={warm ? "text-oxide tabular-nums" : "text-ink tabular-nums"}>
        {value}
      </span>
    </span>
  );
}
