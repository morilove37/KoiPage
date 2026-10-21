use super::error::{CmdError, CmdResult};
use serde::Deserialize;
use sqlx::{Pool, Sqlite};
use tauri::AppHandle;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LibraryBatchPatch {
    pub status: Option<String>,
    pub favorite: Option<bool>,
    #[serde(default)]
    pub add_tag_ids: Vec<i64>,
    #[serde(default)]
    pub remove_tag_ids: Vec<i64>,
}

#[tauri::command]
pub async fn games_batch_update(
    app: AppHandle,
    ids: Vec<i64>,
    patch: LibraryBatchPatch,
) -> CmdResult<usize> {
    apply_batch(&super::games::pool(&app).await?, ids, patch).await
}

fn validated_ids(ids: Vec<i64>) -> CmdResult<std::collections::BTreeSet<i64>> {
    if ids.len() > 10000 || ids.iter().any(|id| *id <= 0) {
        return Err(CmdError("ID 必须为正整数，每批最多 10000 项".into()));
    }
    Ok(ids.into_iter().collect())
}

async fn apply_batch(
    pool: &Pool<Sqlite>,
    ids: Vec<i64>,
    patch: LibraryBatchPatch,
) -> CmdResult<usize> {
    let ids = validated_ids(ids)?;
    if ids.is_empty() {
        return Err(CmdError("请选择游戏".into()));
    }
    let status = patch
        .status
        .as_deref()
        .map(super::util::validate_status)
        .transpose()?;
    let add = validated_ids(patch.add_tag_ids)?;
    let remove = validated_ids(patch.remove_tag_ids)?;
    if add.intersection(&remove).next().is_some() {
        return Err(CmdError("同一标签不能同时添加和移除".into()));
    }
    if status.is_none() && patch.favorite.is_none() && add.is_empty() && remove.is_empty() {
        return Err(CmdError("请选择修改内容".into()));
    }
    // Validate all references in the transaction; never apply a stale selection
    // to a subset. Any SQL failure rolls back every preceding change.
    let mut tx = pool.begin().await?;
    for id in &ids {
        if sqlx::query_scalar::<_, i64>("SELECT id FROM games WHERE id = ?")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?
            .is_none()
        {
            return Err(CmdError(format!("游戏 {id} 已不存在，请刷新后重试")));
        }
    }
    for id in add.union(&remove) {
        if sqlx::query_scalar::<_, i64>("SELECT id FROM tags WHERE id = ?")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?
            .is_none()
        {
            return Err(CmdError(format!("标签 {id} 已不存在，请刷新后重试")));
        }
    }
    let now = super::util::now_iso8601();
    for id in &ids {
        sqlx::query("UPDATE games SET status = COALESCE(?, status), favorite = COALESCE(?, favorite), updated_at = ? WHERE id = ?")
            .bind(status.as_deref()).bind(patch.favorite.map(i64::from)).bind(&now).bind(id)
            .execute(&mut *tx).await?;
        for tag_id in &add {
            sqlx::query("INSERT OR IGNORE INTO game_tags(game_id, tag_id) VALUES(?, ?)")
                .bind(id)
                .bind(tag_id)
                .execute(&mut *tx)
                .await?;
        }
        for tag_id in &remove {
            sqlx::query("DELETE FROM game_tags WHERE game_id = ? AND tag_id = ?")
                .bind(id)
                .bind(tag_id)
                .execute(&mut *tx)
                .await?;
        }
    }
    tx.commit().await?;
    Ok(ids.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    async fn database() -> Pool<Sqlite> {
        // A private in-memory SQLite pool cannot touch the user's database.
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::raw_sql(include_str!("../../migrations/0001_init.sql"))
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO games(id,title,install_path,created_at,updated_at) VALUES(1,'one','one','old','old'),(2,'two','two','old','old')").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO tags(id,name) VALUES(1,'tag'),(2,'other')")
            .execute(&pool)
            .await
            .unwrap();
        pool
    }
    #[tokio::test]
    async fn updates_status_favorite_and_tags_atomically() {
        let pool = database().await;
        let count = apply_batch(
            &pool,
            vec![1, 2, 1],
            LibraryBatchPatch {
                status: Some("completed".into()),
                favorite: Some(true),
                add_tag_ids: vec![1, 1],
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(count, 2);
        let rows: Vec<(String, i64)> =
            sqlx::query_as("SELECT status,favorite FROM games ORDER BY id")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(rows, vec![("completed".into(), 1), ("completed".into(), 1)]);
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM game_tags")
                .fetch_one(&pool)
                .await
                .unwrap(),
            2
        );
        apply_batch(
            &pool,
            vec![1],
            LibraryBatchPatch {
                remove_tag_ids: vec![1],
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM game_tags WHERE game_id=1")
                .fetch_one(&pool)
                .await
                .unwrap(),
            0
        );
    }
    #[tokio::test]
    async fn rejects_missing_or_invalid_ids_status_and_tags_without_changes() {
        let pool = database().await;
        for (ids, patch) in [
            (
                vec![1, 999],
                LibraryBatchPatch {
                    favorite: Some(true),
                    ..Default::default()
                },
            ),
            (
                vec![1],
                LibraryBatchPatch {
                    status: Some("bad".into()),
                    ..Default::default()
                },
            ),
            (
                vec![1],
                LibraryBatchPatch {
                    favorite: Some(true),
                    add_tag_ids: vec![999],
                    ..Default::default()
                },
            ),
            (
                vec![-1],
                LibraryBatchPatch {
                    favorite: Some(true),
                    ..Default::default()
                },
            ),
            (
                vec![1],
                LibraryBatchPatch {
                    add_tag_ids: vec![1],
                    remove_tag_ids: vec![1],
                    ..Default::default()
                },
            ),
        ] {
            assert!(apply_batch(&pool, ids, patch).await.is_err());
        }
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT SUM(favorite) FROM games")
                .fetch_one(&pool)
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM game_tags")
                .fetch_one(&pool)
                .await
                .unwrap(),
            0
        );
    }
    #[tokio::test]
    async fn rolls_back_database_failure_after_first_game() {
        let pool = database().await;
        sqlx::raw_sql("CREATE TRIGGER reject_second BEFORE UPDATE ON games WHEN NEW.id=2 BEGIN SELECT RAISE(ABORT,'test failure'); END;").execute(&pool).await.unwrap();
        assert!(apply_batch(
            &pool,
            vec![1, 2],
            LibraryBatchPatch {
                favorite: Some(true),
                add_tag_ids: vec![1],
                ..Default::default()
            }
        )
        .await
        .is_err());
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT SUM(favorite) FROM games")
                .fetch_one(&pool)
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM game_tags")
                .fetch_one(&pool)
                .await
                .unwrap(),
            0
        );
    }
}
