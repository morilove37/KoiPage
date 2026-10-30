use super::model::{Account, RemoteCollection, SyncValue};
use crate::commands::error::{CmdError, CmdResult};
use reqwest::{
    Method, StatusCode, Url,
    header::{AUTHORIZATION, HeaderMap, HeaderValue},
};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Map, json};
use std::time::Duration;

// No Debug implementation: the HTTP client owns a sensitive Authorization header.
pub struct Client {
    http: reqwest::Client,
    base: Url,
}

fn error(code: &str, message: &str) -> CmdError {
    CmdError(format!("{code}: {message}"))
}
fn invalid() -> CmdError {
    error("BGM_INVALID_INPUT", "Bangumi 同步参数无效")
}
fn http_error(status: StatusCode) -> CmdError {
    let message = match status.as_u16() {
        401 => "Bangumi 令牌已失效，请重新连接",
        403 => "Bangumi 拒绝访问，请检查令牌权限",
        404 => "Bangumi 条目或用户不存在",
        429 => "Bangumi 请求过于频繁，请稍后再试",
        _ => "Bangumi 请求失败",
    };
    error(&format!("BGM_HTTP_{}", status.as_u16()), message)
}

impl Client {
    pub fn new(token: &str) -> CmdResult<Self> {
        if token.is_empty() || token.len() > 2560 || token.bytes().any(|b| !b.is_ascii_graphic()) {
            return Err(invalid());
        }
        let mut authorization =
            HeaderValue::from_str(&format!("Bearer {token}")).map_err(|_| invalid())?;
        authorization.set_sensitive(true);
        let mut headers = HeaderMap::new();
        headers.insert(AUTHORIZATION, authorization);
        let http = reqwest::Client::builder()
            .default_headers(headers)
            .user_agent(concat!(
                "KoiPage/",
                env!("CARGO_PKG_VERSION"),
                " (https://github.com/morilove37/KoiPage)"
            ))
            // Reject all redirects so credentials cannot reach another origin.
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|_| error("BGM_CLIENT", "无法创建 Bangumi 连接"))?;
        Ok(Self {
            http,
            base: Url::parse("https://api.bgm.tv/v0/").map_err(|_| invalid())?,
        })
    }
    fn url(&self, segments: &[&str]) -> CmdResult<Url> {
        let mut url = self.base.clone();
        {
            let mut path = url.path_segments_mut().map_err(|_| invalid())?;
            path.pop_if_empty();
            for segment in segments {
                if segment.is_empty() || *segment == "." || *segment == ".." {
                    return Err(invalid());
                }
                path.push(segment);
            }
        }
        Ok(url)
    }
    async fn send(&self, request: reqwest::RequestBuilder) -> CmdResult<reqwest::Response> {
        // Never stringify reqwest errors: they may contain request URLs or other context.
        request
            .send()
            .await
            .map_err(|_| error("BGM_NETWORK", "无法连接 Bangumi，请检查网络"))
    }
    async fn decode<T: DeserializeOwned>(&self, response: reqwest::Response) -> CmdResult<T> {
        if !response.status().is_success() {
            return Err(http_error(response.status()));
        }
        response
            .json()
            .await
            .map_err(|_| error("BGM_RESPONSE", "Bangumi 返回的数据格式无效"))
    }
    pub async fn me(&self) -> CmdResult<Account> {
        self.decode(self.send(self.http.get(self.url(&["me"])?)).await?)
            .await
    }
    pub async fn collections(&self, username: &str) -> CmdResult<Vec<RemoteCollection>> {
        #[derive(Deserialize)]
        struct Page {
            total: usize,
            data: Vec<RemoteCollection>,
        }
        let mut all = Vec::new();
        let mut offset = 0usize;
        loop {
            let response = self
                .send(
                    self.http
                        .get(self.url(&["users", username, "collections"])?)
                        .query(&[("subject_type", 4usize), ("limit", 100), ("offset", offset)]),
                )
                .await?;
            let page: Page = self.decode(response).await?;
            if page.total > 10_000 || all.len() + page.data.len() > 10_000 {
                return Err(error("BGM_LIMIT", "Bangumi 收藏超过同步上限（10000）"));
            }
            if page.data.is_empty() && offset < page.total {
                return Err(error("BGM_RESPONSE", "Bangumi 收藏分页不完整，请稍后重试"));
            }
            for item in &page.data {
                validate_collection(item)?;
            }
            offset += page.data.len();
            all.extend(page.data);
            if offset >= page.total {
                return Ok(all);
            }
        }
    }
    pub async fn collection(
        &self,
        username: &str,
        subject_id: i64,
    ) -> CmdResult<Option<RemoteCollection>> {
        if subject_id <= 0 {
            return Err(invalid());
        }
        let response = self
            .send(self.http.get(self.url(&[
                "users",
                username,
                "collections",
                &subject_id.to_string(),
            ])?))
            .await?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        let item: RemoteCollection = self.decode(response).await?;
        validate_collection(&item)?;
        if item.subject_id != subject_id {
            return Err(error("BGM_RESPONSE", "Bangumi 返回的收藏条目不匹配"));
        }
        Ok(Some(item))
    }
    pub async fn validate_game(&self, subject_id: i64) -> CmdResult<()> {
        if subject_id <= 0 {
            return Err(invalid());
        }
        #[derive(Deserialize)]
        struct Subject {
            id: i64,
            #[serde(rename = "type")]
            kind: i64,
        }
        let subject: Subject = self
            .decode(
                self.send(
                    self.http
                        .get(self.url(&["subjects", &subject_id.to_string()])?),
                )
                .await?,
            )
            .await?;
        if subject.id != subject_id || subject.kind != 4 {
            return Err(error("BGM_NOT_GAME", "Bangumi ID 必须指向游戏条目"));
        }
        Ok(())
    }
    pub async fn write(
        &self,
        subject_id: i64,
        value: &SyncValue,
        create: bool,
        private_new: bool,
        fields: &[String],
    ) -> CmdResult<()> {
        if subject_id <= 0 {
            return Err(invalid());
        }
        let mut body = Map::new();
        for field in fields {
            match field.as_str() {
                "status" => {
                    let kind = value
                        .collection_type
                        .filter(|v| (1..=5).contains(v))
                        .ok_or_else(invalid)?;
                    body.insert("type".into(), json!(kind));
                }
                "rate" => {
                    if !(0..=10).contains(&value.rate) {
                        return Err(invalid());
                    }
                    body.insert("rate".into(), json!(value.rate));
                }
                "comment" => {
                    body.insert("comment".into(), json!(value.comment));
                }
                _ => return Err(invalid()),
            }
        }
        if create {
            // A new collection requires an explicitly selected, meaningful status.
            if !body.contains_key("type") {
                return Err(invalid());
            }
            body.insert("private".into(), json!(private_new));
        }
        if body.is_empty() {
            return Ok(());
        }
        let method = if create { Method::POST } else { Method::PATCH };
        let response = self
            .send(
                self.http
                    .request(
                        method,
                        self.url(&["users", "-", "collections", &subject_id.to_string()])?,
                    )
                    .json(&body),
            )
            .await?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(http_error(response.status()))
        }
    }
}
fn validate_collection(item: &RemoteCollection) -> CmdResult<()> {
    if item.subject_id <= 0
        || item.subject_type != 4
        || !(1..=5).contains(&item.collection_type)
        || !(0..=10).contains(&item.rate)
    {
        Err(error("BGM_RESPONSE", "Bangumi 返回的游戏收藏数据无效"))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::mpsc,
        thread,
        time::Duration,
    };

    // A local HTTP boundary captures actual reqwest requests; no live API calls.
    fn server(
        responses: Vec<(u16, Value, Option<String>)>,
    ) -> (Client, mpsc::Receiver<String>, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}/v0/", listener.local_addr().unwrap());
        let (tx, rx) = mpsc::channel();
        let handle = thread::spawn(move || {
            for (status, body, location) in responses {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut buf = [0; 4096];
                loop {
                    let read = stream.read(&mut buf).unwrap();
                    if read == 0 {
                        break;
                    }
                    bytes.extend_from_slice(&buf[..read]);
                    if let Some(end) = bytes.windows(4).position(|s| s == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..end]);
                        let len = headers
                            .lines()
                            .find_map(|s| {
                                s.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .and_then(|v| v.trim().parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if bytes.len() >= end + 4 + len {
                            break;
                        }
                    }
                }
                tx.send(String::from_utf8(bytes).unwrap()).unwrap();
                let body = body.to_string();
                let location = location
                    .map(|s| format!("Location: {s}\r\n"))
                    .unwrap_or_default();
                write!(stream, "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{location}\r\n{body}", body.len()).unwrap();
            }
        });
        let mut client = Client::new("test-token-only").unwrap();
        client.base = reqwest::Url::parse(&base).unwrap();
        (client, rx, handle)
    }
    fn remote(id: i64) -> Value {
        json!({"subject_id":id,"subject_type":4,"type":3,"rate":8,"comment":"hello","private":true})
    }
    fn request(rx: &mpsc::Receiver<String>) -> String {
        rx.recv_timeout(Duration::from_secs(4)).unwrap()
    }
    fn fields(values: &[&str]) -> Vec<String> {
        values.iter().map(|s| s.to_string()).collect()
    }

    #[tokio::test]
    async fn collection_list_accepts_bangumi_null_comment_as_empty() {
        let mut item = remote(10);
        item["comment"] = Value::Null;
        let (client, rx, thread) = server(vec![(200, json!({"total":1,"data":[item]}), None)]);
        let result = client.collections("tester").await;
        request(&rx);
        thread.join().unwrap();
        let all = result.expect("Bangumi returns null for an unset comment");
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].value().comment, "");
    }

    #[tokio::test]
    async fn collection_detail_accepts_null_comment_without_clearing_other_fields() {
        let mut item = remote(10);
        item["comment"] = Value::Null;
        let (client, rx, thread) = server(vec![(200, item, None)]);
        let result = client.collection("tester", 10).await;
        request(&rx);
        thread.join().unwrap();
        let item = result.expect("single-collection reads also allow null comments").unwrap();
        assert_eq!(item.comment, "");
        assert_eq!(item.rate, 8);
        assert_eq!(item.collection_type, 3);
        assert!(item.private);
    }

    #[test]
    fn collection_comment_defaults_only_for_null_or_missing_values() {
        let mut item = remote(10);
        item.as_object_mut().unwrap().remove("comment");
        assert_eq!(serde_json::from_value::<RemoteCollection>(item.clone()).unwrap().comment, "");
        item["comment"] = json!(42);
        assert!(serde_json::from_value::<RemoteCollection>(item.clone()).is_err());
        item["comment"] = json!(false);
        assert!(serde_json::from_value::<RemoteCollection>(item).is_err());
    }

    #[tokio::test]
    async fn me_authenticates_and_reads_account() {
        let (client, rx, thread) = server(vec![(
            200,
            json!({"id":7,"username":"tester","nickname":"Test"}),
            None,
        )]);
        assert_eq!(client.me().await.unwrap().id, 7);
        let req = request(&rx);
        assert!(req.starts_with("GET /v0/me HTTP/1.1"));
        assert!(
            req.to_lowercase()
                .contains("authorization: bearer test-token-only")
        );
        assert!(req.to_lowercase().contains("user-agent: koipage/"));
        thread.join().unwrap();
    }
    #[tokio::test]
    async fn pagination_fetches_every_game_page() {
        let (client, rx, thread) = server(vec![
            (200, json!({"total":2,"data":[remote(10)]}), None),
            (200, json!({"total":2,"data":[remote(11)]}), None),
        ]);
        let all = client.collections("tester").await.unwrap();
        assert_eq!(
            all.iter().map(|r| r.subject_id).collect::<Vec<_>>(),
            vec![10, 11]
        );
        let first = request(&rx);
        let second = request(&rx);
        assert!(first.contains("subject_type=4"));
        assert!(first.contains("offset=0"));
        assert!(second.contains("offset=1"));
        thread.join().unwrap();
    }
    #[tokio::test]
    async fn pagination_failure_never_returns_partial_data_or_secret() {
        let (client, rx, thread) = server(vec![
            (200, json!({"total":2,"data":[remote(10)]}), None),
            (429, json!({"error":"test-token-only sensitive body"}), None),
        ]);
        let error = client.collections("tester").await.unwrap_err().to_string();
        assert!(error.starts_with("BGM_HTTP_429:"));
        assert!(!error.contains("test-token-only"));
        assert!(!error.contains("sensitive body"));
        request(&rx);
        request(&rx);
        thread.join().unwrap();
    }
    #[tokio::test]
    async fn missing_collection_is_none() {
        let (client, rx, thread) = server(vec![(404, json!({}), None)]);
        assert!(client.collection("tester", 10).await.unwrap().is_none());
        request(&rx);
        thread.join().unwrap();
    }
    #[tokio::test]
    async fn validates_subject_type_before_binding() {
        let (client, rx, thread) = server(vec![
            (200, json!({"id":10,"type":2}), None),
            (200, json!({"id":11,"type":4}), None),
        ]);
        assert!(client.validate_game(10).await.is_err());
        client.validate_game(11).await.unwrap();
        request(&rx);
        request(&rx);
        thread.join().unwrap();
    }
    #[tokio::test]
    async fn write_sends_only_selected_fields_and_preserves_existing_privacy() {
        let (client, rx, thread) = server(vec![(204, json!(null), None), (204, json!(null), None)]);
        let value = SyncValue {
            collection_type: Some(3),
            rate: 0,
            comment: "personal".into(),
        };
        client
            .write(10, &value, false, true, &fields(&["rate"]))
            .await
            .unwrap();
        client
            .write(10, &value, true, true, &fields(&["status", "comment"]))
            .await
            .unwrap();
        let patch = request(&rx);
        let post = request(&rx);
        assert!(patch.starts_with("PATCH /v0/users/-/collections/10 "));
        assert_eq!(
            serde_json::from_str::<Value>(patch.split("\r\n\r\n").nth(1).unwrap()).unwrap(),
            json!({"rate":0})
        );
        assert!(post.starts_with("POST /v0/users/-/collections/10 "));
        assert_eq!(
            serde_json::from_str::<Value>(post.split("\r\n\r\n").nth(1).unwrap()).unwrap(),
            json!({"type":3,"comment":"personal","private":true})
        );
        thread.join().unwrap();
    }
    #[tokio::test]
    async fn redirects_are_rejected_without_following_location() {
        let trap = TcpListener::bind("127.0.0.1:0").unwrap();
        trap.set_nonblocking(true).unwrap();
        let (client, rx, thread) = server(vec![(
            302,
            json!({}),
            Some(format!("http://{}/leak", trap.local_addr().unwrap())),
        )]);
        assert!(
            client
                .me()
                .await
                .unwrap_err()
                .to_string()
                .starts_with("BGM_HTTP_302:")
        );
        assert!(trap.accept().is_err());
        request(&rx);
        thread.join().unwrap();
    }
    #[tokio::test]
    async fn invalid_input_is_rejected_before_network() {
        let client = Client::new("test-token-only").unwrap();
        assert!(Client::new("bad\r\nheader").is_err());
        assert!(Client::new("").is_err());
        assert!(client.validate_game(0).await.is_err());
        assert!(
            client
                .write(1, &SyncValue::default(), true, true, &fields(&["status"]))
                .await
                .is_err()
        );
        assert!(
            client
                .write(1, &SyncValue::default(), false, true, &fields(&["tags"]))
                .await
                .is_err()
        );
    }
    #[tokio::test]
    async fn auth_failure_is_sanitized_and_is_not_retried() {
        let (client, rx, thread) = server(vec![(
            401,
            json!({"error":"test-token-only private upstream response"}),
            None,
        )]);
        let error = client.me().await.unwrap_err().to_string();
        assert!(error.starts_with("BGM_HTTP_401:"));
        assert!(!error.contains("test-token-only"));
        assert!(!error.contains("private upstream response"));
        request(&rx);
        thread.join().unwrap();
        assert!(rx.try_recv().is_err());
    }
    #[tokio::test]
    async fn excessive_or_incomplete_collections_are_rejected() {
        let (client, rx, thread) = server(vec![
            (200, json!({"total":10001,"data":[]}), None),
            (200, json!({"total":1,"data":[]}), None),
        ]);
        assert!(
            client
                .collections("tester")
                .await
                .unwrap_err()
                .to_string()
                .starts_with("BGM_LIMIT:")
        );
        assert!(
            client
                .collections("tester")
                .await
                .unwrap_err()
                .to_string()
                .starts_with("BGM_RESPONSE:")
        );
        request(&rx);
        request(&rx);
        thread.join().unwrap();
    }
    #[tokio::test]
    async fn malformed_account_and_non_game_collection_fail_closed() {
        let mut non_game = remote(10);
        non_game["subject_type"] = json!(2);
        let (client, rx, thread) = server(vec![
            (200, json!({"secret":"test-token-only"}), None),
            (200, non_game, None),
        ]);
        let error = client.me().await.unwrap_err().to_string();
        assert!(error.starts_with("BGM_RESPONSE:"));
        assert!(!error.contains("test-token-only"));
        assert!(client.collection("tester", 10).await.is_err());
        request(&rx);
        request(&rx);
        thread.join().unwrap();
    }
}
