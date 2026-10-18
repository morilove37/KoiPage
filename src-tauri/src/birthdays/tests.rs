use super::{model::*, providers::*, store::*};
use serde_json::json;
use sqlx::sqlite::SqlitePoolOptions;

async fn database() -> sqlx::SqlitePool {
    let db = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    sqlx::raw_sql(include_str!("../../migrations/0001_init.sql"))
        .execute(&db)
        .await
        .unwrap();
    sqlx::raw_sql(include_str!("../../migrations/0003_birthdays.sql"))
        .execute(&db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO games(id,title,install_path,vndb_id,created_at,updated_at) VALUES(1,'测试作品','E:/test','v17','2026-01-01','2026-01-01'),(2,'续作','E:/test2','v18','2026-01-01','2026-01-01')").execute(&db).await.unwrap();
    db
}
fn work() -> SyncWork {
    SyncWork {
        game_id: 1,
        title: "测试作品".into(),
        source: "vndb".into(),
        external_id: "v17".into(),
    }
}
fn person() -> SourceCharacter {
    SourceCharacter {
        external_id: "c1".into(),
        name: "角色".into(),
        original_name: Some("原名".into()),
        month: Some(2),
        day: Some(29),
        raw: Some("2月29日".into()),
        avatar: None,
        role: "primary".into(),
        spoiler: 0,
    }
}

#[test]
fn parse_vndb_releases_and_spoilers_without_duplicates() {
    let response = json!({"results":[
      {"id":"c1","name":"Name","original":"原名","birthday":[2,29],"vns":[{"id":"v17","role":"side","spoiler":0},{"id":"v17","role":"primary","spoiler":0},{"id":"v17","role":"primary","spoiler":1}]},
      {"id":"c2","name":"秘密","birthday":[4,31],"vns":[{"id":"v17","role":"primary","spoiler":1}]},
      {"id":"c3","name":"配角","vns":[{"id":"v17","role":"side","spoiler":0}]}
    ]});
    let chars = parse_vndb(&response, "v17").unwrap();
    assert_eq!(chars.len(), 1);
    assert_eq!(chars[0].name, "原名");
    assert_eq!(chars[0].month, Some(2));
}
#[test]
fn bangumi_structured_dates_and_conservative_infobox_fallback() {
    let a=parse_bangumi(&json!({"id":10,"name":"原名","birth_mon":10,"birth_day":18,"infobox":[{"key":"简体中文名","value":"中文名"}]})).unwrap();
    assert_eq!(a.name, "中文名");
    assert_eq!((a.month, a.day), (Some(10), Some(18)));
    let b = parse_bangumi(
        &json!({"id":11,"name":"角色","infobox":[{"key":"生日","value":"2000年2月29日"}]}),
    )
    .unwrap();
    assert_eq!((b.month, b.day), (Some(2), Some(29)));
    for value in ["春天", "2月30日", "10月", "10月18日（另一说10月19日）"] {
        let c =
            parse_bangumi(&json!({"id":12,"name":"角色","infobox":[{"key":"生日","value":value}]}))
                .unwrap();
        assert_eq!((c.month, c.day), (None, None));
    }
}
#[tokio::test]
async fn upsert_keeps_overrides_and_a_character_can_link_multiple_works() {
    let db = database().await;
    save_work(&db, &work(), &[person()]).await.unwrap();
    update_character(
        &db,
        "vndb:c1",
        &CharacterEdit {
            name: Some("修正名".into()),
            month: Some(10),
            day: Some(18),
            avatar_file: None,
            hidden: true,
            reset: false,
        },
        None,
    )
    .await
    .unwrap();
    let mut changed = person();
    changed.name = "上游新名称".into();
    let mut second = work();
    second.game_id = 2;
    second.external_id = "v18".into();
    save_work(&db, &second, &[changed.clone()]).await.unwrap();
    save_work(&db, &work(), &[changed]).await.unwrap();
    let chars = list_characters(&db).await.unwrap();
    assert_eq!(chars.len(), 1);
    assert_eq!(chars[0].games.len(), 2);
    assert_eq!(chars[0].name, "修正名");
    assert_eq!(chars[0].birthday_month, Some(10));
    assert!(chars[0].hidden);
}
#[tokio::test]
async fn id_changes_and_deleted_games_do_not_leak_old_associations() {
    let db = database().await;
    save_work(&db, &work(), &[person()]).await.unwrap();
    sqlx::query("UPDATE games SET vndb_id='v999' WHERE id=1")
        .execute(&db)
        .await
        .unwrap();
    assert!(list_characters(&db).await.unwrap().is_empty());
    assert!(!save_work(&db, &work(), &[person()]).await.unwrap());
    sqlx::query("DELETE FROM games WHERE id=1")
        .execute(&db)
        .await
        .unwrap();
    assert!(list_characters(&db).await.unwrap().is_empty());
}
#[tokio::test]
async fn failed_refresh_keeps_cache_but_successful_empty_refresh_replaces_links() {
    let db = database().await;
    save_work(&db, &work(), &[person()]).await.unwrap();
    record_failure(&db, &work(), "网络错误").await.unwrap();
    assert_eq!(list_characters(&db).await.unwrap().len(), 1);
    assert_eq!(
        sync_work(&db, false)
            .await
            .unwrap()
            .iter()
            .map(|w| w.game_id)
            .collect::<Vec<_>>(),
        vec![2]
    );
    assert_eq!(sync_work(&db, true).await.unwrap().len(), 2);
    save_work(&db, &work(), &[]).await.unwrap();
    assert!(list_characters(&db).await.unwrap().is_empty());
}
#[tokio::test]
async fn invalid_manual_date_is_rejected_and_reset_restores_source() {
    let db = database().await;
    save_work(&db, &work(), &[person()]).await.unwrap();
    let mut edit = CharacterEdit {
        name: Some("修正".into()),
        month: Some(2),
        day: Some(30),
        avatar_file: None,
        hidden: false,
        reset: false,
    };
    assert!(update_character(&db, "vndb:c1", &edit, None).await.is_err());
    edit.day = Some(28);
    update_character(&db, "vndb:c1", &edit, None).await.unwrap();
    edit.reset = true;
    update_character(&db, "vndb:c1", &edit, None).await.unwrap();
    let c = list_characters(&db).await.unwrap().remove(0);
    assert_eq!(c.name, "角色");
    assert_eq!(c.birthday_day, Some(29));
    assert!(!c.customized);
}

#[tokio::test]
async fn portable_roundtrip_preserves_edits_and_links_by_external_work_not_local_id() {
    let db = database().await;
    save_work(&db, &work(), &[person()]).await.unwrap();
    let edit = CharacterEdit {
        name: Some("个人译名".into()),
        month: Some(12),
        day: Some(31),
        avatar_file: None,
        hidden: true,
        reset: false,
    };
    update_character(&db, "vndb:c1", &edit, None).await.unwrap();
    let data = super::portable::export_data(&db).await.unwrap();
    let other = database().await;
    sqlx::query("UPDATE games SET id=99 WHERE id=1")
        .execute(&other)
        .await
        .unwrap();
    super::portable::import_data(
        &other,
        data,
        std::path::Path::new("unused-birthday-test-avatar-dir"),
    )
    .await
    .unwrap();
    let chars = list_characters(&other).await.unwrap();
    assert_eq!(chars[0].games[0].id, 99);
    assert_eq!(chars[0].name, "个人译名");
    assert!(chars[0].hidden);
    assert_eq!(chars[0].birthday_day, Some(31));
}

#[tokio::test]
async fn invalid_portable_record_is_rejected_before_any_write() {
    let db = database().await;
    save_work(&db, &work(), &[person()]).await.unwrap();
    let mut data = super::portable::export_data(&db).await.unwrap();
    let mut bad = data.characters[0].clone();
    bad.external_id = "../../bad".into();
    data.characters[0].override_name = Some("不应保存".into());
    data.characters.push(bad);
    assert!(
        super::portable::import_data(
            &db,
            data,
            std::path::Path::new("unused-birthday-test-avatar-dir")
        )
        .await
        .is_err()
    );
    assert_eq!(list_characters(&db).await.unwrap()[0].name, "角色");
}

#[tokio::test]
async fn portable_import_replaces_an_obsolete_work_link() {
    let db = database().await;
    save_work(&db, &work(), &[person()]).await.unwrap();
    let mut data = super::portable::export_data(&db).await.unwrap();
    sqlx::query("UPDATE games SET vndb_id='v18' WHERE id=1")
        .execute(&db)
        .await
        .unwrap();
    data.characters[0].works = vec!["v18".into()];
    super::portable::import_data(
        &db,
        data,
        std::path::Path::new("unused-birthday-test-avatar-dir"),
    )
    .await
    .unwrap();
    assert!(
        list_characters(&db).await.unwrap()[0]
            .games
            .iter()
            .any(|g| g.id == 1)
    );
}

#[tokio::test]
async fn signature_only_avatar_is_rejected_without_committing_edits() {
    let db = database().await;
    save_work(&db, &work(), &[person()]).await.unwrap();
    let mut data = super::portable::export_data(&db).await.unwrap();
    data.characters[0].override_name = Some("不应提交".into());
    let mut fake = b"\x89PNG\r\n\x1a\n".to_vec();
    fake.resize(24, 0);
    data.characters[0].override_avatar = Some(fake);
    assert!(
        super::portable::import_data(
            &db,
            data,
            std::path::Path::new("unused-birthday-test-avatar-dir")
        )
        .await
        .is_err()
    );
    assert_eq!(list_characters(&db).await.unwrap()[0].name, "角色");
}

#[tokio::test]
async fn cancellation_while_waiting_for_a_connection_preserves_existing_work() {
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    let db = database().await;
    save_work(&db, &work(), &[person()]).await.unwrap();
    let connection = db.acquire().await.unwrap();
    let cancel = Arc::new(AtomicBool::new(false));
    let signal = cancel.clone();
    let pool = db.clone();
    let task = tokio::spawn(async move {
        super::store::save_work_cancellable(&pool, &work(), &[], &signal).await
    });
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    cancel.store(true, Ordering::Relaxed);
    drop(connection);
    assert!(!task.await.unwrap().unwrap());
    assert_eq!(list_characters(&db).await.unwrap().len(), 1);
}

#[test]
fn avatar_decoder_accepts_all_supported_formats_and_rejects_truncation() {
    for format in [
        image::ImageFormat::Png,
        image::ImageFormat::Jpeg,
        image::ImageFormat::WebP,
        image::ImageFormat::Gif,
    ] {
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(4, 4)
            .write_to(&mut bytes, format)
            .unwrap();
        assert!(
            super::avatars::validate_image(bytes.get_ref()).is_ok(),
            "{format:?}"
        );
        assert!(
            super::avatars::validate_image(&bytes.get_ref()[..12]).is_err(),
            "{format:?}"
        );
    }
}
