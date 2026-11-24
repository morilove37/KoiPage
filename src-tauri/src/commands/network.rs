//! Settings for the outbound proxy used by every metadata request.
//!
//! The commands live here rather than in `settings.rs` because saving one must
//! do more than write a row: the live [`crate::net::proxy`] cache has to be
//! refreshed, or the change would not take effect until the next launch.

use tauri::AppHandle;

use super::error::CmdResult;
use super::games::pool;
use crate::net::proxy::{self, ProxyConfig, PROXY_ENABLED_KEY, PROXY_URL_KEY};

/// `network_proxy_get` — what the settings form should display.
#[tauri::command]
pub async fn network_proxy_get(app: AppHandle) -> CmdResult<ProxyConfig> {
    let pool = pool(&app).await?;
    proxy::load(&pool).await
}

/// `network_proxy_save` — persist and apply immediately.
///
/// The address is validated before anything is written, so a typo cannot leave
/// the app with a saved-but-unusable proxy. On success the cached proxy is
/// replaced, which makes the next 2DFan/VNDB/AI request use it.
#[tauri::command]
pub async fn network_proxy_save(app: AppHandle, config: ProxyConfig) -> CmdResult<ProxyConfig> {
    let pool = pool(&app).await?;
    // Validate first: `reload` would otherwise store the value and only then
    // complain, leaving the form showing something the app cannot use.
    if config.enabled && !config.url.trim().is_empty() {
        proxy::normalise_url(&config.url).map_err(super::error::CmdError)?;
    }

    let url = if config.url.trim().is_empty() { None } else { Some(config.url.trim().to_string()) };
    write(&pool, PROXY_ENABLED_KEY, Some(if config.enabled { "1".to_string() } else { "0".to_string() })).await?;
    write(&pool, PROXY_URL_KEY, url).await?;
    proxy::reload(&pool).await
}

/// `network_proxy_test` — try one request through the given address.
///
/// Uses a host the app already talks to, so a success here means the proxy
/// really works for the metadata providers rather than only for the test.
#[tauri::command]
pub async fn network_proxy_test(config: ProxyConfig) -> CmdResult<String> {
    let proxy = proxy::build(&config).map_err(super::error::CmdError)?;
    let mut builder = reqwest::Client::builder()
        .user_agent(crate::metadata::USER_AGENT)
        .timeout(std::time::Duration::from_secs(15));
    if let Some(proxy) = proxy {
        builder = builder.proxy(proxy);
    }
    let client = builder.build().map_err(|error| super::error::CmdError(format!("无法创建测试连接：{error}")))?;

    let started = std::time::Instant::now();
    let response = client
        .get("https://api.vndb.org/kana/schema")
        .send()
        .await
        .map_err(|error| super::error::CmdError(format!("代理连接失败：{error}")))?;
    let status = response.status();
    // VNDB answers this endpoint with a schema document; any HTTP answer proves
    // the tunnel works, so only transport errors count as failure.
    let elapsed = started.elapsed().as_millis();
    Ok(format!("连接成功（HTTP {}，{} 毫秒）", status.as_u16(), elapsed))
}

/// Upsert one settings row.
///
/// `settings_set` is a command and needs an `AppHandle`; the proxy save already
/// holds a pool, so it writes directly instead of routing through it.
async fn write(pool: &sqlx::Pool<sqlx::Sqlite>, key: &str, value: Option<String>) -> CmdResult<()> {
    sqlx::query(
        "INSERT INTO settings (key, value) VALUES (?, ?) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(key)
    .bind(&value)
    .execute(pool)
    .await?;
    Ok(())
}
