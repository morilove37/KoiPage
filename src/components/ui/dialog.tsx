import { useEffect } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";

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
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

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
          <div className="flex flex-col gap-1 border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold">{title}</h2>
            {description ? (
              <div className="text-xs text-muted-foreground">{description}</div>
            ) : null}
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
          <button
            type="button"
            onClick={onCancel}
            className="h-9 rounded-md border border-border px-4 text-sm tap hover:bg-accent hover:text-accent-foreground"
          >
            {cancelText}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className={cn(
              "h-9 rounded-md px-4 text-sm font-medium tap disabled:opacity-50",
              destructive
                ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                : "bg-primary text-primary-foreground hover:bg-primary/90",
            )}
          >
            {confirmText}
          </button>
        </>
      }
    />
  );
}

export default Dialog;
