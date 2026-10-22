/** Pane controls deliberately do not depend on an optional wallpaper image. */
export const GLASS_OPACITY_KEY = 'glass_pane_opacity';
export const GLASS_BLUR_KEY = 'glass_pane_blur';
export interface GlassAppearance { opacity: number; blur: number }
export const DEFAULT_GLASS_APPEARANCE: Readonly<GlassAppearance> = { opacity: 72, blur: 24 };

export function parseGlassAppearance(opacity: string | null, blur: string | null): GlassAppearance {
  const bounded = (value: string | null, min: number, max: number, fallback: number) => {
    if (!value?.trim()) return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
  };
  return {
    opacity: bounded(opacity, 40, 100, DEFAULT_GLASS_APPEARANCE.opacity),
    blur: bounded(blur, 0, 60, DEFAULT_GLASS_APPEARANCE.blur),
  };
}

export function applyGlassAppearance(settings: GlassAppearance, root = typeof document === 'undefined' ? undefined : document.documentElement): void {
  if (!root) return;
  const safe = parseGlassAppearance(String(settings.opacity), String(settings.blur));
  root.style.setProperty('--lg-pane-alpha', String(safe.opacity / 100));
  root.style.setProperty('--lg-pane-blur', `${safe.blur}px`);
}
