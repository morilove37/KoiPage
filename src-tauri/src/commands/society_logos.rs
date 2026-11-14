use super::error::{CmdError, CmdResult};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

#[path = "society_logo_sources.rs"]
mod sources;

const RESOLVER_VERSION: u8 = 2;

// One background resolver at a time; local overrides never wait behind this queue.
static RESOLVER: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static NEXTMOE_REQUEST: tokio::sync::Mutex<Option<std::time::Instant>> =
    tokio::sync::Mutex::const_new(None);

#[derive(Clone, Default, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogoRecord {
    pub path: Option<String>,
    pub custom: bool,
    pub source: Option<String>,
    pub checked_at: u64,
    pub retry_after: u64,
    #[serde(default)]
    pub resolver_version: u8,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn identity(name: &str) -> String {
    name.chars()
        .map(|c| {
            if ('\u{ff01}'..='\u{ff5e}').contains(&c) {
                char::from_u32(c as u32 - 0xfee0).unwrap_or(c)
            } else {
                c
            }
        })
        .flat_map(char::to_lowercase)
        .filter(|c| c.is_alphanumeric())
        .collect()
}

fn key(name: &str) -> String {
    format!("society_logo:{:x}", Sha256::digest(name.trim().as_bytes()))
}

fn cache_valid(record: &LogoRecord, now: u64, file_exists: bool) -> bool {
    if record.path.is_some() {
        file_exists
    } else {
        !record.custom && record.resolver_version == RESOLVER_VERSION && now < record.retry_after
    }
}

fn producer_id(producers: &Value, name: &str) -> Option<String> {
    let name = identity(name);
    if name.is_empty() {
        return None;
    }
    let mut ids = std::collections::BTreeSet::new();
    for p in producers.as_array()? {
        let aliases = p["aliases"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str);
        if [p["name"].as_str(), p["original"].as_str()]
            .into_iter()
            .flatten()
            .chain(aliases)
            .any(|n| identity(n) == name)
        {
            if let Some(id) = p["id"].as_str().filter(|id| valid_id(id, Some('p'))) {
                ids.insert(id.to_string());
            }
        }
    }
    (ids.len() == 1).then(|| ids.into_iter().next()).flatten()
}

fn valid_id(id: &str, prefix: Option<char>) -> bool {
    let digits = match prefix {
        Some(p) => match id.strip_prefix(p) {
            Some(s) => s,
            None => return false,
        },
        None => id,
    };
    !digits.is_empty() && digits.len() <= 12 && digits.bytes().all(|b| b.is_ascii_digit())
}

fn bangumi_brand(people: &Value, name: &str) -> Option<(String, Option<String>)> {
    let mut found = std::collections::BTreeMap::new();
    for p in people.as_array()? {
        if !matches!(p["type"].as_u64(), Some(2 | 3))
            || identity(p["name"].as_str().unwrap_or("")) != identity(name)
        {
            continue;
        }
        if !matches!(
            p["relation"].as_str(),
            Some("开发" | "游戏开发" | "製作" | "制作" | "游戏制作")
        ) {
            continue;
        }
        let Some(id) = p["id"].as_u64().filter(|id| *id > 0) else {
            continue;
        };
        let image = ["large", "medium", "small"]
            .into_iter()
            .filter_map(|size| p["images"][size].as_str())
            .find(|url| url.starts_with("https://") && !url.contains("no_icon"))
            .map(str::to_owned);
        found.insert(id.to_string(), image);
    }
    (found.len() == 1)
        .then(|| found.into_iter().next())
        .flatten()
}

async fn read(db: &SqlitePool, key: &str) -> CmdResult<Option<LogoRecord>> {
    Ok(super::settings::settings_get_impl(db, key)
        .await?
        .and_then(|v| serde_json::from_str(&v).ok()))
}

async fn persist(db: &SqlitePool, key: &str, record: &LogoRecord) -> CmdResult<()> {
    sqlx::query("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .bind(key).bind(serde_json::to_string(record).map_err(|e| CmdError(e.to_string()))?).execute(db).await?;
    Ok(())
}

fn expose(app: &AppHandle, mut record: LogoRecord) -> LogoRecord {
    if let Some(path) = &record.path {
        if std::path::Path::new(path).is_file() {
            crate::allow_asset_file(app, path);
        } else {
            record.path = None;
        }
    }
    record
}

async fn nextmoe_logo(
    client: &reqwest::Client,
    db: &SqlitePool,
    reference: &str,
) -> CmdResult<Option<String>> {
    // Anonymous API quota is 30/minute. Space these requests even across folders.
    let mut last = NEXTMOE_REQUEST.lock().await;
    if let Some(at) = *last {
        tokio::time::sleep(Duration::from_millis(2100).saturating_sub(at.elapsed())).await;
    }
    *last = Some(std::time::Instant::now());
    let mut request = client
        .get("https://api.nextmoe.dev/v2/catalog/companies")
        .query(&[("refs", reference), ("include", "logo"), ("nsfw", "true")]);
    if let Some(api_key) = super::settings::settings_get_impl(db, super::metadata::NEXTMOE_KEY)
        .await?
        .filter(|v| !v.trim().is_empty())
    {
        request = request.bearer_auth(api_key.trim());
    }
    let response: Value = request
        .send()
        .await
        .map_err(|e| CmdError(e.to_string()))?
        .error_for_status()
        .map_err(|e| CmdError(e.to_string()))?
        .json()
        .await
        .map_err(|e| CmdError(e.to_string()))?;
    let Some(items) = response["items"]
        .as_array()
        .filter(|items| items.len() == 1)
    else {
        return Ok(None);
    };
    Ok(items[0]["logo"]["url"]
        .as_str()
        .filter(|url| url.starts_with("https://"))
        .map(str::to_owned))
}

async fn candidates(db: &SqlitePool, name: &str) -> CmdResult<(Vec<(String, &'static str)>, bool)> {
    let rows: Vec<(Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT DISTINCT vndb_id,bangumi_id FROM games WHERE trim(developer)=? ORDER BY id LIMIT 3",
    )
    .bind(name)
    .fetch_all(db)
    .await?;
    let client = crate::metadata::http_client()?;
    let mut urls = Vec::new();
    let mut network_failed = false;
    // Resolve an actual credited producer from a known work before requesting its logo.
    let ids: Vec<_> = rows
        .iter()
        .filter_map(|(id, _)| id.as_ref())
        .filter(|id| valid_id(id, Some('v')))
        .collect();
    if !ids.is_empty() {
        let filters = if ids.len() == 1 {
            json!(["id", "=", ids[0]])
        } else {
            let mut filters = vec![json!("or")];
            filters.extend(ids.iter().map(|id| json!(["id", "=", id])));
            Value::Array(filters)
        };
        let result = async {
            let value: Value = client.post("https://api.vndb.org/kana/vn").json(&json!({"filters":filters,"fields":"developers.id,developers.name,developers.original,developers.aliases","results":3}))
                .send().await?.error_for_status()?.json().await?;
            Ok::<_, reqwest::Error>(value)
        }.await;
        match result {
            Ok(value) => {
                let mut producers = Vec::new();
                for work in value["results"].as_array().into_iter().flatten() {
                    producers.extend(work["developers"].as_array().into_iter().flatten().cloned());
                }
                if let Some(id) = producer_id(&Value::Array(producers), name) {
                    match nextmoe_logo(&client, db, &format!("vndb:{id}")).await {
                        Ok(Some(url)) => urls.push((url, "nextmoe")),
                        Ok(None) => {}
                        Err(_) => network_failed = true,
                    }
                }
            }
            Err(_) => network_failed = true,
        }
    }
    {
        let token = crate::bangumi_sync::credentials::load().ok().flatten();
        for id in rows
            .iter()
            .filter_map(|(_, id)| id.as_ref())
            .filter(|id| valid_id(id, None))
            .take(2)
        {
            let mut request = client.get(format!("https://api.bgm.tv/v0/subjects/{id}/persons"));
            if let Some(token) = &token {
                request = request.bearer_auth(token);
            }
            let result = async {
                request
                    .send()
                    .await?
                    .error_for_status()?
                    .json::<Value>()
                    .await
            }
            .await;
            match result {
                Ok(value) => {
                    if let Some((id, image)) = bangumi_brand(&value, name) {
                        if urls.is_empty() {
                            match nextmoe_logo(&client, db, &format!("bangumi:{id}")).await {
                                Ok(Some(url)) => urls.push((url, "nextmoe")),
                                Ok(None) => {}
                                Err(_) => network_failed = true,
                            }
                        }
                        if let Some(image) = image {
                            urls.push((image, "bangumi"));
                        }
                        if !urls.is_empty() {
                            break;
                        }
                    }
                }
                Err(_) => network_failed = true,
            }
        }
    }
    Ok((urls, network_failed))
}

/// Return cached artwork immediately; unresolved societies share a bounded background queue.
#[tauri::command]
pub async fn society_logo_get(app: AppHandle, name: String) -> CmdResult<LogoRecord> {
    let name = name.trim();
    if name.is_empty() {
        return Ok(LogoRecord::default());
    }
    if name.chars().count() > 300 {
        return Err(CmdError("社团名称过长".into()));
    }
    let db = super::games::pool(&app).await?;
    let key = key(name);
    if let Some(record) = read(&db, &key).await? {
        if record.custom
            || cache_valid(
                &record,
                now(),
                record
                    .path
                    .as_ref()
                    .is_some_and(|p| std::path::Path::new(p).is_file()),
            )
        {
            return Ok(expose(&app, record));
        }
    }
    let _queue = RESOLVER.lock().await;
    let before = super::settings::settings_get_impl(&db, &key).await?;
    if let Some(record) = read(&db, &key).await? {
        if record.custom
            || cache_valid(
                &record,
                now(),
                record
                    .path
                    .as_ref()
                    .is_some_and(|p| std::path::Path::new(p).is_file()),
            )
        {
            return Ok(expose(&app, record));
        }
    }
    let (urls, mut failed) = candidates(&db, name).await?;
    let mut record = LogoRecord {
        checked_at: now(),
        resolver_version: RESOLVER_VERSION,
        ..Default::default()
    };
    for (url, source) in urls {
        match super::covers::retain(&app.path().app_data_dir()?.join("society-logos"), &url).await {
            Ok(path) => {
                record.path = Some(path);
                record.source = Some(source.into());
                break;
            }
            Err(_) => failed = true,
        }
    }
    if record.path.is_none() {
        let client = crate::metadata::http_client()?;
        let context = sources::context(&client, &db, name).await?;
        failed |= context.failed;
        match sources::bangumi_search(&client, &context).await {
            Ok(Some(url)) => {
                match super::covers::retain(&app.path().app_data_dir()?.join("society-logos"), &url)
                    .await
                {
                    Ok(path) => {
                        record.path = Some(path);
                        record.source = Some("bangumi".into());
                    }
                    Err(_) => failed = true,
                }
            }
            Ok(None) => {}
            Err(_) => failed = true,
        }
        if record.path.is_none() {
            match sources::wikidata(&client, &context).await {
                Ok(Some(url)) => match super::covers::retain(
                    &app.path().app_data_dir()?.join("society-logos"),
                    &url,
                )
                .await
                {
                    Ok(path) => {
                        record.path = Some(path);
                        record.source = Some("wikidata".into());
                    }
                    Err(_) => failed = true,
                },
                Ok(None) => {}
                Err(_) => failed = true,
            }
        }
    }
    record.retry_after = now() + if failed { 15 * 60 } else { 24 * 60 * 60 };
    // A local override or reset that happened during HTTP must win, including reset-to-null.
    let raw = serde_json::to_string(&record).map_err(|e| CmdError(e.to_string()))?;
    let updated = sqlx::query("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE settings.value IS ?")
        .bind(&key).bind(raw).bind(before).execute(&db).await?;
    if updated.rows_affected() == 0 {
        return Ok(expose(&app, read(&db, &key).await?.unwrap_or_default()));
    }
    Ok(expose(&app, record))
}

/// Copy a local override into managed storage, or clear the override for automatic lookup.
#[tauri::command]
pub async fn society_logo_set(
    app: AppHandle,
    name: String,
    path: Option<String>,
) -> CmdResult<LogoRecord> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 300 {
        return Err(CmdError("无效的社团名称".into()));
    }
    let db = super::games::pool(&app).await?;
    let record = if let Some(path) = path {
        if !std::path::Path::new(&path).is_file() {
            return Err(CmdError("找不到 Logo 图片".into()));
        }
        let path =
            super::covers::retain(&app.path().app_data_dir()?.join("society-logos"), &path).await?;
        LogoRecord {
            path: Some(path),
            custom: true,
            source: Some("custom".into()),
            checked_at: now(),
            retry_after: 0,
            resolver_version: RESOLVER_VERSION,
        }
    } else {
        LogoRecord::default()
    };
    persist(&db, &key(name), &record).await?;
    Ok(expose(&app, record))
}

#[cfg(test)]
#[path = "society_logos_tests.rs"]
mod tests;
