import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Check, X, HeartPulse } from "lucide-react";

export const Route = createFileRoute("/health")({
  component: HealthPage,
});

function HealthPage() {
  const doctor = useQuery({
    queryKey: ["dashboard", "doctor"],
    queryFn: api.doctor,
    refetchInterval: 10_000,
  });
  const config = useQuery({
    queryKey: ["dashboard", "config"],
    queryFn: api.config,
  });

  return (
    <div className="p-6">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Health</h1>
        <p className="text-sm text-muted-foreground">
          Doctor checks and (redacted) runtime config dump.
        </p>
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <HeartPulse className="size-4 text-rose-400" />
              Doctor
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 pt-0">
            {doctor.data?.checks.map((c) => (
              <div
                key={c.name}
                className="flex items-start justify-between gap-2 text-xs"
              >
                <div className="flex items-start gap-2">
                  {c.ok ? (
                    <Check className="mt-0.5 size-3.5 text-emerald-400" />
                  ) : (
                    <X className="mt-0.5 size-3.5 text-destructive" />
                  )}
                  <div>
                    <div className="font-semibold">{c.name}</div>
                    {c.detail && (
                      <div className="text-muted-foreground">{c.detail}</div>
                    )}
                  </div>
                </div>
                <Badge variant={c.ok ? "success" : "destructive"}>
                  {c.ok ? "ok" : "fail"}
                </Badge>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Runtime Config</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <pre className="max-h-96 overflow-auto rounded bg-black/40 p-3 font-mono text-[10px] leading-relaxed text-muted-foreground">
              {config.data
                ? JSON.stringify(config.data.config, null, 2)
                : config.isLoading
                  ? "Loading…"
                  : ""}
            </pre>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
