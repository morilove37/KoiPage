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
/// Cached `Account` snapshot so a restart or a network outage keeps the user
/// visibly logged in without needing a successful claim first.
pub const ACCOUNT_KEY: &str = "friends_account";
pub const DELETE_RECEIPT_KEY: &str = "friends_delete_receipt";
#[derive(Default)]
pub struct Inner {
    pub config: Config,
    pub tokens: Option<Tokens>,
    pub account: Option<Account>,
    pub connected: bool,
    pub error: Option<String>,
    pub seq: i64,
    pub generation: u64,
    pub library_synced_at: Option<i64>,
    pub library_error: Option<String>,
    pub history_synced_at: Option<String>,
    pub history_error: Option<String>,
    /// Set when a claim refresh produced a newer snapshot than the one cached
    /// in settings. The publisher flushes it and clears the flag.
    pub account_dirty: bool,
    pub deletion_pending: bool,
}
#[derive(Default)]
pub struct FriendsState {
    pub inner: Mutex<Inner>,
    pub(super) library: Mutex<super::library::Cache>,
    pub(super) history: Mutex<super::history::Cache>,
    initialized: OnceCell<()>,
    pub stopping: AtomicBool,
}
impl Inner {
    pub fn allow_account_change(&self) -> CmdResult<()> {
        if self.deletion_pending {
            Err(CmdError("FRIENDS_DELETION_PENDING: 请先在设置中确认上次注销结果，再切换账号、服务或分享设置。".into()))
        } else {
            Ok(())
        }
    }
    pub fn status(&self) -> Status {
        Status {
            config: self.config.clone(),
            account: self.account.clone(),
            connected: self.connected,
            last_error: self.error.clone(),
            generation: self.generation,
            library_synced_at: self.library_synced_at,
            library_error: self.library_error.clone(),
            history_synced_at: self.history_synced_at.clone(),
            history_error: self.history_error.clone(),
            deletion_pending: self.deletion_pending,
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
        if error.0.starts_with("FRIENDS_SESSION") && !self.deletion_pending {
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
/// Persist the account snapshot used to keep the user logged in while offline.
pub async fn save_account(app: &AppHandle, account: &Account) {
    if let Ok(value) = serde_json::to_string(account) {
        let _ = settings_set(app.clone(), ACCOUNT_KEY.into(), Some(value)).await;
    }
}
pub async fn clear_account(app: &AppHandle) {
    let _ = settings_set(app.clone(), ACCOUNT_KEY.into(), None).await;
}
pub async fn rpc(inner: &mut Inner, name: &str, body: Value) -> CmdResult<Value> {
    if inner.deletion_pending {
        return Err(CmdError("FRIENDS_DELETION_PENDING: 账号注销结果待确认，请在设置中重试注销。".into()));
    }
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
            let (stored, cached_account, deletion) = match pool(app).await {
                Ok(db) => (
                    settings_get_impl(&db, CONFIG_KEY).await.ok().flatten(),
                    settings_get_impl(&db, ACCOUNT_KEY).await.ok().flatten(),
                    settings_get_impl(&db, DELETE_RECEIPT_KEY).await.ok().flatten(),
                ),
                Err(_) => (None, None, None),
            };
            inner.config = stored
                .and_then(|v| serde_json::from_str(&v).ok())
                .unwrap_or_default();
            inner.deletion_pending = deletion
                .and_then(|value| serde_json::from_str::<DeletionReceipt>(&value).ok())
                .is_some_and(|value| value.server_url == inner.config.server_url);
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
                if inner.tokens.is_some() || inner.deletion_pending {
                    // The snapshot is presentation state only; the publisher
                    // re-claims in the background and replaces it when the
                    // network comes back.
                    inner.account = cached_account.and_then(|v| serde_json::from_str(&v).ok());
                }
                if let Err(error) = resume {
                    inner.failed(&error);
                }
            }
            if inner.deletion_pending {
                state.stopping.store(true, Ordering::SeqCst);
            }
            drop(inner);
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                publisher(handle).await;
            });
            let library_handle = app.clone();
            tauri::async_runtime::spawn(async move {
                super::library::publisher(library_handle).await;
            });
            let history_handle = app.clone();
            tauri::async_runtime::spawn(async move {
                super::history::publisher(history_handle).await;
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
    if inner.deletion_pending || !inner.config.enabled || inner.tokens.is_none() {
        return false;
    }
    if inner.account.is_some() && inner.connected {
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
        inner.account_dirty = true;
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
            if inner.account_dirty {
                inner.account_dirty = false;
                if let Some(account) = inner.account.clone() {
                    let handle = app.clone();
                    tauri::async_runtime::spawn(async move {
                        save_account(&handle, &account).await;
                    });
                }
            }
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
            if !config.share_library {
                let _ = api
                    .rpc(
                        "koipage_library_sync",
                        &tokens.access_token,
                        json!({"p_enabled":false,"p_games":[],"p_keys":[]}),
                    )
                    .await;
            }
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
        inner.config.share_library = false;
        inner.config.share_history = false;
        inner.library_synced_at = None;
        inner.library_error = None;
        inner.history_synced_at = None;
        inner.history_error = None;
        inner.deletion_pending = false;
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
        clear_account(app).await;
        let _ = settings_set(app.clone(), DELETE_RECEIPT_KEY.into(), None).await;
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
    async fn restrictive_leave_retracts_collection_before_going_offline() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let worker = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(4);
            let mut paths = Vec::new();
            while Instant::now() < deadline {
                let (mut stream, _) = match listener.accept() {
                    Ok(value) => value,
                    Err(_) => {
                        std::thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                };
                stream
                    .set_read_timeout(Some(Duration::from_secs(1)))
                    .unwrap();
                let mut bytes = [0; 4096];
                let n = stream.read(&mut bytes).unwrap();
                let line = String::from_utf8_lossy(&bytes[..n])
                    .lines()
                    .next()
                    .unwrap_or_default()
                    .to_string();
                let leaving = line.contains("koipage_leave");
                paths.push(
                    line.split_whitespace()
                        .nth(1)
                        .unwrap_or_default()
                        .to_string(),
                );
                let body = r#"{"ok":true}"#;
                write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\nContent-Type: application/json\r\n\r\n{body}", body.len()).unwrap();
                if leaving {
                    break;
                }
            }
            paths
        });
        let config = Config {
            server_url: format!("http://{address}"),
            public_key: "sb_publishable_test".into(),
            ..Config::default()
        };
        leave_remote(config, Some(tokens())).await;
        assert_eq!(
            worker.join().unwrap(),
            vec![
                "/rest/v1/rpc/koipage_library_sync",
                "/rest/v1/rpc/koipage_leave"
            ]
        );
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
                share_library: true,
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
                assert!(!config.enabled && !config.share_game && !config.share_library);
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

    fn account() -> Account {
        Account {
            id: "id".into(),
            username: "alice".into(),
            nickname: "Alice".into(),
            avatar: 0,
            friend_code: "CODE".into(),
        }
    }

    #[test]
    fn unfinished_deletion_blocks_identity_changes_and_preserves_login() {
        let mut inner=Inner {tokens:Some(tokens()),account:Some(account()),deletion_pending:true,..Inner::default()};
        assert!(inner.allow_account_change().is_err());
        inner.failed(&CmdError("FRIENDS_SESSION: deleted Auth token".into()));
        assert!(inner.tokens.is_some()&&inner.account.is_some());
        inner.deletion_pending=false;
        assert!(inner.allow_account_change().is_ok());
    }

    #[test]
    fn offline_failures_keep_the_login_and_only_auth_failures_clear_it() {
        let mut inner = Inner {
            config: Config {
                enabled: true,
                share_game: true,
                ..Config::default()
            },
            tokens: Some(tokens()),
            account: Some(account()),
            connected: true,
            ..Inner::default()
        };
        inner.failed(&CmdError(
            "FRIENDS_NETWORK: 无法连接内测服务，请稍后重试".into(),
        ));
        assert!(!inner.connected, "a transport failure is not connected");
        assert!(inner.tokens.is_some() && inner.account.is_some() && inner.config.enabled);
        assert!(
            inner
                .error
                .as_deref()
                .unwrap_or_default()
                .starts_with("FRIENDS_NETWORK")
        );
        // Server-side rejections also never erase the login.
        for error in [
            "FRIENDS_RATE: 操作过于频繁",
            "FRIENDS_UNAVAILABLE: 对方不可用",
            "FRIENDS_REQUEST: 状态已变化",
            "FRIENDS_IP_BANNED: 网络已被禁止注册",
        ] {
            inner.failed(&CmdError(error.into()));
            assert!(
                inner.tokens.is_some() && inner.account.is_some(),
                "{error} must not log out"
            );
        }
        inner.failed(&CmdError("FRIENDS_SESSION: 登录已失效".into()));
        assert!(inner.tokens.is_none() && inner.account.is_none() && !inner.config.enabled);
    }

    #[tokio::test]
    async fn cached_account_short_circuits_claim_only_while_connected() {
        let mut inner = Inner {
            config: Config {
                enabled: true,
                server_url: "http://127.0.0.1:1".into(),
                public_key: "sb_publishable_test".into(),
                ..Config::default()
            },
            tokens: Some(tokens()),
            account: Some(account()),
            connected: true,
            ..Inner::default()
        };
        let mut retry = ResumeRetry::default();
        assert!(recover_account(&mut inner, &mut retry, Instant::now()).await);
        // A cached account is still shown while disconnected, and the publisher
        // keeps retrying the claim without erasing it on failure.
        inner.connected = false;
        assert!(!recover_account(&mut inner, &mut retry, Instant::now()).await);
        assert!(inner.account.is_some() && inner.tokens.is_some());
    }
}
