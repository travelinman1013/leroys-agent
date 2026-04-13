/**
 * Shared table primitives — extracted from desk.tsx, sessions.tsx, cron.tsx,
 * workflows.tsx where identical Th definitions were duplicated.
 *
 * Operator's Desk: hairline borders, mono 10px uppercase tracking-marker.
 */

import { cn } from "@/lib/utils";

export function Th({
  children,
  align = "left",
  className,
}: {
  children?: React.ReactNode;
  align?: "left" | "right" | "center";
  className?: string;
}) {
  return (
    <th
      className={cn(
        "border-b border-rule-strong px-3 py-2 font-mono text-[10px] font-normal uppercase tracking-marker text-ink-muted",
        align === "right" && "text-right",
        align === "center" && "text-center",
        className,
      )}
    >
      {children}
    </th>
  );
}

export function compactNumber(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function formatCost(usd: number | null | undefined): string {
  if (usd == null) return "—";
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}
