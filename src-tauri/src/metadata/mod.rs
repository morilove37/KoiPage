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
pub mod twodfan;

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
    #[serde(rename = "2dfan")]
    TwoDfan,
}

impl Provider {
    /// Stable identifier used in settings and UI labels.
    pub fn as_str(self) -> &'static str {
        match self {
            Provider::Nextmoe => "nextmoe",
            Provider::Vndb => "vndb",
            Provider::Bangumi => "bangumi",
            Provider::TwoDfan => "2dfan",
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
    /// Extra spellings used only by the auto-fetch matcher (never rendered).
    ///
    /// VNDB's romanised title ends up here when the display title is Chinese:
    /// the user's folder may be named in English even though the catalogue name
    /// is 魔女的夜宴, and matching must still recognise it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub aliases: Vec<String>,
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

/// 2DFan's image host returns 404 unless the request comes from the site.
pub fn protected_cover(url: &str) -> bool {
    reqwest::Url::parse(url).is_ok_and(|url| url.scheme() == "https" && url.host_str() == Some("img.achost.top"))
}

pub async fn download_cover(url: &str) -> CmdResult<Vec<u8>> {
    let mut request = http_client()?.get(url).header("Accept", "image/*");
    if protected_cover(url) { request = request.header(reqwest::header::REFERER, "https://2dfan.com/"); }
    let mut response = request.send().await.map_err(|error| CmdError(format!("封面下载失败：{error}")))?;
    let status = response.status();
    if !status.is_success() { return Err(CmdError(format!("封面下载返回 HTTP {status}"))); }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| CmdError(format!("封面读取失败：{error}")))? {
        if bytes.len() + chunk.len() > 20 * 1024 * 1024 { return Err(CmdError("封面不能超过 20 MB".into())); }
        bytes.extend_from_slice(&chunk);
    }
    image::guess_format(&bytes).map_err(|_| CmdError("封面下载结果不是有效图片".into()))?;
    Ok(bytes)
}

/// Identifies this application to the upstream APIs, as their terms require.
pub const USER_AGENT: &str = concat!(
    "KoiPage/",
    env!("CARGO_PKG_VERSION"),
    " (https://github.com/morilove37/KoiPage)"
);

/// Settings key for the preferred language of a fetched display title.
pub const TITLE_LANGUAGE_KEY: &str = "metadata_title_language";
pub const DEFAULT_SOURCE_KEY: &str = "metadata_default_source";

pub fn default_source(value: Option<&str>) -> Provider {
    match value.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
        Some("nextmoe") => Provider::Nextmoe,
        Some("bangumi") => Provider::Bangumi,
        Some("2dfan") => Provider::TwoDfan,
        _ => Provider::Vndb,
    }
}

/// Which language should become the game's display title when metadata is applied.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TitlePreference {
    /// Chinese first, then the original-script title, then the provider title.
    Chinese,
    /// Original-script (usually Japanese) first, then Chinese, then the provider title.
    Japanese,
    /// The provider's own title first (often romanised/English).
    Source,
}

impl TitlePreference {
    /// Parse the value stored in the `settings` table; unknown values use the
    /// Chinese-first default so a hand-edited database cannot break imports.
    pub fn parse(value: Option<&str>) -> Self {
        match value.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
            Some("ja" | "japanese" | "original") => Self::Japanese,
            Some("source") => Self::Source,
            _ => Self::Chinese,
        }
    }
}

/// Resolve the display title for a merged detail.
///
/// VNDB's primary `title` is frequently romanised/English, so it must be the last
/// resort. Preferring the Chinese title (when any provider knows one) and then
/// the original-script title is what stops imported games from being named in
/// English.
pub fn resolve_title(detail: &MetadataDetail, preference: TitlePreference) -> String {
    let zh = non_blank(detail.title_zh.as_deref());
    let original = non_blank(detail.title_original.as_deref());
    let source = non_blank(Some(detail.title.as_str()));
    let picked = match preference {
        TitlePreference::Chinese => zh.or(original).or(source),
        TitlePreference::Japanese => original.or(zh).or(source),
        TitlePreference::Source => source.or(zh).or(original),
    };
    picked.unwrap_or_default().to_string()
}

fn non_blank(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

#[cfg(test)]
mod title_tests {
    use super::*;

    fn detail(title: &str, zh: Option<&str>, original: Option<&str>) -> MetadataDetail {
        MetadataDetail {
            title: title.to_string(),
            title_zh: zh.map(str::to_string),
            title_original: original.map(str::to_string),
            ..Default::default()
        }
    }

    #[test]
    fn title_resolution_avoids_romanised_names() {
        let vn = detail("Clannad", None, Some("クラナド"));
        // The reported bug: VNDB's primary title is Latin, but the Japanese title
        // was already fetched and must win.
        assert_eq!(resolve_title(&vn, TitlePreference::Chinese), "クラナド");
        assert_eq!(resolve_title(&vn, TitlePreference::Japanese), "クラナド");
        assert_eq!(resolve_title(&vn, TitlePreference::Source), "Clannad");

        let translated = detail("Clannad", Some("克兰纳德"), Some("クラナド"));
        assert_eq!(resolve_title(&translated, TitlePreference::Chinese), "克兰纳德");
        assert_eq!(resolve_title(&translated, TitlePreference::Japanese), "クラナド");
    }

    #[test]
    fn title_resolution_falls_back_to_the_provider_name() {
        let latin = detail("Clannad", None, None);
        assert_eq!(resolve_title(&latin, TitlePreference::Chinese), "Clannad");
        assert_eq!(resolve_title(&latin, TitlePreference::Japanese), "Clannad");

        let blank = detail("  ", Some(" "), Some(""));
        assert_eq!(resolve_title(&blank, TitlePreference::Chinese), "");
    }

    #[test]
    fn title_preference_parses_settings_values() {
        assert_eq!(TitlePreference::parse(None), TitlePreference::Chinese);
        assert_eq!(TitlePreference::parse(Some("")), TitlePreference::Chinese);
        assert_eq!(TitlePreference::parse(Some("zh")), TitlePreference::Chinese);
        assert_eq!(TitlePreference::parse(Some(" JA ")), TitlePreference::Japanese);
        assert_eq!(TitlePreference::parse(Some("source")), TitlePreference::Source);
        assert_eq!(TitlePreference::parse(Some("garbage")), TitlePreference::Chinese);
    }
}
