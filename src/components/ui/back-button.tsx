import { forwardRef } from "react";
import { Button } from "./button";
import type { ButtonProps } from "./button";
import { GeometryIcon } from "./geometry-icon";
import { cn } from "@/lib/utils";

/** Shared navigation treatment; callers retain control over where Back goes. */
export const BackButton = forwardRef<HTMLButtonElement, ButtonProps>(
  function BackButton({ children = "返回", className, ...props }, ref) {
    return (
      <Button ref={ref} type="button" variant="outline" size="sm" {...props}
        className={cn("group/back h-9 gap-2 pl-2 pr-3", className)}>
        <span className="flex size-6 items-center justify-center rounded-lg bg-foreground/5 transition-colors group-hover/back:bg-primary/10">
          <GeometryIcon name="arrow-left" className="size-3.5" />
        </span>
        {children}
      </Button>
    );
  },
);
