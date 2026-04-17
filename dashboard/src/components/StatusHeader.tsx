/**
 * StatusHeader — the systems strip + top navigation.
 *
 * Operator's Desk header from DESIGN.md §6 / preview §00. Mono UPPERCASE
 * patch-bay metrics across a hairline-divided strip. The brand mark sits
 * on the left, live pulse metrics on the right, and route navigation in
 * a second row below.
 *
 * Navigation: icon-only on mobile, full labels on md+. Active route
 * highlighted with oxide color and a bottom border.
 *
 * Theme toggle deliberately does NOT live here — DESIGN.md §9 anti-slop
 * pledge: "A dark-mode toggle in the header (toggle lives in settings,
 * not chrome)."
 */

import { useQuery } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  Pulse,
  Monitor,
  Brain,
  ShieldCheck,
  CalendarDots,
  Lightning,
  Plugs,
  Key,
  Heartbeat,
  GearSix,
} from "@phosphor-icons/react";
import type { ComponentType } from "react";
import { api } from "@/lib/api";
import { cn, formatUptime } from "@/lib/utils";

interface StatusHeaderProps {
  onTerminalToggle?: () => void;
}

type NavItem = {
  to: string;
  label: string;
  Icon: ComponentType<{ size?: number; weight?: "bold" | "regular" }>;
};

const navItems: NavItem[] = [
  { to: "/", label: "Live", Icon: Pulse },
  { to: "/desk", label: "Desk", Icon: Monitor },
  { to: "/brain", label: "Brain", Icon: Brain },
  { to: "/approvals", label: "Approvals", Icon: ShieldCheck },
  { to: "/cron", label: "Schedule", Icon: CalendarDots },
  { to: "/skills", label: "Skills", Icon: Lightning },
  { to: "/mcp", label: "MCP", Icon: Plugs },
  { to: "/keys", label: "Keys", Icon: Key },
  { to: "/health", label: "Health", Icon: Heartbeat },
  { to: "/config", label: "Config", Icon: GearSix },
];

function isActive(pathname: string, to: string): boolean {
  return to === "/" ? pathname === "/" : pathname.startsWith(to);
}

export function StatusHeader({ onTerminalToggle }: StatusHeaderProps) {
  const location = useRouterState({ select: (s) => s.location });

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
    <header className="border-b border-rule bg-bg">
      {/* ── metrics strip ──────────────────────────────────────── */}
      <div className="grid h-14 grid-cols-[auto_1fr] items-center gap-2 px-4 font-mono text-[11px] uppercase tracking-marker text-ink-muted sm:gap-4 sm:px-6 md:gap-6 lg:gap-8">
        {/* brand */}
        <div className="flex items-baseline gap-3.5">
          <span className="font-display text-[13px] font-bold tracking-marker text-ink">
            LEROYS
          </span>
          <span className="hidden text-ink-faint sm:inline">v0.10.0 · operator's desk</span>
        </div>

        {/* pulse meters */}
        <div className="flex items-center justify-end gap-3 pr-1 sm:gap-4 md:gap-6 md:pr-2">
          <Meter
            dot={connected ? "ok" : error ? "danger" : "warm"}
            label={connected ? "Sandbox OK" : error ? "Offline" : "Connecting"}
          />
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
      </div>

      {/* ── navigation strip ───────────────────────────────────── */}
      <nav className="flex items-center gap-0 overflow-x-auto border-t border-rule px-2 font-mono text-[11px] uppercase tracking-marker sm:px-4">
        {navItems.map((item) => {
          const active = isActive(location.pathname, item.to);
          return (
            <Link
              key={item.to}
              to={item.to}
              title={item.label}
              className={cn(
                "relative flex shrink-0 items-center px-3 py-2.5 transition-colors duration-120 ease-operator",
                active
                  ? "text-oxide"
                  : "text-ink-muted hover:text-ink",
              )}
            >
              {/* Icon always visible, label on md+ */}
              <item.Icon size={16} weight={active ? "bold" : "regular"} />
              <span className="hidden md:inline ml-1.5">{item.label}</span>
              {/* Active indicator — bottom border */}
              {active && (
                <span className="absolute inset-x-0 bottom-0 h-0.5 bg-oxide" />
              )}
            </Link>
          );
        })}
      </nav>
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
  const tail = model.split("/").pop() ?? model;
  return tail
    .replace(/-a\d+b?$/i, "")
    .toUpperCase()
    .slice(0, 14);
}
