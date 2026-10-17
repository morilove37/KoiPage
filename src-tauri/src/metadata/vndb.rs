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
///
/// `titles` is included so the result list can prefer a Chinese title (VNDB
/// carries official `zh-Hans`/`zh-Hant` names for localized releases) instead of
/// falling back to the romanised primary title.
const SEARCH_FIELDS: &str = "id,title,alttitle,titles{lang,title,latin,official,main},\
released,image.url,rating,votecount";

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
    /// Official localizations are preferred over unofficial fan translations.
    #[serde(default)]
    official: bool,
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

/// A Chinese title from VNDB's multilingual `titles` list.
///
/// VNDB lists official localizations (`zh-Hans` / `zh-Hant`) for many releases.
/// They are the reason importing from VNDB does not have to fall back to the
/// romanised English title: prefer official translations, then any Chinese one.
fn chinese_title(vn: &Vn) -> Option<String> {
    let mut unofficial: Option<String> = None;
    for title in &vn.titles {
        let Some(lang) = title.lang.as_deref() else {
            continue;
        };
        if !lang.to_ascii_lowercase().starts_with("zh") {
            continue;
        }
        let Some(value) = title
            .title
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        if title.official {
            return Some(value.to_string());
        }
        unofficial.get_or_insert_with(|| value.to_string());
    }
    unofficial
}

/// Pick the title shown in the result list and the alternate kept as 原名.
///
/// Order: Chinese (official first) → original-script → VNDB's romanised title.
/// The alternate is the first non-equal candidate from original/Latin, so a
/// Chinese display name keeps the Japanese name visible as 原名.
fn display_titles(vn: &Vn) -> (String, Option<String>) {
    let chinese = chinese_title(vn);
    let original = original_title(vn);
    let latin = vn
        .title
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    let title = chinese
        .clone()
        .or_else(|| original.clone())
        .or_else(|| latin.clone())
        .unwrap_or_else(|| vn.id.clone());
    let alternate = original
        .into_iter()
        .chain(latin)
        .find(|candidate| candidate != &title);
    (title, alternate)
}

/// Extra spellings for auto-fetch matching only.
///
/// When the display title becomes Chinese, the romanised title and original
/// script still have to match a folder named `Sabbat of the Witch` or
/// `サノバウィッチ`.
fn matching_aliases(vn: &Vn, title: &str, original: Option<&str>) -> Vec<String> {
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
    push(vn.title.as_deref());
    push(vn.alttitle.as_deref());
    for entry in &vn.titles {
        push(entry.title.as_deref());
        push(entry.latin.as_deref());
    }
    aliases
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
            // Chinese when VNDB knows one, Japanese otherwise; the romanised
            // title is never the display name.
            let (title, original) = display_titles(&vn);
            let aliases = matching_aliases(&vn, &title, original.as_deref());
            MetadataCandidate {
                provider: Provider::Vndb,
                external_id: vn.id.clone(),
                title,
                original_title: original,
                aliases,
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
        title_zh: chinese_title(&vn),
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

    fn vn_with_titles(titles: &[(&str, &str, bool)], primary: &str) -> Vn {
        Vn {
            id: "v16044".to_string(),
            title: Some(primary.to_string()),
            alttitle: Some("サノバウィッチ".to_string()),
            released: None,
            image: None,
            rating: None,
            average: None,
            votecount: None,
            length_minutes: None,
            description: None,
            titles: titles
                .iter()
                .map(|(lang, title, official)| VnTitle {
                    lang: Some(lang.to_string()),
                    title: Some(title.to_string()),
                    latin: None,
                    official: *official,
                    main: *lang == "ja",
                })
                .collect(),
            tags: Vec::new(),
            developers: Vec::new(),
        }
    }

    #[test]
    fn chinese_title_prefers_an_official_localization() {
        let vn = vn_with_titles(
            &[
                ("en", "Sabbat of the Witch", true),
                ("ja", "サノバウィッチ", true),
                ("zh-Hant", "魔女的夜宴", false),
                ("zh-Hans", "魔女的夜宴", true),
            ],
            "Sanoba Witch",
        );
        assert_eq!(chinese_title(&vn).as_deref(), Some("魔女的夜宴"));

        let unofficial_only = vn_with_titles(
            &[("ja", "サノバウィッチ", true), ("zh-Hant", "魔女的夜宴", false)],
            "Sanoba Witch",
        );
        assert_eq!(chinese_title(&unofficial_only).as_deref(), Some("魔女的夜宴"));

        let no_chinese = vn_with_titles(&[("ja", "サノバウィッチ", true)], "Sanoba Witch");
        assert_eq!(chinese_title(&no_chinese), None);
    }

    #[test]
    fn display_titles_never_uses_the_romanised_title_when_localized_ones_exist() {
        // Chinese available: becomes the display title, Japanese stays 原名.
        let chinese = vn_with_titles(
            &[
                ("en", "Sabbat of the Witch", true),
                ("ja", "サノバウィッチ", true),
                ("zh-Hans", "魔女的夜宴", true),
            ],
            "Sanoba Witch",
        );
        assert_eq!(
            display_titles(&chinese),
            ("魔女的夜宴".to_string(), Some("サノバウィッチ".to_string()))
        );

        // No Chinese: the original-script name wins and Latin becomes 原名.
        let japanese = vn_with_titles(&[("ja", "サノバウィッチ", true)], "Sanoba Witch");
        assert_eq!(
            display_titles(&japanese),
            ("サノバウィッチ".to_string(), Some("Sanoba Witch".to_string()))
        );
    }

    #[test]
    fn matching_aliases_keep_the_english_names_out_of_the_display_title() {
        let vn = vn_with_titles(
            &[
                ("en", "Sabbat of the Witch", true),
                ("ja", "サノバウィッチ", true),
                ("zh-Hans", "魔女的夜宴", true),
            ],
            "Sanoba Witch",
        );
        let (title, original) = display_titles(&vn);
        let aliases = matching_aliases(&vn, &title, original.as_deref());
        assert!(aliases.iter().any(|alias| alias == "Sabbat of the Witch"));
        assert!(aliases.iter().any(|alias| alias == "Sanoba Witch"));
        assert!(!aliases.iter().any(|alias| alias == "魔女的夜宴"));
        assert!(!aliases.iter().any(|alias| alias == "サノバウィッチ"));
    }
}
