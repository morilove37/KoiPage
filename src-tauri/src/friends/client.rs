use super::model::{Config, Tokens, now};
use crate::commands::error::{CmdError, CmdResult};
use reqwest::{Client, Method};
use serde_json::{Value, json};
use std::time::Duration;

pub struct Api {
    http: Client,
    config: Config,
}
impl Api {
    pub fn new(config: &Config) -> CmdResult<Self> {
        Ok(Self {
            config: config.clone(),
            http: Client::builder()
                .timeout(Duration::from_secs(8))
                .connect_timeout(Duration::from_secs(5))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|_| CmdError("FRIENDS_NETWORK: 无法建立连接".into()))?,
        })
    }
    pub async fn request(
        &self,
        method: Method,
        path: &str,
        token: Option<&str>,
        body: Value,
    ) -> CmdResult<Value> {
        let mut request = self
            .http
            .request(method, format!("{}{path}", self.config.server_url))
            .header("apikey", &self.config.public_key)
            .header("Content-Type", "application/json");
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        let mut response = request
            .json(&body)
            .send()
            .await
            .map_err(|_| CmdError("FRIENDS_NETWORK: 无法连接内测服务，请稍后重试".into()))?;
        let status = response.status();
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| CmdError("FRIENDS_NETWORK: 服务响应中断".into()))?
        {
            if bytes.len() + chunk.len() > 524288 {
                return Err(CmdError("FRIENDS_PROTOCOL: 服务响应过大".into()));
            }
            bytes.extend_from_slice(&chunk);
        }
        let value = serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null);
        if !status.is_success() {
            return Err(response_error(status.as_u16(), &value));
        }
        if value.is_null() && status.as_u16() != 204 {
            return Err(CmdError("FRIENDS_PROTOCOL: 服务响应格式无效".into()));
        }
        Ok(value)
    }
    pub async fn rpc(&self, name: &str, token: &str, body: Value) -> CmdResult<Value> {
        let value = self
            .request(
                Method::POST,
                &format!("/rest/v1/rpc/{name}"),
                Some(token),
                body,
            )
            .await?;
        if let Some(code) = value["error"].as_str() {
            return Err(response_error(400, &json!({"message":code})));
        }
        Ok(value)
    }
    pub async fn password_login(&self, username: &str, password: &str) -> CmdResult<Tokens> {
        let value = self
            .request(
                Method::POST,
                "/auth/v1/token?grant_type=password",
                None,
                json!({"email":format!("{username}@accounts.koipage.invalid"),"password":password}),
            )
            .await?;
        parse_tokens(value)
    }
    pub async fn refresh(&self, refresh: &str) -> CmdResult<Tokens> {
        parse_tokens(
            self.request(
                Method::POST,
                "/auth/v1/token?grant_type=refresh_token",
                None,
                json!({"refresh_token":refresh}),
            )
            .await?,
        )
    }
    /// Delete the Auth user through the Edge Function, which holds the service key.
    pub async fn delete_account(&self, token: &str, receipt: &str) -> CmdResult<Value> {
        let value = self.request(
            Method::POST,
            "/functions/v1/friends-delete-account",
            Some(token),
            json!({"receipt":receipt}),
        )
        .await?;
        if value["ok"] != true || value["authDeleted"] != true {
            return Err(CmdError("FRIENDS_DELETION_PENDING: 注销结果尚未确认，请重试。".into()));
        }
        Ok(value)
    }
}
pub fn parse_tokens(value: Value) -> CmdResult<Tokens> {
    let access = value["access_token"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() < 4096);
    let refresh = value["refresh_token"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() < 512);
    match (access, refresh) {
        (Some(a), Some(r)) => Ok(Tokens {
            access_token: a.into(),
            refresh_token: r.into(),
            expires_at: now()
                + value["expires_in"]
                    .as_i64()
                    .unwrap_or(3600)
                    .clamp(60, 86400),
        }),
        _ => Err(CmdError(
            "FRIENDS_PROTOCOL: 未取得有效登录会话，请确认已关闭邮箱验证".into(),
        )),
    }
}
fn response_error(status: u16, value: &Value) -> CmdError {
    let message = value["message"].as_str().unwrap_or("");
    let auth_code = value["error_code"]
        .as_str()
        .or_else(|| value["code"].as_str())
        .unwrap_or("");
    let terminal = matches!(
        auth_code,
        "refresh_token_not_found"
            | "refresh_token_already_used"
            | "session_not_found"
            | "session_expired"
            | "user_banned"
            | "bad_jwt"
    );
    let (kind, summary) = if terminal || message.contains("FRIENDS_SESSION") {
        ("SESSION", "登录已失效或账号已在另一端登录，请重新登录")
    } else if auth_code == "FRIENDS_IP_BANNED" || message.contains("FRIENDS_IP_BANNED") {
        ("IP_BANNED", "当前网络已被禁止注册或使用内测服务，请联系管理员")
    } else if auth_code == "FRIENDS_LIBRARY_BANNED" || message.contains("FRIENDS_LIBRARY_BANNED") {
        ("LIBRARY_BANNED", "该账号的游戏库已被管理员关闭或封禁")
    } else if auth_code == "FRIENDS_LIBRARY_CLOSED" || message.contains("FRIENDS_LIBRARY_CLOSED") {
        ("LIBRARY_CLOSED", "该账号的公开游戏库已被管理员强制关闭，请联系管理员处理")
    } else if message.contains("FRIENDS_UPGRADE_REQUIRED") {
        ("UPGRADE_REQUIRED", "请更新客户端后使用账号注销服务")
    } else if auth_code == "FRIENDS_CONSENT_REQUIRED" {
        ("CONSENT_REQUIRED", "请先阅读并同意当前版本的服务协议、隐私政策和出境告知；旧版客户端请更新后注册")
    } else if auth_code == "FRIENDS_IP_REGISTERED" {
        ("IP_REGISTERED", "当前公网 IP 已注册过账号，同一网络可能共用名额，请使用已有账号登录")
    } else if message.contains("FRIENDS_INVITE") {
        ("INVITE", "邀请码无效、已使用或已过期")
    } else if message.contains("FRIENDS_CAPACITY") {
        ("CAPACITY", "本轮内测名额已满")
    } else if message.contains("FRIENDS_RATE") || status == 429 {
        ("RATE", "操作过于频繁，请稍后重试")
    } else if message.contains("FRIENDS_UNAVAILABLE") {
        ("UNAVAILABLE", "无法添加该用户，请检查好友码")
    } else if message.contains("FRIENDS_REQUEST") {
        ("REQUEST", "好友申请已变化，请刷新后重试")
    } else if status == 401 || status == 403 {
        ("SESSION", "登录信息无效，请重新登录")
    } else if (400..500).contains(&status) {
        ("INPUT", "请求未被接受，请检查账号、密码或内测配置")
    } else {
        ("NETWORK", "内测服务暂时不可用，请稍后重试")
    };
    CmdError(format!("FRIENDS_{kind}: {summary}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn consent_rejection_is_actionable_and_does_not_echo_provider_content() {
        let error = response_error(400, &json!({"code":"FRIENDS_CONSENT_REQUIRED","message":"untrusted-provider-body"}));
        assert!(error.0.starts_with("FRIENDS_CONSENT_REQUIRED:"));
        assert!(error.0.contains("更新"));
        assert!(!error.0.contains("untrusted-provider-body"));
    }
    #[test]
    fn registered_ip_is_a_permanent_registration_rule_not_a_temporary_rate_limit() {
        let error = response_error(429, &json!({"code":"FRIENDS_IP_REGISTERED","message":"untrusted-provider-body"}));
        assert!(error.0.starts_with("FRIENDS_IP_REGISTERED:"));
        assert!(error.0.contains("已注册"));
        assert!(!error.0.contains("untrusted-provider-body"));
    }
    #[test]
    fn errors_never_echo_passwords_tokens_or_response_bodies() {
        let error = response_error(
            400,
            &json!({"message":"password=hunter2 token=private-key"}),
        );
        assert!(!error.0.contains("hunter2") && !error.0.contains("private-key"));
        assert!(
            response_error(400, &json!({"message":"FRIENDS_SESSION_REPLACED"}))
                .0
                .starts_with("FRIENDS_SESSION")
        );
    }
    #[test]
    fn terminal_auth_refresh_errors_require_a_new_login() {
        for code in [
            "refresh_token_not_found",
            "refresh_token_already_used",
            "session_not_found",
            "session_expired",
            "user_banned",
        ] {
            assert!(
                response_error(400, &json!({"error_code":code}))
                    .0
                    .starts_with("FRIENDS_SESSION"),
                "{code}"
            );
        }
    }
    #[test]
    fn banned_network_and_library_are_permanent_rule_errors() {
        let ip = response_error(400, &json!({"message":"FRIENDS_IP_BANNED"}));
        assert!(ip.0.starts_with("FRIENDS_IP_BANNED:"));
        assert!(ip.0.contains("禁止"));
        let library = response_error(400, &json!({"message":"FRIENDS_LIBRARY_BANNED"}));
        assert!(library.0.starts_with("FRIENDS_LIBRARY_BANNED:"));
        assert!(library.0.contains("游戏库"));
    }

    #[tokio::test]
    async fn deletion_needs_an_explicit_auth_completion_receipt() {
        use std::io::{Read, Write};
        for reply in [json!({"ok":true,"authDeleted":false}),json!({"ok":true}),json!({"ok":false,"authDeleted":true})] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let body = reply.to_string();
            let worker = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut buffer = [0; 4096];
                let _ = stream.read(&mut buffer);
                write!(stream,"HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
            });
            let api = Api::new(&Config {server_url:format!("http://{address}"),public_key:"sb_publishable_test".into(),..Config::default()}).unwrap();
            assert!(api.delete_account("test-token", &"a".repeat(64)).await.is_err(),"incomplete deletion must keep the login usable");
            worker.join().unwrap();
        }
    }

    #[tokio::test]
    async fn redirect_does_not_forward_bearer_credentials() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let worker = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0; 4096];
            let _ = stream.read(&mut buffer);
            stream.write_all(b"HTTP/1.1 302 Found\r\nLocation: https://should-not-be-requested.invalid/\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}").unwrap();
        });
        let api = Api::new(&Config {
            server_url: format!("http://{address}"),
            public_key: "sb_publishable_test".into(),
            ..Config::default()
        })
        .unwrap();
        let error = api
            .rpc("koipage_snapshot", "test-token", json!({}))
            .await
            .unwrap_err();
        assert!(!error.0.contains("test-token"));
        worker.join().unwrap();
    }
}
