//! `library_health_check` — one pass over the library reporting broken records.
//!
//! Read-only: nothing is repaired, deleted or rewritten. The report tells the
//! user which entries point at a missing install directory, a missing launcher,
//! a missing cover file, or repeat the same install path.

use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use tauri::AppHandle;

use super::error::{CmdError, CmdResult};
use super::games::pool;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthIssue {
    pub id: i64,
    pub title: String,
    pub install_path: String,
    pub exe_path: Option<String>,
    pub cover_path: Option<String>,
    /// `missingInstall` | `missingExe` | `missingCover` | `duplicateInstall`
    pub problems: Vec<&'static str>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HealthReport {
    pub checked: usize,
    pub healthy: usize,
    pub missing_install: usize,
    pub missing_exe: usize,
    pub missing_cover: usize,
    pub duplicate_install: usize,
    pub archived: usize,
    pub issues: Vec<HealthIssue>,
}

#[derive(sqlx::FromRow)]
struct Row {
    id: i64,
    title: String,
    install_path: String,
    exe_path: Option<String>,
    cover_path: Option<String>,
}

/// Archived entries are intentionally uninstalled, so their paths are not
/// reported as damage. Mirrors `relocation::archived_ids`.
async fn archived_ids(db: &sqlx::SqlitePool) -> CmdResult<Vec<i64>> {
    let keys: Vec<String> =
        sqlx::query_scalar("SELECT key FROM settings WHERE value='true' AND key LIKE 'game_archived:%'")
            .fetch_all(db)
            .await?;
    Ok(keys
        .into_iter()
        .filter_map(|key| {
            let suffix = key.strip_prefix("game_archived:")?;
            let id = suffix.parse::<i64>().ok()?;
            (id > 0 && id.to_string() == suffix).then_some(id)
        })
        .collect())
}

/// A cover is only broken when it is a local path that no longer exists.
/// Remote URLs and empty values are not damage.
fn cover_missing(path: Option<&str>) -> bool {
    let Some(path) = path.map(str::trim).filter(|path| !path.is_empty()) else {
        return false;
    };
    if path.starts_with("http://") || path.starts_with("https://") {
        return false;
    }
    !Path::new(path).is_file()
}

fn exe_missing(path: Option<&str>) -> bool {
    path.map(str::trim)
        .filter(|path| !path.is_empty())
        .is_none_or(|path| !Path::new(path).is_file())
}

#[tauri::command]
pub async fn library_health_check(app: AppHandle) -> CmdResult<HealthReport> {
    let db = pool(&app).await?;
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT id, title, install_path, exe_path, cover_path FROM games ORDER BY id",
    )
    .fetch_all(&db)
    .await?;
    let archived = archived_ids(&db).await?;
    let archived: std::collections::HashSet<i64> = archived.into_iter().collect();

    let mut counts: HashMap<String, usize> = HashMap::new();
    for row in &rows {
        let key = row.install_path.trim().to_lowercase();
        if !key.is_empty() {
            *counts.entry(key).or_default() += 1;
        }
    }

    let report = tauri::async_runtime::spawn_blocking(move || {
        let mut report = HealthReport {
            checked: rows.len(),
            ..HealthReport::default()
        };
        for row in rows {
            if archived.contains(&row.id) {
                report.archived += 1;
                continue;
            }
            let mut problems = Vec::new();
            if !Path::new(row.install_path.trim()).is_dir() {
                problems.push("missingInstall");
                report.missing_install += 1;
            } else if exe_missing(row.exe_path.as_deref()) {
                problems.push("missingExe");
                report.missing_exe += 1;
            }
            if cover_missing(row.cover_path.as_deref()) {
                problems.push("missingCover");
                report.missing_cover += 1;
            }
            if counts
                .get(&row.install_path.trim().to_lowercase())
                .is_some_and(|count| *count > 1)
            {
                problems.push("duplicateInstall");
                report.duplicate_install += 1;
            }
            if problems.is_empty() {
                report.healthy += 1;
                continue;
            }
            report.issues.push(HealthIssue {
                id: row.id,
                title: row.title,
                install_path: row.install_path,
                exe_path: row.exe_path,
                cover_path: row.cover_path,
                problems,
            });
        }
        report
    })
    .await
    .map_err(|error| CmdError(format!("库健康检查失败：{error}")))?;

    crate::logging::record(
        "INFO",
        "library",
        &format!(
            "库健康检查 checked={} healthy={} install={} exe={} cover={} duplicate={}",
            report.checked,
            report.healthy,
            report.missing_install,
            report.missing_exe,
            report.missing_cover,
            report.duplicate_install
        ),
    );
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_and_remote_covers_are_not_damage() {
        assert!(!cover_missing(None));
        assert!(!cover_missing(Some("   ")));
        assert!(!cover_missing(Some("https://example.test/cover.jpg")));
        assert!(!cover_missing(Some("http://example.test/cover.jpg")));
        assert!(cover_missing(Some("E:/nowhere/cover.jpg")));
    }

    #[test]
    fn a_cover_that_still_exists_is_healthy() {
        let root = std::env::temp_dir().join(format!("koipage-health-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let cover = root.join("cover.png");
        std::fs::write(&cover, b"bytes").unwrap();
        assert!(!cover_missing(Some(cover.to_str().unwrap())));
        std::fs::remove_file(&cover).unwrap();
        assert!(cover_missing(Some(cover.to_str().unwrap())));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_missing_or_blank_launcher_counts_as_damage() {
        assert!(exe_missing(None));
        assert!(exe_missing(Some("  ")));
        assert!(exe_missing(Some("E:/nowhere/game.exe")));
    }
}
