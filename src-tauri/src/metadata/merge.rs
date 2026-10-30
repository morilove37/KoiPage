//! Cross-provider merge rules.
//!
//! Kept separate from the provider modules because these decisions are policy,
//! not protocol: which title wins, which rating wins, how tags are de-duplicated.
//! Having them in one file makes the rules auditable and unit-testable without
//! any network access.

use super::{MetadataDetail, SourceRating};

/// Rating sources in descending order of preference.
///
/// Bangumi first because its user base is the Chinese-language audience this app
/// targets, and its ratings line up with how users here judge a game. VNDB next
/// for depth of coverage, then NextMoe's own aggregated score.
const RATING_PREFERENCE: &[&str] = &["bangumi", "vndb", "nextmoe", "erogamescape", "howlongtobeat"];

/// Choose a representative 0-10 rating rounded to hundredths.
pub fn pick_rating(ratings: &[SourceRating]) -> Option<f64> {
    for preferred in RATING_PREFERENCE {
        if let Some(found) = ratings.iter().find(|r| r.source == *preferred) {
            return to_stored_rating(found.score);
        }
    }
    // No known source: fall back to the first available score.
    ratings.first().and_then(|r| to_stored_rating(r.score))
}

/// Keep a valid 0-10 score rounded to hundredths.
fn to_stored_rating(score: f64) -> Option<f64> {
    if !score.is_finite() || score <= 0.0 {
        return None;
    }
    Some(crate::rating::round_rating(score.clamp(0.0, 10.0)))
}

/// De-duplicate tag names, preserving first-seen order.
///
/// Matching is case-insensitive and trims surrounding whitespace, because the
/// same tag arrives spelled slightly differently from different upstreams
/// (`Galgame` from Bangumi, `galgame` from VNDB). The first spelling wins, and
/// callers pass sources in preference order.
pub fn dedupe_tags<I>(tags: I) -> Vec<String>
where
    I: IntoIterator<Item = String>,
{
    let mut seen: Vec<String> = Vec::new();
    let mut out: Vec<String> = Vec::new();
    for tag in tags {
        let trimmed = tag.trim();
        if trimmed.is_empty() {
            continue;
        }
        let key = trimmed.to_lowercase();
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        out.push(trimmed.to_string());
    }
    out
}

/// Merge a secondary provider's detail into a primary one.
///
/// `primary` wins on fields it already has; a Chinese introduction may replace
/// a non-Chinese one, while titles and the selected provider remain unchanged.
/// This is deliberately not a "richest field wins" merge: the primary is the
/// record the user explicitly picked, so silently overriding its title would be
/// surprising.
pub fn merge_into(primary: &mut MetadataDetail, secondary: MetadataDetail) {
    // Titles: fill blanks only, but a Chinese title from any source is worth
    // taking even when the primary has a (romanised) title.
    if primary.title_zh.is_none() {
        primary.title_zh = secondary.title_zh.clone();
    }
    if primary.title_original.is_none() {
        primary.title_original = secondary.title_original.clone();
    }
    if primary.title.trim().is_empty() {
        primary.title = secondary.title.clone();
    }
    if primary.developer.is_none() {
        primary.developer = secondary.developer.clone();
    }
    if primary.release_date.is_none() {
        primary.release_date = secondary.release_date.clone();
    }
    if primary.cover_url.is_none() {
        primary.cover_url = secondary.cover_url.clone();
    }
    merge_description(primary, &secondary);
    if primary.vndb_id.is_none() {
        primary.vndb_id = secondary.vndb_id.clone();
    }
    if primary.bangumi_id.is_none() {
        primary.bangumi_id = secondary.bangumi_id.clone();
    }

    // Ratings: keep every source, then let the preference order decide.
    primary.ratings.extend(secondary.ratings);
    primary.rating = pick_rating(&primary.ratings);

    // Tags: secondary tags are appended, then the whole set is de-duplicated.
    let mut all = std::mem::take(&mut primary.tags);
    all.extend(secondary.tags);
    primary.tags = dedupe_tags(all);

    // Attribution: report every provider that contributed.
    primary.attribution = some_attribution(&primary.attribution, &secondary.attribution);
}

pub fn has_chinese_description(detail: &MetadataDetail) -> bool {
    detail.description.as_deref().is_some_and(|s| !s.trim().is_empty())
        && detail.description_lang.as_deref().is_some_and(|lang| {
            let language = lang.trim().to_ascii_lowercase();
            language == "zh" || language.starts_with("zh-") || language.starts_with("zh_")
        })
}

/// Borrow only text and its attribution; do not change title, score or tags.
pub fn merge_description(primary: &mut MetadataDetail, secondary: &MetadataDetail) -> bool {
    remember_description(primary);
    let mut secondary = secondary.clone();
    remember_description(&mut secondary);
    for option in &secondary.description_options { add_description_option(primary, option.clone()); }
    if secondary.description.as_deref().is_none_or(|s| s.trim().is_empty()) { return false; }
    let empty = primary.description.as_deref().is_none_or(|s| s.trim().is_empty());
    if !empty && (has_chinese_description(primary) || !has_chinese_description(&secondary)) { return false; }
    primary.description = secondary.description.clone();
    primary.description_lang = secondary.description_lang.clone();
    primary.description_source = secondary.description_source.or(secondary.provider);
    primary.attribution = some_attribution(&primary.attribution, &secondary.attribution);
    true
}

fn add_description_option(detail: &mut MetadataDetail, option: super::DescriptionOption) {
    if option.text.trim().is_empty() { return; }
    if !detail.description_options.iter().any(|existing|
        existing.source == option.source && existing.language == option.language && existing.text.trim() == option.text.trim()) {
        detail.description_options.push(option);
    }
}

pub fn remember_description(detail: &mut MetadataDetail) {
    if let Some(text) = detail.description.as_deref().filter(|text| !text.trim().is_empty()) {
        let option = super::DescriptionOption { source: detail.description_source.or(detail.provider),
            language: detail.description_lang.clone(), text: text.to_string(), attribution: detail.attribution.clone() };
        add_description_option(detail, option);
    }
}

/// Join two attribution strings without repeating one.
fn some_attribution(a: &Option<String>, b: &Option<String>) -> Option<String> {
    let mut parts = Vec::new();
    for part in a.iter().chain(b.iter()).flat_map(|s| s.split('、')).map(str::trim).filter(|s| !s.is_empty()) {
        if !parts.contains(&part) { parts.push(part); }
    }
    (!parts.is_empty()).then(|| parts.join("、"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_keeps_all_nonempty_intro_choices_even_when_not_selected() {
        use super::super::Provider;
        let mut primary = MetadataDetail { provider: Some(Provider::Vndb), description: Some("English".into()), description_lang: Some("en".into()), ..Default::default() };
        let chinese = MetadataDetail { provider: Some(Provider::Bangumi), description: Some("中文简介".into()), description_lang: Some("zh-Hans".into()), ..Default::default() };
        merge_description(&mut primary, &chinese);
        let other = MetadataDetail { provider: Some(Provider::TwoDfan), description: Some("另一个中文简介".into()), description_lang: Some("zh".into()), ..Default::default() };
        assert!(!merge_description(&mut primary, &other));
        merge_description(&mut primary, &chinese);
        assert_eq!(primary.description.as_deref(), Some("中文简介"));
        assert_eq!(primary.description_options.len(), 3);
        assert_eq!(primary.description_options[0].source, Some(Provider::Vndb));
        assert_eq!(primary.description_options[0].text, "English");
        assert_eq!(primary.description_options[2].source, Some(Provider::TwoDfan));
    }

    #[test]
    fn chinese_intro_replaces_english_without_changing_vndb_identity() {
        let mut primary = MetadataDetail { provider: Some(super::super::Provider::Vndb), external_id: Some("v4".into()),
            title: "CLANNAD".into(), description: Some("English introduction".into()), description_lang: Some("en".into()), attribution: Some("VNDB".into()), ..Default::default() };
        let secondary = MetadataDetail { provider: Some(super::super::Provider::Bangumi), title: "中文标题".into(),
            description: Some("中文游戏简介".into()), description_lang: Some("zh-Hans".into()), attribution: Some("Bangumi".into()), ..Default::default() };
        merge_into(&mut primary, secondary);
        assert_eq!(primary.description.as_deref(), Some("中文游戏简介"));
        assert_eq!(primary.description_lang.as_deref(), Some("zh-Hans"));
        assert_eq!(primary.description_source, Some(super::super::Provider::Bangumi));
        assert_eq!(primary.attribution.as_deref(), Some("VNDB、Bangumi"));
        assert_eq!(primary.title, "CLANNAD");
        assert_eq!(primary.external_id.as_deref(), Some("v4"));
    }

    #[test]
    fn chinese_intro_is_preserved_and_blank_secondary_never_erases_text() {
        let mut primary = MetadataDetail { description: Some("已有中文简介".into()), description_lang: Some("zh-CN".into()), ..Default::default() };
        for (text, lang) in [("Other English", "en"), ("其他中文", "zh-Hant"), ("  ", "zh")] {
            merge_into(&mut primary, MetadataDetail { description: Some(text.into()), description_lang: Some(lang.into()), ..Default::default() });
            assert_eq!(primary.description.as_deref(), Some("已有中文简介"));
        }
        let mut blank = MetadataDetail { description: Some("  ".into()), description_lang: Some("en".into()), ..Default::default() };
        merge_into(&mut blank, MetadataDetail { description: Some("中文".into()), description_lang: Some("zh".into()), ..Default::default() });
        assert_eq!(blank.description.as_deref(), Some("中文"));
    }

    fn rating(source: &str, score: f64) -> SourceRating {
        SourceRating {
            source: source.to_string(),
            score,
            vote_count: None,
        }
    }

    #[test]
    fn rating_prefers_bangumi_over_vndb() {
        // Both are 0-10; the Chinese-audience source wins.
        let ratings = vec![rating("vndb", 8.72), rating("bangumi", 8.9)];
        assert_eq!(pick_rating(&ratings), Some(8.9));
    }

    #[test]
    fn rating_falls_back_to_first_when_no_known_source() {
        let ratings = vec![rating("mystery", 7.4)];
        assert_eq!(pick_rating(&ratings), Some(7.4));
    }

    #[test]
    fn rating_ignores_zeros_and_garbage() {
        assert_eq!(pick_rating(&[rating("bangumi", 0.0)]), None);
        assert_eq!(pick_rating(&[rating("bangumi", f64::NAN)]), None);
        assert_eq!(pick_rating(&[]), None);
    }

    #[test]
    fn rating_clamps_to_the_stored_range() {
        // Defensive: a provider that fails to normalise must not corrupt the DB.
        assert_eq!(pick_rating(&[rating("bangumi", 99.0)]), Some(10.0));
    }

    #[test]
    fn dedupe_tags_is_case_insensitive_and_keeps_order() {
        let tags = vec![
            "Galgame".to_string(),
            "galgame".to_string(),
            "  KEY  ".to_string(),
            "key".to_string(),
            "".to_string(),
            "催泪".to_string(),
        ];
        assert_eq!(dedupe_tags(tags), vec!["Galgame", "KEY", "催泪"]);
    }

    #[test]
    fn merge_fills_blanks_without_overwriting_the_primary() {
        let mut primary = MetadataDetail {
            title: "クラナド".to_string(),
            title_zh: None,
            tags: vec!["Key".to_string()],
            ..Default::default()
        };
        let secondary = MetadataDetail {
            title: "CLANNAD".to_string(),
            title_zh: Some("克兰纳德".to_string()),
            tags: vec!["key".to_string(), "催泪".to_string()],
            ..Default::default()
        };

        merge_into(&mut primary, secondary);

        // Primary title is preserved...
        assert_eq!(primary.title, "クラナド");
        // ...but the gap was filled from the secondary.
        assert_eq!(primary.title_zh.as_deref(), Some("克兰纳德"));
        // Tags merged case-insensitively.
        assert_eq!(primary.tags, vec!["Key", "催泪"]);
    }

    #[test]
    fn merge_recomputes_rating_from_the_combined_pool() {
        let mut primary = MetadataDetail {
            ratings: vec![rating("vndb", 7.0)],
            rating: Some(7.0),
            ..Default::default()
        };
        let secondary = MetadataDetail {
            ratings: vec![rating("bangumi", 9.2)],
            ..Default::default()
        };

        merge_into(&mut primary, secondary);

        assert_eq!(primary.ratings.len(), 2);
        assert_eq!(primary.rating, Some(9.2), "bangumi should win after merging");
    }

    #[test]
    fn merge_joins_attribution_without_duplicating() {
        let mut primary = MetadataDetail {
            attribution: Some("鲲 Galgame 论坛".to_string()),
            ..Default::default()
        };
        let secondary = MetadataDetail {
            attribution: Some("VNDB".to_string()),
            ..Default::default()
        };
        merge_into(&mut primary, secondary);
        assert_eq!(primary.attribution.as_deref(), Some("鲲 Galgame 论坛、VNDB"));

        let mut same = MetadataDetail {
            attribution: Some("VNDB".to_string()),
            ..Default::default()
        };
        merge_into(
            &mut same,
            MetadataDetail {
                attribution: Some("VNDB".to_string()),
                ..Default::default()
            },
        );
        assert_eq!(same.attribution.as_deref(), Some("VNDB"));
    }
}
