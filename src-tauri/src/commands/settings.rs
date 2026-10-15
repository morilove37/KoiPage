//! `settings_get` / `settings_set` commands backed by the `settings` table.

use tauri::AppHandle;
use tauri::Manager;

use super::error::{CmdError, CmdResult};
use super::games::pool;
use super::model::Setting;
use sqlx::{Pool, Sqlite};

/// Read one setting from an existing pool.
///
/// Split out from the command so other modules (e.g. `metadata`, which needs the
/// optional NextMoe key) can read settings without holding an `AppHandle`.
pub async fn settings_get_impl(pool: &Pool<Sqlite>, key: &str) -> CmdResult<Option<String>> {
    let row: Option<(Option<String>,)> = sqlx::query_as("SELECT value FROM settings WHERE key = ?")
        .bind(key)
        .fetch_optional(pool)
        .await?;
    Ok(row.and_then(|(v,)| v))
}

/// `settings_get` — a single value, or `null` when the key is unset.
#[tauri::command]
pub async fn settings_get(app: AppHandle, key: String) -> CmdResult<Option<String>> {
    let pool = pool(&app).await?;
    settings_get_impl(&pool, &key).await
}

/// `settings_set` — upsert a key. Passing `null` stores SQL NULL.
#[tauri::command]
pub async fn settings_set(app: AppHandle, key: String, value: Option<String>) -> CmdResult<()> {
    let pool = pool(&app).await?;
    sqlx::query(
        "INSERT INTO settings (key, value) VALUES (?, ?) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(&key)
    .bind(&value)
    .execute(&pool)
    .await?;
    Ok(())
}

/// `settings_get_all` — every key/value pair, for hydrating app state in one call.
#[tauri::command]
pub async fn settings_get_all(app: AppHandle) -> CmdResult<Vec<Setting>> {
    let pool = pool(&app).await?;
    let rows = sqlx::query_as::<_, Setting>("SELECT key, value FROM settings ORDER BY key")
        .fetch_all(&pool)
        .await?;
    Ok(rows)
}

/// `settings_delete` — remove a key. Returns whether a row was removed.
#[tauri::command]
pub async fn settings_delete(app: AppHandle, key: String) -> CmdResult<bool> {
    let pool = pool(&app).await?;
    let result = sqlx::query("DELETE FROM settings WHERE key = ?")
        .bind(&key)
        .execute(&pool)
        .await?;
    Ok(result.rows_affected() > 0)
}

/// `background_asset_grant` — let the WebView read one local image file.
///
/// The 液态玻璃 theme can paint a user-chosen wallpaper
/// (`background_image_path` in the `settings` table). The asset protocol's
/// static `scope.allow` in `tauri.conf.json` is empty — paths are granted
/// explicitly at runtime — so a stored background is unreadable until this
/// command allows it, exactly like a cover image granted by
/// [`super::scan_roots::sync_asset_scope`].
///
/// The grant lives in the process, not on disk, so the frontend calls this
/// again on every launch (`src/lib/backdrop.ts` → `syncBackdrop`).
///
/// Rejects deliberately with a message instead of silently doing nothing: the
/// UI shows an error next to the picker for a path that vanished, which is
/// more useful than a background that is simply absent.
#[tauri::command]
pub async fn background_asset_grant(app: AppHandle, path: String) -> CmdResult<()> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(CmdError("background image path is empty".into()));
    }

    let file = std::path::Path::new(trimmed);
    if !file.is_file() {
        return Err(CmdError(format!("找不到背景图片文件：{trimmed}")));
    }

    app.asset_protocol_scope()
        .allow_file(file)
        .map_err(|error| CmdError(format!("无法读取背景图片 {trimmed}：{error}")))
}
