mod client;
mod consent;
mod credentials;
mod deletion;
mod history;
mod library;
pub mod model;
mod runtime;
use crate::commands::error::{CmdError, CmdResult};
use model::*;
use reqwest::Method;
pub use runtime::{FriendsState, stop};
use serde::Deserialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthInput {
    mode: String,
    username: String,
    password: String,
    #[serde(default)]
    nickname: String,
    #[serde(default)]
    invite_code: String,
    #[serde(default)]
    reset_code: String,
    #[serde(default)]
    consent: Option<consent::RegistrationConsent>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    share_game: bool,
    #[serde(default)]
    share_library: bool,
    #[serde(default)]
    share_history: bool,
    invisible: bool,
    hidden_game_ids: Vec<i64>,
}

#[tauri::command]
pub async fn friends_library_games(app: AppHandle) -> CmdResult<Vec<HideableGame>> {
    runtime::ensure(&app).await;
    let state = app.state::<FriendsState>();
    {
        let inner = state.inner.lock().await;
        if inner.account.is_none()
            || !inner.config.enabled
            || state.stopping.load(std::sync::atomic::Ordering::SeqCst)
        {
            return Err(CmdError("FRIENDS_SESSION: 请先登录".into()));
        }
    }
    Ok(sqlx::query_as::<_, HideableGame>(
        "SELECT id,title,original_title FROM games ORDER BY title,id",
    )
    .fetch_all(&crate::commands::games::pool(&app).await?)
    .await?)
}

#[tauri::command]
pub async fn friends_status(app: AppHandle) -> CmdResult<Status> {
    runtime::ensure(&app).await;
    Ok(app.state::<FriendsState>().inner.lock().await.status())
}
#[tauri::command]
pub async fn friends_authenticate(app: AppHandle, input: AuthInput) -> CmdResult<Status> {
    let username = validate_login(&input.username, &input.password)?;
    runtime::ensure(&app).await;
    let state = app.state::<FriendsState>();
    let mut inner = state.inner.lock().await;
    inner.allow_account_change()?;
    validate_project(&inner.config.server_url, &inner.config.public_key)?;
    if inner.config.server_url.trim_end_matches('/') == Config::default().server_url {
        consent::validate(input.consent.as_ref(), &inner.config.server_url)?;
    }
    let api = client::Api::new(&inner.config)?;
    let email = format!("{username}@accounts.koipage.invalid");
    let tokens = match input.mode.as_str() {
        "login" => api.password_login(&username, &input.password).await?,
        "register" => {
            consent::validate(input.consent.as_ref(), &inner.config.server_url)?;
            let nickname = if input.nickname.trim().is_empty() {
                username.clone()
            } else {
                input.nickname.trim().into()
            };
            if nickname.chars().count() > 32
                || input.invite_code.len() > 128
                || input.invite_code.trim().is_empty()
            {
                return Err(CmdError("FRIENDS_INPUT: 请检查昵称和邀请码".into()));
            }
            api.request(Method::POST,"/functions/v1/friends-register",None,json!({"username":username,"password":input.password,"nickname":nickname,"inviteCode":input.invite_code.trim(),"consent":input.consent})).await?;
            api.password_login(&username, &input.password).await?
        }
        "reset" => {
            if input.reset_code.len() > 512 || input.reset_code.trim().is_empty() {
                return Err(CmdError("FRIENDS_INPUT: 请输入管理员提供的重置码".into()));
            }
            let value = api
                .request(
                    Method::POST,
                    "/auth/v1/verify",
                    None,
                    json!({"type":"recovery","token_hash":input.reset_code.trim()}),
                )
                .await?;
            if value["user"]["email"] != email {
                return Err(CmdError("FRIENDS_INPUT: 重置码与用户名不匹配".into()));
            }
            let tokens = client::parse_tokens(value)?;
            api.request(
                Method::PUT,
                "/auth/v1/user",
                Some(&tokens.access_token),
                json!({"password":input.password}),
            )
            .await?;
            tokens
        }
        _ => return Err(CmdError("FRIENDS_INPUT: 登录方式无效".into())),
    };
    let profile = api
        .rpc("koipage_claim", &tokens.access_token, json!({}))
        .await?;
    let account: Account = serde_json::from_value(profile)
        .map_err(|_| CmdError("FRIENDS_PROTOCOL: 账号资料格式无效".into()))?;
    credentials::save(&inner.config.server_url, &tokens)?;
    let mut config = inner.config.clone();
    config.enabled = true;
    config.share_game = false;
    config.share_library = false;
    config.share_history = false;
    config.invisible = false;
    runtime::save(&app, &config).await?;
    runtime::save_account(&app, &account).await;
    inner.config = config;
    inner.tokens = Some(tokens);
    inner.account = Some(account);
    inner.account_dirty = false;
    inner.seq = 0;
    inner.generation += 1;
    inner.error = None;
    inner.connected = true;
    inner.library_synced_at = None;
    inner.library_error = None;
    inner.history_synced_at = None;
    inner.history_error = None;
    state
        .stopping
        .store(false, std::sync::atomic::Ordering::SeqCst);
    drop(inner);
    // A fresh login starts private even if this account shared a previous snapshot.
    let _ = library::sync(&app, true).await;
    Ok(state.inner.lock().await.status())
}
#[tauri::command]
pub async fn friends_logout(app: AppHandle) -> CmdResult<Status> {
    runtime::ensure(&app).await;
    let state = app.state::<FriendsState>();
    let (config, tokens, mut status) = {
        let mut inner = state.inner.lock().await;
        inner.allow_account_change()?;
        let mut next = inner.config.clone();
        next.enabled = false;
        next.share_game = false;
        next.share_library = false;
        next.share_history = false;
        runtime::save(&app, &next).await?;
        let tokens = inner.tokens.take();
        inner.config = next;
        inner.account = None;
        inner.connected = false;
        inner.error = None;
        inner.library_synced_at = None;
        inner.library_error = None;
        inner.history_synced_at = None;
        inner.history_error = None;
        inner.generation += 1;
        (inner.config.clone(), tokens, inner.status())
    };
    let deletion = credentials::delete(&config.server_url);
    runtime::clear_account(&app).await;
    if let Some(tokens) = tokens {
        if let Ok(api) = client::Api::new(&config) {
            let _ = api
                .rpc(
                    "koipage_history_sync",
                    &tokens.access_token,
                    json!({"p_enabled":false,"p_sessions":[]}),
                )
                .await;
            if let Err(error) = api
                .rpc(
                    "koipage_library_sync",
                    &tokens.access_token,
                    json!({"p_enabled":false,"p_games":[],"p_keys":[]}),
                )
                .await
            {
                status.library_error = Some(format!(
                    "已退出登录，但云端游戏库尚未撤回；请恢复连接并重新登录后关闭分享。{}",
                    error.0
                ));
                let mut inner = state.inner.lock().await;
                if inner.generation == status.generation {
                    inner.library_error = status.library_error.clone();
                }
            }
            let _ = api
                .rpc("koipage_leave", &tokens.access_token, json!({}))
                .await;
            let _ = api
                .request(
                    Method::POST,
                    "/auth/v1/logout?scope=local",
                    Some(&tokens.access_token),
                    json!({}),
                )
                .await;
        }
    }
    deletion?;
    Ok(status)
}
#[tauri::command]
pub async fn friends_preferences(app: AppHandle, input: Preferences) -> CmdResult<Status> {
    if input.hidden_game_ids.len() > 10000 || input.hidden_game_ids.iter().any(|id| *id <= 0) {
        return Err(CmdError("FRIENDS_INPUT: 隐藏作品列表无效".into()));
    }
    runtime::ensure(&app).await;
    let state = app.state::<FriendsState>();
    let mut inner = state.inner.lock().await;
    inner.allow_account_change()?;
    let mut next = inner.config.clone();
    next.share_game = input.share_game;
    next.share_library = input.share_library;
    next.share_history = input.share_history;
    next.invisible = input.invisible;
    next.hidden_game_ids = input.hidden_game_ids;
    next.hidden_game_ids.sort_unstable();
    next.hidden_game_ids.dedup();
    runtime::save(&app, &next).await?;
    inner.config = next;
    inner.generation += 1;
    drop(inner);
    // Persist restrictive choices first. Failed remote updates stay visible and
    // the native worker retries even when the friends page is not open.
    let _ = library::sync(&app, true).await;
    let history_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = history::sync(&history_handle, true).await;
    });
    Ok(state.inner.lock().await.status())
}

#[tauri::command]
pub async fn friends_sync_library(app: AppHandle) -> CmdResult<Status> {
    runtime::ensure(&app).await;
    let _ = library::sync(&app, true).await;
    Ok(app.state::<FriendsState>().inner.lock().await.status())
}

#[tauri::command]
pub async fn friends_profile(
    app: AppHandle,
    target: String,
    query: Option<String>,
    status: Option<String>,
    offset: Option<i32>,
) -> CmdResult<Value> {
    let query = query.unwrap_or_default();
    let offset = offset.unwrap_or(0);
    if query.chars().count() > 200
        || !(0..=10000).contains(&offset)
        || status.as_ref().is_some_and(|value| {
            ![
                "unplayed",
                "wishlist",
                "playing",
                "completed",
                "on_hold",
                "dropped",
            ]
            .contains(&value.as_str())
        })
    {
        return Err(CmdError("FRIENDS_INPUT: 好友或筛选条件无效".into()));
    }
    runtime::ensure(&app).await;
    let state = app.state::<FriendsState>();
    let mut inner = state.inner.lock().await;
    // The frontend routes `/friends/me` as target "me"; resolve it natively so
    // the page never needs to know its own uuid.
    let target = if target == "me" {
        inner
            .account
            .as_ref()
            .map(|account| account.id.clone())
            .ok_or_else(|| CmdError("FRIENDS_SESSION: 请先登录".into()))?
    } else if valid_uuid(&target) {
        target
    } else {
        return Err(CmdError("FRIENDS_INPUT: 好友或筛选条件无效".into()));
    };
    runtime::rpc(
        &mut inner,
        "koipage_friend_profile",
        json!({"p_target":target,"p_query":query,"p_status":status,"p_offset":offset}),
    )
    .await
}
#[tauri::command]
pub async fn friends_snapshot(app: AppHandle, revision: Option<String>) -> CmdResult<Value> {
    runtime::ensure(&app).await;
    let state = app.state::<FriendsState>();
    let mut inner = state.inner.lock().await;
    runtime::rpc(
        &mut inner,
        "koipage_snapshot",
        json!({"p_revision":revision.filter(|s|s.len()<=64)}),
    )
    .await
}
#[tauri::command]
pub async fn friends_action(
    app: AppHandle,
    action: String,
    target: Option<String>,
    value: Option<Value>,
) -> CmdResult<Status> {
    if ![
        "profile", "request", "accept", "reject", "cancel", "remove", "block", "unblock",
    ]
    .contains(&action.as_str())
        || target.as_ref().is_some_and(|s| s.len() > 128)
    {
        return Err(CmdError("FRIENDS_INPUT: 操作无效".into()));
    }
    runtime::ensure(&app).await;
    let state = app.state::<FriendsState>();
    let mut inner = state.inner.lock().await;
    runtime::rpc(
        &mut inner,
        "koipage_mutate",
        json!({"p_action":action,"p_target":target,"p_value":value.unwrap_or(json!({}))}),
    )
    .await?;
    if action == "profile" {
        let profile = runtime::rpc(&mut inner, "koipage_claim", json!({})).await?;
        inner.account = Some(
            serde_json::from_value(profile)
                .map_err(|_| CmdError("FRIENDS_PROTOCOL: 资料格式无效".into()))?,
        );
        inner.account_dirty = false;
        if let Some(account) = inner.account.clone() {
            runtime::save_account(&app, &account).await;
        }
    }
    Ok(inner.status())
}
#[tauri::command]
pub async fn friends_change_password(app: AppHandle, password: String) -> CmdResult<()> {
    runtime::ensure(&app).await;
    let state = app.state::<FriendsState>();
    let mut inner = state.inner.lock().await;
    let name = inner
        .account
        .as_ref()
        .ok_or_else(|| CmdError("FRIENDS_SESSION: 请先登录".into()))?
        .username
        .clone();
    validate_login(&name, &password)?;
    runtime::rpc(&mut inner, "koipage_claim", json!({})).await?;
    let api = client::Api::new(&inner.config)?;
    let token = &inner.tokens.as_ref().unwrap().access_token;
    api.request(
        Method::PUT,
        "/auth/v1/user",
        Some(token),
        json!({"password":password}),
    )
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn friends_search_users(app: AppHandle, query: String) -> CmdResult<Value> {
    let query = search_query(&query)?;
    runtime::ensure(&app).await;
    let state = app.state::<FriendsState>();
    let mut inner = state.inner.lock().await;
    runtime::rpc(&mut inner, "koipage_search_users", json!({"p_query":query})).await
}

#[tauri::command]
pub async fn friends_request_user(app: AppHandle, target: String) -> CmdResult<Value> {
    if !valid_uuid(&target) {
        return Err(CmdError("FRIENDS_INPUT: 好友目标无效".into()));
    }
    runtime::ensure(&app).await;
    let state = app.state::<FriendsState>();
    let mut inner = state.inner.lock().await;
    runtime::rpc(
        &mut inner,
        "koipage_friend_request",
        json!({"p_target":target}),
    )
    .await
}

fn valid_game_key(value: &str) -> bool {
    (1..=160).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b':' | b'_' | b'-'))
}

#[tauri::command]
pub async fn friends_report(
    app: AppHandle,
    target: String,
    game_key: Option<String>,
    reason: String,
    detail: Option<String>,
) -> CmdResult<Value> {
    if !valid_uuid(&target) {
        return Err(CmdError("FRIENDS_INPUT: 举报对象无效".into()));
    }
    if !["cover", "content", "other"].contains(&reason.as_str()) {
        return Err(CmdError("FRIENDS_INPUT: 举报原因无效".into()));
    }
    let detail = detail.unwrap_or_default();
    if detail.chars().count() > 500 {
        return Err(CmdError("FRIENDS_INPUT: 举报说明最多 500 字".into()));
    }
    let detail = detail.trim();
    let game_key = game_key
        .map(|key| key.trim().to_string())
        .filter(|key| !key.is_empty());
    if game_key.as_deref().is_some_and(|key| !valid_game_key(key)) {
        return Err(CmdError("FRIENDS_INPUT: 举报的封面信息无效".into()));
    }
    runtime::ensure(&app).await;
    let state = app.state::<FriendsState>();
    let mut inner = state.inner.lock().await;
    runtime::rpc(
        &mut inner,
        "koipage_report_friend",
        json!({
            "p_target":target,
            "p_reason":reason,
            "p_game_key":game_key,
            "p_detail":(!detail.is_empty()).then_some(detail),
        }),
    )
    .await
}

#[tauri::command]
pub async fn friends_history(
    app: AppHandle,
    target: String,
    days: Option<u32>,
) -> CmdResult<Value> {
    let days = days.unwrap_or(7);
    if !(1..=7).contains(&days) {
        return Err(CmdError("FRIENDS_INPUT: 只能查看最近 1–7 天的记录".into()));
    }
    runtime::ensure(&app).await;
    let state = app.state::<FriendsState>();
    let mut inner = state.inner.lock().await;
    let target = if target == "me" {
        inner
            .account
            .as_ref()
            .map(|account| account.id.clone())
            .ok_or_else(|| CmdError("FRIENDS_SESSION: 请先登录".into()))?
    } else if valid_uuid(&target) {
        target
    } else {
        return Err(CmdError("FRIENDS_INPUT: 好友目标无效".into()));
    };
    runtime::rpc(
        &mut inner,
        "koipage_friend_history",
        json!({"p_target":target,"p_days":days}),
    )
    .await
}

#[tauri::command]
pub async fn friends_delete_account(app: AppHandle, expected_account: Option<String>) -> CmdResult<Value> {
    deletion::remove(&app, expected_account.as_deref()).await
}

#[tauri::command]
pub async fn friends_resume_deletion(app: AppHandle, password: String, expected_account: String) -> CmdResult<Value> {
    deletion::resume(&app, &password, &expected_account).await
}

#[tauri::command]
pub async fn friends_cover_status(app: AppHandle) -> CmdResult<Vec<library::CoverStatus>> {
    library::cover_status(&app).await
}

#[tauri::command]
pub async fn friends_verify_cover(
    app: AppHandle,
    game_id: i64,
    verified: bool,
) -> CmdResult<Value> {
    library::verify_cover(&app, game_id, verified).await
}
