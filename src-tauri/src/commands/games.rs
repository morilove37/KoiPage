//! `games_*` commands.

use sqlx::{Pool, Sqlite};
use tauri::{AppHandle, Manager};
use tauri_plugin_sql::{DbInstances, DbPool};

use super::error::{CmdError, CmdResult};
use super::model::{Game, GameDetail, GameInput, GamePatch};
use super::util::*;
use super::DB_URL;

/// Fetch the sqlite connection pool for our database.
///
/// `DbPool` is an enum over the enabled drivers with public variants (it has
/// no public accessor methods), so the sqlite pool is extracted by matching.
/// The inner `sqlx::Pool` is cheap to clone — it is an `Arc` handle — so it is
/// returned by value rather than held under the `RwLock` read guard.
/// A `None` here means the database has not been connected yet.
pub async fn pool(app: &AppHandle) -> CmdResult<Pool<Sqlite>> {
    let instances = app.state::<DbInstances>();
    let instances = instances.0.read().await;
    match instances.get(DB_URL) {
        Some(DbPool::Sqlite(pool)) => Ok(pool.clone()),
        // Only reachable if the mysql/postgres features are ever enabled.
        #[allow(unreachable_patterns)]
        Some(_) => Err(CmdError(format!("{DB_URL} is not a sqlite database"))),
        None => Err(CmdError(format!("database {DB_URL} is not loaded yet"))),
    }
}

// CAST also accepts ratings saved as INTEGER by older releases (and whole
// numbers saved with SQLite's INTEGER affinity), while preserving NULL.
// The tiny tolerance matches round_rating for legacy half-way floats (8.725).
const SELECT_GAME: &str = "SELECT id, title, original_title, developer, release_date, status, \
     ROUND(CAST(rating AS REAL) + 1e-12, 2) AS rating, favorite, cover_path, description, install_path, exe_path, launch_args, workdir, \
     save_path, play_time_seconds, last_played_at, notes, vndb_id, bangumi_id, created_at, \
     updated_at FROM games";

async fn fetch_game(pool: &Pool<Sqlite>, id: i64) -> CmdResult<Game> {
    let game = sqlx::query_as::<_, Game>(&format!("{SELECT_GAME} WHERE id = ?"))
        .bind(id)
        .fetch_optional(pool)
        .await?;
    game.ok_or_else(|| not_found("game", id))
}

/// `games_list` — all games, newest first, optionally filtered.
#[tauri::command]
pub async fn games_list(
    app: AppHandle,
    search: Option<String>,
    status: Option<String>,
    favorite_only: Option<bool>,
) -> CmdResult<Vec<Game>> {
    let pool = pool(&app).await?;

    let search = search.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let status = status
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(validate_status)
        .transpose()?;

    // Conditions and their binds are built together so positional `?`
    // placeholders always line up with `.bind()` call order.
    let mut sql = String::from(SELECT_GAME);
    let mut conditions: Vec<&str> = Vec::new();
    let mut binds: Vec<String> = Vec::new();

    // LIKE ... ESCAPE '\' keeps user-typed % and _ from acting as wildcards.
    if let Some(search) = search {
        conditions.push(
            "(title LIKE ? ESCAPE '\\' OR original_title LIKE ? ESCAPE '\\' \
             OR developer LIKE ? ESCAPE '\\')",
        );
        let pattern = format!("%{}%", super::escape_like(search));
        binds.push(pattern.clone());
        binds.push(pattern.clone());
        binds.push(pattern);
    }
    if let Some(status) = status {
        conditions.push("status = ?");
        binds.push(status);
    }
    if favorite_only.unwrap_or(false) {
        conditions.push("favorite = 1");
    }

    if !conditions.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&conditions.join(" AND "));
    }
    sql.push_str(" ORDER BY title COLLATE NOCASE ASC, id ASC");

    let mut query = sqlx::query_as::<_, Game>(&sql);
    for bind in binds {
        query = query.bind(bind);
    }

    let games = query.fetch_all(&pool).await?;
    Ok(games)
}

/// `game_get` — one game plus its tag ids.
#[tauri::command]
pub async fn game_get(app: AppHandle, id: i64) -> CmdResult<GameDetail> {
    let pool = pool(&app).await?;
    let game = fetch_game(&pool, id).await?;
    let tags: Vec<(i64,)> = sqlx::query_as("SELECT tag_id FROM game_tags WHERE game_id = ? ORDER BY tag_id")
        .bind(id)
        .fetch_all(&pool)
        .await?;
    Ok(GameDetail {
        game,
        tags: tags.into_iter().map(|(t,)| t).collect(),
    })
}

/// `game_create` — insert a game and optionally attach tags.
#[tauri::command]
pub async fn game_create(app: AppHandle, input: GameInput) -> CmdResult<Game> {
    let mut input = input;
    let pool = pool(&app).await?;
    if let Some(path) = input.cover_path.take() {
        input.cover_path = Some(super::covers::retain_or_original(&app, path).await);
    }
    let game = create_game(&pool, input).await?;
    if let Some(path) = &game.cover_path {
        crate::allow_asset_file(&app, path);
    }
    Ok(game)
}

async fn create_game(pool: &Pool<Sqlite>, input: GameInput) -> CmdResult<Game> {
    let title = required_string(&input.title, "title")?;
    let install_path = required_string(&input.install_path, "installPath")?;
    let status = match input.status.as_deref() {
        Some(s) => validate_status(s)?,
        None => super::model::STATUS_UNPLAYED.to_string(),
    };
    let rating = validate_rating(input.rating)?;
    let now = now_iso8601();

    let mut tx = pool.begin().await?;

    // Windows treats spelling and separator variations as the same folder.
    // Match the scanner's deduplication inside the write transaction too.
    let key = |path: &str| path.trim().trim_end_matches(['\\', '/']).replace('/', "\\").to_lowercase();
    let existing_paths: Vec<String> = sqlx::query_scalar("SELECT install_path FROM games")
        .fetch_all(&mut *tx)
        .await?;
    if existing_paths.iter().any(|path| key(path) == key(&install_path)) {
        return Err(CmdError("该游戏目录已导入，请到游戏详情中修改启动程序。".to_string()));
    }

    let id: i64 = sqlx::query_scalar(
        "INSERT INTO games (title, original_title, developer, release_date, status, rating, \
         favorite, cover_path, description, install_path, exe_path, launch_args, workdir, \
         save_path, play_time_seconds, last_played_at, notes, vndb_id, bangumi_id, created_at, \
         updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, \
         ?16, ?17, ?18, ?19, ?20, ?20) RETURNING id",
    )
    .bind(&title)
    .bind(optional_string(input.original_title.clone()))
    .bind(optional_string(input.developer.clone()))
    .bind(optional_string(input.release_date.clone()))
    .bind(&status)
    .bind(rating)
    .bind(input.favorite.unwrap_or(0))
    .bind(optional_string(input.cover_path.clone()))
    .bind(optional_string(input.description.clone()))
    .bind(&install_path)
    .bind(optional_string(input.exe_path.clone()))
    .bind(optional_string(input.launch_args.clone()))
    .bind(optional_string(input.workdir.clone()))
    .bind(optional_string(input.save_path.clone()))
    .bind(input.play_time_seconds.unwrap_or(0))
    .bind(optional_string(input.last_played_at.clone()))
    .bind(optional_string(input.notes.clone()))
    .bind(optional_string(input.vndb_id.clone()))
    .bind(optional_string(input.bangumi_id.clone()))
    .bind(&now)
    .fetch_one(&mut *tx)
    .await?;

    for tag_id in &input.tags {
        sqlx::query("INSERT OR IGNORE INTO game_tags (game_id, tag_id) VALUES (?, ?)")
            .bind(id)
            .bind(tag_id)
            .execute(&mut *tx)
            .await?;
    }

    attach_tag_names(&mut tx, id, &input.tag_names).await?;

    tx.commit().await?;
    fetch_game(pool, id).await
}

async fn attach_tag_names(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    game_id: i64,
    names: &[String],
) -> CmdResult<()> {
    for name in names {
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        let existing: Option<i64> = sqlx::query_scalar(
            "SELECT id FROM tags WHERE name = ? COLLATE NOCASE LIMIT 1",
        )
        .bind(name)
        .fetch_optional(&mut **tx)
        .await?;
        let tag_id = match existing {
            Some(id) => id,
            None => sqlx::query_scalar("INSERT INTO tags (name) VALUES (?) RETURNING id")
                .bind(name)
                .fetch_one(&mut **tx)
                .await?,
        };
        sqlx::query("INSERT OR IGNORE INTO game_tags (game_id, tag_id) VALUES (?, ?)")
            .bind(game_id)
            .bind(tag_id)
            .execute(&mut **tx)
            .await?;
    }

    Ok(())
}

/// `game_update` — partial update; omitted fields are left untouched.
#[tauri::command]
pub async fn game_update(app: AppHandle, id: i64, patch: GamePatch) -> CmdResult<Game> {
    let mut patch = patch;
    let pool = pool(&app).await?;
    patch.cover_path = match patch.cover_path {
        Some(Some(path)) => Some(Some(super::covers::retain_or_original(&app, path).await)),
        unchanged => unchanged,
    };
    let game = update_game(&pool, id, patch).await?;
    if let Some(path) = &game.cover_path {
        crate::allow_asset_file(&app, path);
    }
    Ok(game)
}

async fn update_game(pool: &Pool<Sqlite>, id: i64, patch: GamePatch) -> CmdResult<Game> {
    // Ensure the row exists so we can report a clean "not found".
    fetch_game(pool, id).await?;

    if patch.is_empty() {
        return fetch_game(pool, id).await;
    }

    let mut tx = pool.begin().await?;

    if let Some(title) = patch.title.as_deref() {
        let title = required_string(title, "title")?;
        sqlx::query("UPDATE games SET title = ? WHERE id = ?")
            .bind(title)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(install_path) = patch.install_path.as_deref() {
        let install_path = required_string(install_path, "installPath")?;
        sqlx::query("UPDATE games SET install_path = ? WHERE id = ?")
            .bind(install_path)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(status) = patch.status.as_deref() {
        let status = validate_status(status)?;
        sqlx::query("UPDATE games SET status = ? WHERE id = ?")
            .bind(status)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(favorite) = patch.favorite {
        sqlx::query("UPDATE games SET favorite = ? WHERE id = ?")
            .bind(favorite)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(play_time_seconds) = patch.play_time_seconds {
        sqlx::query("UPDATE games SET play_time_seconds = ? WHERE id = ?")
            .bind(play_time_seconds)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(rating) = patch.rating {
        let rating = validate_rating(rating)?;
        sqlx::query("UPDATE games SET rating = ? WHERE id = ?")
            .bind(rating)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }

    // Simple nullable columns: Option<Option<T>> distinguishes "absent" from "null".
    macro_rules! set_nullable {
        ($field:expr, $column:literal) => {
            if let Some(value) = $field.as_ref() {
                sqlx::query(concat!("UPDATE games SET ", $column, " = ? WHERE id = ?"))
                    .bind(value.clone())
                    .bind(id)
                    .execute(&mut *tx)
                    .await?;
            }
        };
    }

    set_nullable!(patch.original_title, "original_title");
    set_nullable!(patch.developer, "developer");
    set_nullable!(patch.release_date, "release_date");
    set_nullable!(patch.cover_path, "cover_path");
    set_nullable!(patch.description, "description");
    set_nullable!(patch.exe_path, "exe_path");
    set_nullable!(patch.launch_args, "launch_args");
    set_nullable!(patch.workdir, "workdir");
    set_nullable!(patch.save_path, "save_path");
    set_nullable!(patch.notes, "notes");
    set_nullable!(patch.vndb_id, "vndb_id");
    set_nullable!(patch.bangumi_id, "bangumi_id");

    if let Some(last_played_at) = patch.last_played_at.as_ref() {
        if let Some(value) = last_played_at.as_deref() {
            validate_iso8601(value, "lastPlayedAt")?;
        }
        sqlx::query("UPDATE games SET last_played_at = ? WHERE id = ?")
            .bind(last_played_at.clone())
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }

    if let Some(tags) = patch.tags.as_ref() {
        sqlx::query("DELETE FROM game_tags WHERE game_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        for tag_id in tags {
            sqlx::query("INSERT OR IGNORE INTO game_tags (game_id, tag_id) VALUES (?, ?)")
                .bind(id)
                .bind(tag_id)
                .execute(&mut *tx)
                .await?;
        }
    }

    attach_tag_names(&mut tx, id, &patch.tag_names).await?;

    sqlx::query("UPDATE games SET updated_at = ? WHERE id = ?")
        .bind(now_iso8601())
        .bind(id)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;
    fetch_game(pool, id).await
}

/// `game_delete` — removes the game; tags/sessions cascade away.
#[tauri::command]
pub async fn game_delete(app: AppHandle, id: i64) -> CmdResult<()> {
    let pool = pool(&app).await?;
    let result = sqlx::query("DELETE FROM games WHERE id = ?")
        .bind(id)
        .execute(&pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(not_found("game", id));
    }
    Ok(())
}

/// `games_delete` — remove many games in one transaction.
///
/// Exists because the library's multi-select would otherwise issue one IPC call
/// per selected game: a selection of a few hundred becomes a few hundred round
/// trips, and a failure part-way through would leave the library half-deleted
/// with no way to tell where it stopped. One statement inside a transaction is
/// all-or-nothing.
///
/// Unknown ids are reported rather than failing the whole call — the selection
/// can legitimately contain a row another window just removed.
#[tauri::command]
pub async fn games_delete(app: AppHandle, ids: Vec<i64>) -> CmdResult<DeleteGamesResult> {
    let pool = pool(&app).await?;

    let requested = ids.len();
    // De-duplicate so the same id twice cannot inflate the reported count.
    let mut unique: Vec<i64> = ids;
    unique.sort_unstable();
    unique.dedup();

    if unique.is_empty() {
        return Ok(DeleteGamesResult {
            requested,
            deleted: 0,
            missing: Vec::new(),
        });
    }

    let mut tx = pool.begin().await?;
    let mut missing: Vec<i64> = Vec::new();

    for id in &unique {
        let result = sqlx::query("DELETE FROM games WHERE id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        if result.rows_affected() == 0 {
            missing.push(*id);
        }
    }

    tx.commit().await?;

    Ok(DeleteGamesResult {
        requested,
        deleted: unique.len() - missing.len(),
        missing,
    })
}

/// Outcome of [`games_delete`].
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteGamesResult {
    /// How many ids the caller supplied, before de-duplication.
    pub requested: usize,
    pub deleted: usize,
    /// Ids that matched no row.
    pub missing: Vec<i64>,
}

/// `games_tags_get` — all `game_id -> tag_ids` links in one round trip, so the
/// list view can render tag chips without an N+1 query per game.
#[tauri::command]
pub async fn games_tags_get(app: AppHandle) -> CmdResult<Vec<(i64, i64)>> {
    let pool = pool(&app).await?;
    let rows: Vec<(i64, i64)> =
        sqlx::query_as("SELECT game_id, tag_id FROM game_tags ORDER BY game_id, tag_id")
            .fetch_all(&pool)
            .await?;
    Ok(rows)
}

/// `games_stats` — aggregate counters for the dashboard.
#[tauri::command]
pub async fn games_stats(app: AppHandle) -> CmdResult<GameStats> {
    let pool = pool(&app).await?;
    let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM games")
        .fetch_one(&pool)
        .await?;
    let favorite: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM games WHERE favorite = 1")
        .fetch_one(&pool)
        .await?;
    let play_time_seconds: i64 =
        sqlx::query_scalar("SELECT COALESCE(SUM(play_time_seconds), 0) FROM games")
            .fetch_one(&pool)
            .await?;
    let by_status: Vec<(String, i64)> =
        sqlx::query_as("SELECT status, COUNT(*) FROM games GROUP BY status ORDER BY status")
            .fetch_all(&pool)
            .await?;

    Ok(GameStats {
        total,
        favorite,
        play_time_seconds,
        by_status,
    })
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameStats {
    pub total: i64,
    pub favorite: i64,
    pub play_time_seconds: i64,
    pub by_status: Vec<(String, i64)>,
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_pool() -> Pool<Sqlite> {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await.unwrap();
        sqlx::raw_sql(include_str!("../../migrations/0001_init.sql"))
            .execute(&pool).await.unwrap();
        pool
    }

    fn input(path: &str, tags: Vec<&str>) -> GameInput {
        serde_json::from_value(serde_json::json!({
            "title": "测试游戏", "installPath": path,
            "exePath": format!("{path}\\game.exe"), "tagNames": tags,
        })).unwrap()
    }

    #[tokio::test]
    async fn import_creates_only_accepted_tags_and_reuses_existing_names() {
        let pool = test_pool().await;
        sqlx::query("INSERT INTO tags (name) VALUES ('Story')").execute(&pool).await.unwrap();
        let game = create_game(&pool, input(r"E:\Games\Demo", vec!["Story", "story", "纯爱", "纯爱", " "])).await.unwrap();
        let tags: Vec<String> = sqlx::query_scalar(
            "SELECT name FROM tags JOIN game_tags ON tags.id = game_tags.tag_id WHERE game_id = ? ORDER BY name",
        ).bind(game.id).fetch_all(&pool).await.unwrap();
        assert_eq!(tags, vec!["Story", "纯爱"]);
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tags").fetch_one(&pool).await.unwrap();
        assert_eq!(count, 2);
    }

    #[tokio::test]
    async fn import_rejects_same_windows_folder_with_another_exe() {
        let pool = test_pool().await;
        create_game(&pool, input(r"E:\Games\Demo", vec![])).await.unwrap();
        assert!(create_game(&pool, input("e:/games/demo/", vec!["must not be created"])).await.is_err());
        let games: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM games").fetch_one(&pool).await.unwrap();
        let tags: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tags").fetch_one(&pool).await.unwrap();
        assert_eq!((games, tags), (1, 0));
    }

    #[tokio::test]
    async fn failed_import_rolls_back_game_and_tags() {
        let pool = test_pool().await;
        let mut draft = input(r"E:\Games\Demo", vec!["new tag"]);
        draft.tags = vec![999];
        assert!(create_game(&pool, draft).await.is_err());
        let games: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM games").fetch_one(&pool).await.unwrap();
        let tags: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tags").fetch_one(&pool).await.unwrap();
        assert_eq!((games, tags), (0, 0));
    }

    #[tokio::test]
    async fn ratings_round_to_hundredths_and_read_legacy_integer_rows() {
        let pool = test_pool().await;
        let mut draft = input(r"E:\Games\Decimal", vec![]);
        draft.rating = Some(8.725);
        let game = create_game(&pool, draft).await.unwrap();
        assert_eq!(game.rating, Some(8.73));
        // The existing INTEGER-affinity SQLite column stores fractional values
        // as REAL without rebuilding the table or disturbing foreign keys.
        let storage: String = sqlx::query_scalar("SELECT typeof(rating) FROM games WHERE id = ?")
            .bind(game.id).fetch_one(&pool).await.unwrap();
        assert_eq!(storage, "real");
        sqlx::query("UPDATE games SET rating = 8 WHERE id = ?")
            .bind(game.id).execute(&pool).await.unwrap();
        assert_eq!(fetch_game(&pool, game.id).await.unwrap().rating, Some(8.0));
        sqlx::query("UPDATE games SET rating = 8.725 WHERE id = ?")
            .bind(game.id).execute(&pool).await.unwrap();
        assert_eq!(fetch_game(&pool, game.id).await.unwrap().rating, Some(8.73));
        let patch: GamePatch = serde_json::from_str(r#"{"rating":7.865}"#).unwrap();
        assert_eq!(update_game(&pool, game.id, patch).await.unwrap().rating, Some(7.87));
        for invalid in [f64::NAN, f64::INFINITY, -0.1, 10.01] {
            let patch = GamePatch { rating: Some(Some(invalid)), title: Some("must roll back".into()), ..Default::default() };
            assert!(update_game(&pool, game.id, patch).await.is_err());
            assert_eq!(fetch_game(&pool, game.id).await.unwrap().title, game.title);
        }
        let patch: GamePatch = serde_json::from_str(r#"{"rating":null}"#).unwrap();
        assert_eq!(update_game(&pool, game.id, patch).await.unwrap().rating, None);
    }

    #[tokio::test]
    async fn update_adds_new_tags_and_reuses_names_without_replacing_existing_links() {
        let pool = test_pool().await;
        let game = create_game(&pool, input(r"E:\Games\Demo", vec!["Story"])).await.unwrap();
        let patch: GamePatch = serde_json::from_value(serde_json::json!({
            "tagNames": ["story", " 新标签 ", "新标签", " "]
        })).unwrap();
        assert!(!patch.is_empty());
        update_game(&pool, game.id, patch).await.unwrap();
        let names: Vec<String> = sqlx::query_scalar(
            "SELECT name FROM tags JOIN game_tags ON tags.id = game_tags.tag_id WHERE game_id = ? ORDER BY name",
        ).bind(game.id).fetch_all(&pool).await.unwrap();
        assert_eq!(names, vec!["Story", "新标签"]);
        let patch: GamePatch = serde_json::from_value(serde_json::json!({
            "tags": [], "tagNames": ["新的分类"]
        })).unwrap();
        update_game(&pool, game.id, patch).await.unwrap();
        let names: Vec<String> = sqlx::query_scalar(
            "SELECT name FROM tags JOIN game_tags ON tags.id = game_tags.tag_id WHERE game_id = ?",
        ).bind(game.id).fetch_all(&pool).await.unwrap();
        assert_eq!(names, vec!["新的分类"]);
    }

    #[tokio::test]
    async fn failed_update_rolls_back_new_tags_links_and_game_edits() {
        let pool = test_pool().await;
        let game = create_game(&pool, input(r"E:\Games\Demo", vec!["Story"])).await.unwrap();
        sqlx::raw_sql("CREATE TRIGGER reject_tag BEFORE INSERT ON tags WHEN NEW.name = 'blocked' BEGIN SELECT RAISE(ABORT, 'test failure'); END;")
            .execute(&pool).await.unwrap();
        let patch: GamePatch = serde_json::from_value(serde_json::json!({
            "title": "must roll back", "tags": [], "tagNames": ["new tag", "blocked"]
        })).unwrap();
        assert!(update_game(&pool, game.id, patch).await.is_err());
        assert_eq!(fetch_game(&pool, game.id).await.unwrap().title, game.title);
        let names: Vec<String> = sqlx::query_scalar(
            "SELECT name FROM tags JOIN game_tags ON tags.id = game_tags.tag_id WHERE game_id = ?",
        ).bind(game.id).fetch_all(&pool).await.unwrap();
        assert_eq!(names, vec!["Story"]);
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tags").fetch_one(&pool).await.unwrap();
        assert_eq!(count, 1);
    }
}
