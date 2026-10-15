import { forwardRef } from "react";
import type { InputHTMLAttributes, TextareaHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

/**
 * Shared field chrome so input / textarea line up pixel for pixel.
 *
 * The dropdown deliberately is **not** a field here: a native `<select>` cannot
 * be styled as a panel, so it lives in `components/ui/select.tsx` as a real
 * listbox. See that file for why.
 */
const FIELD_CLASS = cn(
  "w-full rounded-md border border-border bg-background px-3 py-2 text-sm",
  "text-foreground placeholder:text-muted-foreground",
  "outline-none",
  // Focus ring fades in rather than popping; 160 ms keeps typing responsive.
  "transition-[border-color,box-shadow,background-color] duration-160 ease-smooth",
  "focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30",
  // Glass theme: an opaque `bg-background` field would punch a hole in the
  // frosted pane it sits on, so the well becomes translucent.
  "[.glass_&]:bg-[hsl(var(--glass-soft))] [.glass_&]:backdrop-blur-sm",
  "disabled:cursor-not-allowed disabled:opacity-50",
);

export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement>
>(function Input({ className, ...props }, ref) {
  return (
    <input ref={ref} className={cn(FIELD_CLASS, "h-9 py-0", className)} {...props} />
  );
});

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn(FIELD_CLASS, "min-h-20 resize-y leading-relaxed", className)}
      {...props}
    />
  );
});

export interface FieldProps {
  label: string;
  /** Rendered under the control; use for hints as well as errors. */
  hint?: string;
  className?: string;
  children: React.ReactNode;
}

/** Label + control + hint stack used by the detail form. */
export function Field({ label, hint, className, children }: FieldProps) {
  return (
    <label className={cn("flex flex-col gap-1.5", className)}>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

export default Input;
