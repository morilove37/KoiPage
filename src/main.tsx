import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { initBackdrop } from "./lib/backdrop";
import { initTheme } from "./lib/theme";
import "./index.css";

/**
 * Apply the persisted theme before the first paint, then mount.
 *
 * `index.html` hardcodes `class="dark"` so the window has a sane background even
 * before React runs. Without this call, nothing ever overrode that default at
 * startup: `initTheme()` was only reached from the Settings page, so a user who
 * chose 浅色 or 液态玻璃 would see the dark theme again on every launch until
 * they happened to visit Settings.
 *
 * Awaiting it means no flash of the wrong theme. The read is a single indexed
 * lookup in the local SQLite file, so it resolves in well under a frame; if it
 * fails we still mount, falling back to the hardcoded default.
 *
 * The custom glass wallpaper is read and applied in the same step. It also has
 * to happen before the first paint, and it is what re-grants the asset protocol
 * for the stored image (the grant is per-process), so a background chosen in a
 * previous session is readable again by the time anything renders.
 */
async function bootstrap(): Promise<void> {
  try {
    await Promise.all([initTheme(), initBackdrop()]);
  } catch (error) {
    console.warn("[theme] could not apply the stored theme:", error);
  }

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </React.StrictMode>,
  );
}

void bootstrap();
