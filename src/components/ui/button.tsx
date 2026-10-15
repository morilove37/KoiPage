import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/utils";

/** Visual weight of a {@link Button}. */
export type ButtonVariant =
  | "default"
  | "secondary"
  | "outline"
  | "ghost"
  | "destructive";

/** Size of a {@link Button}. */
export type ButtonSize = "sm" | "md" | "lg" | "icon";

const VARIANTS: Record<ButtonVariant, string> = {
  default: "bg-primary text-primary-foreground hover:bg-primary/90",
  secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
  outline:
    "border border-border bg-transparent hover:bg-accent hover:text-accent-foreground",
  ghost: "bg-transparent hover:bg-accent hover:text-accent-foreground",
  destructive:
    "bg-destructive text-destructive-foreground hover:bg-destructive/90",
};

/**
 * Variants whose own background would otherwise sit as an opaque slab on top
 * of a glass pane. A translucent share of the accent tint keeps the frosted
 * look while preserving the visual weight difference between variants.
 *
 * These are gated on `[.glass_&]` — the arbitrary variant Tailwind emits for
 * "an ancestor carries `.glass`" — so they are inert under light/dark.
 */
const GLASS_VARIANTS: Record<ButtonVariant, string> = {
  default: "[.glass_&]:bg-primary/85 [.glass_&]:backdrop-blur-md",
  secondary: "[.glass_&]:bg-white/10 [.glass_&]:backdrop-blur-md",
  outline: "[.glass_&]:bg-white/5 [.glass_&]:backdrop-blur-md",
  ghost: "[.glass_&]:backdrop-blur-sm",
  destructive: "[.glass_&]:bg-destructive/85 [.glass_&]:backdrop-blur-md",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-xs",
  md: "h-9 px-4 text-sm",
  lg: "h-10 px-6 text-sm",
  icon: "h-9 w-9",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner and blocks interaction. */
  loading?: boolean;
  children?: ReactNode;
}

/**
 * Themed button. Forwards every native `<button>` prop, so `title`, `type`,
 * `disabled` and event handlers behave as usual.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    { className, variant = "default", size = "md", loading, disabled, children, ...props },
    ref,
  ) {
    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={cn(
          "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md font-medium",
          "whitespace-nowrap outline-none",
          // `tap` (src/index.css) supplies the 120–180 ms colour/shadow
          // transition *and* the `scale(.97)` press feedback, all of which is
          // neutralised under `prefers-reduced-motion: reduce`.
          "tap",
          "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
          "disabled:pointer-events-none disabled:opacity-50",
          VARIANTS[variant],
          SIZES[size],
          // A subtle inner highlight so primary buttons read as raised on the
          // glass theme without every caller having to opt in.
          "shadow-[inset_0_1px_0_0_hsl(0_0%_100%_/_0.12)]",
          GLASS_VARIANTS[variant],
          className,
        )}
        {...props}
      >
        {loading ? (
          <span
            aria-hidden
            className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
          />
        ) : null}
        {children}
      </button>
    );
  },
);

export default Button;
