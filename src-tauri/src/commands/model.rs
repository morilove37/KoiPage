//! Row / payload types mirroring the SQLite schema in `migrations/0001_init.sql`.

use serde::{Deserialize, Serialize};

/// Preserve explicit JSON null separately from an omitted patch field.
pub(crate) fn nullable<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

/// Canonical game status values. `games.status` defaults to `'unplayed'`.
pub const STATUS_UNPLAYED: &str = "unplayed";
pub const STATUS_WISHLIST: &str = "wishlist";
pub const STATUS_PLAYING: &str = "playing";
pub const STATUS_COMPLETED: &str = "completed";
pub const STATUS_ON_HOLD: &str = "on_hold";
pub const STATUS_DROPPED: &str = "dropped";

pub const ALL_STATUSES: [&str; 6] = [
    STATUS_UNPLAYED,
    STATUS_WISHLIST,
    STATUS_PLAYING,
    STATUS_COMPLETED,
    STATUS_ON_HOLD,
    STATUS_DROPPED,
];

/// A row of `games`.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Game {
    pub id: i64,
    pub title: String,
    pub original_title: Option<String>,
    pub developer: Option<String>,
    pub release_date: Option<String>,
    pub status: String,
    pub rating: Option<f64>,
    pub favorite: i64,
    pub cover_path: Option<String>,
    pub description: Option<String>,
    pub install_path: String,
    pub exe_path: Option<String>,
    pub launch_args: Option<String>,
    pub workdir: Option<String>,
    pub save_path: Option<String>,
    pub play_time_seconds: i64,
    pub last_played_at: Option<String>,
    pub notes: Option<String>,
    pub vndb_id: Option<String>,
    pub bangumi_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// A row of `tags`.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub id: i64,
    pub name: String,
    pub color: Option<String>,
}

/// A row of `scan_roots`.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ScanRoot {
    pub id: i64,
    pub path: String,
    pub enabled: i64,
    pub max_depth: i64,
}

/// A row of `play_sessions`.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct PlaySession {
    pub id: i64,
    pub game_id: i64,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub duration_seconds: i64,
}

/// A `games` row plus its tag ids, returned by `game_get`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameDetail {
    #[serde(flatten)]
    pub game: Game,
    pub tags: Vec<i64>,
}

/// Payload for `game_create`. `install_path` is required; everything else is
/// optional and falls back to the column default.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameInput {
    pub title: String,
    pub install_path: String,
    #[serde(default)]
    pub original_title: Option<String>,
    #[serde(default)]
    pub developer: Option<String>,
    #[serde(default)]
    pub release_date: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub rating: Option<f64>,
    #[serde(default)]
    pub favorite: Option<i64>,
    #[serde(default)]
    pub cover_path: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub exe_path: Option<String>,
    #[serde(default)]
    pub launch_args: Option<String>,
    #[serde(default)]
    pub workdir: Option<String>,
    #[serde(default)]
    pub save_path: Option<String>,
    #[serde(default)]
    pub play_time_seconds: Option<i64>,
    #[serde(default)]
    pub last_played_at: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub vndb_id: Option<String>,
    #[serde(default)]
    pub bangumi_id: Option<String>,
    #[serde(default)]
    pub tags: Vec<i64>,
    /// Names submitted by the import wizard. Created and linked in the same
    /// transaction as the game, so cancelling a draft leaves no orphan tags.
    #[serde(default)]
    pub tag_names: Vec<String>,
}

/// Payload for `game_update`.
///
/// Every field is optional and **omitted fields are left untouched**; sending
/// an explicit `null` clears an optional column. `title` and `install_path`
/// cannot be cleared and are ignored when `null`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GamePatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, deserialize_with = "nullable")]
    pub original_title: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullable")]
    pub developer: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullable")]
    pub release_date: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, deserialize_with = "nullable")]
    pub rating: Option<Option<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub favorite: Option<i64>,
    #[serde(default, deserialize_with = "nullable")]
    pub cover_path: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullable")]
    pub description: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub install_path: Option<String>,
    #[serde(default, deserialize_with = "nullable")]
    pub exe_path: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullable")]
    pub launch_args: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullable")]
    pub workdir: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullable")]
    pub save_path: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub play_time_seconds: Option<i64>,
    #[serde(default, deserialize_with = "nullable")]
    pub last_played_at: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullable")]
    pub notes: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullable")]
    pub vndb_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullable")]
    pub bangumi_id: Option<Option<String>>,
    /// When present, replaces the game's tag set wholesale.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<i64>>,
    /// Names to create/reuse and attach, atomically with the rest of the patch.
    #[serde(default)]
    pub tag_names: Vec<String>,
}

impl GamePatch {
    /// True when no column (and no tag list) would be modified.
    pub fn is_empty(&self) -> bool {
        self.title.is_none()
            && self.original_title.is_none()
            && self.developer.is_none()
            && self.release_date.is_none()
            && self.status.is_none()
            && self.rating.is_none()
            && self.favorite.is_none()
            && self.cover_path.is_none()
            && self.description.is_none()
            && self.install_path.is_none()
            && self.exe_path.is_none()
            && self.launch_args.is_none()
            && self.workdir.is_none()
            && self.save_path.is_none()
            && self.play_time_seconds.is_none()
            && self.last_played_at.is_none()
            && self.notes.is_none()
            && self.vndb_id.is_none()
            && self.bangumi_id.is_none()
            && self.tags.is_none()
            && self.tag_names.is_empty()
    }
}

/// A row of `settings`.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Setting {
    pub key: String,
    pub value: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patch_distinguishes_omitted_null_and_supplied_values() {
        let omitted: GamePatch = serde_json::from_str("{}").unwrap();
        assert!(omitted.is_empty());
        let cleared: GamePatch = serde_json::from_str(r#"{"rating":null,"coverPath":null,"description":null}"#).unwrap();
        assert_eq!(cleared.rating, Some(None));
        assert_eq!(cleared.cover_path, Some(None));
        assert_eq!(cleared.description, Some(None));
        assert!(!cleared.is_empty());
        let changed: GamePatch = serde_json::from_str(r#"{"rating":8,"description":"test"}"#).unwrap();
        assert_eq!(changed.rating, Some(Some(8.0)));
        assert_eq!(changed.description.as_ref().and_then(|v| v.as_deref()), Some("test"));
    }
}
