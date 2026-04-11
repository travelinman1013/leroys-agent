/**
 * StatusHeader — the systems strip.
 *
 * Operator's Desk header from DESIGN.md §6 / preview §00. Mono UPPERCASE
 * patch-bay metrics across a hairline-divided strip. No icons, no badges,
 * no chrome. The brand mark sits on the left, live pulse metrics in the
 * middle, theme toggle on the right. Wraps the existing
 * /api/dashboard/state query.
 */

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { formatUptime } from "@/lib/utils";
import { useTheme } from "@/lib/theme";

export function StatusHeader() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["dashboard", "state"],
    queryFn: api.state,
    refetchInterval: 5_000,
  });

  const gateway = data?.gateway;
  const connected = !isLoading && !error && Boolean(gateway);

  return (
    <header className="grid h-14 grid-cols-[auto_1fr_auto] items-center gap-8 border-b border-rule bg-bg px-6 font-mono text-[11px] uppercase tracking-marker text-ink-muted">
      {/* ── brand ────────────────────────────────────────────── */}
      <div className="flex items-baseline gap-3.5">
        <span className="font-display text-[13px] font-bold tracking-marker text-ink">
          HERMES
        </span>
        <span className="text-ink-faint">v0.8.0 · operator's desk</span>
      </div>

      {/* ── pulse meters ─────────────────────────────────────── */}
      <div className="flex items-center justify-center gap-6">
        <Meter
          dot={connected ? "ok" : error ? "danger" : "warm"}
          label={connected ? "Sandbox OK" : error ? "Offline" : "Connecting"}
        />
        {data?.model && (
          <Meter label="Model" value={shortModel(data.model)} />
        )}
        {gateway?.uptime_seconds !== undefined && (
          <Meter label="Up" value={formatUptime(gateway.uptime_seconds)} />
        )}
        {data?.event_bus && (
          <Meter
            label="Bus"
            value={`${data.event_bus.subscribers} sub`}
          />
        )}
      </div>

      {/* ── theme toggle ─────────────────────────────────────── */}
      <ThemeToggle />
    </header>
  );
}

function Meter({
  dot,
  label,
  value,
  warm,
}: {
  dot?: "ok" | "warm" | "warn" | "danger";
  label: string;
  value?: string;
  warm?: boolean;
}) {
  return (
    <span className="flex items-baseline gap-2">
      {dot && <Dot kind={dot} />}
      <span>{label}</span>
      {value && (
        <span
          className={
            warm
              ? "text-oxide tabular-nums"
              : "text-ink tabular-nums"
          }
        >
          {value}
        </span>
      )}
    </span>
  );
}

function Dot({ kind }: { kind: "ok" | "warm" | "warn" | "danger" }) {
  const cls =
    kind === "warm"
      ? "bg-oxide oxide-pulse"
      : kind === "warn"
        ? "bg-warning"
        : kind === "danger"
          ? "bg-danger"
          : "bg-success";
  return (
    <span className={`inline-block size-1.5 rounded-full ${cls}`} />
  );
}

function ThemeToggle() {
  const { theme, toggle } = useTheme();
  return (
    <button
      onClick={toggle}
      className="rounded-sm border border-rule px-3.5 py-1.5 font-mono text-[10px] uppercase tracking-wide text-ink-2 transition-colors duration-120 ease-operator hover:border-oxide-edge hover:text-oxide"
    >
      {theme === "dark" ? "◐ LIGHT MODE" : "◑ DARK MODE"}
    </button>
  );
}

function shortModel(model: string): string {
  // "google/gemma-4-26b-a4b" → "GEMMA-4-26B"
  const tail = model.split("/").pop() ?? model;
  return tail
    .replace(/-a\d+b?$/i, "")
    .toUpperCase()
    .slice(0, 14);
}
