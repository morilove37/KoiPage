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
use tauri::{AppHandle, Emitter, Manager};
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
            generation: self.generation,
        }
    }
    pub fn failed(&mut self, error: &CmdError) {
        if ![
            "FRIENDS_UNAVAILABLE",
            "FRIENDS_REQUEST",
            "FRIENDS_INPUT",
            "FRIENDS_RATE",
        ]
        .iter()
        .any(|p| error.0.starts_with(p))
        {
            self.connected = false;
        }
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
                    if inner.tokens.is_none() {
                        inner.config.enabled = false;
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

#[derive(Default)]
struct ResumeRetry {
    next: Option<Instant>,
    failures: u32,
    generation: u64,
}
async fn recover_account(inner: &mut Inner, retry: &mut ResumeRetry, at: Instant) -> bool {
    if !inner.config.enabled || inner.tokens.is_none() {
        return false;
    }
    if inner.account.is_some() {
        return true;
    }
    if retry.generation != inner.generation {
        *retry = ResumeRetry {
            generation: inner.generation,
            ..ResumeRetry::default()
        };
    }
    if retry.next.is_some_and(|next| at < next) {
        return false;
    }
    let result = async {
        validate_project(&inner.config.server_url, &inner.config.public_key)?;
        let profile = rpc(inner, "koipage_claim", json!({})).await?;
        inner.account = Some(
            serde_json::from_value(profile)
                .map_err(|_| CmdError("FRIENDS_PROTOCOL: 账号资料格式无效".into()))?,
        );
        Ok::<(), CmdError>(())
    }
    .await;
    match result {
        Ok(()) => {
            retry.next = None;
            retry.failures = 0;
            true
        }
        Err(error) => {
            inner.failed(&error);
            retry.failures = retry.failures.saturating_add(1);
            retry.next = Some(at + Duration::from_secs((1u64 << retry.failures.min(5)).min(30)));
            false
        }
    }
}
async fn game_for_publish<F>(config: &Config, load: impl FnOnce() -> F) -> Option<PublicGame>
where
    F: std::future::Future<Output = CmdResult<Vec<RunningCandidate>>>,
{
    if !config.share_game || config.invisible {
        return None;
    }
    tokio::time::timeout(Duration::from_secs(2), load())
        .await
        .ok()
        .and_then(Result::ok)
        .and_then(|games| select_game(config, &games))
}
async fn publisher(app: AppHandle) {
    let mut last_signature = String::new();
    let mut attempted_signature = String::new();
    let mut last_publish = Instant::now() - Duration::from_secs(31);
    let mut retry_at = Instant::now();
    let mut failures = 0u32;
    let mut resume_retry = ResumeRetry::default();
    loop {
        tokio::time::sleep(Duration::from_secs(1)).await;
        let state = app.state::<FriendsState>();
        if state.stopping.load(Ordering::SeqCst) {
            continue;
        }
        let (config, generation) = {
            let mut inner = state.inner.lock().await;
            let before = inner.status();
            let ready = recover_account(&mut inner, &mut resume_retry, Instant::now()).await;
            if inner.status() != before {
                let _ = app.emit("friends-status-changed", inner.status());
            }
            if !ready {
                continue;
            }
            (inner.config.clone(), inner.generation)
        };
        let game = game_for_publish(&config, || candidates(&app)).await;
        let mut inner = state.inner.lock().await;
        if state.stopping.load(Ordering::SeqCst)
            || !inner.config.enabled
            || inner.tokens.is_none()
            || inner.generation != generation
        {
            continue;
        }
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
        let _ = app.emit("friends-status-changed", inner.status());
    }
}
/// The flag is immediate even if an earlier HTTP operation is still in flight.
/// Graceful exit gets one second; a disconnected client expires server-side.
async fn leave_remote(config: Config, tokens: Option<Tokens>) {
    if let Some(tokens) = tokens {
        if let Ok(api) = Api::new(&config) {
            let _ = api
                .rpc("koipage_leave", &tokens.access_token, json!({}))
                .await;
        }
    }
}
async fn tear_down_for_restore<S, L>(
    inner: &Mutex<Inner>,
    persist: impl FnOnce(Config) -> S,
    clear: impl FnOnce(&str) -> CmdResult<()>,
    leave: impl FnOnce(Config, Option<Tokens>) -> L,
) -> CmdResult<()>
where
    S: std::future::Future<Output = CmdResult<()>>,
    L: std::future::Future<Output = ()>,
{
    let (config, tokens) = {
        let mut inner = inner.lock().await;
        inner.config.enabled = false;
        inner.config.share_game = false;
        inner.account = None;
        inner.connected = false;
        inner.generation += 1;
        (inner.config.clone(), inner.tokens.take())
    };
    let credential_result = clear(&config.server_url);
    let save_result = persist(config.clone()).await;
    let _ = tokio::time::timeout(Duration::from_secs(1), leave(config, tokens)).await;
    credential_result?;
    save_result
}
pub async fn stop(app: &AppHandle, persist: bool) {
    let Some(state) = app.try_state::<FriendsState>() else {
        return;
    };
    state.stopping.store(true, Ordering::SeqCst);
    if persist {
        if let Err(error) = tear_down_for_restore(
            &state.inner,
            |config| async move { save(app, &config).await },
            credentials::delete,
            leave_remote,
        )
        .await
        {
            crate::app_warn!("[friends] {error}");
        }
        let _ = app.emit("friends-status-changed", state.inner.lock().await.status());
    } else {
        let _ = tokio::time::timeout(Duration::from_secs(1), async {
            let (config, tokens) = {
                let inner = state.inner.lock().await;
                (inner.config.clone(), inner.tokens.clone())
            };
            leave_remote(config, tokens).await;
        })
        .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, atomic::AtomicUsize};
    fn tokens() -> Tokens {
        Tokens {
            access_token: "test-only-access".into(),
            refresh_token: "test-only-refresh".into(),
            expires_at: now() + 3600,
        }
    }
    #[tokio::test]
    async fn native_resume_retries_transient_failure_without_any_frontend_timer() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        let worker = std::thread::spawn(move || {
            for (status, body) in [
                (503, "{}"),
                (
                    200,
                    r#"{"id":"test-id","username":"alice","nickname":"Alice","avatar":0,"friendCode":"CODE"}"#,
                ),
            ] {
                let (mut stream, _) = listener.accept().unwrap();
                let mut bytes = [0; 4096];
                let _ = stream.read(&mut bytes);
                count.fetch_add(1, Ordering::SeqCst);
                write!(stream,"HTTP/1.1 {status} Result\r\nContent-Length: {}\r\nConnection: close\r\nContent-Type: application/json\r\n\r\n{body}",body.len()).unwrap();
            }
        });
        let mut inner = Inner {
            config: Config {
                enabled: true,
                server_url: format!("http://{address}"),
                public_key: "sb_publishable_test".into(),
                ..Config::default()
            },
            tokens: Some(tokens()),
            ..Inner::default()
        };
        let start = Instant::now();
        let mut recovery = ResumeRetry::default();
        assert!(!recover_account(&mut inner, &mut recovery, start).await);
        assert!(inner.tokens.is_some());
        assert!(!recover_account(&mut inner, &mut recovery, start + Duration::from_secs(1)).await);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(recover_account(&mut inner, &mut recovery, start + Duration::from_secs(3)).await);
        assert_eq!(inner.account.as_ref().unwrap().username, "alice");
        worker.join().unwrap();
    }
    #[tokio::test]
    async fn restrictive_privacy_never_needs_a_successful_metadata_lookup() {
        let config = Config {
            share_game: false,
            ..Config::default()
        };
        assert!(
            game_for_publish(&config, || async {
                panic!("private metadata must not be queried")
            })
            .await
            .is_none()
        );
        let config = Config {
            share_game: true,
            invisible: true,
            ..Config::default()
        };
        assert!(
            game_for_publish(&config, || async {
                panic!("private metadata must not be queried")
            })
            .await
            .is_none()
        );
        let config = Config {
            share_game: true,
            ..Config::default()
        };
        assert!(
            game_for_publish(&config, || async {
                Err(CmdError("database unavailable".into()))
            })
            .await
            .is_none()
        );
        let bounded = tokio::time::timeout(
            Duration::from_secs(3),
            game_for_publish(&config, || {
                std::future::pending::<CmdResult<Vec<RunningCandidate>>>()
            }),
        )
        .await;
        assert!(
            bounded.is_ok(),
            "metadata lookup must not indefinitely delay a restrictive update"
        );
    }
    #[tokio::test]
    async fn restore_teardown_clears_memory_and_credentials_before_a_stalled_leave() {
        let inner = Mutex::new(Inner {
            config: Config {
                enabled: true,
                share_game: true,
                ..Config::default()
            },
            tokens: Some(tokens()),
            account: Some(Account {
                id: "id".into(),
                username: "alice".into(),
                nickname: "Alice".into(),
                avatar: 0,
                friend_code: "CODE".into(),
            }),
            ..Inner::default()
        });
        let saved = Arc::new(AtomicBool::new(false));
        let cleared = Arc::new(AtomicBool::new(false));
        let s = saved.clone();
        let c = cleared.clone();
        let check_saved = saved.clone();
        let check_cleared = cleared.clone();
        tear_down_for_restore(
            &inner,
            move |config| async move {
                assert!(!config.enabled && !config.share_game);
                s.store(true, Ordering::SeqCst);
                Ok(())
            },
            move |_| {
                c.store(true, Ordering::SeqCst);
                Ok(())
            },
            move |_, _| {
                assert!(check_saved.load(Ordering::SeqCst) && check_cleared.load(Ordering::SeqCst));
                std::future::pending::<()>()
            },
        )
        .await
        .unwrap();
        let inner = inner.lock().await;
        assert!(inner.tokens.is_none() && inner.account.is_none());
        assert!(saved.load(Ordering::SeqCst) && cleared.load(Ordering::SeqCst));
    }
}
