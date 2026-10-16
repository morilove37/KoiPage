// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

pub mod commands;
pub mod launcher;
pub mod metadata;
pub mod scanner;
mod rating;

use commands::DB_URL;

/// Grant read access to one locally stored cover image.
pub fn allow_asset_file(app: &tauri::AppHandle, path: &str) {
    use tauri::Manager;

    let file = std::path::Path::new(path);
    if !file.is_file() {
        return;
    }
    if let Err(error) = app.asset_protocol_scope().allow_file(file) {
        eprintln!("[asset-scope] could not allow {path}: {error}");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            #[cfg(desktop)]
            app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
            Ok(())
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
            // games
            commands::games::games_list,
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
            commands::metadata::metadata_autofetch,
            // scanner (scan-import)
            scanner::scan_directory,
            // scanner (manual exe import)
            scanner::inspect_exe_file,
            // launcher (launch-settings)
            launcher::launch_game,
            launcher::game_running,
            launcher::stop_game,
            launcher::export_games,
            launcher::import_games,
            launcher::backup_database,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
