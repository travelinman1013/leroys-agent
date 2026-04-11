import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Native `<select>` styled to match the Operator's Desk Input primitive.
 *
 * No Radix, no portal, no virtualized list — this is a local-first
 * dashboard with 2-5 options per dropdown. The native element is
 * correct by construction: accessible, keyboard-navigable, theme-aware.
 * Only the visual chrome is custom, and it shares tokens with
 * `<Input>` so the /config form looks uniform.
 */
const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, children, ...props }, ref) => {
  return (
    <select
      ref={ref}
      className={cn(
        // 2px radius per DESIGN.md §6, same border + bg tokens as Input.
        // `appearance-none` + the inline SVG caret keeps the native chevron
        // from swapping per-browser and staying on-theme.
        "flex h-9 w-full appearance-none rounded-sm border border-rule-strong bg-bg-alt bg-no-repeat px-3 py-1 pr-8 font-mono text-[13px] text-ink transition-colors duration-120 ease-operator focus-visible:border-oxide focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='8' height='8' viewBox='0 0 8 8'><path d='M1 2 L4 6 L7 2' fill='none' stroke='%238d877b' stroke-width='1.25'/></svg>\")",
        backgroundPosition: "right 0.75rem center",
        backgroundSize: "0.5rem 0.5rem",
      }}
      {...props}
    >
      {children}
    </select>
  );
});
Select.displayName = "Select";

export { Select };
