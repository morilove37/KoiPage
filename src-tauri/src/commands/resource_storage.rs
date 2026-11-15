//! Restart-time relocation of SQLite and managed resources, retaining originals.

use super::error::{CmdError, CmdResult};
use serde::Serialize;
use sqlx::SqlitePool;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{OnceLock, RwLock},
};
use tauri::{AppHandle, Manager};

#[path = "resource_storage_files.rs"]
mod files;
pub(crate) const ROOT_KEY: &str = "resource_storage_root";
static ROOT: OnceLock<RwLock<Option<PathBuf>>> = OnceLock::new();
static ACCESS: tokio::sync::RwLock<()> = tokio::sync::RwLock::const_new(());

/// Hold from directory selection until the final reference is persisted. A
/// background command moves this guard into its spawned task before returning.
/// try_read/try_write never queue a writer, so nested guarded operations cannot
/// deadlock behind a pending migration (e.g. refresh -> safety backup).
pub(crate) fn operation_guard() -> CmdResult<tokio::sync::RwLockReadGuard<'static, ()>> {
    super::data_storage::ensure_available()?;
    ACCESS
        .try_read()
        .map_err(|_| CmdError("资源目录正在迁移，请稍后重试".into()))
}

fn migration_guard() -> CmdResult<tokio::sync::RwLockWriteGuard<'static, ()>> {
    ACCESS.try_write().map_err(|_| {
        CmdError("图片处理、生日同步或资料更新正在进行，请待其完成或取消后再迁移资源目录".into())
    })
}

/// Called when the SQL pool first becomes available, before resource writers run.
pub(super) async fn initialize(db: &SqlitePool) -> CmdResult<()> {
    if ROOT.get().is_none() {
        let path = super::settings::settings_get_impl(db, ROOT_KEY)
            .await?
            .filter(|path| Path::new(path).is_absolute())
            .map(PathBuf::from);
        let _ = ROOT.set(RwLock::new(path));
    }
    Ok(())
}

pub(crate) fn root(app: &AppHandle) -> CmdResult<PathBuf> {
    if let Some(root) = ROOT.get() {
        if let Some(path) = root
            .read()
            .map_err(|_| CmdError("资源目录状态不可用".into()))?
            .as_ref()
        {
            return Ok(path.clone());
        }
    }
    Ok(app.path().app_data_dir()?)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageInfo {
    directory: String,
    database_path: String,
    available: bool,
    copied_files: usize,
    restart_required: bool,
    pending_directory: Option<String>,
}
fn info(app: &AppHandle, copied_files: usize) -> CmdResult<StorageInfo> {
    let root = root(app)?;
    Ok(StorageInfo {
        available: root.is_dir(),
        directory: root.to_string_lossy().into_owned(),
        database_path: super::data_storage::database_directory(app)?
            .join("galgame.db")
            .to_string_lossy()
            .into_owned(),
        copied_files,
        restart_required: super::data_storage::pending().is_some(),
        pending_directory: super::data_storage::pending()
            .map(|path| path.to_string_lossy().into_owned()),
    })
}

#[tauri::command]
pub async fn resource_storage_info(app: AppHandle) -> CmdResult<StorageInfo> {
    if ROOT.get().is_none() {
        super::data_storage::initialize_database(app.clone()).await?;
    }
    info(&app, 0)
}

fn mapped(path: &str, paths: &HashMap<PathBuf, String>) -> Option<String> {
    Path::new(path)
        .canonicalize()
        .ok()
        .and_then(|path| paths.get(&path).cloned())
}

fn rewrite_json(value: &mut serde_json::Value, paths: &HashMap<PathBuf, String>) -> bool {
    match value {
        serde_json::Value::String(path) => {
            if let Some(next) = mapped(path, paths) {
                *path = next;
                true
            } else {
                false
            }
        }
        serde_json::Value::Object(values) => values.values_mut().fold(false, |changed, value| {
            rewrite_json(value, paths) || changed
        }),
        serde_json::Value::Array(values) => values.iter_mut().fold(false, |changed, value| {
            rewrite_json(value, paths) || changed
        }),
        _ => false,
    }
}

async fn switch_references(
    db: &SqlitePool,
    source: &Path,
    target: &Path,
    paths: &HashMap<PathBuf, String>,
) -> CmdResult<()> {
    let mut tx = db.begin().await?;
    let games: Vec<(i64, String)> =
        sqlx::query_as("SELECT id,cover_path FROM games WHERE cover_path IS NOT NULL")
            .fetch_all(&mut *tx)
            .await?;
    for (id, path) in games {
        if let Some(next) = mapped(&path, paths) {
            sqlx::query("UPDATE games SET cover_path=? WHERE id=?")
                .bind(next)
                .bind(id)
                .execute(&mut *tx)
                .await?;
        }
    }
    let exists: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE name='birthday_characters'")
            .fetch_one(&mut *tx)
            .await?;
    if exists > 0 {
        for column in ["avatar_path", "override_avatar"] {
            let rows: Vec<(String, String)> = sqlx::query_as(&format!(
                "SELECT id,{column} FROM birthday_characters WHERE {column} IS NOT NULL"
            ))
            .fetch_all(&mut *tx)
            .await?;
            for (id, path) in rows {
                if let Some(next) = mapped(&path, paths) {
                    sqlx::query(&format!(
                        "UPDATE birthday_characters SET {column}=? WHERE id=?"
                    ))
                    .bind(next)
                    .bind(id)
                    .execute(&mut *tx)
                    .await?;
                }
            }
        }
    }
    let settings:Vec<(String,String)>=sqlx::query_as("SELECT key,value FROM settings WHERE key GLOB 'game_cover:*' OR key GLOB 'society_logo:*' OR key IN ('background_image_path','save_backup_storage_root')").fetch_all(&mut *tx).await?;
    for (key, raw) in settings {
        let next = if key == "save_backup_storage_root" {
            // Snapshot roots are directories, while the copy manifest records files.
            source.canonicalize().ok().and_then(|old| {
                Path::new(&raw)
                    .canonicalize()
                    .ok()?
                    .strip_prefix(old)
                    .ok()
                    .map(|relative| target.join(relative).to_string_lossy().into_owned())
            })
        } else if key == "background_image_path" {
            mapped(&raw, paths)
        } else {
            serde_json::from_str::<serde_json::Value>(&raw)
                .ok()
                .and_then(|mut value| rewrite_json(&mut value, paths).then(|| value.to_string()))
        };
        if let Some(next) = next {
            sqlx::query("UPDATE settings SET value=? WHERE key=?")
                .bind(next)
                .bind(key)
                .execute(&mut *tx)
                .await?;
        }
    }
    sqlx::query("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(ROOT_KEY).bind(target.to_string_lossy().as_ref()).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

async fn prepare_database_copy(
    source_database: &Path,
    source_resources: &Path,
    target: &Path,
    paths: &HashMap<PathBuf, String>,
) -> CmdResult<()> {
    let database = target.join("galgame.db");
    super::data_storage::snapshot_closed_database(source_database, &database).await?;
    let copy = super::data_storage::open_existing(&database).await?;
    let changed = async {
        switch_references(&copy, source_resources, target, paths).await?;
        super::data_storage::verify(&copy).await
    }
    .await;
    copy.close().await;
    changed?;
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&database)
        .and_then(|file| file.sync_all())
        .map_err(|error| CmdError(format!("无法同步新数据库：{error}")))?;
    Ok(())
}

/// Copy resources first. Drain/close the live pool, snapshot its final committed
/// state, rewrite only that copy, and publish the independent boot marker last.
#[tauri::command]
pub async fn resource_storage_change(
    app: AppHandle,
    parent_path: String,
) -> CmdResult<StorageInfo> {
    super::data_storage::ensure_available()?;
    let _migration = migration_guard()?;
    // Backups/restores and snapshot operations share this guard.
    let running = app.state::<crate::launcher::RunningGames>();
    let _guard = running.1.lock().await;
    if !running
        .0
        .lock()
        .map_err(|_| CmdError("无法读取运行中的游戏".into()))?
        .is_empty()
    {
        return Err(CmdError(
            "请先结束所有正在运行的游戏，再迁移数据库和资源".into(),
        ));
    }
    let db = super::games::pool(&app).await?;
    let source_database = db.connect_options().get_filename().to_path_buf();
    let config = super::data_storage::database_directory(&app)?;
    if config.join(".koipage-restore").exists() {
        return Err(CmdError(
            "已有待恢复数据，请完全退出并重新打开恋页后再更改资源目录".into(),
        ));
    }
    let source = root(&app)?;
    let parent = PathBuf::from(parent_path);
    if !parent.is_absolute() || !parent.is_dir() {
        return Err(CmdError("请选择可用的绝对目录".into()));
    }
    let target = parent.join(format!(
        "KoiPage-data-{}",
        time::OffsetDateTime::now_utc().unix_timestamp_nanos()
    ));
    let source_copy = source.clone();
    let target_copy = target.clone();
    let copied = tauri::async_runtime::spawn_blocking(move || {
        files::copy_resources(&source_copy, &target_copy)
    })
    .await
    .map_err(|error| CmdError(format!("资源复制任务失败：{error}")))?
    .map_err(|error| {
        CmdError(format!(
            "资源迁移未生效，原文件和设置已保留：{error}。若目标目录已创建，可检查：{}",
            target.display()
        ))
    })?;
    let count = copied.len();
    let paths: HashMap<PathBuf, String> = copied
        .into_iter()
        .map(|(source, target)| (source, target.to_string_lossy().into_owned()))
        .collect();
    super::data_storage::freeze();
    db.close().await;
    let result = async {
        prepare_database_copy(&source_database, &source, &target, &paths).await?;
        super::data_storage::publish_location(&app.path().app_config_dir()?, &target)?;
        Ok::<_, CmdError>(())
    }
    .await;
    if let Err(error) = result {
        if let Err(reopen) = super::data_storage::reconnect(&app, &source_database).await {
            return Err(CmdError(format!(
                "迁移未生效，原数据库和文件已保留；重新连接失败，请完全退出后重启：{error}；{reopen}。已复制文件保留在：{}",
                target.display()
            )));
        }
        return Err(CmdError(format!(
            "迁移未生效，已恢复原数据库连接，原数据和设置已保留：{error}。已复制文件保留在：{}",
            target.display()
        )));
    }
    super::data_storage::mark_pending(target);
    info(&app, count)
}

#[tauri::command]
pub fn resource_storage_restart(app: AppHandle) -> CmdResult<()> {
    if super::data_storage::pending().is_none() {
        return Err(CmdError("尚无等待生效的数据目录迁移".into()));
    }
    crate::instance::release_for_restart();
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[tokio::test]
    async fn migration_and_background_resource_writes_are_mutually_exclusive() {
        let operation = operation_guard().unwrap();
        assert!(
            migration_guard().is_err(),
            "a batch must finish before migration starts"
        );
        let (release, released) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            // The guard moves into the worker before the start command returns.
            let _operation = operation;
            let _ = released.await;
        });
        assert!(migration_guard().is_err());
        release.send(()).unwrap();
        task.await.unwrap();
        let migration = migration_guard().unwrap();
        assert!(
            operation_guard().is_err(),
            "new writers cannot start mid-copy"
        );
        drop(migration);
        assert!(operation_guard().is_ok());
    }

    async fn fixture() -> (
        PathBuf,
        PathBuf,
        PathBuf,
        SqlitePool,
        HashMap<PathBuf, String>,
    ) {
        let root = std::env::temp_dir().join(format!(
            "koipage-resource-db-{}-{}",
            std::process::id(),
            time::OffsetDateTime::now_utc().unix_timestamp_nanos()
        ));
        let source = root.join("old");
        let target = root.join("new");
        for name in [
            "covers",
            "society-logos",
            "birthday-avatars",
            "restored-assets/123/saves",
        ] {
            fs::create_dir_all(source.join(name)).unwrap();
        }
        for path in [
            "covers/a.png",
            "society-logos/a.png",
            "birthday-avatars/a.png",
            "restored-assets/123/saves/manifest.json",
        ] {
            fs::write(source.join(path), path).unwrap();
        }
        let copied = files::copy_resources(&source, &target).unwrap();
        let paths = copied
            .into_iter()
            .map(|(source, target)| (source, target.to_string_lossy().into_owned()))
            .collect();
        let db = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                sqlx::sqlite::SqliteConnectOptions::new()
                    .filename(source.join("galgame.db"))
                    .create_if_missing(true),
            )
            .await
            .unwrap();
        sqlx::raw_sql(include_str!("../../migrations/0001_init.sql"))
            .execute(&db)
            .await
            .unwrap();
        sqlx::raw_sql(include_str!("../../migrations/0003_birthdays.sql"))
            .execute(&db)
            .await
            .unwrap();
        let cover = source.join("covers/a.png").to_string_lossy().into_owned();
        sqlx::query("INSERT INTO games(id,title,install_path,cover_path,description,created_at,updated_at,play_time_seconds) VALUES(1,'Title','E:/game',?,'keep description','created','updated',321)").bind(&cover).execute(&db).await.unwrap();
        let prefs=serde_json::json!({"customPath":cover,"censored":true,"crop":{"path":cover,"x":0.1},"future":123}).to_string();
        for (key, value) in [
            ("game_cover:1", prefs),
            (
                "society_logo:abc",
                serde_json::json!({"path":source.join("society-logos/a.png"),"custom":true})
                    .to_string(),
            ),
            (
                "save_backup_storage_root",
                source
                    .join("restored-assets/123/saves")
                    .to_string_lossy()
                    .into_owned(),
            ),
            (
                "friends_config",
                "credentials must remain unchanged".to_owned(),
            ),
        ] {
            sqlx::query("INSERT INTO settings(key,value) VALUES(?,?)")
                .bind(key)
                .bind(value)
                .execute(&db)
                .await
                .unwrap();
        }
        sqlx::query("INSERT INTO birthday_characters(id,source,external_id,name,avatar_path,override_avatar) VALUES('bgm:1','bangumi','1','Character',?,?)").bind(source.join("birthday-avatars/a.png").to_string_lossy().as_ref()).bind(&cover).execute(&db).await.unwrap();
        (root, source, target, db, paths)
    }

    #[tokio::test]
    async fn switch_preserves_crop_metadata_descriptions_credentials_and_original_files() {
        let (root, source, target, db, paths) = fixture().await;
        switch_references(&db, &source, &target, &paths)
            .await
            .unwrap();
        let row: (String, String, i64) =
            sqlx::query_as("SELECT cover_path,description,play_time_seconds FROM games WHERE id=1")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(
            Path::new(&row.0).canonicalize().unwrap(),
            target.join("covers/a.png").canonicalize().unwrap()
        );
        assert_eq!((row.1, row.2), ("keep description".into(), 321));
        let prefs = super::super::settings::settings_get_impl(&db, "game_cover:1")
            .await
            .unwrap()
            .unwrap();
        let prefs: serde_json::Value = serde_json::from_str(&prefs).unwrap();
        assert_eq!(prefs["customPath"], row.0);
        assert_eq!(prefs["crop"]["path"], row.0);
        assert_eq!(prefs["censored"], true);
        assert_eq!(prefs["future"], 123);
        let avatar: (String, String) = sqlx::query_as(
            "SELECT avatar_path,override_avatar FROM birthday_characters WHERE id='bgm:1'",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(
            Path::new(&avatar.0).canonicalize().unwrap(),
            target
                .join("birthday-avatars/a.png")
                .canonicalize()
                .unwrap()
        );
        assert_eq!(avatar.1, row.0);
        let setting = |key: &'static str| super::super::settings::settings_get_impl(&db, key);
        assert_eq!(
            setting(ROOT_KEY).await.unwrap().unwrap(),
            target.to_string_lossy()
        );
        assert_eq!(
            Path::new(&setting("save_backup_storage_root").await.unwrap().unwrap())
                .canonicalize()
                .unwrap(),
            target
                .join("restored-assets/123/saves")
                .canonicalize()
                .unwrap()
        );
        assert_eq!(
            setting("friends_config").await.unwrap().unwrap(),
            "credentials must remain unchanged"
        );
        assert!(source.join("covers/a.png").is_file());
        db.close().await;
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn staged_database_rewrites_only_copy_and_retains_original_database_records() {
        let (root, source, target, db, paths) = fixture().await;
        let source_database = source.join("galgame.db");
        // Use a real file-backed live DB, as production does. A memory-mode
        // SQLite connection can carry its OPEN_MEMORY flag into VACUUM INTO,
        // yielding no physical file for the subsequent reopen on Windows.
        db.close().await;
        prepare_database_copy(&source_database, &source, &target, &paths)
            .await
            .unwrap();
        let retained = super::super::data_storage::open_existing(&source_database)
            .await
            .unwrap();
        let original_cover: String = sqlx::query_scalar("SELECT cover_path FROM games WHERE id=1")
            .fetch_one(&retained)
            .await
            .unwrap();
        assert_eq!(
            original_cover,
            source.join("covers/a.png").to_string_lossy()
        );
        assert!(
            super::super::settings::settings_get_impl(&retained, ROOT_KEY)
                .await
                .unwrap()
                .is_none()
        );
        let copy = super::super::data_storage::open_existing(&target.join("galgame.db"))
            .await
            .unwrap();
        let (cover, description): (String, String) =
            sqlx::query_as("SELECT cover_path,description FROM games WHERE id=1")
                .fetch_one(&copy)
                .await
                .unwrap();
        assert_eq!(
            Path::new(&cover).canonicalize().unwrap(),
            target.join("covers/a.png").canonicalize().unwrap()
        );
        assert_eq!(description, "keep description");
        assert_eq!(
            super::super::settings::settings_get_impl(&copy, "friends_config")
                .await
                .unwrap()
                .unwrap(),
            "credentials must remain unchanged"
        );
        retained.close().await;
        copy.close().await;
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn failed_database_commit_rolls_back_all_references_and_preference() {
        let (root, source, target, db, paths) = fixture().await;
        sqlx::raw_sql("CREATE TRIGGER reject_root BEFORE INSERT ON settings WHEN NEW.key='resource_storage_root' BEGIN SELECT RAISE(ABORT,'simulated failure'); END;").execute(&db).await.unwrap();
        assert!(
            switch_references(&db, &source, &target, &paths)
                .await
                .is_err()
        );
        let cover: String = sqlx::query_scalar("SELECT cover_path FROM games WHERE id=1")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(cover, source.join("covers/a.png").to_string_lossy());
        assert!(
            super::super::settings::settings_get_impl(&db, ROOT_KEY)
                .await
                .unwrap()
                .is_none()
        );
        assert!(source.join("covers/a.png").is_file());
        assert!(target.join("covers/a.png").is_file());
        db.close().await;
        fs::remove_dir_all(root).unwrap();
    }
}
