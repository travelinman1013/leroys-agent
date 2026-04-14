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

/**
 * Compact relative time for dense-scan tables.
 *
 *   < 5s    → "now"
 *   < 1m    → "12s"
 *   < 1h    → "45m"
 *   < 1d    → "4h"
 *   < 7d    → "2d"
 *   < 30d   → "3w"
 *   < 365d  → "6mo"   (two-letter to disambiguate from minutes)
 *   ≥ 365d  → "2y"
 *
 * Positive deltas render without a suffix (the column header like
 * "LAST" already implies "ago"). Negative deltas (future timestamps
 * for scheduled cron jobs) render with a leading "in ". Matches the
 * approvals history WHEN column density goal per Maxwell's feedback
 * after Commit 3b.
 */
export function compactRelTimeFromUnix(
  unix: number | null | undefined,
): string {
  if (unix === null || unix === undefined || unix === 0) return "—";
  const nowMs = Date.now();
  const thenMs = unix * 1000;
  const diffSec = Math.round((nowMs - thenMs) / 1000);
  const future = diffSec < 0;
  const abs = Math.abs(diffSec);

  let value: string;
  if (abs < 5) value = "now";
  else if (abs < 60) value = `${abs}s`;
  else if (abs < 3_600) value = `${Math.floor(abs / 60)}m`;
  else if (abs < 86_400) value = `${Math.floor(abs / 3_600)}h`;
  else if (abs < 604_800) value = `${Math.floor(abs / 86_400)}d`;
  else if (abs < 2_592_000) value = `${Math.floor(abs / 604_800)}w`;
  else if (abs < 31_536_000) value = `${Math.floor(abs / 2_592_000)}mo`;
  else value = `${Math.floor(abs / 31_536_000)}y`;

  if (value === "now") return value;
  return future ? `in ${value}` : value;
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

/**
 * Semantic class for an event type. Operator's Desk differentiates events
 * **typographically** (italic for tool, small-caps for memory, UPPERCASE
 * for approval, etc.) — never by color. See DESIGN.md §4 rule 3.
 *
 * Returns a class that lives on the event row so descendant `.evt-label`
 * and `.evt-body` selectors in index.css can apply the right type.
 */
export function eventClass(type: string): string {
  if (type.startsWith("turn.")) return "evt-turn";
  if (type.startsWith("tool.")) return "evt-tool";
  if (type.startsWith("llm.")) return "evt-llm";
  if (type.startsWith("approval.")) return "evt-approval";
  if (type.startsWith("memory.")) return "evt-memory";
  if (type === "compaction" || type.startsWith("compaction.")) return "evt-compaction";
  if (type.startsWith("cron.")) return "evt-cron";
  if (type.startsWith("session.")) return "evt-session";
  if (type.startsWith("workflow.")) return "evt-workflow";
  if (type.startsWith("gateway.")) return "evt-gateway";
  if (type.startsWith("error") || type.includes(".error")) return "evt-error";
  return "evt-gateway";
}

/** Compact label for the type — single word, lowercase, for the event rail. */
export function eventShortLabel(type: string): string {
  if (type.startsWith("turn.")) return "turn";
  if (type.startsWith("tool.")) return "tool";
  if (type.startsWith("llm.")) return "llm";
  if (type.startsWith("approval.")) return "approval";
  if (type.startsWith("memory.")) return "memory";
  if (type === "compaction" || type.startsWith("compaction.")) return "compact";
  if (type.startsWith("cron.")) return "cron";
  if (type.startsWith("session.")) return "session";
  if (type.startsWith("workflow.")) return "workflow";
  if (type.startsWith("gateway.")) return "gateway";
  return type.split(".")[0] || type;
}
