mod client;
mod credentials;
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
pub struct ProjectInput {
    server_url: String,
    public_key: String,
}
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
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    share_game: bool,
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
pub async fn friends_configure(app: AppHandle, input: ProjectInput) -> CmdResult<Status> {
    let address = validate_project(&input.server_url, &input.public_key)?;
    runtime::ensure(&app).await;
    let state = app.state::<FriendsState>();
    let mut inner = state.inner.lock().await;
    if inner.config.server_url != address || inner.config.public_key != input.public_key.trim() {
        if inner.tokens.is_some() {
            let _ = runtime::rpc(&mut inner, "koipage_leave", json!({})).await;
        }
        credentials::delete(&inner.config.server_url)?;
        let next = Config {
            server_url: address,
            public_key: input.public_key.trim().into(),
            ..Config::default()
        };
        runtime::save(&app, &next).await?;
        inner.config = next;
        inner.tokens = None;
        inner.account = None;
        inner.connected = false;
        inner.error = None;
        inner.generation += 1;
    }
    Ok(inner.status())
}
#[tauri::command]
pub async fn friends_authenticate(app: AppHandle, input: AuthInput) -> CmdResult<Status> {
    let username = validate_login(&input.username, &input.password)?;
    runtime::ensure(&app).await;
    let state = app.state::<FriendsState>();
    let mut inner = state.inner.lock().await;
    validate_project(&inner.config.server_url, &inner.config.public_key)?;
    let api = client::Api::new(&inner.config)?;
    let email = format!("{username}@accounts.koipage.invalid");
    let tokens = match input.mode.as_str() {
        "login" => api.password_login(&username, &input.password).await?,
        "register" => {
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
            api.request(Method::POST,"/functions/v1/friends-register",None,json!({"username":username,"password":input.password,"nickname":nickname,"inviteCode":input.invite_code.trim()})).await?;
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
    config.invisible = false;
    runtime::save(&app, &config).await?;
    inner.config = config;
    inner.tokens = Some(tokens);
    inner.account = Some(account);
    inner.seq = 0;
    inner.generation += 1;
    inner.error = None;
    inner.connected = true;
    state
        .stopping
        .store(false, std::sync::atomic::Ordering::SeqCst);
    Ok(inner.status())
}
#[tauri::command]
pub async fn friends_logout(app: AppHandle) -> CmdResult<Status> {
    runtime::ensure(&app).await;
    let state = app.state::<FriendsState>();
    let (config, tokens, status) = {
        let mut inner = state.inner.lock().await;
        let mut next = inner.config.clone();
        next.enabled = false;
        next.share_game = false;
        runtime::save(&app, &next).await?;
        let tokens = inner.tokens.take();
        inner.config = next;
        inner.account = None;
        inner.connected = false;
        inner.error = None;
        inner.generation += 1;
        (inner.config.clone(), tokens, inner.status())
    };
    let deletion = credentials::delete(&config.server_url);
    if let Some(tokens) = tokens {
        if let Ok(api) = client::Api::new(&config) {
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
    let mut next = inner.config.clone();
    next.share_game = input.share_game;
    next.invisible = input.invisible;
    next.hidden_game_ids = input.hidden_game_ids;
    next.hidden_game_ids.sort_unstable();
    next.hidden_game_ids.dedup();
    runtime::save(&app, &next).await?;
    inner.config = next;
    inner.generation += 1;
    Ok(inner.status())
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
