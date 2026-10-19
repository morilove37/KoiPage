/**
 * Theme handling: `light` / `dark` / `system` / `glass`.
 *
 * The rendered theme is applied by toggling classes on `<html>`, which is what
 * Tailwind's `darkMode: "class"` strategy looks at (see `tailwind.config.js`):
 *
 *   `light`  → `<html>`
 *   `dark`   → `<html class="dark">`
 *   `glass`  → `<html class="glass">` (plus `dark` when the OS is dark, i.e.
 *              the "midnight glass" variant declared in `src/index.css`)
 *   `system` → decided live from `prefers-color-scheme`
 *
 * The *user's choice* — which may be `system` — is persisted to the `settings`
 * table under the `theme` key so it survives a restart.
 *
 * Backwards compatibility: the stored values `light` / `dark` / `system` keep
 * their exact previous meaning and rendering. `glass` is purely additive — an
 * older build reading a stored `glass` would fall back to {@link DEFAULT_THEME}
 * through {@link isTheme}, and nothing here ever writes a value the old code
 * could not read.
 */

import { settingsGet, settingsSet } from './db';
import { applyAccent, initAccent } from './accent';

/** Settings key holding the persisted choice. */
export const THEME_SETTING_KEY = 'theme';

/** The two legacy explicit schemes. */
export const BASE_THEMES = ['light', 'dark'] as const;

export type BaseTheme = (typeof BASE_THEMES)[number];

/**
 * Class applied to `<html>` per rendered scheme. `resolved` is the
 * light/dark decision; the `dark` class is always toggled for dark so every
 * existing `dark:` utility keeps working under the glass theme too.
 */
const RESOLVED_CLASSES: Record<'light' | 'dark', readonly string[]> = {
  light: [],
  dark: ['dark'],
};

/** Class that switches on the 液态玻璃 token set. */
export const GLASS_CLASS = 'glass';

export const THEMES = ['light', 'dark', 'system', 'glass'] as const;

export type Theme = (typeof THEMES)[number];

/** Human-readable labels, mirroring `GAME_STATUS_LABELS` in `@/types/game`. */
export const THEME_LABELS: Record<Theme, string> = {
  light: '浅色',
  dark: '深色',
  system: '跟随系统',
  glass: '液态玻璃',
};

/** Short blurbs shown under the theme buttons in 设置 → 外观. */
export const THEME_DESCRIPTIONS: Record<Theme, string> = {
  light: '干净的浅色界面。',
  dark: '低亮度深色界面，适合夜间。',
  system: '随操作系统的深浅色设置实时切换。',
  glass: '半透明磨砂玻璃与流动光斑背景，圆角更大。',
};

/** Default when nothing is stored or the stored value is unrecognised. */
export const DEFAULT_THEME: Theme = 'system';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** Narrow an arbitrary string to a {@link Theme}. */
export function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value);
}

/** True when a choice renders glass (as opposed to a flat light/dark UI). */
export function isGlassTheme(theme: Theme): boolean {
  return theme === 'glass';
}

/** The active media query list, or `null` where `matchMedia` is unavailable. */
function darkMediaQuery(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return null;
  }
  return window.matchMedia(DARK_QUERY);
}

/** True when the OS currently prefers a dark colour scheme. */
export function systemPrefersDark(): boolean {
  return darkMediaQuery()?.matches ?? false;
}

/**
 * Resolve the effective light/dark value for a choice.
 *
 * `system` consults `prefers-color-scheme`. `glass` resolves the same way —
 * it is always glass, but whether it renders as bright glass or the dimmed
 * "midnight glass" variant follows the OS — so native widgets and `dark:`
 * utilities stay consistent in both cases.
 */
export function resolveTheme(theme: Theme): 'light' | 'dark' {
  if (theme === 'system' || theme === 'glass') {
    return systemPrefersDark() ? 'dark' : 'light';
  }
  return theme;
}

/**
 * Apply a theme choice to `<html>`.
 *
 * Both the choice and its resolved light/dark value are needed, because glass
 * is an *axis of its own*: it can render bright or dim.
 */
function apply(theme: Theme, resolved: 'light' | 'dark'): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;

  for (const name of RESOLVED_CLASSES[resolved]) root.classList.add(name);
  if (resolved === 'light') root.classList.remove('dark');

  // `glass` is deliberately absent from RESOLVED_CLASSES: it must be added by
  // the choice, not by the light/dark decision.
  root.classList.toggle(GLASS_CLASS, isGlassTheme(theme));

  // Lets native widgets (scrollbars, form controls) follow the theme too.
  root.style.colorScheme = resolved;
  applyAccent();
}

/**
 * Apply a theme immediately, without touching storage.
 *
 * Use this for the initial paint and for instant feedback while a
 * {@link setTheme} write is still in flight.
 */
export function applyTheme(theme: Theme): void {
  apply(theme, resolveTheme(theme));
}

/**
 * Watch `prefers-color-scheme` while `system` (or `glass`) is active.
 *
 * Returns a disposer. Calling it, or calling this function again with a new
 * theme, removes the previous listener so at most one is ever registered.
 */
let disposeSystemListener: (() => void) | null = null;

export function watchSystemTheme(theme: Theme): () => void {
  // Drop any previous subscription before deciding whether to add another.
  if (disposeSystemListener) {
    disposeSystemListener();
    disposeSystemListener = null;
  }
  // Both `system` and `glass` follow the OS light/dark setting — glass only
  // changes *how* it is rendered, never *whether* it tracks the OS.
  if (theme !== 'system' && theme !== 'glass') {
    return () => {};
  }

  const query = darkMediaQuery();
  // `addEventListener` is unavailable in very old WebViews; degrade to a
  // one-shot application rather than throwing.
  if (!query || typeof query.addEventListener !== 'function') {
    return () => {};
  }

  const onChange = () => apply(theme, query.matches ? 'dark' : 'light');
  query.addEventListener('change', onChange);

  disposeSystemListener = () => query.removeEventListener('change', onChange);
  return disposeSystemListener;
}

/**
 * Read the persisted theme, falling back to {@link DEFAULT_THEME}.
 *
 * A database failure is swallowed: a missing theme must never stop the app
 * from rendering, and the fallback (`system`) is always valid.
 */
export async function loadTheme(): Promise<Theme> {
  try {
    const stored = await settingsGet(THEME_SETTING_KEY);
    return isTheme(stored) ? stored : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

/**
 * Apply a theme and persist the choice.
 *
 * Throws if the write fails, so a settings UI can surface the problem — the
 * theme is still applied, since `applyTheme` runs before the write.
 */
export async function setTheme(theme: Theme): Promise<void> {
  applyTheme(theme);
  watchSystemTheme(theme);
  await settingsSet(THEME_SETTING_KEY, theme);
}

/**
 * Bootstrap: read the stored theme, apply it, and start following the OS when
 * the choice is `system` or `glass`. Returns the applied choice.
 *
 * Safe to call once at startup; it never throws.
 */
export async function initTheme(): Promise<Theme> {
  const [theme] = await Promise.all([loadTheme(), initAccent()]);
  applyTheme(theme);
  watchSystemTheme(theme);
  return theme;
}
