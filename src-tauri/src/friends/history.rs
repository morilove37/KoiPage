//! Recent play-history sync: local `play_sessions` -> `koipage_history_sync`.
//!
//! This worker is deliberately independent from [`super::runtime::rpc`]: a
//! rejected or expired history call must only surface in `historyError`, never
//! log the user out. The publisher that owns auth state handles real session
//! failures separately.
use super::{client::Api, library, model::*};
use crate::commands::error::{CmdError, CmdResult};
use serde_json::{Value, json};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

const WINDOW_SECONDS: i64 = 30 * 24 * 60 * 60;
const BATCH: usize = 100;
const TICK: Duration = Duration::from_secs(60);

#[derive(Default)]
pub(super) struct Cache {
    identity: String,
    generation: Option<u64>,
    enabled: Option<bool>,
    attempted_generation: Option<u64>,
    next_attempt: Option<Instant>,
}

#[derive(sqlx::FromRow)]
pub(super) struct LocalSession {
    id: i64,
    game_id: i64,
    started_at: String,
    ended_at: Option<String>,
    duration_seconds: i64,
    title: String,
    vndb_id: Option<String>,
    bangumi_id: Option<String>,
}

fn parse_epoch(value: &str) -> Option<i64> {
    time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339)
        .ok()
        .map(|at| at.unix_timestamp())
        .filter(|seconds| *seconds > 0)
}

fn iso(seconds: i64) -> String {
    time::OffsetDateTime::from_unix_timestamp(seconds)
        .ok()
        .and_then(|at| at.format(&time::format_description::well_known::Rfc3339).ok())
        .unwrap_or_default()
}

fn short(value: &str) -> String {
    value.trim().chars().take(200).collect()
}

/// Map one local session to the narrow payload accepted by `koipage_history_sync`.
pub(super) fn session_payload(row: &LocalSession) -> Option<Value> {
    let started = parse_epoch(&row.started_at)?;
    let ended = row
        .ended_at
        .as_deref()
        .and_then(parse_epoch)
        .filter(|ended| *ended > started);
    let title = short(&row.title);
    if title.is_empty() {
        return None;
    }
    let vndb_id = row
        .vndb_id
        .as_ref()
        .filter(|s| {
            s.starts_with('v')
                && (2..=13).contains(&s.len())
                && s[1..].bytes().all(|b| b.is_ascii_digit())
        })
        .cloned();
    let bangumi_id = row
        .bangumi_id
        .as_ref()
        .filter(|s| (1..=12).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit()))
        .cloned();
    Some(json!({
        "key": format!("{}:{}", row.game_id, row.id),
        "gameKey": library::library_key(row.game_id),
        "title": title,
        "vndbId": vndb_id,
        "bangumiId": bangumi_id,
        "startedAt": started,
        "endedAt": ended,
        "durationSeconds": row.duration_seconds.clamp(0, 3_155_760_000),
    }))
}

/// `syncedAt` comes back either as an ISO string from PostgREST or as epoch
/// seconds; the frontend type is a string, so normalise to RFC3339.
pub(super) fn synced_at(value: &Value) -> Option<String> {
    match &value["syncedAt"] {
        Value::String(text) if !text.trim().is_empty() => Some(text.clone()),
        Value::Number(number) => {
            let seconds = number.as_i64().filter(|seconds| *seconds > 0)?;
            Some(
                time::OffsetDateTime::from_unix_timestamp(seconds)
                    .ok()
                    .and_then(|at| at.format(&time::format_description::well_known::Rfc3339).ok())
                    .unwrap_or_else(|| number.to_string()),
            )
        }
        _ => None,
    }
}

async fn local_sessions(db: &sqlx::SqlitePool, cutoff: &str) -> CmdResult<Vec<LocalSession>> {
    Ok(sqlx::query_as::<_, LocalSession>(
        "SELECT ps.id,ps.game_id,ps.started_at,ps.ended_at,ps.duration_seconds,g.title,g.vndb_id,g.bangumi_id \
         FROM play_sessions ps JOIN games g ON g.id=ps.game_id \
         WHERE ps.started_at>=? ORDER BY ps.started_at DESC LIMIT 2000",
    )
    .bind(cutoff)
    .fetch_all(db)
    .await?)
}

/// Serialize refresh and one HTTP batch with identity changes. History errors
/// remain separate, but stale workers must never recreate credentials or share
/// data after logout, a privacy change or an unfinished account deletion.
async fn request(state:&super::runtime::FriendsState,generation:u64,body:Value) -> CmdResult<Value> {
    let mut inner=state.inner.lock().await;
    if inner.generation!=generation || inner.deletion_pending
        || state.stopping.load(std::sync::atomic::Ordering::SeqCst)
        || !inner.config.enabled || inner.account.is_none() {
        return Err(CmdError("FRIENDS_CANCELLED: 游玩记录同步状态已变化".into()));
    }
    let current=inner.tokens.clone().ok_or_else(||CmdError("FRIENDS_CANCELLED: 当前会话已结束".into()))?;
    let api=Api::new(&inner.config)?;
    if current.expires_at<=now()+60 {
        let next=api.refresh(&current.refresh_token).await?;
        super::credentials::save(&inner.config.server_url,&next)?;
        inner.tokens=Some(next);
    }
    let token=&inner.tokens.as_ref().unwrap().access_token;
    api.rpc("koipage_history_sync",token,body).await
}

pub(super) async fn sync(app: &AppHandle, force: bool) -> CmdResult<Status> {
    let state = app.state::<super::runtime::FriendsState>();
    let mut cache = state.history.lock().await;
    let (config, generation, identity) = {
        let inner = state.inner.lock().await;
        if inner.deletion_pending || state.stopping.load(std::sync::atomic::Ordering::SeqCst) {
            return Ok(inner.status());
        }
        let Some(account) = inner.account.as_ref().filter(|_| inner.config.enabled && inner.tokens.is_some()) else {
            return Ok(inner.status());
        };
        (
            inner.config.clone(),
            inner.generation,
            format!("{}:{}", inner.config.server_url, account.id),
        )
    };
    if cache.identity != identity {
        *cache = Cache {
            identity,
            ..Cache::default()
        };
    }
    if !force
        && cache.attempted_generation == Some(generation)
        && cache.next_attempt.is_some_and(|at| Instant::now() < at)
    {
        return Ok(state.inner.lock().await.status());
    }
    cache.attempted_generation = Some(generation);
    cache.next_attempt = Some(Instant::now() + TICK);

    let result = async {
        if !config.share_history {
            if cache.enabled == Some(false)
                && cache.generation == Some(generation)
                && !force
            {
                return Ok::<Option<Value>, CmdError>(None);
            }
            return Ok(Some(
                request(
                    &state,
                    generation,
                    json!({"p_enabled":false,"p_sessions":[]}),
                )
                .await?,
            ));
        }
        let db = crate::commands::games::pool(app).await?;
        let cutoff = iso(now() - WINDOW_SECONDS);
        let sessions = local_sessions(&db, &cutoff).await?;
        let payloads = sessions.iter().filter_map(session_payload).collect::<Vec<_>>();
        let mut last = None;
        if payloads.is_empty() {
            if cache.enabled != Some(true)
                || cache.generation != Some(generation)
                || force
            {
                last = Some(
                    request(
                        &state,
                        generation,
                        json!({"p_enabled":true,"p_sessions":[]}),
                    )
                    .await?,
                );
            }
        } else {
            for chunk in payloads.chunks(BATCH) {
                last = Some(
                    request(
                        &state,
                        generation,
                        json!({"p_enabled":true,"p_sessions":chunk}),
                    )
                    .await?,
                );
            }
        }
        Ok(last)
    }
    .await;

    let mut inner = state.inner.lock().await;
    if inner.generation != generation {
        return Ok(inner.status());
    }
    match result {
        Ok(value) => {
            cache.enabled = Some(config.share_history);
            cache.generation = Some(generation);
            if let Some(value) = value {
                inner.history_synced_at = synced_at(&value);
            }
            inner.history_error = None;
            let _ = app.emit("friends-status-changed", inner.status());
            Ok(inner.status())
        }
        Err(error) => {
            cache.next_attempt = Some(Instant::now() + Duration::from_secs(30));
            // History errors never touch login state.
            inner.history_error = Some(format!(
                "游玩记录尚未同步，恢复网络后会自动重试。{}",
                error.0
            ));
            let _ = app.emit("friends-status-changed", inner.status());
            Err(error)
        }
    }
}

pub(super) async fn publisher(app: AppHandle) {
    loop {
        tokio::time::sleep(TICK).await;
        let state = app.state::<super::runtime::FriendsState>();
        if state.stopping.load(std::sync::atomic::Ordering::SeqCst) {
            continue;
        }
        let _ = sync(&app, false).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn stale_or_suspended_history_work_never_touches_the_network_or_credentials() {
        let state=super::super::runtime::FriendsState::default();
        for (generation,pending,stopped) in [(2,false,false),(1,true,false),(1,false,true)] {
            {
                let mut inner=state.inner.lock().await;
                inner.config.enabled=true;
                inner.config.server_url="http://127.0.0.1:1".into();
                inner.account=Some(Account {id:"id".into(),username:"alice".into(),nickname:"Alice".into(),avatar:0,friend_code:"CODE".into()});
                inner.generation=generation;
                inner.deletion_pending=pending;
                inner.tokens=Some(Tokens {access_token:"old-access".into(),refresh_token:"old-refresh".into(),expires_at:0});
            }
            state.stopping.store(stopped,std::sync::atomic::Ordering::SeqCst);
            let error=request(&state,1,json!({"p_enabled":true,"p_sessions":[]})).await.unwrap_err();
            assert!(error.0.starts_with("FRIENDS_CANCELLED"));
            assert_eq!(state.inner.lock().await.tokens.as_ref().unwrap().access_token,"old-access");
        }
    }

    fn row() -> LocalSession {
        LocalSession {
            id: 9,
            game_id: 7,
            started_at: "2026-11-09T00:00:00Z".into(),
            ended_at: Some("2026-11-09T01:30:00Z".into()),
            duration_seconds: 5400,
            title: " 测试作品 ".into(),
            vndb_id: Some("v123".into()),
            bangumi_id: Some("456".into()),
        }
    }

    #[test]
    fn history_payload_uses_epoch_seconds_keys_and_library_keys() {
        let value = session_payload(&row()).unwrap();
        let mut keys = value
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        keys.sort();
        assert_eq!(
            keys,
            vec![
                "bangumiId",
                "durationSeconds",
                "endedAt",
                "gameKey",
                "key",
                "startedAt",
                "title",
                "vndbId"
            ]
        );
        assert_eq!(value["key"], "7:9");
        assert_eq!(value["gameKey"], library::library_key(7));
        assert_eq!(value["title"], "测试作品");
        assert_eq!(value["startedAt"], 1794182400);
        assert_eq!(value["endedAt"], 1794187800);
        assert_eq!(value["durationSeconds"], 5400);
    }

    #[test]
    fn history_payload_drops_end_before_start_and_invalid_identifiers() {
        let mut row = row();
        row.ended_at = Some("2026-11-08T23:00:00Z".into());
        row.duration_seconds = -20;
        row.vndb_id = Some("file:///secret".into());
        row.bangumi_id = Some("x".into());
        let value = session_payload(&row).unwrap();
        assert!(value["endedAt"].is_null());
        assert_eq!(value["durationSeconds"], 0);
        assert!(value["vndbId"].is_null() && value["bangumiId"].is_null());
        row.started_at = "not-a-time".into();
        assert!(session_payload(&row).is_none());
        row.started_at = "2026-11-09T00:00:00Z".into();
        row.title = "   ".into();
        assert!(session_payload(&row).is_none());
    }

    #[test]
    fn synced_timestamp_accepts_strings_and_epoch_numbers() {
        assert_eq!(
            synced_at(&json!({"syncedAt":"2026-11-11T00:00:00+00:00"})).as_deref(),
            Some("2026-11-11T00:00:00+00:00")
        );
        assert_eq!(
            synced_at(&json!({"syncedAt":1794182400})).as_deref(),
            Some("2026-11-09T00:00:00Z")
        );
        assert!(synced_at(&json!({})).is_none());
        assert!(synced_at(&json!({"syncedAt":"  "})).is_none());
    }

    #[tokio::test]
    async fn local_history_query_only_covers_the_last_thirty_days() {
        let db = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(
            "CREATE TABLE games(id INTEGER PRIMARY KEY,title TEXT,vndb_id TEXT,bangumi_id TEXT);\
             CREATE TABLE play_sessions(id INTEGER PRIMARY KEY,game_id INTEGER,started_at TEXT,ended_at TEXT,duration_seconds INTEGER);\
             INSERT INTO games VALUES(1,'old','v1',NULL);\
             INSERT INTO play_sessions VALUES(1,1,'2020-01-01T00:00:00Z',NULL,10),(2,1,'2026-11-09T00:00:00Z',NULL,20);",
        )
        .execute(&db)
        .await
        .unwrap();
        let cutoff = iso(now() - WINDOW_SECONDS);
        let sessions = local_sessions(&db, &cutoff).await.unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, 2);
        db.close().await;
    }
}
