//! NextMoe·未萌 API v2 provider.
//!
//! This is the primary source: it aligns six upstreams (VNDB, Bangumi, DLsite,
//! ErogameScape, Ci-en, Getchu) into one record and hands back the arbitrated
//! answer per field, plus which source each answer came from.
//!
//! ## Attribution
//!
//! NextMoe's terms ask that Galgame data be credited to **鲲 Galgame 论坛**.
//! [`ATTRIBUTION`] carries that string to the UI.
//!
//! ## Auth
//!
//! Anonymous reads work (30 req/min, 1000/day per IP). A free `nmk_` key raises
//! that to 60 req/min and 50 000/day. The key is optional and read from the
//! `nextmoe_api_key` setting when present.
//!
//! ## Response shapes differ between the collection and detail endpoints
//!
//! Verified against the live API:
//!
//! - `GET /v2/catalog/works` → `{ object, items: [...], next_cursor }`
//! - `GET /v2/catalog/works/{id}` → a bare work object
//! - `GET /v2/catalog/works/{id}/ratings` → `{ object, items: [...] }`
//! - `GET /v2/catalog/works/{id}?include=ratings` → a **bare array**, no `items`
//!
//! That last case is the trap: the same logical field arrives enveloped or bare
//! depending on how it was requested. [`RatingsField`] accepts both.

use serde::Deserialize;

use super::{MetadataCandidate, MetadataDetail, Provider, SourceRating, USER_AGENT};

/// NextMoe terms require crediting Galgame data to this site.
pub const ATTRIBUTION: &str = "鲲 Galgame 论坛";

const BASE: &str = "https://api.nextmoe.dev/v2";

/// A cover image reference.
#[derive(Debug, Clone, Deserialize)]
pub struct Image {
    pub url: Option<String>,
}

impl Image {
    fn url(&self) -> Option<String> {
        self.url.clone().filter(|u| !u.is_empty())
    }
}

/// One title in one language.
#[derive(Debug, Clone, Deserialize)]
pub struct Title {
    pub lang: Option<String>,
    pub title: Option<String>,
    /// Romanised form, when the title is not Latin script.
    pub latin: Option<String>,
    pub title_kind: Option<String>,
    #[serde(default)]
    pub is_machine: bool,
}

/// A description in one language.
#[derive(Debug, Clone, Deserialize)]
pub struct Intro {
    pub lang: Option<String>,
    pub value: Option<String>,
    #[serde(default)]
    pub is_machine: bool,
}

/// A company credited on a work.
#[derive(Debug, Clone, Deserialize)]
pub struct Company {
    pub display_name: Option<String>,
    /// `developer` for the studio that made it, `publisher` for the rest.
    pub attribution_role: Option<String>,
    pub company_kind: Option<String>,
}

/// A tag applied to a work.
#[derive(Debug, Clone, Deserialize)]
pub struct Tag {
    pub display_name: Option<String>,
    /// Which upstream the tag came from; used to prefer Chinese tags.
    pub source: Option<String>,
    #[serde(default)]
    pub is_sexual: bool,
}

/// One upstream's rating.
#[derive(Debug, Clone, Deserialize)]
pub struct Rating {
    pub source: Option<String>,
    pub score: Option<f64>,
    pub vote_count: Option<i64>,
}

/// Ratings arrive enveloped (`{items:[...]}`) from the sub-resource endpoint but
/// as a bare array from `?include=ratings`. Accept both.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum RatingsField {
    Enveloped { items: Vec<Rating> },
    Bare(Vec<Rating>),
}

impl RatingsField {
    fn into_vec(self) -> Vec<Rating> {
        match self {
            RatingsField::Enveloped { items } => items,
            RatingsField::Bare(items) => items,
        }
    }
}

/// Same enveloped-or-bare problem as [`RatingsField`].
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum TagsField {
    Enveloped { items: Vec<Tag> },
    Bare(Vec<Tag>),
}

impl TagsField {
    fn into_vec(self) -> Vec<Tag> {
        match self {
            TagsField::Enveloped { items } => items,
            TagsField::Bare(items) => items,
        }
    }
}

/// A work as returned by the collection or detail endpoint.
#[derive(Debug, Clone, Deserialize)]
pub struct Work {
    pub id: String,
    pub display_name: Option<String>,
    /// Romanised title, when the display name is not Latin.
    pub latin: Option<String>,
    pub release_date: Option<String>,
    pub cover: Option<Image>,
    #[serde(default)]
    pub titles: Vec<Title>,
    #[serde(default)]
    pub intros: Vec<Intro>,
    #[serde(default)]
    pub companies: Vec<Company>,
    /// Present only when requested via `include=ratings`.
    pub ratings: Option<RatingsField>,
    /// Present only when requested via `include=tags`.
    pub tags: Option<TagsField>,
}

/// Collection envelope.
#[derive(Debug, Deserialize)]
struct ListResponse {
    #[serde(default)]
    items: Vec<Work>,
}

/// Percent-encode a query value.
///
/// A tiny local encoder avoids pulling in a dependency for six characters; it
/// encodes everything outside the unreserved set, which is always safe.
fn encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Pick the best Chinese title from a work's title list.
///
/// Prefers a non-machine `zh-Hans` official title, then any `zh*` title.
fn chinese_title(titles: &[Title]) -> Option<String> {
    let zh = |t: &Title| {
        t.lang
            .as_deref()
            .map(|l| l.starts_with("zh"))
            .unwrap_or(false)
    };
    titles
        .iter()
        .filter(|t| zh(t) && !t.is_machine && t.title.is_some())
        .chain(titles.iter().filter(|t| zh(t) && t.title.is_some()))
        .find_map(|t| t.title.clone().filter(|s| !s.trim().is_empty()))
        // `display_name` is sometimes already the Chinese title.
        .or_else(|| {
            titles
                .iter()
                .filter(|t| zh(t))
                .find_map(|t| t.latin.clone().filter(|s| !s.trim().is_empty()))
        })
}

/// Pick the Japanese/original-script title.
fn original_title(work: &Work) -> Option<String> {
    // The `ja` entry is the original script for essentially every Galgame.
    work.titles
        .iter()
        .filter(|t| t.lang.as_deref() == Some("ja"))
        .find_map(|t| t.title.clone())
        .filter(|s| !s.trim().is_empty())
        .or_else(|| work.latin.clone().filter(|s| !s.trim().is_empty()))
}

/// Pick the best description, preferring a human Chinese translation.
///
/// Machine translations are accepted only as a last resort, and the chosen
/// language is reported so the UI can label it.
fn best_intro(work: &Work) -> Option<(String, String)> {
    let pick = |pred: &dyn Fn(&Intro) -> bool| -> Option<(String, String)> {
        work.intros
            .iter()
            .find(|i| pred(i) && i.value.as_deref().map(|v| !v.trim().is_empty()).unwrap_or(false))
            .and_then(|i| {
                Some((
                    i.value.clone()?,
                    i.lang.clone().unwrap_or_else(|| "unknown".to_string()),
                ))
            })
    };
    let is_zh = |i: &Intro| i.lang.as_deref().map(|l| l.starts_with("zh")).unwrap_or(false);

    // 1. Human Chinese, 2. machine Chinese, 3. English, 4. anything.
    pick(&|i| is_zh(i) && !i.is_machine)
        .or_else(|| pick(&is_zh))
        .or_else(|| pick(&|i| i.lang.as_deref() == Some("en")))
        .or_else(|| pick(&|_| true))
}

/// The studio that developed the work.
///
/// Prefers a company explicitly credited as `developer`; some entries only carry
/// publishers, in which case the first publisher is the best available answer.
fn developer(companies: &[Company]) -> Option<String> {
    companies
        .iter()
        .find(|c| c.attribution_role.as_deref() == Some("developer"))
        .or_else(|| companies.iter().find(|c| c.company_kind.as_deref() == Some("game_brand")))
        .or_else(|| companies.first())
        .and_then(|c| c.display_name.clone())
        .filter(|s| !s.trim().is_empty())
}

/// Normalise a NextMoe rating to 0-10.
///
/// Verified live: `vndb`/`bangumi`/`nextmoe` report 0-10, while `erogamescape`
/// and `howlongtobeat` report 0-100. Scores above 10 are therefore divided by 10
/// rather than trusting the source name, which keeps working if NextMoe adds a
/// source we have not enumerated.
fn normalise_score(score: f64) -> Option<f64> {
    if !score.is_finite() || score <= 0.0 {
        return None;
    }
    let scaled = if score > 10.0 { score / 10.0 } else { score };
    Some(scaled.clamp(0.0, 10.0))
}

fn source_ratings(raw: Vec<Rating>) -> Vec<SourceRating> {
    raw.into_iter()
        .filter_map(|r| {
            let score = normalise_score(r.score?)?;
            Some(SourceRating {
                source: r.source.unwrap_or_else(|| "unknown".to_string()),
                score,
                vote_count: r.vote_count,
            })
        })
        .collect()
}

/// Extra spellings used only by the auto-fetch matcher.
///
/// The display title is Chinese/original-script, but folders are often named
/// with the romanised title (`Sabbat of the Witch`), so those forms must still
/// be recognised without being rendered.
fn matching_aliases(work: &Work, title: &str, original: Option<&str>) -> Vec<String> {
    let mut aliases: Vec<String> = Vec::new();
    let mut push = |value: Option<&str>| {
        let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
            return;
        };
        if value == title || Some(value) == original {
            return;
        }
        if !aliases.iter().any(|existing| existing == value) {
            aliases.push(value.to_string());
        }
    };
    push(work.display_name.as_deref());
    for entry in &work.titles {
        push(entry.title.as_deref());
        push(entry.latin.as_deref());
    }
    aliases
}

fn to_candidate(work: Work) -> MetadataCandidate {
    let chinese = chinese_title(&work.titles);
    let original = original_title(&work);
    let display = work.display_name.clone().filter(|name| !name.trim().is_empty());
    // Chinese → original script → provider display name. `display_name` is
    // often the romanised title, so it is the last resort for the result list.
    let title = chinese
        .or_else(|| original.clone())
        .or_else(|| display.clone())
        .unwrap_or_else(|| work.id.clone());
    let alternate = original
        .clone()
        .filter(|value| *value != title)
        .or_else(|| display.filter(|value| *value != title));
    let aliases = matching_aliases(&work, &title, alternate.as_deref());
    MetadataCandidate {
        provider: Provider::Nextmoe,
        external_id: work.id.clone(),
        title,
        original_title: alternate,
        aliases,
        release_date: work.release_date.clone(),
        cover_url: work.cover.as_ref().and_then(Image::url),
        rating: work
            .ratings
            .map(RatingsField::into_vec)
            .map(source_ratings)
            .and_then(|rs| {
                // Prefer Bangumi (Chinese audience), then VNDB.
                rs.iter()
                    .find(|r| r.source == "bangumi")
                    .or_else(|| rs.iter().find(|r| r.source == "vndb"))
                    .or_else(|| rs.first())
                    .map(|r| r.score)
            }),
        source_label: "鲲 Galgame 论坛".to_string(),
    }
}

/// Search the NextMoe catalogue.
pub async fn search(query: &str, limit: u32, api_key: Option<&str>) -> super::CmdResult<Vec<MetadataCandidate>> {
    let limit = limit.clamp(1, 30);
    let url = format!(
        "{BASE}/catalog/works?q={}&limit={}&include=ratings",
        encode(query),
        limit
    );
    let mut request = super::http_client()?.get(&url).header("Accept", "application/json");
    if let Some(key) = api_key.filter(|k| !k.trim().is_empty()) {
        request = request.bearer_auth(key.trim());
    }
    let response = request
        .send()
        .await
        .map_err(|error| super::CmdError(format!("NextMoe 搜索失败：{error}")))?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(super::CmdError(format!(
            "NextMoe 搜索失败（HTTP {status}）：{}",
            body.chars().take(200).collect::<String>()
        )));
    }

    let list: ListResponse = response
        .json()
        .await
        .map_err(|error| super::CmdError(format!("NextMoe 响应解析失败：{error}")))?;

    Ok(list.items.into_iter().map(to_candidate).collect())
}

/// Turn a fully-populated `Work` into a [`MetadataDetail`].
///
/// Shared by the detail endpoint and the `refs=` batch lane so both paths apply
/// identical title/rating/tag policy.
fn detail_from_work(work: Work) -> MetadataDetail {
    let ratings = work
        .ratings
        .clone()
        .map(RatingsField::into_vec)
        .map(source_ratings)
        .unwrap_or_default();
    let tags: Vec<String> = work
        .tags
        .clone()
        .map(TagsField::into_vec)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|t| t.display_name)
        .filter(|n| !n.trim().is_empty())
        .collect();
    let (description, description_lang) = match best_intro(&work) {
        Some((text, lang)) => (Some(text), Some(lang)),
        None => (None, None),
    };

    MetadataDetail {
        provider: Some(Provider::Nextmoe),
        external_id: Some(work.id.clone()),
        title: work
            .display_name
            .clone()
            .unwrap_or_else(|| work.id.clone()),
        title_zh: chinese_title(&work.titles),
        title_original: original_title(&work),
        developer: developer(&work.companies),
        release_date: work.release_date.clone(),
        // The merge layer decides the final value; NextMoe's own preference is
        // Bangumi, then VNDB, then whatever exists.
        rating: super::merge::pick_rating(&ratings),
        ratings,
        cover_url: work.cover.as_ref().and_then(Image::url),
        description,
        description_lang,
        tags: super::merge::dedupe_tags(tags),
        vndb_id: None,
        bangumi_id: None,
        attribution: Some(ATTRIBUTION.to_string()),
    }
}

/// Fetch full metadata for one work.
pub async fn detail(id: &str, api_key: Option<&str>) -> super::CmdResult<MetadataDetail> {
    let url = format!(
        "{BASE}/catalog/works/{}?include=titles,intros,companies,ratings,tags",
        encode(id)
    );
    let mut request = super::http_client()?.get(&url).header("Accept", "application/json");
    if let Some(key) = api_key.filter(|k| !k.trim().is_empty()) {
        request = request.bearer_auth(key.trim());
    }
    let response = request
        .send()
        .await
        .map_err(|error| super::CmdError(format!("NextMoe 详情失败：{error}")))?;

    let status = response.status();
    if !status.is_success() {
        return Err(super::CmdError(format!("NextMoe 详情失败（HTTP {status}）")));
    }

    let work: Work = response
        .json()
        .await
        .map_err(|error| super::CmdError(format!("NextMoe 详情解析失败：{error}")))?;

    Ok(detail_from_work(work))
}

/// Look a work up by an external anchor such as `vndb:v4` or `bangumi:13`.
///
/// This is the batch lane documented at
/// <https://developer.nextmoe.dev/docs/shaping> — it resolves an id from another
/// provider into NextMoe's record, which is how a VNDB or Bangumi pick gets
/// enriched with a Chinese title and extra rating sources.
///
/// ## Why this takes two requests
///
/// `titles` is listed in NextMoe's *list* include vocabulary, but the collection
/// lane does not actually emit it. Measured against the live API:
///
/// | request | `titles` | `ratings` | `tags` |
/// |---|---|---|---|
/// | `?ids=86&include=titles,ratings,tags` | **absent** | 5 | 101 |
/// | `?refs=vndb:v4&include=…` | **absent** | 5 | 101 |
/// | `?q=CLANNAD&limit=1&include=…` | **absent** | 5 | 101 |
/// | `/works/86?include=titles,ratings,tags` | 7 | 5 | 101 |
///
/// Without `titles` there is no Chinese title, which is the main reason to
/// consult NextMoe at all — `display_name` is only sometimes Chinese. So this
/// resolves the id through the batch lane and then fetches the detail record.
///
/// Returns `Ok(None)` when NextMoe does not know the reference, which is a
/// normal outcome rather than an error: unknown keys come back in `missing[]`
/// instead of a 404, and coverage is partial (roughly a quarter of VNDB's
/// most-voted titles), so a miss is common and must stay quiet.
pub async fn detail_by_ref(
    reference: &str,
    api_key: Option<&str>,
) -> super::CmdResult<Option<MetadataDetail>> {
    let url = format!("{BASE}/catalog/works?refs={}", encode(reference));
    let mut request = super::http_client()?.get(&url).header("Accept", "application/json");
    if let Some(key) = api_key.filter(|k| !k.trim().is_empty()) {
        request = request.bearer_auth(key.trim());
    }
    let response = request
        .send()
        .await
        .map_err(|error| super::CmdError(format!("NextMoe 反查失败：{error}")))?;

    let status = response.status();
    if !status.is_success() {
        return Err(super::CmdError(format!(
            "NextMoe 反查返回 HTTP {status}"
        )));
    }

    let list: ListResponse = response
        .json()
        .await
        .map_err(|error| super::CmdError(format!("NextMoe 反查解析失败：{error}")))?;

    // Empty `items` means the work is not in NextMoe's catalogue.
    let Some(resolved_id) = list.items.into_iter().next().map(|work| work.id) else {
        return Ok(None);
    };

    // Second hop: the detail lane is the only one that returns `titles`.
    detail(&resolved_id, api_key).await.map(Some)
}

/// User-Agent constant is defined in the parent module; re-exported for docs.
#[allow(dead_code)]
pub(crate) const UA: &str = USER_AGENT;
