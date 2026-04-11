import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

// Operator's Desk button: mono UPPERCASE patch-bay labels, 2px radius,
// hairline borders, no shadows, mechanical 120ms transitions.
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-sm font-mono uppercase tracking-label transition-colors duration-120 ease-operator focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-oxide disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-oxide text-inverse border border-oxide hover:bg-oxide-hover hover:border-oxide-hover",
        destructive:
          "bg-transparent text-danger border border-danger hover:bg-danger/10",
        outline:
          "bg-transparent text-ink border border-rule-strong hover:border-oxide-edge hover:text-oxide",
        secondary:
          "bg-transparent text-ink border border-rule-strong hover:border-oxide-edge hover:text-oxide",
        ghost: "text-ink-2 hover:text-oxide",
        link: "text-oxide underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 text-[11px]",
        sm: "h-8 px-3 text-[10px]",
        lg: "h-10 px-6 text-[12px]",
        icon: "h-8 w-8 [&_svg]:size-3.5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
