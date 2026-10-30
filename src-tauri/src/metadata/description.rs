//! Conservative identity checks for borrowing a description from another source.

use super::{MetadataCandidate, MetadataDetail, Provider, matching};

fn titles(detail: &MetadataDetail) -> impl Iterator<Item = &str> {
    detail.title_original.as_deref().into_iter().chain(std::iter::once(detail.title.as_str()))
        .chain(detail.title_zh.as_deref()).filter(|s| !s.trim().is_empty())
}

pub fn description_query(detail: &MetadataDetail) -> Option<&str> { titles(detail).next() }

fn conflicting_dates(a: Option<&str>, b: Option<&str>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) if a.len() == 10 && b.len() == 10 => a != b,
        _ => false,
    }
}

pub fn description_candidate<'a>(primary: &MetadataDetail, candidates: &'a [MetadataCandidate], provider: Provider) -> Option<&'a MetadataCandidate> {
    let mut found: Option<&MetadataCandidate> = None;
    for candidate in candidates {
        if candidate.provider != provider
            || conflicting_dates(primary.release_date.as_deref(), candidate.release_date.as_deref())
            || !titles(primary).any(|title| matching::score(title, candidate) == matching::Match::Exact) { continue; }
        if found.is_some_and(|previous| previous.external_id != candidate.external_id) { return None; }
        found = Some(candidate);
    }
    found
}

pub fn same_description_work(primary: &MetadataDetail, secondary: &MetadataDetail) -> bool {
    if conflicting_dates(primary.release_date.as_deref(), secondary.release_date.as_deref()) { return false; }
    let mut shared_id = false;
    for (a, b) in [(&primary.vndb_id, &secondary.vndb_id), (&primary.bangumi_id, &secondary.bangumi_id)] {
        if let (Some(a), Some(b)) = (a, b) {
            if a != b { return false; }
            shared_id = true;
        }
    }
    if shared_id { return true; }
    titles(primary).any(|a| titles(secondary).any(|b| {
            let a = matching::normalise(a);
            !a.is_empty() && a == matching::normalise(b)
        }))
}

/// Carry the verified identity alongside a borrowed introduction. A description
/// can be absent while the subject still supplies a useful Bangumi binding.
pub fn merge_verified_supplement(primary: &mut MetadataDetail, secondary: &MetadataDetail) {
    if !same_description_work(primary, secondary) { return; }
    if secondary.provider == Some(Provider::Bangumi) {
        if primary.bangumi_id.as_deref().is_none_or(|id| id.trim().is_empty()) {
            primary.bangumi_id = secondary.bangumi_id.clone();
        }
        if primary.title_zh.as_deref().is_none_or(|title| title.trim().is_empty()) {
            primary.title_zh = secondary.title_zh.clone();
        }
    }
    super::merge::merge_description(primary, secondary);
}

/// Read-only lookup. Callers bound the request time and isolate provider errors.
pub async fn fetch_description(primary: &MetadataDetail, provider: Provider, nextmoe_key: Option<&str>) -> super::CmdResult<Option<MetadataDetail>> {
    let known_id = match provider { Provider::Bangumi => primary.bangumi_id.as_deref(), Provider::Vndb => primary.vndb_id.as_deref(), _ => None };
    let id = if let Some(id) = known_id {
        id.to_string()
    } else {
        let Some(query) = description_query(primary) else { return Ok(None); };
        let candidates = match provider {
            Provider::Bangumi => super::bangumi::search(query, 10).await?,
            Provider::TwoDfan => super::twodfan::search(query, 10).await?,
            Provider::Vndb => super::vndb::search(query, 10).await?,
            Provider::Nextmoe => super::nextmoe::search(query, 10, nextmoe_key).await?,
        };
        let Some(candidate) = description_candidate(primary, &candidates, provider) else { return Ok(None); };
        candidate.external_id.clone()
    };
    let secondary = match provider {
        Provider::Bangumi => super::bangumi::detail(&id).await?,
        Provider::TwoDfan => super::twodfan::detail(&id).await?,
        Provider::Vndb => super::vndb::detail(&id).await?,
        Provider::Nextmoe => super::nextmoe::detail(&id, nextmoe_key).await?,
    };
    Ok(same_description_work(primary, &secondary).then_some(secondary))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metadata::{MetadataCandidate, MetadataDetail, Provider};

    fn primary() -> MetadataDetail {
        MetadataDetail { provider: Some(Provider::Vndb), title: "CLANNAD".into(),
            vndb_id: Some("v4".into()), release_date: Some("2004-04-28".into()), ..Default::default() }
    }
    fn candidate(id: &str, title: &str) -> MetadataCandidate {
        MetadataCandidate { provider: Provider::Bangumi, external_id: id.into(), title: title.into(), original_title: None,
            aliases: vec![], release_date: None, cover_url: None, rating: None, source_label: "Bangumi".into() }
    }

    #[test]
    fn only_unique_exact_matches_can_supply_an_intro() {
        let p = primary();
        let choices = vec![candidate("1", "CLANNAD"), candidate("2", "CLANNAD Side Stories")];
        assert_eq!(description_candidate(&p, &choices, Provider::Bangumi).unwrap().external_id, "1");
        assert!(description_candidate(&p, &[candidate("2", "CLANNAD Side Stories")], Provider::Bangumi).is_none());
        assert!(description_candidate(&p, &[candidate("1", "CLANNAD"), candidate("2", "CLANNAD")], Provider::Bangumi).is_none());
        assert!(description_candidate(&p, &choices, Provider::TwoDfan).is_none());
    }

    #[test]
    fn conflicting_dates_or_external_ids_are_rejected() {
        let p = primary();
        let mut wrong = candidate("1", "CLANNAD");
        wrong.release_date = Some("2024-04-28".into());
        assert!(description_candidate(&p, &[wrong], Provider::Bangumi).is_none());
        let mut detail = MetadataDetail { title: "CLANNAD".into(), vndb_id: Some("v99".into()), ..Default::default() };
        assert!(!same_description_work(&p, &detail));
        detail.vndb_id = Some("v4".into());
        detail.title = "另一个语言的标题".into();
        assert!(same_description_work(&p, &detail));
        detail.release_date = Some("2024-04-28".into());
        assert!(!same_description_work(&p, &detail));
    }

    #[test]
    fn original_titles_match_localized_results_and_duplicate_hits_are_not_ambiguous() {
        let mut p = primary(); p.title_original = Some("クラナド".into());
        let mut hit = candidate("1", "克兰纳德"); hit.original_title = Some("クラナド".into());
        let choices = vec![hit.clone(), hit];
        assert!(description_candidate(&p, &choices, Provider::Bangumi).is_some());
    }

    #[test]
    fn verified_bangumi_binding_is_kept_even_without_an_intro() {
        for provider in [Provider::Vndb, Provider::Nextmoe, Provider::TwoDfan] {
            let mut p = primary(); p.provider = Some(provider);
            let extra = MetadataDetail { provider: Some(Provider::Bangumi), title: "CLANNAD".into(),
                bangumi_id: Some("12".into()), title_zh: Some("克兰纳德".into()), ..Default::default() };
            merge_verified_supplement(&mut p, &extra);
            assert_eq!(p.bangumi_id.as_deref(), Some("12"));
            assert_eq!(p.title_zh.as_deref(), Some("克兰纳德"));
            let mut conflicting = extra.clone(); conflicting.bangumi_id = Some("99".into());
            merge_verified_supplement(&mut p, &conflicting);
            assert_eq!(p.bangumi_id.as_deref(), Some("12"));
        }
    }

    #[test]
    fn unrelated_work_cannot_supply_a_bangumi_binding() {
        let mut p = primary();
        let extra = MetadataDetail { provider: Some(Provider::Bangumi), title: "CLANNAD Side Stories".into(),
            bangumi_id: Some("99".into()), ..Default::default() };
        merge_verified_supplement(&mut p, &extra);
        assert!(p.bangumi_id.is_none());
    }
}
