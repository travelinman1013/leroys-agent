import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import {
  formatDistanceToNow,
  formatDistance,
  format as dateFormat,
} from "date-fns";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Format a unix timestamp (seconds) as "5 minutes ago" */
export function relTimeFromUnix(unix: number | null | undefined): string {
  if (!unix) return "—";
  try {
    return formatDistanceToNow(new Date(unix * 1000), { addSuffix: true });
  } catch {
    return "—";
  }
}

/** Format an ISO timestamp as "5 minutes ago" */
export function relTimeFromIso(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return "—";
  }
}

export function formatUnix(unix: number | null | undefined, fmt = "PPpp"): string {
  if (!unix) return "—";
  try {
    return dateFormat(new Date(unix * 1000), fmt);
  } catch {
    return "—";
  }
}

export function formatDuration(
  from: number | null | undefined,
  to: number | null | undefined,
): string {
  if (!from || !to) return "—";
  try {
    return formatDistance(new Date(from * 1000), new Date(to * 1000));
  } catch {
    return "—";
  }
}

/** Compact number formatting: 1_234 -> "1.2k" */
export function compactNumber(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** USD with 4 decimal precision for tiny costs */
export function formatCost(cost: number | null | undefined): string {
  if (cost === null || cost === undefined) return "—";
  if (cost === 0) return "$0";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

/** Format seconds as "2h 15m" or "45s" */
export function formatUptime(seconds: number): string {
  if (!seconds || seconds < 0) return "—";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** Color class for an event type */
export function eventColorClass(type: string): string {
  if (type.startsWith("turn.")) return "evt-turn";
  if (type.startsWith("tool.")) return "evt-tool";
  if (type.startsWith("llm.")) return "evt-llm";
  if (type.startsWith("approval.")) return "evt-approval";
  if (type === "compaction") return "evt-compaction";
  if (type.startsWith("cron.")) return "evt-cron";
  if (type.startsWith("session.")) return "evt-session";
  if (type.startsWith("gateway.")) return "evt-gateway";
  return "text-muted-foreground";
}
