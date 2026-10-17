//! Window lifecycle commands driven by the frontend's close prompt.
//!
//! Closing the window never destroys it directly: the Rust side intercepts
//! `CloseRequested` (see `lib.rs`) and asks the frontend what to do. These
//! commands are the two possible answers, plus the restore path used by the tray
//! icon.

use tauri::{AppHandle, Manager};

use super::error::{CmdError, CmdResult};

/// Bring the main window back, e.g. from the tray icon or its menu.
pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
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
pub fn app_quit(app: AppHandle) {
    app.exit(0);
}
