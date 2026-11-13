//! Keep deletion recoverable across network failures and process restarts.
use super::{client::Api, credentials, history, library, model::*, runtime};
use crate::commands::{
    error::{CmdError, CmdResult},
    games::pool,
    settings::{settings_get_impl, settings_set},
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, Manager};

async fn authenticate_original(
    api: &Api,
    username: &str,
    password: &str,
    expected: &str,
) -> CmdResult<(Tokens, Account)> {
    let tokens = api.password_login(username, password).await?;
    let user = api
        .request(
            reqwest::Method::GET,
            "/auth/v1/user",
            Some(&tokens.access_token),
            json!({}),
        )
        .await?;
    if user["id"].as_str() != Some(expected) {
        let _ = api
            .request(
                reqwest::Method::POST,
                "/auth/v1/logout?scope=local",
                Some(&tokens.access_token),
                json!({}),
            )
            .await;
        return Err(CmdError("FRIENDS_INPUT: 只能重新验证原注销账号。".into()));
    }
    let profile = api
        .rpc("koipage_claim", &tokens.access_token, json!({}))
        .await?;
    let account: Account = serde_json::from_value(profile)
        .map_err(|_| CmdError("FRIENDS_PROTOCOL: 账号资料格式无效".into()))?;
    target_identity(Some(&account.id), Some(expected), None)?;
    Ok((tokens, account))
}

/// A displaced refresh token cannot recover itself. Password reauthentication
/// is scoped to the persisted original identity, and never changes the target.
pub(super) async fn resume(app: &AppHandle, password: &str, expected: &str) -> CmdResult<Value> {
    runtime::ensure(app).await;
    let state = app.state::<runtime::FriendsState>();
    let mut inner = state.inner.lock().await;
    if !inner.deletion_pending {
        return Err(CmdError("FRIENDS_INPUT: 没有待确认的注销请求。".into()));
    }
    let db = pool(app).await?;
    let saved = settings_get_impl(&db, runtime::DELETE_RECEIPT_KEY)
        .await?
        .and_then(|raw| serde_json::from_str::<DeletionReceipt>(&raw).ok())
        .filter(|receipt| receipt.server_url == inner.config.server_url)
        .ok_or_else(|| CmdError("FRIENDS_INPUT: 未找到原注销请求。".into()))?;
    let account = inner.account.as_ref().ok_or_else(|| {
        CmdError("FRIENDS_SESSION: 未找到原账号资料，请先重试确认注销结果。".into())
    })?;
    target_identity(Some(&account.id), Some(&saved.account_id), Some(expected))?;
    let username = validate_login(&account.username, password)?;
    let api = Api::new(&inner.config)?;
    let (tokens, account) = authenticate_original(&api, &username, password, expected).await?;
    credentials::save(&inner.config.server_url, &tokens)?;
    runtime::save_account(app, &account).await;
    inner.tokens = Some(tokens);
    inner.account = Some(account);
    inner.generation += 1;
    drop(inner);
    remove(app, Some(expected)).await
}

fn target_identity(
    current: Option<&str>,
    pending: Option<&str>,
    expected: Option<&str>,
) -> CmdResult<String> {
    if current.zip(pending).is_some_and(|(a, b)| a != b) {
        return Err(CmdError(
            "FRIENDS_INPUT: 上次注销请求属于其他账号，不能更换注销对象。".into(),
        ));
    }
    let identity = pending
        .or(current)
        .ok_or_else(|| CmdError("FRIENDS_SESSION: 请先登录".into()))?;
    if expected.is_some_and(|value| value != identity) {
        return Err(CmdError(
            "FRIENDS_INPUT: 当前账号已变化，请重新确认要注销的账号。".into(),
        ));
    }
    Ok(identity.into())
}

pub(super) async fn remove(app: &AppHandle, expected_account: Option<&str>) -> CmdResult<Value> {
    runtime::ensure(app).await;
    let state = app.state::<runtime::FriendsState>();
    let mut inner = state.inner.lock().await;
    let db = pool(app).await?;
    let saved = settings_get_impl(&db, runtime::DELETE_RECEIPT_KEY)
        .await?
        .and_then(|raw| serde_json::from_str::<DeletionReceipt>(&raw).ok())
        .filter(|receipt| receipt.server_url == inner.config.server_url);
    let identity = target_identity(
        inner.account.as_ref().map(|a| a.id.as_str()),
        saved.as_ref().map(|receipt| receipt.account_id.as_str()),
        expected_account,
    )?;
    let pending = match saved {
        Some(receipt) => receipt,
        None => {
            let token = inner
                .tokens
                .as_ref()
                .ok_or_else(|| CmdError("FRIENDS_SESSION: 请先登录".into()))?;
            DeletionReceipt {
                server_url: inner.config.server_url.clone(),
                account_id: identity,
                receipt: format!("{:x}", Sha256::digest(&token.access_token)),
            }
        }
    };
    // Save before the network call: a confirmed server deletion may lose its reply.
    settings_set(
        app.clone(),
        runtime::DELETE_RECEIPT_KEY.into(),
        Some(serde_json::to_string(&pending).map_err(|_| CmdError("无法保存注销请求".into()))?),
    )
    .await?;
    inner.deletion_pending = true;
    inner.generation += 1;
    state.stopping.store(true, Ordering::SeqCst);
    let api = Api::new(&inner.config)?;
    let access = inner
        .tokens
        .as_ref()
        .map(|token| token.access_token.as_str())
        .unwrap_or("receipt-status-only");
    let mut result = api.delete_account(access, &pending.receipt).await;
    // Check the receipt using the old token first; refreshing a deleted account
    // would discard the evidence needed to confirm a lost success response.
    if result
        .as_ref()
        .is_err_and(|error| error.0.starts_with("FRIENDS_SESSION"))
    {
        if let Some(tokens) = inner.tokens.clone() {
            if let Ok(next) = api.refresh(&tokens.refresh_token).await {
                credentials::save(&inner.config.server_url, &next)?;
                let next_access = next.access_token.clone();
                inner.tokens = Some(next);
                result = api.delete_account(&next_access, &pending.receipt).await;
            }
        }
    }
    if let Err(error) = result {
        inner.connected = false;
        inner.error = Some(
            "FRIENDS_DELETION_PENDING: 注销结果待确认，登录凭据已保留，请在设置中重试。".into(),
        );
        let _ = app.emit("friends-status-changed", inner.status());
        return Err(error);
    }
    let server = inner.config.server_url.clone();
    inner.config = Config::default();
    // Even if local persistence fails, the opaque receipt remains available for
    // another confirmation attempt. The server's completed deletion is final.
    let _ = runtime::save(app, &inner.config).await;
    inner.tokens = None;
    inner.account = None;
    inner.deletion_pending = false;
    inner.connected = false;
    inner.error = None;
    inner.library_synced_at = None;
    inner.library_error = None;
    inner.history_synced_at = None;
    inner.history_error = None;
    inner.account_dirty = false;
    inner.generation += 1;
    drop(inner);
    let _ = credentials::delete(&server);
    runtime::clear_account(app).await;
    let _ = settings_set(app.clone(), runtime::DELETE_RECEIPT_KEY.into(), None).await;
    *state.library.lock().await = library::Cache::default();
    *state.history.lock().await = history::Cache::default();
    let _ = app.emit("friends-status-changed", state.inner.lock().await.status());
    Ok(json!({"ok":true,"authDeleted":true}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn resume_reauthenticates_only_the_original_account_before_claiming() {
        use std::io::{Read, Write};
        for mismatch in [false, true] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let expected = "00000000-0000-4000-8000-000000000001";
            let actual = if mismatch {
                "00000000-0000-4000-8000-000000000002"
            } else {
                expected
            };
            let worker = std::thread::spawn(move || {
                let replies = [
                    json!({"access_token":"fresh-access","refresh_token":"fresh-refresh","expires_in":3600}),
                    json!({"id":actual}),
                    if mismatch {
                        json!({})
                    } else {
                        json!({"id":expected,"username":"alice","nickname":"Alice","avatar":0,"friendCode":"CODE"})
                    },
                ];
                let mut requests = Vec::new();
                for body in replies {
                    let (mut stream, _) = listener.accept().unwrap();
                    stream
                        .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                        .unwrap();
                    let mut buffer = [0; 8192];
                    let n = stream.read(&mut buffer).unwrap();
                    requests.push(String::from_utf8_lossy(&buffer[..n]).to_string());
                    let body = body.to_string();
                    write!(
                        stream,
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    )
                    .unwrap();
                }
                requests
            });
            let api = Api::new(&Config {
                server_url: format!("http://{address}"),
                ..Config::default()
            })
            .unwrap();
            let result = authenticate_original(&api, "alice", "test-password-123", expected).await;
            let requests = worker.join().unwrap();
            assert!(requests[0].starts_with("POST /auth/v1/token"));
            assert!(requests[1].starts_with("GET /auth/v1/user"));
            if mismatch {
                assert!(result.is_err());
                assert!(requests[2].starts_with("POST /auth/v1/logout"));
                assert!(!requests
                    .iter()
                    .any(|request| request.contains("koipage_claim")));
            } else {
                let (tokens, account) = result.unwrap();
                assert_eq!(tokens.access_token, "fresh-access");
                assert_eq!(account.id, expected);
                assert!(requests[2].contains("/rest/v1/rpc/koipage_claim"));
            }
        }
    }

    #[test]
    fn pending_receipt_cannot_be_reused_to_delete_a_different_account() {
        assert!(target_identity(Some("bob"), Some("alice"), Some("bob")).is_err());
        assert!(target_identity(Some("alice"), None, Some("bob")).is_err());
        assert_eq!(
            target_identity(Some("alice"), None, Some("alice")).unwrap(),
            "alice"
        );
        assert_eq!(target_identity(None, Some("alice"), None).unwrap(), "alice");
    }
}
