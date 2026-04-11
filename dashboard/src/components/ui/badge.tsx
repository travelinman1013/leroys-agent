import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

// Operator's Desk badge: mono UPPERCASE patch-bay chip, 2px radius,
// 1px hairline, no fills (semantic colors are tinted from the wash).
const badgeVariants = cva(
  "inline-flex items-center rounded-sm border px-2 py-0.5 font-mono text-[10px] uppercase tracking-label transition-colors focus:outline-none",
  {
    variants: {
      variant: {
        default: "border-oxide-edge bg-oxide-wash text-oxide",
        secondary: "border-rule-strong bg-transparent text-ink-2",
        destructive: "border-danger/40 bg-transparent text-danger",
        outline: "border-rule-strong bg-transparent text-ink-2",
        success: "border-success/40 bg-transparent text-success",
        warn: "border-warning/40 bg-transparent text-warning",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
