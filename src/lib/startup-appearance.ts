/**
 * Whether the pre-paint appearance bootstrap in `src/main.tsx` succeeded.
 *
 * The shell keeps a cheap idempotent top-up that re-grants asset access for the
 * stored glass wallpaper. That is only worth an IPC call when the bootstrap
 * could not do it, so `main.tsx` records the outcome here and the shell reads
 * it once on mount.
 */

let applied = false;

/** Called by `main.tsx` once the snapshot-based appearance pass has run. */
export function markAppearanceApplied(): void {
  applied = true;
}

/** True when `main.tsx` already applied the theme, accent, glass and backdrop. */
export function appearanceApplied(): boolean {
  return applied;
}
