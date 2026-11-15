//! Bootstrap location is deliberately outside the database being relocated.

use super::{
    DB_URL,
    error::{CmdError, CmdResult},
};
use serde::{Deserialize, Serialize};
use sqlx::{
    SqlitePool,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
};
use std::{
    borrow::Cow,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{
        OnceLock, RwLock,
        atomic::{AtomicBool, Ordering},
    },
};
use tauri::{AppHandle, Manager};
use tauri_plugin_sql::{DbInstances, DbPool};

const MARKER: &str = "data-location.json";
static ACTIVE: OnceLock<PathBuf> = OnceLock::new();
static FROZEN: AtomicBool = AtomicBool::new(false);
static PENDING: OnceLock<RwLock<Option<PathBuf>>> = OnceLock::new();
static INITIALIZING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Location {
    version: u8,
    directory: PathBuf,
}

fn error(message: impl std::fmt::Display) -> CmdError {
    CmdError(format!("数据目录：{message}"))
}

pub(crate) fn ensure_available() -> CmdResult<()> {
    if FROZEN.load(Ordering::Acquire) {
        return Err(error(
            "当前已暂停数据读写，请等待迁移完成并按提示完全重启恋页",
        ));
    }
    Ok(())
}

pub(crate) fn freeze() {
    FROZEN.store(true, Ordering::Release);
}
pub(crate) fn resume() {
    FROZEN.store(false, Ordering::Release);
}
pub(crate) fn pending() -> Option<PathBuf> {
    PENDING.get().and_then(|value| {
        value
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    })
}
pub(crate) fn mark_pending(path: PathBuf) {
    *PENDING
        .get_or_init(|| RwLock::new(None))
        .write()
        .unwrap_or_else(|error| error.into_inner()) = Some(path);
}

/// A broken/missing custom drive is an error, never a reason to open an empty C: DB.
fn resolve_directory(original: &Path) -> CmdResult<PathBuf> {
    let marker = original.join(MARKER);
    let metadata = match fs::metadata(&marker) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(original.to_path_buf());
        }
        Err(failure) => return Err(error(failure)),
    };
    if metadata.len() > 16 * 1024 {
        return Err(error(
            "启动位置记录过大，请检查原应用配置目录中的 data-location.json",
        ));
    }
    let location: Location =
        serde_json::from_slice(&fs::read(&marker).map_err(error)?).map_err(error)?;
    if location.version != 1
        || !location.directory.is_absolute()
        || !location.directory.is_dir()
        // A restore can be interrupted after moving the live DB aside. Let
        // the restore plugin validate/recover its staged files before opening
        // SQLite; never create a replacement DB in this case.
        || (!location.directory.join("galgame.db").is_file()
            && !location.directory.join(".koipage-restore/ready").is_file())
    {
        return Err(error(format!(
            "自定义数据库不可用，请连接原磁盘或恢复目录后重试：{}。启动位置记录保留在：{}",
            location.directory.display(),
            marker.display()
        )));
    }
    Ok(location.directory)
}

pub(crate) fn database_directory(app: &AppHandle) -> CmdResult<PathBuf> {
    if let Some(path) = ACTIVE.get() {
        return Ok(path.clone());
    }
    let path = resolve_directory(&app.path().app_config_dir()?)?;
    let _ = ACTIVE.set(path.clone());
    Ok(ACTIVE.get().cloned().unwrap_or(path))
}

/// Stage and sync the complete marker next to its final path, then rename last.
pub(crate) fn publish_location(original: &Path, target: &Path) -> CmdResult<()> {
    if !target.is_absolute() || !target.join("galgame.db").is_file() {
        return Err(error("新数据库未准备完成"));
    }
    fs::create_dir_all(original).map_err(error)?;
    let temporary = original.join(format!(
        ".data-location-{}-{}.tmp",
        std::process::id(),
        time::OffsetDateTime::now_utc().unix_timestamp_nanos()
    ));
    let bytes = serde_json::to_vec(&Location {
        version: 1,
        directory: target.to_path_buf(),
    })
    .map_err(error)?;
    let result = (|| -> std::io::Result<()> {
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        // Both paths share the original config directory, so this publication
        // must be a same-volume atomic rename, never a copy/delete fallback.
        fs::rename(&temporary, original.join(MARKER))
    })();
    if let Err(failure) = result {
        let _ = fs::remove_file(&temporary);
        return Err(error(failure));
    }
    Ok(())
}

pub(crate) async fn open_existing(path: &Path) -> CmdResult<SqlitePool> {
    Ok(SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(path)
                .create_if_missing(false),
        )
        .await?)
}

pub(crate) async fn reconnect(app: &AppHandle, path: &Path) -> CmdResult<()> {
    let db = open_existing(path).await?;
    app.state::<DbInstances>()
        .0
        .write()
        .await
        .insert(DB_URL.to_owned(), DbPool::Sqlite(db));
    resume();
    Ok(())
}

pub(crate) async fn verify(db: &SqlitePool) -> CmdResult<()> {
    let result: String = sqlx::query_scalar("PRAGMA quick_check")
        .fetch_one(db)
        .await?;
    if result != "ok" {
        return Err(error(format!("数据库完整性校验失败：{result}")));
    }
    Ok(())
}

/// Call only after closing/draining the live pool: even WAL commits made just
/// before close are included, and no later command can mutate the source.
pub(crate) async fn snapshot_closed_database(source: &Path, target: &Path) -> CmdResult<()> {
    let db = open_existing(source).await?;
    let result = sqlx::query("VACUUM INTO ?")
        .bind(target.to_string_lossy().as_ref())
        .execute(&db)
        .await;
    db.close().await;
    result?;
    Ok(())
}

async fn open_and_migrate(path: &Path, create: bool) -> CmdResult<SqlitePool> {
    let db = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(path)
                .create_if_missing(create),
        )
        .await?;
    let migrations = super::migrations()
        .into_iter()
        .map(|migration| {
            sqlx::migrate::Migration::new(
                migration.version,
                migration.description.into(),
                sqlx::migrate::MigrationType::ReversibleUp,
                migration.sql.into(),
                false,
            )
        })
        .collect();
    let migrator = sqlx::migrate::Migrator {
        migrations: Cow::Owned(migrations),
        ..sqlx::migrate::Migrator::DEFAULT
    };
    if let Err(failure) = migrator.run(&db).await {
        db.close().await;
        return Err(error(failure));
    }
    Ok(db)
}

/// Use the plugin's stable logical key while opening the selected physical file.
/// Frontend constructs Database(DB_URL), and must not call plugin SQL load again.
#[tauri::command]
pub async fn initialize_database(app: AppHandle) -> CmdResult<()> {
    let _resources = super::resource_storage::operation_guard()?;
    ensure_available()?;
    let _initializing = INITIALIZING.lock().await;
    ensure_available()?;
    let instances = app.state::<DbInstances>();
    let existing = {
        let instances = instances.0.read().await;
        instances.get(DB_URL).and_then(|entry| match entry {
            DbPool::Sqlite(db) if !db.is_closed() => Some(db.clone()),
            _ => None,
        })
    };
    if let Some(db) = existing {
        return super::resource_storage::initialize(&db).await;
    }
    let original = app.path().app_config_dir()?;
    let directory = database_directory(&app)?;
    let custom = original.join(MARKER).is_file();
    if !custom {
        fs::create_dir_all(&directory).map_err(error)?;
    }
    let db = open_and_migrate(&directory.join("galgame.db"), !custom).await?;
    super::resource_storage::initialize(&db).await?;
    instances
        .0
        .write()
        .await
        .insert(DB_URL.to_owned(), DbPool::Sqlite(db));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "koipage-data-location-{}-{}",
            std::process::id(),
            time::OffsetDateTime::now_utc().unix_timestamp_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }
    #[test]
    fn missing_custom_database_never_falls_back_to_original_database() {
        let root = fixture();
        let original = root.join("original");
        let target = root.join("chosen");
        fs::create_dir_all(&original).unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::write(original.join("galgame.db"), b"original retained").unwrap();
        fs::write(
            original.join(MARKER),
            serde_json::to_vec(&Location {
                version: 1,
                directory: target,
            })
            .unwrap(),
        )
        .unwrap();
        assert!(resolve_directory(&original).is_err());
        assert_eq!(
            fs::read(original.join("galgame.db")).unwrap(),
            b"original retained"
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn location_publication_is_reusable_and_preserves_source_database() {
        let root = fixture();
        let original = root.join("original");
        fs::create_dir_all(&original).unwrap();
        fs::write(original.join("galgame.db"), b"source").unwrap();
        for name in ["first", "second"] {
            let target = root.join(name);
            fs::create_dir_all(&target).unwrap();
            fs::write(target.join("galgame.db"), b"verified snapshot").unwrap();
            publish_location(&original, &target).unwrap();
            assert_eq!(resolve_directory(&original).unwrap(), target);
        }
        assert_eq!(fs::read(original.join("galgame.db")).unwrap(), b"source");
        assert_eq!(fs::read_dir(&original).unwrap().count(), 2);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn interrupted_custom_restore_reaches_recovery_before_database_open() {
        let root = fixture();
        let original = root.join("original");
        let target = root.join("selected");
        fs::create_dir_all(&original).unwrap();
        fs::create_dir_all(target.join(".koipage-restore")).unwrap();
        fs::write(target.join("galgame.db"), b"original database").unwrap();
        publish_location(&original, &target).unwrap();
        fs::rename(target.join("galgame.db"), target.join(".koipage-restore/database.previous")).unwrap();
        fs::write(target.join(".koipage-restore/ready"), b"pending restore must be validated by restore plugin").unwrap();
        assert_eq!(resolve_directory(&original).unwrap(), target);
        assert!(!target.join("galgame.db").exists());
        fs::remove_file(target.join(".koipage-restore/ready")).unwrap();
        assert!(resolve_directory(&original).is_err(), "no ready restore must fail instead of creating an empty database");
        fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn frozen_database_snapshot_keeps_wal_commits_descriptions_and_migration_checksums() {
        let root = fixture();
        let original = root.join("galgame.db");
        let target = root.join("copy.db");
        let db = open_and_migrate(&original, true).await.unwrap();
        sqlx::query("PRAGMA journal_mode=WAL")
            .execute(&db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO games(title,install_path,description,created_at,updated_at) VALUES('Game','E:/game','完整简介','created','updated')").execute(&db).await.unwrap();
        db.close().await;
        assert!(
            sqlx::query("UPDATE games SET description='late write'")
                .execute(&db)
                .await
                .is_err()
        );
        snapshot_closed_database(&original, &target).await.unwrap();
        // Re-running the exact plugin-compatible migrations must accept checksums.
        let copy = open_and_migrate(&target, false).await.unwrap();
        verify(&copy).await.unwrap();
        let description: String = sqlx::query_scalar("SELECT description FROM games")
            .fetch_one(&copy)
            .await
            .unwrap();
        assert_eq!(description, "完整简介");
        copy.close().await;
        let retained = open_existing(&original).await.unwrap();
        let description: String = sqlx::query_scalar("SELECT description FROM games")
            .fetch_one(&retained)
            .await
            .unwrap();
        assert_eq!(description, "完整简介");
        retained.close().await;
        fs::remove_dir_all(root).unwrap();
    }
}
