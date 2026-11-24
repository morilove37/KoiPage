//! The user-configured outbound proxy.
//!
//! Configuration lives in the `settings` table so it survives restarts and rides
//! along with the existing backup format. Because every HTTP client in the app is
//! built at arbitrary call sites (providers, AI assistant, share uploader,
//! verification window), the parsed [`reqwest::Proxy`] is cached in a
//! process-wide cell instead of being threaded through function signatures.
//!
//! [`reload`] is the single writer: the frontend calls it on launch and the
//! settings commands call it after every save. Until then the cell is empty and
//! requests go direct, which is the default state.

use std::sync::{OnceLock, RwLock};

use reqwest::{Proxy, Url};
use sqlx::{Pool, Sqlite};

use crate::commands::error::{CmdError, CmdResult};

/// Settings key: `"1"` when the proxy is enabled, anything else (or absent) when not.
pub const PROXY_ENABLED_KEY: &str = "network_proxy_enabled";

/// Settings key: the proxy address, e.g. `http://127.0.0.1:7890`.
pub const PROXY_URL_KEY: &str = "network_proxy_url";

/// Schemes reqwest can actually dial.
///
/// `socks4a`/`socks5h` are included because they resolve DNS on the proxy side,
/// which is exactly what a blocked or poisoned resolver needs.
const ALLOWED_SCHEMES: [&str; 6] = ["http", "https", "socks4", "socks4a", "socks5", "socks5h"];

/// What the settings UI shows and edits.
#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyConfig {
    pub enabled: bool,
    /// Empty when the user has not configured one yet.
    pub url: String,
}

impl ProxyConfig {
    /// The proxy address in the form [`Url`] and the UI both understand, or
    /// `None` when the feature is off.
    pub fn active_url(&self) -> Option<&str> {
        if !self.enabled || self.url.is_empty() {
            return None;
        }
        Some(&self.url)
    }
}

static CACHE: OnceLock<RwLock<Option<Proxy>>> = OnceLock::new();
/// The address behind [`CACHE`], kept separately so error messages can name it.
static URL_CACHE: OnceLock<RwLock<Option<String>>> = OnceLock::new();

fn cache() -> &'static RwLock<Option<Proxy>> {
    CACHE.get_or_init(|| RwLock::new(None))
}

fn url_cache() -> &'static RwLock<Option<String>> {
    URL_CACHE.get_or_init(|| RwLock::new(None))
}

/// Accept the shapes users actually type.
///
/// `127.0.0.1:7890` and `localhost:1080` are common enough that rejecting them
/// for a missing scheme would be hostile; everything else is validated so a typo
/// surfaces in the settings form instead of as a mysterious "network error"
/// hours later.
pub fn normalise_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("请填写代理地址，例如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080".into());
    }
    let with_scheme = if trimmed.contains("://") { trimmed.to_string() } else { format!("http://{trimmed}") };
    let url = Url::parse(&with_scheme).map_err(|error| format!("代理地址格式不正确：{error}"))?;

    if !ALLOWED_SCHEMES.contains(&url.scheme()) {
        return Err(format!(
            "代理协议 {} 不受支持，请使用 http、https、socks4 或 socks5",
            url.scheme()
        ));
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err("代理地址缺少主机名，例如 http://127.0.0.1:7890".into());
    }
    if url.port().is_none() {
        return Err("代理地址需要包含端口，例如 http://127.0.0.1:7890".into());
    }
    // Special schemes (http/https) always carry "/" as their empty path, while
    // socks5 and friends report "". Both mean "no path given".
    let path_is_empty = url.path().is_empty() || url.path() == "/";
    if !path_is_empty || url.query().is_some() || url.fragment().is_some() {
        return Err("代理地址只应包含协议、主机和端口，不要带路径".into());
    }

    // Drop the trailing slash `Url` adds for special schemes so the stored value
    // matches what the user typed. `set_path("")` is not enough: it serialises
    // back to "/" for http/https/socks.
    Ok(url.as_str().trim_end_matches('/').to_string())
}

/// Turn a stored configuration into a live proxy, validating as it goes.
pub fn build(config: &ProxyConfig) -> Result<Option<Proxy>, String> {
    let Some(raw) = config.active_url() else { return Ok(None) };
    let normalised = normalise_url(raw)?;
    let url = Url::parse(&normalised).map_err(|error| format!("代理地址格式不正确：{error}"))?;
    Proxy::all(url).map(Some).map_err(|error| format!("无法使用该代理地址：{error}"))
}

/// Read the configuration out of the database.
pub async fn load(pool: &Pool<Sqlite>) -> CmdResult<ProxyConfig> {
    let enabled = crate::commands::settings::settings_get_impl(pool, PROXY_ENABLED_KEY).await?;
    let url = crate::commands::settings::settings_get_impl(pool, PROXY_URL_KEY).await?;
    Ok(ProxyConfig {
        enabled: enabled.as_deref() == Some("1"),
        url: url.unwrap_or_default(),
    })
}

/// Refresh the cached proxy from the database.
///
/// Called once at startup and again after every save, so a change takes effect
/// on the next request without restarting the app.
pub async fn reload(pool: &Pool<Sqlite>) -> CmdResult<ProxyConfig> {
    let config = load(pool).await?;
    match build(&config) {
        Ok(proxy) => {
            let url = config.active_url().map(str::to_string);
            if let Ok(mut slot) = cache().write() {
                *slot = proxy;
            }
            if let Ok(mut slot) = url_cache().write() {
                *slot = url;
            }
            Ok(config)
        }
        Err(message) => {
            // A broken address must not keep a stale proxy alive: clear it and
            // let the settings form show the error.
            if let Ok(mut slot) = cache().write() {
                *slot = None;
            }
            if let Ok(mut slot) = url_cache().write() {
                *slot = None;
            }
            Err(CmdError(message))
        }
    }
}

/// Install a proxy without touching the database (used by [`reload`] and tests).
pub fn install(proxy: Option<Proxy>) {
    install_with_url(proxy, None);
}

/// Install a proxy together with the address it came from.
pub fn install_with_url(proxy: Option<Proxy>, url: Option<String>) {
    if let Ok(mut slot) = cache().write() {
        *slot = proxy;
    }
    if let Ok(mut slot) = url_cache().write() {
        *slot = url;
    }
}

/// The proxy every outgoing request should use, if any.
pub fn current() -> Option<Proxy> {
    cache().read().ok().and_then(|slot| slot.clone())
}

/// The address currently in effect, for user-facing messages.
pub fn active_url() -> Option<String> {
    url_cache().read().ok().and_then(|slot| slot.clone())
}

/// Suffix appended to transport failures while a proxy is configured.
///
/// Without it a stopped proxy client looks exactly like a dead website — the
/// most confusing failure this setting can produce — so every request error
/// says which proxy was in the way and how to get around it.
pub fn failure_hint() -> String {
    hint_for(active_url().as_deref())
}

fn hint_for(url: Option<&str>) -> String {
    match url {
        Some(url) => format!("（当前通过代理 {url} 访问：请确认代理软件已启动并监听该端口，或在设置里关闭代理）"),
        None => String::new(),
    }
}

/// Attach the configured proxy to a client builder.
///
/// Providers and the AI assistant all go through this so one setting covers the
/// whole app rather than only the 2DFan panel.
pub fn apply(builder: reqwest::ClientBuilder) -> reqwest::ClientBuilder {
    match current() {
        Some(proxy) => builder.proxy(proxy),
        None => builder,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bare_host_and_port_gains_the_http_scheme() {
        assert_eq!(normalise_url("127.0.0.1:7890").as_deref(), Ok("http://127.0.0.1:7890"));
        assert_eq!(normalise_url(" localhost:1080 ").as_deref(), Ok("http://localhost:1080"));
    }

    #[test]
    fn supported_schemes_survive_untouched() {
        for url in [
            "http://127.0.0.1:7890",
            "https://proxy.example.com:8443",
            "socks5://127.0.0.1:1080",
            "socks5h://127.0.0.1:1080",
            "socks4://127.0.0.1:1080",
        ] {
            assert_eq!(normalise_url(url).as_deref(), Ok(url), "{url} should round-trip");
        }
    }

    #[test]
    fn a_trailing_slash_is_not_part_of_the_address() {
        assert_eq!(normalise_url("http://127.0.0.1:7890/").as_deref(), Ok("http://127.0.0.1:7890"));
    }

    #[test]
    fn a_missing_port_is_reported_rather_than_guessed() {
        let error = normalise_url("http://127.0.0.1").unwrap_err();
        assert!(error.contains("端口"), "{error}");
    }

    #[test]
    fn unknown_schemes_name_the_alternatives() {
        let error = normalise_url("ftp://127.0.0.1:21").unwrap_err();
        assert!(error.contains("socks5"), "{error}");
    }

    #[test]
    fn a_path_is_rejected_instead_of_silently_ignored() {
        let error = normalise_url("http://127.0.0.1:7890/pac").unwrap_err();
        assert!(error.contains("路径"), "{error}");
    }

    #[test]
    fn an_empty_address_is_refused() {
        assert!(normalise_url("   ").is_err());
    }

    #[test]
    fn a_stopped_proxy_client_is_named_in_the_failure_message() {
        // Without the address a stopped client reads as a dead website.
        let hint = hint_for(Some("http://127.0.0.1:7890"));
        assert!(hint.contains("127.0.0.1:7890"), "{hint}");
        assert!(hint.contains("代理软件已启动"), "{hint}");
        // Direct connections must not blame a proxy that is not configured.
        assert_eq!(hint_for(None), "");
    }

    #[test]
    fn the_config_only_produces_a_proxy_when_enabled_and_filled_in() {
        let off = ProxyConfig { enabled: false, url: "http://127.0.0.1:7890".into() };
        assert!(build(&off).unwrap().is_none());
        let blank = ProxyConfig { enabled: true, url: String::new() };
        assert!(build(&blank).unwrap().is_none());
        let on = ProxyConfig { enabled: true, url: "http://127.0.0.1:7890".into() };
        assert!(build(&on).unwrap().is_some());
    }

    #[test]
    fn a_broken_stored_address_does_not_produce_a_proxy() {
        let broken = ProxyConfig { enabled: true, url: "not a url".into() };
        assert!(build(&broken).is_err());
    }
}
