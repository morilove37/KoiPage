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
    let pool = pool(&app).await?;

    let existing = sqlx::query_as::<_, PlaySession>(
        "SELECT id, game_id, started_at, ended_at, duration_seconds FROM play_sessions WHERE id = ?",
    )
    .bind(session_id)
    .fetch_optional(&pool)
    .await?;
    let existing = existing.ok_or_else(|| not_found("play session", session_id))?;

    if existing.ended_at.is_some() {
        return Ok(existing);
    }

    let ended_at = now_iso8601();
    // Prefer the client-reported duration (it knows about pauses); otherwise
    // derive it from the wall-clock span.
    let duration = match duration_seconds {
        Some(d) if d >= 0 => d,
        Some(d) => return Err(CmdError(format!("durationSeconds must be >= 0, got {d}"))),
        None => elapsed_seconds(&existing.started_at, &ended_at).unwrap_or(0),
    };

    let mut tx = pool.begin().await?;

    sqlx::query("UPDATE play_sessions SET ended_at = ?, duration_seconds = ? WHERE id = ?")
        .bind(&ended_at)
        .bind(duration)
        .bind(session_id)
        .execute(&mut *tx)
        .await?;

    sqlx::query(
        "UPDATE games SET play_time_seconds = play_time_seconds + ?, last_played_at = ?, \
         updated_at = ? WHERE id = ?",
    )
    .bind(duration)
    .bind(&ended_at)
    .bind(&ended_at)
    .bind(existing.game_id)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok(PlaySession {
        id: existing.id,
        game_id: existing.game_id,
        started_at: existing.started_at,
        ended_at: Some(ended_at),
        duration_seconds: duration,
    })
}

/// `play_sessions_list` — recent sessions, optionally for one game.
#[tauri::command]
pub async fn play_sessions_list(
    app: AppHandle,
    game_id: Option<i64>,
    limit: Option<i64>,
) -> CmdResult<Vec<PlaySession>> {
    let pool = pool(&app).await?;
    let limit = limit.unwrap_or(100).clamp(1, 1000);

    let sessions = match game_id {
        Some(game_id) => {
            sqlx::query_as::<_, PlaySession>(
                "SELECT id, game_id, started_at, ended_at, duration_seconds FROM play_sessions \
                 WHERE game_id = ? ORDER BY started_at DESC, id DESC LIMIT ?",
            )
            .bind(game_id)
            .bind(limit)
            .fetch_all(&pool)
            .await?
        }
        None => {
            sqlx::query_as::<_, PlaySession>(
                "SELECT id, game_id, started_at, ended_at, duration_seconds FROM play_sessions \
                 ORDER BY started_at DESC, id DESC LIMIT ?",
            )
            .bind(limit)
            .fetch_all(&pool)
            .await?
        }
    };

    Ok(sessions)
}

/// Whole seconds between two ISO8601 timestamps, if both parse.
fn elapsed_seconds(start: &str, end: &str) -> Option<i64> {
    use time::format_description::well_known::Rfc3339;
    let start = time::OffsetDateTime::parse(start, &Rfc3339).ok()?;
    let end = time::OffsetDateTime::parse(end, &Rfc3339).ok()?;
    Some((end - start).whole_seconds().max(0))
}
