//! Bootstrap location is deliberately outside the database being relocated.

use super::{
    DB_URL,
    error::{CmdError, CmdResult},
};
use serde::{Deserialize, Serialize};
use sqlx::{
    SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
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
    time::Duration,
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

/// Options shared by every connection this module opens.
///
/// The busy timeout is not cosmetic: the pool runs five connections and the
/// launcher's session accounting takes write locks, so the 5s sqlx default can
/// surface as "database is locked" under a slow disk.
fn base_options(path: &Path, create: bool) -> SqliteConnectOptions {
    SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(create)
        .busy_timeout(Duration::from_secs(10))
}

/// Options for the pool that serves the running app.
///
/// WAL stops a read from waiting behind the writer — the UI reads games and
/// settings while play-session accounting writes — and `synchronous = NORMAL`
/// is the pairing SQLite documents for WAL: a crash may lose the last commits
/// but cannot corrupt the file. The journal mode is stored in the file header,
/// so the first launch after an upgrade pays for the switch and later ones do
/// not; `synchronous` is per connection and is re-applied on every open.
fn live_options(path: &Path, create: bool) -> SqliteConnectOptions {
    base_options(path, create)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
}

/// Open the pool that serves the running app, preferring WAL.
///
/// WAL needs shared memory beside the database, which network shares and some
/// removable filesystems do not provide. A user who moved their library to such
/// a drive could open it before this change, so a failed WAL switch must not be
/// the reason they cannot open it now: the pool falls back to the rollback
/// journal the app has always used.
async fn connect_live(path: &Path, create: bool) -> CmdResult<SqlitePool> {
    let attempt = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(live_options(path, create))
        .await;
    match attempt {
        Ok(db) => {
            // Some filesystems accept the pragma and silently keep the old
            // journal mode, so read it back instead of trusting the request.
            match sqlx::query_scalar::<_, String>("PRAGMA journal_mode")
                .fetch_one(&db)
                .await
            {
                Ok(mode) if mode.eq_ignore_ascii_case("wal") => return Ok(db),
                Ok(mode) => {
                    crate::app_warn!(
                        "[database] this drive keeps the {mode} journal; WAL is unavailable here"
                    );
                    db.close().await;
                }
                Err(failure) => {
                    crate::app_warn!("[database] could not read the journal mode: {failure}");
                    db.close().await;
                }
            }
        }
        Err(failure) => {
            crate::app_warn!("[database] WAL open failed ({failure}); using the rollback journal");
        }
    }
    Ok(SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(base_options(path, create))
        .await?)
}

pub(crate) async fn open_existing(path: &Path) -> CmdResult<SqlitePool> {
    Ok(SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(base_options(path, false))
        .await?)
}

pub(crate) async fn reconnect(app: &AppHandle, path: &Path) -> CmdResult<()> {
    let db = connect_live(path, false).await?;
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

/// Refuse a library that a newer build already migrated.
///
/// Migrations only move forward. sqlx validates the versions recorded in the
/// file against the ones this binary knows, and an unknown version aborts the
/// open with "migration N was previously applied but is missing in the
/// resolved migrations" — accurate, but meaningless to someone who just
/// reinstalled an older installer or opened an old shortcut. Checking up front
/// turns that into an instruction they can act on, and it costs one query on a
/// file that is about to be read anyway.
async fn reject_newer_library(db: &SqlitePool) -> CmdResult<()> {
    let newest = super::migrations()
        .into_iter()
        .map(|migration| migration.version)
        .max()
        .unwrap_or(0);
    // A database this app has never opened has no bookkeeping table yet; the
    // failed lookup is the expected state, not an error worth reporting.
    let recorded: Option<i64> = sqlx::query_scalar("SELECT MAX(version) FROM _sqlx_migrations")
        .fetch_one(db)
        .await
        .ok();
    match recorded {
        Some(version) if version > newest => Err(error(format!(
            "这个游戏库已被更新版本的恋页打开过（数据结构版本 {version}，当前程序只支持到 {newest}）。\
             请安装最新版本后再打开，或用备份恢复旧版本的数据。"
        ))),
        _ => Ok(()),
    }
}

async fn open_and_migrate(path: &Path, create: bool) -> CmdResult<SqlitePool> {
    let db = connect_live(path, create).await?;
    if let Err(failure) = reject_newer_library(&db).await {
        db.close().await;
        return Err(failure);
    }
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

/// Open and migrate the database during startup, before the frontend asks.
///
/// The window paints the moment the WebView finishes loading, and its very
/// first settings read has to wait for the connection. Opening here overlaps
/// that work with window creation instead of serialising behind it: by the time
/// the frontend calls `initialize_database` the pool is already registered, and
/// the call returns from the "already open" branch.
///
/// This is deliberately *not* the sql plugin's `preload`: that resolves a
/// relative `sqlite:` URL against `app_config_dir()`, which is exactly the
/// location a relocated library must not use, and it consumes the migration
/// list the normal path still needs. Everything here goes through the same
/// directory resolution as the command above, so the two agree.
///
/// Failures are left to the command path, which reports them to the UI: a
/// startup that cannot open the database should surface as a normal error
/// dialog, not as a silent background failure.
pub async fn warm_up(app: &AppHandle) {
    // The plugin registers `DbInstances` while plugins initialise, which
    // happens before the app's own setup closure — but only trust that if it
    // is actually there, since `state` panics when it is missing.
    if app.try_state::<DbInstances>().is_none() {
        crate::app_warn!("[database] the sql plugin did not register its state; skipping warm-up");
        return;
    }
    match initialize_database(app.clone()).await {
        Ok(()) => crate::logging::record("INFO", "backend", "[database] opened before the frontend asked"),
        Err(failure) => crate::app_warn!("[database] startup warm-up failed: {failure}"),
    }
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
    /// Windows releases SQLite's file handles a moment after `close()` resolves,
    /// so removing the directory can still fail briefly. Retry instead of flaking.
    fn cleanup(root: &Path) {
        for _ in 0..50 {
            match fs::remove_dir_all(root) {
                Ok(()) => return,
                Err(_) => std::thread::sleep(Duration::from_millis(20)),
            }
        }
        fs::remove_dir_all(root).unwrap();
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
    /// Build the database an older release would have left behind: the same
    /// migration SQL, applied only up to `through`.
    async fn library_at_version(path: &Path, through: i64) -> SqlitePool {
        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(base_options(path, true))
            .await
            .unwrap();
        let migrations = super::super::migrations()
            .into_iter()
            .filter(|migration| migration.version <= through)
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
        sqlx::migrate::Migrator {
            migrations: Cow::Owned(migrations),
            ..sqlx::migrate::Migrator::DEFAULT
        }
        .run(&db)
        .await
        .unwrap();
        db
    }

    #[tokio::test]
    async fn upgrading_a_released_library_keeps_every_row_and_only_adds_structure() {
        // Every shipped installer up to v0.7.6 embedded only migrations 1-4, so
        // that is the state an upgrading user actually brings. Rebuilding it
        // here from the same SQL keeps the checksums identical to theirs.
        let root = fixture();
        let path = root.join("galgame.db");
        let old = library_at_version(&path, 4).await;
        sqlx::query(
            "INSERT INTO games(title,install_path,status,favorite,play_time_seconds,description,created_at,updated_at) \
             VALUES('Existing','E:/games/existing','completed',1,3600,'简介','2026-01-01','2026-01-01')",
        )
        .execute(&old)
        .await
        .unwrap();
        sqlx::query("INSERT INTO tags(name) VALUES('已有标签')")
            .execute(&old)
            .await
            .unwrap();
        sqlx::query("INSERT INTO game_tags(game_id,tag_id) VALUES(1,1)")
            .execute(&old)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO play_sessions(game_id,started_at,ended_at,duration_seconds) \
             VALUES(1,'2026-01-01T00:00:00Z','2026-01-01T01:00:00Z',3600)",
        )
        .execute(&old)
        .await
        .unwrap();
        sqlx::query("INSERT INTO settings(key,value) VALUES('theme','light')")
            .execute(&old)
            .await
            .unwrap();
        old.close().await;

        // This is exactly what the next launch does.
        let upgraded = open_and_migrate(&path, false).await.unwrap();
        verify(&upgraded).await.unwrap();

        let games: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM games")
            .fetch_one(&upgraded)
            .await
            .unwrap();
        let tags: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM game_tags")
            .fetch_one(&upgraded)
            .await
            .unwrap();
        let sessions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM play_sessions")
            .fetch_one(&upgraded)
            .await
            .unwrap();
        let theme: String = sqlx::query_scalar("SELECT value FROM settings WHERE key='theme'")
            .fetch_one(&upgraded)
            .await
            .unwrap();
        let play_time: i64 = sqlx::query_scalar("SELECT play_time_seconds FROM games WHERE id=1")
            .fetch_one(&upgraded)
            .await
            .unwrap();
        assert_eq!((games, tags, sessions), (1, 1, 1), "upgrading must not drop rows");
        assert_eq!(theme, "light");
        assert_eq!(play_time, 3600);

        let versions: Vec<i64> =
            sqlx::query_scalar("SELECT version FROM _sqlx_migrations ORDER BY version")
                .fetch_all(&upgraded)
                .await
                .unwrap();
        let expected: Vec<i64> = super::super::migrations()
            .into_iter()
            .map(|migration| migration.version)
            .collect();
        assert_eq!(versions, expected, "every migration must be recorded");

        // The columns and tables the new features read must exist afterwards.
        let twodfan: Option<String> = sqlx::query_scalar("SELECT twodfan_id FROM games WHERE id=1")
            .fetch_one(&upgraded)
            .await
            .unwrap();
        assert_eq!(twodfan, None);
        for table in ["twodfan_topic_list", "twodfan_topic", "vndb_relation"] {
            let found: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?",
            )
            .bind(table)
            .fetch_one(&upgraded)
            .await
            .unwrap();
            assert_eq!(found, 1, "{table} must exist after the upgrade");
        }
        upgraded.close().await;

        // Reopening the upgraded file must be a no-op, not a second migration.
        let reopened = open_and_migrate(&path, false).await.unwrap();
        let games: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM games")
            .fetch_one(&reopened)
            .await
            .unwrap();
        assert_eq!(games, 1);
        reopened.close().await;
        cleanup(&root);
    }

    #[tokio::test]
    async fn a_library_migrated_by_a_newer_build_is_reported_in_words_not_sqlx_codes() {
        let root = fixture();
        let path = root.join("galgame.db");
        let db = open_and_migrate(&path, true).await.unwrap();
        // Pretend a future build applied a migration this binary has never seen.
        sqlx::query(
            "INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) \
             VALUES(999,'from the future',TRUE,x'00',0)",
        )
        .execute(&db)
        .await
        .unwrap();
        db.close().await;
        let failure = open_and_migrate(&path, false).await.unwrap_err();
        let message = failure.to_string();
        assert!(
            message.contains("更新版本") && message.contains("999"),
            "expected an actionable message, got: {message}"
        );
        // The refusal must not have touched the file.
        let retained = open_existing(&path).await.unwrap();
        let newest: i64 = sqlx::query_scalar("SELECT MAX(version) FROM _sqlx_migrations")
            .fetch_one(&retained)
            .await
            .unwrap();
        assert_eq!(newest, 999);
        retained.close().await;
        cleanup(&root);
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
