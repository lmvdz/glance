import { forwardRef } from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius-sm)] border font-[inherit] transition-colors duration-150 cursor-pointer disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
  {
    variants: {
      variant: {
        primary:
          "bg-primary text-primary-foreground border-primary font-semibold hover:bg-accent-hover hover:border-accent-hover",
        secondary: "bg-secondary text-foreground border-border hover:border-border-strong",
        outline: "bg-transparent text-foreground border-border hover:border-border-strong",
        ghost: "bg-transparent text-foreground border-transparent hover:bg-secondary",
        danger: "bg-secondary text-foreground border-border hover:border-danger hover:text-danger",
      },
      size: {
        sm: "min-h-0 px-2 py-[3px] text-[length:var(--text-12)]",
        default: "min-h-[40px] px-3 py-1.5 text-[length:var(--text-14)]",
        icon: "min-h-[40px] min-w-[40px] p-1.5",
      },
    },
    defaultVariants: { variant: "secondary", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
  },
);
Button.displayName = "Button";
