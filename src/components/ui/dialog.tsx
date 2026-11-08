import { useLayoutEffect, useMemo, useRef } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";
import { Button } from "./button";
import { GeometryIcon } from "./geometry-icon";
import { mountDialogFocus } from "./dialog-focus";

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  /** Rendered at the bottom right; typically action buttons. */
  footer?: ReactNode;
  className?: string;
  children?: ReactNode;
}

/**
 * Minimal modal: dark scrim + centred panel.
 *
 * `Escape` and scrim clicks close it. Body scroll is left alone because the
 * shell already owns its own scroll containers.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  footer,
  className,
  children,
}: DialogProps) {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  // Snapshot before the commit removes a menu or lets an input autoFocus.
  const returnFocus = useMemo(() => open ? document.activeElement : null, [open]);
  useLayoutEffect(() => {
    if (!open || !panel.current) return;
    return mountDialogFocus(panel.current, () => close.current(), returnFocus);
  }, [open, returnFocus]);

  if (!open) return null;

  // Filters/transforms on glass cards establish a containing block for fixed
  // descendants. Portal outside scrolling cards so the modal uses the viewport.
  return createPortal(
    <div
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className={cn(
        "fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4",
        "animate-fade-in",
        // Scrim under the glass theme: the rule in index.css picks this up and
        // swaps in the translucent, blurred variant.
        "[.glass_&]:bg-black/40",
      )}
    >
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-label={typeof title === "string" ? title : undefined}
        aria-modal="true"
        className={cn(
          "flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-lg",
          "border border-border bg-card text-card-foreground shadow-xl",
          // Entrance: fade + 3% scale-up over 160 ms. Long enough to feel
          // deliberate, short enough that a repeat open never drags.
          "animate-dialog-in",
          // On glass the panel needs a *heavier* frost than a page card: it
          // has to separate from whatever content it covers.
          "[.glass_&]:border-[hsl(var(--glass-border))] [.glass_&]:bg-[hsl(var(--glass-strong))]",
          "[.glass_&]:backdrop-blur-2xl [.glass_&]:backdrop-saturate-150",
          "[.glass_&]:shadow-glass-lg",
          "[.glass_&]:[box-shadow:inset_0_1px_0_0_hsl(var(--glass-highlight)),0_24px_60px_-20px_var(--glass-shadow)]",
          className,
        )}
      >
        {title ? (
          <div className="relative flex flex-col gap-1 border-b border-border py-3 pl-4 pr-14">
            <h2 className="text-sm font-semibold">{title}</h2>
            {description ? (
              <div className="text-xs text-muted-foreground">{description}</div>
            ) : null}
            <Button type="button" variant="ghost" size="icon" onClick={onClose}
              aria-label="关闭对话框" title="关闭" className="absolute right-3 top-2.5 size-7 rounded-full text-muted-foreground hover:text-foreground">
              <GeometryIcon name="close" className="size-4" />
            </Button>
          </div>
        ) : null}

        <div className="flex-1 overflow-y-auto p-4">{children}</div>

        {footer ? (
          <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
            {footer}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: ReactNode;
  confirmText?: string;
  cancelText?: string;
  /** Styles the confirm button as destructive. */
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Small wrapper around {@link Dialog} for yes/no questions. */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmText = "确定",
  cancelText = "取消",
  destructive,
  busy,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      description={description}
      className="max-w-sm"
      footer={
        <>
          <Button
            type="button"
            onClick={onCancel}
            variant="outline"
          >
            {cancelText}
          </Button>
          <Button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            variant={destructive ? "destructive" : "default"}
            loading={busy}
          >
            {confirmText}
          </Button>
        </>
      }
    />
  );
}

export default Dialog;
