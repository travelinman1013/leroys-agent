import * as React from "react";
import { cn } from "@/lib/utils";

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        // Operator's Desk: hairline border, mono body, no rounded.
        "block w-full resize-y border border-rule bg-bg px-3 py-2 font-mono text-sm leading-snug text-foreground",
        "focus:outline-none focus-visible:ring-1 focus-visible:ring-oxide",
        "placeholder:text-muted-foreground",
        className,
      )}
      {...props}
    />
  ),
);
Textarea.displayName = "Textarea";

export { Textarea };
