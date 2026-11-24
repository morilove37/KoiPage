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
aliases,olang,released,image.url,image.thumbnail,image.sexual,image.violence,average,rating,votecount,\
length_minutes,description,tags{id,name,rating,spoiler,category},developers{id,name}";

/// Smaller field set for search results.
///
/// `titles` is included so the result list can prefer a Chinese title (VNDB
/// carries official `zh-Hans`/`zh-Hant` names for localized releases) instead of
/// falling back to the romanised primary title.
const SEARCH_FIELDS: &str = "id,title,alttitle,titles{lang,title,latin,official,main},\
released,image.url,rating,votecount";

/// Fields for a relations lookup: the VN itself plus its directly related VNs.
///
/// The nested `relations` selection repeats the fields rendered per row so the
/// whole graph arrives in one request; VNDB charges one request per call.
const RELATION_FIELDS: &str = "id,title,alttitle,released,rating,image{url,sexual},\
relations{id,relation,title,alttitle,released,rating,image{url,sexual},\
titles{lang,title,official,main}}";

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
    /// Directly related VNs (sequels, prequels, fandiscs, ...). Only populated
    /// when the query selects `relations`.
    #[serde(default)]
    relations: Vec<VnRelation>,
}

#[derive(Debug, Deserialize)]
struct VnImage {
    url: Option<String>,
    sexual: Option<f64>,
    violence: Option<f64>,
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
    category: Option<String>,
}

#[derive(Debug, Deserialize)]
struct VnProducer {
    name: Option<String>,
}

/// One entry of VNDB's `relations` array (a single related VN).
///
/// `relation` is the VNDB relation code (`seq`, `preq`, `set`, ...); the
/// human-readable Chinese label is derived on the way out by [`relation_label`].
#[derive(Debug, Deserialize)]
struct VnRelation {
    id: String,
    relation: String,
    title: Option<String>,
    alttitle: Option<String>,
    released: Option<String>,
    /// 0-100.
    rating: Option<f64>,
    image: Option<VnImage>,
    /// All known titles; relations carry the same `titles` shape as a full VN,
    /// so the Chinese localization can be shown instead of the romaji title.
    #[serde(default)]
    titles: Vec<VnTitle>,
}

/// A related VN, flattened for the frontend.
///
/// Serialised in camelCase because the TypeScript side consumes it directly.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VndbRelation {
    pub id: String,
    /// Raw VNDB relation code, kept so the UI can style or group rows.
    pub relation: String,
    /// Chinese label for `relation`, e.g. 续作 / 外传 / 相关.
    pub relation_label: String,
    pub title: String,
    pub original_title: Option<String>,
    pub release_date: Option<String>,
    pub rating: Option<f64>,
    pub cover_url: Option<String>,
    pub nsfw: Option<bool>,
    /// Canonical VNDB page for the related VN.
    pub url: String,
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
    chinese_title_of(&vn.titles)
}

/// [`chinese_title`] over a bare title list.
///
/// Split out because `relations` entries carry the same `titles` shape but are
/// not full [`Vn`] values.
fn chinese_title_of(titles: &[VnTitle]) -> Option<String> {
    let mut unofficial: Option<String> = None;
    for title in titles {
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

/// Chinese label for a VNDB relation code.
///
/// VNDB's documented codes are finite; anything new or unexpected degrades to
/// 相关 instead of leaking the raw code into the UI.
fn relation_label(code: &str) -> &'static str {
    match code {
        "seq" => "续作",
        "preq" => "前作",
        "set" => "同设定",
        "alt" => "外传",
        "char" => "角色作",
        "side" => "旁支",
        "par" => "同世界观",
        "ser" => "同系列",
        "fan" => "同人",
        "orig" => "原作",
        "misc" => "其他",
        "unknown" => "相关",
        _ => "相关",
    }
}

/// Shared Kana POST: sends `body`, enforces the error contract, parses JSON.
///
/// Generic over the response type so each lookup can name its own shape while
/// every request keeps the identical timeout / rate-limit / parse error strings.
async fn post_typed<T: serde::de::DeserializeOwned>(body: KanaQuery<'_>) -> super::CmdResult<T> {
    let response = super::http_client()?
        .post(ENDPOINT)
        .header("Accept", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|error| {
            let hint = crate::net::proxy::failure_hint();
            super::CmdError(if error.is_timeout() {
                format!("VNDB 请求超时，请稍后重试{hint}")
            } else {
                format!("VNDB 请求失败：{error}{hint}")
            })
        })?;

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

    response
        .json()
        .await
        .map_err(|error| super::CmdError(format!("VNDB 响应解析失败：{error}")))
}

/// Standard `results`-shaped query, kept for the existing search/detail callers.
async fn post(body: KanaQuery<'_>) -> super::CmdResult<Vec<Vn>> {
    post_typed::<KanaResponse>(body)
        .await
        .map(|parsed| parsed.results)
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

    Ok(detail_from_vn(vn))
}

fn detail_from_vn(vn: Vn) -> MetadataDetail {
    // https://api.vndb.org/kana: image flags are 0..=2 and `ero` tags
    // describe sexual content. Absence/zero only describes the selected cover,
    // so it must never certify that the whole game is suitable for all ages.
    let nsfw = (vn.tags.iter().any(|tag| tag.category.as_deref() == Some("ero"))
        || vn.image.as_ref().is_some_and(|image| {
            [image.sexual, image.violence].into_iter().flatten().any(|value| value.is_finite() && value > 0.0)
        })).then_some(true);

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

    MetadataDetail {
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
        description_source: Some(Provider::Vndb),
        description_options: vec![],
        tags: super::merge::dedupe_tags(tags),
        vndb_id: Some(vn.id.clone()),
        bangumi_id: None,
        nsfw,
        attribution: Some("VNDB".to_string()),
    }
}

/// Project one raw relation entry into the flattened frontend struct.
fn relation_from_vn(entry: VnRelation) -> VndbRelation {
    let id = entry.id.clone();
    let clean = |value: Option<&String>| {
        value
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    };
    let romaji = clean(entry.title.as_ref());
    let original = clean(entry.alttitle.as_ref());
    // Prefer the Chinese localization, then the original script, then romaji.
    let chinese = chinese_title_of(&entry.titles);
    let title = chinese
        .clone()
        .or_else(|| original.clone())
        .or_else(|| romaji.clone())
        .unwrap_or_else(|| id.clone());
    // Keep whichever name adds information over the displayed title: when the
    // title is already the original script, the romaji spelling is the useful
    // second line, and vice versa.
    let original_title = [original.clone(), romaji.clone()]
        .into_iter()
        .flatten()
        .find(|value| value != &title);
    // A cover's `sexual` flag describes that image only; zero/absent means
    // "no evidence", never "safe for all ages".
    let nsfw = entry
        .image
        .as_ref()
        .and_then(|image| image.sexual)
        .map(|sexual| sexual > 0.0);
    let cover_url = entry.image.as_ref().and_then(|image| image.url.clone());

    VndbRelation {
        id: id.clone(),
        relation: entry.relation.clone(),
        relation_label: relation_label(&entry.relation).to_string(),
        title,
        original_title,
        release_date: entry.released.clone(),
        rating: normalise(entry.rating),
        cover_url,
        nsfw,
        url: format!("https://vndb.org/{id}"),
    }
}

/// Related VNs for one VN (sequels, prequels, fandiscs, ...).
///
/// A VN with no relations is a normal, non-error answer and yields an empty
/// list; only a missing VN is reported as 未找到.
pub async fn relations(id: &str) -> super::CmdResult<Vec<VndbRelation>> {
    let parsed = post_typed::<KanaResponse>(KanaQuery {
        filters: serde_json::json!(["id", "=", id]),
        fields: RELATION_FIELDS,
        results: Some(1),
    })
    .await?;

    let vn = parsed
        .results
        .into_iter()
        .next()
        .ok_or_else(|| super::CmdError(format!("VNDB 未找到 {id}")))?;

    Ok(vn.relations.into_iter().map(relation_from_vn).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adult_source_evidence_survives_vndb_projection_without_guessing_safe_from_a_cover() {
        let adult: Vn = serde_json::from_value(serde_json::json!({"id":"v1","tags":[{"name":"Sexual Content","category":"ero","rating":2.5}]})).unwrap();
        assert_eq!(detail_from_vn(adult).nsfw, Some(true));
        let adult_image: Vn = serde_json::from_value(serde_json::json!({"id":"v2","image":{"url":"https://example.test/a.jpg","sexual":1.2,"violence":0.0}})).unwrap();
        assert_eq!(detail_from_vn(adult_image).nsfw, Some(true));
        let safe_cover: Vn = serde_json::from_value(serde_json::json!({"id":"v3","image":{"sexual":0.0,"violence":0.0}})).unwrap();
        assert_eq!(detail_from_vn(safe_cover).nsfw, None);
    }

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
            relations: Vec::new(),
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

    #[test]
    fn relation_label_maps_every_vndb_code_to_chinese() {
        assert_eq!(relation_label("seq"), "续作");
        assert_eq!(relation_label("preq"), "前作");
        assert_eq!(relation_label("set"), "同设定");
        assert_eq!(relation_label("alt"), "外传");
        assert_eq!(relation_label("char"), "角色作");
        assert_eq!(relation_label("side"), "旁支");
        assert_eq!(relation_label("par"), "同世界观");
        assert_eq!(relation_label("ser"), "同系列");
        assert_eq!(relation_label("fan"), "同人");
        assert_eq!(relation_label("orig"), "原作");
        assert_eq!(relation_label("misc"), "其他");
        assert_eq!(relation_label("unknown"), "相关");
        // New/unknown codes must never leak into the UI verbatim.
        assert_eq!(relation_label("brand_new_code"), "相关");
        assert_eq!(relation_label(""), "相关");
    }

    #[test]
    fn kana_response_with_relations_projects_into_vndb_relations() {
        // Shape copied from a real Kana `/vn` response: `results` holds the
        // queried VN and each entry carries a nested `relations` array.
        let fixture = r#"{
            "results": [{
                "id": "v16044",
                "title": "Sanoba Witch",
                "alttitle": "サノバウィッチ",
                "released": "2015-02-27",
                "rating": 84.6,
                "image": {"url": "https://t.vndb.org/cv/44/16044.jpg", "sexual": 0.4},
                "relations": [
                    {
                        "id": "v17785",
                        "relation": "seq",
                        "title": "Sabbat of the Witch",
                        "alttitle": "サノバウィッチ 続編",
                        "released": "2016-06-24",
                        "rating": 80.0,
                        "image": {"url": "https://t.vndb.org/cv/85/17785.jpg", "sexual": 1.8},
                        "titles": [
                            {"lang": "ja", "title": "サノバウィッチ 続編", "official": true, "main": true},
                            {"lang": "zh-Hans", "title": "魔女的夜宴 续篇", "official": false, "main": false}
                        ]
                    },
                    {
                        "id": "v21755",
                        "relation": "fan",
                        "title": "Sanoba Witch Fandisc",
                        "released": "2018-01-26",
                        "rating": 0.0,
                        "image": {"url": "https://t.vndb.org/cv/55/21755.jpg", "sexual": 0.0}
                    },
                    {
                        "id": "v99999",
                        "relation": "par",
                        "title": "Related But Bare",
                        "alttitle": "関連作"
                    }
                ]
            }],
            "more": false
        }"#;

        let parsed: KanaResponse = serde_json::from_str(fixture).unwrap();
        assert_eq!(parsed.results.len(), 1);
        let vn = parsed.results.into_iter().next().unwrap();
        assert_eq!(vn.relations.len(), 3);

        let relations: Vec<VndbRelation> = vn.relations.into_iter().map(relation_from_vn).collect();

        let sequel = &relations[0];
        assert_eq!(sequel.id, "v17785");
        assert_eq!(sequel.relation, "seq");
        assert_eq!(sequel.relation_label, "续作");
        assert_eq!(sequel.title, "魔女的夜宴 续篇", "Chinese localization wins over romaji");
        assert_eq!(sequel.original_title.as_deref(), Some("サノバウィッチ 続編"));
        assert_eq!(sequel.release_date.as_deref(), Some("2016-06-24"));
        assert_eq!(sequel.rating, Some(8.0), "0-100 is normalised to 0-10");
        assert_eq!(sequel.cover_url.as_deref(), Some("https://t.vndb.org/cv/85/17785.jpg"));
        assert_eq!(sequel.nsfw, Some(true));
        assert_eq!(sequel.url, "https://vndb.org/v17785");

        let fandisc = &relations[1];
        assert_eq!(fandisc.relation_label, "同人");
        assert_eq!(fandisc.original_title, None, "alttitle absent -> no 原名");
        assert_eq!(fandisc.rating, None, "a zero rating is unrated, not 0.0");
        assert_eq!(fandisc.nsfw, Some(false), "sexual 0.0 is evidence of a safe cover");

        let bare = &relations[2];
        assert_eq!(bare.relation_label, "同世界观");
        assert_eq!(bare.title, "関連作", "no Chinese -> original script is the title");
        assert_eq!(bare.original_title.as_deref(), Some("Related But Bare"));
        assert_eq!(bare.release_date, None);
        assert_eq!(bare.rating, None);
        assert_eq!(bare.cover_url, None);
        assert_eq!(bare.nsfw, None, "no image -> no evidence either way");
        assert_eq!(bare.url, "https://vndb.org/v99999");
    }

    #[test]
    fn vn_without_relations_yields_an_empty_relation_list() {
        // Absent `relations` must not be an error: VNDB simply omits or empties it.
        let parsed: KanaResponse =
            serde_json::from_str(r#"{"results":[{"id":"v1","title":"Lonely"}]}"#).unwrap();
        let vn = parsed.results.into_iter().next().unwrap();
        assert!(vn.relations.is_empty());
    }
}
