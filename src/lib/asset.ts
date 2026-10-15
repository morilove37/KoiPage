/**
 * Local-file → WebView URL helpers.
 *
 * `games.cover_path` stores an **absolute filesystem path**
 * (e.g. `E:\Games\Foo\cover.jpg`). A WebView cannot load that directly: a bare
 * `<img src="E:\Games\...">` is treated as an unknown scheme and silently
 * renders as a broken image. Tauri exposes local files through a custom asset
 * protocol instead, and {@link convertFileSrc} builds the matching URL.
 *
 * Runtime requirements, both owned by the app config, not by this module:
 *   1. `tauri` crate built with the `protocol-asset` feature (Cargo.toml);
 *   2. `app.security.assetProtocol` enabled with a matching `scope` in
 *      `src-tauri/tauri.conf.json`.
 *
 * NOTE: the asset scope lives in `tauri.conf.json`, **not** in
 * `src-tauri/capabilities/*.json`. There is no `asset:*` / `asset:default`
 * ACL permission in Tauri 2 — `gen/schemas/acl-manifests.json` contains no
 * asset entry at all. Adding one to a capability file makes the ACL reject the
 * build with an "unknown permission" error, so do not try.
 *
 * Missing either one makes the request fail at runtime while `tsc` stays green,
 * so the UI degrades to a placeholder rather than a broken-image icon; see the
 * `onError` handling in the cover components.
 */

import { convertFileSrc } from "@tauri-apps/api/core";

/** Schemes that a WebView can already load without any Tauri help. */
const PASS_THROUGH_SCHEME = /^(https?:|data:|blob:|asset:|tauri:)/i;

/**
 * Turn a stored cover path into something usable as an `<img src>`.
 *
 * Returns `undefined` for a missing path so callers can branch on it.
 * Already-loadable URLs (http/https/data/blob, or an already-converted `asset:`
 * URL) are returned untouched, which keeps remote covers and previously
 * converted values working.
 */
export function coverSrc(path: string | null | undefined): string | undefined {
  if (!path) return undefined;
  const trimmed = path.trim();
  if (trimmed === "") return undefined;
  if (PASS_THROUGH_SCHEME.test(trimmed)) return trimmed;

  // Windows-style backslashes are fine here: convertFileSrc percent-encodes the
  // path for us, and the asset protocol resolves it against the OS filesystem.
  try {
    return convertFileSrc(trimmed);
  } catch {
    // Called outside a Tauri context (e.g. a plain `vite` browser preview).
    // Returning the raw path at least keeps the alt text meaningful.
    return trimmed;
  }
}
