//! Bangumi (`bgm.tv`) API v0 provider.
//!
//! Two endpoints, verified live:
//!
//! - `POST https://api.bgm.tv/v0/search/subjects?limit=N` with
//!   `{"keyword": "...", "filter": {"type": [4]}}` — `type: 4` selects games.
//! - `GET  https://api.bgm.tv/v0/subjects/{id}`
//!
//! Public subjects allow anonymous reads; restricted adult subjects need the
//! saved personal token even when collection synchronization is turned off.
//!
//! ## Why this provider matters
//!
//! `name_cn` is the only reliable source of Chinese titles across the three
//! providers, and `rating.score` is already 0-10 — the same scale
//! `games.rating` stores, preserving the supplied decimal precision.

use serde::{Deserialize, Serialize};

use super::{MetadataCandidate, MetadataDetail, Provider, SourceRating};

const SEARCH: &str = "https://api.bgm.tv/v0/search/subjects";
const SUBJECT: &str = "https://api.bgm.tv/v0/subjects";

/// Bangumi's subject type id for "game".
const TYPE_GAME: i64 = 4;

#[derive(Debug, Deserialize)]
struct SearchResponse {
    #[serde(default)]
    data: Vec<Subject>,
}

#[derive(Debug, Deserialize)]
struct Subject {
    id: i64,
    name: Option<String>,
    /// Chinese title; frequently empty, so never assume it exists.
    name_cn: Option<String>,
    date: Option<String>,
    images: Option<Images>,
    summary: Option<String>,
    /// Only present on the detail endpoint.
    rating: Option<Rating>,
    #[serde(default)]
    tags: Vec<Tag>,
    #[serde(default)]
    infobox: Vec<Infobox>,
}

#[derive(Debug, Deserialize)]
struct Images {
    large: Option<String>,
    common: Option<String>,
    medium: Option<String>,
}

impl Images {
    fn best(&self) -> Option<String> {
        self.large
            .clone()
            .or_else(|| self.common.clone())
            .or_else(|| self.medium.clone())
            .filter(|u| !u.trim().is_empty())
    }
}

#[derive(Debug, Deserialize)]
struct Rating {
    /// Already 0-10.
    score: Option<f64>,
    total: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct Tag {
    name: Option<String>,
    count: Option<i64>,
}

/// `infobox` is a list of `{key, value}` pairs where `value` is a string or a
/// list of `{v}` objects, so it stays as raw JSON and is interpreted by lookup.
#[derive(Debug, Deserialize)]
struct Infobox {
    key: Option<String>,
    value: Option<serde_json::Value>,
}

/// Alternative title entries in the infobox, used to find the Japanese name.
const ALIAS_KEYS: &[&str] = &["别名", "別名", "alias", "中文名"];
/// Developer-ish infobox keys, in preference order.
const DEV_KEYS: &[&str] = &[
    "开发",
    "遊戲開發",
    "开发厂商",
    "遊戲開發商",
    "开发商",
    "出版社",
];

#[derive(Debug, Serialize)]
struct SearchBody<'a> {
    keyword: &'a str,
    filter: SearchFilter,
}

#[derive(Debug, Serialize)]
struct SearchFilter {
    #[serde(rename = "type")]
    kind: Vec<i64>,
    // Official v0 schema: null returns all visible subjects; true returns ONLY
    // adult subjects, excluding the ordinary all-age results.
    nsfw: Option<bool>,
}

fn request_with_token(
    method: reqwest::Method,
    url: &str,
    token: Option<&str>,
) -> super::CmdResult<reqwest::RequestBuilder> {
    let url =
        reqwest::Url::parse(url).map_err(|_| super::CmdError("Bangumi 请求地址无效".into()))?;
    if url.scheme() != "https"
        || url.host_str() != Some("api.bgm.tv")
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(super::CmdError("Bangumi 令牌仅可用于官方 API".into()));
    }
    let client = reqwest::Client::builder()
        .user_agent(super::USER_AGENT)
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|_| super::CmdError("无法创建 Bangumi 资料连接".into()))?;
    let mut request = client
        .request(method, url)
        .header("Accept", "application/json");
    if let Some(token) = token {
        let mut authorization = reqwest::header::HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|_| super::CmdError("Bangumi 令牌格式无效，请在设置中重新连接".into()))?;
        authorization.set_sensitive(true);
        request = request.header(reqwest::header::AUTHORIZATION, authorization);
    }
    Ok(request)
}

fn request(method: reqwest::Method, url: &str) -> super::CmdResult<reqwest::RequestBuilder> {
    #[cfg(windows)]
    let token = crate::bangumi_sync::credentials::load()?;
    #[cfg(not(windows))]
    let token: Option<String> = None;
    request_with_token(method, url, token.as_deref())
}

fn response_error(status: reqwest::StatusCode) -> super::CmdError {
    let message = match status.as_u16() {
        401 => "Bangumi 令牌已失效，请在设置 → Bangumi 同步中重新验证并保存令牌",
        403 => "Bangumi 拒绝读取资料，请检查账号权限及个人令牌",
        404 => "Bangumi 条目不存在或当前账号无权读取；部分成人条目需要个人令牌",
        429 => "Bangumi 请求过于频繁，请稍后重试",
        _ => "Bangumi 资料请求失败",
    };
    super::CmdError(format!("{message}（HTTP {status}）"))
}

pub(crate) fn missing_binding_hint() -> (bool, String) {
    match crate::bangumi_sync::credentials::load() {
        Ok(None) => (true, "尚未保存 Bangumi 个人令牌，匿名查询可能缺少成人条目。请在「设置 → Bangumi 同步」验证并保存令牌后重试，无需开启自动同步".into()),
        Ok(Some(_)) => (false, "Bangumi ID 未找到唯一可信匹配。请检查令牌有效性、账号访问权限，或在作品详情中手动确认".into()),
        Err(_) => (true, "无法读取已保存的 Bangumi 令牌，请在「设置 → Bangumi 同步」重新验证并保存后重试".into()),
    }
}

/// Flatten an infobox value into plain strings.
///
/// Bangumi returns either `"string"` or `[{"v": "..."}, ...]` depending on the
/// key, so both shapes must be handled.
fn infobox_strings(value: &serde_json::Value) -> Vec<String> {
    match value {
        serde_json::Value::String(s) => vec![s.clone()],
        serde_json::Value::Array(items) => items
            .iter()
            .filter_map(|item| {
                item.get("v")
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
                    .or_else(|| item.as_str().map(str::to_string))
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// Look up the first infobox entry matching any of `keys`.
fn infobox_lookup<'a>(boxes: &'a [Infobox], keys: &[&str]) -> Option<&'a serde_json::Value> {
    keys.iter().find_map(|key| {
        boxes
            .iter()
            .find(|b| b.key.as_deref() == Some(*key))
            .and_then(|b| b.value.as_ref())
    })
}

/// The Japanese/other-language title from the alias infobox entry.
fn alias_title(subject: &Subject) -> Option<String> {
    let raw = infobox_lookup(&subject.infobox, ALIAS_KEYS)?;
    // Alias entries are "Japanese | English | ..." in practice; take the part
    // that is not already the display title.
    infobox_strings(raw)
        .into_iter()
        .flat_map(|entry| {
            entry
                .split(['|', '／', '/'])
                .map(|part| part.trim().to_string())
                .collect::<Vec<_>>()
        })
        .find(|part| {
            !part.is_empty()
                && Some(part.as_str()) != subject.name.as_deref()
                && Some(part.as_str()) != subject.name_cn.as_deref()
        })
}

/// The developer/studio from the infobox.
fn developer(subject: &Subject) -> Option<String> {
    let raw = infobox_lookup(&subject.infobox, DEV_KEYS)?;
    infobox_strings(raw)
        .into_iter()
        .next()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Bangumi scores are already 0-10; guard against unexpected scales.
fn normalise(score: Option<f64>) -> Option<f64> {
    let score = score?;
    if !score.is_finite() || score <= 0.0 {
        return None;
    }
    let scaled = if score > 10.0 { score / 10.0 } else { score };
    Some(scaled.clamp(0.0, 10.0))
}

/// Prefer the Chinese title, falling back to the primary name.
fn best_title(subject: &Subject) -> String {
    subject
        .name_cn
        .clone()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| subject.name.clone())
        .unwrap_or_else(|| subject.id.to_string())
}

/// Search Bangumi for games matching `query`.
pub async fn search(query: &str, limit: u32) -> super::CmdResult<Vec<MetadataCandidate>> {
    let url = format!("{SEARCH}?limit={}", limit.clamp(1, 25));
    let response = request(reqwest::Method::POST, &url)?
        .json(&SearchBody {
            keyword: query,
            filter: SearchFilter {
                kind: vec![TYPE_GAME],
                nsfw: None,
            },
        })
        .send()
        .await
        .map_err(|_| super::CmdError("Bangumi 搜索失败，请检查网络后重试".into()))?;

    let status = response.status();
    if !status.is_success() {
        return Err(response_error(status));
    }

    let parsed: SearchResponse = response
        .json()
        .await
        .map_err(|_| super::CmdError("Bangumi 搜索结果格式无法识别".into()))?;

    Ok(parsed
        .data
        .into_iter()
        .map(|subject| {
            let title = best_title(&subject);
            let original = subject
                .name
                .clone()
                .filter(|n| *n != title)
                .or_else(|| alias_title(&subject));
            // Bangumi's name/name_cn/别名 are all useful for matching an English
            // or Japanese folder even when the display title is Chinese.
            let alias = alias_title(&subject);
            let mut aliases: Vec<String> = Vec::new();
            for value in [
                subject.name.as_deref(),
                subject.name_cn.as_deref(),
                alias.as_deref(),
            ]
            .into_iter()
            .flatten()
            {
                let value = value.trim();
                if value.is_empty() || value == title || Some(value) == original.as_deref() {
                    continue;
                }
                if !aliases.iter().any(|existing| existing == value) {
                    aliases.push(value.to_string());
                }
            }
            MetadataCandidate {
                provider: Provider::Bangumi,
                external_id: subject.id.to_string(),
                title,
                original_title: original,
                aliases,
                release_date: subject.date.clone(),
                cover_url: subject.images.as_ref().and_then(Images::best),
                rating: normalise(subject.rating.as_ref().and_then(|r| r.score)),
                source_label: "Bangumi".to_string(),
            }
        })
        .collect())
}

/// Fetch one subject by id.
pub async fn detail(id: &str) -> super::CmdResult<MetadataDetail> {
    let url = format!("{SUBJECT}/{}", id.trim());
    let response = request(reqwest::Method::GET, &url)?
        .send()
        .await
        .map_err(|_| super::CmdError("Bangumi 详情读取失败，请检查网络后重试".into()))?;

    let status = response.status();
    if !status.is_success() {
        return Err(response_error(status));
    }

    let subject: Subject = response
        .json()
        .await
        .map_err(|_| super::CmdError("Bangumi 详情结果格式无法识别".into()))?;

    let score = normalise(subject.rating.as_ref().and_then(|r| r.score));
    let ratings = score
        .map(|score| {
            vec![SourceRating {
                source: "bangumi".to_string(),
                score,
                vote_count: subject.rating.as_ref().and_then(|r| r.total),
            }]
        })
        .unwrap_or_default();

    // Sort tags by vote count so the most agreed-upon ones come first.
    let mut tags: Vec<(String, i64)> = subject
        .tags
        .iter()
        .filter_map(|t| Some((t.name.clone()?, t.count.unwrap_or(0))))
        .collect();
    tags.sort_by(|a, b| b.1.cmp(&a.1));

    let summary = subject.summary.clone().filter(|s| !s.trim().is_empty());

    Ok(MetadataDetail {
        provider: Some(Provider::Bangumi),
        external_id: Some(subject.id.to_string()),
        title: subject
            .name
            .clone()
            .unwrap_or_else(|| subject.id.to_string()),
        title_zh: subject.name_cn.clone().filter(|s| !s.trim().is_empty()),
        title_original: alias_title(&subject),
        developer: developer(&subject),
        release_date: subject.date.clone(),
        rating: super::merge::pick_rating(&ratings),
        ratings,
        cover_url: subject.images.as_ref().and_then(Images::best),
        description: summary,
        description_lang: Some("zh-Hans".to_string()),
        description_source: Some(Provider::Bangumi),
        description_options: vec![],
        tags: super::merge::dedupe_tags(tags.into_iter().map(|(name, _)| name)),
        vndb_id: None,
        bangumi_id: Some(subject.id.to_string()),
        attribution: Some("Bangumi".to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metadata_requests_use_the_saved_token_without_exposing_it() {
        let request =
            request_with_token(reqwest::Method::POST, SEARCH, Some("fake-metadata-token"))
                .unwrap()
                .build()
                .unwrap();
        let auth = request
            .headers()
            .get(reqwest::header::AUTHORIZATION)
            .expect("metadata lookup needs authorization too");
        assert_eq!(auth.to_str().unwrap(), "Bearer fake-metadata-token");
        assert!(auth.is_sensitive());
        assert!(!format!("{request:?}").contains("fake-metadata-token"));
        let anonymous = request_with_token(reqwest::Method::GET, SUBJECT, None)
            .unwrap()
            .build()
            .unwrap();
        assert!(
            !anonymous
                .headers()
                .contains_key(reqwest::header::AUTHORIZATION)
        );
    }

    #[test]
    fn metadata_credentials_are_restricted_to_the_bangumi_api_origin() {
        for url in [
            "http://api.bgm.tv/v0/subjects",
            "https://example.com/",
            "https://api.bgm.tv.example.com/",
        ] {
            assert!(
                request_with_token(reqwest::Method::GET, url, Some("fake-metadata-token")).is_err()
            );
        }
    }

    #[test]
    fn search_keeps_all_age_and_authorized_adult_results_together() {
        let body = serde_json::to_value(SearchBody {
            keyword: "test",
            filter: SearchFilter {
                kind: vec![TYPE_GAME],
                nsfw: None,
            },
        })
        .unwrap();
        assert!(body["filter"].as_object().unwrap().contains_key("nsfw"));
        assert!(body["filter"]["nsfw"].is_null());
    }

    #[test]
    fn infobox_handles_both_string_and_object_values() {
        let plain = serde_json::json!("Key");
        assert_eq!(infobox_strings(&plain), vec!["Key"]);

        let nested = serde_json::json!([{"v": "Key"}, {"v": "VISUAL ARTS"}]);
        assert_eq!(infobox_strings(&nested), vec!["Key", "VISUAL ARTS"]);
    }

    #[test]
    fn normalise_repairs_a_hundred_scale_score() {
        assert_eq!(normalise(Some(8.9)), Some(8.9));
        assert_eq!(normalise(Some(89.0)), Some(8.9));
        assert_eq!(normalise(Some(0.0)), None);
    }

    #[test]
    fn best_title_prefers_chinese_then_falls_back() {
        let with_cn = Subject {
            id: 1,
            name: Some("CLANNAD".into()),
            name_cn: Some("克兰纳德".into()),
            date: None,
            images: None,
            summary: None,
            rating: None,
            tags: vec![],
            infobox: vec![],
        };
        assert_eq!(best_title(&with_cn), "克兰纳德");

        let without_cn = Subject {
            id: 2,
            name: Some("CLANNAD".into()),
            name_cn: Some("   ".into()), // whitespace-only must not win
            date: None,
            images: None,
            summary: None,
            rating: None,
            tags: vec![],
            infobox: vec![],
        };
        assert_eq!(best_title(&without_cn), "CLANNAD");
    }
}
