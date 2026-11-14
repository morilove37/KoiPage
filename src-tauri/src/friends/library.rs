//! Allowlisted public collection data, independent from short-lived presence.
use super::{model::*, runtime};
use crate::commands::error::{CmdError, CmdResult};
use base64::Engine;
use serde::Serialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::{
    io::Read,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Serialize, sqlx::FromRow)]
pub struct Source {
    id: i64,
    title: String,
    original_title: Option<String>,
    developer: Option<String>,
    status: String,
    rating: Option<f64>,
    play_time_seconds: i64,
    vndb_id: Option<String>,
    bangumi_id: Option<String>,
    cover_path: Option<String>,
    cover_preferences: Option<String>,
    /// Effective provider/manual classification; unknown games are censored.
    nsfw: bool,
}

impl Source {
    fn cover_preferences(&self) -> serde_json::Value {
        preferences(&self.cover_preferences)
    }
    /// A hand-picked cover exists (verified or not).
    fn custom_cover(&self) -> bool {
        custom_path(&self.cover_preferences()).is_some()
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverStatus {
    pub game_id: i64,
    pub title: String,
    pub nsfw: bool,
    pub custom_cover: bool,
    pub verified: bool,
    pub review_status: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    key: String,
    title: String,
    original_title: Option<String>,
    developer: Option<String>,
    status: String,
    rating: Option<f64>,
    play_time_seconds: i64,
    vndb_id: Option<String>,
    bangumi_id: Option<String>,
    cover_url: Option<String>,
    cover_kind: String,
    nsfw: bool,
}

fn short(value: &str) -> String {
    value.trim().chars().take(200).collect()
}
/// Stable public key for one local game. Shared with history sync so friend
/// history cards can join the same public library entry.
pub(super) fn library_key(game_id: i64) -> String {
    format!("{:x}", Sha256::digest(format!("library:{game_id}")))
}
fn preferences(raw: &Option<String>) -> serde_json::Value {
    raw.as_deref()
        .and_then(|raw| serde_json::from_str(raw).ok())
        .unwrap_or_default()
}
fn custom_path(value: &serde_json::Value) -> Option<String> {
    value["customPath"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}
fn project(source: &Source, cover: Option<String>) -> Option<Entry> {
    let title = short(&source.title);
    if title.is_empty() {
        return None;
    }
    let status = if [
        "unplayed",
        "wishlist",
        "playing",
        "completed",
        "on_hold",
        "dropped",
    ]
    .contains(&source.status.as_str())
    {
        source.status.clone()
    } else {
        "unplayed".into()
    };
    Some(Entry {
        key: library_key(source.id),
        title,
        original_title: source
            .original_title
            .as_deref()
            .map(short)
            .filter(|v| !v.is_empty()),
        developer: source
            .developer
            .as_deref()
            .map(short)
            .filter(|v| !v.is_empty()),
        status,
        rating: source
            .rating
            .filter(|v| v.is_finite() && (0.0..=10.0).contains(v)),
        play_time_seconds: source.play_time_seconds.clamp(0, 3_155_760_000),
        vndb_id: source
            .vndb_id
            .as_ref()
            .filter(|s| {
                s.starts_with('v')
                    && (2..=13).contains(&s.len())
                    && s[1..].bytes().all(|b| b.is_ascii_digit())
            })
            .cloned(),
        bangumi_id: source
            .bangumi_id
            .as_ref()
            .filter(|s| (1..=12).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit()))
            .cloned(),
        cover_url: cover,
        cover_kind: if source.custom_cover() {
            "custom"
        } else {
            "source"
        }
        .into(),
        nsfw: source.nsfw,
    })
}
fn thumbnail_with_options(
    bytes: &[u8],
    censored: bool,
    crop: Option<&serde_json::Value>,
) -> Option<String> {
    if bytes.len() > 20 * 1024 * 1024 {
        return None;
    }
    let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .ok()?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    let mut image = reader.decode().ok()?;
    if let Some(crop) = crop {
        let values = ["x", "y", "width", "height"].map(|key| crop[key].as_f64());
        if let [Some(x), Some(y), Some(width), Some(height)] = values {
            if [x, y, width, height].iter().all(|v| v.is_finite()) && width > 0.0 && height > 0.0 {
                let width = width.min(1.0);
                let height = height.min(1.0);
                let left = (x.clamp(0.0, 1.0 - width) * image.width() as f64).floor() as u32;
                let top = (y.clamp(0.0, 1.0 - height) * image.height() as f64).floor() as u32;
                let w =
                    ((width * image.width() as f64).round() as u32).clamp(1, image.width() - left);
                let h = ((height * image.height() as f64).round() as u32)
                    .clamp(1, image.height() - top);
                image = image.crop_imm(left, top, w, h);
            }
        }
    }
    for (width, height, quality) in [(120, 168, 65), (80, 112, 50)] {
        let thumbnail = image.thumbnail(width, height);
        let image = if censored {
            thumbnail.blur(12.0)
        } else {
            thumbnail
        }
        .to_rgb8();
        let mut jpeg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, quality)
            .encode_image(&image)
            .ok()?;
        let url = format!(
            "data:image/jpeg;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(jpeg)
        );
        if url.len() <= 12288 {
            return Some(url);
        }
    }
    None
}

fn cover_choice(source: &Source) -> (Option<String>, bool, Option<serde_json::Value>) {
    let value = source.cover_preferences();
    let path = custom_path(&value).or_else(|| source.cover_path.clone());
    // Public thumbnails are shared without blur; local display preferences stay local.
    let censored = false;
    let crop = value
        .get("crop")
        .filter(|crop| {
            path.as_deref()
                .is_some_and(|path| crop["path"].as_str() == Some(path))
        })
        .cloned();
    (path, censored, crop)
}
#[cfg(test)]
fn thumbnail_bytes(bytes: &[u8]) -> Option<String> {
    thumbnail_with_options(bytes, false, None)
}
fn fingerprint(entry: &Entry) -> String {
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(entry).unwrap_or_default())
    )
}
fn changed_batches(entries: &[Entry], published: &HashMap<String, String>) -> Vec<Vec<Entry>> {
    entries
        .iter()
        .filter(|entry| published.get(&entry.key) != Some(&fingerprint(entry)))
        .cloned()
        .collect::<Vec<_>>()
        .chunks(25)
        .map(|chunk| chunk.to_vec())
        .collect()
}

#[derive(Default)]
pub(super) struct Cache {
    identity: String,
    entries: HashMap<i64, (String, Entry)>,
    published: HashMap<String, String>,
    enabled: Option<bool>,
    generation: Option<u64>,
    attempted_generation: Option<u64>,
    next_attempt: Option<Instant>,
}

fn managed_cover(path: &str, roots: &[PathBuf]) -> Option<PathBuf> {
    let path = Path::new(path).canonicalize().ok()?;
    roots
        .iter()
        .any(|root| root.canonicalize().is_ok_and(|root| path.starts_with(root)))
        .then_some(path)
}

fn prepare_entries(
    config: &Config,
    sources: Vec<Source>,
    previous: &HashMap<i64, (String, Entry)>,
    roots: &[PathBuf],
) -> CmdResult<HashMap<i64, (String, Entry)>> {
    let hidden = config
        .hidden_game_ids
        .iter()
        .copied()
        .collect::<std::collections::HashSet<_>>();
    let mut entries = HashMap::new();
    for source in sources
        .into_iter()
        .filter(|source| !hidden.contains(&source.id))
    {
        // Cloud review is deliberately disabled in this release. Withhold the
        // whole custom-cover work before reading images or reusing cached entries;
        // local "verified" preferences cannot authorize public sharing.
        // TODO: only submit candidates after server quarantine/review is enabled.
        if source.custom_cover() {
            continue;
        }
        if entries.len() >= 10000 {
            return Err(CmdError(
                "FRIENDS_INPUT: 最多可分享 10000 部作品，请隐藏部分作品后重试".into(),
            ));
        }
        let (effective_path, censored, crop) = cover_choice(&source);
        let path = effective_path
            .as_deref()
            .and_then(|value| managed_cover(value, roots));
        let metadata = path
            .as_ref()
            .and_then(|p| std::fs::metadata(p).ok())
            .filter(|m| m.is_file() && m.len() <= 20 * 1024 * 1024);
        let stamp = metadata
            .as_ref()
            .map(|m| format!("{}:{:?}", m.len(), m.modified().ok()));
        let signature = format!(
            "{:x}",
            Sha256::digest(format!(
                "{}:{stamp:?}",
                serde_json::to_string(&source).unwrap_or_default()
            ))
        );
        if let Some((old_signature, old_entry)) =
            previous.get(&source.id).filter(|(s, _)| s == &signature)
        {
            entries.insert(source.id, (old_signature.clone(), old_entry.clone()));
            continue;
        }
        let cover = path.filter(|_| metadata.is_some()).and_then(|path| {
            let file = std::fs::File::open(path).ok()?;
            let mut bytes = Vec::new();
            file.take(20 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)
                .ok()?;
            thumbnail_with_options(&bytes, censored, crop.as_ref())
        });
        if let Some(entry) = project(&source, cover) {
            entries.insert(source.id, (signature, entry));
        }
    }
    Ok(entries)
}

fn current(inner: &runtime::Inner, generation: u64, id: &str) -> bool {
    inner.generation == generation
        && inner.config.enabled
        && inner.tokens.is_some()
        && inner
            .account
            .as_ref()
            .is_some_and(|account| account.id == id)
}

async fn load_sources(db: &sqlx::SqlitePool) -> CmdResult<Vec<Source>> {
    Ok(sqlx::query_as::<_, Source>("SELECT g.id,g.title,g.original_title,g.developer,g.status,CAST(g.rating AS REAL) AS rating,g.play_time_seconds,g.vndb_id,g.bangumi_id,g.cover_path,s.value AS cover_preferences,CASE WHEN p.value='0' AND COALESCE(n.value,'0')='0' THEN 0 ELSE 1 END AS nsfw FROM games g LEFT JOIN settings s ON s.key='game_cover:'||g.id LEFT JOIN settings n ON n.key='game_nsfw:'||g.id LEFT JOIN settings p ON p.key='game_nsfw_source:'||g.id ORDER BY g.id").fetch_all(db).await?)
}

fn cover_status_row(
    game_id: i64,
    title: &str,
    nsfw: Option<&str>,
    cover: Option<&str>,
) -> Option<CoverStatus> {
    let raw = cover.map(str::to_string);
    let value = preferences(&raw);
    let custom = custom_path(&value).is_some();
    let nsfw = nsfw == Some("1");
    (nsfw || custom).then(|| CoverStatus {
        game_id,
        title: title.trim().to_string(),
        nsfw,
        custom_cover: custom,
        verified: false,
        review_status: "disabled".into(),
    })
}

pub(super) async fn cover_status(app: &AppHandle) -> CmdResult<Vec<CoverStatus>> {
    let db = crate::commands::games::pool(app).await?;
    let rows: Vec<_> = load_sources(&db)
        .await?
        .into_iter()
        .filter_map(|source| {
            cover_status_row(
                source.id,
                &source.title,
                Some(if source.nsfw { "1" } else { "0" }),
                source.cover_preferences.as_deref(),
            )
        })
        .collect();
    // Read-only local status: review interfaces are not deployed. Do not sync
    // candidates or query any deferred cloud review RPC from this settings view.
    Ok(rows)
}

pub(super) async fn verify_cover(
    _app: &AppHandle,
    _game_id: i64,
    _verified: bool,
) -> CmdResult<serde_json::Value> {
    Err(CmdError(
        "FRIENDS_INPUT: 当前版本未启用云端封面审核，自定义封面作品暂不公开，无法在本机确认通过。"
            .into(),
    ))
}

async fn synchronize(
    app: &AppHandle,
    cache: &mut Cache,
    config: &Config,
    generation: u64,
    id: &str,
    force: bool,
) -> CmdResult<Status> {
    let state = app.state::<runtime::FriendsState>();
    if !config.share_library {
        let mut inner = state.inner.lock().await;
        if !current(&inner, generation, id) {
            return Ok(inner.status());
        }
        if cache.enabled != Some(false) || cache.generation != Some(generation) || force {
            runtime::rpc(
                &mut inner,
                "koipage_library_sync",
                json!({"p_enabled":false,"p_games":[],"p_keys":[]}),
            )
            .await?;
        }
        cache.enabled = Some(false);
        cache.generation = Some(generation);
        cache.entries.clear();
        cache.published.clear();
        inner.library_synced_at = None;
        inner.library_error = None;
        inner.library_pending = false;
        return Ok(inner.status());
    }
    let db = crate::commands::games::pool(app).await?;
    let sources = load_sources(&db).await?;
    let directory = app.path().app_data_dir()?;
    let roots = vec![directory.join("covers"), directory.join("custom-covers")];
    let config_for_images = config.clone();
    let previous = cache.entries.clone();
    cache.entries = tauri::async_runtime::spawn_blocking(move || {
        prepare_entries(&config_for_images, sources, &previous, &roots)
    })
    .await
    .map_err(|_| CmdError("FRIENDS_LIBRARY: 无法准备游戏库封面".into()))??;
    let mut entries = cache
        .entries
        .values()
        .map(|(_, entry)| entry.clone())
        .collect::<Vec<_>>();
    entries.sort_by(|a, b| a.key.cmp(&b.key));
    let keys = entries
        .iter()
        .map(|entry| entry.key.clone())
        .collect::<Vec<_>>();
    let mut batches = changed_batches(&entries, &cache.published);
    let removed = cache
        .published
        .keys()
        .any(|key| keys.binary_search(key).is_err());
    if batches.is_empty()
        && (removed || force || cache.enabled != Some(true) || cache.generation != Some(generation))
    {
        batches.push(Vec::new());
    }
    for batch in batches {
        let mut inner = state.inner.lock().await;
        // Metadata/image work runs without the identity lock. Discard its result if
        // logout, a privacy change or an account switch happened in the meantime.
        if state.stopping.load(std::sync::atomic::Ordering::SeqCst)
            || !current(&inner, generation, id)
            || !inner.config.share_library
        {
            return Ok(inner.status());
        }
        let response = runtime::rpc(
            &mut inner,
            "koipage_library_sync",
            json!({"p_enabled":true,"p_games":batch,"p_keys":keys}),
        )
        .await?;
        cache
            .published
            .retain(|key, _| keys.binary_search(key).is_ok());
        for entry in &batch {
            cache
                .published
                .insert(entry.key.clone(), fingerprint(entry));
        }
        cache.enabled = Some(true);
        cache.generation = Some(generation);
        inner.library_synced_at = response["syncedAt"]
            .as_f64()
            .filter(|v| v.is_finite())
            .map(|v| v as i64);
        inner.library_error = None;
        let _ = app.emit("friends-status-changed", inner.status());
    }
    let mut inner = state.inner.lock().await;
    if current(&inner, generation, id) {
        inner.library_error = None;
        inner.library_pending = false;
    }
    Ok(inner.status())
}

pub(super) async fn sync(app: &AppHandle, force: bool) -> CmdResult<Status> {
    let state = app.state::<runtime::FriendsState>();
    let mut cache = state.library.lock().await;
    let (config, generation, id) = {
        let inner = state.inner.lock().await;
        let Some(account) = inner
            .account
            .as_ref()
            .filter(|_| inner.config.enabled && inner.tokens.is_some())
        else {
            return Ok(inner.status());
        };
        (inner.config.clone(), inner.generation, account.id.clone())
    };
    let identity = format!("{}:{id}", config.server_url);
    if cache.identity != identity {
        *cache = Cache {
            identity,
            ..Cache::default()
        };
    }
    if !force
        && cache.attempted_generation == Some(generation)
        && cache.next_attempt.is_some_and(|at| Instant::now() < at)
    {
        return Ok(state.inner.lock().await.status());
    }
    cache.attempted_generation = Some(generation);
    cache.next_attempt = Some(Instant::now() + Duration::from_secs(30));
    let result = synchronize(app, &mut cache, &config, generation, &id, force).await;
    if let Err(error) = &result {
        cache.next_attempt = Some(Instant::now() + Duration::from_secs(10));
        let mut inner = state.inner.lock().await;
        if inner.generation == generation {
            inner.library_error = Some(format!(
                "游戏库尚未同步，分享或隐藏设置可能尚未在云端生效。{}",
                error.0
            ));
            let _ = app.emit("friends-status-changed", inner.status());
        }
    } else {
        let _ = app.emit("friends-status-changed", state.inner.lock().await.status());
    }
    result
}

pub(super) async fn publisher(app: AppHandle) {
    loop {
        tokio::time::sleep(Duration::from_secs(if runtime::low_activity(&app) { 60 } else { 15 })).await;
        let state = app.state::<runtime::FriendsState>();
        if state.stopping.load(std::sync::atomic::Ordering::SeqCst) {
            continue;
        }
        let _ = sync(&app, false).await;
    }
}

pub(super) async fn retract_before_forgetting(inner: &mut runtime::Inner) -> CmdResult<()> {
    match runtime::rpc(
        inner,
        "koipage_library_sync",
        json!({"p_enabled":false,"p_games":[],"p_keys":[]}),
    )
    .await
    {
        Ok(_) => {
            inner.library_synced_at = None;
            inner.library_error = None;
            Ok(())
        }
        Err(error) => {
            inner.library_error = Some(format!(
                "云端游戏库尚未撤回，已保留原连接；恢复网络后请重新保存连接设置。{}",
                error.0
            ));
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn legacy_integer_ratings_and_zero_scores_do_not_abort_library_sync() {
        let db = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE games(id INTEGER,title TEXT,original_title TEXT,developer TEXT,status TEXT,rating INTEGER,play_time_seconds INTEGER,vndb_id TEXT,bangumi_id TEXT,cover_path TEXT)").execute(&db).await.unwrap();
        sqlx::query("INSERT INTO games VALUES(1,'zero',NULL,NULL,'completed',0,7200,NULL,NULL,NULL),(2,'decimal',NULL,NULL,'playing',8.73,3600,NULL,NULL,NULL)").execute(&db).await.unwrap();
        sqlx::query("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT)")
            .execute(&db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO settings VALUES('game_cover:1','{\"censored\":true}')")
            .execute(&db)
            .await
            .unwrap();
        let rows = load_sources(&db).await.unwrap();
        assert_eq!(rows[0].rating, Some(0.0));
        assert_eq!(rows[1].rating, Some(8.73));
        assert!(
            rows.iter().all(|row| row.nsfw),
            "unknown classification must be masked"
        );
        sqlx::query("INSERT INTO settings VALUES('game_nsfw:1','0'),('game_nsfw_source:1','1'),('game_nsfw_source:2','0')").execute(&db).await.unwrap();
        let classified = load_sources(&db).await.unwrap();
        assert!(
            classified[0].nsfw,
            "manual safe cannot erase provider adult evidence"
        );
        assert!(
            !classified[1].nsfw,
            "provider safe can be displayed without manual override"
        );
        sqlx::query("DELETE FROM settings WHERE key='game_nsfw_source:1'")
            .execute(&db)
            .await
            .unwrap();
        assert!(
            load_sources(&db).await.unwrap()[0].nsfw,
            "manual safe alone is not provider evidence"
        );
        assert_eq!(
            rows[0].cover_preferences.as_deref(),
            Some("{\"censored\":true}")
        );
        db.close().await;
    }

    #[tokio::test]
    async fn changing_service_retracts_collection_before_discarding_the_connection() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let worker = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut bytes = [0; 4096];
            let n = stream.read(&mut bytes).unwrap();
            let request = String::from_utf8_lossy(&bytes[..n]).into_owned();
            write!(
                stream,
                "HTTP/1.1 503 Unavailable\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"
            )
            .unwrap();
            request.lines().next().unwrap().to_string()
        });
        let mut inner = runtime::Inner {
            config: Config {
                enabled: true,
                share_library: true,
                server_url: format!("http://{address}"),
                public_key: "sb_publishable_test".into(),
                ..Config::default()
            },
            tokens: Some(Tokens {
                access_token: "test-only".into(),
                refresh_token: "test-only".into(),
                expires_at: now() + 3600,
            }),
            ..runtime::Inner::default()
        };
        assert!(retract_before_forgetting(&mut inner).await.is_err());
        assert!(worker.join().unwrap().contains("/koipage_library_sync"));
        assert!(inner.tokens.is_some() && inner.config.enabled && inner.config.share_library);
        assert!(inner.library_error.as_ref().unwrap().contains("原连接"));
    }
    fn source(id: i64) -> Source {
        Source {
            id,
            title: " 测试作品 ".into(),
            original_title: Some("原名".into()),
            developer: Some("制作组".into()),
            status: "completed".into(),
            rating: Some(0.0),
            play_time_seconds: 7200,
            vndb_id: Some("v123".into()),
            bangumi_id: Some("456".into()),
            cover_path: Some(r"C:\private\cover.png".into()),
            cover_preferences: None,
            nsfw: false,
        }
    }

    #[test]
    fn library_keys_are_stable_and_shared_with_history_sync() {
        let key = library_key(7);
        assert_eq!(key.len(), 64);
        assert_eq!(key, library_key(7));
        assert_eq!(project(&source(7), None).unwrap().key, key);
    }

    #[test]
    fn public_covers_are_not_blurred_by_nsfw_or_local_mask_preferences() {
        let mut row = source(1);
        assert!(!cover_choice(&row).1);
        row.nsfw = true;
        row.cover_preferences = Some(json!({"censored":false}).to_string());
        assert!(!cover_choice(&row).1);
        row.cover_preferences = Some(json!({"censored":true}).to_string());
        assert!(!cover_choice(&row).1);
    }

    #[test]
    fn custom_cover_works_are_withheld_while_cloud_review_is_disabled() {
        let config = Config {
            share_library: true,
            ..Config::default()
        };
        let mut unverified = source(1);
        unverified.cover_preferences =
            Some(json!({"customPath":"C:/custom/one.png","censored":true}).to_string());
        let mut verified = source(2);
        verified.cover_preferences =
            Some(json!({"customPath":"C:/custom/two.png","verified":true}).to_string());
        let entries = prepare_entries(
            &config,
            vec![unverified, verified, source(3)],
            &HashMap::new(),
            &[],
        )
        .unwrap();
        assert!(!entries.contains_key(&1));
        assert!(!entries.contains_key(&2));
        assert!(entries.contains_key(&3));
    }

    #[test]
    fn cover_status_cannot_trust_local_self_approval() {
        assert!(cover_status_row(1, "A", Some("1"), None).unwrap().nsfw);
        let custom = cover_status_row(
            2,
            " B ",
            None,
            Some(r#"{"customPath":"C:/x.png","censored":true}"#),
        )
        .unwrap();
        assert!(custom.custom_cover && !custom.verified && !custom.nsfw);
        assert_eq!(custom.review_status, "disabled");
        assert_eq!(custom.title, "B");
        assert!(
            !cover_status_row(
                3,
                "C",
                None,
                Some(r#"{"customPath":"C:/x.png","verified":true}"#)
            )
            .unwrap()
            .verified
        );
        assert!(cover_status_row(4, "D", None, None).is_none());
        assert!(cover_status_row(5, "E", Some("0"), Some("{}")).is_none());
    }

    #[test]
    fn withholding_custom_cover_does_not_change_private_preferences_or_reuse_cached_public_work() {
        let mut row = source(1);
        row.cover_preferences = Some(json!({"customPath":"C:/private.png","verified":true,
            "censored":true,"crop":{"path":"C:/private.png","x":0.1,"y":0.1,"width":0.5,"height":0.5}}).to_string());
        let original = row.cover_preferences.clone();
        let cached = HashMap::from([(
            1,
            (
                "old".into(),
                project(&row, Some("old-public-cover".into())).unwrap(),
            ),
        )]);
        let entries = prepare_entries(&Config::default(), vec![row.clone()], &cached, &[]).unwrap();
        assert!(entries.is_empty());
        assert_eq!(row.cover_preferences, original);
        let (path, censored, crop) = cover_choice(&row);
        assert_eq!(path.as_deref(), Some("C:/private.png"));
        assert!(!censored && crop.is_some());
        assert!(row.cover_preferences()["verified"].as_bool().unwrap());
    }
    #[test]
    fn library_projection_preserves_zero_score_and_total_time_without_local_paths() {
        let entry = project(&source(1), None).expect("a public entry");
        let value = serde_json::to_value(&entry).unwrap();
        assert_eq!(value["title"], "测试作品");
        assert_eq!(value["rating"], 0.0);
        assert_eq!(value["playTimeSeconds"], 7200);
        assert_eq!(value["status"], "completed");
        assert_eq!(value["key"].as_str().unwrap().len(), 64);
        assert_eq!(value.as_object().unwrap().len(), 12);
        assert_eq!(value["coverKind"], "source");
        assert_eq!(value["nsfw"], false);
        assert!(!value.to_string().contains("private"));
        let mut invalid = source(1);
        invalid.title = "  ".into();
        assert!(project(&invalid, None).is_none());
    }

    #[test]
    fn public_covers_follow_matching_crop_preferences_without_mask() {
        let mut row = source(1);
        row.cover_preferences = Some(json!({"customPath":"C:/safe.png","censored":true,"crop":{"path":"C:/safe.png","x":0.2,"y":0.1,"width":0.5,"height":0.5}}).to_string());
        let (path, censored, crop) = cover_choice(&row);
        assert_eq!(path.as_deref(), Some("C:/safe.png"));
        assert!(!censored);
        assert_eq!(crop.unwrap()["width"], 0.5);
        row.cover_preferences = Some(json!({"customPath":null,"censored":true,"crop":{"path":"unrelated","x":0,"y":0,"width":1,"height":1}}).to_string());
        let (path, censored, crop) = cover_choice(&row);
        assert_eq!(path, row.cover_path);
        assert!(!censored && crop.is_none());
    }

    #[test]
    fn censorship_changes_uploaded_pixels_and_crops_do_not_include_excluded_regions() {
        let image = image::RgbImage::from_fn(200, 200, |x, y| {
            if (x / 8 + y / 8) % 2 == 0 {
                image::Rgb([255, 0, 0])
            } else {
                image::Rgb([0, 0, 255])
            }
        });
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(image)
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        let normal = thumbnail_bytes(bytes.get_ref()).unwrap();
        let censored = thumbnail_with_options(bytes.get_ref(), true, None).unwrap();
        assert_ne!(
            Sha256::digest(normal.as_bytes()),
            Sha256::digest(censored.as_bytes()),
            "a CSS-only mask must never expose the original uploaded bytes"
        );
        let crop = json!({"x":0,"y":0,"width":0.3,"height":1});
        assert_ne!(
            Sha256::digest(normal.as_bytes()),
            Sha256::digest(
                thumbnail_with_options(bytes.get_ref(), false, Some(&crop))
                    .unwrap()
                    .as_bytes()
            )
        );
    }
    #[test]
    fn library_projection_normalizes_untrusted_local_metadata() {
        let mut row = source(2);
        row.rating = Some(f64::NAN);
        row.play_time_seconds = -5;
        row.vndb_id = Some("file:///secret".into());
        row.bangumi_id = Some("not-an-id".into());
        row.status = "bogus".into();
        let entry = project(&row, None).unwrap();
        assert!(entry.rating.is_none() && entry.vndb_id.is_none() && entry.bangumi_id.is_none());
        assert_eq!(entry.play_time_seconds, 0);
        assert_eq!(entry.status, "unplayed");
    }
    #[test]
    fn library_cover_is_reencoded_as_a_bounded_jpeg_and_invalid_images_are_skipped() {
        let img = image::DynamicImage::new_rgb8(600, 900);
        let mut bytes = std::io::Cursor::new(Vec::new());
        img.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
        let url = thumbnail_bytes(bytes.get_ref()).expect("a thumbnail");
        assert!(url.starts_with("data:image/jpeg;base64,") && url.len() <= 12288);
        let jpeg = base64::engine::general_purpose::STANDARD
            .decode(url.split_once(',').unwrap().1)
            .unwrap();
        let decoded = image::load_from_memory(&jpeg).unwrap();
        assert!(decoded.width() <= 120 && decoded.height() <= 168);
        assert!(thumbnail_bytes(b"not an image").is_none());
    }
    #[test]
    fn library_delta_only_sends_changed_entries_in_bounded_batches() {
        let entries = (1..=27)
            .map(|id| project(&source(id), None).unwrap())
            .collect::<Vec<_>>();
        let published = HashMap::from([(entries[0].key.clone(), fingerprint(&entries[0]))]);
        let batches = changed_batches(&entries, &published);
        assert_eq!(
            batches.iter().map(Vec::len).collect::<Vec<_>>(),
            vec![25, 1]
        );
        assert!(
            batches
                .iter()
                .flatten()
                .all(|entry| entry.key != entries[0].key)
        );
        let all = entries
            .iter()
            .map(|entry| (entry.key.clone(), fingerprint(entry)))
            .collect();
        assert!(changed_batches(&entries, &all).is_empty());
    }

    #[test]
    fn hidden_entries_are_removed_even_when_their_public_projection_is_cached() {
        let row = source(1);
        let cached = HashMap::from([(1, ("old".into(), project(&row, None).unwrap()))]);
        let config = Config {
            share_library: true,
            hidden_game_ids: vec![1],
            ..Config::default()
        };
        let visible = prepare_entries(&config, vec![row, source(2)], &cached, &[]).unwrap();
        assert_eq!(visible.len(), 1);
        assert!(visible.contains_key(&2) && !visible.contains_key(&1));
    }

    #[test]
    fn in_flight_library_work_cannot_cross_an_identity_or_preferences_generation() {
        let mut inner = runtime::Inner {
            config: Config {
                enabled: true,
                ..Config::default()
            },
            account: Some(Account {
                id: "alice".into(),
                username: "alice".into(),
                nickname: "Alice".into(),
                avatar: 0,
                friend_code: "CODE".into(),
            }),
            tokens: Some(Tokens {
                access_token: "test".into(),
                refresh_token: "test".into(),
                expires_at: now() + 3600,
            }),
            generation: 2,
            ..runtime::Inner::default()
        };
        assert!(current(&inner, 2, "alice"));
        assert!(!current(&inner, 1, "alice"));
        assert!(!current(&inner, 2, "bob"));
        inner.config.enabled = false;
        assert!(!current(&inner, 2, "alice"));
    }
}
