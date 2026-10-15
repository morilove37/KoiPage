import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/utils";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-card text-card-foreground shadow-sm",
        // Colours/shadows settle instead of snapping when the theme flips or
        // the card is hovered by a parent `.lift`.
        "transition-[background-color,border-color,box-shadow] duration-180 ease-smooth",
        className,
      )}
      {...props}
    />
  );
}

export interface InteractiveCardProps extends HTMLAttributes<HTMLDivElement> {
  /** Renders as a keyboard-focusable, hoverable surface. */
  as?: "div" | "button" | "a";
}

/**
 * {@link Card} that behaves like a target: it lifts on hover and recedes on
 * press. Use this for tiles the user clicks; the plain {@link Card} stays for
 * static panels (so a form panel never twitches when the mouse crosses it).
 *
 * The lift is transform-only, so it never triggers layout, and it is disabled
 * under `prefers-reduced-motion: reduce`.
 */
export function InteractiveCard({
  className,
  ...props
}: InteractiveCardProps) {
  return (
    <Card
      className={cn(
        "lift cursor-pointer shadow-sm hover:border-primary/50 hover:shadow-lift",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-1 p-4 pb-3", className)} {...props} />;
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn("text-sm font-semibold", className)} {...props} />;
}

export function CardDescription({
  className,
  ...props
}: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p className={cn("text-xs text-muted-foreground", className)} {...props} />
  );
}

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-4 pt-0", className)} {...props} />;
}

export function CardFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("flex items-center gap-2 p-4 pt-0", className)} {...props} />
  );
}

export interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}

/** Centred placeholder used for "no data" / "no matches" states. */
export function EmptyState({
  title,
  description,
  icon,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border px-6 py-14 text-center",
        className,
      )}
    >
      {icon ? <div className="text-3xl opacity-70">{icon}</div> : null}
      <div className="space-y-1">
        <p className="text-sm font-medium">{title}</p>
        {description ? (
          <p className="max-w-md text-xs text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}
