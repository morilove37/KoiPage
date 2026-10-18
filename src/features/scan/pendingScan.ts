/**
 * Cross-page hand-off for "extract in 实用工具, then import in 游戏库".
 *
 * The tools page has no scan import dialog, so it stores the extracted folders
 * in sessionStorage and navigates to the library, which opens the add-game
 * dialog preloaded with those folders and scans them immediately.
 */

const PENDING_SCAN_KEY = "koipage_pending_scan_roots";

/** Remember extracted folders for the next library visit. */
export function setPendingScanRoots(roots: string[]): void {
  try {
    sessionStorage.setItem(PENDING_SCAN_KEY, JSON.stringify(roots));
  } catch {
    // A locked-down webview may forbid storage; the user can still scan manually.
  }
}

/** Read and clear the hand-off so a refresh does not rescan every time. */
export function takePendingScanRoots(): string[] | null {
  try {
    const raw = sessionStorage.getItem(PENDING_SCAN_KEY);
    if (raw === null) return null;
    sessionStorage.removeItem(PENDING_SCAN_KEY);
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const roots = parsed.filter((value): value is string => typeof value === "string" && value.trim() !== "");
    return roots.length > 0 ? roots : null;
  } catch {
    return null;
  }
}
