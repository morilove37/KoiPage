use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: i64,
    pub username: String,
    #[serde(default)]
    pub nickname: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncValue {
    pub collection_type: Option<i64>,
    pub rate: i64,
    pub comment: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RemoteCollection {
    pub subject_id: i64,
    pub subject_type: i64,
    #[serde(rename = "type")]
    pub collection_type: i64,
    pub rate: i64,
    #[serde(default, deserialize_with = "collection_comment")]
    pub comment: String,
    #[serde(default)]
    pub private: bool,
}

/// Bangumi uses JSON null for a collection without a short comment. Keep the
/// merge model's empty-string representation while rejecting other JSON types.
fn collection_comment<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    Option::<String>::deserialize(deserializer).map(Option::unwrap_or_default)
}
impl RemoteCollection {
    pub fn value(&self) -> SyncValue {
        SyncValue {
            collection_type: Some(self.collection_type),
            rate: self.rate,
            comment: self.comment.clone(),
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub synced: usize,
    pub uploaded: usize,
    pub downloaded: usize,
    pub conflicts: usize,
    pub skipped: usize,
    pub errors: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncConflict {
    pub local: SyncValue,
    pub remote: SyncValue,
    pub base: Option<SyncValue>,
    pub fields: Vec<String>,
    pub reason: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncItem {
    pub revision: i64,
    pub game_id: i64,
    pub title: String,
    pub subject_id: Option<i64>,
    pub enabled: bool,
    pub personal_rate: Option<i64>,
    pub personal_comment: Option<String>,
    pub last_synced_at: Option<String>,
    pub error: Option<String>,
    pub conflict: Option<SyncConflict>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub connected: bool,
    pub account: Option<Account>,
    pub enabled: bool,
    pub interval_seconds: u64,
    pub private_new: bool,
    pub last_run_at: Option<String>,
    pub last_error: Option<String>,
    pub last_report: Option<SyncReport>,
}
