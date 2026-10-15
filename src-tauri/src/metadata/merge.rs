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
/// `primary` wins on every field it already has; the secondary only fills gaps.
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
    if primary.description.is_none() {
        primary.description = secondary.description.clone();
        primary.description_lang = secondary.description_lang.clone();
    }
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

/// Join two attribution strings without repeating one.
fn some_attribution(a: &Option<String>, b: &Option<String>) -> Option<String> {
    match (a, b) {
        (Some(a), Some(b)) if a == b => Some(a.clone()),
        (Some(a), Some(b)) => Some(format!("{a}、{b}")),
        (Some(a), None) => Some(a.clone()),
        (None, Some(b)) => Some(b.clone()),
        (None, None) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
