import type { CSSProperties, HTMLAttributes } from "react";

import { cn } from "@/lib/utils";

export interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {
  /** Any Tailwind size/rounding utility, e.g. `h-4 w-32` or `size-10 rounded-full`. */
  className?: string;
  /**
   * `pulse` (default) is a soft opacity breath; `shimmer` sweeps a highlight
   * across the block. Shimmer reads better for wide rows and covers.
   */
  variant?: "pulse" | "shimmer";
  /** Renders as an inline block instead of a full-width block. */
  inline?: boolean;
}

/**
 * Loading placeholder.
 *
 * Both variants are pure CSS (see `.shimmer` in `src/index.css`), and both are
 * reduced to a slow steady pulse under `prefers-reduced-motion: reduce`.
 *
 * Marked `aria-hidden` because a skeleton is decoration: the accessible
 * "something is loading" signal belongs on the surrounding region, e.g.
 * `aria-busy` / a visually-hidden status line.
 */
export function Skeleton({
  className,
  variant = "pulse",
  inline,
  ...props
}: SkeletonProps) {
  return (
    <div
      aria-hidden
      className={cn(
        "rounded-md bg-muted",
        inline ? "inline-block align-middle" : "block",
        variant === "shimmer" ? "shimmer" : "animate-pulse",
        className,
      )}
      {...props}
    />
  );
}

export interface SkeletonTextProps {
  /** Number of lines; the last one is shortened to look like prose. */
  lines?: number;
  className?: string;
  lineClassName?: string;
  variant?: SkeletonProps["variant"];
}

/** A paragraph of skeleton lines. */
export function SkeletonText({
  lines = 3,
  className,
  lineClassName,
  variant = "pulse",
}: SkeletonTextProps) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {Array.from({ length: Math.max(1, lines) }, (_, index) => (
        <Skeleton
          key={index}
          variant={variant}
          className={cn("h-3", lineClassName)}
          style={
            index === lines - 1 && lines > 1
              ? ({ width: "62%" } satisfies CSSProperties)
              : undefined
          }
        />
      ))}
    </div>
  );
}

export interface SkeletonCardGridProps {
  /** Number of tiles to render. */
  count?: number;
  className?: string;
}

/**
 * Grid-of-game-cards placeholder, matching `GameCard`'s proportions so the
 * layout does not jump when the real data arrives.
 */
export function SkeletonCardGrid({ count = 8, className }: SkeletonCardGridProps) {
  return (
    <div
      aria-hidden
      className={cn(
        "grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-4",
        className,
      )}
    >
      {Array.from({ length: Math.max(1, count) }, (_, index) => (
        <div
          key={index}
          className="flex flex-col overflow-hidden rounded-lg border border-border bg-card"
        >
          <Skeleton
            variant="shimmer"
            className="aspect-[3/4] w-full rounded-none"
          />
          <div className="flex flex-col gap-2 p-2.5">
            <Skeleton className="h-3.5 w-4/5" />
            <Skeleton className="h-3 w-1/2" />
            <Skeleton className="mt-1 h-3 w-2/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

export interface SkeletonRowsProps {
  count?: number;
  className?: string;
}

/** List-view placeholder: one row per game in the table layout. */
export function SkeletonRows({ count = 8, className }: SkeletonRowsProps) {
  return (
    <div aria-hidden className={cn("flex flex-col", className)}>
      {Array.from({ length: Math.max(1, count) }, (_, index) => (
        <div
          key={index}
          className="flex items-center gap-3 border-b border-border px-3 py-3 last:border-b-0"
        >
          <Skeleton variant="shimmer" className="h-10 w-8 shrink-0 rounded" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton variant="shimmer" className="h-3.5 w-2/5" />
            <Skeleton className="h-3 w-1/4" />
          </div>
          <Skeleton className="hidden h-3 w-32 sm:block" />
          <Skeleton className="hidden h-5 w-16 rounded-full md:block" />
          <Skeleton className="h-3 w-10" />
        </div>
      ))}
    </div>
  );
}

export default Skeleton;
