//! Window lifecycle commands driven by the frontend's close prompt.
//!
//! Closing the window never destroys it directly: the Rust side intercepts
//! `CloseRequested` (see `lib.rs`) and asks the frontend what to do. These
//! commands are the two possible answers, plus the restore path used by the tray
//! icon.

use std::sync::OnceLock;

use tauri::{AppHandle, Manager};

use super::error::{CmdError, CmdResult};

/// Set once `run()` has a live [`AppHandle`] to act on.
static APP: OnceLock<AppHandle> = OnceLock::new();

/// Remember the handle so the single-instance guard can wake the window later.
pub fn remember_app(app: AppHandle) {
    let _ = APP.set(app);
}

/// Bring this manager's window back, e.g. after a re-launch asked for it.
///
/// Same as [`show_main_window`]: the window may be hidden or minimized, and the
/// restore has to work even when the hide did not go through this API.
pub fn restore_main_window(app: &AppHandle) {
    show_main_window(app);
}

/// Is the main window visible according to the OS (not just the webview API)?
#[cfg(windows)]
pub fn is_main_window_visible(app: &AppHandle) -> Option<bool> {
    use windows_sys::Win32::UI::WindowsAndMessaging::IsWindowVisible;

    let window = app.get_webview_window("main")?;
    let hwnd = top_level_window(&window)?;
    // SAFETY: `hwnd` is a live window handle owned by this process.
    let visible = unsafe { IsWindowVisible(hwnd) } != 0;
    Some(visible)
}

/// The real top-level window behind a Tauri window.
///
/// `WebviewWindow::hwnd()` can hand back the webview's child window. Showing or
/// testing *that* leaves the frame hidden, so always climb to the root window
/// before touching Win32 visibility.
#[cfg(windows)]
fn top_level_window(window: &tauri::WebviewWindow) -> Option<*mut std::ffi::c_void> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GA_ROOT, GetAncestor};

    let hwnd = window.hwnd().ok()?;
    let root = unsafe { GetAncestor(hwnd.0 as _, GA_ROOT) };
    Some(if root.is_null() { hwnd.0 as _ } else { root })
}

#[cfg(not(windows))]
pub fn is_main_window_visible(_app: &AppHandle) -> Option<bool> {
    None
}

/// Bring the main window back, e.g. from the tray icon or its menu.
///
/// `show`/`unminimize` alone are not enough: tao caches the window's visibility,
/// so if the window was hidden or minimized outside this API (another process,
/// a Win32 call, a session change) the cached state says "already visible" and
/// the OS window stays hidden. The native `ShowWindow` below is what actually
/// makes it reappear; it is safe to call when the window is already shown.
pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        #[cfg(windows)]
        force_native_show(&window);
        let _ = window.set_focus();
    }
}

/// Force the OS window visible and in front, regardless of cached state.
#[cfg(windows)]
fn force_native_show(window: &tauri::WebviewWindow) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SW_RESTORE, SW_SHOW, SetForegroundWindow, ShowWindow,
    };

    let Some(hwnd) = top_level_window(window) else {
        return;
    };
    // SAFETY: `hwnd` is this process' own top-level window.
    unsafe {
        ShowWindow(hwnd, SW_SHOW);
        ShowWindow(hwnd, SW_RESTORE);
        SetForegroundWindow(hwnd);
    }
}

/// `app_show_window` — restore the main window from the tray.
#[tauri::command]
pub fn app_show_window(app: AppHandle) -> CmdResult<()> {
    if app.get_webview_window("main").is_none() {
        return Err(CmdError("主窗口不存在".into()));
    }
    show_main_window(&app);
    Ok(())
}

/// `app_hide_to_tray` — hide the window; the process keeps running in the tray.
#[tauri::command]
pub fn app_hide_to_tray(app: AppHandle) -> CmdResult<()> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| CmdError("主窗口不存在".into()))?;
    window
        .hide()
        .map_err(|error| CmdError(format!("无法隐藏窗口：{error}")))?;
    Ok(())
}

/// `app_quit` — actually terminate the application.
#[tauri::command]
pub async fn app_quit(app: AppHandle) -> CmdResult<()> {
    // A full exit credits confirmed play time before dropping the process registry.
    if super::games::pool(&app).await.is_ok() {
        crate::launcher::sessions::prepare_manager_exit(app.clone()).await?;
    }
    app.exit(0);
    Ok(())
}

#[tauri::command]
pub fn manager_running_count(app: AppHandle) -> CmdResult<usize> {
    Ok(app.state::<crate::launcher::RunningGames>().0.lock()
        .map_err(|_| CmdError("进程表不可用".into()))?.len())
}
