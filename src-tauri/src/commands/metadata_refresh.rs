//! Explicit, backed-up replacement of catalogue metadata. No user activity data
//! is included in the write set. Jobs live in application state across navigation.

use super::{
    error::{CmdError, CmdResult},
    games::pool,
    metadata::{self, Sources},
    settings::settings_get_impl,
};
use crate::metadata::{MetadataDetail, Provider, TitlePreference};
use serde::Serialize;
use sqlx::{Row, SqlitePool};
use std::sync::{
    Mutex,
    atomic::{AtomicBool, Ordering},
};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RefreshState {
    phase: Phase,
    run_id: u64,
    total: usize,
    processed: usize,
    updated: usize,
    needs_review: usize,
    failed: usize,
    skipped: usize,
    current_title: Option<String>,
    backup_path: Option<String>,
    error: Option<String>,
    outcomes: Vec<Outcome>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
enum Phase {
    #[default]
    Idle,
    BackingUp,
    Running,
    Completed,
    Stopped,
    Failed,
}
impl Phase {
    fn active(self) -> bool {
        matches!(self, Self::BackingUp | Self::Running)
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum ResultKind {
    Updated,
    NeedsReview,
    NeedsAuthorization,
    Failed,
    Skipped,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Outcome {
    game_id: i64,
    title: String,
    status: ResultKind,
    message: String,
    #[serde(skip)]
    changed: bool,
}

#[derive(Default)]
pub struct RefreshJob {
    state: Mutex<RefreshState>,
    cancel: AtomicBool,
}

fn publish(app: &AppHandle, change: impl FnOnce(&mut RefreshState)) -> RefreshState {
    let job = app.state::<RefreshJob>();
    let mut state = job.state.lock().unwrap_or_else(|e| e.into_inner());
    change(&mut state);
    let copy = state.clone();
    let _ = app.emit("metadata-refresh-progress", &copy);
    copy
}
fn cancelled(app: &AppHandle) -> bool {
    app.state::<RefreshJob>().cancel.load(Ordering::Acquire)
}

#[tauri::command]
pub fn metadata_refresh_status(app: AppHandle) -> RefreshState {
    publish(&app, |_| {})
}

#[tauri::command]
pub fn metadata_refresh_cancel(app: AppHandle) -> RefreshState {
    app.state::<RefreshJob>()
        .cancel
        .store(true, Ordering::Release);
    publish(&app, |_| {})
}

#[tauri::command]
pub async fn metadata_refresh_start(app: AppHandle, confirmed: bool) -> CmdResult<RefreshState> {
    if !confirmed {
        return Err(CmdError("请先确认资料覆盖警告".into()));
    }
    let db = pool(&app).await?;
    let enabled = metadata::enabled_sources(&db).await?;
    if enabled.is_empty() {
        return Err(CmdError("请先启用至少一个资料数据源".into()));
    }
    let ids: Vec<i64> = sqlx::query_scalar("SELECT id FROM games ORDER BY id LIMIT 10001")
        .fetch_all(&db)
        .await?;
    if ids.is_empty() {
        return Err(CmdError("游戏库为空，无需焕新".into()));
    }
    if ids.len() > 10000 {
        return Err(CmdError("一次最多焕新 10000 部作品".into()));
    }
    let preferred = metadata::source_preference(&db).await?;
    let language = metadata::title_preference(&db).await;
    let key = settings_get_impl(&db, metadata::NEXTMOE_KEY).await?;
    let initial = {
        let job = app.state::<RefreshJob>();
        let mut state = job.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.phase.active() {
            return Err(CmdError("已有资料焕新正在进行".into()));
        }
        job.cancel.store(false, Ordering::Release);
        *state = RefreshState {
            phase: Phase::BackingUp,
            run_id: state.run_id + 1,
            total: ids.len(),
            ..Default::default()
        };
        state.clone()
    };
    let _ = app.emit("metadata-refresh-progress", &initial);
    tauri::async_runtime::spawn(async move {
        // A refresh may bind new subjects; synchronize only after the batch has
        // finished. An existing sync finishes before the backup is captured.
        let sync = app.state::<crate::bangumi_sync::SyncState>();
        let _sync_guard = sync.gate.lock().await;
        let result = run(
            &app,
            &db,
            ids,
            &enabled,
            preferred,
            language,
            key.as_deref(),
        )
        .await;
        publish(&app, |state| {
            state.current_title = None;
            match result {
                Err(error) => {
                    state.phase = Phase::Failed;
                    state.error = Some(error.0);
                }
                Ok(()) => {
                    state.phase = if cancelled(&app) {
                        Phase::Stopped
                    } else {
                        Phase::Completed
                    }
                }
            }
        });
        crate::bangumi_sync::mark_dirty(&app);
    });
    Ok(initial)
}

async fn run(
    app: &AppHandle,
    db: &SqlitePool,
    ids: Vec<i64>,
    enabled: &[Sources],
    preferred: Provider,
    language: TitlePreference,
    key: Option<&str>,
) -> CmdResult<()> {
    if cancelled(app) {
        return Ok(());
    }
    let directory = app
        .path()
        .app_config_dir()?
        .join("metadata-refresh-backups");
    std::fs::create_dir_all(&directory)
        .map_err(|e| CmdError(format!("无法创建焕新备份目录：{e}")))?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| CmdError(e.to_string()))?
        .as_millis();
    let backup = directory.join(format!("before-refresh-{stamp}.koibak"));
    super::backup::backup_create(
        app.clone(),
        backup.to_string_lossy().into_owned(),
        Some(false),
    )
    .await?;
    publish(app, |s| {
        s.backup_path = Some(backup.to_string_lossy().into_owned());
        s.phase = Phase::Running;
    });
    for id in ids {
        if cancelled(app) {
            break;
        }
        let Some(before) = Snapshot::read(db, id).await? else {
            record(
                app,
                Outcome {
                    game_id: id,
                    title: format!("作品 {id}"),
                    status: ResultKind::Skipped,
                    message: "作品已被删除".into(),
                    changed: false,
                },
            );
            continue;
        };
        publish(app, |s| s.current_title = Some(before.title().to_owned()));
        let outcome = match lookup(&before, enabled, preferred, key).await {
            Err(error) => Outcome {
                game_id: id,
                title: before.title().into(),
                status: ResultKind::Failed,
                message: error.0,
                changed: false,
            },
            Ok(None) => Outcome {
                game_id: id,
                title: before.title().into(),
                status: ResultKind::NeedsReview,
                message: "未找到唯一可信的作品，请在作品详情中手动匹配资料".into(),
                changed: false,
            },
            Ok(Some(mut detail)) => {
                if cancelled(app) {
                    break;
                }
                select_description(&mut detail, preferred);
                match apply(db, id, &before, &detail, language).await {
                    Err(error) => Outcome {
                        game_id: id,
                        title: before.title().into(),
                        status: ResultKind::Failed,
                        message: error.0,
                        changed: false,
                    },
                    Ok((status, message)) => {
                        let needs_binding = enabled.contains(&Sources::Bangumi)
                            && before.get("bangumi_id").is_none()
                            && detail
                                .bangumi_id
                                .as_deref()
                                .is_none_or(|v| v.trim().is_empty());
                        let changed = status == ResultKind::Updated;
                        let (needs_authorization, binding_hint) = if needs_binding {
                            crate::metadata::bangumi::missing_binding_hint()
                        } else {
                            (false, String::new())
                        };
                        Outcome {
                            game_id: id,
                            title: before.title().into(),
                            status: if needs_binding
                                && matches!(status, ResultKind::Updated | ResultKind::Skipped)
                            {
                                if needs_authorization {
                                    ResultKind::NeedsAuthorization
                                } else {
                                    ResultKind::NeedsReview
                                }
                            } else {
                                status
                            },
                            message: if needs_binding {
                                format!("{message}；{binding_hint}")
                            } else {
                                message
                            },
                            changed,
                        }
                    }
                }
            }
        };
        record(app, outcome);
        if cancelled(app) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(700)).await;
    }
    Ok(())
}
fn record(app: &AppHandle, outcome: Outcome) {
    publish(app, |s| {
        s.processed += 1;
        if outcome.changed {
            s.updated += 1;
        }
        match outcome.status {
            ResultKind::Updated => {}
            ResultKind::NeedsReview | ResultKind::NeedsAuthorization => s.needs_review += 1,
            ResultKind::Failed => s.failed += 1,
            ResultKind::Skipped => s.skipped += 1,
        }
        s.outcomes.push(outcome);
    });
}

const COLUMNS: [&str; 7] = [
    "title",
    "original_title",
    "developer",
    "release_date",
    "description",
    "vndb_id",
    "bangumi_id",
];
#[derive(Debug, Clone, PartialEq)]
struct Snapshot {
    texts: Vec<Option<String>>,
    rating: Option<f64>,
}
impl Snapshot {
    fn title(&self) -> &str {
        self.texts[0].as_deref().unwrap_or("")
    }
    fn get(&self, column: &str) -> Option<&str> {
        COLUMNS
            .iter()
            .position(|&c| c == column)
            .and_then(|i| self.texts[i].as_deref())
            .filter(|s| !s.trim().is_empty())
    }
    fn from_row(row: &sqlx::sqlite::SqliteRow) -> CmdResult<Self> {
        Ok(Self {
            texts: COLUMNS
                .iter()
                .map(|c| row.try_get::<Option<String>, _>(*c))
                .collect::<Result<_, _>>()?,
            rating: row.try_get("refresh_rating")?,
        })
    }
    async fn read(db: &SqlitePool, id: i64) -> CmdResult<Option<Self>> {
        sqlx::query("SELECT *, CAST(rating AS REAL) AS refresh_rating FROM games WHERE id=?")
            .bind(id)
            .fetch_optional(db)
            .await?
            .map(|row| {
                let mut s = Self::from_row(&row)?;
                s.rating = row.try_get("refresh_rating")?;
                Ok(s)
            })
            .transpose()
    }
    fn identity(&self) -> MetadataDetail {
        MetadataDetail {
            title: self.title().into(),
            title_original: self.get("original_title").map(str::to_owned),
            release_date: self.get("release_date").map(str::to_owned),
            vndb_id: self.get("vndb_id").map(str::to_owned),
            bangumi_id: self.get("bangumi_id").map(str::to_owned),
            ..Default::default()
        }
    }
}

async fn lookup(
    before: &Snapshot,
    enabled: &[Sources],
    preferred: Provider,
    key: Option<&str>,
) -> CmdResult<Option<MetadataDetail>> {
    let identity = before.identity();
    // Stable bindings work even if an old import used an English display name.
    let mut ordered = enabled.to_vec();
    ordered.sort_by_key(|s| s.provider() != preferred);
    let mut last_error = None;
    for source in ordered
        .iter()
        .filter(|source| source.provider() == preferred)
    {
        let id = match source {
            Sources::Vndb => identity.vndb_id.as_deref(),
            Sources::Bangumi => identity.bangumi_id.as_deref(),
            _ => None,
        };
        if let Some(id) = id {
            match metadata::resolve_detail_with_choices(*source, id, key, enabled, true).await {
                Ok(detail) if compatible_ids(&identity, &detail) => return Ok(Some(detail)),
                Ok(_) => return Ok(None),
                Err(error) => last_error = Some(error),
            }
        }
    }
    // Search original and display titles; every automatic overwrite needs a
    // unique exact match within its source. Prefix matches require review.
    let mut queries = vec![before.title()];
    if let Some(original) = before
        .get("original_title")
        .filter(|&v| v != before.title())
    {
        queries.push(original);
    }
    let mut candidates = Vec::new();
    for query in queries {
        let (found, errors) = metadata::search_all(query, enabled, 10, key).await;
        for hit in found {
            if !candidates
                .iter()
                .any(|c: &crate::metadata::MetadataCandidate| {
                    c.provider == hit.provider && c.external_id == hit.external_id
                })
            {
                candidates.push(hit);
            }
        }
        if let Some(error) = errors.into_iter().next() {
            last_error = Some(CmdError(error.message));
        }
    }
    for source in &ordered {
        let Some(hit) = crate::metadata::description::description_candidate(
            &identity,
            &candidates,
            source.provider(),
        ) else {
            continue;
        };
        match metadata::resolve_detail_with_choices(*source, &hit.external_id, key, enabled, true)
            .await
        {
            Ok(detail)
                if crate::metadata::description::same_description_work(&identity, &detail) =>
            {
                return Ok(Some(detail));
            }
            Ok(_) => {}
            Err(error) => last_error = Some(error),
        }
    }
    for source in ordered
        .iter()
        .filter(|source| source.provider() != preferred)
    {
        let id = match source {
            Sources::Vndb => identity.vndb_id.as_deref(),
            Sources::Bangumi => identity.bangumi_id.as_deref(),
            _ => None,
        };
        if let Some(id) = id {
            match metadata::resolve_detail_with_choices(*source, id, key, enabled, true).await {
                Ok(detail) if compatible_ids(&identity, &detail) => return Ok(Some(detail)),
                Ok(_) => return Ok(None),
                Err(error) => last_error = Some(error),
            }
        }
    }
    if candidates.is_empty() {
        if let Some(error) = last_error {
            return Err(error);
        }
    }
    Ok(None)
}

fn compatible_ids(a: &MetadataDetail, b: &MetadataDetail) -> bool {
    [(&a.vndb_id, &b.vndb_id), (&a.bangumi_id, &b.bangumi_id)]
        .into_iter()
        .all(|(a, b)| match (a, b) {
            (Some(a), Some(b)) => a == b,
            _ => true,
        })
}

fn chinese(language: Option<&str>) -> bool {
    language.is_some_and(|s| s.to_ascii_lowercase().starts_with("zh"))
}
fn select_description(detail: &mut MetadataDetail, preferred: Provider) {
    let selected = detail
        .description_options
        .iter()
        .filter(|c| !c.text.trim().is_empty())
        .min_by_key(|c| (!chinese(c.language.as_deref()), c.source != Some(preferred)));
    if let Some(choice) = selected {
        detail.description = Some(choice.text.clone());
        detail.description_lang = choice.language.clone();
        detail.description_source = choice.source;
    }
}
fn has_han(text: &str) -> bool {
    text.chars().any(|c| ('\u{3400}'..='\u{9fff}').contains(&c))
}

fn updates(
    before: &Snapshot,
    detail: &MetadataDetail,
    language: TitlePreference,
) -> CmdResult<Vec<(&'static str, String)>> {
    let fields = metadata::AUTOFETCH_FIELDS
        .iter()
        .map(|s| s.to_string())
        .collect::<Vec<_>>();
    Ok(metadata::text_columns(detail, &fields, language)?
        .into_iter()
        .filter(|(column, value)| {
            if before.get(column) == Some(value.as_str()) {
                return false;
            }
            if matches!(*column, "vndb_id" | "bangumi_id") && before.get(column).is_some() {
                return false;
            }
            if *column == "description"
                && before.get(column).is_some_and(has_han)
                && !chinese(detail.description_lang.as_deref())
                && !has_han(value)
            {
                return false;
            }
            if *column == "title"
                && language == TitlePreference::Chinese
                && before.get(column).is_some_and(has_han)
                && !has_han(value)
            {
                return false;
            }
            true
        })
        .collect())
}

async fn apply(
    db: &SqlitePool,
    id: i64,
    before: &Snapshot,
    detail: &MetadataDetail,
    language: TitlePreference,
) -> CmdResult<(ResultKind, String)> {
    let columns = updates(before, detail, language)?;
    let rating = super::util::validate_rating(detail.rating)?.filter(|r| Some(*r) != before.rating);
    let mut tx = db.begin().await?;
    let row = sqlx::query("SELECT *, CAST(rating AS REAL) AS refresh_rating FROM games WHERE id=?")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
    let Some(row) = row else {
        return Ok((ResultKind::Skipped, "作品已删除".into()));
    };
    let mut current = Snapshot::from_row(&row)?;
    current.rating = row.try_get("refresh_rating")?;
    if &current != before {
        return Ok((
            ResultKind::Skipped,
            "获取资料期间作品资料已修改，已保留本地修改".into(),
        ));
    }
    let mut changed = 0;
    for (column, value) in &columns {
        sqlx::query(&format!("UPDATE games SET {column}=? WHERE id=?"))
            .bind(value)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        changed += 1;
    }
    if let Some(rating) = rating {
        sqlx::query("UPDATE games SET rating=? WHERE id=?")
            .bind(rating)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        changed += 1;
    }
    for name in crate::metadata::merge::dedupe_tags(detail.tags.clone()) {
        sqlx::query("INSERT OR IGNORE INTO tags(name) VALUES(?)")
            .bind(&name)
            .execute(&mut *tx)
            .await?;
        changed += sqlx::query(
            "INSERT OR IGNORE INTO game_tags(game_id,tag_id) SELECT ?,id FROM tags WHERE name=?",
        )
        .bind(id)
        .bind(&name)
        .execute(&mut *tx)
        .await?
        .rows_affected() as usize;
    }
    if changed > 0 {
        sqlx::query("UPDATE games SET updated_at=? WHERE id=?")
            .bind(super::util::now_iso8601())
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(if changed > 0 {
        (ResultKind::Updated, "资料已按当前规则更新".into())
    } else {
        (ResultKind::Skipped, "资料已经是当前结果，无需更改".into())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metadata::DescriptionOption;

    async fn database() -> SqlitePool {
        let db = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::raw_sql(include_str!("../../migrations/0001_init.sql"))
            .execute(&db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO games(id,title,description,install_path,exe_path,save_path,status,play_time_seconds,notes,cover_path,favorite,created_at,updated_at,vndb_id) VALUES(1,'Old English','Old introduction','game','game.exe','saves','playing',4321,'private','custom.png',1,'now','now','v4')").execute(&db).await.unwrap();
        sqlx::query("INSERT INTO tags(name) VALUES('私人标签')")
            .execute(&db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO game_tags VALUES(1,1)")
            .execute(&db)
            .await
            .unwrap();
        db
    }
    fn fresh() -> MetadataDetail {
        MetadataDetail {
            title: "CLANNAD".into(),
            title_zh: Some("克兰纳德".into()),
            title_original: Some("クラナド".into()),
            description: Some("中文简介".into()),
            description_lang: Some("zh-Hans".into()),
            rating: Some(8.91),
            bangumi_id: Some("12".into()),
            vndb_id: Some("v4".into()),
            tags: vec!["剧情".into()],
            ..Default::default()
        }
    }
    #[tokio::test]
    async fn refresh_replaces_catalogue_preserving_activity_paths_and_tags() {
        let db = database().await;
        let before = Snapshot::read(&db, 1).await.unwrap().unwrap();
        assert_eq!(
            apply(&db, 1, &before, &fresh(), TitlePreference::Chinese)
                .await
                .unwrap()
                .0,
            ResultKind::Updated
        );
        let row = sqlx::query("SELECT * FROM games WHERE id=1")
            .fetch_one(&db)
            .await
            .unwrap();
        for (column, value) in [
            ("title", "克兰纳德"),
            ("description", "中文简介"),
            ("bangumi_id", "12"),
            ("vndb_id", "v4"),
            ("status", "playing"),
            ("notes", "private"),
            ("cover_path", "custom.png"),
            ("install_path", "game"),
            ("exe_path", "game.exe"),
            ("save_path", "saves"),
        ] {
            assert_eq!(row.get::<String, _>(column), value, "{column}");
        }
        assert_eq!(row.get::<i64, _>("play_time_seconds"), 4321);
        assert_eq!(row.get::<i64, _>("favorite"), 1);
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM game_tags WHERE game_id=1")
                .fetch_one(&db)
                .await
                .unwrap(),
            2
        );
    }
    #[tokio::test]
    async fn concurrent_catalogue_edit_is_not_overwritten() {
        let db = database().await;
        let before = Snapshot::read(&db, 1).await.unwrap().unwrap();
        sqlx::query("UPDATE games SET description='刚刚编辑的简介' WHERE id=1")
            .execute(&db)
            .await
            .unwrap();
        assert_eq!(
            apply(&db, 1, &before, &fresh(), TitlePreference::Chinese)
                .await
                .unwrap()
                .0,
            ResultKind::Skipped
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT title FROM games WHERE id=1")
                .fetch_one(&db)
                .await
                .unwrap(),
            "Old English"
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM game_tags")
                .fetch_one(&db)
                .await
                .unwrap(),
            1
        );
    }
    #[tokio::test]
    async fn concurrent_status_and_notes_are_preserved_without_blocking_catalogue_refresh() {
        let db = database().await;
        let before = Snapshot::read(&db, 1).await.unwrap().unwrap();
        sqlx::query("UPDATE games SET status='completed',notes='新备注' WHERE id=1")
            .execute(&db)
            .await
            .unwrap();
        assert_eq!(
            apply(&db, 1, &before, &fresh(), TitlePreference::Chinese)
                .await
                .unwrap()
                .0,
            ResultKind::Updated
        );
        assert_eq!(
            sqlx::query_as::<_, (String, String)>("SELECT status,notes FROM games WHERE id=1")
                .fetch_one(&db)
                .await
                .unwrap(),
            ("completed".into(), "新备注".into())
        );
    }
    #[tokio::test]
    async fn existing_binding_and_chinese_text_never_downgrade_or_clear() {
        let db = database().await;
        sqlx::query("UPDATE games SET title='中文名',description='中文简介',bangumi_id='77',rating=9 WHERE id=1").execute(&db).await.unwrap();
        let before = Snapshot::read(&db, 1).await.unwrap().unwrap();
        let detail = MetadataDetail {
            title: "English".into(),
            description: Some("English introduction".into()),
            description_lang: Some("en".into()),
            bangumi_id: Some("99".into()),
            vndb_id: Some("v999".into()),
            ..Default::default()
        };
        assert_eq!(
            apply(&db, 1, &before, &detail, TitlePreference::Chinese)
                .await
                .unwrap()
                .0,
            ResultKind::Skipped
        );
        assert_eq!(Snapshot::read(&db, 1).await.unwrap().unwrap(), before);
    }
    #[tokio::test]
    async fn field_and_tag_changes_rollback_together_on_error() {
        let db = database().await;
        sqlx::raw_sql("CREATE TRIGGER reject_new_tag BEFORE INSERT ON tags BEGIN SELECT RAISE(ABORT,'test rejection'); END;").execute(&db).await.unwrap();
        let before = Snapshot::read(&db, 1).await.unwrap().unwrap();
        assert!(
            apply(&db, 1, &before, &fresh(), TitlePreference::Chinese)
                .await
                .is_err()
        );
        assert_eq!(Snapshot::read(&db, 1).await.unwrap().unwrap(), before);
    }
    #[test]
    fn chinese_intro_precedes_default_source_and_default_breaks_language_ties() {
        let mut detail = fresh();
        detail.description_options = vec![
            DescriptionOption {
                source: Some(Provider::Vndb),
                language: Some("en".into()),
                text: "English".into(),
                attribution: None,
            },
            DescriptionOption {
                source: Some(Provider::Bangumi),
                language: Some("zh-Hans".into()),
                text: "中文甲".into(),
                attribution: None,
            },
            DescriptionOption {
                source: Some(Provider::TwoDfan),
                language: Some("zh-Hant".into()),
                text: "中文乙".into(),
                attribution: None,
            },
        ];
        select_description(&mut detail, Provider::Vndb);
        assert_eq!(detail.description.as_deref(), Some("中文甲"));
        select_description(&mut detail, Provider::TwoDfan);
        assert_eq!(detail.description.as_deref(), Some("中文乙"));
    }
    #[test]
    fn conflicts_in_either_existing_binding_block_refresh_identity() {
        let a = fresh();
        let mut b = a.clone();
        b.vndb_id = Some("v99".into());
        assert!(!compatible_ids(&a, &b));
        b.vndb_id = a.vndb_id.clone();
        b.bangumi_id = Some("99".into());
        assert!(!compatible_ids(&a, &b));
    }
}
