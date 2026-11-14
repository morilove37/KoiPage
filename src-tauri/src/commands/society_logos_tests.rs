use super::*;
use serde_json::json;

#[test]
fn names_normalize_width_case_and_punctuation_without_substring_matching() {
    assert_eq!(identity("Ｓ.Ｍ.Ｅ.Ｅ"), identity("SMEE"));
    assert_ne!(identity("Key"), identity("Key Sounds Label"));
    assert_eq!(identity("ゆずソフト"), "ゆずソフト");
}
#[test]
fn producer_requires_exact_name_or_alias_and_rejects_ambiguity() {
    let producers = json!([{ "id":"p1","name":"YuzuSoft","original":"ゆずソフト","aliases":["柚子社"] },{"id":"p2","name":"Other"}]);
    assert_eq!(producer_id(&producers, "柚子社"), Some("p1".into()));
    assert_eq!(producer_id(&producers, "Yuzu"), None);
    assert_eq!(
        producer_id(
            &json!([{"id":"p1","name":"Key"},{"id":"p2","name":"KEY"}]),
            "Key"
        ),
        None
    );
}
#[test]
fn bangumi_uses_only_matching_organizations_and_development_credits() {
    let people = json!([
        {"id":1,"type":1,"name":"Key","relation":"原画","images":{"large":"https://img/artist"}},
        {"id":2,"type":2,"name":"Key","relation":"发行","images":{"large":"https://img/publisher"}},
        {"id":3,"type":2,"name":"Key","relation":"开发","images":{"large":"https://img/logo"}}]);
    assert_eq!(
        bangumi_brand(&people, "Key"),
        Some(("3".into(), Some("https://img/logo".into())))
    );
    assert_eq!(bangumi_brand(&people, "Unknown"), None);
}
#[test]
fn cache_keeps_custom_images_and_retries_misses_and_missing_files() {
    let mut logo = LogoRecord {
        path: Some("a.png".into()),
        custom: true,
        source: Some("custom".into()),
        checked_at: 1,
        retry_after: 60,
        resolver_version: RESOLVER_VERSION,
    };
    assert!(cache_valid(&logo, 1000, true));
    assert!(!cache_valid(&logo, 1000, false));
    logo.custom = false;
    assert!(cache_valid(&logo, 1000, true));
    logo.path = None;
    assert!(cache_valid(&logo, 30, false));
    assert!(!cache_valid(&logo, 61, false));
}

#[tokio::test]
#[ignore = "live VNDB and NextMoe API smoke check; run explicitly"]
async fn live_logo_resolves_a_credited_brand_and_decodes_the_download() {
    let db = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    sqlx::raw_sql("CREATE TABLE games(id INTEGER,developer TEXT,vndb_id TEXT,bangumi_id TEXT);CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);INSERT INTO games VALUES(1,'SMEE','v26765',NULL);").execute(&db).await.unwrap();
    let (urls, _) = candidates(&db, "SMEE").await.unwrap();
    assert!(
        !urls.is_empty(),
        "SMEE should resolve through its credited VNDB producer"
    );
    assert_eq!(urls[0].1, "nextmoe");
    let bytes = crate::metadata::download_cover(&urls[0].0).await.unwrap();
    let image = image::load_from_memory(&bytes).unwrap();
    assert!(image.width() > 0 && image.height() > 0);
    db.close().await;
}

#[test]
fn name_search_accepts_aliases_but_requires_known_game_development() {
    let brand = json!({"id":8973,"type":1,"career":["producer"],"name":"FAVORITE","infobox":[{"key":"别名","value":[{"v":"F社"}]}]});
    let works = json!([{"type":4,"staff":"开发","id":3650,"name":"星空のメモリア"}]);
    assert!(sources::verified_bangumi_brand(
        &brand,
        &["F社".into()],
        &works,
        &["3650".into()],
        &[]
    ));
    assert!(!sources::verified_bangumi_brand(
        &brand,
        &["Favorite Garden".into()],
        &works,
        &["3650".into()],
        &[]
    ));
    assert!(!sources::verified_bangumi_brand(
        &brand,
        &["FAVORITE".into()],
        &works,
        &["9999".into()],
        &[]
    ));
    assert!(!sources::verified_bangumi_brand(
        &brand,
        &["FAVORITE".into()],
        &json!([{"type":4,"staff":"原画","id":3650}]),
        &["3650".into()],
        &[]
    ));
}
#[test]
fn wikidata_uses_exact_labels_and_skips_humans_and_ambiguous_logo_claims() {
    let mut entity = json!({"id":"Q1","labels":{"en":{"value":"FAVORITE"}},"descriptions":{"en":{"value":"Japanese video game developer"}},"claims":{"P154":[{"rank":"normal","mainsnak":{"datavalue":{"value":"Logo.svg"}}},{"rank":"deprecated","mainsnak":{"datavalue":{"value":"Old.png"}}}]}});
    assert!(sources::wikidata_matches(
        &entity,
        &["Favorite".into()],
        false
    ));
    assert!(!sources::wikidata_matches(&entity, &["Favo".into()], false));
    let mut work = entity.clone();
    work["descriptions"]["en"]["value"] = json!("2010 visual novel");
    assert!(!sources::wikidata_matches(
        &work,
        &["FAVORITE".into()],
        false
    ));
    assert_eq!(
        sources::wikidata_logo_file(&entity),
        Some("Logo.svg".into())
    );
    entity["claims"]["P31"] = json!([{"mainsnak":{"datavalue":{"value":{"id":"Q5"}}}}]);
    assert!(!sources::wikidata_matches(
        &entity,
        &["Favorite".into()],
        true
    ));
    entity["claims"]["P154"][1]["rank"] = json!("normal");
    assert_eq!(sources::wikidata_logo_file(&entity), None);
    entity["claims"]["P154"][0]["rank"] = json!("preferred");
    assert_eq!(
        sources::wikidata_logo_file(&entity),
        Some("Logo.svg".into())
    );
}
#[test]
fn commons_uses_raster_thumbnails_for_svg_and_rejects_missing_thumbnails() {
    let info = json!({"mime":"image/svg+xml","url":"https://upload.wikimedia.org/logo.svg","thumburl":"https://upload.wikimedia.org/thumb/logo.svg/512px-logo.svg.png","thumbmime":"image/png"});
    assert!(
        sources::commons_raster_url(&info)
            .unwrap()
            .ends_with(".png")
    );
    assert_eq!(
        sources::commons_raster_url(
            &json!({"mime":"image/svg+xml","url":"https://upload.wikimedia.org/logo.svg"})
        ),
        None
    );
    assert_eq!(
        sources::commons_raster_url(
            &json!({"mime":"image/png","url":"https://evil.test/logo.png"})
        ),
        None
    );
}

#[test]
fn upgrading_resolver_retries_old_misses_without_replacing_existing_artwork() {
    let mut record = LogoRecord {
        path: None,
        custom: false,
        source: None,
        checked_at: 1,
        retry_after: u64::MAX,
        resolver_version: 1,
    };
    assert!(!cache_valid(&record, 2, false));
    record.path = Some("saved.png".into());
    assert!(cache_valid(&record, 2, true));
    record.path = None;
    record.resolver_version = RESOLVER_VERSION;
    assert!(cache_valid(&record, 2, false));
}

#[tokio::test]
#[ignore = "live Bangumi search and Wikidata/Commons smoke check; run explicitly"]
async fn live_additional_sources_verify_brand_and_decode_wikimedia_svg_thumbnail() {
    let client = crate::metadata::http_client().unwrap();
    let context = sources::Context {
        names: vec!["FAVORITE".into(), "F社".into()],
        game_ids: vec!["3650".into()],
        ..Default::default()
    };
    let url = sources::bangumi_search(&client, &context)
        .await
        .unwrap()
        .expect("verified FAVORITE brand should have an image");
    image::load_from_memory(&crate::metadata::download_cover(&url).await.unwrap()).unwrap();
    let context = sources::Context {
        names: vec!["Nintendo".into()],
        wikidata_ids: vec!["Q8093".into()],
        ..Default::default()
    };
    let url = sources::wikidata(&client, &context)
        .await
        .unwrap()
        .expect("Nintendo P154 should resolve to a raster thumbnail");
    let image =
        image::load_from_memory(&crate::metadata::download_cover(&url).await.unwrap()).unwrap();
    assert!(image.width() > 0 && image.height() > 0);
}
