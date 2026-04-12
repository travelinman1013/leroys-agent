/**
 * SectionMarker — DESIGN.md section divider.
 *
 *   --- LABEL -----------------------------------------------
 *
 * 10px Switzer uppercase, tracking 0.14em, --rule hairline.
 */

import { cn } from "@/lib/utils";

type Props = {
  label: string;
  className?: string;
};

export function SectionMarker({ label, className }: Props) {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <span className="shrink-0 font-body text-[10px] uppercase tracking-marker text-ink-muted">
        {label}
      </span>
      <span className="h-px flex-1 bg-rule" />
    </div>
  );
}
