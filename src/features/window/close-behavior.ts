/**
 * Shared close-button behaviour setting.
 *
 * The Rust side intercepts every window close and asks the frontend; this value
 * decides whether the prompt appears, the window hides to the tray, or the app
 * exits immediately.
 */

/** Settings key shared with the close dialog and the settings page. */
export const CLOSE_BEHAVIOR_KEY = "close_behavior";

/** `ask` = show the prompt every time; `tray` = hide to tray; `exit` = quit. */
export type CloseBehavior = "ask" | "tray" | "exit";

export const CLOSE_BEHAVIOR_OPTIONS: ReadonlyArray<{ value: CloseBehavior; label: string }> = [
  { value: "ask", label: "每次询问" },
  { value: "tray", label: "缩小至托盘" },
  { value: "exit", label: "直接关闭" },
];

/** Unknown / unset values fall back to asking, never to silently quitting. */
export function normalizeCloseBehavior(value: string | null | undefined): CloseBehavior {
  return value === "tray" || value === "exit" ? value : "ask";
}
