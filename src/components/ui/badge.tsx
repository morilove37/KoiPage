import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/utils";

export type BadgeVariant = "default" | "secondary" | "outline" | "status";

// `color` is omitted from the native attributes: here it means "tag colour from
// SQLite" and must accept `null`, which the DOM's `color?: string` does not.
export interface BadgeProps extends Omit<HTMLAttributes<HTMLSpanElement>, "color"> {
  variant?: BadgeVariant;
  /** Custom `background-color`; used for tag colours coming from SQLite. */
  color?: string | null;
  children?: ReactNode;
}

const VARIANTS: Record<BadgeVariant, string> = {
  default: "border-transparent bg-primary text-primary-foreground",
  secondary: "border-transparent bg-secondary text-secondary-foreground",
  outline: "border-border bg-transparent text-foreground",
  status: "border-border bg-muted text-muted-foreground",
};

/** Small pill. `color` wins over `variant` backgrounds when provided. */
export function Badge({ className, variant = "default", color, style, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium leading-5",
        // A badge may be dropped straight on top of a text baselines row where
        // the surrounding background changes on theme flip.
        "transition-[background-color,border-color,color] duration-180 ease-smooth",
        VARIANTS[variant],
        className,
      )}
      style={
        color
          ? { backgroundColor: color, borderColor: color, color: pickTextColor(color), ...style }
          : style
      }
      {...props}
    />
  );
}

/**
 * Pick a readable foreground for an arbitrary tag colour.
 *
 * Only parses `#rgb` / `#rrggbb`; anything else (or a missing colour) falls back
 * to white, which is safe on the saturated palette the tag editor offers.
 */
function pickTextColor(color: string): string {
  const hex = color.trim().replace(/^#/, "");
  const full =
    hex.length === 3
      ? hex
          .split("")
          .map((c) => c + c)
          .join("")
      : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return "#ffffff";
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  // Rec. 601 luma: 0..255, >150 reads as a light background.
  const luma = (r * 299 + g * 587 + b * 114) / 1000;
  return luma > 150 ? "#111111" : "#ffffff";
}

export default Badge;
