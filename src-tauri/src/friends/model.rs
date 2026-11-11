use crate::commands::error::{CmdError, CmdResult};
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Config {
    pub server_url: String,
    pub public_key: String,
    pub enabled: bool,
    pub share_game: bool,
    pub share_library: bool,
    pub share_history: bool,
    pub invisible: bool,
    pub hidden_game_ids: Vec<i64>,
}

impl Default for Config {
    fn default() -> Self {
        let project: serde_json::Value =
            serde_json::from_str(include_str!("defaults.json")).unwrap_or_default();
        Self {
            server_url: project["serverUrl"].as_str().unwrap_or_default().into(),
            public_key: project["publicKey"].as_str().unwrap_or_default().into(),
            enabled: false,
            share_game: false,
            share_library: false,
            share_history: false,
            invisible: false,
            hidden_game_ids: Vec::new(),
        }
    }
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub username: String,
    pub nickname: String,
    pub avatar: u8,
    pub friend_code: String,
}

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct HideableGame {
    pub id: i64,
    pub title: String,
    pub original_title: Option<String>,
}

// Tokens deliberately have no Debug implementation and never appear in status DTOs.
#[derive(Clone, Serialize, Deserialize)]
pub struct Tokens {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: i64,
}

/// An opaque completion lookup; it cannot authenticate or authorize deletion.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletionReceipt {
    pub server_url: String,
    pub account_id: String,
    pub receipt: String,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub config: Config,
    pub account: Option<Account>,
    pub connected: bool,
    pub last_error: Option<String>,
    pub generation: u64,
    pub library_synced_at: Option<i64>,
    pub library_error: Option<String>,
    pub history_synced_at: Option<String>,
    pub history_error: Option<String>,
    #[serde(default)]
    pub deletion_pending: bool,
}

#[derive(Clone)]
pub struct RunningCandidate {
    pub game_id: i64,
    pub session_id: i64,
    pub started_at: String,
    pub duration: i64,
    pub title: String,
    pub vndb_id: Option<String>,
    pub bangumi_id: Option<String>,
}
#[derive(Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicGame {
    pub key: String,
    pub title: String,
    pub vndb_id: Option<String>,
    pub bangumi_id: Option<String>,
    pub duration: i64,
}

pub fn select_game(config: &Config, games: &[RunningCandidate]) -> Option<PublicGame> {
    if !config.share_game || config.invisible {
        return None;
    }
    let g = games.iter().max_by(|a, b| {
        a.started_at
            .cmp(&b.started_at)
            .then(a.session_id.cmp(&b.session_id))
    })?;
    if config.hidden_game_ids.contains(&g.game_id) {
        return None;
    }
    let title = g.title.trim().chars().take(200).collect::<String>();
    if title.is_empty() {
        return None;
    }
    let vndb_id = g
        .vndb_id
        .as_ref()
        .filter(|s| {
            s.starts_with('v')
                && s.len() > 1
                && s.len() <= 13
                && s[1..].bytes().all(|b| b.is_ascii_digit())
        })
        .cloned();
    let bangumi_id = g
        .bangumi_id
        .as_ref()
        .filter(|s| !s.is_empty() && s.len() <= 12 && s.bytes().all(|b| b.is_ascii_digit()))
        .cloned();
    Some(PublicGame {
        key: format!(
            "{:x}",
            Sha256::digest(format!("{}:{}", g.game_id, g.session_id))
        ),
        title,
        vndb_id,
        bangumi_id,
        duration: g.duration.clamp(0, 315576000),
    })
}

pub fn validate_project(address: &str, key: &str) -> CmdResult<String> {
    let url = reqwest::Url::parse(address.trim())
        .map_err(|_| CmdError("FRIENDS_CONFIG: 项目地址格式无效".into()))?;
    let loopback = matches!(
        url.host_str(),
        Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
    );
    if (url.scheme() != "https" && !(cfg!(debug_assertions) && url.scheme() == "http" && loopback))
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(CmdError(
            "FRIENDS_CONFIG: 请填写 HTTPS 项目根地址（开发版仅允许本机 HTTP）".into(),
        ));
    }
    let key = key.trim();
    let publishable = key.starts_with("sb_publishable_")
        && key.len() > 15
        && key.len() < 512
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    let anon = key
        .split('.')
        .nth(1)
        .and_then(|p| {
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(p)
                .ok()
        })
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .is_some_and(|v| v["role"] == "anon");
    if key.len() > 4096 || (!publishable && !anon) {
        return Err(CmdError(
            "FRIENDS_CONFIG: 仅接受 publishable 或 anon 公钥，不能填写管理密钥".into(),
        ));
    }
    Ok(url.as_str().trim_end_matches('/').to_owned())
}

pub fn validate_login(username: &str, password: &str) -> CmdResult<String> {
    let username = username.trim().to_ascii_lowercase();
    if !(3..=32).contains(&username.len())
        || !username
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
    {
        return Err(CmdError(
            "FRIENDS_INPUT: 用户名需为 3–32 位字母、数字或下划线".into(),
        ));
    }
    if password.len() < 12 || password.len() > 72 || !password.bytes().all(|b| b.is_ascii_graphic())
    {
        return Err(CmdError(
            "FRIENDS_INPUT: 密码需为 12–72 位英文字母、数字或符号，不支持中文和空格".into(),
        ));
    }
    Ok(username)
}

pub fn now() -> i64 {
    time::OffsetDateTime::now_utc().unix_timestamp()
}

/// Friends RPCs identify users by the UUID Auth assigns them.
pub fn valid_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

/// A friends search box accepts either a 16-digit friend code or a user name.
///
/// The exact lengths mirror `koipage_search_users`, so a query that cannot match
/// is rejected locally instead of costing a round trip.
pub fn search_query(query: &str) -> CmdResult<String> {
    let query = query.trim();
    let friend_code = query.len() == 16 && query.bytes().all(|byte| byte.is_ascii_hexdigit());
    // User names cannot contain spaces, so reject them locally as well.
    let name = (3..=32).contains(&query.chars().count())
        && query
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_');
    if query.is_empty() || (!friend_code && !name) {
        return Err(CmdError(
            "FRIENDS_INPUT: 请输入 16 位好友码或 3–32 位用户名".into(),
        ));
    }
    Ok(query.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_configuration_rejects_secrets_redirect_paths_and_remote_plaintext() {
        assert!(validate_project("https://example.supabase.co", "sb_publishable_test").is_ok());
        for url in [
            "http://example.com",
            "https://user:pass@example.com",
            "https://example.com/path",
            "https://example.com?token=x",
            "file:///C:/secret",
        ] {
            assert!(
                validate_project(url, "sb_publishable_test").is_err(),
                "{url}"
            );
        }
        assert!(validate_project("https://example.supabase.co", "sb_secret_private").is_err());
        assert!(
            validate_project(
                "https://example.supabase.co",
                "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.fake"
            )
            .is_err()
        );
    }

    #[test]
    fn newest_hidden_game_never_exposes_an_older_running_game() {
        let games = vec![candidate(1, 10), candidate(2, 20)];
        let mut config = Config::default();
        assert!(select_game(&config, &games).is_none());
        config.share_game = true;
        assert_eq!(select_game(&config, &games).unwrap().title, "game 2");
        config.hidden_game_ids = vec![2];
        assert!(select_game(&config, &games).is_none());
        config.hidden_game_ids.clear();
        config.invisible = true;
        assert!(select_game(&config, &games).is_none());
    }

    #[test]
    fn public_game_contains_only_allowlisted_metadata_and_stable_session_identity() {
        let config = Config {
            share_game: true,
            ..Config::default()
        };
        let game = select_game(&config, &[candidate(1, 10)]).unwrap();
        let value = serde_json::to_value(game).unwrap();
        let mut keys = value
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        keys.sort();
        assert_eq!(
            keys,
            vec!["bangumiId", "duration", "key", "title", "vndbId"]
        );
        assert_eq!(value["duration"], 42);
        assert_eq!(value["vndbId"], "v123");
        assert_ne!(value["key"], "10");
    }

    #[test]
    fn restored_config_is_disabled_and_passwords_do_not_silently_truncate() {
        let config: Config = serde_json::from_str("{}").unwrap();
        assert!(!config.enabled && !config.share_game && !config.invisible);
        assert!(validate_login("alice", "twelve-chars!x").is_ok());
        assert!(validate_login("bad name", "twelve-chars!x").is_err());
        assert!(validate_login("alice", "short").is_err());
        assert!(validate_login("alice", &"密".repeat(25)).is_err());
        assert!(validate_login("alice", &"密".repeat(12)).is_err());
        assert!(validate_login("alice", "english password").is_err());
    }

    #[test]
    fn shared_library_is_explicitly_opt_in_even_for_old_saved_preferences() {
        let old: Config = serde_json::from_str(r#"{"enabled":true,"shareGame":true}"#).unwrap();
        let value = serde_json::to_value(old).unwrap();
        assert_eq!(value["shareLibrary"], false);
    }

    #[test]
    fn hidden_game_picker_serializes_only_id_and_titles() {
        let value = serde_json::to_value(HideableGame {
            id: 1,
            title: "Title".into(),
            original_title: Some("原名".into()),
        })
        .unwrap();
        let mut fields = value
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        fields.sort();
        assert_eq!(fields, vec!["id", "originalTitle", "title"]);
    }

    #[test]
    fn share_history_is_opt_in_even_for_saved_and_old_configurations() {
        let config: Config = serde_json::from_str("{}").unwrap();
        assert!(!config.share_history);
        let old: Config =
            serde_json::from_str(r#"{"enabled":true,"shareGame":true,"shareLibrary":true}"#).unwrap();
        assert!(!old.share_history);
        let value = serde_json::to_value(Status {
            config: old,
            account: None,
            connected: false,
            last_error: None,
            generation: 0,
            library_synced_at: None,
            library_error: None,
            history_synced_at: Some("2026-11-11T00:00:00Z".into()),
            history_error: None,
            deletion_pending: false,
        })
        .unwrap();
        assert_eq!(value["historySyncedAt"], "2026-11-11T00:00:00Z");
        assert!(value.get("historyError").is_some() && value["historyError"].is_null());
    }

    #[test]
    fn search_box_only_accepts_friend_codes_or_user_names() {
        assert!(search_query("  ABCDEF0123456789 ").is_ok());
        assert!(search_query("ali").is_ok());
        assert!(search_query("Alice").is_ok());
        assert!(search_query("ab").is_err());
        assert!(search_query("a b").is_err());
        assert!(search_query("").is_err());
        assert!(search_query(&"名".repeat(33)).is_err());
        assert_eq!(search_query("  Alice ").unwrap(), "Alice");
    }

    #[test]
    fn friend_targets_are_restricted_to_uuid_shaped_values() {
        assert!(valid_uuid("c0ffee00-0000-4000-8000-000000000000"));
        for invalid in [
            "me",
            "c0ffee00-0000-4000-8000-00000000000",
            "c0ffee00_0000-4000-8000-000000000000",
            "zzzzzzzz-0000-4000-8000-000000000000",
            "",
        ] {
            assert!(!valid_uuid(invalid), "{invalid}");
        }
    }

    fn candidate(id: i64, session: i64) -> RunningCandidate {
        RunningCandidate {
            game_id: id,
            session_id: session,
            started_at: format!("2026-11-09T00:00:{session:02}Z"),
            duration: 42,
            title: format!("game {id}"),
            vndb_id: Some("v123".into()),
            bangumi_id: None,
        }
    }
}
