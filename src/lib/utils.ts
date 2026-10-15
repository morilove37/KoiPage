import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge Tailwind class names, resolving conflicts (last one wins).
 *
 * `clsx` handles conditional/array/object inputs; `twMerge` makes sure a
 * caller-supplied override such as `className="p-0"` actually wins over a
 * component's default `p-4`.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
