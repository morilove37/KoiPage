use super::model::*;
use crate::commands::{
    error::{CmdError, CmdResult},
    util::now_iso8601,
};
use sqlx::{Row, SqlitePool};
use std::collections::BTreeMap;

// Use the current game metadata, so changing a source ID never exposes stale links.
const ACTIVE_LINKS: &str = "FROM birthday_game_characters l JOIN birthday_characters c ON c.id=l.character_id JOIN games g ON g.id=l.game_id WHERE l.spoiler=0 AND l.role IN ('main','primary') AND ((c.source='vndb' AND ('v'||ltrim(trim(g.vndb_id),'vV'))=l.external_game_id) OR (c.source='bangumi' AND NULLIF(trim(g.vndb_id),'') IS NULL AND trim(g.bangumi_id)=l.external_game_id))";

pub async fn list_characters(db: &SqlitePool) -> CmdResult<Vec<Character>> {
    let rows=sqlx::query(&format!("SELECT c.*,g.id AS game_id,g.title AS game_title,g.favorite AS game_favorite,g.status AS game_status {ACTIVE_LINKS} ORDER BY c.id,g.id")).fetch_all(db).await?;
    let mut chars: BTreeMap<String, Character> = BTreeMap::new();
    for row in rows {
        let id: String = row.get("id");
        let c = chars.entry(id.clone()).or_insert_with(|| {
            let override_date: bool = row.get("override_date");
            let override_name: Option<String> = row.get("override_name");
            let override_avatar: Option<String> = row.get("override_avatar");
            Character {
                id,
                source: row.get("source"),
                external_id: row.get("external_id"),
                name: override_name.clone().unwrap_or_else(|| row.get("name")),
                original_name: row.get("original_name"),
                birthday_month: row.get(if override_date {
                    "override_month"
                } else {
                    "birthday_month"
                }),
                birthday_day: row.get(if override_date {
                    "override_day"
                } else {
                    "birthday_day"
                }),
                birthday_raw: row.get("birthday_raw"),
                avatar_path: override_avatar.clone().or_else(|| row.get("avatar_path")),
                hidden: row.get("hidden"),
                customized: override_date || override_name.is_some() || override_avatar.is_some(),
                games: vec![],
            }
        });
        c.games.push(BirthdayGame {
            id: row.get("game_id"),
            title: row.get("game_title"),
            favorite: row.get("game_favorite"),
            status: row.get("game_status"),
        });
    }
    Ok(chars.into_values().collect())
}

pub async fn list_sync(db: &SqlitePool) -> CmdResult<Vec<SyncState>> {
    let rows=sqlx::query("SELECT g.id,g.title,g.vndb_id,g.bangumi_id,s.source,s.external_id,s.status,s.synced_at,s.error FROM games g LEFT JOIN birthday_sync s ON s.game_id=g.id ORDER BY g.id").fetch_all(db).await?;
    Ok(rows
        .into_iter()
        .map(|r| {
            let v: Option<String> = r.get("vndb_id");
            let b: Option<String> = r.get("bangumi_id");
            let selected = source_for(v.as_deref(), b.as_deref());
            let previous: Option<String> = r.get("source");
            let external: Option<String> = r.get("external_id");
            let same = selected.as_ref().is_some_and(|(s, id)| {
                Some(s) == previous.as_ref() && Some(id) == external.as_ref()
            });
            SyncState {
                game_id: r.get("id"),
                title: r.get("title"),
                source: selected.as_ref().map(|(s, _)| s.clone()),
                external_id: selected.as_ref().map(|(_, id)| id.clone()),
                status: if same {
                    r.get("status")
                } else if selected.is_some() {
                    "pending".into()
                } else {
                    "unmatched".into()
                },
                synced_at: if same { r.get("synced_at") } else { None },
                error: if same { r.get("error") } else { None },
            }
        })
        .collect())
}

pub async fn sync_work(db: &SqlitePool, force: bool) -> CmdResult<Vec<SyncWork>> {
    let mut out = vec![];
    for s in list_sync(db).await? {
        let (Some(source), Some(id)) = (s.source, s.external_id) else {
            continue;
        };
        let attempt: Option<String> = sqlx::query_scalar(
            "SELECT attempted_at FROM birthday_sync WHERE game_id=? AND source=? AND external_id=?",
        )
        .bind(s.game_id)
        .bind(&source)
        .bind(&id)
        .fetch_optional(db)
        .await?;
        let age = |value: Option<&str>| {
            value
                .and_then(|s| {
                    time::OffsetDateTime::parse(s, &time::format_description::well_known::Rfc3339)
                        .ok()
                })
                .map(|t| (time::OffsetDateTime::now_utc() - t).whole_seconds())
                .unwrap_or(i64::MAX)
        };
        let due = if s.status == "error" {
            age(attempt.as_deref()) >= 3600
        } else {
            age(s.synced_at.as_deref()) >= 30 * 86400
        };
        if force || due {
            out.push(SyncWork {
                game_id: s.game_id,
                title: s.title,
                source,
                external_id: id,
            });
        }
    }
    Ok(out)
}

pub async fn save_work(
    db: &SqlitePool,
    work: &SyncWork,
    characters: &[SourceCharacter],
) -> CmdResult<bool> {
    save_work_cancellable(
        db,
        work,
        characters,
        &std::sync::atomic::AtomicBool::new(false),
    )
    .await
}

pub async fn save_work_cancellable(
    db: &SqlitePool,
    work: &SyncWork,
    characters: &[SourceCharacter],
    cancel: &std::sync::atomic::AtomicBool,
) -> CmdResult<bool> {
    let cancelled = || cancel.load(std::sync::atomic::Ordering::Relaxed);
    if cancelled() {
        return Ok(false);
    }
    let mut tx = db.begin().await?;
    if cancelled() {
        return Ok(false);
    }
    let current: Option<(Option<String>, Option<String>)> =
        sqlx::query_as("SELECT vndb_id,bangumi_id FROM games WHERE id=?")
            .bind(work.game_id)
            .fetch_optional(&mut *tx)
            .await?;
    if !current.is_some_and(|(v, b)| {
        source_for(v.as_deref(), b.as_deref())
            == Some((work.source.clone(), work.external_id.clone()))
    }) {
        return Ok(false);
    }
    sqlx::query("DELETE FROM birthday_game_characters WHERE game_id=?")
        .bind(work.game_id)
        .execute(&mut *tx)
        .await?;
    for c in characters {
        if cancelled() {
            return Ok(false);
        }
        validate_identity(&work.source, &c.external_id)?;
        if !valid_date(c.month, c.day) {
            return Err(CmdError("来源生日无效".into()));
        }
        let id = format!("{}:{}", work.source, c.external_id);
        sqlx::query("INSERT INTO birthday_characters(id,source,external_id,name,original_name,birthday_month,birthday_day,birthday_raw,avatar_path) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,original_name=excluded.original_name,birthday_month=excluded.birthday_month,birthday_day=excluded.birthday_day,birthday_raw=excluded.birthday_raw,avatar_path=COALESCE(excluded.avatar_path,birthday_characters.avatar_path)")
            .bind(&id).bind(&work.source).bind(&c.external_id).bind(&c.name).bind(&c.original_name).bind(c.month).bind(c.day).bind(&c.raw).bind(&c.avatar).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO birthday_game_characters(game_id,character_id,external_game_id,role,spoiler) VALUES(?,?,?,?,?) ON CONFLICT(game_id,character_id) DO UPDATE SET role=excluded.role,spoiler=excluded.spoiler")
            .bind(work.game_id).bind(&id).bind(&work.external_id).bind(&c.role).bind(c.spoiler).execute(&mut *tx).await?;
    }
    let now = now_iso8601();
    sqlx::query("INSERT INTO birthday_sync(game_id,source,external_id,synced_at,attempted_at,status) VALUES(?,?,?,?,?,'success') ON CONFLICT(game_id) DO UPDATE SET source=excluded.source,external_id=excluded.external_id,synced_at=excluded.synced_at,attempted_at=excluded.attempted_at,status='success',error=NULL")
        .bind(work.game_id).bind(&work.source).bind(&work.external_id).bind(&now).bind(&now).execute(&mut *tx).await?;
    if cancelled() {
        return Ok(false);
    }
    tx.commit().await?;
    Ok(true)
}

pub async fn record_failure(db: &SqlitePool, work: &SyncWork, error: &str) -> CmdResult<()> {
    sqlx::query("INSERT INTO birthday_sync(game_id,source,external_id,attempted_at,status,error) SELECT id,?,?,?,'error',? FROM games WHERE id=? ON CONFLICT(game_id) DO UPDATE SET source=excluded.source,external_id=excluded.external_id,attempted_at=excluded.attempted_at,status='error',error=excluded.error")
        .bind(&work.source).bind(&work.external_id).bind(now_iso8601()).bind(error).bind(work.game_id).execute(db).await?;
    Ok(())
}

pub async fn update_character(
    db: &SqlitePool,
    id: &str,
    edit: &CharacterEdit,
    avatar: Option<&str>,
) -> CmdResult<()> {
    if !valid_date(edit.month, edit.day) {
        return Err(CmdError("请输入有效的生日月日，或同时留空".into()));
    }
    let name = edit
        .name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if name.is_some_and(|n| n.chars().count() > 100) {
        return Err(CmdError("角色名称最多 100 字".into()));
    }
    let changed = if edit.reset {
        sqlx::query("UPDATE birthday_characters SET override_name=NULL,override_month=NULL,override_day=NULL,override_date=0,override_avatar=NULL,hidden=? WHERE id=?").bind(edit.hidden).bind(id).execute(db).await?
    } else {
        sqlx::query("UPDATE birthday_characters SET override_name=?,override_month=?,override_day=?,override_date=1,override_avatar=COALESCE(?,override_avatar),hidden=? WHERE id=?")
            .bind(name).bind(edit.month).bind(edit.day).bind(avatar).bind(edit.hidden).bind(id).execute(db).await?
    };
    if changed.rows_affected() == 0 {
        return Err(CmdError("角色资料不存在，请刷新后重试".into()));
    }
    Ok(())
}
