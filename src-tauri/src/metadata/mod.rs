//! External metadata providers: NextMoe, VNDB and Bangumi.
//!
//! Every provider module exposes the same shape — a search and a detail lookup —
//! so the merge layer in [`mod@self`] can treat them uniformly. Nothing here
//! writes to the database; results are returned to the frontend, which shows
//! them for confirmation before a game is created or updated.
//!
//! ## Why the requests happen in Rust
//!
//! Both reasons are load-bearing:
//!
//! 1. **CORS** — a WebView `fetch()` to a third-party origin is subject to the
//!    page's origin. The Rust side has no such restriction.
//! 2. **User-Agent** — VNDB and Bangumi both require callers to identify their
//!    application. A browser WebView will not let JavaScript set that header.
//!
//! HTTP requests use Rust reqwest; frontend HTTP plugin capabilities are not
//! involved. Offline tag display translations live in the frontend dictionary.

pub mod bangumi;
pub mod matching;
pub mod merge;
pub mod nextmoe;
pub mod vndb;

#[cfg(test)]
mod live_tests;

use serde::{Deserialize, Serialize};

use crate::commands::error::{CmdError, CmdResult};

/// Which provider a [`MetadataCandidate`] came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Nextmoe,
    Vndb,
    Bangumi,
}

impl Provider {
    /// Stable identifier used in settings and UI labels.
    pub fn as_str(self) -> &'static str {
        match self {
            Provider::Nextmoe => "nextmoe",
            Provider::Vndb => "vndb",
            Provider::Bangumi => "bangumi",
        }
    }
}

/// One search hit, normalised across providers.
///
/// Only fields that can be rendered in the result list live here; the heavy
/// detail payload is fetched separately once the user picks a candidate.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataCandidate {
    pub provider: Provider,
    /// Provider-local id, used for the follow-up detail call.
    pub external_id: String,
    /// Best display title the provider offers (Chinese preferred when known).
    pub title: String,
    /// Romanised / original-script title, when distinct from `title`.
    pub original_title: Option<String>,
    pub release_date: Option<String>,
    /// Cover image URL (remote; cached later by the import flow).
    pub cover_url: Option<String>,
    /// 0-10, already normalised by the provider module.
    pub rating: Option<f64>,
    /// Human-readable provider label, for the "各源" column in the UI.
    pub source_label: String,
}

/// A rating from one upstream source.
///
/// `score` is always normalised to 0-10 by the provider module, because the
/// upstreams disagree: VNDB and Bangumi use 0-10, ErogameScape and
/// HowLongToBeat use 0-100.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRating {
    pub source: String,
    pub score: f64,
    pub vote_count: Option<i64>,
}

/// Fully resolved metadata for one work, merged across providers.
///
/// This is what the confirmation dialog renders before the user accepts it.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataDetail {
    /// Which provider this detail primarily came from.
    pub provider: Option<Provider>,
    pub external_id: Option<String>,
    /// The provider's own display title.
    pub title: String,
    /// Chinese title when any provider knows one; what we prefer to store.
    pub title_zh: Option<String>,
    /// Original-script (usually Japanese) title.
    pub title_original: Option<String>,
    pub developer: Option<String>,
    pub release_date: Option<String>,
    /// 0-10 score, preserving upstream decimal precision. Chosen by [`merge`].
    pub rating: Option<f64>,
    /// Per-source ratings, for transparency in the UI.
    pub ratings: Vec<SourceRating>,
    pub cover_url: Option<String>,
    /// Description text, preferring a non-machine-translated Chinese intro.
    pub description: Option<String>,
    pub description_lang: Option<String>,
    /// Tag display names, de-duplicated across providers, order preserved.
    pub tags: Vec<String>,
    /// External ids we learned, so they can be stored on the game row.
    pub vndb_id: Option<String>,
    pub bangumi_id: Option<String>,
    /// Attribution string the provider requires us to display.
    pub attribution: Option<String>,
}

/// Shared HTTP client with the User-Agent our upstreams require.
///
/// A single client is reused so connections are pooled across providers.
pub fn http_client() -> CmdResult<reqwest::Client> {
    reqwest::Client::builder()
        // VNDB and Bangumi both ask callers to identify themselves; a default
        // reqwest UA is a common cause of unexplained 403s.
        .user_agent(crate::metadata::USER_AGENT)
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|error| CmdError(format!("could not build http client: {error}")))
}

/// Identifies this application to the upstream APIs, as their terms require.
pub const USER_AGENT: &str = concat!(
    "KoiPage/",
    env!("CARGO_PKG_VERSION"),
    " (https://github.com/morilove37/KoiPage)"
);
