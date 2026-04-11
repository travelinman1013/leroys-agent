/**
 * StatusHeader — the persistent top bar.
 *
 * Shows gateway status, model, sandbox indicator, uptime, and a live
 * subscriber count for the event bus.
 */

import { Badge } from "@/components/ui/badge";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Activity, Cpu, Lock, Radio, Zap } from "lucide-react";
import { formatUptime } from "@/lib/utils";

export function StatusHeader() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["dashboard", "state"],
    queryFn: api.state,
    refetchInterval: 5_000,
  });

  const gateway = data?.gateway;
  const connected = !isLoading && !error && Boolean(gateway);

  return (
    <header className="flex h-14 items-center gap-4 border-b bg-card/50 px-6">
      <div className="flex items-center gap-2">
        <div className="relative">
          <Zap className="size-5 text-indigo-400" />
          {connected && (
            <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-emerald-400 animate-pulse-slow" />
          )}
        </div>
        <span className="font-semibold tracking-tight">Hermes</span>
        <span className="text-xs text-muted-foreground">Dashboard</span>
      </div>

      <div className="ml-4 flex flex-1 items-center gap-3 text-xs">
        <StatusPill
          icon={<Activity className="size-3" />}
          label="Status"
          value={connected ? "online" : error ? "offline" : "connecting…"}
          variant={connected ? "success" : "warn"}
        />
        {data?.model && (
          <StatusPill
            icon={<Cpu className="size-3" />}
            label="Model"
            value={data.model}
          />
        )}
        {gateway?.sandboxed && (
          <StatusPill
            icon={<Lock className="size-3" />}
            label="Sandbox"
            value="Seatbelt"
            variant="success"
          />
        )}
        {gateway?.uptime_seconds !== undefined && (
          <StatusPill
            icon={<Activity className="size-3" />}
            label="Uptime"
            value={formatUptime(gateway.uptime_seconds)}
          />
        )}
        {data?.event_bus && (
          <StatusPill
            icon={<Radio className="size-3" />}
            label="Bus"
            value={`${data.event_bus.subscribers} sub`}
          />
        )}
      </div>
    </header>
  );
}

function StatusPill({
  icon,
  label,
  value,
  variant = "outline",
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  variant?: "outline" | "success" | "warn";
}) {
  return (
    <Badge variant={variant} className="gap-1 font-normal">
      {icon}
      <span className="text-muted-foreground">{label}</span>
      <span className="font-semibold">{value}</span>
    </Badge>
  );
}
