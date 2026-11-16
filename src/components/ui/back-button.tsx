import { forwardRef } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { LinkProps } from "react-router-dom";
import { Button, buttonClassName } from "./button";
import type { ButtonProps, ButtonSize, ButtonVariant } from "./button";
import { GeometryIcon } from "./geometry-icon";
import { cn } from "@/lib/utils";

/**
 * The arrow chip both treatments share. It sits on its own tinted square so the
 * control still reads as "go back" at a glance, before the label is parsed.
 */
const GLYPH =
  "flex size-6 shrink-0 items-center justify-center rounded-lg bg-foreground/5 transition-colors group-hover/back:bg-primary/10";

/** Shared navigation treatment; callers retain control over where Back goes. */
export const BackButton = forwardRef<HTMLButtonElement, ButtonProps>(
  function BackButton({ children = "返回", className, ...props }, ref) {
    return (
      <Button ref={ref} type="button" variant="outline" size="sm" {...props}
        className={cn("group/back h-9 gap-2 pl-2 pr-3", className)}>
        <span className={GLYPH}>
          <GeometryIcon name="arrow-left" className="size-3.5" />
        </span>
        {children}
      </Button>
    );
  },
);

export interface BackLinkProps extends Omit<LinkProps, "className" | "children"> {
  className?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  children?: ReactNode;
}

/**
 * The same back affordance, for destinations that are a route rather than a
 * history pop.
 *
 * A plain underlined text link next to real buttons reads as an afterthought —
 * easy to miss and easy to mistake for body copy. This renders the router
 * `<Link>` with the button surface, so "返回好友列表" is as obviously clickable
 * as the controls beside it.
 */
export const BackLink = forwardRef<HTMLAnchorElement, BackLinkProps>(
  function BackLink(
    { children = "返回", className, variant = "outline", size = "sm", ...props },
    ref,
  ) {
    return (
      <Link
        ref={ref}
        {...props}
        className={cn(
          buttonClassName({ variant, size }),
          "group/back h-9 gap-2 pl-2 pr-3",
          className,
        )}
      >
        <span className={GLYPH}>
          <GeometryIcon name="arrow-left" className="size-3.5" />
        </span>
        {children}
      </Link>
    );
  },
);
