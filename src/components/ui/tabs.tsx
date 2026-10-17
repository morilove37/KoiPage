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
  label?: string;
}

/** Segmented control; the active tab drives whichever panel the caller renders. */
export function Tabs({ value, onValueChange, items, className, label = "内容分区" }: TabsProps) {
  const activeIndex = Math.max(0, items.findIndex(item => item.value === value));
  return (
    <div
      role="tablist"
      aria-label={label}
      aria-orientation="horizontal"
      onKeyDown={event => {
        let index: number;
        if (event.key === "ArrowRight") index = (activeIndex + 1) % items.length;
        else if (event.key === "ArrowLeft") index = (activeIndex - 1 + items.length) % items.length;
        else if (event.key === "Home") index = 0;
        else if (event.key === "End") index = items.length - 1;
        else return;
        if (!items[index]) return;
        event.preventDefault();
        onValueChange(items[index].value);
        event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[index]?.focus({ preventScroll: true });
      }}
      className={cn(
        "rounded-xl border border-border bg-background/95 p-1 shadow-sm backdrop-blur-md",
        "[.glass_&]:bg-[hsl(var(--glass-strong))]",
        className,
      )}
    >
      <div className="relative grid" style={{ gridTemplateColumns: `repeat(${Math.max(1, items.length)}, minmax(0, 1fr))` }}>
      {items.length > 0 ? <span aria-hidden="true" data-tab-slider
        className="sidebar-slider pointer-events-none absolute inset-y-0 left-0"
        style={{ width: `${100 / items.length}%`, transform: `translateX(${activeIndex * 100}%)` }} /> : null}
      {items.map((item) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onValueChange(item.value)}
            className={cn(
              "relative z-10 flex h-9 min-w-0 items-center justify-center rounded-lg px-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-sm",
              active
                ? "text-primary-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {item.label}
          </button>
        );
      })}
      </div>
    </div>
  );
}

export default Tabs;
