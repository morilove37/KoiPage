//! Confirmed-duration checkpoints; unfinished time is never inferred at startup.
use super::RunningGames;
use crate::commands::{
    error::{CmdError, CmdResult},
    games::pool,
    model::PlaySession,
    util::{not_found, now_iso8601},
};
use sqlx::{Pool, Sqlite, Transaction};
use tauri::{AppHandle, Emitter, Manager};

fn endpoint(start: &str, duration: i64) -> CmdResult<String> {
    let parsed = time::OffsetDateTime::parse(start, &time::format_description::well_known::Rfc3339)
        .map_err(|_| CmdError("会话开始时间无效，请手动修正".into()))?;
    parsed
        .checked_add(time::Duration::seconds(duration))
        .ok_or_else(|| CmdError("时长超出范围".into()))?
        .format(&time::format_description::well_known::Rfc3339)
        .map_err(|e| CmdError(e.to_string()))
}

async fn refresh(tx: &mut Transaction<'_, Sqlite>, game: i64, delta: i64) -> CmdResult<()> {
    sqlx::query("UPDATE games SET play_time_seconds=MAX(0,play_time_seconds+?), last_played_at=(SELECT COALESCE(ended_at,started_at) FROM play_sessions WHERE game_id=? ORDER BY julianday(COALESCE(ended_at,started_at)) DESC,id DESC LIMIT 1),updated_at=? WHERE id=?")
        .bind(delta).bind(game).bind(now_iso8601()).bind(game).execute(&mut **tx).await?;
    Ok(())
}

pub async fn settle(db: &Pool<Sqlite>, id: i64, duration: Option<i64>) -> CmdResult<i64> {
    let mut tx = db.begin().await?;
    // Acquire SQLite's writer lock before reading; concurrent callers cannot both credit.
    sqlx::query("UPDATE play_sessions SET duration_seconds=duration_seconds WHERE id=?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    let row: PlaySession = sqlx::query_as(
        "SELECT id,game_id,started_at,ended_at,duration_seconds FROM play_sessions WHERE id=?",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| not_found("session", id))?;
    if row.ended_at.is_some() {
        return Ok(row.duration_seconds);
    }
    let seconds = duration
        .unwrap_or(row.duration_seconds)
        .max(row.duration_seconds)
        .max(0);
    let end = endpoint(&row.started_at, seconds)?;
    sqlx::query("UPDATE play_sessions SET ended_at=?,duration_seconds=? WHERE id=?")
        .bind(end)
        .bind(seconds)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    refresh(&mut tx, row.game_id, seconds).await?;
    tx.commit().await?;
    Ok(seconds)
}

pub async fn checkpoint(db: &Pool<Sqlite>, id: i64, seconds: i64) -> CmdResult<()> {
    sqlx::query("UPDATE play_sessions SET duration_seconds=MAX(duration_seconds,?) WHERE id=? AND ended_at IS NULL")
        .bind(seconds.max(0)).bind(id).execute(db).await?;
    Ok(())
}

fn ensure_inactive(app: &AppHandle, id: i64) -> CmdResult<()> {
    if app
        .state::<RunningGames>()
        .0
        .lock()
        .map_err(|_| CmdError("进程表已损坏".into()))?
        .values()
        .any(|g| g.session_id == id)
    {
        return Err(CmdError("此记录对应的游戏仍在运行，请先结束游戏".into()));
    }
    Ok(())
}

#[tauri::command]
pub async fn recover_play_sessions(app: AppHandle) -> CmdResult<u64> {
    let state = app.state::<RunningGames>();
    let _guard = state.1.lock().await;
    let db = pool(&app).await?;
    let ids: Vec<i64> = sqlx::query_scalar("SELECT id FROM play_sessions WHERE ended_at IS NULL")
        .fetch_all(&db)
        .await?;
    let mut count = 0;
    for id in ids {
        if ensure_inactive(&app, id).is_ok() {
            match settle(&db, id, None).await {
                Ok(_) => count += 1,
                Err(error) => crate::app_warn!("[sessions] recovery session_id={id}: {error}"),
            }
        }
    }
    Ok(count)
}

#[tauri::command]
pub async fn settle_orphan_session(app: AppHandle, session_id: i64) -> CmdResult<()> {
    let state = app.state::<RunningGames>();
    let _guard = state.1.lock().await;
    ensure_inactive(&app, session_id)?;
    settle(&pool(&app).await?, session_id, None).await?;
    let _ = app.emit("play-history-changed", ());
    Ok(())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInput {
    pub id: Option<i64>,
    pub game_id: i64,
    pub started_at: String,
    pub duration_seconds: i64,
}

pub async fn save(db: &Pool<Sqlite>, input: SessionInput) -> CmdResult<i64> {
    if input.duration_seconds < 0 || input.duration_seconds > 315_576_000 {
        return Err(CmdError("时长应介于 0 秒和 10 年之间".into()));
    }
    let end = endpoint(&input.started_at, input.duration_seconds)?;
    let end_time =
        time::OffsetDateTime::parse(&end, &time::format_description::well_known::Rfc3339)
            .map_err(|_| CmdError("时间无效".into()))?;
    if end_time > time::OffsetDateTime::now_utc() {
        return Err(CmdError("游玩记录的开始和结束时间不能晚于现在".into()));
    }
    let mut tx = db.begin().await?;
    let matched = sqlx::query("UPDATE games SET updated_at=updated_at WHERE id=?")
        .bind(input.game_id)
        .execute(&mut *tx)
        .await?;
    if matched.rows_affected() == 0 {
        return Err(not_found("game", input.game_id));
    }
    let (id, old) = if let Some(id) = input.id {
        let old: (i64, Option<String>, i64) = sqlx::query_as(
            "SELECT game_id,ended_at,duration_seconds FROM play_sessions WHERE id=?",
        )
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| not_found("session", id))?;
        if old.0 != input.game_id {
            return Err(CmdError("记录不属于此游戏".into()));
        }
        sqlx::query(
            "UPDATE play_sessions SET started_at=?,ended_at=?,duration_seconds=? WHERE id=?",
        )
        .bind(&input.started_at)
        .bind(&end)
        .bind(input.duration_seconds)
        .bind(id)
        .execute(&mut *tx)
        .await?;
        (id, if old.1.is_some() { old.2 } else { 0 })
    } else {
        let id=sqlx::query_scalar("INSERT INTO play_sessions(game_id,started_at,ended_at,duration_seconds) VALUES(?,?,?,?) RETURNING id").bind(input.game_id).bind(&input.started_at).bind(&end).bind(input.duration_seconds).fetch_one(&mut *tx).await?;
        (id, 0)
    };
    refresh(&mut tx, input.game_id, input.duration_seconds - old).await?;
    tx.commit().await?;
    Ok(id)
}

#[tauri::command]
pub async fn play_session_save(app: AppHandle, input: SessionInput) -> CmdResult<i64> {
    let state = app.state::<RunningGames>();
    let _guard = state.1.lock().await;
    if let Some(id) = input.id {
        ensure_inactive(&app, id)?;
    }
    let id = save(&pool(&app).await?, input).await?;
    let _ = app.emit("play-history-changed", ());
    Ok(id)
}

pub async fn delete(db: &Pool<Sqlite>, id: i64) -> CmdResult<()> {
    let mut tx = db.begin().await?;
    let row: Option<(i64, Option<String>, i64)> = sqlx::query_as(
        "DELETE FROM play_sessions WHERE id=? RETURNING game_id,ended_at,duration_seconds",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some((game, end, seconds)) = row {
        refresh(&mut tx, game, if end.is_some() { -seconds } else { 0 }).await?;
    }
    tx.commit().await?;
    Ok(())
}

#[tauri::command]
pub async fn play_session_delete(app: AppHandle, session_id: i64) -> CmdResult<()> {
    let state = app.state::<RunningGames>();
    let _guard = state.1.lock().await;
    ensure_inactive(&app, session_id)?;
    delete(&pool(&app).await?, session_id).await?;
    let _ = app.emit("play-history-changed", ());
    Ok(())
}

/// Stop accounting now, leave external games running. Call only after explicit exit choice.
#[tauri::command]
pub async fn prepare_manager_exit(app: AppHandle) -> CmdResult<u64> {
    let state = app.state::<RunningGames>();
    let _guard = state.1.lock().await;
    let entries: Vec<(i64, i64)> = state
        .0
        .lock()
        .map_err(|_| CmdError("进程表已损坏".into()))?
        .values()
        .map(|g| (g.session_id, g.clock.elapsed().as_secs() as i64))
        .collect();
    let db = pool(&app).await?;
    for (id, seconds) in &entries {
        settle(&db, *id, Some(*seconds)).await?;
    }
    Ok(entries.len() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    async fn fixture() -> Pool<Sqlite> {
        let db = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::raw_sql("CREATE TABLE games(id INTEGER PRIMARY KEY, play_time_seconds INTEGER, last_played_at TEXT, updated_at TEXT); CREATE TABLE play_sessions(id INTEGER PRIMARY KEY, game_id INTEGER, started_at TEXT, ended_at TEXT, duration_seconds INTEGER); INSERT INTO games VALUES(1,1000,NULL,''); INSERT INTO play_sessions VALUES(1,1,'2020-01-01T00:00:00Z',NULL,60);").execute(&db).await.unwrap();
        db
    }
    #[tokio::test]
    async fn recovery_credits_only_checkpoint_and_is_idempotent() {
        let db = fixture().await;
        assert_eq!(settle(&db, 1, None).await.unwrap(), 60);
        settle(&db, 1, None).await.unwrap();
        let row: (i64, String) = sqlx::query_as("SELECT g.play_time_seconds,s.ended_at FROM games g JOIN play_sessions s ON s.game_id=g.id").fetch_one(&db).await.unwrap();
        assert_eq!(row, (1060, "2020-01-01T00:01:00Z".into()));
    }
    #[tokio::test]
    async fn edits_and_deletes_preserve_imported_total_and_recompute_recency() {
        let db = fixture().await;
        settle(&db, 1, None).await.unwrap();
        save(
            &db,
            SessionInput {
                id: Some(1),
                game_id: 1,
                started_at: "2020-01-02T00:00:00Z".into(),
                duration_seconds: 120,
            },
        )
        .await
        .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT play_time_seconds FROM games")
                .fetch_one(&db)
                .await
                .unwrap(),
            1120
        );
        let id = save(
            &db,
            SessionInput {
                id: None,
                game_id: 1,
                started_at: "2020-01-03T00:00:00Z".into(),
                duration_seconds: 30,
            },
        )
        .await
        .unwrap();
        delete(&db, id).await.unwrap();
        delete(&db, id).await.unwrap();
        let row: (i64, String) =
            sqlx::query_as("SELECT play_time_seconds,last_played_at FROM games")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(row, (1120, "2020-01-02T00:02:00Z".into()));
        delete(&db, 1).await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT play_time_seconds FROM games")
                .fetch_one(&db)
                .await
                .unwrap(),
            1000
        );
    }
    #[tokio::test]
    async fn checkpoint_is_monotonic_and_does_not_credit_until_settled() {
        let db = fixture().await;
        checkpoint(&db, 1, 90).await.unwrap();
        checkpoint(&db, 1, 30).await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT play_time_seconds FROM games")
                .fetch_one(&db)
                .await
                .unwrap(),
            1000
        );
        assert_eq!(settle(&db, 1, None).await.unwrap(), 90);
        checkpoint(&db, 1, 900).await.unwrap();
        assert_eq!(settle(&db, 1, None).await.unwrap(), 90);
    }
    #[tokio::test]
    async fn invalid_edit_rolls_back_without_touching_history() {
        let db = fixture().await;
        for (game, seconds) in [(1, -1), (2, 100)] {
            assert!(
                save(
                    &db,
                    SessionInput {
                        id: Some(1),
                        game_id: game,
                        started_at: "2020-01-01T00:00:00Z".into(),
                        duration_seconds: seconds
                    }
                )
                .await
                .is_err()
            );
        }
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT duration_seconds FROM play_sessions")
                .fetch_one(&db)
                .await
                .unwrap(),
            60
        );
    }

    #[tokio::test]
    async fn concurrent_settlement_on_temporary_database_credits_once() {
        let path = std::env::temp_dir().join(format!(
            "koipage-session-test-{}-{}.sqlite",
            std::process::id(),
            time::OffsetDateTime::now_utc().unix_timestamp_nanos()
        ));
        let db = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(
                sqlx::sqlite::SqliteConnectOptions::new()
                    .filename(&path)
                    .create_if_missing(true)
                    .busy_timeout(std::time::Duration::from_secs(5)),
            )
            .await
            .unwrap();
        sqlx::raw_sql("CREATE TABLE games(id INTEGER PRIMARY KEY,play_time_seconds INTEGER,last_played_at TEXT,updated_at TEXT); CREATE TABLE play_sessions(id INTEGER PRIMARY KEY,game_id INTEGER,started_at TEXT,ended_at TEXT,duration_seconds INTEGER); INSERT INTO games VALUES(1,1000,NULL,''); INSERT INTO play_sessions VALUES(1,1,'2020-01-01T00:00:00Z',NULL,60);").execute(&db).await.unwrap();
        let (first, second) = tokio::join!(settle(&db, 1, None), settle(&db, 1, None));
        assert_eq!(first.unwrap(), 60);
        assert_eq!(second.unwrap(), 60);
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT play_time_seconds FROM games")
                .fetch_one(&db)
                .await
                .unwrap(),
            1060
        );
        db.close().await;
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn future_record_and_corrupt_recovery_leave_totals_untouched() {
        let db = fixture().await;
        assert!(
            save(
                &db,
                SessionInput {
                    id: None,
                    game_id: 1,
                    started_at: "2099-01-01T00:00:00Z".into(),
                    duration_seconds: 60
                }
            )
            .await
            .is_err()
        );
        sqlx::query("UPDATE play_sessions SET started_at='broken'")
            .execute(&db)
            .await
            .unwrap();
        assert!(settle(&db, 1, None).await.is_err());
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT play_time_seconds FROM games")
                .fetch_one(&db)
                .await
                .unwrap(),
            1000
        );
    }
}
