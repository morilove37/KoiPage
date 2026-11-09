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
        self.request(
            Method::POST,
            &format!("/rest/v1/rpc/{name}"),
            Some(token),
            body,
        )
        .await
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
    let (kind, summary) = if message.contains("FRIENDS_SESSION") {
        ("SESSION", "登录已失效或账号已在另一端登录，请重新登录")
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
