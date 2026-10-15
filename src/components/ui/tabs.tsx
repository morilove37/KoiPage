import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface TabItem {
  value: string;
  label: ReactNode;
}

export interface TabsProps {
  value: string;
  onValueChange: (value: string) => void;
  items: ReadonlyArray<TabItem>;
  className?: string;
}

/** Segmented control; the active tab drives whichever panel the caller renders. */
export function Tabs({ value, onValueChange, items, className }: TabsProps) {
  return (
    <div
      role="tablist"
      className={cn(
        "inline-flex items-center gap-1 rounded-md bg-muted p-1",
        // Glass: the strip behind a segmented control has to stay translucent,
        // otherwise it appears as an opaque rectangle floating in the pane.
        "[.glass_&]:bg-white/5 [.glass_&]:backdrop-blur-md",
        className,
      )}
    >
      {items.map((item) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onValueChange(item.value)}
            className={cn(
              "rounded px-3 py-1 text-xs font-medium tap",
              active
                ? "bg-background text-foreground shadow-sm [.glass_&]:bg-white/15"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

export default Tabs;
