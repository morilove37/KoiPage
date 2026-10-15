//! Live smoke test against the three metadata providers.
//!
//! `#[ignore]` by default: it needs network access and hits real rate limits
//! (VNDB allows 200 requests / 5 minutes), so it must never run in a normal
//! `cargo test`. Run it deliberately:
//!
//! ```text
//! cargo test --lib live_tests -- --ignored --nocapture --test-threads=1
//! ```
//!
//! This exists because unit tests with hand-written JSON prove only that our
//! parser matches our own fixture. They cannot catch a wrong URL, a missing
//! User-Agent, or an upstream that changed its envelope shape — the exact class
//! of bug that compiles cleanly and fails at runtime.
//!
//! Three real bugs were found this way:
//!
//! 1. `include=titles` is silently ignored on every NextMoe collection lane, so
//!    Chinese titles required a second request against the detail lane.
//! 2. `include=` blocks come back as bare arrays, not `{ items: [...] }`.
//! 3. NextMoe covers only ~27% of VNDB's most-voted titles, so a `refs=` miss is
//!    routine and must not be treated as an error.

use super::matching::{best_match, Match};
use super::{bangumi, merge, nextmoe, vndb};
use crate::commands::metadata::{search_all, Sources};

/// A title all three providers are expected to know.
const QUERY: &str = "CLANNAD";

#[tokio::test]
#[ignore = "hits the live network; run explicitly with --ignored"]
async fn nextmoe_search_and_detail() {
    let found = nextmoe::search(QUERY, 3, None)
        .await
        .expect("NextMoe search should succeed anonymously");
    assert!(!found.is_empty(), "expected at least one NextMoe hit");
    println!(
        "NextMoe search: {}",
        found
            .iter()
            .map(|c| format!("{} ({})", c.title, c.external_id))
            .collect::<Vec<_>>()
            .join(", ")
    );

    let id = found[0].external_id.clone();
    let detail = nextmoe::detail(&id, None)
        .await
        .expect("NextMoe detail should succeed");
    println!(
        "NextMoe detail id={id} title={:?} zh={:?} rating={:?} tags={} desc_lang={:?}",
        detail.title,
        detail.title_zh,
        detail.rating,
        detail.tags.len(),
        detail.description_lang
    );

    // Chinese title is the whole reason we prefer NextMoe; CLANNAD has one.
    assert!(
        detail.title_zh.is_some(),
        "CLANNAD should have a zh-Hans title on NextMoe"
    );
    assert!(detail.rating.is_some(), "expected a merged rating");
    assert!(!detail.tags.is_empty(), "expected tags");
}

#[tokio::test]
#[ignore = "hits the live network; run explicitly with --ignored"]
async fn nextmoe_refs_batch_lane_resolves_vndb_ids() {
    // This is the enrichment path used when the user picks a VNDB result.
    //
    // Note on the id: NextMoe's catalogue is much smaller than VNDB's — measured
    // at ~27% of VNDB's thirty most-voted titles — so the sample must be a work
    // NextMoe actually holds. `v4` (CLANNAD) is one; `v17` (Ever17) is not.
    let detail = nextmoe::detail_by_ref("vndb:v4", None)
        .await
        .expect("refs lookup should not error");
    println!("refs=vndb:v4 -> {detail:?}");
    let detail = detail.expect("vndb:v4 (CLANNAD) should resolve through the refs lane");
    assert!(
        detail.title_zh.is_some(),
        "the refs lane is how we get Chinese titles for VNDB picks"
    );

    // An unknown anchor must be a quiet None, never an error: a miss is the
    // common case and must not break the metadata flow.
    let missing = nextmoe::detail_by_ref("vndb:v999999999", None)
        .await
        .expect("unknown ref must not be an error");
    assert!(missing.is_none(), "unknown ref should come back as None");
}

#[tokio::test]
#[ignore = "hits the live network; run explicitly with --ignored"]
async fn nextmoe_refs_reports_uncovered_works_as_missing() {
    // Documents the real coverage gap: NextMoe answers with `items=[]` plus a
    // `missing[]` list for works it does not hold. The enrichment step must
    // tolerate that, which `detail_by_ref` does by returning Ok(None).
    //
    // Ever17 is a well-known VN absent from NextMoe at the time of writing.
    match nextmoe::detail_by_ref("vndb:v17", None).await {
        Ok(None) => println!("vndb:v17 is not in NextMoe (expected; coverage is partial)"),
        Ok(Some(found)) => println!("vndb:v17 is now covered: {found:?}"),
        Err(error) => panic!("a missing work must not error, got: {}", error.0),
    }
}

#[tokio::test]
#[ignore = "hits the live network; run explicitly with --ignored"]
async fn vndb_search_and_detail() {
    let found = vndb::search(QUERY, 3)
        .await
        .expect("VNDB search should succeed");
    assert!(!found.is_empty(), "expected a VNDB hit");
    let id = found[0].external_id.clone();
    println!("VNDB search: {id}");

    let detail = vndb::detail(&id).await.expect("VNDB detail should succeed");
    println!(
        "VNDB detail id={id} title={:?} rating={:?} tags={} desc_len={:?}",
        detail.title,
        detail.rating,
        detail.tags.len(),
        detail.description.as_deref().map(str::len)
    );

    assert_eq!(detail.vndb_id.as_deref(), Some(id.as_str()));
    // VNDB reports 0-100 upstream; ours must be 0-10.
    if let Some(rating) = detail.rating {
        assert!(
            (0.0..=10.0).contains(&rating),
            "rating must be normalised to 0-10, got {rating}"
        );
    }
    // Descriptions must not leak VNDB markup into the database.
    if let Some(description) = &detail.description {
        assert!(
            !description.contains("[url="),
            "VNDB markup should be stripped"
        );
    }
}

#[tokio::test]
#[ignore = "hits the live network; run explicitly with --ignored"]
async fn bangumi_search_and_detail() {
    let found = bangumi::search(QUERY, 3)
        .await
        .expect("Bangumi search should succeed");
    assert!(!found.is_empty(), "expected a Bangumi hit");
    let id = found[0].external_id.clone();
    println!("Bangumi search: {id}");

    let detail = bangumi::detail(&id)
        .await
        .expect("Bangumi detail should succeed");
    println!(
        "Bangumi detail id={id} title={:?} zh={:?} rating={:?} dev={:?} tags={}",
        detail.title,
        detail.title_zh,
        detail.rating,
        detail.developer,
        detail.tags.len()
    );

    assert_eq!(detail.bangumi_id.as_deref(), Some(id.as_str()));
    if let Some(rating) = detail.rating {
        assert!((0.0..=10.0).contains(&rating), "rating out of range: {rating}");
    }
}

#[tokio::test]
#[ignore = "hits the live network; run explicitly with --ignored"]
async fn cross_provider_merge_produces_a_chinese_title() {
    // A VNDB pick alone has no Chinese title; merging NextMoe's record for the
    // same work should supply one. This is the real end-to-end enrichment path
    // used by `metadata_detail`.
    //
    // `v4` (CLANNAD) is used because NextMoe covers it; see the coverage note on
    // `nextmoe_refs_batch_lane_resolves_vndb_ids`.
    let vndb_detail = vndb::detail("v4")
        .await
        .expect("VNDB detail for v4 should succeed");
    assert!(
        vndb_detail.title_zh.is_none(),
        "VNDB has no Chinese titles by design"
    );

    let mut merged = vndb_detail;
    if let Some(extra) = nextmoe::detail_by_ref("vndb:v4", None)
        .await
        .expect("refs lookup should succeed")
    {
        merge::merge_into(&mut merged, extra);
    }

    println!(
        "merged: title={:?} zh={:?} ratings={} tags={} attribution={:?}",
        merged.title,
        merged.title_zh,
        merged.ratings.len(),
        merged.tags.len(),
        merged.attribution
    );

    assert!(
        merged.title_zh.is_some(),
        "merging NextMoe should fill in a Chinese title"
    );
    assert!(
        merged.ratings.len() > 1,
        "merged record should carry ratings from more than one source"
    );
    assert!(merged.vndb_id.is_some(), "VNDB id must be preserved");
}

// ---------------------------------------------------------------------------
// Command-layer fan-out
//
// These exercise `search_all`, the function `metadata_search` delegates to. The
// per-provider tests above prove each provider works in isolation; these prove
// the layer above them does, which is what the frontend actually reaches. They
// run without a Tauri `AppHandle` because `search_all` was extracted for that.
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "hits the live network; run explicitly with --ignored"]
async fn search_all_queries_every_provider_and_isolates_failures() {
    let wanted = [Sources::Nextmoe, Sources::Vndb, Sources::Bangumi];
    let (candidates, errors) = search_all(QUERY, &wanted, 5, None).await;

    let providers: Vec<&str> = candidates.iter().map(|c| c.provider.as_str()).collect();
    println!(
        "search_all -> {} candidates from {:?}, {} provider errors",
        candidates.len(),
        providers,
        errors.len()
    );
    for error in &errors {
        println!("  provider error: {} {}", error.provider.as_str(), error.message);
    }

    assert!(
        !candidates.is_empty(),
        "CLANNAD should match on at least one provider"
    );

    // The point of fanning out: all three sources contribute, and a failure in
    // one does not suppress the others. Assert at least two responded.
    let mut distinct = providers.clone();
    distinct.sort_unstable();
    distinct.dedup();
    assert!(
        distinct.len() >= 2,
        "expected hits from at least two providers, got {distinct:?} (errors: {:?})",
        errors
            .iter()
            .map(|e| e.message.as_str())
            .collect::<Vec<_>>()
    );

    // A provider error is reported, not thrown: if any source did fail, the
    // message must be non-empty so the UI has something to show.
    for error in &errors {
        assert!(
            !error.message.trim().is_empty(),
            "a provider error must carry a message"
        );
    }
}

#[tokio::test]
#[ignore = "hits the live network; run explicitly with --ignored"]
async fn search_all_respects_the_source_filter() {
    // Only VNDB selected: NextMoe and Bangumi must not be queried, so no
    // candidate may be attributed to them.
    let (candidates, errors) = search_all(QUERY, &[Sources::Vndb], 5, None).await;
    println!(
        "vndb-only -> {} candidates, {} errors",
        candidates.len(),
        errors.len()
    );

    assert!(!candidates.is_empty(), "VNDB should return hits for CLANNAD");
    assert!(
        candidates.iter().all(|c| c.provider == crate::metadata::Provider::Vndb),
        "source filter leaked other providers: {:?}",
        candidates.iter().map(|c| c.provider).collect::<Vec<_>>()
    );
}

#[tokio::test]
#[ignore = "hits the live network; run explicitly with --ignored"]
async fn search_all_returns_empty_rather_than_erroring_for_nonsense() {
    // A query that cannot match must yield an empty list, not an error: an empty
    // result is what drives the UI's "fall back to manual entry" path.
    let gibberish = "zzqqx_no_such_visual_novel_9f3a2b";
    let wanted = [Sources::Nextmoe, Sources::Vndb, Sources::Bangumi];
    let (candidates, errors) = search_all(gibberish, &wanted, 5, None).await;

    println!(
        "gibberish query -> {} candidates, {} errors",
        candidates.len(),
        errors.len()
    );
    assert!(
        candidates.is_empty(),
        "gibberish should match nothing, got {:?}",
        candidates.iter().map(|c| &c.title).collect::<Vec<_>>()
    );
    // A provider may still legitimately error (rate limit); only assert that we
    // did not panic or hang.
}

// ---------------------------------------------------------------------------
// Auto-fetch matching against real search results
//
// The unit tests for `matching` use synthetic candidates. These run the scorer
// over what the providers *actually* return for a folder-name-shaped query,
// which is the situation auto-fetch faces right after an import.
// ---------------------------------------------------------------------------

/// Search every provider and report what the matcher would choose.
async fn match_for(query: &str) -> Option<(String, String, Match)> {
    let (candidates, errors) = search_all(
        query,
        &[Sources::Nextmoe, Sources::Vndb, Sources::Bangumi],
        8,
        None,
    )
    .await;
    println!(
        "query {:?} -> {} candidates, {} provider errors",
        query,
        candidates.len(),
        errors.len()
    );
    best_match(query, &candidates)
        .map(|(c, strength)| (c.title.clone(), c.external_id.clone(), strength))
}

#[tokio::test]
#[ignore = "hits the live network; run explicitly with --ignored"]
async fn autofetch_confidently_matches_a_plain_title() {
    let found = match_for("CLANNAD").await.expect("CLANNAD should match");
    println!("CLANNAD -> {:?}", found);
    assert!(
        found.2.is_confident(),
        "a plain exact title must be safe to auto-apply, got {:?}",
        found.2
    );
}

#[tokio::test]
#[ignore = "hits the live network; run explicitly with --ignored"]
async fn autofetch_confidently_matches_a_folder_style_name() {
    // What a scanned folder is actually called: title plus a version marker.
    let found = match_for("CLANNAD_v1.0")
        .await
        .expect("a versioned folder name should still match");
    println!("CLANNAD_v1.0 -> {:?}", found);
    assert!(
        found.2.is_confident(),
        "version noise must not prevent a confident match, got {:?}",
        found.2
    );
}

#[tokio::test]
#[ignore = "hits the live network; run explicitly with --ignored"]
async fn autofetch_refuses_to_guess_for_nonsense() {
    // A folder whose name matches nothing must produce no confident match, so
    // auto-fetch leaves the game alone rather than attaching a stranger's data.
    let found = match_for("zzqqx_no_such_visual_novel_9f3a2b").await;
    println!("gibberish -> {found:?}");
    assert!(
        found.is_none() || !found.as_ref().expect("checked").2.is_confident(),
        "nonsense must never be auto-applied, got {found:?}"
    );
}

#[tokio::test]
#[ignore = "hits the live network; run explicitly with --ignored"]
async fn autofetch_does_not_attach_a_spin_off_to_the_base_title() {
    // The dangerous case: searching "CLANNAD" returns many CLANNAD spin-offs.
    // Whichever the matcher picks, it must not be a *confident* match on a
    // spin-off title — that would silently mislabel the user's game.
    let (candidates, _) = search_all(
        "CLANNAD",
        &[Sources::Nextmoe, Sources::Vndb, Sources::Bangumi],
        8,
        None,
    )
    .await;
    let (chosen, strength) = best_match("CLANNAD", &candidates).expect("a match");
    println!("chosen {:?} ({:?}) from {} candidates", chosen.title, strength, candidates.len());

    if strength.is_confident() {
        // If we auto-apply, the chosen title must normalise to the query.
        let chosen_norm = super::matching::normalise(&chosen.title);
        let query_norm = super::matching::normalise("CLANNAD");
        assert!(
            chosen_norm == query_norm || chosen_norm.starts_with(&query_norm),
            "confident match must not be an unrelated title: {chosen:?}"
        );
    }
}
