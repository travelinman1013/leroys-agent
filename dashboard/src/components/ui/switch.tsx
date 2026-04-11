import * as React from "react";
import { cn } from "@/lib/utils";

interface SwitchProps {
  checked: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  "aria-label"?: string;
  className?: string;
}

/** Operator's Desk hairline toggle. */
export const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  ({ checked, onCheckedChange, disabled, className, ...rest }, ref) => (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => !disabled && onCheckedChange?.(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 items-center border border-rule transition-colors duration-120 ease-operator",
        checked ? "bg-oxide" : "bg-bg",
        disabled && "opacity-50 cursor-not-allowed",
        className,
      )}
      {...rest}
    >
      <span
        className={cn(
          "block h-3 w-3 transform border border-rule bg-card transition-transform duration-120 ease-operator",
          checked ? "translate-x-5" : "translate-x-0.5",
        )}
      />
    </button>
  ),
);
Switch.displayName = "Switch";
