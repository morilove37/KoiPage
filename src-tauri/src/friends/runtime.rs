use super::{client::Api, credentials, model::*};
use crate::commands::{
    error::{CmdError, CmdResult},
    games::pool,
    settings::{settings_get_impl, settings_set},
};
use serde_json::{Value, json};
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};
use tokio::sync::{Mutex, OnceCell};

pub const CONFIG_KEY: &str = "friends_config";
#[derive(Default)]
pub struct Inner {
    pub config: Config,
    pub tokens: Option<Tokens>,
    pub account: Option<Account>,
    pub connected: bool,
    pub error: Option<String>,
    pub seq: i64,
    pub generation: u64,
}
#[derive(Default)]
pub struct FriendsState {
    pub inner: Mutex<Inner>,
    initialized: OnceCell<()>,
    pub stopping: AtomicBool,
}
impl Inner {
    pub fn status(&self) -> Status {
        Status {
            config: self.config.clone(),
            account: self.account.clone(),
            connected: self.connected,
            last_error: self.error.clone(),
        }
    }
    pub fn failed(&mut self, error: &CmdError) {
        self.connected = false;
        self.error = Some(error.0.clone());
        if error.0.starts_with("FRIENDS_SESSION") {
            self.tokens = None;
            self.account = None;
            self.config.enabled = false;
            self.generation += 1;
            let _ = credentials::delete(&self.config.server_url);
        }
    }
}
pub async fn save(app: &AppHandle, config: &Config) -> CmdResult<()> {
    settings_set(
        app.clone(),
        CONFIG_KEY.into(),
        Some(
            serde_json::to_string(config)
                .map_err(|_| CmdError("FRIENDS_CONFIG: 无法保存设置".into()))?,
        ),
    )
    .await
}
pub async fn rpc(inner: &mut Inner, name: &str, body: Value) -> CmdResult<Value> {
    let result = async {
        let api = Api::new(&inner.config)?;
        let current = inner
            .tokens
            .clone()
            .ok_or_else(|| CmdError("FRIENDS_SESSION: 请先登录".into()))?;
        if current.expires_at <= now() + 60 {
            let next = api.refresh(&current.refresh_token).await?;
            credentials::save(&inner.config.server_url, &next)?;
            inner.tokens = Some(next);
        }
        let token = &inner.tokens.as_ref().unwrap().access_token;
        api.rpc(name, token, body).await
    }
    .await;
    match &result {
        Ok(_) => {
            inner.connected = true;
            inner.error = None;
        }
        Err(error) => inner.failed(error),
    }
    result
}
pub async fn ensure(app: &AppHandle) {
    let state = app.state::<FriendsState>();
    state
        .initialized
        .get_or_init(|| async {
            let mut inner = state.inner.lock().await;
            let stored = match pool(app).await {
                Ok(db) => settings_get_impl(&db, CONFIG_KEY).await.ok().flatten(),
                Err(_) => None,
            };
            inner.config = stored
                .and_then(|v| serde_json::from_str(&v).ok())
                .unwrap_or_default();
            if inner.config.enabled {
                let resume = async {
                    validate_project(&inner.config.server_url, &inner.config.public_key)?;
                    inner.tokens = credentials::load(&inner.config.server_url)?;
                    if inner.tokens.is_some() {
                        let profile = rpc(&mut inner, "koipage_claim", json!({})).await?;
                        inner.account =
                            Some(serde_json::from_value(profile).map_err(|_| {
                                CmdError("FRIENDS_PROTOCOL: 账号信息格式无效".into())
                            })?);
                    }
                    Ok::<(), CmdError>(())
                }
                .await;
                if let Err(error) = resume {
                    inner.failed(&error);
                }
            }
            drop(inner);
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                publisher(handle).await;
            });
        })
        .await;
}
async fn candidates(app: &AppHandle) -> CmdResult<Vec<RunningCandidate>> {
    let running = app
        .state::<crate::launcher::RunningGames>()
        .presence_snapshot()?;
    if running.is_empty() {
        return Ok(Vec::new());
    }
    let db = pool(app).await?;
    let mut result = Vec::new();
    for (id, session, started, duration) in running {
        if let Some((title, vndb_id, bangumi_id)) =
            sqlx::query_as::<_, (String, Option<String>, Option<String>)>(
                "SELECT title,vndb_id,bangumi_id FROM games WHERE id=?",
            )
            .bind(id)
            .fetch_optional(&db)
            .await?
        {
            result.push(RunningCandidate {
                game_id: id,
                session_id: session,
                started_at: started,
                duration,
                title,
                vndb_id,
                bangumi_id,
            });
        }
    }
    Ok(result)
}
async fn publisher(app: AppHandle) {
    let mut last_signature = String::new();
    let mut attempted_signature = String::new();
    let mut last_publish = Instant::now() - Duration::from_secs(31);
    let mut retry_at = Instant::now();
    let mut failures = 0u32;
    loop {
        tokio::time::sleep(Duration::from_secs(1)).await;
        let state = app.state::<FriendsState>();
        if state.stopping.load(Ordering::SeqCst) {
            continue;
        }
        {
            let inner = state.inner.lock().await;
            if !inner.config.enabled || inner.tokens.is_none() || inner.account.is_none() {
                continue;
            }
        }
        let games = match candidates(&app).await {
            Ok(g) => g,
            Err(_) => continue,
        };
        let mut inner = state.inner.lock().await;
        if state.stopping.load(Ordering::SeqCst) || !inner.config.enabled || inner.tokens.is_none()
        {
            continue;
        }
        let game = select_game(&inner.config, &games);
        let mut stable = serde_json::to_value(&game).unwrap_or(Value::Null);
        if let Some(object) = stable.as_object_mut() {
            object.remove("duration");
        }
        let signature = format!("{}:{}:{stable}", inner.generation, inner.config.invisible);
        if signature == last_signature && last_publish.elapsed() < Duration::from_secs(30) {
            continue;
        }
        if signature == attempted_signature && Instant::now() < retry_at {
            continue;
        }
        attempted_signature = signature.clone();
        inner.seq = inner.seq.saturating_add(1);
        let seq = inner.seq;
        let invisible = inner.config.invisible;
        match rpc(
            &mut inner,
            "koipage_publish",
            json!({"p_seq":seq,"p_invisible":invisible,"p_game":game}),
        )
        .await
        {
            Ok(value) => {
                inner.seq = inner.seq.max(value["seq"].as_i64().unwrap_or(seq));
                failures = 0;
                retry_at = Instant::now();
                if value["accepted"] == true {
                    last_signature = signature;
                    last_publish = Instant::now();
                }
            }
            Err(_) => {
                failures = failures.saturating_add(1);
                retry_at = Instant::now() + Duration::from_secs((1u64 << failures.min(5)).min(30));
            }
        }
    }
}
/// The flag is immediate even if an earlier HTTP operation is still in flight.
/// Graceful exit gets one second; a disconnected client expires server-side.
pub async fn stop(app: &AppHandle, persist: bool) {
    let state = app.state::<FriendsState>();
    state.stopping.store(true, Ordering::SeqCst);
    let _ = tokio::time::timeout(Duration::from_secs(1), async {
        let mut inner = state.inner.lock().await;
        if inner.tokens.is_some() {
            let _ = rpc(&mut inner, "koipage_leave", json!({})).await;
        }
        if persist {
            inner.config.enabled = false;
            inner.config.share_game = false;
            inner.tokens = None;
            inner.account = None;
            inner.generation += 1;
            let _ = credentials::delete(&inner.config.server_url);
            let _ = save(app, &inner.config).await;
        }
    })
    .await;
}
