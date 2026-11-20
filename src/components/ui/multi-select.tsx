import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { KeyboardEvent, ReactNode } from "react";

import { createPortal } from "react-dom";

import { GLASS_CLASS } from "@/lib/theme";
import { cn } from "@/lib/utils";

/**
 * Multi-select dropdown, the sibling of {@link Select}.
 *
 * WHY A SEPARATE FILE
 * `select.tsx` is a single-choice listbox: its trigger renders one selected
 * label and picking a row commits the value and closes the panel. Squeezing a
 * `values: string[]` mode into it would mean every caller of the existing
 * component pays for a branch it never uses, and the "close on commit" rule
 * (right for single choice) is wrong here — a user ticking 4 statuses must not
 * be forced to reopen the panel between each one. So this component copies the
 * parts that make the two look identical (trigger skin, frosted panel, portal,
 * flip) and keeps the multi-select behaviour local.
 *
 * WHAT DIFFERS FROM `Select`
 *   - rows toggle instead of committing, and the panel stays open;
 *   - the leading row clears the whole selection (empty array = "all");
 *   - the trigger summarises the selection instead of showing one label.
 *
 * Deliberately NOT shared with `select.tsx` as extracted primitives: that file
 * is load-bearing for every dropdown in the app and the task that added this
 * one asked for it to stay untouched.
 */

export interface MultiSelectOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}

export interface MultiSelectProps {
  /** Caption above the trigger, matching `LabeledSelect`. */
  label: string;
  values: string[];
  onValuesChange: (values: string[]) => void;
  options: ReadonlyArray<MultiSelectOption>;
  className?: string;
  /** Leading "全部××" row; picking it clears the selection. */
  allLabel?: string;
}

const EDGE_MARGIN = 8;
const PANEL_OFFSET = 10;

function labelText(label: ReactNode): string {
  return typeof label === "string" || typeof label === "number"
    ? String(label)
    : "";
}

function scrollParent(node: HTMLElement | null): HTMLElement | null {
  let current = node?.parentElement ?? null;
  while (current) {
    const overflowY = getComputedStyle(current).overflowY;
    if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

/**
 * Whether 液态玻璃 is active.
 *
 * The panel lives in a portal, so the `[.glass_&]:` ancestor variants stop
 * matching and the wrapper has to re-declare the class — which must only happen
 * while glass is really selected, or every theme renders the frosted pane.
 */
function useGlassTheme(): boolean {
  const [glass, setGlass] = useState(
    () => typeof document !== "undefined" && document.documentElement.classList.contains(GLASS_CLASS),
  );

  useLayoutEffect(() => {
    const read = () => document.documentElement.classList.contains(GLASS_CLASS);
    setGlass(read());
    const root = document.documentElement;
    const observer = new MutationObserver(() => setGlass(read()));
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onScheme = () => setGlass(read());
    media.addEventListener("change", onScheme);
    return () => {
      observer.disconnect();
      media.removeEventListener("change", onScheme);
    };
  }, []);

  return glass;
}

export function MultiSelect({
  label,
  values,
  onValuesChange,
  options,
  className,
  allLabel,
}: MultiSelectProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [flipUp, setFlipUp] = useState(false);
  const [maxHeight, setMaxHeight] = useState<number | undefined>(undefined);
  const [anchor, setAnchor] = useState<{
    left: number;
    width: number;
    top: number;
    bottom: number;
  } | null>(null);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setPortalTarget(document.body);
  }, []);

  const glass = useGlassTheme();
  const frosted = glass && open;

  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const id = useId();
  const listId = `${id}-list`;
  const labelId = `${id}-label`;
  const optionId = (index: number) => `${listId}-option-${index}`;

  const selected = new Set(values);
  /** Rows are the "全部" entry (index 0 when `allLabel` is set) plus options. */
  const allRow = allLabel !== undefined ? 0 : -1;
  const firstOptionIndex = allLabel !== undefined ? 1 : 0;
  const rowCount = options.length + firstOptionIndex;

  /**
   * Summary in the trigger.
   *
   * One value fits its label, but the filter bar only gives this control a few
   * characters (`w-32`): joining two or more Chinese labels would be clipped by
   * `truncate` into something like "未开始、游玩…", which reads worse than the
   * count it replaces. So anything past a single value collapses to "已选 N 项".
   */
  const summary = (() => {
    if (values.length === 0) return allLabel ?? "";
    if (values.length === 1) {
      const only = options.find((option) => option.value === values[0]);
      const label = only ? labelText(only.label) : "";
      // A value with no matching option (a developer that vanished from the
      // library) still counts, so the trigger never claims "no selection".
      return label || `已选 1 项`;
    }
    return `已选 ${values.length} 项`;
  })();

  const measureSpace = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    setAnchor({ left: rect.left, width: rect.width, top: rect.top, bottom: rect.bottom });

    const scroller = scrollParent(trigger);
    const bounds = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
    const below = bounds.bottom - rect.bottom - EDGE_MARGIN;
    const above = rect.top - bounds.top - EDGE_MARGIN;
    const estimated = rowCount * 32 + 12;
    const shouldFlip = below < Math.min(estimated, 220) && above > below;
    setFlipUp(shouldFlip);
    setMaxHeight(Math.max(120, shouldFlip ? above : below));
  }, [rowCount]);

  const measureSpaceRef = useRef(measureSpace);
  measureSpaceRef.current = measureSpace;

  const closeMenu = useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
  }, []);

  const openMenu = useCallback(() => {
    // Start on the first checked row so keyboard users land where their
    // selection is, not always on "全部".
    const firstChecked = options.findIndex((option) => selected.has(option.value));
    setActiveIndex(firstChecked >= 0 ? firstChecked + firstOptionIndex : 0);
    setOpen(true);
  }, [firstOptionIndex, options, selected]);

  /** Toggle one row without closing: multi-select needs the panel to stay put. */
  const toggle = useCallback(
    (index: number) => {
      if (index === allRow) {
        onValuesChange([]);
        return;
      }
      const option = options[index - firstOptionIndex];
      if (!option || option.disabled) return;
      const next = new Set(values);
      if (next.has(option.value)) next.delete(option.value);
      else next.add(option.value);
      onValuesChange([...next]);
    },
    [allRow, firstOptionIndex, onValuesChange, options, values],
  );

  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => measureSpaceRef.current();
    measure();
    window.addEventListener("resize", measure);
    // Capture phase: the page scrolls inside `main`, which does not bubble.
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    optionRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const node = event.target as Node | null;
      if (!node) return;
      if (rootRef.current?.contains(node) || menuRef.current?.contains(node)) return;
      closeMenu();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open, closeMenu]);

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const key = event.key;
    if (!open) {
      if (key === "ArrowDown" || key === "ArrowUp" || key === "Enter" || key === " ") {
        event.preventDefault();
        openMenu();
      }
      return;
    }
    switch (key) {
      case "ArrowDown":
        event.preventDefault();
        setActiveIndex((current) => (rowCount === 0 ? 0 : (current + 1) % rowCount));
        return;
      case "ArrowUp":
        event.preventDefault();
        setActiveIndex((current) => (rowCount === 0 ? 0 : (current - 1 + rowCount) % rowCount));
        return;
      case "Home":
        event.preventDefault();
        setActiveIndex(0);
        return;
      case "End":
        event.preventDefault();
        setActiveIndex(Math.max(0, rowCount - 1));
        return;
      case "Enter":
      case " ":
        event.preventDefault();
        toggle(activeIndex);
        return;
      case "Escape":
        event.preventDefault();
        closeMenu(true);
        return;
      case "Tab":
        closeMenu();
        return;
      default:
        break;
    }
  };

  const renderRow = (
    index: number,
    rowLabel: ReactNode,
    checked: boolean,
    disabled = false,
  ) => (
    <button
      key={index}
      ref={(node) => {
        optionRefs.current[index] = node;
      }}
      id={optionId(index)}
      type="button"
      role="option"
      aria-selected={checked}
      disabled={disabled}
      tabIndex={-1}
      // Keep focus on the trigger: keyboard handling stays in one place and the
      // row being toggled cannot unmount under the pointer.
      onMouseDown={(event) => event.preventDefault()}
      onMouseEnter={() => setActiveIndex(index)}
      onClick={() => toggle(index)}
      className={cn(
        "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors duration-120",
        "text-foreground",
        index === activeIndex && "bg-accent text-accent-foreground",
        checked && "font-medium",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      <span className="w-3.5 shrink-0 text-xs text-primary">{checked ? "✓" : ""}</span>
      <span className="min-w-0 flex-1 truncate">{rowLabel}</span>
    </button>
  );

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <span id={labelId} className="text-xs font-medium text-muted-foreground">
        {label}
      </span>
      <div
        ref={rootRef}
        className="relative"
        data-multi-select-open={open ? "true" : "false"}
        onBlur={(event) => {
          const next = event.relatedTarget as Node | null;
          if (!next) return;
          if (!event.currentTarget.contains(next)) closeMenu();
        }}
      >
        <button
          ref={triggerRef}
          type="button"
          aria-labelledby={`${labelId} ${id}-value`}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open ? optionId(activeIndex) : undefined}
          onClick={() => (open ? closeMenu() : openMenu())}
          onKeyDown={onTriggerKeyDown}
          className={cn(
            "flex w-full cursor-pointer items-center gap-2 rounded-md border border-border bg-background text-left",
            "text-foreground outline-none",
            "transition-[border-color,box-shadow,background-color] duration-160 ease-smooth",
            "focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30",
            "[.glass_&]:bg-[hsl(var(--glass-soft))] [.glass_&]:backdrop-blur-sm",
            "h-9 px-3 text-sm",
          )}
        >
          <span
            id={`${id}-value`}
            className={cn("min-w-0 flex-1 truncate", values.length === 0 && "text-muted-foreground")}
          >
            {summary}
          </span>
          <svg
            aria-hidden="true"
            viewBox="0 0 20 20"
            className={cn(
              "size-3.5 shrink-0 opacity-70 transition-transform duration-160 ease-smooth",
              open && "rotate-180",
            )}
          >
            <path
              d="M5.5 8l4.5 4.5L14.5 8"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>

        {open && portalTarget && anchor
          ? createPortal(
              <div className={cn("contents", frosted && "glass")}>
                <div
                  ref={menuRef}
                  id={listId}
                  role="listbox"
                  aria-multiselectable="true"
                  aria-labelledby={labelId}
                  tabIndex={-1}
                  style={{
                    left: Math.max(
                      EDGE_MARGIN,
                      Math.min(anchor.left, window.innerWidth - anchor.width - EDGE_MARGIN),
                    ),
                    width: anchor.width,
                    top: flipUp ? undefined : anchor.bottom + PANEL_OFFSET,
                    bottom: flipUp ? window.innerHeight - anchor.top + PANEL_OFFSET : undefined,
                    maxHeight,
                  }}
                  className={cn(
                    "fixed z-[60] overflow-y-auto overscroll-contain border border-border p-1",
                    "text-card-foreground",
                    frosted ? "rounded-xl" : "rounded-md",
                    frosted
                      ? "bg-[hsl(var(--glass-strong))] backdrop-blur-2xl backdrop-saturate-150"
                      : "bg-card shadow-xl",
                    frosted &&
                      "[.glass_&]:border-[hsl(var(--glass-border))] [.glass_&]:[box-shadow:inset_0_1px_0_0_hsl(var(--glass-highlight)),0_18px_44px_-16px_var(--glass-shadow)]",
                    "animate-fade-in",
                  )}
                >
                  {allLabel !== undefined
                    ? renderRow(0, allLabel, values.length === 0)
                    : null}
                  {options.map((option, offset) =>
                    renderRow(
                      offset + firstOptionIndex,
                      option.label,
                      selected.has(option.value),
                      option.disabled,
                    ),
                  )}
                  {rowCount === 0 ? (
                    <p className="px-2.5 py-1.5 text-xs text-muted-foreground">暂无可选项</p>
                  ) : null}
                </div>
              </div>,
              portalTarget,
            )
          : null}
      </div>
    </div>
  );
}

export default MultiSelect;
