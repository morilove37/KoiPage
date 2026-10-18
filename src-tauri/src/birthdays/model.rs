use crate::commands::error::{CmdError, CmdResult};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BirthdayGame {
    pub id: i64,
    pub title: String,
    pub favorite: i64,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Character {
    pub id: String,
    pub source: String,
    pub external_id: String,
    pub name: String,
    pub original_name: Option<String>,
    pub birthday_month: Option<i64>,
    pub birthday_day: Option<i64>,
    pub birthday_raw: Option<String>,
    pub avatar_path: Option<String>,
    pub hidden: bool,
    pub customized: bool,
    pub games: Vec<BirthdayGame>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CharacterEdit {
    pub name: Option<String>,
    pub month: Option<i64>,
    pub day: Option<i64>,
    pub avatar_file: Option<String>,
    pub hidden: bool,
    pub reset: bool,
}

#[derive(Debug, Clone)]
pub struct SourceCharacter {
    pub external_id: String,
    pub name: String,
    pub original_name: Option<String>,
    pub month: Option<i64>,
    pub day: Option<i64>,
    pub raw: Option<String>,
    pub avatar: Option<String>,
    pub role: String,
    pub spoiler: i64,
}

#[derive(Debug, Clone)]
pub struct SyncWork {
    pub game_id: i64,
    pub title: String,
    pub source: String,
    pub external_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncState {
    pub game_id: i64,
    pub title: String,
    pub source: Option<String>,
    pub external_id: Option<String>,
    pub status: String,
    pub synced_at: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub running: bool,
    pub cancelling: bool,
    pub total: usize,
    pub completed: usize,
    pub failed: usize,
    pub current: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub characters: Vec<Character>,
    pub sync: Vec<SyncState>,
    pub enabled: bool,
    pub progress: Progress,
}

pub fn valid_date(month: Option<i64>, day: Option<i64>) -> bool {
    match (month, day) {
        (None, None) => true,
        (Some(m), Some(d)) => u8::try_from(m)
            .ok()
            .and_then(|n| time::Month::try_from(n).ok())
            .zip(u8::try_from(d).ok())
            .is_some_and(|(m, d)| time::Date::from_calendar_date(2000, m, d).is_ok()),
        _ => false,
    }
}

pub fn validate_identity(source: &str, id: &str) -> CmdResult<()> {
    let digits = if source == "vndb" {
        id.strip_prefix('c').unwrap_or("")
    } else if source == "bangumi" {
        id
    } else {
        ""
    };
    if digits.is_empty() || digits.len() > 16 || !digits.bytes().all(|c| c.is_ascii_digit()) {
        return Err(CmdError("角色来源或 ID 无效".into()));
    }
    Ok(())
}

pub fn source_for(vndb: Option<&str>, bangumi: Option<&str>) -> Option<(String, String)> {
    if let Some(id) = vndb.map(str::trim).filter(|s| !s.is_empty()) {
        Some((
            "vndb".into(),
            format!("v{}", id.trim_start_matches(['v', 'V'])),
        ))
    } else {
        bangumi
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|id| ("bangumi".into(), id.into()))
    }
}
