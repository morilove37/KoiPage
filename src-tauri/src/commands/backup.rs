//! Versioned complete backup archive and restart-time restore.

use super::{
    error::{CmdError, CmdResult},
    games::pool,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{
    SqlitePool,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
};
use std::{
    collections::HashSet,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};

const MAGIC: &[u8] = b"KOIPAGE-BACKUP-1\n";
const MAX_ARCHIVE: u64 = 1024 * 1024 * 1024;
const MAX_IMAGE: u64 = 32 * 1024 * 1024;
const STAGE: &str = ".koipage-restore";
fn error(e: impl std::fmt::Display) -> CmdError {
    CmdError(format!("完整备份：{e}"))
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn safe_entry(path: &str) -> bool {
    !path.is_empty()
        && !path.contains(['\\', ':'])
        && path
            .split('/')
            .all(|p| !p.is_empty() && p != "." && p != "..")
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Entry {
    path: String,
    source: Option<String>,
    size: u64,
    sha256: String,
}
#[derive(Serialize, Deserialize)]
struct Ready {
    database_sha256: String,
    rollback_sha256: String,
    assets: Vec<(PathBuf, String)>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    format_version: u32,
    app_version: String,
    schema_version: i64,
    created_at: String,
    pub games: i64,
    pub sessions: i64,
    pub assets: usize,
    entries: Vec<Entry>,
    #[serde(default)]
    pub archive_sha256: String,
}
impl Manifest {
    fn empty() -> Self {
        Self {
            format_version: 1,
            app_version: env!("CARGO_PKG_VERSION").into(),
            schema_version: 0,
            created_at: super::util::now_iso8601(),
            games: 0,
            sessions: 0,
            assets: 0,
            entries: vec![],
            archive_sha256: String::new(),
        }
    }
}
fn pack(manifest: &Manifest, payloads: &[Vec<u8>]) -> CmdResult<Vec<u8>> {
    let mut manifest = manifest.clone();
    if manifest.entries.is_empty() {
        manifest.entries = payloads
            .iter()
            .enumerate()
            .map(|(i, b)| Entry {
                path: if i == 0 {
                    "database.sqlite".into()
                } else {
                    format!("assets/{i}.img")
                },
                source: None,
                size: b.len() as u64,
                sha256: hash(b),
            })
            .collect();
    }
    let json = serde_json::to_vec(&manifest).map_err(error)?;
    let mut out = MAGIC.to_vec();
    out.extend_from_slice(&(json.len() as u64).to_le_bytes());
    out.extend_from_slice(&json);
    for p in payloads {
        out.extend_from_slice(p);
    }
    if out.len() as u64 > MAX_ARCHIVE {
        return Err(error("备份超过 1 GB 限制"));
    }
    Ok(out)
}
fn unpack(bytes: &[u8]) -> CmdResult<(Manifest, Vec<Vec<u8>>)> {
    let start = MAGIC.len() + 8;
    if bytes.len() < start || bytes.len() as u64 > MAX_ARCHIVE || !bytes.starts_with(MAGIC) {
        return Err(error("文件格式无效"));
    }
    let n = u64::from_le_bytes(bytes[MAGIC.len()..start].try_into().map_err(error)?) as usize;
    if n > 16 * 1024 * 1024 || n > bytes.len() - start {
        return Err(error("清单长度无效"));
    }
    let manifest: Manifest = serde_json::from_slice(&bytes[start..start + n]).map_err(error)?;
    if manifest.format_version != 1
        || manifest.schema_version
            > super::migrations()
                .iter()
                .map(|m| m.version)
                .max()
                .unwrap_or(0)
    {
        return Err(error("该备份由更新版本创建，请升级恋页后恢复"));
    }
    if manifest.entries.is_empty()
        || manifest.entries.len() > 100_000
        || manifest.entries[0].path != "database.sqlite"
        || manifest.assets != manifest.entries.len() - 1
    {
        return Err(error("清单计数无效"));
    }
    let mut seen = HashSet::new();
    let mut sources = HashSet::new();
    let mut offset = start + n;
    let mut payloads = vec![];
    for (i, entry) in manifest.entries.iter().enumerate() {
        if !safe_entry(&entry.path)
            || !seen.insert(&entry.path)
            || (i > 0
                && (!entry.path.starts_with("assets/")
                    || entry
                        .source
                        .as_ref()
                        .is_none_or(|s| s.is_empty() || !sources.insert(s))))
        {
            return Err(error("清单包含不安全或重复路径"));
        }
        let len = usize::try_from(entry.size).map_err(error)?;
        if len > bytes.len() - offset || (i > 0 && entry.size > MAX_IMAGE) {
            return Err(error("文件长度无效"));
        }
        let payload = &bytes[offset..offset + len];
        if hash(payload) != entry.sha256 {
            return Err(error(format!("校验失败：{}", entry.path)));
        }
        if i > 0 {
            validate_image(payload)?;
        }
        payloads.push(payload.to_vec());
        offset += len;
    }
    if offset != bytes.len() {
        return Err(error("归档包含额外数据"));
    }
    Ok((manifest, payloads))
}
fn validate_image(bytes: &[u8]) -> CmdResult<()> {
    let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .map_err(error)?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(16384);
    limits.max_image_height = Some(16384);
    limits.max_alloc = Some(256 * 1024 * 1024);
    reader.limits(limits);
    reader.decode().map_err(error)?;
    Ok(())
}
fn read_limited(path: &Path, limit: u64) -> CmdResult<Vec<u8>> {
    let f = fs::File::open(path).map_err(error)?;
    let mut b = vec![];
    f.take(limit + 1).read_to_end(&mut b).map_err(error)?;
    if b.len() as u64 > limit {
        return Err(error("文件超过大小限制"));
    }
    Ok(b)
}
fn write_sync(path: &Path, bytes: &[u8]) -> CmdResult<()> {
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(error)?;
    f.write_all(bytes).map_err(error)?;
    f.sync_all().map_err(error)
}
struct TempDir(PathBuf);
impl TempDir {
    fn new(root: &Path) -> CmdResult<Self> {
        fs::create_dir_all(root).map_err(error)?;
        let p = root.join(format!(
            ".backup-{}-{}",
            std::process::id(),
            time::OffsetDateTime::now_utc().unix_timestamp_nanos()
        ));
        fs::create_dir(&p).map_err(error)?;
        Ok(Self(p))
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
async fn open_db(path: &Path) -> CmdResult<SqlitePool> {
    Ok(SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(path)
                .read_only(false)
                .create_if_missing(false)
                .pragma("trusted_schema", "OFF"),
        )
        .await?)
}
async fn schema(db: &SqlitePool) -> CmdResult<i64> {
    let exists: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE name='_sqlx_migrations'")
            .fetch_one(db)
            .await?;
    if exists == 0 {
        return Ok(0);
    }
    Ok(
        sqlx::query_scalar("SELECT COALESCE(MAX(version),0) FROM _sqlx_migrations WHERE success=1")
            .fetch_one(db)
            .await?,
    )
}
async fn references(db: &SqlitePool) -> CmdResult<Vec<String>> {
    let mut paths: Vec<Option<String>> = sqlx::query_scalar("SELECT cover_path FROM games")
        .fetch_all(db)
        .await?;
    let exists: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE name='birthday_characters'")
            .fetch_one(db)
            .await?;
    if exists > 0 {
        paths.extend(sqlx::query_scalar::<_,Option<String>>("SELECT avatar_path FROM birthday_characters UNION SELECT override_avatar FROM birthday_characters").fetch_all(db).await?);
    }
    paths.extend(
        sqlx::query_scalar::<_, Option<String>>(
            "SELECT value FROM settings WHERE key='background_image_path'",
        )
        .fetch_all(db)
        .await?,
    );
    let custom: Vec<String> =
        sqlx::query_scalar("SELECT value FROM settings WHERE key GLOB 'game_cover:*'")
            .fetch_all(db)
            .await?;
    for value in custom {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&value) {
            if let Some(path) = value
                .get("customPath")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|v| !v.is_empty())
            {
                paths.push(Some(path.into()));
            }
        }
    }
    let mut set = HashSet::new();
    Ok(paths
        .into_iter()
        .flatten()
        .filter(|s| !s.trim().is_empty() && set.insert(s.clone()))
        .collect())
}
async fn create_archive(db: &SqlitePool, dest: &Path, temp_root: &Path) -> CmdResult<Manifest> {
    let tmp = TempDir::new(temp_root)?;
    let snapshot = tmp.0.join("database.sqlite");
    sqlx::query("VACUUM INTO ?")
        .bind(snapshot.to_string_lossy().as_ref())
        .execute(db)
        .await?;
    let snap = open_db(&snapshot).await?;
    let result = async {
        let mut m = Manifest::empty();
        m.schema_version = schema(&snap).await?;
        m.games = sqlx::query_scalar("SELECT COUNT(*) FROM games")
            .fetch_one(&snap)
            .await?;
        m.sessions = sqlx::query_scalar("SELECT COUNT(*) FROM play_sessions")
            .fetch_one(&snap)
            .await?;
        let paths = references(&snap).await?;
        let mut payloads = vec![read_limited(&snapshot, MAX_ARCHIVE)?];
        m.entries.push(Entry {
            path: "database.sqlite".into(),
            source: None,
            size: payloads[0].len() as u64,
            sha256: hash(&payloads[0]),
        });
        let mut total = payloads[0].len() as u64;
        for source in paths {
            if source.starts_with("http:") || source.starts_with("https:") {
                return Err(error(format!(
                    "图片尚未保存在本地：{source}，请先重新匹配封面"
                )));
            }
            let b = read_limited(Path::new(&source), MAX_IMAGE)
                .map_err(|e| error(format!("无法备份引用图片 {source}：{e}")))?;
            validate_image(&b)?;
            total += b.len() as u64;
            if total > MAX_ARCHIVE {
                return Err(error("备份超过 1 GB 限制"));
            }
            let extension = image::guess_format(&b).map_err(error)?.extensions_str()[0];
            m.entries.push(Entry {
                path: format!("assets/{}.{extension}", m.entries.len()),
                source: Some(source),
                size: b.len() as u64,
                sha256: hash(&b),
            });
            payloads.push(b);
        }
        m.assets = payloads.len() - 1;
        let bytes = pack(&m, &payloads)?;
        let output = tmp.0.join("archive.partial");
        write_sync(&output, &bytes)?;
        // Refuse overwriting an existing export, including a database path.
        let mut destination = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(dest)
            .map_err(error)?;
        if let Err(e) = destination
            .write_all(&bytes)
            .and_then(|_| destination.sync_all())
        {
            drop(destination);
            let _ = fs::remove_file(dest);
            return Err(error(e));
        }
        Ok(m)
    }
    .await;
    snap.close().await;
    result
}
async fn validate_database(path: &Path, m: &Manifest) -> CmdResult<()> {
    let db = open_db(path).await?;
    let result = async {
        let unsafe_schema: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master WHERE type IN ('trigger','view')",
        )
        .fetch_one(&db)
        .await?;
        if unsafe_schema > 0 {
            return Err(error("备份包含不受支持的数据库触发器或视图"));
        }
        for name in [
            "games",
            "tags",
            "game_tags",
            "play_sessions",
            "settings",
            "scan_roots",
        ] {
            let count: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?",
            )
            .bind(name)
            .fetch_one(&db)
            .await?;
            if count != 1 {
                return Err(error(format!("备份缺少必要数据表：{name}")));
            }
        }
        if m.schema_version > 0 {
            let applied: Vec<(i64, Vec<u8>, bool)> = sqlx::query_as(
                "SELECT version,checksum,success FROM _sqlx_migrations ORDER BY version",
            )
            .fetch_all(&db)
            .await?;
            for (version, checksum, success) in applied {
                let migration = super::migrations()
                    .into_iter()
                    .find(|x| x.version == version)
                    .ok_or_else(|| error("未知数据库迁移"))?;
                if !success
                    || checksum.as_slice()
                        != sha2::Sha384::digest(migration.sql.as_bytes()).as_slice()
                {
                    return Err(error("数据库迁移校验失败"));
                }
            }
        }
        let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
            .fetch_one(&db)
            .await?;
        if integrity != "ok" {
            return Err(error("数据库完整性检查失败"));
        }
        if !sqlx::query("PRAGMA foreign_key_check")
            .fetch_all(&db)
            .await?
            .is_empty()
        {
            return Err(error("数据库外键检查失败"));
        }
        let games: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM games")
            .fetch_one(&db)
            .await?;
        let sessions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM play_sessions")
            .fetch_one(&db)
            .await?;
        if games != m.games || sessions != m.sessions || schema(&db).await? != m.schema_version {
            return Err(error("数据库版本或计数与清单不符"));
        }
        let expected: HashSet<String> = m.entries.iter().filter_map(|e| e.source.clone()).collect();
        if references(&db).await?.into_iter().collect::<HashSet<_>>() != expected {
            return Err(error("数据库引用的图片与清单不符"));
        }
        Ok(())
    }
    .await;
    db.close().await;
    result
}
async fn inspect(path: &Path, temp_root: &Path) -> CmdResult<(Manifest, Vec<Vec<u8>>)> {
    let bytes = read_limited(path, MAX_ARCHIVE)?;
    let (mut m, p) = unpack(&bytes)?;
    m.archive_sha256 = hash(&bytes);
    let tmp = TempDir::new(temp_root)?;
    let db = tmp.0.join("check.sqlite");
    write_sync(&db, &p[0])?;
    validate_database(&db, &m).await?;
    Ok((m, p))
}
fn ensure_idle(app: &AppHandle) -> CmdResult<()> {
    if !app
        .state::<crate::launcher::RunningGames>()
        .0
        .lock()
        .map_err(error)?
        .is_empty()
    {
        return Err(error("请先结束所有正在运行的游戏"));
    }
    Ok(())
}
#[tauri::command]
pub async fn backup_create(app: AppHandle, path: String) -> CmdResult<Manifest> {
    let running = app.state::<crate::launcher::RunningGames>();
    let _guard = running.1.lock().await;
    ensure_idle(&app)?;
    create_archive(
        &pool(&app).await?,
        Path::new(&path),
        &app.path().app_config_dir()?,
    )
    .await
}
#[tauri::command]
pub async fn backup_preview(app: AppHandle, path: String) -> CmdResult<Manifest> {
    Ok(inspect(Path::new(&path), &app.path().app_config_dir()?)
        .await?
        .0)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestorePrepared {
    safety_backup: String,
    restart_required: bool,
}
#[tauri::command]
pub async fn backup_restore_prepare(
    app: AppHandle,
    path: String,
    confirmed: bool,
    expected_sha256: String,
) -> CmdResult<RestorePrepared> {
    if !confirmed {
        return Err(error("恢复前必须明确确认"));
    }
    let running = app.state::<crate::launcher::RunningGames>();
    let _guard = running.1.lock().await;
    ensure_idle(&app)?;
    let config = app.path().app_config_dir()?;
    let stage = config.join(STAGE);
    if stage.exists() {
        return Err(error("已有待恢复数据，请先完全退出并重新打开恋页"));
    }
    let bytes = read_limited(Path::new(&path), MAX_ARCHIVE)?;
    if hash(&bytes) != expected_sha256 {
        return Err(error("备份文件在预览后已改变，请重新预览"));
    }
    let (m, p) = unpack(&bytes)?;
    let validation = TempDir::new(&config)?;
    let check = validation.0.join("check.sqlite");
    write_sync(&check, &p[0])?;
    validate_database(&check, &m).await?;
    let safety = config.join(format!(
        "before-restore-{}.koibak",
        time::OffsetDateTime::now_utc().unix_timestamp_nanos()
    ));
    create_archive(&pool(&app).await?, &safety, &config).await?;
    let (_, current) = unpack(&read_limited(&safety, MAX_ARCHIVE)?)?;
    stage_restore(
        &config,
        &app.path().app_data_dir()?.join("restored-assets"),
        &m,
        &p,
        &current[0],
    )
    .await?;
    Ok(RestorePrepared {
        safety_backup: safety.to_string_lossy().into(),
        restart_required: true,
    })
}
async fn stage_restore(
    config: &Path,
    asset_base: &Path,
    m: &Manifest,
    p: &[Vec<u8>],
    rollback: &[u8],
) -> CmdResult<()> {
    let stage = config.join(STAGE);
    if stage.exists() {
        return Err(error("已有待恢复数据"));
    }
    let tmp = TempDir::new(config)?;
    let next = tmp.0.join("database.next");
    write_sync(&next, &p[0])?;
    write_sync(&tmp.0.join("rollback.sqlite"), rollback)?;
    let asset_root = asset_base.join(
        time::OffsetDateTime::now_utc()
            .unix_timestamp_nanos()
            .to_string(),
    );
    fs::create_dir_all(&asset_root).map_err(error)?;
    let db = open_db(&next).await?;
    let mut staged_assets = vec![];
    let result = async {
        let mut tx = db.begin().await?;
        for (i, entry) in m.entries.iter().enumerate().skip(1) {
            let dest = asset_root.join(
                Path::new(&entry.path)
                    .file_name()
                    .ok_or_else(|| error("图片文件名无效"))?,
            );
            write_sync(&dest, &p[i])?;
            staged_assets.push((dest.clone(), entry.sha256.clone()));
            let source = entry.source.as_ref().ok_or_else(|| error("图片引用缺失"))?;
            let dest = dest.to_string_lossy();
            sqlx::query("UPDATE games SET cover_path=? WHERE cover_path=?")
                .bind(dest.as_ref())
                .bind(source)
                .execute(&mut *tx)
                .await?;
            let exists: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM sqlite_master WHERE name='birthday_characters'",
            )
            .fetch_one(&mut *tx)
            .await?;
            if exists > 0 {
                for column in ["avatar_path", "override_avatar"] {
                    sqlx::query(&format!(
                        "UPDATE birthday_characters SET {column}=? WHERE {column}=?"
                    ))
                    .bind(dest.as_ref())
                    .bind(source)
                    .execute(&mut *tx)
                    .await?;
                }
            }
            sqlx::query(
                "UPDATE settings SET value=? WHERE key='background_image_path' AND value=?",
            )
            .bind(dest.as_ref())
            .bind(source)
            .execute(&mut *tx)
            .await?;
            let prefs: Vec<(String, String)> =
                sqlx::query_as("SELECT key,value FROM settings WHERE key GLOB 'game_cover:*'")
                    .fetch_all(&mut *tx)
                    .await?;
            for (key, value) in prefs {
                if let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&value) {
                    let mut changed = false;
                    if value
                        .get("customPath")
                        .and_then(|v| v.as_str())
                        .map(str::trim)
                        == Some(source.as_str())
                    {
                        value["customPath"] = serde_json::Value::String(dest.to_string());
                        changed = true;
                    }
                    // Crop coordinates belong to this image's identity. Restored
                    // images move together with their source/custom cover paths.
                    if value
                        .get("crop")
                        .and_then(|v| v.get("path"))
                        .and_then(|v| v.as_str())
                        == Some(source.as_str())
                    {
                        value["crop"]["path"] = serde_json::Value::String(dest.to_string());
                        changed = true;
                    }
                    if changed {
                        sqlx::query("UPDATE settings SET value=? WHERE key=?")
                            .bind(value.to_string())
                            .bind(key)
                            .execute(&mut *tx)
                            .await?;
                    }
                }
            }
        }
        tx.commit().await?;
        Ok::<_, CmdError>(())
    }
    .await;
    db.close().await;
    if let Err(e) = result {
        let _ = fs::remove_dir_all(&asset_root);
        return Err(e);
    }
    fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&next)
        .map_err(error)?
        .sync_all()
        .map_err(error)?;
    let ready = Ready {
        database_sha256: hash(&read_limited(&next, MAX_ARCHIVE)?),
        rollback_sha256: hash(rollback),
        assets: staged_assets,
    };
    write_sync(
        &tmp.0.join("ready"),
        &serde_json::to_vec(&ready).map_err(error)?,
    )?;
    publish_stage_directory(&tmp.0, &stage).map_err(error)?;
    Ok(())
}

/// Apply before the SQL plugin opens any connection. Persistent stage files make
/// each interrupted rename safe to retry; the old database is retained on disk.
fn publish_stage_directory(from: &Path, to: &Path) -> std::io::Result<()> {
    match fs::rename(from, to) {
        Ok(()) => return Ok(()),
        Err(e) if cfg!(windows) && e.raw_os_error() == Some(17) => {}
        Err(e) => return Err(e),
    }
    // Only backup-owned flat staging directories use this fallback. A copy is
    // not atomic: publish ready last, after every payload has been flushed.
    // Until ready exists, startup ignores and cleans an interrupted publication.
    fs::create_dir(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        if entry.file_name() == "ready" {
            continue;
        }
        if !entry.file_type()?.is_file() {
            return Err(std::io::Error::other(
                "backup stage must contain only regular files",
            ));
        }
        let dest = to.join(entry.file_name());
        fs::copy(entry.path(), &dest)?;
        fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(dest)?
            .sync_all()?;
    }
    let ready = fs::read(from.join("ready"))?;
    write_sync(&to.join("ready"), &ready).map_err(std::io::Error::other)?;
    // Disable replay in the old stage before cleanup. Once published, cleanup
    // failure is harmless; an unready fixed stage is removed on next startup.
    fs::remove_file(from.join("ready"))?;
    let _ = fs::remove_dir_all(from);
    Ok(())
}
pub fn apply_pending(config: &Path) -> CmdResult<()> {
    let stage = config.join(STAGE);
    if !stage.join("ready").is_file() {
        if stage.is_dir() {
            fs::remove_dir_all(&stage).map_err(error)?;
        }
        return Ok(());
    }
    let target = config.join("galgame.db");
    let next = stage.join("database.next");
    let old = stage.join("database.previous");
    let ready: Ready =
        serde_json::from_slice(&read_limited(&stage.join("ready"), 16 * 1024 * 1024)?)
            .map_err(error)?;
    let validated = (|| {
        if hash(&read_limited(&stage.join("rollback.sqlite"), MAX_ARCHIVE)?)
            != ready.rollback_sha256
        {
            return Err(error("回退快照校验失败"));
        }
        for (path, sha) in &ready.assets {
            let bytes = read_limited(path, MAX_IMAGE)?;
            if hash(&bytes) != *sha {
                return Err(error("待恢复图片校验失败"));
            }
            validate_image(&bytes)?;
        }
        if next.exists() && hash(&read_limited(&next, MAX_ARCHIVE)?) != ready.database_sha256 {
            return Err(error("待恢复数据库校验失败，原数据库未改变"));
        }
        if !next.exists()
            && target.is_file()
            && hash(&read_limited(&target, MAX_ARCHIVE)?) != ready.database_sha256
        {
            return Err(error("恢复后的数据库校验失败"));
        }
        Ok(())
    })();
    if let Err(e) = validated {
        if !target.exists()
            && hash(&read_limited(&stage.join("rollback.sqlite"), MAX_ARCHIVE)?)
                == ready.rollback_sha256
        {
            for suffix in ["-wal", "-shm"] {
                let p = config.join(format!("galgame.db{suffix}"));
                if p.exists() {
                    fs::remove_file(p).map_err(error)?;
                }
            }
            fs::copy(stage.join("rollback.sqlite"), &target).map_err(error)?;
        }
        return Err(e);
    }
    if next.exists() {
        if !old.exists() && target.exists() {
            crate::file_ops::rename(&target, &old).map_err(error)?;
        }
        for suffix in ["-wal", "-shm"] {
            let p = config.join(format!("galgame.db{suffix}"));
            if p.exists() {
                crate::file_ops::rename(p, stage.join(format!("database.previous{suffix}")))
                    .map_err(error)?;
            }
        }
        if let Err(e) = crate::file_ops::rename(&next, &target) {
            if !target.exists() {
                fs::copy(stage.join("rollback.sqlite"), &target).map_err(error)?;
            }
            return Err(error(e));
        }
    } else if !target.exists() {
        if stage.join("rollback.sqlite").is_file() {
            fs::copy(stage.join("rollback.sqlite"), &target).map_err(error)?;
        }
        return Err(error("恢复文件缺失，已保留原数据库"));
    }
    // Keep the previous DB for manual recovery, but stop replaying on startup.
    let completed = config.join(format!(
        "restore-completed-{}",
        time::OffsetDateTime::now_utc().unix_timestamp_nanos()
    ));
    publish_stage_directory(&stage, &completed).map_err(error)?;
    Ok(())
}
/// A failed pending restore must not trap the user in a startup error loop.
/// Retire it and retain the original DB, using the consistent rollback snapshot
/// whenever swapping had begun. Never rely on a raw DB missing its WAL.
fn recover_failed_restore(config: &Path) -> CmdResult<()> {
    let stage = config.join(STAGE);
    let target = config.join("galgame.db");
    if stage.join("database.previous").exists() || !target.is_file() {
        let ready: Ready =
            serde_json::from_slice(&read_limited(&stage.join("ready"), 16 * 1024 * 1024)?)
                .map_err(error)?;
        let bytes = read_limited(&stage.join("rollback.sqlite"), MAX_ARCHIVE)?;
        if hash(&bytes) != ready.rollback_sha256 {
            return Err(error("无法验证回退快照；已停止启动以保留现有数据"));
        }
        let replacement = stage.join("rollback.apply");
        if replacement.exists() {
            fs::remove_file(&replacement).map_err(error)?;
        }
        write_sync(&replacement, &bytes)?;
        if target.exists() {
            crate::file_ops::rename(
                &target,
                stage.join(format!(
                    "database.rejected-{}",
                    time::OffsetDateTime::now_utc().unix_timestamp_nanos()
                )),
            )
            .map_err(error)?;
        }
        for suffix in ["-wal", "-shm"] {
            let sidecar = config.join(format!("galgame.db{suffix}"));
            if sidecar.exists() {
                crate::file_ops::rename(sidecar, stage.join(format!("database.rejected{suffix}")))
                    .map_err(error)?;
            }
        }
        crate::file_ops::rename(replacement, &target).map_err(error)?;
    }
    if !target.is_file() {
        return Err(error("无法回退恢复：原数据库不可用"));
    }
    let failed = config.join(format!(
        "restore-failed-{}",
        time::OffsetDateTime::now_utc().unix_timestamp_nanos()
    ));
    publish_stage_directory(&stage, &failed).map_err(error)?;
    Ok(())
}
pub fn restore_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("backup-restore")
        .setup(|app, _| {
            let config=app.path().app_config_dir()?;
            let had_pending=config.join(STAGE).join("ready").is_file();
            if let Err(failure)=apply_pending(&config) {
                recover_failed_restore(&config)?;
                crate::app_warn!("[backup-restore] Restore failed; original data retained: {failure}");
                let notice=config.join("restore-failure.txt");
                let _=fs::write(notice,format!("恢复失败，已自动保留原有数据：{failure}\n安全备份及失败暂存文件保留在应用配置目录。"));
            } else if had_pending {
                let _=fs::remove_file(config.join("restore-failure.txt"));
            }
            Ok(())
        })
        .build()
}
#[tauri::command]
pub fn backup_restore_notice(app: AppHandle) -> CmdResult<Option<String>> {
    let path = app.path().app_config_dir()?.join("restore-failure.txt");
    if !path.is_file() {
        return Ok(None);
    }
    Ok(Some(
        String::from_utf8_lossy(&read_limited(&path, 64 * 1024)?).into_owned(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn test_root() -> PathBuf {
        std::env::var_os("KOIPAGE_TEST_ENCRYPTED_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir)
    }
    #[test]
    fn startup_discards_only_unpublished_task_owned_stage() {
        let tmp = TempDir::new(&test_root()).unwrap();
        let stage = tmp.0.join(STAGE);
        fs::create_dir(&stage).unwrap();
        fs::write(stage.join("database.next"), b"partial").unwrap();
        fs::write(tmp.0.join("galgame.db"), b"unchanged original").unwrap();
        apply_pending(&tmp.0).unwrap();
        assert!(!stage.exists());
        assert_eq!(
            fs::read(tmp.0.join("galgame.db")).unwrap(),
            b"unchanged original"
        );
    }
    #[tokio::test]
    async fn interrupted_copy_to_live_database_is_retried_from_verified_source() {
        let tmp = TempDir::new(&test_root()).unwrap();
        let db = fixture(&tmp.0).await;
        let archive = tmp.0.join("complete.koibak");
        create_archive(&db, &archive, &tmp.0).await.unwrap();
        let (m, p) = inspect(&archive, &tmp.0).await.unwrap();
        stage_restore(&tmp.0, &tmp.0.join("assets"), &m, &p, &p[0])
            .await
            .unwrap();
        db.close().await;
        crate::file_ops::rename(
            tmp.0.join("galgame.db"),
            tmp.0.join(STAGE).join("database.previous"),
        )
        .unwrap();
        fs::write(tmp.0.join("galgame.db"), b"partial interrupted native copy").unwrap();
        apply_pending(&tmp.0).unwrap();
        let restored = open_db(&tmp.0.join("galgame.db")).await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT title FROM games")
                .fetch_one(&restored)
                .await
                .unwrap(),
            "Original"
        );
        restored.close().await;
    }
    #[test]
    fn archive_rejects_traversal_and_corrupt_payloads() {
        assert!(!safe_entry("../database.sqlite"));
        assert!(!safe_entry("assets\\evil"));
        assert!(!safe_entry("C:/evil"));
        assert!(safe_entry("assets/0.png"));
        let mut bytes = pack(&Manifest::empty(), &[b"SQLite payload".to_vec()]).unwrap();
        assert!(unpack(&bytes).is_ok());
        *bytes.last_mut().unwrap() ^= 1;
        assert!(unpack(&bytes).is_err());
        let mut future = Manifest::empty();
        future.schema_version = i64::MAX;
        assert!(unpack(&pack(&future, &[vec![1]]).unwrap()).is_err());
    }
    async fn fixture(root: &Path) -> SqlitePool {
        let path = root.join("galgame.db");
        fs::File::create(&path).unwrap();
        let db = open_db(&path).await.unwrap();
        sqlx::raw_sql(include_str!("../../migrations/0001_init.sql"))
            .execute(&db)
            .await
            .unwrap();
        sqlx::raw_sql(include_str!("../../migrations/0003_birthdays.sql"))
            .execute(&db)
            .await
            .unwrap();
        let img = root.join("original.png");
        image::RgbaImage::new(2, 2).save(&img).unwrap();
        let img = img.to_string_lossy().into_owned();
        sqlx::query("INSERT INTO games(id,title,install_path,cover_path,created_at,updated_at) VALUES(7,'Original','D:/Game',?,'now','now')").bind(&img).execute(&db).await.unwrap();
        sqlx::query("INSERT INTO settings(key,value) VALUES('background_image_path',?)")
            .bind(&img)
            .execute(&db)
            .await
            .unwrap();
        let custom = root.join("custom.png");
        image::RgbaImage::new(3, 3).save(&custom).unwrap();
        sqlx::query("INSERT INTO settings(key,value) VALUES('game_cover:7',?)")
            .bind(
                serde_json::json!({"customPath":custom.to_string_lossy(),"censored":true,
                    "crop":{"path":custom.to_string_lossy(),"x":0.25,"y":0.1,"width":0.3,"height":0.4}})
                    .to_string(),
            )
            .execute(&db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO settings(key,value) VALUES('game_cover:8',?)")
            .bind(
                serde_json::json!({"customPath":null,"censored":false,
                "crop":{"path":img,"x":0.2,"y":0.1,"width":0.3,"height":0.4}})
                .to_string(),
            )
            .execute(&db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO birthday_characters(id,source,external_id,name,avatar_path,override_avatar) VALUES('c1','vndb','c1','Character',?,?)").bind(&img).bind(&img).execute(&db).await.unwrap();
        db
    }
    #[tokio::test]
    async fn full_backup_restores_snapshot_and_remaps_every_image_reference() {
        let tmp = TempDir::new(&test_root()).unwrap();
        let db = fixture(&tmp.0).await;
        sqlx::query("PRAGMA journal_mode=WAL")
            .execute(&db)
            .await
            .unwrap();
        let archive = tmp.0.join("complete.koibak");
        let manifest = create_archive(&db, &archive, &tmp.0).await.unwrap();
        assert_eq!((manifest.games, manifest.assets), (1, 2));
        let (m, p) = inspect(&archive, &tmp.0).await.unwrap();
        sqlx::query("UPDATE games SET title='Changed'")
            .execute(&db)
            .await
            .unwrap();
        stage_restore(&tmp.0, &tmp.0.join("restored-assets"), &m, &p, &p[0])
            .await
            .unwrap();
        // The live DB remains untouched until all connections are closed.
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT title FROM games")
                .fetch_one(&db)
                .await
                .unwrap(),
            "Changed"
        );
        db.close().await;
        apply_pending(&tmp.0).unwrap();
        apply_pending(&tmp.0).unwrap();
        let restored = open_db(&tmp.0.join("galgame.db")).await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT title FROM games")
                .fetch_one(&restored)
                .await
                .unwrap(),
            "Original"
        );
        let refs = references(&restored).await.unwrap();
        assert_eq!(refs.len(), 2);
        assert!(Path::new(&refs[0]).is_file());
        assert!(refs[0].contains("restored-assets"));
        let prefs: String =
            sqlx::query_scalar("SELECT value FROM settings WHERE key='game_cover:7'")
                .fetch_one(&restored)
                .await
                .unwrap();
        let prefs: serde_json::Value = serde_json::from_str(&prefs).unwrap();
        assert_eq!(prefs["censored"], true);
        assert_eq!(prefs["crop"]["path"], prefs["customPath"]);
        assert_eq!(prefs["crop"]["x"], 0.25);
        assert_eq!(prefs["crop"]["width"], 0.3);
        assert!(
            prefs["customPath"]
                .as_str()
                .unwrap()
                .contains("restored-assets")
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT override_avatar FROM birthday_characters")
                .fetch_one(&restored)
                .await
                .unwrap(),
            refs[0]
        );
        let source_prefs: String =
            sqlx::query_scalar("SELECT value FROM settings WHERE key='game_cover:8'")
                .fetch_one(&restored)
                .await
                .unwrap();
        let source_prefs: serde_json::Value = serde_json::from_str(&source_prefs).unwrap();
        assert_eq!(source_prefs["crop"]["path"], refs[0]);
        assert_eq!(source_prefs["crop"]["x"], 0.2);
        assert_eq!(source_prefs["crop"]["height"], 0.4);
        restored.close().await;
    }
    #[tokio::test]
    async fn startup_resumes_after_old_database_rename_and_rejects_tampering() {
        let tmp = TempDir::new(&test_root()).unwrap();
        let db = fixture(&tmp.0).await;
        let archive = tmp.0.join("complete.koibak");
        create_archive(&db, &archive, &tmp.0).await.unwrap();
        let (m, p) = inspect(&archive, &tmp.0).await.unwrap();
        stage_restore(&tmp.0, &tmp.0.join("assets"), &m, &p, &p[0])
            .await
            .unwrap();
        db.close().await;
        let next = tmp.0.join(STAGE).join("database.next");
        let good = fs::read(&next).unwrap();
        fs::write(&next, b"broken").unwrap();
        assert!(apply_pending(&tmp.0).is_err());
        assert!(tmp.0.join("galgame.db").is_file());
        fs::write(&next, good).unwrap();
        crate::file_ops::rename(
            tmp.0.join("galgame.db"),
            tmp.0.join(STAGE).join("database.previous"),
        )
        .unwrap();
        apply_pending(&tmp.0).unwrap();
        assert!(tmp.0.join("galgame.db").is_file());
    }
    #[tokio::test]
    async fn startup_rejects_missing_restored_assets_before_touching_live_database() {
        let tmp = TempDir::new(&test_root()).unwrap();
        let db = fixture(&tmp.0).await;
        let archive = tmp.0.join("complete.koibak");
        create_archive(&db, &archive, &tmp.0).await.unwrap();
        let (m, p) = inspect(&archive, &tmp.0).await.unwrap();
        let assets = tmp.0.join("assets");
        stage_restore(&tmp.0, &assets, &m, &p, &p[0]).await.unwrap();
        db.close().await;
        let folder = fs::read_dir(&assets)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let image = fs::read_dir(folder)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        fs::remove_file(image).unwrap();
        assert!(apply_pending(&tmp.0).is_err());
        assert!(tmp.0.join("galgame.db").is_file());
        assert!(!tmp.0.join(STAGE).join("database.previous").exists());
        recover_failed_restore(&tmp.0).unwrap();
        assert!(!tmp.0.join(STAGE).exists());
        let original = open_db(&tmp.0.join("galgame.db")).await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT title FROM games")
                .fetch_one(&original)
                .await
                .unwrap(),
            "Original"
        );
        original.close().await;
    }
    #[tokio::test]
    async fn interrupted_restore_rolls_back_from_consistent_snapshot_not_raw_wal_database() {
        let tmp = TempDir::new(&test_root()).unwrap();
        let db = fixture(&tmp.0).await;
        sqlx::query("PRAGMA journal_mode=WAL")
            .execute(&db)
            .await
            .unwrap();
        let archive = tmp.0.join("complete.koibak");
        create_archive(&db, &archive, &tmp.0).await.unwrap();
        let (m, p) = inspect(&archive, &tmp.0).await.unwrap();
        sqlx::query("UPDATE games SET title='Latest committed WAL data'")
            .execute(&db)
            .await
            .unwrap();
        let rollback = tmp.0.join("safety.sqlite");
        sqlx::query("VACUUM INTO ?")
            .bind(rollback.to_string_lossy().as_ref())
            .execute(&db)
            .await
            .unwrap();
        let rollback = fs::read(rollback).unwrap();
        stage_restore(&tmp.0, &tmp.0.join("assets"), &m, &p, &rollback)
            .await
            .unwrap();
        db.close().await;
        let stage = tmp.0.join(STAGE);
        crate::file_ops::rename(tmp.0.join("galgame.db"), stage.join("database.previous")).unwrap();
        fs::write(
            stage.join("database.previous"),
            b"raw database incomplete without WAL",
        )
        .unwrap();
        fs::remove_file(stage.join("database.next")).unwrap();
        assert!(apply_pending(&tmp.0).is_err());
        let restored = open_db(&tmp.0.join("galgame.db")).await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT title FROM games")
                .fetch_one(&restored)
                .await
                .unwrap(),
            "Latest committed WAL data"
        );
        restored.close().await;
    }
    #[tokio::test]
    async fn missing_images_abort_without_creating_incomplete_backup() {
        let tmp = TempDir::new(&test_root()).unwrap();
        let db = fixture(&tmp.0).await;
        fs::remove_file(tmp.0.join("original.png")).unwrap();
        let archive = tmp.0.join("bad.koibak");
        assert!(create_archive(&db, &archive, &tmp.0).await.is_err());
        assert!(!archive.exists());
        db.close().await;
    }
    #[tokio::test]
    async fn preview_rejects_invalid_sqlite_and_manifest_count_mismatch() {
        let tmp = TempDir::new(&test_root()).unwrap();
        let archive = tmp.0.join("broken.koibak");
        fs::write(
            &archive,
            pack(&Manifest::empty(), &[b"not SQLite".to_vec()]).unwrap(),
        )
        .unwrap();
        assert!(inspect(&archive, &tmp.0).await.is_err());
        let db = fixture(&tmp.0).await;
        let good = tmp.0.join("good.koibak");
        create_archive(&db, &good, &tmp.0).await.unwrap();
        let (mut m, p) = unpack(&fs::read(&good).unwrap()).unwrap();
        m.games = 100;
        fs::write(&archive, pack(&m, &p).unwrap()).unwrap();
        assert!(inspect(&archive, &tmp.0).await.is_err());
        db.close().await;
    }
}
