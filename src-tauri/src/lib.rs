// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

pub mod commands;
mod bangumi_sync;
pub mod birthdays;
pub mod instance;
pub mod extract;
pub mod launcher;
pub mod metadata;
pub mod scanner;
mod rating;
pub mod logging;
pub mod file_ops;

use commands::DB_URL;

/// Grant read access to one locally stored cover image.
pub fn allow_asset_file(app: &tauri::AppHandle, path: &str) {
    use tauri::Manager;

    let file = std::path::Path::new(path);
    if !file.is_file() {
        return;
    }
    if let Err(error) = app.asset_protocol_scope().allow_file(file) {
        crate::app_warn!("[asset-scope] could not allow {path}: {error}");
    }
}

/// Create the tray icon that keeps the app reachable after the window is hidden.
///
/// The frontend decides on `CloseRequested` whether to hide or exit; the tray is
/// always available so "缩小至托盘" never strands the window with no way back.
fn setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let show = MenuItem::with_id(app, "tray-show", "显示恋页", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray-quit", "退出恋页", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let Some(icon) = app.default_window_icon().cloned() else {
        crate::app_warn!("[tray] default window icon is missing; tray icon disabled");
        return Ok(());
    };

    TrayIconBuilder::with_id("koipage-tray")
        .icon(icon)
        .tooltip("恋页 KoiPage")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "tray-show" => commands::window::show_main_window(app),
            "tray-quit" => {
                use tauri::Emitter;
                commands::window::show_main_window(app);
                let _ = app.emit("quit-requested", ());
            },
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                commands::window::show_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // A second launch shows a notice and activates the existing window, then
    // exits before another manager, tray icon or database connection is created.
    if instance::acquire() == instance::Role::Duplicate {
        return;
    }
    logging::init();

    tauri::Builder::default()
        .manage(bangumi_sync::SyncState::default())
        .manage(commands::metadata_refresh::RefreshJob::default())
        .plugin(commands::backup::restore_plugin())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            commands::window::remember_app(app.handle().clone());
            #[cfg(desktop)]
            app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
            setup_tray(app.handle())?;
            // From now on a re-launch wakes this window instead of opening a
            // second manager.
            instance::listen_for_activation(app.handle().clone());
            Ok(())
        })
        // The window must not vanish on its own: the frontend shows the close
        // prompt (缩小至托盘 / 直接关闭) and calls a command back. Programmatic
        // exits (`app.exit`, used by the tray menu and the updater) bypass this.
        .on_window_event(|window, event| {
            use tauri::{Emitter, WindowEvent};
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if let Err(error) = window.emit("close-requested", ()) {
                    crate::app_warn!("[window] could not emit close-requested: {error}");
                }
            }
        })
        .plugin(
            tauri_plugin_sql::Builder::new()
                // Migrations only run once the database is actually connected,
                // which `preload` does during plugin setup. Without it the
                // frontend's first `Database.load(DB_URL)` would be the
                // trigger, so keep this list in sync with commands::DB_URL.
                .add_migrations(DB_URL, commands::migrations())
                .build(),
        )
        // `launcher` commands call `app.state::<RunningGames>()`, which panics
        // at runtime if the state was never managed.
        .manage(launcher::RunningGames::default())
        .invoke_handler(tauri::generate_handler![
            logging::logs_info,
            logging::logs_write,
            logging::logs_export,
            logging::logs_open_directory,
            // games
            commands::games::games_list,
            commands::library_batch::games_batch_update,
            commands::launch_profiles::launch_profile_get,
            commands::launch_profiles::launch_profile_save,
            commands::relocation::game_paths_check,
            commands::relocation::game_paths_preview,
            commands::relocation::game_paths_apply,
            commands::games::game_get,
            commands::games::game_create,
            commands::games::game_update,
            commands::games::game_delete,
            commands::games::games_delete,
            commands::games::games_tags_get,
            commands::games::games_stats,
            // tags
            commands::tags::tags_list,
            commands::tags::tag_create,
            commands::tags::tag_update,
            commands::tags::tag_delete,
            commands::tags::game_set_tags,
            // play sessions
            commands::play_sessions::play_session_start,
            commands::play_sessions::play_session_end,
            commands::play_sessions::play_sessions_list,
            // settings
            commands::settings::settings_get,
            commands::settings::settings_set,
            commands::settings::settings_get_all,
            commands::settings::settings_delete,
            bangumi_sync::bangumi_sync_status,
            bangumi_sync::bangumi_sync_connect,
            bangumi_sync::bangumi_sync_disconnect,
            bangumi_sync::bangumi_sync_configure,
            bangumi_sync::bangumi_sync_run,
            bangumi_sync::bangumi_sync_items,
            bangumi_sync::bangumi_sync_profile_get,
            bangumi_sync::bangumi_sync_profile_save,
            bangumi_sync::bangumi_sync_pause,
            bangumi_sync::bangumi_sync_resolve,
            commands::installation::game_archive_set,
            commands::save_backups::save_backup_settings_get,
            commands::save_backups::save_backup_settings_set,
            commands::save_backups::save_backup_create,
            commands::save_backups::save_backup_list,
            commands::save_backups::save_backup_restore,
            commands::save_backups::save_backup_delete,
            commands::save_backups::save_backup_directory,
            commands::updater::ensure_update_ready,
            commands::share::share_cover_read,
            commands::share::share_image_save,
            commands::share::share_images_upload,
            // custom backdrop (液态玻璃 theme wallpaper)
            commands::settings::background_asset_grant,
            // scan roots
            commands::scan_roots::scan_roots_list,
            commands::scan_roots::scan_root_create,
            commands::scan_roots::scan_root_update,
            commands::scan_roots::scan_root_delete,
            commands::scan_roots::sync_asset_scope,
            // external metadata (NextMoe / VNDB / Bangumi)
            commands::metadata::metadata_search,
            commands::metadata::metadata_detail,
            commands::metadata::metadata_apply,
            commands::metadata::metadata_cover_cache,
            commands::metadata::metadata_cover_preview,
            commands::covers::game_cover_import,
            commands::covers::covers_migrate,
            commands::metadata::metadata_autofetch,
            commands::metadata_refresh::metadata_refresh_status,
            commands::metadata_refresh::metadata_refresh_start,
            commands::metadata_refresh::metadata_refresh_cancel,
            // cached library character birthdays
            birthdays::birthdays_list,
            birthdays::birthdays_update,
            birthdays::birthdays_sync_start,
            birthdays::birthdays_sync_cancel,
            birthdays::birthdays_export,
            birthdays::birthdays_import,
            // scanner (scan-import)
            scanner::scan_directory,
            // scanner (manual exe import)
            scanner::inspect_exe_file,
            // archive extraction (archive-import)
            extract::archive_group,
            extract::archive_extract,
            // launcher (launch-settings)
            launcher::launch_game,
            launcher::locale::locale_tool_status,
            launcher::magpie::magpie_status,
            launcher::magpie::magpie_launch,
            launcher::magpie::magpie_quit,
            launcher::luna::luna_status,
            launcher::luna::luna_launch,
            launcher::luna::luna_quit,
            launcher::magpie::magpie_scaling_config,
            launcher::magpie::magpie_scaling_set,
            launcher::magpie::magpie_scaling_reset,
            launcher::game_running,
            launcher::stop_game,
            launcher::export_games,
            launcher::import_games,
            launcher::backup_database,
            commands::backup::backup_create,
            commands::backup::backup_estimate,
            commands::backup::backup_preview,
            commands::backup::backup_restore_prepare,
            commands::backup::backup_restore_notice,
            launcher::sessions::recover_play_sessions,
            launcher::sessions::settle_orphan_session,
            launcher::sessions::play_session_save,
            launcher::sessions::play_session_delete,
            launcher::sessions::prepare_manager_exit,
            // window / tray lifecycle
            commands::window::app_show_window,
            commands::window::app_hide_to_tray,
            commands::window::app_quit,
            commands::window::manager_running_count,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
