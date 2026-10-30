use super::{merge, model::*};
use crate::commands::{
    error::{CmdError, CmdResult},
    util::now_iso8601,
};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

pub const CONFIG_KEY: &str = "bangumi_sync_config";
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Config {
    pub account: Option<Account>,
    pub enabled: bool,
    pub private_new: bool,
    pub last_run_at: Option<String>,
    pub last_error: Option<String>,
    pub last_report: Option<SyncReport>,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            account: None,
            enabled: false,
            private_new: true,
            last_run_at: None,
            last_error: None,
            last_report: None,
        }
    }
}

pub async fn config(db: &SqlitePool) -> CmdResult<Config> {
    let value = crate::commands::settings::settings_get_impl(db, CONFIG_KEY).await?;
    value
        .map(|value| {
            serde_json::from_str(&value)
                .map_err(|_| CmdError("Bangumi 同步设置损坏，请重新连接账号".into()))
        })
        .unwrap_or_else(|| Ok(Config::default()))
}
pub async fn save_config(db: &SqlitePool, value: &Config) -> CmdResult<()> {
    sqlx::query("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .bind(CONFIG_KEY).bind(serde_json::to_string(value).map_err(|_|CmdError("无法保存同步设置".into()))?).execute(db).await?;
    Ok(())
}

#[derive(Clone, Debug, sqlx::FromRow)]
pub struct Row {
    pub game_id: i64,
    pub title: String,
    pub status: String,
    pub bangumi_id: Option<String>,
    pub enabled: i64,
    pub personal_rate: Option<i64>,
    pub personal_comment: Option<String>,
    pub account_id: Option<i64>,
    pub baseline_subject_id: Option<i64>,
    pub baseline_json: Option<String>,
    pub conflict_json: Option<String>,
    pub resolution: Option<String>,
    pub last_synced_at: Option<String>,
    pub error: Option<String>,
    pub revision: i64,
}
const ROWS: &str = "SELECT g.id game_id,g.title,g.status,g.bangumi_id,COALESCE(s.enabled,1) enabled,s.personal_rate,s.personal_comment,s.account_id,s.baseline_subject_id,s.baseline_json,s.conflict_json,s.resolution,s.last_synced_at,s.error,COALESCE(s.revision,0) revision FROM games g LEFT JOIN bangumi_game_sync s ON s.game_id=g.id";
pub async fn rows(db: &SqlitePool) -> CmdResult<Vec<Row>> {
    Ok(sqlx::query_as(&format!("{ROWS} ORDER BY g.id"))
        .fetch_all(db)
        .await?)
}
pub async fn row(db: &SqlitePool, id: i64) -> CmdResult<Row> {
    sqlx::query_as(&format!("{ROWS} WHERE g.id=?"))
        .bind(id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| CmdError("游戏不存在".into()))
}
pub fn parse_subject(value: Option<&str>) -> Option<i64> {
    value
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|s| s.parse().ok())
        .filter(|id| *id > 0)
}
impl Row {
    pub fn subject_id(&self) -> Option<i64> {
        parse_subject(self.bangumi_id.as_deref())
    }
    pub fn local(&self) -> SyncValue {
        SyncValue {
            collection_type: merge::to_remote_status(&self.status),
            rate: self.personal_rate.unwrap_or(0),
            comment: self.personal_comment.clone().unwrap_or_default(),
        }
    }
    pub fn baseline(&self, account: i64, subject: i64) -> CmdResult<Option<SyncValue>> {
        if self.account_id != Some(account) || self.baseline_subject_id != Some(subject) {
            return Ok(None);
        }
        self.baseline_json
            .as_ref()
            .map(|s| {
                serde_json::from_str(s)
                    .map_err(|_| CmdError("同步基线损坏，请重新绑定该作品".into()))
            })
            .transpose()
    }
    pub fn conflict(&self) -> CmdResult<Option<SyncConflict>> {
        self.conflict_json
            .as_ref()
            .map(|s| serde_json::from_str(s).map_err(|_| CmdError("同步冲突记录损坏".into())))
            .transpose()
    }
    pub fn item(&self) -> CmdResult<SyncItem> {
        Ok(SyncItem {
            revision: self.revision,
            game_id: self.game_id,
            title: self.title.clone(),
            subject_id: self.subject_id(),
            enabled: self.enabled != 0,
            personal_rate: self.personal_rate,
            personal_comment: self.personal_comment.clone(),
            last_synced_at: self.last_synced_at.clone(),
            error: self.error.clone(),
            conflict: self.conflict()?,
        })
    }
}
pub async fn ensure(db: &SqlitePool, id: i64) -> CmdResult<()> {
    sqlx::query("INSERT OR IGNORE INTO bangumi_game_sync(game_id) VALUES(?)")
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}
pub async fn error(db: &SqlitePool, id: i64, message: &str) -> CmdResult<()> {
    ensure(db, id).await?;
    sqlx::query("UPDATE bangumi_game_sync SET error=? WHERE game_id=?")
        .bind(message)
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}
pub async fn conflict(db: &SqlitePool, id: i64, value: &SyncConflict) -> CmdResult<()> {
    ensure(db, id).await?;
    sqlx::query(
        "UPDATE bangumi_game_sync SET conflict_json=?,resolution=NULL,error=NULL WHERE game_id=?",
    )
    .bind(serde_json::to_string(value).map_err(|_| CmdError("无法保存冲突".into()))?)
    .bind(id)
    .execute(db)
    .await?;
    Ok(())
}

/// Compare values inside the write transaction. Never discard an edit made while
/// remote requests were in flight, even after a remote write has succeeded.
pub async fn apply(
    db: &SqlitePool,
    expected: &Row,
    account: i64,
    subject: i64,
    value: &SyncValue,
) -> CmdResult<()> {
    let mut tx = db.begin().await?;
    let current: Row = sqlx::query_as(&format!("{ROWS} WHERE g.id=?"))
        .bind(expected.game_id)
        .fetch_one(&mut *tx)
        .await?;
    if current.revision != expected.revision
        || current.status != expected.status
        || current.bangumi_id != expected.bangumi_id
        || current.personal_rate != expected.personal_rate
        || current.personal_comment != expected.personal_comment
        || current.enabled == 0
    {
        return Err(CmdError(
            "本地资料在同步期间已修改，已保留编辑，稍后重试".into(),
        ));
    }
    let status = match value.collection_type {
        // Uploading an unstarted game as "wish" must not rewrite the user's
        // local classification. Other remote status changes still download.
        Some(1) if current.status == "unplayed" => "unplayed",
        Some(value) => {
            merge::to_local_status(value).ok_or_else(|| CmdError("Bangumi 收藏状态无效".into()))?
        }
        None => "unplayed",
    };
    let now = now_iso8601();
    sqlx::query("UPDATE games SET status=?,updated_at=CASE WHEN status<>? THEN ? ELSE updated_at END WHERE id=?")
        .bind(status).bind(status).bind(&now).bind(expected.game_id).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO bangumi_game_sync(game_id,personal_rate,personal_comment,account_id,baseline_subject_id,baseline_json,last_synced_at,revision) VALUES(?,?,?,?,?,?,?,1) ON CONFLICT(game_id) DO UPDATE SET personal_rate=excluded.personal_rate,personal_comment=excluded.personal_comment,account_id=excluded.account_id,baseline_subject_id=excluded.baseline_subject_id,baseline_json=excluded.baseline_json,last_synced_at=excluded.last_synced_at,conflict_json=NULL,resolution=NULL,error=NULL,revision=bangumi_game_sync.revision+1")
        .bind(expected.game_id).bind(value.rate).bind(&value.comment).bind(account).bind(subject)
        .bind(serde_json::to_string(value).map_err(|_|CmdError("无法保存同步基线".into()))?).bind(now).execute(&mut *tx).await?;
    // Accepting a remote removal is explicit. Pause this binding so the new
    // unplayed -> wish mapping cannot recreate that collection on the next run.
    if value.collection_type.is_none() {
        sqlx::query("UPDATE bangumi_game_sync SET enabled=0 WHERE game_id=?")
            .bind(expected.game_id).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}

pub async fn save_profile(
    db: &SqlitePool,
    id: i64,
    subject: Option<i64>,
    enabled: bool,
    rate: Option<i64>,
    comment: Option<String>,
    expected_revision: Option<i64>,
) -> CmdResult<SyncItem> {
    let mut tx = db.begin().await?;
    let existing: Row = sqlx::query_as(&format!("{ROWS} WHERE g.id=?"))
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| CmdError("游戏不存在".into()))?;
    if expected_revision.is_some_and(|revision| revision != existing.revision) {
        return Err(CmdError(
            "个人记录刚被同步更新，请重新读取并确认后再次保存".into(),
        ));
    }
    if rate.is_some_and(|r| !(0..=10).contains(&r)) {
        return Err(CmdError("我的评分必须为 0 到 10 的整数".into()));
    }
    if comment != existing.personal_comment
        && comment.as_ref().is_some_and(|s| s.chars().count() > 1000)
    {
        return Err(CmdError("Bangumi 短评最多填写 1000 字".into()));
    }
    let changed = existing.subject_id() != subject;
    sqlx::query("UPDATE games SET bangumi_id=?,updated_at=? WHERE id=?")
        .bind(subject.map(|s| s.to_string()))
        .bind(now_iso8601())
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO bangumi_game_sync(game_id,enabled,personal_rate,personal_comment,revision) VALUES(?,?,?,?,1) ON CONFLICT(game_id) DO UPDATE SET enabled=excluded.enabled,personal_rate=excluded.personal_rate,personal_comment=excluded.personal_comment,revision=bangumi_game_sync.revision+1")
        .bind(id).bind(if enabled{1}else{0}).bind(rate).bind(comment).execute(&mut *tx).await?;
    if changed {
        sqlx::query("UPDATE bangumi_game_sync SET account_id=NULL,baseline_subject_id=NULL,baseline_json=NULL,conflict_json=NULL,resolution=NULL,last_synced_at=NULL,error=NULL WHERE game_id=?").bind(id).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    row(db, id).await?.item()
}

pub async fn pause(db: &SqlitePool, id: i64) -> CmdResult<SyncItem> {
    row(db, id).await?;
    ensure(db, id).await?;
    sqlx::query("UPDATE bangumi_game_sync SET enabled=0,revision=revision+1 WHERE game_id=?")
        .bind(id)
        .execute(db)
        .await?;
    row(db, id).await?.item()
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
        sqlx::raw_sql(include_str!("../../migrations/0001_init.sql"))
            .execute(&db)
            .await
            .unwrap();
        sqlx::raw_sql(include_str!("../../migrations/0004_bangumi_sync.sql"))
            .execute(&db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO games(id,title,status,install_path,created_at,updated_at,rating,notes,bangumi_id) VALUES(1,'Test','playing','test','now','now',9,'private note','13')").execute(&db).await.unwrap();
        db
    }
    #[tokio::test]
    async fn sync_personal_fields_do_not_touch_public_rating_private_notes_or_paths() {
        let db = fixture().await;
        let original = row(&db, 1).await.unwrap();
        apply(
            &db,
            &original,
            42,
            13,
            &SyncValue {
                collection_type: Some(2),
                rate: 7,
                comment: "public review".into(),
            },
        )
        .await
        .unwrap();
        let user: (i64, String, String, String) =
            sqlx::query_as("SELECT rating,notes,install_path,status FROM games WHERE id=1")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(
            user,
            (9, "private note".into(), "test".into(), "completed".into())
        );
        let item = row(&db, 1).await.unwrap().item().unwrap();
        assert_eq!(item.personal_rate, Some(7));
    }
    #[tokio::test]
    async fn edits_during_request_are_kept_and_rebinding_discards_old_baseline() {
        let db = fixture().await;
        let original = row(&db, 1).await.unwrap();
        save_profile(
            &db,
            1,
            Some(13),
            true,
            Some(10),
            Some("new local".into()),
            None,
        )
        .await
        .unwrap();
        assert!(
            apply(
                &db,
                &original,
                42,
                13,
                &SyncValue {
                    collection_type: Some(2),
                    rate: 7,
                    comment: "remote".into()
                }
            )
            .await
            .is_err()
        );
        assert_eq!(row(&db, 1).await.unwrap().personal_rate, Some(10));
        let current = row(&db, 1).await.unwrap();
        apply(&db, &current, 42, 13, &current.local())
            .await
            .unwrap();
        assert!(
            row(&db, 1)
                .await
                .unwrap()
                .baseline(42, 13)
                .unwrap()
                .is_some()
        );
        save_profile(&db, 1, Some(14), true, Some(10), None, None)
            .await
            .unwrap();
        assert!(
            row(&db, 1)
                .await
                .unwrap()
                .baseline(42, 14)
                .unwrap()
                .is_none()
        );
    }
    #[tokio::test]
    async fn stale_profile_save_is_rejected_and_pause_preserves_new_downloads() {
        let db = fixture().await;
        let before = row(&db, 1).await.unwrap();
        apply(
            &db,
            &before,
            42,
            13,
            &SyncValue {
                collection_type: Some(2),
                rate: 9,
                comment: "new download".into(),
            },
        )
        .await
        .unwrap();
        assert!(
            save_profile(
                &db,
                1,
                Some(13),
                false,
                Some(0),
                Some("old".into()),
                Some(before.revision)
            )
            .await
            .is_err()
        );
        let paused = pause(&db, 1).await.unwrap();
        assert!(!paused.enabled);
        assert_eq!(paused.personal_rate, Some(9));
        assert_eq!(paused.personal_comment.as_deref(), Some("new download"));
    }
}
