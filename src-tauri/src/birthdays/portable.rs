//! Portable birthday data never contains filesystem paths or local game IDs.
use super::{avatars, model::*, store};
use crate::commands::error::{CmdError, CmdResult};
use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};
use std::{collections::BTreeSet, path::Path};

pub const MAX_PORTABLE: u64 = 64 * 1024 * 1024;
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableFile {
    pub version: u32,
    pub characters: Vec<PortableCharacter>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableCharacter {
    pub source: String,
    pub external_id: String,
    pub name: String,
    pub original_name: Option<String>,
    pub month: Option<i64>,
    pub day: Option<i64>,
    pub raw: Option<String>,
    pub avatar: Option<Vec<u8>>,
    pub override_name: Option<String>,
    pub override_month: Option<i64>,
    pub override_day: Option<i64>,
    pub override_date: bool,
    pub override_avatar: Option<Vec<u8>>,
    pub hidden: bool,
    pub works: Vec<String>,
}
pub async fn export_data(db: &SqlitePool) -> CmdResult<PortableFile> {
    let mut records = vec![];
    let mut image_bytes = 0usize;
    for c in store::list_characters(db).await? {
        let row = sqlx::query("SELECT * FROM birthday_characters WHERE id=?")
            .bind(&c.id)
            .fetch_one(db)
            .await?;
        let read =
            |path: Option<String>| path.and_then(|s| avatars::read_image(Path::new(&s)).ok());
        let avatar = read(row.get("avatar_path"));
        let override_avatar = read(row.get("override_avatar"));
        image_bytes +=
            avatar.as_ref().map_or(0, Vec::len) + override_avatar.as_ref().map_or(0, Vec::len);
        if image_bytes > 12 * 1024 * 1024 {
            return Err(CmdError(
                "生日资料的头像过多，无法导出为单个文件（头像合计最多 12 MB）".into(),
            ));
        }
        let works:Vec<String>=sqlx::query_scalar("SELECT DISTINCT external_game_id FROM birthday_game_characters WHERE character_id=? AND game_id IN (SELECT id FROM games)").bind(&c.id).fetch_all(db).await?;
        records.push(PortableCharacter {
            source: c.source,
            external_id: c.external_id,
            name: row.get("name"),
            original_name: row.get("original_name"),
            month: row.get("birthday_month"),
            day: row.get("birthday_day"),
            raw: row.get("birthday_raw"),
            avatar,
            override_name: row.get("override_name"),
            override_month: row.get("override_month"),
            override_day: row.get("override_day"),
            override_date: row.get("override_date"),
            override_avatar,
            hidden: c.hidden,
            works,
        });
    }
    Ok(PortableFile {
        version: 1,
        characters: records,
    })
}
fn validate(data: &PortableFile) -> CmdResult<()> {
    if data.version != 1 || data.characters.len() > 10000 {
        return Err(CmdError("不支持此生日资料版本或角色数量超过 10000".into()));
    }
    let mut ids = BTreeSet::new();
    for c in &data.characters {
        validate_identity(&c.source, &c.external_id)?;
        if !ids.insert((&c.source, &c.external_id))
            || !valid_date(c.month, c.day)
            || !valid_date(c.override_month, c.override_day)
            || c.name.trim().is_empty()
            || c.name.chars().count() > 200
            || c.override_name
                .as_ref()
                .is_some_and(|s| s.chars().count() > 100)
            || c.original_name.as_ref().is_some_and(|s| s.len() > 2000)
            || c.raw.as_ref().is_some_and(|s| s.len() > 2000)
            || c.works.len() > 1000
        {
            return Err(CmdError("生日资料包含重复角色、无效名称或无效日期".into()));
        }
        for id in &c.works {
            let digits = if c.source == "vndb" {
                id.strip_prefix('v').unwrap_or("")
            } else {
                id
            };
            if digits.is_empty() || digits.len() > 16 || !digits.bytes().all(|v| v.is_ascii_digit())
            {
                return Err(CmdError("生日资料包含无效的关联作品 ID".into()));
            }
        }
        for bytes in [&c.avatar, &c.override_avatar].into_iter().flatten() {
            avatars::validate_image(bytes)?;
        }
    }
    Ok(())
}
pub async fn import_data(
    db: &SqlitePool,
    data: PortableFile,
    avatar_dir: &Path,
) -> CmdResult<usize> {
    validate(&data)?;
    let works = store::list_sync(db).await?;
    let mut tx = db.begin().await?;
    let count = data.characters.len();
    for c in data.characters {
        let id = format!("{}:{}", c.source, c.external_id);
        let avatar = c
            .avatar
            .as_deref()
            .map(|b| avatars::save_image(avatar_dir, b))
            .transpose()?;
        let override_avatar = c
            .override_avatar
            .as_deref()
            .map(|b| avatars::save_image(avatar_dir, b))
            .transpose()?;
        sqlx::query("INSERT INTO birthday_characters(id,source,external_id,name,original_name,birthday_month,birthday_day,birthday_raw,avatar_path,override_name,override_month,override_day,override_date,override_avatar,hidden) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,original_name=excluded.original_name,birthday_month=excluded.birthday_month,birthday_day=excluded.birthday_day,birthday_raw=excluded.birthday_raw,avatar_path=COALESCE(excluded.avatar_path,birthday_characters.avatar_path),override_name=excluded.override_name,override_month=excluded.override_month,override_day=excluded.override_day,override_date=excluded.override_date,override_avatar=excluded.override_avatar,hidden=excluded.hidden")
            .bind(&id).bind(&c.source).bind(&c.external_id).bind(&c.name).bind(&c.original_name).bind(c.month).bind(c.day).bind(&c.raw).bind(avatar)
            .bind(&c.override_name).bind(c.override_month).bind(c.override_day).bind(c.override_date).bind(override_avatar).bind(c.hidden).execute(&mut *tx).await?;
        for work in &works {
            if work.source.as_deref() == Some(&c.source)
                && work
                    .external_id
                    .as_ref()
                    .is_some_and(|id| c.works.contains(id))
            {
                sqlx::query("INSERT INTO birthday_game_characters(game_id,character_id,external_game_id,role,spoiler) VALUES(?,?,?,'primary',0) ON CONFLICT(game_id,character_id) DO UPDATE SET external_game_id=excluded.external_game_id,role='primary',spoiler=0")
                    .bind(work.game_id).bind(&id).bind(&work.external_id).execute(&mut *tx).await?;
            }
        }
    }
    tx.commit().await?;
    Ok(count)
}
