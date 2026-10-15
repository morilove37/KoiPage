//! VNDB Kana API provider.
//!
//! Query endpoint: `POST https://api.vndb.org/kana/vn` with a JSON body.
//! No authentication. Rate limit: 200 requests / 5 minutes.
//!
//! Rate limiting is enforced **per 5 minutes**, so a burst of searches from the
//! UI can trip it. Callers should search sparingly (one request per user action)
//! and prefer NextMoe's aggregated record for bulk work.
//!
//! ## Scale differences versus the other providers
//!
//! - `rating` / `average` are **0-100** integers here; normalised on the way out.
//! - `tags` contains only *directly applied* tags (no parents).
//! - `description` may embed VNDB formatting codes, stripped by [`strip_markup`].

use serde::{Deserialize, Serialize};

use super::{MetadataCandidate, MetadataDetail, Provider, SourceRating};

const ENDPOINT: &str = "https://api.vndb.org/kana/vn";

/// Fields requested for a detail lookup.
///
/// Listing `image` without sub-fields is an error on VNDB, so nested selections
/// are always bracketed.
const DETAIL_FIELDS: &str = "id,title,alttitle,titles{lang,title,latin,official,main},\
aliases,olang,released,image.url,image.thumbnail,average,rating,votecount,\
length_minutes,description,tags{id,name,rating,spoiler},developers{id,name}";

/// Smaller field set for search results.
const SEARCH_FIELDS: &str = "id,title,alttitle,released,image.url,rating,votecount";

#[derive(Debug, Deserialize)]
struct KanaResponse {
    #[serde(default)]
    results: Vec<Vn>,
}

#[derive(Debug, Deserialize)]
struct Vn {
    id: String,
    title: Option<String>,
    alttitle: Option<String>,
    released: Option<String>,
    image: Option<VnImage>,
    /// 0-100.
    rating: Option<f64>,
    average: Option<f64>,
    votecount: Option<i64>,
    /// Average play time in minutes. Parsed for completeness and surfaced in the
    /// UI later; NextMoe does not expose an equivalent field.
    #[allow(dead_code)]
    length_minutes: Option<i64>,
    description: Option<String>,
    #[serde(default)]
    titles: Vec<VnTitle>,
    #[serde(default)]
    tags: Vec<VnTag>,
    #[serde(default)]
    developers: Vec<VnProducer>,
}

#[derive(Debug, Deserialize)]
struct VnImage {
    url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct VnTitle {
    lang: Option<String>,
    title: Option<String>,
    /// Romanised form. Kept because VNDB returns it and it documents the shape,
    /// even though we only ever read the original-script title today.
    #[allow(dead_code)]
    latin: Option<String>,
    #[allow(dead_code)]
    #[serde(default)]
    main: bool,
}

#[derive(Debug, Deserialize)]
struct VnTag {
    name: Option<String>,
    /// 0-3 tag weight; used to drop very weak tags.
    rating: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct VnProducer {
    name: Option<String>,
}

/// Request body for a Kana query.
#[derive(Debug, Serialize)]
struct KanaQuery<'a> {
    filters: serde_json::Value,
    fields: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    results: Option<u32>,
}

/// VNDB reports 0-100; convert to the 0-10 the rest of the app uses.
fn normalise(score: Option<f64>) -> Option<f64> {
    let score = score?;
    if !score.is_finite() || score <= 0.0 {
        return None;
    }
    Some((score / 10.0).clamp(0.0, 10.0))
}

/// Strip VNDB's inline formatting codes.
///
/// VNDB descriptions embed markup such as `[url=/v123]` and `[b]`; leaving it in
/// would show raw syntax in the description field.
fn strip_markup(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut depth = 0usize;
    for ch in input.chars() {
        match ch {
            '[' => depth += 1,
            ']' if depth > 0 => depth -= 1,
            _ if depth == 0 => out.push(ch),
            _ => {}
        }
    }
    out.trim().to_string()
}

/// The Japanese/original title, from the `main`-flagged entry when present.
fn original_title(vn: &Vn) -> Option<String> {
    vn.titles
        .iter()
        .find(|t| t.lang.as_deref() == Some("ja"))
        .and_then(|t| t.title.clone())
        .or_else(|| vn.alttitle.clone())
        .filter(|s| !s.trim().is_empty())
}

async fn post(body: KanaQuery<'_>) -> super::CmdResult<Vec<Vn>> {
    let response = super::http_client()?
        .post(ENDPOINT)
        .header("Accept", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|error| super::CmdError(format!("VNDB 请求失败：{error}")))?;

    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        // 429 is the documented rate-limit response and is worth naming.
        let hint = if status.as_u16() == 429 {
            "（已触发 VNDB 限流：200 次/5 分钟）"
        } else {
            ""
        };
        return Err(super::CmdError(format!(
            "VNDB 返回 HTTP {status}{hint}：{}",
            text.chars().take(200).collect::<String>()
        )));
    }

    let parsed: KanaResponse = response
        .json()
        .await
        .map_err(|error| super::CmdError(format!("VNDB 响应解析失败：{error}")))?;
    Ok(parsed.results)
}

/// Search VNDB by title.
pub async fn search(query: &str, limit: u32) -> super::CmdResult<Vec<MetadataCandidate>> {
    let results = post(KanaQuery {
        filters: serde_json::json!(["search", "=", query]),
        fields: SEARCH_FIELDS,
        results: Some(limit.clamp(1, 25)),
    })
    .await?;

    Ok(results
        .into_iter()
        .map(|vn| {
            let title = vn.title.clone().unwrap_or_else(|| vn.id.clone());
            let original = original_title(&vn).filter(|o| *o != title);
            MetadataCandidate {
                provider: Provider::Vndb,
                external_id: vn.id.clone(),
                title,
                original_title: original,
                release_date: vn.released.clone(),
                cover_url: vn.image.as_ref().and_then(|i| i.url.clone()),
                rating: normalise(vn.rating).or_else(|| normalise(vn.average)),
                source_label: "VNDB".to_string(),
            }
        })
        .collect())
}

/// Fetch one VN by id.
pub async fn detail(id: &str) -> super::CmdResult<MetadataDetail> {
    let results = post(KanaQuery {
        filters: serde_json::json!(["id", "=", id]),
        fields: DETAIL_FIELDS,
        results: Some(1),
    })
    .await?;

    let vn = results
        .into_iter()
        .next()
        .ok_or_else(|| super::CmdError(format!("VNDB 未找到 {id}")))?;

    let rating = normalise(vn.rating).or_else(|| normalise(vn.average));
    let ratings = rating
        .map(|score| {
            vec![SourceRating {
                source: "vndb".to_string(),
                score,
                vote_count: vn.votecount,
            }]
        })
        .unwrap_or_default();

    // VNDB tags carry a 0-3 weight; very low-weight tags are noise.
    let tags: Vec<String> = vn
        .tags
        .iter()
        .filter(|t| t.rating.unwrap_or(0.0) >= 1.0)
        .filter_map(|t| t.name.clone())
        .collect();

    let mut description = vn.description.clone().map(|d| strip_markup(&d));
    if description
        .as_deref()
        .map(|d: &str| d.trim().is_empty())
        .unwrap_or(false)
    {
        description = None;
    }

    Ok(MetadataDetail {
        provider: Some(Provider::Vndb),
        external_id: Some(vn.id.clone()),
        title: vn.title.clone().unwrap_or_else(|| vn.id.clone()),
        title_zh: None,
        title_original: original_title(&vn),
        developer: vn.developers.first().and_then(|d| d.name.clone()),
        release_date: vn.released.clone(),
        rating: super::merge::pick_rating(&ratings),
        ratings,
        cover_url: vn.image.as_ref().and_then(|i| i.url.clone()),
        description,
        description_lang: Some("en".to_string()),
        tags: super::merge::dedupe_tags(tags),
        vndb_id: Some(vn.id.clone()),
        bangumi_id: None,
        attribution: Some("VNDB".to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalise_converts_vndb_hundred_scale_to_ten() {
        assert_eq!(normalise(Some(87.2)), Some(8.72));
        assert_eq!(normalise(Some(100.0)), Some(10.0));
        assert_eq!(normalise(Some(0.0)), None, "unrated is not a zero score");
        assert_eq!(normalise(None), None);
    }

    #[test]
    fn strip_markup_removes_vndb_inline_codes() {
        let input = "A [url=/v123]link[/url] and [b]bold[/b] text";
        assert_eq!(strip_markup(input), "A link and bold text");
    }

    #[test]
    fn strip_markup_leaves_plain_text_untouched() {
        assert_eq!(strip_markup("plain text"), "plain text");
    }
}
