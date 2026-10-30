use super::{client::Client, merge, model::*, store};
use crate::commands::error::{CmdError, CmdResult};
use sqlx::SqlitePool;
use std::{collections::HashMap, future::Future};

pub trait Api: Sync {
    fn collections(
        &self,
        user: &str,
    ) -> impl Future<Output = CmdResult<Vec<RemoteCollection>>> + Send;
    fn collection(
        &self,
        user: &str,
        id: i64,
    ) -> impl Future<Output = CmdResult<Option<RemoteCollection>>> + Send;
    fn validate_game(&self, id: i64) -> impl Future<Output = CmdResult<()>> + Send;
    fn write(
        &self,
        id: i64,
        value: &SyncValue,
        create: bool,
        private: bool,
        fields: &[String],
    ) -> impl Future<Output = CmdResult<()>> + Send;
}
impl Api for Client {
    async fn collections(&self, user: &str) -> CmdResult<Vec<RemoteCollection>> {
        Client::collections(self, user).await
    }
    async fn collection(&self, user: &str, id: i64) -> CmdResult<Option<RemoteCollection>> {
        Client::collection(self, user, id).await
    }
    async fn validate_game(&self, id: i64) -> CmdResult<()> {
        Client::validate_game(self, id).await
    }
    async fn write(
        &self,
        id: i64,
        value: &SyncValue,
        create: bool,
        private: bool,
        fields: &[String],
    ) -> CmdResult<()> {
        Client::write(self, id, value, create, private, fields).await
    }
}

fn changed(a: &SyncValue, b: &SyncValue) -> Vec<String> {
    let mut fields = Vec::new();
    if a.collection_type != b.collection_type {
        fields.push("status".into());
    }
    if a.rate != b.rate {
        fields.push("rate".into());
    }
    if a.comment != b.comment {
        fields.push("comment".into());
    }
    fields
}
fn value(remote: Option<&RemoteCollection>) -> CmdResult<SyncValue> {
    if let Some(remote) = remote {
        if remote.subject_type != 4
            || merge::to_local_status(remote.collection_type).is_none()
            || !(0..=10).contains(&remote.rate)
        {
            return Err(CmdError("Bangumi 返回了无效的游戏收藏记录".into()));
        }
        Ok(remote.value())
    } else {
        Ok(SyncValue::default())
    }
}

pub async fn run<C: Api>(
    db: &SqlitePool,
    api: &C,
    account: &Account,
    private_new: bool,
) -> CmdResult<SyncReport> {
    let all = store::rows(db).await?;
    let eligible: Vec<_> = all
        .iter()
        .filter(|r| r.enabled != 0 && r.subject_id().is_some())
        .collect();
    let mut report = SyncReport {
        skipped: all.len() - eligible.len(),
        ..Default::default()
    };
    if eligible.is_empty() {
        return Ok(report);
    }
    // A failed page never becomes an empty remote library.
    let remote = api.collections(&account.username).await?;
    let mut indexed = HashMap::new();
    for entry in &remote {
        if indexed.insert(entry.subject_id, entry).is_some() {
            return Err(CmdError(
                "Bangumi 收藏列表包含重复编号，已停止本次同步".into(),
            ));
        }
    }
    let mut counts = HashMap::<i64, usize>::new();
    for row in &eligible {
        *counts.entry(row.subject_id().unwrap()).or_default() += 1;
    }
    for old in eligible {
        let row = match store::row(db, old.game_id).await {
            Ok(row) => row,
            Err(_) => {
                report.skipped += 1;
                continue;
            }
        };
        let Some(subject) = row.subject_id().filter(|_| row.enabled != 0) else {
            report.skipped += 1;
            continue;
        };
        if counts.get(&subject).copied().unwrap_or(0) > 1 {
            store::error(
                db,
                row.game_id,
                "同一 Bangumi 条目绑定了多部本地作品，请只保留一部参与同步",
            )
            .await?;
            report.errors += 1;
            continue;
        }
        match sync_one(
            db,
            api,
            account,
            private_new,
            &row,
            indexed.get(&subject).copied(),
        )
        .await
        {
            Ok(Outcome::Skipped) => report.skipped += 1,
            Ok(Outcome::Conflict) => report.conflicts += 1,
            Ok(Outcome::Synced {
                uploaded,
                downloaded,
            }) => {
                report.synced += 1;
                report.uploaded += usize::from(uploaded);
                report.downloaded += usize::from(downloaded);
            }
            Err(error) => {
                store::error(db, row.game_id, &error.0).await?;
                report.errors += 1;
                if error.0.starts_with("BGM_HTTP_401")
                    || error.0.starts_with("BGM_HTTP_403")
                    || error.0.starts_with("BGM_HTTP_429")
                {
                    return Err(error);
                }
            }
        }
    }
    Ok(report)
}
enum Outcome {
    Skipped,
    Conflict,
    Synced { uploaded: bool, downloaded: bool },
}

async fn sync_one<C: Api>(
    db: &SqlitePool,
    api: &C,
    account: &Account,
    private_new: bool,
    row: &store::Row,
    remote: Option<&RemoteCollection>,
) -> CmdResult<Outcome> {
    let subject = row
        .subject_id()
        .ok_or_else(|| CmdError("请先绑定 Bangumi ID".into()))?;
    let local = row.local();
    let remote = value(remote)?;
    let base = row.baseline(account.id, subject)?;
    if base.as_ref() == Some(&local)
        && local == remote
        && row.conflict_json.is_none()
        && row.error.is_none()
    {
        return Ok(Outcome::Skipped);
    }
    // A new account invalidates the baseline, not the user's local opinions.
    let merged = merge::merge_values(
        base.as_ref(),
        &local,
        &remote,
        row.personal_rate.is_some(),
        row.personal_comment.is_some(),
    );
    let stored_conflict = row.conflict()?;
    let resolution = row.resolution.as_deref().filter(|_| {
        stored_conflict
            .as_ref()
            .is_some_and(|c| c.local == local && c.remote == remote)
    });
    let chosen = match resolution {
        Some(side @ ("local" | "remote")) => {
            let selected = if side == "local" { &local } else { &remote };
            let fields = &stored_conflict.as_ref().unwrap().fields;
            if fields
                .iter()
                .any(|f| f == "collection" || f == "remote_changed")
            {
                selected.clone()
            } else {
                let mut resolved = merged.value.clone();
                for field in fields {
                    match field.as_str() {
                        "status" => resolved.collection_type = selected.collection_type,
                        "rate" => resolved.rate = selected.rate,
                        "comment" => resolved.comment = selected.comment.clone(),
                        _ => {}
                    }
                }
                resolved
            }
        }
        _ if !merged.conflicts.is_empty() => {
            let reason = if merged.conflicts.iter().any(|f| f == "collection") {
                "Bangumi 收藏已移除；采用远端会保留删除并暂停本款同步，保留本地会重新创建收藏"
            } else if local.collection_type.is_none() && base.is_some() {
                "本地状态无法对应 Bangumi 收藏，请调整状态、采用远端或暂停此游戏同步"
            } else {
                "本地和 Bangumi 有不同内容，请选择保留哪一边"
            };
            store::conflict(
                db,
                row.game_id,
                &SyncConflict {
                    local,
                    remote,
                    base,
                    fields: merged.conflicts,
                    reason: reason.into(),
                },
            )
            .await?;
            return Ok(Outcome::Conflict);
        }
        _ => merged.value,
    };
    let upload_fields = changed(&remote, &chosen);
    if !upload_fields.is_empty() && chosen.collection_type.is_none() {
        return Err(CmdError(
            "本地状态无法对应 Bangumi 收藏，请调整状态，或采用远端/暂停同步".into(),
        ));
    }
    if chosen.collection_type.is_none() && remote.collection_type.is_none() && base.is_none() {
        return Ok(Outcome::Skipped);
    }
    let uploaded = !upload_fields.is_empty();
    if uploaded {
        let current = store::row(db, row.game_id).await?;
        if current.enabled == 0 {
            return Ok(Outcome::Skipped);
        }
        if current.revision != row.revision
            || current.status != row.status
            || current.bangumi_id != row.bangumi_id
            || current.enabled == 0
        {
            return Err(CmdError("本地在同步期间已修改，将在下次同步时重试".into()));
        }
        let latest = value(api.collection(&account.username, subject).await?.as_ref())?;
        if latest != remote {
            store::conflict(
                db,
                row.game_id,
                &SyncConflict {
                    local,
                    remote: latest,
                    base,
                    fields: vec!["remote_changed".into()],
                    reason: "Bangumi 在同步期间发生变化，请重新选择".into(),
                },
            )
            .await?;
            return Ok(Outcome::Conflict);
        }
        if remote.collection_type.is_none() {
            api.validate_game(subject).await?;
        }
        // Pausing is an immediate enabled-only operation and may finish during
        // either awaited lookup above. Check again at the actual write boundary.
        let current = store::row(db, row.game_id).await?;
        if current.enabled == 0 {
            return Ok(Outcome::Skipped);
        }
        if current.revision != row.revision
            || current.status != row.status
            || current.bangumi_id != row.bangumi_id
        {
            return Err(CmdError(
                "本地在远端校验期间已修改，未执行上传，稍后重试".into(),
            ));
        }
        api.write(
            subject,
            &chosen,
            remote.collection_type.is_none(),
            private_new,
            &upload_fields,
        )
        .await?;
        let confirmed = value(api.collection(&account.username, subject).await?.as_ref())?;
        if confirmed != chosen {
            return Err(CmdError(
                "Bangumi 写入后的内容已变化，未推进同步基线，下次将重新比较".into(),
            ));
        }
    }
    let downloaded =
        local != chosen || row.personal_rate.is_none() || row.personal_comment.is_none();
    store::apply(db, row, account.id, subject, &chosen).await?;
    Ok(Outcome::Synced {
        uploaded,
        downloaded,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    struct Fake {
        remote: Mutex<Option<SyncValue>>,
        writes: Mutex<Vec<Vec<String>>>,
        fail: bool,
    }
    impl Fake {
        fn collection_value(&self) -> Option<RemoteCollection> {
            self.remote
                .lock()
                .unwrap()
                .clone()
                .map(|v| RemoteCollection {
                    subject_id: 13,
                    subject_type: 4,
                    collection_type: v.collection_type.unwrap(),
                    rate: v.rate,
                    comment: v.comment,
                    private: true,
                })
        }
    }
    impl Api for Fake {
        async fn collections(&self, _: &str) -> CmdResult<Vec<RemoteCollection>> {
            Ok(self.collection_value().into_iter().collect())
        }
        async fn collection(&self, _: &str, _: i64) -> CmdResult<Option<RemoteCollection>> {
            Ok(self.collection_value())
        }
        async fn validate_game(&self, _: i64) -> CmdResult<()> {
            Ok(())
        }
        async fn write(
            &self,
            _: i64,
            v: &SyncValue,
            _: bool,
            _: bool,
            f: &[String],
        ) -> CmdResult<()> {
            self.writes.lock().unwrap().push(f.to_vec());
            if self.fail {
                return Err(CmdError("offline".into()));
            }
            *self.remote.lock().unwrap() = Some(v.clone());
            Ok(())
        }
    }
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
        sqlx::query("INSERT INTO games(id,title,status,install_path,created_at,updated_at,bangumi_id,rating,notes) VALUES(1,'Test','playing','test','now','now','13',10,'private')").execute(&db).await.unwrap();
        db
    }
    fn account() -> Account {
        Account {
            id: 42,
            username: "tester".into(),
            nickname: "Tester".into(),
        }
    }
    #[tokio::test]
    async fn unplayed_uploads_as_wishlist_and_keeps_local_status_without_repeat() {
        let db = fixture().await;
        sqlx::query("UPDATE games SET status='unplayed' WHERE id=1").execute(&db).await.unwrap();
        let api = Fake { remote: Mutex::new(None), writes: Mutex::new(vec![]), fail: false };
        assert_eq!(run(&db, &api, &account(), true).await.unwrap().uploaded, 1);
        assert_eq!(api.remote.lock().unwrap().as_ref().unwrap().collection_type, Some(1));
        assert_eq!(store::row(&db, 1).await.unwrap().status, "unplayed");
        let second = run(&db, &api, &account(), true).await.unwrap();
        assert_eq!(second.uploaded, 0);
        assert_eq!(second.skipped, 1);
        assert_eq!(api.writes.lock().unwrap().len(), 1);
    }
    #[tokio::test]
    async fn accepting_remote_removal_pauses_so_unplayed_does_not_recreate_wishlist() {
        let db = fixture().await;
        let api = Fake { remote: Mutex::new(Some(SyncValue { collection_type: Some(3), ..Default::default() })),
            writes: Mutex::new(vec![]), fail: false };
        run(&db, &api, &account(), true).await.unwrap();
        *api.remote.lock().unwrap() = None;
        assert_eq!(run(&db, &api, &account(), true).await.unwrap().conflicts, 1);
        sqlx::query("UPDATE bangumi_game_sync SET resolution='remote' WHERE game_id=1").execute(&db).await.unwrap();
        run(&db, &api, &account(), true).await.unwrap();
        let row = store::row(&db, 1).await.unwrap();
        assert_eq!(row.status, "unplayed");
        assert_eq!(row.enabled, 0);
        assert_eq!(run(&db, &api, &account(), true).await.unwrap().skipped, 1);
        assert!(api.writes.lock().unwrap().is_empty());
    }
    #[tokio::test]
    async fn paused_or_unbound_unplayed_games_are_not_uploaded() {
        for paused in [true, false] {
            let db = fixture().await;
            sqlx::query("UPDATE games SET status='unplayed' WHERE id=1").execute(&db).await.unwrap();
            if paused { store::pause(&db, 1).await.unwrap(); }
            else { sqlx::query("UPDATE games SET bangumi_id=NULL WHERE id=1").execute(&db).await.unwrap(); }
            let api = Fake { remote: Mutex::new(None), writes: Mutex::new(vec![]), fail: false };
            assert_eq!(run(&db, &api, &account(), true).await.unwrap().skipped, 1);
            assert!(api.writes.lock().unwrap().is_empty());
        }
    }
    #[tokio::test]
    async fn unplayed_does_not_overwrite_existing_remote_progress_on_first_sync() {
        let db = fixture().await;
        sqlx::query("UPDATE games SET status='unplayed' WHERE id=1").execute(&db).await.unwrap();
        let api = Fake { remote: Mutex::new(Some(SyncValue { collection_type: Some(2), rate: 8,
            comment: "remote review".into() })), writes: Mutex::new(vec![]), fail: false };
        let report = run(&db, &api, &account(), true).await.unwrap();
        assert_eq!(report.conflicts, 1);
        assert_eq!(store::row(&db, 1).await.unwrap().status, "unplayed");
        assert_eq!(api.remote.lock().unwrap().as_ref().unwrap().collection_type, Some(2));
        assert!(api.writes.lock().unwrap().is_empty());
    }
    #[tokio::test]
    async fn pulls_then_pushes_only_changed_fields_and_does_not_repeat() {
        let db = fixture().await;
        let api = Fake {
            remote: Mutex::new(Some(SyncValue {
                collection_type: Some(3),
                rate: 8,
                comment: "remote".into(),
            })),
            writes: Mutex::new(vec![]),
            fail: false,
        };
        let report = run(&db, &api, &account(), true).await.unwrap();
        assert_eq!(report.downloaded, 1);
        assert!(api.writes.lock().unwrap().is_empty());
        assert_eq!(store::row(&db, 1).await.unwrap().status, "playing");
        sqlx::query("UPDATE games SET status='completed' WHERE id=1")
            .execute(&db)
            .await
            .unwrap();
        assert_eq!(run(&db, &api, &account(), true).await.unwrap().uploaded, 1);
        assert_eq!(
            *api.writes.lock().unwrap(),
            vec![vec!["status".to_string()]]
        );
        assert_eq!(run(&db, &api, &account(), true).await.unwrap().uploaded, 0);
    }
    #[tokio::test]
    async fn failure_keeps_pending_local_change_and_remote_deletion_does_not_recreate() {
        let db = fixture().await;
        let api = Fake {
            remote: Mutex::new(Some(SyncValue {
                collection_type: Some(3),
                rate: 0,
                comment: "".into(),
            })),
            writes: Mutex::new(vec![]),
            fail: true,
        };
        run(&db, &api, &account(), true).await.unwrap();
        sqlx::query("UPDATE games SET status='completed' WHERE id=1")
            .execute(&db)
            .await
            .unwrap();
        assert_eq!(run(&db, &api, &account(), true).await.unwrap().errors, 1);
        assert_eq!(
            store::row(&db, 1)
                .await
                .unwrap()
                .baseline(42, 13)
                .unwrap()
                .unwrap()
                .collection_type,
            Some(3)
        );
        *api.remote.lock().unwrap() = None;
        assert_eq!(run(&db, &api, &account(), true).await.unwrap().conflicts, 1);
        assert_eq!(api.writes.lock().unwrap().len(), 1);
    }
    #[tokio::test]
    async fn changing_account_keeps_local_opinions_and_requires_first_sync_conflict() {
        let db = fixture().await;
        let api = Fake {
            remote: Mutex::new(Some(SyncValue {
                collection_type: Some(3),
                rate: 9,
                comment: "mine".into(),
            })),
            writes: Mutex::new(vec![]),
            fail: false,
        };
        run(&db, &api, &account(), true).await.unwrap();
        *api.remote.lock().unwrap() = Some(SyncValue {
            collection_type: Some(3),
            rate: 3,
            comment: "theirs".into(),
        });
        let mut second = account();
        second.id = 43;
        assert_eq!(run(&db, &api, &second, true).await.unwrap().conflicts, 1);
        let row = store::row(&db, 1).await.unwrap();
        assert_eq!(row.personal_rate, Some(9));
        assert_eq!(row.personal_comment.as_deref(), Some("mine"));
        assert!(api.writes.lock().unwrap().is_empty());
    }
    #[tokio::test]
    async fn resolving_status_only_keeps_nonconflicting_remote_personal_fields() {
        let db = fixture().await;
        sqlx::query("UPDATE games SET status='playing'")
            .execute(&db)
            .await
            .unwrap();
        let api = Fake {
            remote: Mutex::new(Some(SyncValue {
                collection_type: Some(2),
                rate: 8,
                comment: "remote".into(),
            })),
            writes: Mutex::new(vec![]),
            fail: false,
        };
        assert_eq!(run(&db, &api, &account(), true).await.unwrap().conflicts, 1);
        sqlx::query("UPDATE bangumi_game_sync SET resolution='local' WHERE game_id=1")
            .execute(&db)
            .await
            .unwrap();
        assert_eq!(run(&db, &api, &account(), true).await.unwrap().uploaded, 1);
        let row = store::row(&db, 1).await.unwrap();
        assert_eq!(row.status, "playing");
        assert_eq!(row.personal_rate, Some(8));
        assert_eq!(row.personal_comment.as_deref(), Some("remote"));
        assert_eq!(
            *api.writes.lock().unwrap(),
            vec![vec!["status".to_string()]]
        );
    }
    #[tokio::test]
    async fn pause_during_remote_check_prevents_the_following_upload() {
        struct Pausing {
            inner: Fake,
            db: SqlitePool,
        }
        impl Api for Pausing {
            async fn collections(&self, u: &str) -> CmdResult<Vec<RemoteCollection>> {
                self.inner.collections(u).await
            }
            async fn collection(&self, u: &str, id: i64) -> CmdResult<Option<RemoteCollection>> {
                store::pause(&self.db, 1).await?;
                self.inner.collection(u, id).await
            }
            async fn validate_game(&self, id: i64) -> CmdResult<()> {
                self.inner.validate_game(id).await
            }
            async fn write(
                &self,
                id: i64,
                v: &SyncValue,
                c: bool,
                p: bool,
                f: &[String],
            ) -> CmdResult<()> {
                self.inner.write(id, v, c, p, f).await
            }
        }
        let db = fixture().await;
        let inner = Fake {
            remote: Mutex::new(Some(SyncValue {
                collection_type: Some(3),
                rate: 0,
                comment: "".into(),
            })),
            writes: Mutex::new(vec![]),
            fail: false,
        };
        run(&db, &inner, &account(), true).await.unwrap();
        sqlx::query("UPDATE games SET status='completed' WHERE id=1")
            .execute(&db)
            .await
            .unwrap();
        let api = Pausing {
            inner,
            db: db.clone(),
        };
        run(&db, &api, &account(), true).await.unwrap();
        assert!(api.inner.writes.lock().unwrap().is_empty());
        assert!(!store::row(&db, 1).await.unwrap().item().unwrap().enabled);
    }
}
