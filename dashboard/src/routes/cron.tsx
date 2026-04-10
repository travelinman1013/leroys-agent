import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Play, Pause, Trash2, Clock } from "lucide-react";
import { relTimeFromUnix } from "@/lib/utils";

export const Route = createFileRoute("/cron")({
  component: CronPage,
});

function CronPage() {
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

  const jobs = data?.jobs ?? [];

  return (
    <div className="p-6">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Cron Jobs</h1>
        <p className="text-sm text-muted-foreground">
          Scheduled agent tasks. Each tick delivers its output to the configured channel.
        </p>
      </header>

      {isLoading && (
        <p className="text-sm text-muted-foreground">Loading jobs…</p>
      )}
      {error && (
        <p className="text-sm text-destructive">{(error as Error).message}</p>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        {jobs.map((job: any) => (
          <Card key={job.id}>
            <CardHeader className="pb-2">
              <div className="flex items-start justify-between gap-2">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Clock className="size-4 text-cyan-400" />
                  {job.name}
                </CardTitle>
                <Badge
                  variant={
                    job.enabled && job.state !== "paused" ? "success" : "outline"
                  }
                >
                  {job.state || (job.enabled ? "scheduled" : "paused")}
                </Badge>
              </div>
              <div className="text-xs text-muted-foreground">
                <span className="font-mono">{job.id}</span>
                {" · "}
                {job.schedule_display || JSON.stringify(job.schedule)}
              </div>
            </CardHeader>
            <CardContent className="space-y-3 pt-0">
              <p className="line-clamp-2 text-xs text-muted-foreground">
                {job.prompt}
              </p>
              <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                <span>deliver: {job.deliver}</span>
                <span>
                  last run: {relTimeFromUnix(job.last_run_at)}
                </span>
                <span>
                  next: {relTimeFromUnix(job.next_run_at)}
                </span>
                {job.last_status && <span>status: {job.last_status}</span>}
              </div>
              {job.last_error && (
                <p className="rounded-md bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
                  {job.last_error}
                </p>
              )}
              <div className="flex gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => run.mutate(job.id)}
                  disabled={run.isPending}
                >
                  <Play className="size-3.5" />
                  Run now
                </Button>
                {job.enabled && job.state !== "paused" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => pause.mutate(job.id)}
                    disabled={pause.isPending}
                  >
                    <Pause className="size-3.5" />
                    Pause
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => resume.mutate(job.id)}
                    disabled={resume.isPending}
                  >
                    <Play className="size-3.5" />
                    Resume
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => {
                    if (confirm(`Delete cron job "${job.name}"?`)) {
                      remove.mutate(job.id);
                    }
                  }}
                  disabled={remove.isPending}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {jobs.length === 0 && !isLoading && (
        <p className="text-sm text-muted-foreground">
          No cron jobs scheduled. Create one via the Hermes CLI:{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
            hermes cron add
          </code>
        </p>
      )}
    </div>
  );
}
