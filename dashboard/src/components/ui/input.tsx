import * as React from "react";
import { cn } from "@/lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          // Operator's Desk: 2px radius, hairline border, mono body, no shadow.
          "flex h-9 w-full rounded-sm border border-rule-strong bg-bg-alt px-3 py-1 font-mono text-[13px] text-ink transition-colors duration-120 ease-operator file:border-0 file:bg-transparent file:font-mono file:text-sm file:text-ink placeholder:text-ink-faint focus-visible:outline-none focus-visible:border-oxide disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };
