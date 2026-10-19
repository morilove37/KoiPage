//! Title matching for automatic metadata lookup.
//!
//! Auto-fetch has one failure mode that matters far more than "found nothing":
//! **confidently attaching the wrong game's data**. A user importing a folder
//! named `CLANNAD` should not silently get metadata for `CLANNAD -Happy
//! Birthday-`, and a folder named `AIR` must not match `Fairy Tale` just because
//! one normalised string happens to contain the other.
//!
//! So this module scores a candidate against the query and only reports
//! [`Match::Exact`] or [`Match::Strong`] as safe to apply unattended. Anything
//! weaker is surfaced for the user to confirm instead of being written.
//!
//! Scoring compares normalised text: case, spaces, punctuation, version markers
//! and localisation tags removed — the decorations that routinely separate a
//! folder name (`CLANNAD_v1.0`, `[汉化] AIR`) from a catalogue title.

use super::MetadataCandidate;

/// How confidently a candidate matches the query.
///
/// Variants are declared in **increasing** confidence so the derived `Ord` puts
/// the strongest match last, which is what `Iterator::max` needs. Reordering
/// these would silently invert every "pick the best match" decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Match {
    /// No meaningful overlap.
    None,
    /// A partial overlap. Plausible but not dependable — must be confirmed.
    Weak,
    /// One normalised title prefixes the other, with little surplus: the same
    /// work under a slightly different name. Safe to apply unattended.
    Strong,
    /// Normalised titles are identical. Safe to apply unattended.
    Exact,
}

impl Match {
    /// Whether auto-fetch may write this match without user confirmation.
    pub fn is_confident(self) -> bool {
        matches!(self, Match::Exact | Match::Strong)
    }
}

/// Localisation and release tags that appear in folder names but never in a
/// catalogue title. Stripped from the end of a normalised string.
const NOISE_SUFFIXES: &[&str] = &[
    "全年龄",
    "汉化",
    "漢化",
    "中文",
    "简体",
    "繁体",
    "官中",
    "汉化版",
    "破解版",
    "免安装",
    "18禁",
];

/// Maximum extra characters the longer title may carry and still count as the
/// same work under prefix containment.
///
/// Without this, `CLANNAD` would "strongly" match the whole long tail of
/// CLANNAD spin-offs. Requiring real surplus content pushes those to
/// [`Match::Weak`], which is the safe answer: same series, different work.
const MAX_CONTAINMENT_SLACK: usize = 6;

/// Shortest normalised title allowed to qualify as [`Match::Strong`]. Two
/// characters is not enough signal — short strings collide constantly.
const MIN_STRONG_LEN: usize = 3;

/// Strip a trailing `v` + digits marker (`clannadv10` → `clannad`).
///
/// Deliberately requires the literal `v`, because titles legitimately end in
/// digits: stripping a bare numeric tail would turn `ever17` into `ever`.
fn strip_version(text: &str) -> &str {
    let bytes = text.as_bytes();
    let mut end = bytes.len();
    while end > 0 && bytes[end - 1].is_ascii_digit() {
        end -= 1;
    }
    if end > 0 && end < bytes.len() && bytes[end - 1] == b'v' {
        return &text[..end - 1];
    }
    text
}

/// Normalise a title for comparison.
///
/// Keeps letters (including CJK) and digits; drops everything else. CJK
/// ideographs are preserved because they *are* the title for Chinese and
/// Japanese works — only punctuation and whitespace are expendable.
pub fn normalise(title: &str) -> String {
    let lowered = title.to_lowercase();
    let kept: String = lowered.chars().filter(|ch| ch.is_alphanumeric()).collect();
    let mut out = strip_version(&kept).to_string();
    for noise in NOISE_SUFFIXES {
        if let Some(stripped) = out.strip_suffix(&noise.to_lowercase()) {
            out = stripped.to_string();
        }
    }
    out
}

/// Score a candidate against the user's query.
///
/// Both the display title and the original-script title are considered, because
/// the query may be either: a folder named `クラナド` should match a catalogue
/// entry displayed as `CLANNAD`.
pub fn score(query: &str, candidate: &MetadataCandidate) -> Match {
    let needle = normalise(query);
    if needle.is_empty() {
        return Match::None;
    }

    let mut best = Match::None;
    for haystack in [Some(candidate.title.as_str()), candidate.original_title.as_deref()]
        .into_iter()
        .chain(candidate.aliases.iter().map(|alias| Some(alias.as_str())))
        .flatten()
    {
        best = best.max(compare(&needle, &normalise(haystack)));
    }
    best
}

/// Compare two already-normalised titles.
fn compare(needle: &str, haystack: &str) -> Match {
    if haystack.is_empty() {
        return Match::None;
    }
    if needle == haystack {
        return Match::Exact;
    }

    let (longer, shorter) = if needle.len() >= haystack.len() {
        (needle, haystack)
    } else {
        (haystack, needle)
    };

    // Containment is only trusted when the shorter title *prefixes* the longer
    // one. A substring anywhere would let `air` match `fairy tale`, which is
    // exactly the false positive that makes blind auto-apply dangerous.
    if !shorter.is_empty() && longer.starts_with(shorter) {
        let slack = longer.chars().count() - shorter.chars().count();
        if slack <= MAX_CONTAINMENT_SLACK && shorter.chars().count() >= MIN_STRONG_LEN {
            return Match::Strong;
        }
        return Match::Weak;
    }

    // Otherwise: a long shared prefix that is not the whole shorter title.
    // Conservative — `Weak` never auto-applies.
    let common = shorter
        .chars()
        .zip(longer.chars())
        .take_while(|(a, b)| a == b)
        .count();
    if common >= 4 && common * 2 >= shorter.chars().count() {
        return Match::Weak;
    }

    Match::None
}

/// Pick the best candidate for `query`, or `None` when nothing overlaps.
///
/// On equal confidence, keep the existing API providers ahead of 2DFan's HTML
/// catalogue: they supply localized names and external IDs for enrichment.
/// The existing ordering among those providers remains unchanged.
pub fn best_match<'a>(
    query: &str,
    candidates: &'a [MetadataCandidate],
) -> Option<(&'a MetadataCandidate, Match)> {
    candidates
        .iter()
        .map(|candidate| (candidate, score(query, candidate)))
        .filter(|(_, strength)| *strength != Match::None)
        .max_by_key(|(candidate, strength)| (*strength, candidate.provider != super::Provider::TwoDfan))
}

pub fn ranked_candidates<'a>(
    query: &str,
    candidates: &'a [MetadataCandidate],
    preferred: super::Provider,
) -> Vec<(&'a MetadataCandidate, Match)> {
    let mut ranked = candidates.iter().enumerate()
        .map(|(index, candidate)| (index, candidate, score(query, candidate)))
        .filter(|(_, _, strength)| strength.is_confident())
        .collect::<Vec<_>>();
    ranked.sort_by(|(ai, a, sa), (bi, b, sb)| {
        (b.provider == preferred).cmp(&(a.provider == preferred))
            .then_with(|| sb.cmp(sa)).then_with(|| ai.cmp(bi))
    });
    ranked.into_iter().map(|(_, candidate, strength)| (candidate, strength)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metadata::Provider;

    #[test]
    fn preferred_source_wins_for_confident_matches_but_not_weak_ones() {
        let mut fallback = candidate("CLANNAD", None);
        fallback.provider = Provider::Bangumi;
        let mut preferred = candidate("CLANNAD", None);
        preferred.provider = Provider::Vndb;
        let candidates = vec![fallback.clone(), preferred.clone()];
        let ranked = ranked_candidates("CLANNAD", &candidates, Provider::Vndb);
        assert_eq!(ranked.len(), 2);
        assert_eq!(ranked[0].0.provider, Provider::Vndb);

        preferred.title = "CLANNAD -Happy Birthday-".into();
        let candidates = vec![preferred, fallback];
        let ranked = ranked_candidates("CLANNAD", &candidates, Provider::Vndb);
        assert_eq!(ranked.len(), 1);
        assert_eq!(ranked[0].0.provider, Provider::Bangumi);
    }

    #[test]
    fn explicit_2dfan_preference_is_respected_and_same_source_order_is_stable() {
        let mut api = candidate("CLANNAD", None);
        api.provider = Provider::Vndb;
        let mut first = candidate("CLANNAD", None);
        first.provider = Provider::TwoDfan;
        first.external_id = "21".into();
        let mut second = first.clone();
        second.external_id = "22".into();
        let candidates = vec![api, first, second];
        let ranked = ranked_candidates("CLANNAD", &candidates, Provider::TwoDfan);
        assert_eq!(ranked.iter().map(|(c,_)| c.external_id.as_str()).collect::<Vec<_>>(), vec!["21","22","1"]);
        assert!(ranked_candidates("unrelated", &candidates, Provider::TwoDfan).is_empty());
    }

    fn candidate(title: &str, original: Option<&str>) -> MetadataCandidate {
        MetadataCandidate {
            provider: Provider::Nextmoe,
            external_id: "1".to_string(),
            title: title.to_string(),
            original_title: original.map(str::to_string),
            aliases: Vec::new(),
            release_date: None,
            cover_url: None,
            rating: None,
            source_label: "test".to_string(),
        }
    }

    #[test]
    fn normalise_strips_case_spaces_and_punctuation() {
        assert_eq!(normalise("CLANNAD"), "clannad");
        assert_eq!(normalise("  AIR  "), "air");
        assert_eq!(normalise("Steins;Gate"), "steinsgate");
        // Japanese and Chinese titles survive intact.
        assert_eq!(normalise("クラナド"), "クラナド");
        assert_eq!(normalise("命运石之门"), "命运石之门");
    }

    #[test]
    fn normalise_drops_version_and_localisation_noise() {
        assert_eq!(normalise("CLANNAD_v1.0"), "clannad");
        assert_eq!(normalise("AIR汉化"), "air");
        assert_eq!(normalise("CLANNAD 18禁"), "clannad");
    }

    #[test]
    fn version_stripping_does_not_eat_trailing_digits_in_titles() {
        // Ever17 is a title, not "ever" + version 17.
        assert_eq!(normalise("Ever17"), "ever17");
        assert_eq!(normalise("Steins;Gate 0"), "steinsgate0");
    }

    #[test]
    fn identical_titles_are_exact() {
        assert_eq!(score("CLANNAD", &candidate("CLANNAD", None)), Match::Exact);
        assert_eq!(score("clannad", &candidate("CLANNAD", None)), Match::Exact);
        assert_eq!(score("命运石之门", &candidate("命运石之门", None)), Match::Exact);
    }

    #[test]
    fn version_suffix_still_counts_as_exact() {
        // A folder name almost always carries a version marker.
        assert_eq!(score("CLANNAD_v1.0", &candidate("CLANNAD", None)), Match::Exact);
        assert_eq!(score("AIR v1.02", &candidate("AIR", None)), Match::Exact);
    }

    #[test]
    fn matching_the_original_script_title_works() {
        // Folder named in Japanese, catalogue entry displayed in English.
        assert_eq!(
            score("クラナド", &candidate("CLANNAD", Some("クラナド"))),
            Match::Exact
        );
    }

    #[test]
    fn matching_a_latin_alias_works_when_the_display_title_is_chinese() {
        // VNDB now shows the Chinese title but must still match an English folder.
        let mut vndb = candidate("魔女的夜宴", Some("サノバウィッチ"));
        vndb.aliases = vec!["Sabbat of the Witch".to_string()];
        assert_eq!(score("Sabbat of the Witch", &vndb), Match::Exact);
        assert_eq!(score("Sanoba Witch", &vndb), Match::None);
    }

    #[test]
    fn a_spin_off_with_a_long_suffix_is_not_confident() {
        // The case that makes blind auto-apply dangerous.
        assert_eq!(
            score("CLANNAD", &candidate("CLANNAD -Happy Birthday-", None)),
            Match::Weak
        );
        assert_eq!(
            score("Summer Pockets", &candidate("Summer Pockets REFLECTION BLUE", None)),
            Match::Weak
        );
        assert_eq!(
            score("AIR", &candidate("AIR ~something completely different~", None)),
            Match::Weak
        );
    }

    #[test]
    fn a_bare_substring_is_not_a_strong_match() {
        // "air" appears inside "fairy tale"; prefix-only containment rejects it.
        assert_eq!(score("AIR", &candidate("Fairy Tale", None)), Match::None);
        // And the reverse direction must behave the same way.
        assert_eq!(score("Fairy Tale", &candidate("AIR", None)), Match::None);
    }

    #[test]
    fn very_short_titles_never_reach_strong() {
        assert_eq!(score("AI", &candidate("AIR", None)), Match::Weak);
    }

    #[test]
    fn a_small_suffix_is_strong() {
        // A two-word title gaining a short suffix is plausibly the same work.
        assert_eq!(
            score("CLANNAD Fan", &candidate("CLANNAD FanDisc", None)),
            Match::Strong
        );
    }

    #[test]
    fn unrelated_titles_do_not_match() {
        assert_eq!(score("CLANNAD", &candidate("Steins;Gate", None)), Match::None);
        assert_eq!(score("", &candidate("CLANNAD", None)), Match::None);
    }

    #[test]
    fn confidence_gate_only_allows_exact_and_strong() {
        assert!(Match::Exact.is_confident());
        assert!(Match::Strong.is_confident());
        assert!(!Match::Weak.is_confident());
        assert!(!Match::None.is_confident());
    }

    /// Guards the enum ordering the whole module depends on: if someone
    /// reorders the variants, `max()` starts returning the *worst* match.
    #[test]
    fn ordering_puts_the_strongest_match_last() {
        assert!(Match::None < Match::Weak);
        assert!(Match::Weak < Match::Strong);
        assert!(Match::Strong < Match::Exact);
    }

    #[test]
    fn best_match_returns_none_when_nothing_overlaps() {
        let candidates = vec![candidate("Steins;Gate", None), candidate("Ever17", None)];
        assert!(best_match("CLANNAD", &candidates).is_none());
    }

    #[test]
    fn best_match_prefers_the_strongest_then_provider_order() {
        let candidates = vec![
            candidate("CLANNAD -Happy Birthday-", None), // Weak
            candidate("CLANNAD", Some("クラナド")),       // Exact
        ];
        let (found, strength) = best_match("CLANNAD", &candidates).expect("a match");
        assert_eq!(strength, Match::Exact);
        assert_eq!(found.title, "CLANNAD");
    }

    #[test]
    fn adding_2dfan_preserves_existing_precedence_for_equal_matches() {
        let mut existing = candidate("CLANNAD", Some("クラナド"));
        existing.provider = Provider::Bangumi;
        let mut added = candidate("CLANNAD", None);
        added.provider = Provider::TwoDfan;
        let candidates = vec![existing, added];
        let (found, strength) = best_match("CLANNAD", &candidates).unwrap();
        assert_eq!(strength, Match::Exact);
        assert_eq!(found.provider, Provider::Bangumi);

        let candidates = vec![candidate("CLANNAD -Happy Birthday-", None), candidates[1].clone()];
        let (found, _) = best_match("CLANNAD", &candidates).unwrap();
        assert_eq!(found.provider, Provider::TwoDfan, "a stronger 2DFan match must still win");
    }
}
