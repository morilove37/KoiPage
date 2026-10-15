/**
 * Custom backdrop for the 液态玻璃 theme.
 *
 * The glass theme paints four drifting colour blobs behind the UI (see
 * `#lg-backdrop` in `index.html` and section 3 of `src/index.css`). This module
 * lets the user lay a **local image file** underneath those blobs, and control
 * how much of it shows through:
 *
 *   `background_image_path`  absolute filesystem path, `''` = no custom image
 *   `background_opacity`     image opacity, 0–100 (default 100)
 *   `background_blur`        blur of the image itself, 0–60 px (default 0)
 *   `background_fit`         `cover` | `contain` | `fill` | `tile` (default cover)
 *
 * All four live in the `settings` table, like the theme choice, so they survive
 * a restart. They are written as plain strings; the readers below clamp and
 * fall back, so a value written by a newer build (or a hand-edited database)
 * can never produce an out-of-range CSS value.
 *
 * RENDERING CONTRACT — the image is painted by CSS, not by React:
 *   `index.html` ships an empty `<div id="lg-backdrop-image">` inside the
 *   backdrop, and everything this module does is set the custom properties
 *   (`--lg-bg-image`, `--lg-bg-opacity`, `--lg-bg-blur`, `--lg-bg-fit`) on
 *   `<html>` plus `background-repeat` on the layer element itself. `src/index.css`
 *   decides whether the layer is visible at all: it is gated on `.glass`, so
 *   switching to 浅色 / 深色 hides it without clearing the setting.
 *
 * WHY A RUST CALL: a WebView cannot read `E:\...\bg.jpg` directly. Tauri serves
 * local files through the asset protocol, whose runtime scope is **empty** in
 * `tauri.conf.json` (`allow: []`) — every path is granted explicitly at runtime,
 * which is what `syncAssetScope` does for cover images. A background image is
 * not a cover, so it needs its own grant; {@link backdropAssetGrant} is that
 * call. The grant is per-process, hence {@link syncBackdrop} re-grants on every
 * launch.
 *
 * NAMING: the DOM hooks are `lg-*` (never `glass-*`), by the same rule the rest
 * of the glass styles follow — a `glass-*` class in markup is read by Tailwind
 * as an (undeclared) utility candidate, and `tailwind-merge` then strips the
 * caller's real glass classes. See section 3/4 of `src/index.css`.
 */

import { invoke } from '@tauri-apps/api/core';

import { coverSrc } from './asset';
import { settingsGet, settingsSet } from './db';

/** Settings keys owned by this module. */
export const BACKDROP_IMAGE_KEY = 'background_image_path';
export const BACKDROP_OPACITY_KEY = 'background_opacity';
export const BACKDROP_BLUR_KEY = 'background_blur';
export const BACKDROP_FIT_KEY = 'background_fit';

/** How the image is scaled into the window. `tile` repeats it at 1:1. */
export const BACKDROP_FITS = ['cover', 'contain', 'fill', 'tile'] as const;

export type BackdropFit = (typeof BACKDROP_FITS)[number];

export const BACKDROP_FIT_LABELS: Record<BackdropFit, string> = {
  cover: '覆盖',
  contain: '适应',
  fill: '拉伸',
  tile: '平铺',
};

export const BACKDROP_FIT_DESCRIPTIONS: Record<BackdropFit, string> = {
  cover: '等比放大铺满窗口，多出的部分被裁掉。',
  contain: '等比缩放到完整显示，两侧或上下留空。',
  fill: '直接拉伸到窗口大小，比例可能变形。',
  tile: '保持原尺寸并重复排列，适合花纹素材。',
};

/** Everything the renderer needs. `path === ''` means "no custom image". */
export interface BackdropSettings {
  path: string;
  /** 0–100. */
  opacity: number;
  /** 0–60 px. */
  blur: number;
  fit: BackdropFit;
}

export const DEFAULT_BACKDROP: BackdropSettings = {
  path: '',
  opacity: 100,
  blur: 0,
  fit: 'cover',
};

/** Slider bounds, exported so the UI and the clamps cannot drift apart. */
export const BACKDROP_OPACITY_RANGE = { min: 0, max: 100, step: 1 } as const;
export const BACKDROP_BLUR_RANGE = { min: 0, max: 60, step: 2 } as const;

/** Narrow an arbitrary string to a {@link BackdropFit}. */
export function isBackdropFit(value: unknown): value is BackdropFit {
  return typeof value === 'string' && (BACKDROP_FITS as readonly string[]).includes(value);
}

/** Clamp a parsed number into `[min, max]`, falling back on garbage. */
function clampNumber(raw: string | null, min: number, max: number, fallback: number): number {
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** Parse the four stored strings into a validated {@link BackdropSettings}. */
export function parseBackdrop(values: {
  path?: string | null;
  opacity?: string | null;
  blur?: string | null;
  fit?: string | null;
}): BackdropSettings {
  return {
    path: (values.path ?? '').trim(),
    opacity: clampNumber(
      values.opacity ?? null,
      BACKDROP_OPACITY_RANGE.min,
      BACKDROP_OPACITY_RANGE.max,
      DEFAULT_BACKDROP.opacity,
    ),
    blur: clampNumber(
      values.blur ?? null,
      BACKDROP_BLUR_RANGE.min,
      BACKDROP_BLUR_RANGE.max,
      DEFAULT_BACKDROP.blur,
    ),
    fit: isBackdropFit(values.fit) ? values.fit : DEFAULT_BACKDROP.fit,
  };
}

// ---------------------------------------------------------------------------
// Rust bridge
// ---------------------------------------------------------------------------

/**
 * `background_asset_grant` — allow the WebView to read one image file.
 *
 * Must be granted *before* the image is painted, or the request fails with a
 * 403 from the asset protocol and the layer stays empty. Rejects with a plain
 * string when the path is empty or is not a regular file.
 */
export function backdropAssetGrant(path: string): Promise<void> {
  return invoke<void>('background_asset_grant', { path });
}

/**
 * Ask Rust to re-grant the stored background image.
 *
 * Deliberately fire-and-forget: the fact that the file could not be granted is
 * reported by the image failing to load, and a stale path must never stop the
 * app from starting. The rejection is swallowed here so callers can `void` the
 * call without an unhandled-rejection warning.
 */
export function syncBackdrop(path: string): void {
  if (path.trim() === '') return;
  void backdropAssetGrant(path).catch((cause) => {
    console.warn('[backdrop] could not grant read access:', cause);
  });
}

// ---------------------------------------------------------------------------
// DOM application
// ---------------------------------------------------------------------------

/** CSS custom properties the stylesheet reads for the backdrop layer. */
const ROOT_VARS = {
  image: '--lg-bg-image',
  opacity: '--lg-bg-opacity',
  blur: '--lg-bg-blur',
  fit: '--lg-bg-fit',
} as const;

/**
 * `background-repeat` is written inline rather than left to the stylesheet.
 *
 * A rule like `.lg-bg-tile #lg-backdrop-image { background-repeat: repeat }`
 * looks like it should win the cascade — it is more specific than the
 * `:is(.glass, .glass.dark) #lg-backdrop-image` block that sets `no-repeat` —
 * but in WebView2 it does **not**: the class rule was verified present *and*
 * matching (`layer.matches(...)` → true) yet the computed value stayed
 * `no-repeat`, and the very same declaration with `!important` did win. Rather
 * than depend on that edge, the repeat mode is set here, where nothing can
 * out-rank it.
 *
 * It must be set on the layer itself, not on `<html>`: the declaration that
 * sets `no-repeat` targets `#lg-backdrop-image` directly, and inherited values
 * lose to any declaration on the element.
 */
const LAYER_ID = 'lg-backdrop-image';

/**
 * `background-size` for a fit mode.
 *
 * `fill` is **not** a CSS keyword — the initial version wrote it straight into
 * `background-size`, the declaration was rejected as invalid and the browser
 * fell back to `auto` (a 1:1 image, i.e. the image silently did not stretch).
 * `100% 100%` is the real thing: scale to the box, aspect ratio be damned.
 * `tile` uses `auto` so a small image repeats at its natural size.
 */
function backgroundSize(fit: BackdropFit): string {
  if (fit === 'tile') return 'auto';
  if (fit === 'fill') return '100% 100%';
  return fit;
}

/** `tile` is the only mode that repeats. */
function backgroundRepeat(fit: BackdropFit): 'repeat' | 'no-repeat' {
  return fit === 'tile' ? 'repeat' : 'no-repeat';
}

/**
 * WebView URL for a stored background path, or `undefined` when unset.
 *
 * Exposed because the settings UI needs the same URL to *probe* the image:
 * the layer is a CSS `background-image`, so a missing file (renamed, deleted,
 * on an unplugged drive) produces no `onerror` event anywhere — the only way to
 * notice is to load the same URL into an `Image` and watch for `error`.
 *
 * `coverSrc` is reused rather than reimplemented: the path handling is
 * identical to cover images (`asset://` conversion, `http/data/blob`
 * pass-through, a `try/catch` for non-Tauri previews).
 */
export function backdropSrc(path: string): string | undefined {
  return path.trim() === '' ? undefined : coverSrc(path);
}

/**
 * Reflect {@link BackdropSettings} onto the document.
 *
 * Idempotent and safe to call before React mounts (it is, from
 * {@link initBackdrop}). An empty path *removes* the inline `background-image`
 * rather than the whole element, so the layer keeps existing across
 * clear/re-set cycles.
 */
export function applyBackdrop(settings: BackdropSettings): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;

  const src = backdropSrc(settings.path);
  if (src) root.style.setProperty(ROOT_VARS.image, `url("${src}")`);
  else root.style.removeProperty(ROOT_VARS.image);

  root.style.setProperty(ROOT_VARS.opacity, String(settings.opacity / 100));
  root.style.setProperty(ROOT_VARS.blur, `${settings.blur}px`);
  root.style.setProperty(ROOT_VARS.fit, backgroundSize(settings.fit));

  // The layer is optional: a plain browser preview (or a host page without the
  // markup from `index.html`) must not throw here.
  const layer = document.getElementById(LAYER_ID);
  if (layer) layer.style.backgroundRepeat = backgroundRepeat(settings.fit);
}

/** Drop every variable this module owns, returning the plain blob backdrop. */
export function clearBackdrop(): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  for (const name of Object.values(ROOT_VARS)) root.style.removeProperty(name);
  const layer = document.getElementById(LAYER_ID);
  if (layer) layer.style.removeProperty('background-repeat');
}

// ---------------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------------

/**
 * Read the persisted backdrop. Never throws: a database failure degrades to
 * {@link DEFAULT_BACKDROP}, because a broken setting must not stop the render.
 */
export async function loadBackdrop(): Promise<BackdropSettings> {
  try {
    const [path, opacity, blur, fit] = await Promise.all([
      settingsGet(BACKDROP_IMAGE_KEY),
      settingsGet(BACKDROP_OPACITY_KEY),
      settingsGet(BACKDROP_BLUR_KEY),
      settingsGet(BACKDROP_FIT_KEY),
    ]);
    return parseBackdrop({ path, opacity, blur, fit });
  } catch (cause) {
    console.warn('[backdrop] could not read settings:', cause);
    return { ...DEFAULT_BACKDROP };
  }
}

/**
 * Persist and immediately apply a backdrop. The whole record is written so the
 * UI never has to think about which field changed; the four keys are written in
 * parallel and a failure rejects after the UI has already been updated.
 */
export async function saveBackdrop(settings: BackdropSettings): Promise<void> {
  applyBackdrop(settings);
  await Promise.all([
    settingsSet(BACKDROP_IMAGE_KEY, settings.path),
    settingsSet(BACKDROP_OPACITY_KEY, String(settings.opacity)),
    settingsSet(BACKDROP_BLUR_KEY, String(settings.blur)),
    settingsSet(BACKDROP_FIT_KEY, settings.fit),
  ]);
}

/**
 * Bootstrap: read the stored backdrop, grant read access to the image and paint
 * it. Returns the applied settings so callers (the settings page) can seed their
 * local state. Never throws.
 */
export async function initBackdrop(): Promise<BackdropSettings> {
  const settings = await loadBackdrop();
  applyBackdrop(settings);
  syncBackdrop(settings.path);
  return settings;
}
