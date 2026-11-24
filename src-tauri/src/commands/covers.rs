use super::error::{CmdError, CmdResult};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const MAX_COVER: usize = 20 * 1024 * 1024;
/// Long edge of the thumbnails used by list and card views.
const THUMB_SIZE: u32 = 320;
const THUMB_DIRECTORY: &str = "thumbs";
/// Remembers the last reference set so an unchanged library skips the copy pass.
const FINGERPRINT_KEY: &str = "covers_migrate_fingerprint";

/// Serialises temporary file names for concurrent writers.
static TEMPORARY: AtomicU64 = AtomicU64::new(0);

#[derive(Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationReport {
    pub copied: usize,
    pub already_managed: usize,
    pub missing: usize,
    pub failed: usize,
    /// True when the stored fingerprint matched and no reference was rescanned.
    pub skipped: bool,
}

pub(crate) fn directory(app: &tauri::AppHandle) -> CmdResult<PathBuf> {
    Ok(super::resource_storage::root(app)?.join("covers"))
}

fn is_managed(path: &str, directory: &Path) -> bool {
    let Ok(path) = Path::new(path).canonicalize() else {
        return false;
    };
    let roots = [
        directory.to_path_buf(),
        directory
            .parent()
            .unwrap_or(directory)
            .join("custom-covers"),
    ];
    roots
        .iter()
        .any(|root| root.canonicalize().is_ok_and(|root| path.starts_with(root)))
}

/// Directory holding the downscaled copies used by list and card views.
fn thumbnail_directory(directory: &Path) -> PathBuf {
    directory.join(THUMB_DIRECTORY)
}

/// `covers/<sha>.png` -> `covers/thumbs/<sha>.jpg`. Only managed covers have
/// thumbnails, so any other path returns `None` and callers keep the original.
fn thumbnail_path(directory: &Path, original: &Path) -> Option<PathBuf> {
    if original.parent()? != directory {
        return None;
    }
    let stem = original.file_stem()?;
    Some(thumbnail_directory(directory).join(stem).with_extension("jpg"))
}

/// Write a 320px thumbnail beside the stored cover. Best effort: a failure is
/// logged and the full-size original still renders, so it never blocks a save.
fn ensure_thumbnail(directory: &Path, original: &Path, bytes: &[u8]) {
    let Some(target) = thumbnail_path(directory, original) else {
        return;
    };
    if target.is_file() {
        return;
    }
    if let Err(error) = write_thumbnail(&target, bytes) {
        crate::app_warn!("[covers] could not build a thumbnail for {}: {error}", original.display());
    }
}

fn write_thumbnail(target: &Path, bytes: &[u8]) -> CmdResult<()> {
    let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|error| CmdError(format!("无法识别封面图片格式：{error}")))?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(10000);
    limits.max_image_height = Some(10000);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    let image = reader
        .decode()
        .map_err(|error| CmdError(format!("封面图片损坏或尺寸过大：{error}")))?;
    // `thumbnail` keeps the aspect ratio and only shrinks, so small covers are
    // copied at their own size instead of being blown up.
    // JPEG at quality 82 measured ~25 KB per card against ~132 KB for the
    // lossless WebP this used to write, and covers carry no transparency.
    let small = image.thumbnail(THUMB_SIZE, THUMB_SIZE).to_rgb8();
    let mut encoded = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut encoded, 82)
        .encode(
            small.as_raw(),
            small.width(),
            small.height(),
            image::ExtendedColorType::Rgb8,
        )
        .map_err(|error| CmdError(format!("无法生成封面缩略图：{error}")))?;
    let parent = target.parent().unwrap_or(target);
    std::fs::create_dir_all(parent).map_err(|error| CmdError(format!("无法创建缩略图目录：{error}")))?;
    let temporary = parent.join(format!(
        ".thumb-{}-{}.tmp",
        std::process::id(),
        TEMPORARY.fetch_add(1, Ordering::Relaxed)
    ));
    let result = std::fs::write(&temporary, &encoded)
        .and_then(|_| crate::file_ops::rename(&temporary, target));
    if let Err(error) = result {
        let _ = std::fs::remove_file(&temporary);
        return Err(CmdError(format!("无法保存封面缩略图：{error}")));
    }
    Ok(())
}

fn read_image(path: &Path) -> CmdResult<Vec<u8>> {
    let file = std::fs::File::open(path)
        .map_err(|error| CmdError(format!("无法读取封面图片：{error}")))?;
    let mut bytes = Vec::new();
    file.take((MAX_COVER + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| CmdError(format!("无法读取封面图片：{error}")))?;
    if bytes.len() > MAX_COVER {
        return Err(CmdError("封面图片不能超过 20 MB".into()));
    }
    Ok(bytes)
}

pub(super) async fn retain(directory: &Path, source: &str) -> CmdResult<String> {
    let source = source.trim();
    if is_managed(source, directory) {
        return Ok(source.into());
    }
    let remote = source.starts_with("https://") || source.starts_with("http://");
    let bytes = if remote {
        Some(crate::metadata::download_cover(source).await?)
    } else {
        None
    };
    let source = source.to_string();
    let directory = directory.to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = match bytes {
            Some(bytes) => bytes,
            None => read_image(Path::new(&source))?,
        };
        cache_image(&directory, &bytes)
    })
    .await
    .map_err(|error| CmdError(format!("封面保存失败：{error}")))?
}

/// A failed copy keeps the caller's original reference and operation result.
pub(super) async fn retain_or_original(app: &tauri::AppHandle, source: String) -> String {
    let result = match directory(app) {
        Ok(directory) => retain(&directory, &source).await,
        Err(error) => Err(error),
    };
    match result {
        Ok(path) => {
            crate::allow_asset_file(app, &path);
            path
        }
        Err(error) => {
            crate::app_warn!("[covers] preserve original reference: {error}");
            source
        }
    }
}

enum Reference {
    Source {
        id: i64,
        path: String,
    },
    Custom {
        key: String,
        raw: String,
        path: String,
    },
}
impl Reference {
    fn path(&self) -> &str {
        match self {
            Self::Source { path, .. } | Self::Custom { path, .. } => path,
        }
    }
}

#[derive(Debug)]
enum CopyResult {
    Copied,
    AlreadyManaged,
    Missing,
}

async fn migrate_reference(
    db: sqlx::SqlitePool,
    directory: PathBuf,
    reference: Reference,
) -> CmdResult<CopyResult> {
    let path = reference.path();
    if is_managed(path, &directory) {
        return Ok(CopyResult::AlreadyManaged);
    }
    if !path.starts_with("http://") && !path.starts_with("https://") && !Path::new(path).is_file() {
        crate::logging::record("WARN", "covers", &format!("原封面不存在，保留引用：{path}"));
        return Ok(CopyResult::Missing);
    }
    let saved = retain(&directory, path).await?;
    // Compare-and-swap: an edit made during a copy/download wins over this
    // snapshot. No title, timestamp, playtime or censorship field is rewritten.
    let changed = match reference {
        Reference::Source { id, path } => {
            sqlx::query("UPDATE games SET cover_path=? WHERE id=? AND cover_path=?")
                .bind(saved)
                .bind(id)
                .bind(path)
                .execute(&db)
                .await?
                .rows_affected()
        }
        Reference::Custom { key, raw, .. } => {
            let mut value: serde_json::Value =
                serde_json::from_str(&raw).map_err(|error| CmdError(error.to_string()))?;
            value["customPath"] = saved.into();
            sqlx::query("UPDATE settings SET value=? WHERE key=? AND value=?")
                .bind(value.to_string())
                .bind(key)
                .bind(raw)
                .execute(&db)
                .await?
                .rows_affected()
        }
    };
    Ok(if changed > 0 {
        CopyResult::Copied
    } else {
        CopyResult::AlreadyManaged
    })
}

/// Every stored cover reference: game rows first, then custom overrides.
async fn collect_references(db: &sqlx::SqlitePool) -> CmdResult<Vec<Reference>> {
    let mut references = Vec::new();
    let sources: Vec<(i64, String)> = sqlx::query_as(
        "SELECT id,cover_path FROM games WHERE cover_path IS NOT NULL AND trim(cover_path)<>''",
    )
    .fetch_all(db)
    .await?;
    references.extend(
        sources
            .into_iter()
            .map(|(id, path)| Reference::Source { id, path }),
    );
    let custom: Vec<(String, String)> = sqlx::query_as(
        "SELECT key,value FROM settings WHERE key LIKE 'game_cover:%' AND value IS NOT NULL",
    )
    .fetch_all(db)
    .await?;
    for (key, raw) in custom {
        if let Some(path) = serde_json::from_str::<serde_json::Value>(&raw)
            .ok()
            .and_then(|value| {
                value
                    .get("customPath")
                    .and_then(|path| path.as_str())
                    .map(str::trim)
                    .filter(|path| !path.is_empty())
                    .map(str::to_string)
            })
        {
            references.push(Reference::Custom { key, raw, path });
        }
    }
    Ok(references)
}

/// Stable digest of the whole reference set. Paths are already stored in a
/// canonical form by the migration itself, so an unchanged library hashes the
/// same on every launch while any add, edit or removal changes it.
fn fingerprint(references: &[Reference]) -> String {
    let mut entries: Vec<String> = references
        .iter()
        .map(|reference| match reference {
            Reference::Source { id, path } => format!("g{id}\u{0}{path}"),
            Reference::Custom { key, path, .. } => format!("c{key}\u{0}{path}"),
        })
        .collect();
    entries.sort();
    let mut digest = Sha256::new();
    for entry in entries {
        digest.update(entry.as_bytes());
        digest.update([0u8]);
    }
    format!("{:x}", digest.finalize())
}

/// The stored fingerprint is only trusted when the previous pass finished with
/// nothing left to repair, so a transient failure is retried on the next start.
#[derive(serde::Serialize, serde::Deserialize)]
struct StoredFingerprint {
    digest: String,
    clean: bool,
}

async fn stored_fingerprint(db: &sqlx::SqlitePool) -> Option<StoredFingerprint> {
    let raw = super::settings::settings_get_impl(db, FINGERPRINT_KEY).await.ok()??;
    serde_json::from_str(&raw).ok()
}

async fn save_fingerprint(db: &sqlx::SqlitePool, digest: &str, clean: bool) {
    let value = serde_json::to_string(&StoredFingerprint {
        digest: digest.to_string(),
        clean,
    });
    if let Ok(value) = value {
        let _ = super::settings::settings_set_impl(db, FINGERPRINT_KEY, Some(value)).await;
    }
}

async fn migrate_references(
    db: &sqlx::SqlitePool,
    directory: &Path,
    references: Vec<Reference>,
) -> CmdResult<MigrationReport> {
    let mut pending = references.into_iter();
    let mut tasks = tokio::task::JoinSet::new();
    let mut report = MigrationReport::default();
    loop {
        while tasks.len() < 4 {
            let Some(reference) = pending.next() else {
                break;
            };
            tasks.spawn(migrate_reference(
                db.clone(),
                directory.to_path_buf(),
                reference,
            ));
        }
        let Some(result) = tasks.join_next().await else {
            break;
        };
        match result {
            Ok(Ok(CopyResult::Copied)) => report.copied += 1,
            Ok(Ok(CopyResult::AlreadyManaged)) => report.already_managed += 1,
            Ok(Ok(CopyResult::Missing)) => report.missing += 1,
            result => {
                report.failed += 1;
                crate::app_warn!("[covers] migration failed: {result:?}");
            }
        }
    }
    Ok(report)
}

pub(crate) async fn migrate(db: &sqlx::SqlitePool, directory: &Path) -> CmdResult<MigrationReport> {
    let references = collect_references(db).await?;
    let report = migrate_references(db, directory, references).await?;
    crate::logging::record(
        "INFO",
        "covers",
        &format!(
            "封面保存完成 copied={} managed={} missing={} failed={}",
            report.copied, report.already_managed, report.missing, report.failed
        ),
    );
    Ok(report)
}

/// Run after SQLite opens, before pages hydrate their game/cover references.
/// Retrying is safe: managed images are skipped and failed originals are kept.
///
/// The reference set is fingerprinted so an unchanged library skips the pass
/// entirely; only an unfinished previous attempt (missing/failed references)
/// forces another one.
#[tauri::command]
pub async fn covers_migrate(app: tauri::AppHandle) -> CmdResult<MigrationReport> {
    let _resources = super::resource_storage::operation_guard()?;
    let db = super::games::pool(&app).await?;
    let directory = directory(&app)?;
    let references = collect_references(&db).await?;
    let digest = fingerprint(&references);
    if let Some(stored) = stored_fingerprint(&db).await {
        if stored.clean && stored.digest == digest {
            // Thumbnails are cheap to check and are what lists actually render,
            // so a cover stored before they existed still gets one. The decode
            // runs on a blocking thread: it is CPU work, not I/O.
            let pending: Vec<PathBuf> = references
                .iter()
                .map(|reference| PathBuf::from(reference.path()))
                .filter(|original| {
                    thumbnail_path(&directory, original).is_some_and(|thumb| !thumb.is_file())
                })
                .collect();
            let pending_count = pending.len();
            if !pending.is_empty() {
                let directory = directory.clone();
                let _ = tauri::async_runtime::spawn_blocking(move || {
                    for original in pending {
                        if let Ok(bytes) = read_image(&original) {
                            ensure_thumbnail(&directory, &original, &bytes);
                        }
                    }
                })
                .await;
            }
            super::scan_roots::sync_asset_scope(app).await?;
            crate::logging::record(
                "INFO",
                "covers",
                &format!("封面未变化，跳过检查（{} 张缩略图已补齐）", pending_count),
            );
            return Ok(MigrationReport {
                skipped: true,
                ..MigrationReport::default()
            });
        }
    }
    let report = migrate(&db, &directory).await?;
    // Fingerprint the references *after* the pass: the migration rewrites them
    // to managed paths, and only that settled form is stable between launches.
    let settled = fingerprint(&collect_references(&db).await?);
    // Only a clean pass is remembered: a missing or failed reference must be
    // retried on the next launch, which is exactly what an unclean flag does.
    save_fingerprint(&db, &settled, report.missing == 0 && report.failed == 0).await;
    super::scan_roots::sync_asset_scope(app).await?;
    Ok(report)
}

fn cache_image(dir: &Path, bytes: &[u8]) -> CmdResult<String> {
    if bytes.len() > MAX_COVER {
        return Err(CmdError("封面图片不能超过 20 MB".into()));
    }
    let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| CmdError("无法识别封面图片格式".into()))?;
    let ext = match reader.format() {
        Some(image::ImageFormat::Png) => "png",
        Some(image::ImageFormat::Jpeg) => "jpg",
        Some(image::ImageFormat::WebP) => "webp",
        Some(image::ImageFormat::Gif) => "gif",
        Some(image::ImageFormat::Bmp) => "bmp",
        _ => return Err(CmdError("请选择 PNG、JPEG、WebP、GIF 或 BMP 图片".into())),
    };
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(10000);
    limits.max_image_height = Some(10000);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    reader
        .decode()
        .map_err(|_| CmdError("封面图片损坏或尺寸过大".into()))?;
    std::fs::create_dir_all(dir).map_err(|e| CmdError(format!("无法创建封面目录：{e}")))?;
    let path = dir.join(format!("{:x}.{ext}", Sha256::digest(bytes)));
    if std::fs::read(&path).ok().as_deref() != Some(bytes) {
        let temporary = dir.join(format!(
            ".cover-{}-{}.tmp",
            std::process::id(),
            TEMPORARY.fetch_add(1, Ordering::Relaxed)
        ));
        let result =
            std::fs::write(&temporary, bytes).and_then(|_| crate::file_ops::rename(&temporary, &path));
        if let Err(error) = result {
            let _ = std::fs::remove_file(&temporary);
            return Err(CmdError(format!("无法保存封面：{error}")));
        }
    }
    ensure_thumbnail(dir, &path, bytes);
    Ok(path.to_string_lossy().into_owned())
}

/// Copy a selected image into managed storage; the source is never modified.
#[tauri::command]
pub async fn game_cover_import(
    app: tauri::AppHandle,
    game_id: i64,
    source_path: String,
) -> CmdResult<String> {
    let _resources = super::resource_storage::operation_guard()?;
    let db = super::games::pool(&app).await?;
    let exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM games WHERE id=?")
        .bind(game_id)
        .fetch_one(&db)
        .await?;
    if exists == 0 {
        return Err(CmdError("游戏不存在".into()));
    }
    let dir = directory(&app)?;
    let path = tauri::async_runtime::spawn_blocking(move || {
        let bytes = read_image(Path::new(&source_path))?;
        cache_image(&dir, &bytes)
    })
    .await
    .map_err(|e| CmdError(format!("封面保存失败：{e}")))??;
    crate::allow_asset_file(&app, &path);
    Ok(path)
}

/// Resolve only a saved custom path. An absent override preserves the source.
pub async fn custom_path(db: &sqlx::SqlitePool, game_id: i64) -> CmdResult<Option<String>> {
    let value = super::settings::settings_get_impl(db, &format!("game_cover:{game_id}")).await?;
    Ok(value
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|value| {
            value
                .get("customPath")
                .and_then(|path| path.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
        }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn encrypted_qa_cache_publish_repairs_interrupted_partial_copy() {
        let Some(base)=std::env::var_os("KOIPAGE_TEST_ENCRYPTED_ROOT") else { return; };
        let root=PathBuf::from(base).join(format!("cover-publish-test-{}",time::OffsetDateTime::now_utc().unix_timestamp_nanos()));
        let bytes=png(); let path=cache_image(&root,&bytes).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(),bytes);
        std::fs::write(&path,b"interrupted partial publication").unwrap();
        cache_image(&root,&bytes).unwrap(); assert_eq!(std::fs::read(&path).unwrap(),bytes);
        std::fs::remove_dir_all(&root).unwrap();
    }
    #[test]
    fn custom_cover_is_copied_to_managed_storage_and_keeps_original_bytes() {
        let mut png = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(2, 3)
            .write_to(&mut png, image::ImageFormat::Png)
            .unwrap();
        let dir = std::env::temp_dir().join(format!("koipage-cover-test-{}", std::process::id()));
        let path = cache_image(&dir, png.get_ref()).unwrap();
        assert!(Path::new(&path).starts_with(&dir));
        assert_eq!(std::fs::read(&path).unwrap(), *png.get_ref());
        assert_eq!(cache_image(&dir, png.get_ref()).unwrap(), path);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn corrupt_and_oversized_images_are_rejected_before_writing() {
        let dir = std::env::temp_dir().join("koipage-invalid-cover-test");
        assert!(cache_image(&dir, b"not an image").is_err());
        assert!(cache_image(&dir, &vec![0; 20 * 1024 * 1024 + 1]).is_err());
        assert!(!dir.exists());
    }

    fn png() -> Vec<u8> {
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(3, 2)
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        bytes.into_inner()
    }
    /// Stored originals only — `thumbs/` is a derived cache, not a cover.
    fn stored_files(directory: &Path) -> Vec<PathBuf> {
        std::fs::read_dir(directory)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .filter(|path| path.is_file())
            .collect()
    }
    async fn database() -> sqlx::SqlitePool {
        let db = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::raw_sql(include_str!("../../migrations/0001_init.sql"))
            .execute(&db)
            .await
            .unwrap();
        db
    }
    async fn game(db: &sqlx::SqlitePool, id: i64, cover: &str) {
        sqlx::query("INSERT INTO games(id,title,install_path,cover_path,created_at,updated_at,play_time_seconds) VALUES(?, 'Keep me', ?, ?, 'original', 'original', 321)")
            .bind(id).bind(format!("game-{id}")).bind(cover).execute(db).await.unwrap();
    }
    #[tokio::test]
    async fn migration_keeps_source_and_custom_covers_after_original_files_are_deleted() {
        let root =
            std::env::temp_dir().join(format!("koipage-cover-migration-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let source = root.join("source.png");
        let custom = root.join("custom.png");
        std::fs::write(&source, png()).unwrap();
        std::fs::write(&custom, png()).unwrap();
        let db = database().await;
        game(&db, 1, source.to_str().unwrap()).await;
        let preferences =
            serde_json::json!({"customPath":custom,"censored":true,"futureOption":"preserve"})
                .to_string();
        sqlx::query("INSERT INTO settings(key,value) VALUES('game_cover:1',?)")
            .bind(preferences)
            .execute(&db)
            .await
            .unwrap();
        let directory = root.join("managed");
        let first = migrate(&db, &directory).await.unwrap();
        assert!(
            source.is_file() && custom.is_file(),
            "migration must only copy original files"
        );
        std::fs::remove_file(source).unwrap();
        std::fs::remove_file(custom).unwrap();
        let source_path: String = sqlx::query_scalar("SELECT cover_path FROM games WHERE id=1")
            .fetch_one(&db)
            .await
            .unwrap();
        let custom_path = custom_path(&db, 1).await.unwrap().unwrap();
        assert_eq!(first.copied, 2, "both stored references must be migrated");
        assert_eq!(std::fs::read(&source_path).unwrap(), png());
        assert_eq!(std::fs::read(&custom_path).unwrap(), png());
        assert_eq!(
            source_path, custom_path,
            "identical contents should share one stored file"
        );
        let saved: String =
            sqlx::query_scalar("SELECT value FROM settings WHERE key='game_cover:1'")
                .fetch_one(&db)
                .await
                .unwrap();
        let saved: serde_json::Value = serde_json::from_str(&saved).unwrap();
        assert_eq!(saved["censored"], true);
        assert_eq!(saved["futureOption"], "preserve");
        let untouched: (i64, String) =
            sqlx::query_as("SELECT play_time_seconds,updated_at FROM games WHERE id=1")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(untouched, (321, "original".into()));
        let second = migrate(&db, &directory).await.unwrap();
        assert_eq!((second.copied, second.already_managed), (0, 2));
        assert_eq!(stored_files(&directory).len(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn migration_keeps_missing_and_bad_references_while_preserving_other_covers() {
        let root =
            std::env::temp_dir().join(format!("koipage-cover-partial-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let missing = root.join("missing.png");
        let bad = root.join("bad.png");
        let valid = root.join("valid.png");
        std::fs::write(&bad, b"broken image").unwrap();
        std::fs::write(&valid, png()).unwrap();
        let db = database().await;
        game(&db, 1, missing.to_str().unwrap()).await;
        game(&db, 2, bad.to_str().unwrap()).await;
        game(&db, 3, valid.to_str().unwrap()).await;
        let result = migrate(&db, &root.join("managed")).await.unwrap();
        assert_eq!((result.copied, result.missing, result.failed), (1, 1, 1));
        let paths: Vec<String> = sqlx::query_scalar("SELECT cover_path FROM games ORDER BY id")
            .fetch_all(&db)
            .await
            .unwrap();
        assert_eq!(paths[0], missing.to_string_lossy());
        assert_eq!(paths[1], bad.to_string_lossy());
        assert!(Path::new(&paths[2]).is_file());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn migration_downloads_remote_covers_without_an_installed_game() {
        use std::io::Write;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/remote.jpg", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let server = std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            loop {
                if let Ok((mut stream, _)) = listener.accept() {
                    stream
                        .set_read_timeout(Some(std::time::Duration::from_secs(2)))
                        .unwrap();
                    let mut buffer = [0; 4096];
                    let _ = stream.read(&mut buffer);
                    let bytes = png();
                    write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",bytes.len()).unwrap();
                    stream.write_all(&bytes).unwrap();
                    return;
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "remote cover request never arrived"
                );
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        });
        let root =
            std::env::temp_dir().join(format!("koipage-cover-remote-{}", std::process::id()));
        let db = database().await;
        game(&db, 1, &url).await;
        let report = migrate(&db, &root).await.unwrap();
        server.join().unwrap();
        assert_eq!(report.copied, 1);
        let path: String = sqlx::query_scalar("SELECT cover_path FROM games WHERE id=1")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(Path::new(&path).extension().unwrap(), "png");
        assert_eq!(std::fs::read(path).unwrap(), png());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn failed_storage_write_keeps_the_original_reference() {
        let root =
            std::env::temp_dir().join(format!("koipage-cover-write-fail-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let source = root.join("source.png");
        std::fs::write(&source, png()).unwrap();
        let blocked = root.join("managed");
        std::fs::write(&blocked, b"not a directory").unwrap();
        let db = database().await;
        game(&db, 1, source.to_str().unwrap()).await;
        let report = migrate(&db, &blocked).await.unwrap();
        assert_eq!((report.copied, report.failed), (0, 1));
        let path: String = sqlx::query_scalar("SELECT cover_path FROM games WHERE id=1")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(path, source.to_string_lossy());
        assert_eq!(std::fs::read(source).unwrap(), png());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn managed_image_writes_repair_damaged_cache_files_without_leftover_temporary_files() {
        let root =
            std::env::temp_dir().join(format!("koipage-cover-repair-{}", std::process::id()));
        let path = cache_image(&root, &png()).unwrap();
        std::fs::write(&path, b"interrupted write").unwrap();
        assert_eq!(cache_image(&root, &png()).unwrap(), path);
        assert_eq!(std::fs::read(path).unwrap(), png());
        assert_eq!(stored_files(&root).len(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn scanned_bmp_covers_are_preserved_without_changing_their_bytes() {
        // One black pixel, 24-bit uncompressed BMP, with a padded 4-byte row.
        let mut bytes = b"BM".to_vec();
        bytes.extend(58u32.to_le_bytes());
        bytes.extend(0u32.to_le_bytes());
        bytes.extend(54u32.to_le_bytes());
        bytes.extend(40u32.to_le_bytes());
        bytes.extend(1i32.to_le_bytes());
        bytes.extend(1i32.to_le_bytes());
        bytes.extend(1u16.to_le_bytes());
        bytes.extend(24u16.to_le_bytes());
        bytes.extend(0u32.to_le_bytes());
        bytes.extend(4u32.to_le_bytes());
        bytes.extend([0;16]);
        bytes.extend([0;4]);
        let root = std::env::temp_dir().join(format!("koipage-cover-bmp-{}",std::process::id()));
        let path = cache_image(&root,&bytes).expect("BMP accepted by the scanner must also be retained");
        assert_eq!(Path::new(&path).extension().unwrap(),"bmp");
        assert_eq!(std::fs::read(path).unwrap(),bytes);
        std::fs::remove_dir_all(root).unwrap();
    }
}
