/**
 * StatusHeader — the systems strip.
 *
 * Operator's Desk header from DESIGN.md §6 / preview §00. Mono UPPERCASE
 * patch-bay metrics across a hairline-divided strip. No icons, no badges,
 * no chrome. The brand mark sits on the left, live pulse metrics in the
 * middle. Wraps the existing /api/dashboard/state query.
 *
 * Theme toggle deliberately does NOT live here — DESIGN.md §9 anti-slop
 * pledge: "A dark-mode toggle in the header (toggle lives in settings,
 * not chrome)." The toggle was relocated to /config Commit 6 of
 * ~/.claude/plans/ashen-tempering-ibis.md.
 */

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { formatUptime } from "@/lib/utils";

interface StatusHeaderProps {
  onTerminalToggle?: () => void;
  onMobileMenuToggle?: () => void;
}

export function StatusHeader({ onTerminalToggle, onMobileMenuToggle }: StatusHeaderProps) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["dashboard", "state"],
    queryFn: api.state,
    refetchInterval: 5_000,
  });

  const cost = useQuery({
    queryKey: ["dashboard", "cost", "summary"],
    queryFn: api.costSummary,
    refetchInterval: 60_000,
  });

  const tokens = useQuery({
    queryKey: ["dashboard", "metrics", "tokens", "24h"],
    queryFn: () => api.metricsTokens("24h"),
    refetchInterval: 60_000,
  });

  const gateway = data?.gateway;
  const connected = !isLoading && !error && Boolean(gateway);

  const todayCost = cost.data?.today_usd;
  const totalTokens = tokens.data?.total
    ? tokens.data.total.input + tokens.data.total.output
    : undefined;

  return (
    <header className="grid h-14 grid-cols-[auto_1fr] items-center gap-2 border-b border-rule bg-bg px-4 font-mono text-[11px] uppercase tracking-marker text-ink-muted sm:gap-4 sm:px-6 md:gap-6 lg:gap-8">
      {/* ── brand + hamburger ─────────────────────────────────── */}
      <div className="flex items-center gap-3">
        {onMobileMenuToggle && (
          <button
            type="button"
            onClick={onMobileMenuToggle}
            aria-label="Open menu"
            className="font-mono text-[20px] leading-none text-ink-muted transition-colors hover:text-oxide md:hidden"
          >
            ≡
          </button>
        )}
        <div className="flex items-baseline gap-3.5">
          <span className="font-display text-[13px] font-bold tracking-marker text-ink">
            LEROYS
          </span>
          <span className="hidden text-ink-faint sm:inline">v0.8.0 · operator's desk</span>
        </div>
      </div>

      {/* ── pulse meters ─────────────────────────────────────── */}
      <div className="flex items-center justify-end gap-3 pr-1 sm:gap-4 md:gap-6 md:pr-2">
        {/* Sandbox status — always visible (critical meter) */}
        <Meter
          dot={connected ? "ok" : error ? "danger" : "warm"}
          label={connected ? "Sandbox OK" : error ? "Offline" : "Connecting"}
        />
        {/* Model + uptime — visible sm+ */}
        {data?.model && (
          <span className="hidden sm:inline">
            <Meter label="Model" value={shortModel(data.model)} />
          </span>
        )}
        {gateway?.uptime_seconds !== undefined && (
          <span className="hidden sm:inline">
            <Meter label="Up" value={formatUptime(gateway.uptime_seconds)} />
          </span>
        )}
        {/* Bus, cost, tokens — visible md+ */}
        {data?.event_bus && (
          <span className="hidden md:inline">
            <Meter
              label="Bus"
              value={`${data.event_bus.subscribers} sub`}
            />
          </span>
        )}
        {todayCost !== undefined && (
          <span className="hidden md:inline">
            <Meter
              label="Cost 24h"
              value={formatCostHeader(todayCost)}
              warm={todayCost > 0.5}
            />
          </span>
        )}
        {totalTokens !== undefined && (
          <span className="hidden lg:inline">
            <Meter
              label="Tok 24h"
              value={compactNumber(totalTokens)}
            />
          </span>
        )}
        {onTerminalToggle && (
          <button
            type="button"
            onClick={onTerminalToggle}
            title="Terminal (Ctrl+`)"
            className="text-ink-muted transition-colors hover:text-oxide"
          >
            &gt;_
          </button>
        )}
      </div>
    </header>
  );
}

function formatCostHeader(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function compactNumber(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
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

function shortModel(model: string): string {
  // "google/gemma-4-26b-a4b" → "GEMMA-4-26B"
  const tail = model.split("/").pop() ?? model;
  return tail
    .replace(/-a\d+b?$/i, "")
    .toUpperCase()
    .slice(0, 14);
}
