//! `play_session_*` commands.
//!
//! `started_at` / `ended_at` are ISO8601 UTC strings so the frontend can parse
//! them with `new Date(...)` directly.

use tauri::AppHandle;

use super::error::{CmdError, CmdResult};
use super::games::pool;
use super::model::PlaySession;
use super::util::*;

/// `play_session_start` — open a session and mark the game as playing.
#[tauri::command]
pub async fn play_session_start(app: AppHandle, game_id: i64) -> CmdResult<PlaySession> {
    let pool = pool(&app).await?;

    let exists: Option<(i64,)> = sqlx::query_as("SELECT id FROM games WHERE id = ?")
        .bind(game_id)
        .fetch_optional(&pool)
        .await?;
    if exists.is_none() {
        return Err(not_found("game", game_id));
    }

    let started_at = now_iso8601();
    let mut tx = pool.begin().await?;

    let id: i64 = sqlx::query_scalar(
        "INSERT INTO play_sessions (game_id, started_at, ended_at, duration_seconds) \
         VALUES (?, ?, NULL, 0) RETURNING id",
    )
    .bind(game_id)
    .bind(&started_at)
    .fetch_one(&mut *tx)
    .await?;

    // Starting a session refreshes the recency marker and promotes a
    // not-yet-started game to 'playing'. Only the pre-play states are touched,
    // so an explicit 'completed' / 'on_hold' / 'dropped' is never clobbered.
    sqlx::query(
        "UPDATE games SET last_played_at = ?, \
         status = CASE WHEN status IN ('unplayed', 'wishlist') THEN 'playing' ELSE status END, \
         updated_at = ? WHERE id = ?",
    )
    .bind(&started_at)
    .bind(&started_at)
    .bind(game_id)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok(PlaySession {
        id,
        game_id,
        started_at,
        ended_at: None,
        duration_seconds: 0,
    })
}

/// `play_session_end` — close a session and fold its duration into the game total.
///
/// Idempotent per session: ending an already-ended session returns the stored
/// row without double-counting `play_time_seconds`.
#[tauri::command]
pub async fn play_session_end(
    app: AppHandle,
    session_id: i64,
    duration_seconds: Option<i64>,
) -> CmdResult<PlaySession> {
    use tauri::Manager;
    let state = app.state::<crate::launcher::RunningGames>();
    let _guard = state.1.lock().await;
    if state.0.lock().map_err(|_| CmdError("进程表已损坏".into()))?.values().any(|entry| entry.session_id == session_id) {
        return Err(CmdError("请通过结束游戏来结算运行中的记录".into()));
    }
    if duration_seconds.is_some_and(|seconds| seconds < 0) {
        return Err(CmdError("时长不能为负数".into()));
    }
    let db = pool(&app).await?;
    crate::launcher::sessions::settle(&db, session_id, duration_seconds).await?;
    Ok(sqlx::query_as("SELECT id,game_id,started_at,ended_at,duration_seconds FROM play_sessions WHERE id=?")
        .bind(session_id).fetch_one(&db).await?)
}

/// Recent sessions, or every completed session overlapping a bounded period.
#[tauri::command]
pub async fn play_sessions_list(
    app: AppHandle,
    game_id: Option<i64>,
    limit: Option<i64>,
    started_before: Option<String>,
    ended_after: Option<String>,
    before_started_at: Option<String>,
    before_id: Option<i64>,
) -> CmdResult<Vec<PlaySession>> {
    let pool = pool(&app).await?;
    if started_before.is_some() || ended_after.is_some() {
        if before_started_at.is_some() || before_id.is_some() {
            return Err(CmdError("统计范围不能与历史记录翻页同时使用".into()));
        }
        let (Some(end), Some(start)) = (started_before, ended_after) else {
            return Err(CmdError("统计范围必须同时提供开始和结束时间".into()));
        };
        return sessions_in_period(&pool, game_id, &start, &end).await;
    }
    recent_sessions(&pool, game_id, limit.unwrap_or(100), before_started_at.as_deref(), before_id).await
}

async fn recent_sessions(
    pool: &sqlx::SqlitePool,
    game_id: Option<i64>,
    limit: i64,
    before_started_at: Option<&str>,
    before_id: Option<i64>,
) -> CmdResult<Vec<PlaySession>> {
    if before_started_at.is_some() != before_id.is_some() {
        return Err(CmdError("历史记录翻页必须同时提供时间和记录编号".into()));
    }
    if let Some(started_at) = before_started_at {
        use time::format_description::well_known::Rfc3339;
        if before_id.unwrap_or(0) <= 0 || time::OffsetDateTime::parse(started_at, &Rfc3339).is_err() {
            return Err(CmdError("历史记录翻页位置无效".into()));
        }
    }
    // A timestamp + id cursor avoids skipped/duplicated rows when a new play
    // finishes between page reads, including sessions sharing the same time.
    Ok(sqlx::query_as::<_, PlaySession>(
        "SELECT id, game_id, started_at, ended_at, duration_seconds FROM play_sessions \
         WHERE (? IS NULL OR game_id = ?) \
         AND (? IS NULL OR started_at < ? OR (started_at = ? AND id < ?)) \
         ORDER BY started_at DESC, id DESC LIMIT ?",
    )
    .bind(game_id).bind(game_id)
    .bind(before_started_at).bind(before_started_at).bind(before_started_at).bind(before_id)
    .bind(limit.clamp(1, 1000)).fetch_all(pool).await?)
}

async fn sessions_in_period(
    pool: &sqlx::SqlitePool,
    game_id: Option<i64>,
    start: &str,
    end: &str,
) -> CmdResult<Vec<PlaySession>> {
    use time::format_description::well_known::Rfc3339;
    let parse = |value: &str| time::OffsetDateTime::parse(value, &Rfc3339)
        .map_err(|_| CmdError("统计范围的时间格式无效".into()));
    let span = parse(end)? - parse(start)?;
    if span <= time::Duration::ZERO || span > time::Duration::days(40) {
        return Err(CmdError("统计范围必须大于 0 且不超过 40 天".into()));
    }
    // Do not apply the recent-list limit: a busy month can exceed 1,000 sessions.
    // julianday handles both Z timestamps and equivalent explicit UTC offsets.
    Ok(sqlx::query_as::<_, PlaySession>(
        "SELECT id, game_id, started_at, ended_at, duration_seconds FROM play_sessions \
         WHERE ended_at IS NOT NULL AND duration_seconds > 0 \
         AND julianday(ended_at) > julianday(started_at) \
         AND julianday(started_at) < julianday(?) AND julianday(ended_at) > julianday(?) \
         AND (? IS NULL OR game_id = ?) ORDER BY started_at DESC, id DESC",
    )
    .bind(end).bind(start).bind(game_id).bind(game_id)
    .fetch_all(pool).await?)
}


#[cfg(test)]
mod period_tests {
    use super::*;

    async fn database() -> sqlx::SqlitePool {
        let pool = sqlx::sqlite::SqlitePoolOptions::new().max_connections(1)
            .connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE play_sessions (id INTEGER PRIMARY KEY, game_id INTEGER, started_at TEXT, ended_at TEXT, duration_seconds INTEGER)")
            .execute(&pool).await.unwrap();
        pool
    }

    #[tokio::test]
    async fn period_reads_overlap_and_offsets_without_recent_list_truncation() {
        let pool = database().await;
        let mut transaction = pool.begin().await.unwrap();
        for id in 1..=1005_i64 {
            sqlx::query("INSERT INTO play_sessions VALUES (?, 1, '2026-10-16T23:30:00+08:00', '2026-10-17T00:30:00+08:00', 3600)")
                .bind(id).execute(&mut *transaction).await.unwrap();
        }
        sqlx::query("INSERT INTO play_sessions VALUES (1006, 2, '2026-10-16T16:00:00Z', '2026-10-16T17:00:00Z', 3600), (1007, 1, '2026-10-16T14:00:00Z', '2026-10-16T16:00:00Z', 7200), (1008, 1, '2026-10-17T16:00:00Z', '2026-10-17T17:00:00Z', 3600), (1009, 1, '2026-10-16T17:00:00Z', NULL, 0), (1010, 1, 'broken', 'broken', 60)")
            .execute(&mut *transaction).await.unwrap();
        transaction.commit().await.unwrap();
        let all = sessions_in_period(&pool, None, "2026-10-16T16:00:00Z", "2026-10-17T16:00:00Z").await.unwrap();
        assert_eq!(all.len(), 1006);
        let one_game = sessions_in_period(&pool, Some(1), "2026-10-16T16:00:00Z", "2026-10-17T16:00:00Z").await.unwrap();
        assert_eq!(one_game.len(), 1005);
    }

    #[tokio::test]
    async fn period_rejects_invalid_reversed_or_unbounded_ranges() {
        let pool = database().await;
        for (start, end) in [
            ("broken", "2026-10-17T00:00:00Z"),
            ("2026-10-17T00:00:00Z", "2026-10-17T00:00:00Z"),
            ("2026-10-18T00:00:00Z", "2026-10-17T00:00:00Z"),
            ("2026-01-01T00:00:00Z", "2026-10-17T00:00:00Z"),
        ] {
            assert!(sessions_in_period(&pool, None, start, end).await.is_err());
        }
    }

    #[tokio::test]
    async fn history_cursor_reaches_every_record_beyond_1000_with_stable_ties() {
        let pool = database().await;
        let mut transaction = pool.begin().await.unwrap();
        for id in 1..=1107_i64 {
            sqlx::query("INSERT INTO play_sessions VALUES (?, 1, '2026-10-17T01:00:00Z', '2026-10-17T02:00:00Z', 3600)")
                .bind(id).execute(&mut *transaction).await.unwrap();
        }
        transaction.commit().await.unwrap();
        let mut all_ids = Vec::new();
        let mut cursor: Option<(String, i64)> = None;
        loop {
            let page = recent_sessions(&pool, None, 51, cursor.as_ref().map(|value| value.0.as_str()), cursor.as_ref().map(|value| value.1)).await.unwrap();
            let has_more = page.len() > 50;
            let rows = page.into_iter().take(50).collect::<Vec<_>>();
            all_ids.extend(rows.iter().map(|row| row.id));
            if cursor.is_none() {
                sqlx::query("INSERT INTO play_sessions VALUES (1108, 2, '2026-10-18T01:00:00Z', NULL, 0)")
                    .execute(&pool).await.unwrap();
            }
            if !has_more { break; }
            let last = rows.last().unwrap();
            cursor = Some((last.started_at.clone(), last.id));
        }
        assert_eq!(all_ids, (1..=1107).rev().collect::<Vec<_>>());
        let recent = recent_sessions(&pool, None, 6, None, None).await.unwrap();
        assert_eq!(recent[0].id, 1108);
        assert!(recent[0].ended_at.is_none());
        let one_game = recent_sessions(&pool, Some(2), 50, None, None).await.unwrap();
        assert_eq!(one_game.len(), 1);
    }

    #[tokio::test]
    async fn history_cursor_requires_a_valid_pair() {
        let pool = database().await;
        assert!(recent_sessions(&pool, None, 50, Some("2026-10-17T01:00:00Z"), None).await.is_err());
        assert!(recent_sessions(&pool, None, 50, None, Some(1)).await.is_err());
        assert!(recent_sessions(&pool, None, 50, Some("broken"), Some(1)).await.is_err());
        assert!(recent_sessions(&pool, None, 50, Some("2026-10-17T01:00:00Z"), Some(0)).await.is_err());
    }
}
