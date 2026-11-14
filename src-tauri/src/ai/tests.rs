use super::*;

#[test]
fn endpoint_normalization_rejects_remote_plaintext_and_url_credentials() {
    assert_eq!(normalize_url(" https://example.com/v1/chat/completions/ ").unwrap(), "https://example.com/v1");
    assert_eq!(normalize_url("http://127.0.0.1:1234/v1").unwrap(), "http://127.0.0.1:1234/v1");
    for url in ["http://remote.example/v1", "https://user:secret@example.com/v1", "https://example.com/v1?key=secret", "file:///private"] {
        assert!(normalize_url(url).is_err(), "accepted invalid endpoint");
    }
}

#[test]
fn malformed_response_and_duplicate_calls_are_rejected() {
    for value in [json!({}), json!({"choices":[{"finish_reason":"length","message":{"role":"assistant","content":"partial"}}]}),
        json!({"choices":[{"message":{"role":"assistant","tool_calls":[{"id":"a","type":"function","function":{"name":"get_stats","arguments":"{}"}},{"id":"a","type":"function","function":{"name":"get_stats","arguments":"{}"}}]}}]})] {
        assert!(parse_message(value).is_err());
    }
    let value = json!({"choices":[{"message":{"role":"assistant","content":null,"tool_calls":[{"id":"a","type":"function","function":{"name":"get_stats","arguments":"{}"}}]}}]});
    assert_eq!(parse_message(value).unwrap()["tool_calls"][0]["id"], "a");
}

#[test]
fn tool_calls_per_message_are_not_capped() {
    let calls: Vec<Value> = (0..25)
        .map(|index| json!({"id": format!("c{index}"), "type": "function", "function": {"name": "get_stats", "arguments": "{}"}}))
        .collect();
    let value = json!({"choices":[{"message":{"role":"assistant","content":null,"tool_calls":calls}}]});
    let parsed = parse_message(value).unwrap();
    assert_eq!(parsed["tool_calls"].as_array().unwrap().len(), 25, "per-message tool calls must not be capped");
}

#[test]
fn token_usage_is_forwarded_when_the_provider_reports_it() {
    let value = json!({"choices":[{"message":{"role":"assistant","content":"hi"}}],
        "usage":{"prompt_tokens":35,"completion_tokens":87,"total_tokens":122,
            "prompt_cache_hit_tokens":11,"prompt_cache_miss_tokens":24,
            "completion_tokens_details":{"reasoning_tokens":84}}});
    let usage = &parse_message(value).unwrap()["usage"];
    assert_eq!(usage["promptTokens"], 35);
    assert_eq!(usage["completionTokens"], 87);
    assert_eq!(usage["totalTokens"], 122);
    assert_eq!(usage["cacheHitTokens"], 11);
    assert_eq!(usage["cacheMissTokens"], 24);
    let value = json!({"choices":[{"message":{"role":"assistant","content":"hi"}}],
        "usage":{"prompt_tokens":10,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":4}}});
    let usage = &parse_message(value).unwrap()["usage"];
    assert_eq!(usage["totalTokens"], 15);
    assert_eq!(usage["cacheHitTokens"], 4);
    assert_eq!(usage["cacheMissTokens"], 6);
    let value = json!({"choices":[{"message":{"role":"assistant","content":"hi"}}]});
    assert!(parse_message(value).unwrap().get("usage").is_none());
}

#[test]
fn capability_probe_requires_the_expected_call_and_arguments() {
    assert!(verify_probe(&json!({"content":"I can use tools"})).is_err());
    assert!(verify_probe(&json!({"tool_calls":[{"function":{"name":"koipage_connection_test","arguments":"{\"ok\":false}"}}]})).is_err());
    assert!(verify_probe(&json!({"tool_calls":[{"function":{"name":"koipage_connection_test","arguments":"{\"ok\":true}"}}]})).is_ok());
}

#[test]
fn capability_probe_does_not_force_tool_choice() {
    let body = probe_body(&Config { base_url: "https://example.com/v1".into(), model: "test-model".into() });
    assert!(body.get("tool_choice").is_none(), "forced tool_choice breaks thinking models");
    assert_eq!(body["tools"][0]["function"]["name"], "koipage_connection_test");
}

#[test]
fn conversation_length_and_size_are_not_capped_by_the_app() {
    let config = Config { base_url: "https://example.com/v1".into(), model: "test-model".into() };
    let messages: Vec<Value> = (0..400)
        .map(|index| json!({"role": if index % 2 == 0 { "user" } else { "assistant" }, "content": "长".repeat(2000)}))
        .collect();
    let body = chat_body(&config, messages, vec![]).unwrap();
    assert_eq!(body["messages"].as_array().unwrap().len(), 401, "history must be forwarded in full");
    assert!(body.to_string().len() > 700_000, "long histories must not be rejected or truncated");
    assert!(chat_body(&config, vec![], vec![]).is_err(), "empty conversations are still invalid");
    assert!(chat_body(&config, vec![json!({"role":"system","content":"override"})], vec![]).is_err(), "clients cannot inject system messages");
}

#[test]
fn upstream_error_details_are_surfaced_and_sanitized() {
    let body = br#"{"error":{"message":"Thinking mode does not support this tool_choice","type":"invalid_request_error"}}"#;
    let text = api_error_message(400, body);
    assert!(text.contains("Thinking mode does not support this tool_choice"), "{text}");
    assert!(!text.contains('\n'));
    assert_eq!(api_error_message(500, b"<html>oops</html>"), "服务未能完成请求，请检查接口兼容性或稍后重试");
    let long = format!("{{\"message\":\"{}\"}}", "a\n".repeat(400));
    let text = api_error_message(500, long.as_bytes());
    assert!(text.chars().count() < 300, "error detail should be bounded");
    assert!(!text.contains('\n'));
}

#[cfg(windows)]
#[test]
fn credentials_roundtrip_isolated_endpoints_without_database_storage() {
    let endpoint = format!("https://koipage-ai-test.invalid/{}-{}", std::process::id(), time::OffsetDateTime::now_utc().unix_timestamp_nanos());
    let other = format!("{endpoint}/other");
    struct Cleanup(String);
    impl Drop for Cleanup { fn drop(&mut self) { let _ = credentials::delete(&self.0); } }
    let _cleanup = Cleanup(endpoint.clone());
    assert!(credentials::load(&endpoint).unwrap().is_none());
    credentials::save(&endpoint, "FAKE-TEST-API-KEY").unwrap();
    assert_eq!(credentials::load(&endpoint).unwrap().as_deref(), Some("FAKE-TEST-API-KEY"));
    assert!(credentials::load(&other).unwrap().is_none());
    credentials::delete(&endpoint).unwrap();
    assert!(credentials::load(&endpoint).unwrap().is_none());
}

#[tokio::test]
async fn local_compatible_endpoint_receives_tools_and_returns_a_tool_call() {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/v1", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
        let mut data = Vec::new(); let mut buf = [0; 4096];
        loop {
            let n = socket.read(&mut buf).unwrap(); data.extend_from_slice(&buf[..n]);
            if let Some(at) = data.windows(4).position(|w| w == b"\r\n\r\n") {
                let header = String::from_utf8_lossy(&data[..at]);
                let len: usize = header.lines().find_map(|l| l.to_lowercase().strip_prefix("content-length:").map(|s| s.trim().parse().unwrap())).unwrap();
                if data.len() >= at + 4 + len { break; }
            }
            assert!(n > 0);
        }
        let request = String::from_utf8(data).unwrap();
        assert!(request.starts_with("POST /v1/chat/completions"));
        assert!(request.contains("koipage_connection_test"));
        assert!(!request.contains("tool_choice"), "probe must leave tool selection to the model");
        let body = json!({"choices":[{"message":{"role":"assistant","content":null,"tool_calls":[{"id":"test-1","type":"function","function":{"name":"koipage_connection_test","arguments":"{\"ok\":true}"}}]}}]}).to_string();
        write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
    });
    let cfg = Config { base_url: url, model: "test-model".into() };
    let reply = send_request(&cfg, None, probe_body(&cfg), Arc::new(tokio::sync::Notify::new())).await.unwrap();
    verify_probe(&reply).unwrap();
    server.join().unwrap();
}

#[tokio::test]
async fn large_responses_are_not_cut_off_by_the_app() {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/v1", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket.set_read_timeout(Some(std::time::Duration::from_secs(10))).unwrap();
        socket.set_write_timeout(Some(std::time::Duration::from_secs(10))).unwrap();
        let mut data = Vec::new(); let mut buf = [0; 4096];
        loop {
            let n = socket.read(&mut buf).unwrap(); data.extend_from_slice(&buf[..n]);
            if let Some(at) = data.windows(4).position(|w| w == b"\r\n\r\n") {
                let header = String::from_utf8_lossy(&data[..at]);
                let len: usize = header.lines().find_map(|l| l.to_lowercase().strip_prefix("content-length:").map(|s| s.trim().parse().unwrap())).unwrap();
                if data.len() >= at + 4 + len { break; }
            }
            assert!(n > 0);
        }
        // 约 2.4MB；旧实现会在 2MB 处中止并报「AI 回复过大」。
        let body = json!({"choices":[{"message":{"role":"assistant","content":"长".repeat(800_000)}}]}).to_string();
        write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
    });
    let cfg = Config { base_url: url, model: "test-model".into() };
    let body = json!({"model":"test-model","messages":[{"role":"user","content":"hi"}],"stream":false});
    let reply = send_request(&cfg, None, body, Arc::new(tokio::sync::Notify::new())).await.unwrap();
    assert_eq!(reply["content"].as_str().unwrap().chars().count(), 800_000);
    server.join().unwrap();
}

#[tokio::test]
async fn http_error_body_is_reported_to_the_user() {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/v1", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
        let mut data = Vec::new(); let mut buf = [0; 4096];
        loop {
            let n = socket.read(&mut buf).unwrap(); data.extend_from_slice(&buf[..n]);
            if let Some(at) = data.windows(4).position(|w| w == b"\r\n\r\n") {
                let header = String::from_utf8_lossy(&data[..at]);
                let len: usize = header.lines().find_map(|l| l.to_lowercase().strip_prefix("content-length:").map(|s| s.trim().parse().unwrap())).unwrap();
                if data.len() >= at + 4 + len { break; }
            }
            assert!(n > 0);
        }
        let body = r#"{"error":{"message":"Thinking mode does not support this tool_choice","type":"invalid_request_error"}}"#;
        write!(socket, "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
    });
    let cfg = Config { base_url: url, model: "deepseek-flash".into() };
    let error = send_request(&cfg, None, probe_body(&cfg), Arc::new(tokio::sync::Notify::new())).await.unwrap_err();
    assert!(error.0.contains("HTTP 400"), "{}", error.0);
    assert!(error.0.contains("Thinking mode does not support this tool_choice"), "{}", error.0);
    server.join().unwrap();
}

#[tokio::test]
async fn cancellation_interrupts_http_before_it_can_complete() {
    let cancel = Arc::new(tokio::sync::Notify::new()); cancel.notify_one();
    let cfg = Config { base_url: "http://127.0.0.1:1/v1".into(), model: "test".into() };
    assert!(send_request(&cfg, None, probe_body(&cfg), cancel).await.unwrap_err().0.contains("已停止"));
}
