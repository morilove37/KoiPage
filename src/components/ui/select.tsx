import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { KeyboardEvent, ReactNode, Ref } from "react";

import { createPortal } from "react-dom";

import { GLASS_CLASS } from "@/lib/theme";
import { cn } from "@/lib/utils";

/**
 * Themed dropdown (a real listbox, not a native `<select>`).
 *
 * WHY NOT A NATIVE CONTROL
 * A native `<select>` popup is drawn by the OS/WebView chrome, not by the page:
 * no CSS reaches the list, so it can never be frosted. Under the 液态玻璃 theme
 * the page is dark and translucent while that panel stays an opaque light slab
 * — it reads as a blank white box punched through the UI. This component draws
 * the panel itself, so every dropdown is the same frosted glass surface as the
 * cards it sits on.
 *
 * WHAT IT KEEPS FROM THE NATIVE CONTROL
 *   - the same value/onValueChange/options contract, so callers are unchanged;
 *   - keyboard use: ↑/↓, Home/End, Enter, Space, Esc, Tab, type-ahead;
 *   - listbox semantics: `role="listbox"` / `role="option"` + `aria-selected`.
 *
 * The panel is `position: fixed` (not portalled): the tree it renders in has no
 * `transform`/`filter` ancestor, so `fixed` is already viewport-relative, and
 * the anchor position is measured from the trigger's client rect.
 */

export interface SelectOption<T extends string = string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
}

export interface SelectProps<T extends string = string> {
  value: T;
  onValueChange: (value: T) => void;
  options: ReadonlyArray<SelectOption<T>>;
  /** Leading option for "no filter"; omit to force a concrete choice. */
  placeholder?: string;
  id?: string;
  disabled?: boolean;
  className?: string;
  /** `sm` matches the compact fields used inside dialogs and list rows. */
  size?: "md" | "sm";
  "aria-label"?: string;
  /** Forwarded to the trigger, which is the focusable element. */
  ref?: Ref<HTMLButtonElement>;
}

/**
 * Space the panel keeps from the scroll container's edge when deciding whether
 * to open downward or upward.
 */
const EDGE_MARGIN = 8;

/**
 * Vertical gap between the trigger and the panel.
 *
 * Slightly more than a hairline: the panel is absolutely positioned inside its
 * control, so a neighbouring element that comes later in the DOM (the tag row
 * under the library filter bar, for example) can show through a panel that
 * opens flush against the trigger. The offset also matches the small caret
 * distance a native popup uses.
 */
const PANEL_OFFSET = 10;

/** Label text for the trigger and for the type-ahead match. */
function labelText(label: ReactNode): string {
  return typeof label === "string" || typeof label === "number"
    ? String(label)
    : "";
}

/**
 * The nearest scrolling ancestor, or `null` when the panel would be clipped by
 * the viewport instead.
 *
 * The panel is `position: fixed` in a portal, but its available space is still
 * bounded by whichever ancestor scrolls — that box decides whether the panel
 * opens downward or flips upward.
 */
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
 * Whether the 液态玻璃 theme is active right now.
 *
 * Read from `<html>` rather than from any store: `lib/theme` owns the choice and
 * expresses it as the `glass` class, so the DOM is the single source of truth.
 * A `MutationObserver` keeps it live for the app's own theme buttons, and
 * `prefers-color-scheme` matters because the `system` theme can flip to glass's
 * dimmed variant without any code running.
 *
 * The portal is what makes this necessary: the portalled panel leaves the shell,
 * so the `[.glass_&]:` ancestor variants no longer match on their own.
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

export function Select<T extends string = string>({
  value,
  onValueChange,
  options,
  placeholder,
  id,
  disabled,
  className,
  size = "md",
  ref,
  ...aria
}: SelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  /** Panel opens downward by default and flips up when space below runs out. */
  const [flipUp, setFlipUp] = useState(false);
  const [maxHeight, setMaxHeight] = useState<number | undefined>(undefined);
  /** Trigger box in viewport coordinates, for the portalled panel. */
  const [anchor, setAnchor] = useState<{
    left: number;
    width: number;
    top: number;
    bottom: number;
  } | null>(null);
  /**
   * Portal target for the panel, set after mount.
   *
   * The panel is portalled to `<body>` so it can paint above sibling rows that
   * come later in the DOM — under 液态玻璃 the filter card carries a
   * `backdrop-filter`, which makes it a stacking context, so a panel nested
   * inside it could never rise above the tag row below it. Portalling puts the
   * panel back in the root stacking context, where its `z-index` means what it
   * says. React event bubbling still works through a portal.
   */
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setPortalTarget(document.body);
  }, []);

  /**
   * The panel must match the *active* theme, and portalling it out of the shell
   * strips the `[.glass_&]:` ancestor hook it relied on.
   *
   * So the wrapper below re-declares `glass` only while the glass theme is
   * actually selected: light / dark / system keep the plain `bg-card` surface
   * they had, and only glass gets the frosted translucent one. Hardcoding
   * `glass` here made every theme render the glass dropdown, which is exactly
   * the "other themes should not look like 液态玻璃" bug.
   */
  const glass = useGlassTheme();
  const frosted = glass && open;

  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const typeahead = useRef({ query: "", at: 0 });

  const listId = useId();
  const optionId = (index: number) => `${listId}-option-${index}`;

  /**
   * The leading "no filter" entry is spliced in as an option rather than kept
   * as a third state, so either shape behaves identically from here on.
   *
   * Memoised on a *content* fingerprint, never on `options` itself: callers
   * build their list inline in JSX, so a fresh array arrives on every render
   * and a dependency on it would invalidate every callback below — which is
   * exactly how this file first tripped React's "Maximum update depth
   * exceeded". The fingerprint keeps the work honest: it changes when the
   * options do (including a label swap or a new filter value at equal length).
   */
  const optionFingerprint = options
    .map((option) => `${option.value}\u0000${labelText(option.label)}\u0000${option.disabled ? 1 : 0}`)
    .join("\u0001");

  const allOptions: SelectOption<T>[] = useMemo(
    () =>
      placeholder !== undefined
        ? [{ value: "" as T, label: placeholder }, ...options]
        : [...options],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by content
    [placeholder, optionFingerprint],
  );

  const allOptionsRef = useRef(allOptions);
  allOptionsRef.current = allOptions;

  const selectedIndex = allOptions.findIndex((option) => option.value === value);
  /** First selectable row: with a placeholder that is always the clearing entry. */
  const firstEnabledIndex = allOptions.findIndex((option) => !option.disabled);

  /** Move to the next enabled row, wrapping in the given direction. */
  const stepIndex = useCallback(
    (from: number, direction: 1 | -1): number => {
      const count = allOptions.length;
      if (count === 0) return -1;
      let index = from;
      for (let hop = 0; hop < count; hop += 1) {
        index = (index + direction + count) % count;
        if (!allOptions[index]?.disabled) return index;
      }
      return from;
    },
    [allOptions],
  );

  /**
   * Re-anchor the portalled panel to the trigger and decide whether it hangs
   * below the trigger or flips above it.
   *
   * The panel is `position: fixed` at the trigger's viewport box, so it is
   * unaffected by any ancestor's stacking context or `overflow` — that is the
   * whole reason it lives in a portal. The flip is measured against the nearest
   * scrolling ancestor (or the viewport when there is none).
   */
  const measureSpace = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    setAnchor({
      left: rect.left,
      width: rect.width,
      top: rect.top,
      bottom: rect.bottom,
    });

    const scroller = scrollParent(trigger);
    const bounds = scroller
      ? scroller.getBoundingClientRect()
      : { top: 0, bottom: window.innerHeight };

    const below = bounds.bottom - rect.bottom - EDGE_MARGIN;
    const above = rect.top - bounds.top - EDGE_MARGIN;
    // Rough panel height: one row per option plus padding. Only used to choose
    // the flip, so an estimate is fine.
    const estimated = allOptionsRef.current.length * 32 + 12;

    const shouldFlip = below < Math.min(estimated, 220) && above > below;
    setFlipUp(shouldFlip);
    setMaxHeight(Math.max(120, shouldFlip ? above : below));
  }, []);

  const openMenu = useCallback(
    (index: number) => {
      if (disabled || allOptionsRef.current.length === 0) return;
      typeahead.current = { query: "", at: 0 };
      setActiveIndex(index);
      setOpen(true);
    },
    [disabled],
  );

  const closeMenu = useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
  }, []);

  /** Commit a row; a no-op selection still closes the panel. */
  const commit = useCallback(
    (index: number) => {
      const option = allOptionsRef.current[index];
      if (!option || option.disabled) return;
      if (option.value !== value) onValueChange(option.value);
      closeMenu(true);
    },
    [closeMenu, onValueChange, value],
  );

  /**
   * Anchor the portalled panel when it opens, then keep it glued to the trigger
   * while the page scrolls or the window resizes.
   *
   * The dependency list is `[open]` on purpose: `measureSpace` reads live
   * geometry through a ref, so a caller re-rendering with a new inline
   * `options` array cannot re-trigger this effect. Re-running it on every
   * render while state was being set is what once produced an infinite update
   * loop ("Maximum update depth exceeded").
   */
  const measureSpaceRef = useRef(measureSpace);
  measureSpaceRef.current = measureSpace;

  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => measureSpaceRef.current();
    measure();
    window.addEventListener("resize", measure);
    // Capture phase: the page scrolls inside `main`, which does not bubble a
    // scroll event to the window.
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open]);

  // Keyboard navigation must be visible: keep the active row in view.
  useEffect(() => {
    if (!open) return;
    optionRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const count = allOptions.length;
    if (count === 0) return;

    const key = event.key;

    if (!open) {
      if (key === "ArrowDown" || key === "ArrowUp" || key === "Enter" || key === " ") {
        event.preventDefault();
        openMenu(selectedIndex >= 0 ? selectedIndex : firstEnabledIndex);
      }
      return;
    }

    switch (key) {
      case "ArrowDown":
        event.preventDefault();
        setActiveIndex((current) => stepIndex(current, 1));
        return;
      case "ArrowUp":
        event.preventDefault();
        setActiveIndex((current) => stepIndex(current, -1));
        return;
      case "Home":
        event.preventDefault();
        setActiveIndex(firstEnabledIndex);
        return;
      case "End":
        event.preventDefault();
        setActiveIndex(stepIndex(0, -1));
        return;
      case "Enter":
      case " ":
        event.preventDefault();
        commit(activeIndex);
        return;
      case "Escape":
        event.preventDefault();
        closeMenu();
        return;
      case "Tab":
        // Let focus move on, but never leave a stray panel behind.
        closeMenu();
        return;
      default:
        break;
    }

    // Type-ahead: printable characters accumulate for 600 ms, matching the
    // platform behaviour a native control would have given us.
    if (key.length === 1 && /\S/.test(key)) {
      const now = Date.now();
      const state = typeahead.current;
      const query = now - state.at > 600 ? key.toLowerCase() : state.query + key.toLowerCase();
      typeahead.current = { query, at: now };
      const match = allOptions.findIndex(
        (option) => !option.disabled && labelText(option.label).toLowerCase().startsWith(query),
      );
      if (match >= 0) setActiveIndex(match);
    }
  };

  const selected = selectedIndex >= 0 ? allOptions[selectedIndex] : undefined;
  const activeDescendant =
    open && activeIndex >= 0 ? optionId(activeIndex) : undefined;

  // Close when the user clicks (or taps) anywhere outside the control. This is
  // a *document*-level listener rather than an `onBlur`, deliberately:
  // `backdrop-filter`, the animated blobs and the WebView2 host can all move
  // focus out of the trigger the instant it is clicked, and a blur handler
  // turns that into a menu that flashes closed as it opens. A pointer that
  // lands outside the root and outside the panel is an unambiguous dismissal.
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

  return (
    <div
      ref={rootRef}
      className={cn("relative", className)}
      // Debug hook: lets a CDP probe read the open/closed state off the DOM
      // during the real-input verification in `_verify/check-select.mjs`.
      data-select-open={open ? "true" : "false"}
      // Keyboard-only dismissal path: `relatedTarget` is a real node when Tab
      // moves focus to another element. Pointer focus loss (`relatedTarget`
      // null) is handled by the document listener above, so a bare blur here
      // never closes the panel by accident.
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null;
        if (!next) return;
        if (!event.currentTarget.contains(next)) closeMenu();
      }}
    >
      <button
        ref={(node) => {
          triggerRef.current = node;
          if (typeof ref === "function") ref(node);
          else if (ref) (ref as React.MutableRefObject<HTMLButtonElement | null>).current = node;
        }}
        id={id}
        type="button"
        disabled={disabled}
        aria-label={aria["aria-label"]}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={activeDescendant}
        onClick={() => {
          if (open) {
            closeMenu();
            return;
          }
          const base = selectedIndex >= 0 ? selectedIndex : firstEnabledIndex;
          openMenu(base);
        }}
        onKeyDown={onTriggerKeyDown}
        className={cn(
          "flex w-full cursor-pointer items-center gap-2 rounded-md border border-border bg-background text-left",
          "text-foreground outline-none",
          "transition-[border-color,box-shadow,background-color] duration-160 ease-smooth",
          "focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30",
          // Frosted like the other fields on the 液态玻璃 theme.
          "[.glass_&]:bg-[hsl(var(--glass-soft))] [.glass_&]:backdrop-blur-sm",
          "disabled:cursor-not-allowed disabled:opacity-50",
          // `sm` mirrors the compact native fields it replaces in dialogs.
          size === "sm" ? "h-8 px-2 text-xs" : "h-9 px-3 text-sm",
        )}
      >
        <span className={cn("min-w-0 flex-1 truncate", !selected && "text-muted-foreground")}>
          {selected ? selected.label : (placeholder ?? "")}
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
            /*
             * The panel follows the active theme:
             *
             *   浅色 / 深色 / 跟随系统 → the same opaque `bg-card` surface and
             *     `border-border` hairline the library cards and dialogs use;
             *   液态玻璃 → the translucent, backdrop-blurred pane.
             *
             * The wrapper hands the `[.glass_&]:` variants their ancestor hook,
             * but only while glass is actually selected — forcing it on made
             * every theme render the glass dropdown.
             */
            <div className={cn("contents", frosted && "glass")}>
              <div
                ref={menuRef}
                id={listId}
                role="listbox"
                aria-label={aria["aria-label"]}
                tabIndex={-1}
                style={{
                  // Fixed against the trigger's viewport box, clamped so the
                  // panel never crosses the window edge. The panel matches the
                  // trigger's width so the two read as one control, and the
                  // clamp above can be computed from that same width.
                  left: Math.max(
                    EDGE_MARGIN,
                    Math.min(anchor.left, window.innerWidth - anchor.width - EDGE_MARGIN),
                  ),
                  width: anchor.width,
                  top: flipUp ? undefined : anchor.bottom + PANEL_OFFSET,
                  bottom: flipUp
                    ? window.innerHeight - anchor.top + PANEL_OFFSET
                    : undefined,
                  maxHeight,
                }}
                className={cn(
                  "fixed z-[60] overflow-y-auto overscroll-contain border border-border p-1",
                  "text-card-foreground",
                  // Mirrors the control it belongs to: frosted with roomier
                  // corners on glass, the plain card surface everywhere else.
                  frosted ? "rounded-xl" : "rounded-md",
                  frosted
                    ? "bg-[hsl(var(--glass-strong))] backdrop-blur-2xl backdrop-saturate-150"
                    : "bg-card shadow-xl",
                  frosted &&
                    "[.glass_&]:border-[hsl(var(--glass-border))] [.glass_&]:[box-shadow:inset_0_1px_0_0_hsl(var(--glass-highlight)),0_18px_44px_-16px_var(--glass-shadow)]",
                  "animate-fade-in",
                )}
              >
                {allOptions.map((option, index) => {
                  const isSelected = option.value === value;
                  const isActive = index === activeIndex;
                  return (
                    <button
                      key={option.value === "" ? "__placeholder__" : option.value}
                      ref={(node) => {
                        optionRefs.current[index] = node;
                      }}
                      id={optionId(index)}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      disabled={option.disabled}
                      tabIndex={-1}
                      // Keep focus on the trigger so keyboard handling stays in
                      // one place and focus never lands on a row about to unmount.
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => commit(index)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors duration-120",
                        "text-foreground",
                        isActive && "bg-accent text-accent-foreground",
                        isSelected && "font-medium",
                        option.disabled && "cursor-not-allowed opacity-50",
                      )}
                    >
                      <span className="w-3.5 shrink-0 text-xs text-primary">
                        {isSelected ? "✓" : ""}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{option.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>,
            portalTarget,
          )
        : null}
    </div>
  );
}

export interface LabeledSelectProps<T extends string = string>
  extends Omit<SelectProps<T>, "id"> {
  label: string;
  hint?: ReactNode;
}

/** {@link Select} with a caption above it, for filter bars. */
export function LabeledSelect<T extends string = string>({
  label,
  hint,
  className,
  ...selectProps
}: LabeledSelectProps<T>) {
  const id = useId();
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <Select id={id} {...selectProps} />
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

export default Select;
