//! The isolated 2DFan browser session, never exposed to the application frontend.

use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri::webview::{Cookie, NewWindowResponse};
use super::{CmdError, CmdResult};

const LABEL: &str = "twodfan-verification";
const HOME: &str = "https://2dfan.com/";
static APP: OnceLock<AppHandle> = OnceLock::new();
static WINDOW_LOCK: Mutex<()> = Mutex::new(());

pub fn remember_app(app: AppHandle) { let _ = APP.set(app); }

pub(super) fn allowed_navigation(url: &reqwest::Url) -> bool {
    url.scheme() == "https" && url.port_or_known_default() == Some(443)
        && url.username().is_empty() && url.password().is_none()
        && matches!(url.host_str(), Some("2dfan.com" | "www.2dfan.com"))
}

fn browser_user_agent(version: &str) -> String {
    let parts: Vec<_> = version.split('.').collect();
    let version = if parts.len() == 4 && parts.iter().all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit())) {
        version
    } else { "120.0.0.0" };
    format!("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{version} Safari/537.36 Edg/{version}")
}

pub(super) fn user_agent() -> &'static str {
    static UA: OnceLock<String> = OnceLock::new();
    UA.get_or_init(|| {
        #[cfg(windows)]
        { browser_user_agent(&tauri::webview_version().unwrap_or_default()) }
        #[cfg(not(windows))]
        { super::USER_AGENT.into() }
    })
}

fn cookie_header(url: &reqwest::Url, mut cookies: Vec<Cookie<'static>>) -> Option<reqwest::header::HeaderValue> {
    // WebView2 already scopes GetCookies to this URL. Check again here so no
    // credentials can reach an image host, redirect destination or test server.
    if !allowed_navigation(url) { return None; }
    cookies.retain(|cookie| {
        let domain = cookie.domain().unwrap_or("").trim_start_matches('.');
        let host = url.host_str().unwrap_or("");
        // cookies_for_url has already applied the host-only/domain flag. A
        // site-wide cookie for .2dfan.com is valid on the allowed www origin.
        let domain_matches = domain == host || (domain == "2dfan.com" && host == "www.2dfan.com");
        let path = cookie.path().unwrap_or("/");
        let path_matches = url.path() == path || (url.path().starts_with(path)
            && (path.ends_with('/') || url.path().as_bytes().get(path.len()) == Some(&b'/')));
        domain_matches && path_matches
            && cookie.expires_datetime().is_none_or(|date| date > time::OffsetDateTime::now_utc())
            && cookie.max_age().is_none_or(|age| age.whole_seconds() > 0)
            && !cookie.name().is_empty()
            && cookie.name().bytes().all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
            && cookie.value().bytes().all(|b| b >= 0x21 && b <= 0x7e && !b"\";,\\".contains(&b))
    });
    // A specific path takes precedence when the same cookie name exists twice.
    cookies.sort_by_key(|cookie| std::cmp::Reverse(cookie.path().unwrap_or("/").len()));
    let value = cookies.iter().map(|cookie| format!("{}={}", cookie.name(), cookie.value())).collect::<Vec<_>>().join("; ");
    if value.is_empty() { None } else { reqwest::header::HeaderValue::from_str(&value).ok() }
}

fn session_window(app: &AppHandle, create: bool) -> CmdResult<Option<WebviewWindow>> {
    let _guard = WINDOW_LOCK.lock().map_err(|_| CmdError("2DFan 验证窗口正忙，请重试".into()))?;
    if let Some(window) = app.get_webview_window(LABEL) { return Ok(Some(window)); }
    let directory = app.path().app_local_data_dir()?.join("web-sessions").join("2dfan");
    // Do not create a browser profile until the user explicitly opens verification.
    // An existing profile can be restored hidden after an application restart.
    if !create && !directory.is_dir() { return Ok(None); }
    std::fs::create_dir_all(&directory).map_err(|_| CmdError("无法创建 2DFan 独立会话目录".into()))?;
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External(HOME.parse().unwrap()))
        .title("2DFan · 登录 / 访问验证（完成后返回恋页重试）")
        .inner_size(1080.0, 760.0).min_inner_size(720.0, 540.0)
        .visible(false).data_directory(directory).user_agent(user_agent())
        .devtools(false).general_autofill_enabled(false)
        .on_navigation(allowed_navigation)
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .on_download(|_, _| false)
        .build().map_err(|_| CmdError("无法打开 2DFan 验证窗口，请检查 WebView2 运行环境".into()))?;
    let close_window = window.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = close_window.hide();
        }
    });
    // No capability includes this label or remote origin. Tauri 2.12 rejects
    // remote custom commands too. Never add an IPC bridge or page-reading script.
    Ok(Some(window))
}

/// Runs outside the UI thread: native cookie reads otherwise deadlock on Windows.
pub(super) async fn session_cookie(url: &reqwest::Url) -> CmdResult<Option<reqwest::header::HeaderValue>> {
    if !allowed_navigation(url) { return Ok(None); }
    let Some(app) = APP.get().cloned() else { return Ok(None); };
    let url = url.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let Some(window) = session_window(&app, false)? else { return Ok(None); };
        let cookies = window.cookies_for_url(url.clone()).map_err(|_| CmdError("读取 2DFan 会话失败，请重新打开登录 / 验证窗口后重试".into()))?;
        Ok(cookie_header(&url, cookies))
    }).await.map_err(|_| CmdError("读取 2DFan 会话失败，请重试".into()))?
}

#[tauri::command]
pub async fn twodfan_verification_open(app: AppHandle, window: WebviewWindow) -> CmdResult<()> {
    if window.label() != "main" { return Err(CmdError("此窗口无权打开站点验证".into())); }
    tauri::async_runtime::spawn_blocking(move || {
        let window = session_window(&app, true)?.ok_or_else(|| CmdError("无法创建 2DFan 验证窗口".into()))?;
        window.show()?;
        window.unminimize()?;
        window.set_focus()?;
        Ok(())
    }).await.map_err(|_| CmdError("打开 2DFan 验证窗口失败".into()))?
}

#[tauri::command]
pub async fn twodfan_verification_sync(app: AppHandle, window: WebviewWindow) -> CmdResult<()> {
    if window.label() != "main" { return Err(CmdError("此窗口无权读取站点会话".into())); }
    tauri::async_runtime::spawn_blocking(move || {
        let window = app.get_webview_window(LABEL).ok_or_else(|| CmdError("请先打开 2DFan 登录 / 验证窗口".into()))?;
        // Validate native cookie access before retrying, without returning any
        // cookie names, values, user identities or authentication claims to JS.
        window.cookies_for_url(HOME.parse().unwrap()).map_err(|_| CmdError("读取 2DFan 会话失败，请重新打开验证窗口后重试".into()))?;
        window.hide()?;
        Ok(())
    }).await.map_err(|_| CmdError("同步 2DFan 会话失败，请重试".into()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::webview::Cookie;

    #[test]
    fn navigation_accepts_only_exact_https_site_origins() {
        for value in ["https://2dfan.com/", "https://www.2dfan.com/users/sign_in", "https://2dfan.com:443/search"] {
            assert!(allowed_navigation(&value.parse().unwrap()), "{value}");
        }
        for value in ["http://2dfan.com/", "https://2dfan.com:8443/", "https://2dfan.com.evil.test/", "https://evil2dfan.com/", "https://2dfan.com@evil.test/", "https://user@2dfan.com/", "file:///C:/private", "tauri://localhost/", "https://challenges.cloudflare.com/"] {
            assert!(!allowed_navigation(&value.parse().unwrap()), "{value}");
        }
    }

    #[test]
    fn session_header_keeps_httponly_and_respects_domain_path_secure_and_expiry() {
        let url = "https://2dfan.com/subjects/21".parse().unwrap();
        let cookies = vec![
            Cookie::build(("session", "private")).domain(".2dfan.com").path("/").http_only(true).secure(true).build(),
            Cookie::build(("detail", "yes")).domain("2dfan.com").path("/subjects").build(),
            Cookie::build(("wrong_path", "no")).domain("2dfan.com").path("/subject").build(),
            Cookie::build(("admin", "no")).domain("2dfan.com").path("/admin").build(),
            Cookie::build(("other", "no")).domain("evil.test").path("/").build(),
            Cookie::build(("subdomain", "no")).domain("www.2dfan.com").path("/").build(),
            Cookie::build(("expired", "no")).domain("2dfan.com").path("/").expires(time::OffsetDateTime::UNIX_EPOCH).build(),
        ];
        let header = cookie_header(&url, cookies).unwrap();
        assert_eq!(header.to_str().unwrap(), "detail=yes; session=private");
    }

    #[test]
    fn session_never_leaks_to_an_untrusted_url_or_through_header_injection() {
        let cookie = || Cookie::build(("session", "secret")).domain("2dfan.com").path("/").build();
        for value in ["https://evil.test/", "http://2dfan.com/", "https://2dfan.com:444/", "http://127.0.0.1/search"] {
            assert!(cookie_header(&value.parse().unwrap(), vec![cookie()]).is_none());
        }
        assert!(cookie_header(&"https://2dfan.com/".parse().unwrap(), vec![
            Cookie::build(("session", "secret\r\nInjected: yes")).domain("2dfan.com").path("/").build(),
            Cookie::build(("bad;name", "value")).domain("2dfan.com").path("/").build(),
        ]).is_none());
    }

    #[test]
    fn site_domain_cookies_can_be_used_on_the_www_origin() {
        let header = cookie_header(&"https://www.2dfan.com/search".parse().unwrap(), vec![
            Cookie::build(("session", "shared")).domain(".2dfan.com").path("/").build(),
        ]).expect("native URL-scoped domain cookie");
        assert_eq!(header.to_str().unwrap(), "session=shared");
    }

    #[test]
    fn browser_agent_uses_only_a_valid_installed_runtime_version() {
        let ua = browser_user_agent("142.0.3595.94");
        assert!(ua.contains("Chrome/142.0.3595.94"));
        assert!(ua.contains("Edg/142.0.3595.94"));
        assert!(browser_user_agent("142.0\r\nInjected: yes").contains("Chrome/120.0.0.0"));
    }
}
