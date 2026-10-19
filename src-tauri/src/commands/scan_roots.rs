//! `scan_roots_*` commands.

use tauri::AppHandle;

use super::error::{CmdError, CmdResult};
use super::games::pool;
use super::model::ScanRoot;
use super::util::*;

/// Grant access only to saved local cover files. Covers selected outside a
/// scan root work too; configuring a scan root never grants a whole disk tree.
/// Runtime grants are rebuilt on every launch.
#[tauri::command]
pub async fn sync_asset_scope(app: AppHandle) -> CmdResult<usize> {
    let pool = pool(&app).await?;
    let paths: Vec<(String,)> = sqlx::query_as(
        "SELECT DISTINCT cover_path FROM games WHERE cover_path IS NOT NULL",
    )
    .fetch_all(&pool)
    .await?;

    let mut granted = 0usize;
    for (path,) in paths {
        if std::path::Path::new(&path).is_file() {
            crate::allow_asset_file(&app, &path);
            granted += 1;
        }
    }
    let custom: Vec<(Option<String>,)> = sqlx::query_as("SELECT value FROM settings WHERE key LIKE 'game_cover:%'")
        .fetch_all(&pool).await?;
    for (raw,) in custom {
        if let Some(value) = raw.and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok()) {
            if let Some(path) = value.get("customPath").and_then(|p| p.as_str()) {
                if std::path::Path::new(path).is_file() { crate::allow_asset_file(&app, path); granted += 1; }
            }
        }
    }
    Ok(granted)
}

/// `scan_roots_list` — all configured scan roots, oldest first.
#[tauri::command]
pub async fn scan_roots_list(app: AppHandle) -> CmdResult<Vec<ScanRoot>> {
    let pool = pool(&app).await?;
    let roots = sqlx::query_as::<_, ScanRoot>(
        "SELECT id, path, enabled, max_depth FROM scan_roots ORDER BY id ASC",
    )
    .fetch_all(&pool)
    .await?;
    Ok(roots)
}

/// `scan_root_create` — add a directory to scan. Paths are unique.
#[tauri::command]
pub async fn scan_root_create(
    app: AppHandle,
    path: String,
    enabled: Option<i64>,
    max_depth: Option<i64>,
) -> CmdResult<ScanRoot> {
    let pool = pool(&app).await?;
    let path = required_string(&path, "path")?;
    let enabled = enabled.unwrap_or(1);
    let max_depth = validate_max_depth(max_depth)?.unwrap_or(3);

    let existing: Option<(i64,)> = sqlx::query_as("SELECT id FROM scan_roots WHERE path = ?")
        .bind(&path)
        .fetch_optional(&pool)
        .await?;
    if existing.is_some() {
        return Err(CmdError(format!("scan root {path:?} already exists")));
    }

    let id: i64 = sqlx::query_scalar(
        "INSERT INTO scan_roots (path, enabled, max_depth) VALUES (?, ?, ?) RETURNING id",
    )
    .bind(&path)
    .bind(enabled)
    .bind(max_depth)
    .fetch_one(&pool)
    .await?;

    Ok(ScanRoot {
        id,
        path,
        enabled,
        max_depth,
    })
}

/// `scan_root_update` — toggle `enabled` and/or change `max_depth`.
#[tauri::command]
pub async fn scan_root_update(
    app: AppHandle,
    id: i64,
    enabled: Option<i64>,
    max_depth: Option<i64>,
) -> CmdResult<ScanRoot> {
    let pool = pool(&app).await?;

    if let Some(enabled) = enabled {
        let result = sqlx::query("UPDATE scan_roots SET enabled = ? WHERE id = ?")
            .bind(enabled)
            .bind(id)
            .execute(&pool)
            .await?;
        if result.rows_affected() == 0 {
            return Err(not_found("scan root", id));
        }
    }

    if let Some(max_depth) = validate_max_depth(max_depth)? {
        let result = sqlx::query("UPDATE scan_roots SET max_depth = ? WHERE id = ?")
            .bind(max_depth)
            .bind(id)
            .execute(&pool)
            .await?;
        if result.rows_affected() == 0 {
            return Err(not_found("scan root", id));
        }
    }

    let root = sqlx::query_as::<_, ScanRoot>(
        "SELECT id, path, enabled, max_depth FROM scan_roots WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(&pool)
    .await?;
    root.ok_or_else(|| not_found("scan root", id))
}

/// `scan_root_delete` — remove a scan root.
#[tauri::command]
pub async fn scan_root_delete(app: AppHandle, id: i64) -> CmdResult<()> {
    let pool = pool(&app).await?;
    let result = sqlx::query("DELETE FROM scan_roots WHERE id = ?")
        .bind(id)
        .execute(&pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(not_found("scan root", id));
    }
    Ok(())
}
