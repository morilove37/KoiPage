//! `tags_*` and `game_set_tags` commands.

use tauri::AppHandle;

use super::error::{CmdError, CmdResult};
use super::games::pool;
use super::model::Tag;
use super::util::*;

/// `tags_list` — all tags, alphabetical.
#[tauri::command]
pub async fn tags_list(app: AppHandle) -> CmdResult<Vec<Tag>> {
    let pool = pool(&app).await?;
    let tags = sqlx::query_as::<_, Tag>(
        "SELECT id, name, color FROM tags ORDER BY name COLLATE NOCASE ASC, id ASC",
    )
    .fetch_all(&pool)
    .await?;
    Ok(tags)
}

/// `tag_create` — insert a tag. Duplicate names surface as a unique-violation error.
#[tauri::command]
pub async fn tag_create(app: AppHandle, name: String, color: Option<String>) -> CmdResult<Tag> {
    let pool = pool(&app).await?;
    let name = required_string(&name, "name")?;
    let color = optional_string(color);

    let existing: Option<(i64,)> = sqlx::query_as("SELECT id FROM tags WHERE name = ?")
        .bind(&name)
        .fetch_optional(&pool)
        .await?;
    if existing.is_some() {
        return Err(CmdError(format!("tag {name:?} already exists")));
    }

    let id: i64 = sqlx::query_scalar("INSERT INTO tags (name, color) VALUES (?, ?) RETURNING id")
        .bind(&name)
        .bind(&color)
        .fetch_one(&pool)
        .await?;

    Ok(Tag { id, name, color })
}

/// `tag_update` — rename and/or recolour a tag.
#[tauri::command]
pub async fn tag_update(
    app: AppHandle,
    id: i64,
    name: Option<String>,
    color: Option<Option<String>>,
) -> CmdResult<Tag> {
    let pool = pool(&app).await?;

    if let Some(name) = name.as_deref() {
        let name = required_string(name, "name")?;
        let clash: Option<(i64,)> = sqlx::query_as("SELECT id FROM tags WHERE name = ? AND id <> ?")
            .bind(&name)
            .bind(id)
            .fetch_optional(&pool)
            .await?;
        if clash.is_some() {
            return Err(CmdError(format!("tag {name:?} already exists")));
        }
        let result = sqlx::query("UPDATE tags SET name = ? WHERE id = ?")
            .bind(&name)
            .bind(id)
            .execute(&pool)
            .await?;
        if result.rows_affected() == 0 {
            return Err(not_found("tag", id));
        }
    }

    if let Some(color) = color.as_ref() {
        let result = sqlx::query("UPDATE tags SET color = ? WHERE id = ?")
            .bind(optional_string(color.clone()))
            .bind(id)
            .execute(&pool)
            .await?;
        if result.rows_affected() == 0 {
            return Err(not_found("tag", id));
        }
    }

    let tag = sqlx::query_as::<_, Tag>("SELECT id, name, color FROM tags WHERE id = ?")
        .bind(id)
        .fetch_optional(&pool)
        .await?;
    tag.ok_or_else(|| not_found("tag", id))
}

/// `tag_delete` — removes a tag; `game_tags` rows cascade away.
#[tauri::command]
pub async fn tag_delete(app: AppHandle, id: i64) -> CmdResult<()> {
    let pool = pool(&app).await?;
    let result = sqlx::query("DELETE FROM tags WHERE id = ?")
        .bind(id)
        .execute(&pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(not_found("tag", id));
    }
    Ok(())
}

/// `game_set_tags` — replace a game's tag set wholesale.
#[tauri::command]
pub async fn game_set_tags(app: AppHandle, game_id: i64, tag_ids: Vec<i64>) -> CmdResult<Vec<i64>> {
    let pool = pool(&app).await?;

    let exists: Option<(i64,)> = sqlx::query_as("SELECT id FROM games WHERE id = ?")
        .bind(game_id)
        .fetch_optional(&pool)
        .await?;
    if exists.is_none() {
        return Err(not_found("game", game_id));
    }

    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM game_tags WHERE game_id = ?")
        .bind(game_id)
        .execute(&mut *tx)
        .await?;
    for tag_id in &tag_ids {
        sqlx::query("INSERT OR IGNORE INTO game_tags (game_id, tag_id) VALUES (?, ?)")
            .bind(game_id)
            .bind(tag_id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;

    let tags: Vec<(i64,)> = sqlx::query_as("SELECT tag_id FROM game_tags WHERE game_id = ? ORDER BY tag_id")
        .bind(game_id)
        .fetch_all(&pool)
        .await?;
    Ok(tags.into_iter().map(|(t,)| t).collect())
}
