//! Validate and remap library paths without moving game files.

use super::{
    error::{CmdError, CmdResult},
    games::pool,
    util::now_iso8601,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use std::collections::HashSet;
use std::path::Path;
use tauri::{AppHandle, Manager};

fn root(value: &str) -> CmdResult<String> {
    let value = value.trim().replace('/', "\\");
    let absolute = value.as_bytes().get(1) == Some(&b':')
        && value.as_bytes().get(2) == Some(&b'\\')
        || value.starts_with("\\\\");
    if !absolute
        || value.contains('\0')
        || value.split('\\').any(|part| part == ".." || part == ".")
    {
        return Err(CmdError("请输入不含 . 或 .. 的完整目录路径".into()));
    }
    Ok(value.trim_end_matches('\\').to_string())
}
pub fn map_path(value: &str, old_root: &str, new_root: &str) -> CmdResult<Option<String>> {
    let old = root(old_root)?;
    let new = root(new_root)?;
    let value = value.replace('/', "\\");
    let prefix = value.get(..old.len());
    if prefix.is_none_or(|p| !p.eq_ignore_ascii_case(&old)) {
        return Ok(None);
    }
    let tail = &value[old.len()..];
    if !tail.is_empty() && !tail.starts_with('\\') {
        return Ok(None);
    }
    if tail.split('\\').any(|part| part == ".." || part == ".") {
        return Err(CmdError("原路径包含相对路径段，请先修正".into()));
    }
    Ok(Some(format!("{new}{tail}")))
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathCheck {
    id: i64,
    title: String,
    install_path: String,
    exe_path: Option<String>,
    state: String,
}
#[derive(Debug, Clone, sqlx::FromRow)]
struct Paths {
    id: i64,
    title: String,
    install_path: String,
    exe_path: Option<String>,
    workdir: Option<String>,
    save_path: Option<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelocationRow {
    id: i64,
    title: String,
    old_install_path: String,
    new_install_path: String,
    new_exe_path: Option<String>,
    new_workdir: Option<String>,
    new_save_path: Option<String>,
    ready: bool,
    message: String,
    fingerprint: String,
}
#[derive(Debug, Deserialize)]
pub struct PathExpectation {
    id: i64,
    fingerprint: String,
}
fn fingerprint(row: &Paths, old: &str, new: &str) -> String {
    let data = serde_json::json!([
        row.id,
        row.title,
        row.install_path,
        row.exe_path,
        row.workdir,
        row.save_path,
        old,
        new
    ]);
    format!("{:x}", Sha256::digest(data.to_string().as_bytes()))
}
async fn archived_ids(db: &SqlitePool) -> CmdResult<HashSet<i64>> {
    let keys: Vec<String> = sqlx::query_scalar("SELECT key FROM settings WHERE value='true' AND key LIKE 'game_archived:%'")
        .fetch_all(db).await?;
    Ok(keys.into_iter().filter_map(|key| {
        let suffix = key.strip_prefix("game_archived:")?;
        let id = suffix.parse::<i64>().ok()?;
        (id > 0 && id.to_string() == suffix).then_some(id)
    }).collect())
}
async fn rows(db: &SqlitePool) -> CmdResult<Vec<Paths>> {
    Ok(sqlx::query_as(
        "SELECT id,title,install_path,exe_path,workdir,save_path FROM games ORDER BY id",
    )
    .fetch_all(db)
    .await?)
}
fn remap_option(value: &Option<String>, old: &str, new: &str) -> CmdResult<Option<String>> {
    match value {
        Some(value) => Ok(Some(
            map_path(value, old, new)?.unwrap_or_else(|| value.clone()),
        )),
        None => Ok(None),
    }
}
fn plan(all: &[Paths], ids: &[i64], old: &str, new: &str) -> CmdResult<Vec<RelocationRow>> {
    root(old)?;
    root(new)?;
    if old
        .replace('/', "\\")
        .trim_end_matches('\\')
        .eq_ignore_ascii_case(new.replace('/', "\\").trim_end_matches('\\'))
    {
        return Err(CmdError("新旧目录相同，无需修复".into()));
    }
    let mut result = Vec::new();
    for row in all {
        if !ids.is_empty() && !ids.contains(&row.id) {
            continue;
        }
        let Some(target) = map_path(&row.install_path, old, new)? else {
            continue;
        };
        let exe = remap_option(&row.exe_path, old, new)?;
        let workdir = remap_option(&row.workdir, old, new)?;
        let save = remap_option(&row.save_path, old, new)?;
        let conflict = all.iter().any(|other| {
            other.id != row.id
                && other
                    .install_path
                    .replace('/', "\\")
                    .trim_end_matches('\\')
                    .eq_ignore_ascii_case(&target)
        });
        let folder_ok = Path::new(&target).is_dir();
        let exe_ok = exe.as_deref().is_some_and(|p| Path::new(p).is_file());
        let workdir_ok = workdir
            .as_deref()
            .filter(|p| !p.trim().is_empty())
            .is_none_or(|p| Path::new(p).is_dir());
        let ready = !conflict && folder_ok && exe_ok && workdir_ok;
        let message = if conflict {
            "目标目录已有另一条游戏记录"
        } else if !folder_ok {
            "新安装目录不存在或磁盘未连接"
        } else if !exe_ok {
            "新启动文件未找到，请核对目录"
        } else if !workdir_ok {
            "新工作目录不存在"
        } else {
            "路径有效，可更新"
        };
        result.push(RelocationRow {
            id: row.id,
            title: row.title.clone(),
            old_install_path: row.install_path.clone(),
            new_install_path: target,
            new_exe_path: exe,
            new_workdir: workdir,
            new_save_path: save,
            ready,
            message: message.into(),
            fingerprint: fingerprint(row, old, new),
        });
    }
    let mut targets = HashSet::new();
    for row in &mut result {
        if !targets.insert(row.new_install_path.to_lowercase()) {
            row.ready = false;
            row.message = "映射后出现重复安装目录，请先整理重复记录".into();
        }
    }
    if result.is_empty() {
        return Err(CmdError("没有匹配旧目录的游戏".into()));
    }
    Ok(result)
}
#[tauri::command]
pub async fn game_paths_check(app: AppHandle) -> CmdResult<Vec<PathCheck>> {
    let db = pool(&app).await?;
    let all = rows(&db).await?;
    let archived = archived_ids(&db).await?;
    tauri::async_runtime::spawn_blocking(move || {
        all.into_iter()
            .map(|row| {
                let root = Path::new(&row.install_path)
                    .components()
                    .take(2)
                    .collect::<std::path::PathBuf>();
                let state = if archived.contains(&row.id) {
                    "archived"
                } else if !root.exists() {
                    "offline"
                } else if !Path::new(&row.install_path).is_dir() {
                    "missingFolder"
                } else if row
                    .exe_path
                    .as_deref()
                    .is_none_or(|p| !Path::new(p).is_file())
                {
                    "missingExe"
                } else {
                    "ok"
                };
                PathCheck {
                    id: row.id,
                    title: row.title,
                    install_path: row.install_path,
                    exe_path: row.exe_path,
                    state: state.into(),
                }
            })
            .collect()
    })
    .await
    .map_err(|e| CmdError(e.to_string()))
}
#[tauri::command]
pub async fn game_paths_preview(
    app: AppHandle,
    old_root: String,
    new_root: String,
) -> CmdResult<Vec<RelocationRow>> {
    let db = pool(&app).await?;
    let archived = archived_ids(&db).await?;
    let all = rows(&db).await?;
    tauri::async_runtime::spawn_blocking(move || {
        let result: Vec<_> = plan(&all, &[], &old_root, &new_root)?.into_iter().filter(|row| !archived.contains(&row.id)).collect();
        if result.is_empty() { return Err(CmdError("没有匹配旧目录的已安装游戏".into())); }
        Ok(result)
    })
        .await
        .map_err(|e| CmdError(e.to_string()))?
}
async fn apply(
    db: &SqlitePool,
    old: &str,
    new: &str,
    ids: &[i64],
    expected: &[PathExpectation],
) -> CmdResult<usize> {
    if ids.is_empty()
        || ids.iter().any(|id| *id <= 0)
        || ids.iter().collect::<HashSet<_>>().len() != ids.len()
    {
        return Err(CmdError("请选择有效且不重复的游戏".into()));
    }
    let mut tx = db.begin().await?;
    // Acquire the write lock before reading paths so a competing edit cannot invalidate the plan.
    sqlx::query("UPDATE games SET updated_at=updated_at WHERE 0")
        .execute(&mut *tx)
        .await?;
    let all: Vec<Paths> =
        sqlx::query_as("SELECT id,title,install_path,exe_path,workdir,save_path FROM games")
            .fetch_all(&mut *tx)
            .await?;
    for id in ids {
        let archived: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key=?").bind(format!("game_archived:{id}")).fetch_optional(&mut *tx).await?.flatten();
        if archived.as_deref() == Some("true") { return Err(CmdError("所选游戏已归档，请重新预览路径变更".into())); }
    }
    let changes = plan(&all, ids, old, new)?;
    if changes.len() != ids.len() || changes.iter().any(|r| !r.ready) {
        return Err(CmdError(
            "路径检查未通过，请重新预览并仅选择可更新的游戏".into(),
        ));
    }
    if expected.len() != ids.len()
        || changes.iter().any(|row| {
            !expected
                .iter()
                .any(|e| e.id == row.id && e.fingerprint == row.fingerprint)
        })
    {
        return Err(CmdError("预览后游戏路径已改变，请重新预览再确认".into()));
    }
    let now = now_iso8601();
    for change in &changes {
        sqlx::query("UPDATE games SET install_path=?,exe_path=?,workdir=?,save_path=?,updated_at=? WHERE id=?")
            .bind(&change.new_install_path).bind(&change.new_exe_path).bind(&change.new_workdir).bind(&change.new_save_path).bind(&now).bind(change.id).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(changes.len())
}
#[tauri::command]
pub async fn game_paths_apply(
    app: AppHandle,
    old_root: String,
    new_root: String,
    ids: Vec<i64>,
    expected: Vec<PathExpectation>,
) -> CmdResult<usize> {
    let running = app.state::<crate::launcher::RunningGames>();
    let _guard = running.1.lock().await;
    if !running
        .0
        .lock()
        .map_err(|_| CmdError("进程表不可用".into()))?
        .is_empty()
    {
        return Err(CmdError("请先退出正在运行的游戏再修复路径".into()));
    }
    apply(&pool(&app).await?, &old_root, &new_root, &ids, &expected).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn maps_only_whole_windows_directory_prefixes() {
        assert_eq!(
            map_path(r"D:\Gal\Title\game.exe", r"d:\gal", r"E:\Games").unwrap(),
            Some(r"E:\Games\Title\game.exe".into())
        );
        assert_eq!(
            map_path(r"D:\Galaxy\game.exe", r"D:\Gal", r"E:\Games").unwrap(),
            None
        );
        assert_eq!(
            map_path(r"D:\Gal", r"D:\Gal", r"E:\Games").unwrap(),
            Some(r"E:\Games".into())
        );
        assert!(map_path(r"D:\Gal\game.exe", "", r"E:\Games").is_err());
        assert!(map_path(r"D:\Gal\game.exe", r"D:\Gal", r"E:\Games\..\oops").is_err());
    }

    #[tokio::test]
    async fn invalid_mapping_does_not_change_existing_records() {
        let db = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::raw_sql("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE games(id INTEGER PRIMARY KEY,title TEXT,install_path TEXT UNIQUE,exe_path TEXT,workdir TEXT,save_path TEXT,updated_at TEXT); INSERT INTO games VALUES(1,'A','D:\\Gal\\A','D:\\Gal\\A\\game.exe',NULL,NULL,'');").execute(&db).await.unwrap();
        assert!(
            apply(&db, r"D:\Gal", r"Z:\missing-test-target", &[1], &[])
                .await
                .is_err()
        );
        let path: String = sqlx::query_scalar("SELECT install_path FROM games WHERE id=1")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(path, r"D:\Gal\A");
        assert!(
            apply(&db, r"D:\Gal", r"Z:\missing-test-target", &[1, 1], &[])
                .await
                .is_err()
        );
        sqlx::query("INSERT INTO settings(key,value) VALUES('game_archived:1','true')").execute(&db).await.unwrap();
        assert!(archived_ids(&db).await.unwrap().contains(&1));
        let error = apply(&db, r"D:\Gal", r"Z:\missing-test-target", &[1], &[]).await.unwrap_err();
        assert!(error.0.contains("已归档"));
        db.close().await;
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn relocation_updates_related_paths_and_preserves_identity() {
        let temp = std::env::temp_dir().join(format!(
            "koipage-path-{}",
            time::OffsetDateTime::now_utc().unix_timestamp_nanos()
        ));
        std::fs::create_dir_all(temp.join("A")).unwrap();
        std::fs::write(temp.join("A/game.exe"), b"fixture").unwrap();
        let target = temp.to_string_lossy().into_owned();
        let db = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::raw_sql("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE games(id INTEGER PRIMARY KEY,title TEXT,install_path TEXT UNIQUE,exe_path TEXT,workdir TEXT,save_path TEXT,updated_at TEXT); INSERT INTO games VALUES(7,'A','D:\\Gal\\A','D:\\Gal\\A\\game.exe','D:\\Gal\\A','D:\\Gal\\A\\save','');").execute(&db).await.unwrap();
        let preview = plan(&rows(&db).await.unwrap(), &[7], r"D:\Gal", &target).unwrap();
        let expected = vec![PathExpectation {
            id: 7,
            fingerprint: preview[0].fingerprint.clone(),
        }];
        sqlx::query("UPDATE games SET save_path='D:\\Gal\\A\\changed' WHERE id=7")
            .execute(&db)
            .await
            .unwrap();
        assert!(
            apply(&db, r"D:\Gal", &target, &[7], &expected)
                .await
                .is_err()
        );
        sqlx::query("UPDATE games SET save_path='D:\\Gal\\A\\save' WHERE id=7")
            .execute(&db)
            .await
            .unwrap();
        assert_eq!(
            apply(&db, r"D:\Gal", &target, &[7], &expected)
                .await
                .unwrap(),
            1
        );
        let row: (i64, String, String, String) =
            sqlx::query_as("SELECT id,install_path,exe_path,save_path FROM games")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(row.0, 7);
        assert_eq!(row.1, format!("{target}\\A"));
        assert_eq!(row.2, format!("{target}\\A\\game.exe"));
        assert_eq!(row.3, format!("{target}\\A\\save"));
        db.close().await;
        std::fs::remove_dir_all(&temp).unwrap();
    }
}
