//! Installation status is stored separately so archiving preserves the complete game record.
use super::{
    error::{CmdError, CmdResult},
    games::pool,
    settings::settings_get_impl,
};
use sqlx::SqlitePool;
use std::path::Path;
use tauri::{AppHandle, Manager};

pub async fn is_archived(db: &SqlitePool, game_id: i64) -> CmdResult<bool> {
    Ok(settings_get_impl(db, &format!("game_archived:{game_id}"))
        .await?
        .as_deref()
        == Some("true"))
}

#[cfg(test)]
mod tests {
    use super::*;
    async fn fixture() -> SqlitePool {
        let db = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::raw_sql("CREATE TABLE games(id INTEGER PRIMARY KEY,install_path TEXT,exe_path TEXT); CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT); INSERT INTO games VALUES(1,'Z:\\missing-archive-fixture','Z:\\missing-archive-fixture\\game.exe');").execute(&db).await.unwrap();
        db
    }
    #[tokio::test]
    async fn archive_retains_game_with_missing_files_and_restoration_rejects_missing_paths() {
        let db = fixture().await;
        assert!(!is_archived(&db, 1).await.unwrap());
        set_archived(&db, 1, true).await.unwrap();
        assert!(is_archived(&db, 1).await.unwrap());
        assert!(set_archived(&db, 1, false).await.is_err());
        assert!(is_archived(&db, 1).await.unwrap());
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM games WHERE id=1")
                .fetch_one(&db)
                .await
                .unwrap(),
            1
        );
        assert!(set_archived(&db, 2, true).await.is_err());
        db.close().await;
    }
    #[tokio::test]
    async fn restoration_checks_saved_folder_and_executable_then_clears_archive() {
        let db = fixture().await;
        let temp = std::env::temp_dir().join(format!(
            "koipage-installation-{}",
            time::OffsetDateTime::now_utc().unix_timestamp_nanos()
        ));
        std::fs::create_dir_all(&temp).unwrap();
        let exe = temp.join("game.exe");
        sqlx::query("UPDATE games SET install_path=?,exe_path=? WHERE id=1")
            .bind(temp.to_string_lossy().as_ref())
            .bind(exe.to_string_lossy().as_ref())
            .execute(&db)
            .await
            .unwrap();
        set_archived(&db, 1, true).await.unwrap();
        assert!(set_archived(&db, 1, false).await.is_err());
        std::fs::write(&exe, b"fixture").unwrap();
        set_archived(&db, 1, false).await.unwrap();
        assert!(!is_archived(&db, 1).await.unwrap());
        std::fs::remove_file(exe).unwrap();
        std::fs::remove_dir(temp).unwrap();
        db.close().await;
    }
}

async fn set_archived(db: &SqlitePool, game_id: i64, archived: bool) -> CmdResult<()> {
    let mut tx = db.begin().await?;
    // Serialize against path edits before reading the paths used for restoration.
    sqlx::query("UPDATE games SET id=id WHERE 0")
        .execute(&mut *tx)
        .await?;
    let row: Option<(String, Option<String>)> =
        sqlx::query_as("SELECT install_path,exe_path FROM games WHERE id=?")
            .bind(game_id)
            .fetch_optional(&mut *tx)
            .await?;
    let Some((folder, exe)) = row else {
        return Err(CmdError("游戏记录不存在".into()));
    };
    if !archived {
        if !Path::new(&folder).is_dir() {
            return Err(CmdError(
                "安装目录不存在，请先重新安装游戏，并在启动设置中保存正确的路径".into(),
            ));
        }
        if exe
            .as_deref()
            .is_none_or(|value| !Path::new(value).is_file())
        {
            return Err(CmdError(
                "启动程序不存在，请先在启动设置中选择并保存正确的启动文件".into(),
            ));
        }
    }
    let key = format!("game_archived:{game_id}");
    if archived {
        sqlx::query("INSERT INTO settings(key,value) VALUES(?,'true') ON CONFLICT(key) DO UPDATE SET value='true'")
            .bind(key).execute(&mut *tx).await?;
    } else {
        sqlx::query("DELETE FROM settings WHERE key=?")
            .bind(key)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

#[tauri::command]
pub async fn game_archive_set(app: AppHandle, game_id: i64, archived: bool) -> CmdResult<()> {
    let running = app.state::<crate::launcher::RunningGames>();
    let _guard = running.1.lock().await;
    if running
        .0
        .lock()
        .map_err(|_| CmdError("进程表不可用".into()))?
        .contains_key(&game_id)
    {
        return Err(CmdError("请先退出该游戏再更改安装状态".into()));
    }
    set_archived(&pool(&app).await?, game_id, archived).await
}
