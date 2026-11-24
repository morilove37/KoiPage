import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { ToastProvider } from "./components/Toast";
import { initGlassAppearance } from "./features/settings/GlassAppearanceSettings";
import { seedCoverPreferences } from "./features/covers/store";
import { ensureLibraryData, seedLibraryFolders } from "./features/library/data-store";
import { initBackdrop } from "./lib/backdrop";
import { initTheme } from "./lib/theme";
import { migrateCovers, settingsGetAll } from './lib/db';
import { toSettingsSnapshot } from './lib/settings-snapshot';
import { markAppearanceApplied } from './lib/startup-appearance';
import "./index.css";
import { initLogging } from './lib/logging';

const disposeLogging = initLogging();
if (import.meta.hot) import.meta.hot.dispose(disposeLogging);

/**
 * Apply the persisted appearance, then mount.
 *
 * `index.html` hardcodes `class="dark"` so the window has a sane background even
 * before React runs. Without this step, nothing ever overrode that default at
 * startup: the theme was only reached from the Settings page, so a user who
 * chose 浅色 or 液态玻璃 would see the dark theme again on every launch until
 * they happened to visit Settings.
 *
 * All of it comes from ONE `settings_get_all`: the theme, the accent, the four
 * backdrop keys and the two glass keys are rows of the same table, and reading
 * them one key at a time cost nine IPC round trips that all queued behind the
 * database connection. The same snapshot also seeds the cover store, so the
 * first cover render does not repeat the dump. Applying it before the first
 * paint means no flash of the wrong theme, and the backdrop grant (per-process)
 * is in place before anything renders.
 *
 * Cover migration is *not* awaited: it walks every game's cover (copying or
 * downloading originals into the managed directory) and is idempotent —
 * managed files are skipped on later startups and failed originals retry — so
 * it runs after the window is already interactive.
 */
async function bootstrap(): Promise<void> {
  try {
    const snapshot = toSettingsSnapshot(await settingsGetAll());
    await Promise.all([initTheme(snapshot), initBackdrop(snapshot), initGlassAppearance(snapshot)]);
    seedCoverPreferences(snapshot);
    // The folder definitions are one more row of the same dump; seeding them
    // here lets 游戏文件夹 paint its folder list without its own settings read.
    seedLibraryFolders(snapshot);
    markAppearanceApplied();
  } catch (error) {
    // A failed read must never block the window: the hardcoded defaults in
    // index.html are a valid fallback, and the pages read settings again.
    console.warn("[theme] could not apply the stored theme:", error);
  }

  // Prefetch the game rows once, so the first page does not have to. This is
  // deliberately not awaited: the window must appear immediately, and the
  // first page's `ensureLibraryData()` joins this same request.
  void ensureLibraryData();

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <ToastProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </ToastProvider>
    </React.StrictMode>,
  );

  // Preserve existing covers once the UI is up. Managed files are skipped on
  // later startups; failed originals can retry.
  try { await migrateCovers(); }
  catch (error) { console.warn('[covers] could not preserve existing covers:', error); }
}

void bootstrap();
