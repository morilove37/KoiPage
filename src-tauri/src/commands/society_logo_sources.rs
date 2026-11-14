//! Additional sources are queried only after the existing artwork fails.
use super::*;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Default)]
pub(super) struct Context {
    pub names: Vec<String>,
    pub game_ids: Vec<String>,
    pub game_names: Vec<String>,
    pub wikidata_ids: Vec<String>,
    pub failed: bool,
}

fn push_name(names: &mut Vec<String>, name: &str) {
    if !name.trim().is_empty() && !names.iter().any(|n| identity(n) == identity(name)) {
        names.push(name.trim().into());
    }
}

fn person_names(person: &Value) -> Vec<String> {
    let mut names = Vec::new();
    if let Some(name) = person["name"].as_str() {
        push_name(&mut names, name);
    }
    for field in person["infobox"].as_array().into_iter().flatten() {
        if !matches!(
            field["key"].as_str(),
            Some("别名" | "简体中文名" | "日文名" | "英文名")
        ) {
            continue;
        }
        if let Some(name) = field["value"].as_str() {
            push_name(&mut names, name);
        }
        for alias in field["value"].as_array().into_iter().flatten() {
            if let Some(name) = alias["v"].as_str() {
                push_name(&mut names, name);
            }
        }
    }
    names
}

fn matches_names(actual: &[String], expected: &[String]) -> bool {
    actual
        .iter()
        .any(|a| !identity(a).is_empty() && expected.iter().any(|b| identity(a) == identity(b)))
}

fn producer_person(person: &Value) -> bool {
    person["career"]
        .as_array()
        .is_some_and(|careers| careers.iter().any(|c| c.as_str() == Some("producer")))
}

pub(super) fn verified_bangumi_brand(
    person: &Value,
    names: &[String],
    works: &Value,
    game_ids: &[String],
    game_names: &[String],
) -> bool {
    // Bangumi has real brands marked type=1. Verify credited development of an
    // actual library game instead of accepting/rejecting solely by person type.
    producer_person(person)
        && matches_names(&person_names(person), names)
        && works.as_array().is_some_and(|works| {
            works.iter().any(|work| {
                work["type"].as_u64() == Some(4)
                    && matches!(
                        work["staff"].as_str(),
                        Some("开发" | "游戏开发" | "製作" | "制作" | "游戏制作")
                    )
                    && (work["id"]
                        .as_u64()
                        .is_some_and(|id| game_ids.iter().any(|known| *known == id.to_string()))
                        || [work["name"].as_str(), work["name_cn"].as_str()]
                            .into_iter()
                            .flatten()
                            .any(|name| {
                                game_names.iter().any(|known| {
                                    !identity(known).is_empty() && identity(known) == identity(name)
                                })
                            }))
            })
        })
}

pub(super) async fn context(
    client: &reqwest::Client,
    db: &SqlitePool,
    name: &str,
) -> CmdResult<Context> {
    let rows: Vec<(Option<String>, Option<String>, String, Option<String>)> = sqlx::query_as(
        "SELECT vndb_id,bangumi_id,title,original_title FROM games WHERE trim(developer)=? ORDER BY id LIMIT 3")
        .bind(name).fetch_all(db).await?;
    let mut context = Context::default();
    push_name(&mut context.names, name);
    let mut filters = Vec::new();
    for (vn, bgm, title, original) in rows {
        if let Some(id) = vn.filter(|id| valid_id(id, Some('v'))) {
            filters.push(json!(["id", "=", id]));
        }
        if let Some(id) = bgm.filter(|id| valid_id(id, None)) {
            context.game_ids.push(id);
        }
        push_name(&mut context.game_names, &title);
        if let Some(original) = original {
            push_name(&mut context.game_names, &original);
        }
    }
    if !filters.is_empty() {
        let filters = if filters.len() == 1 {
            filters.remove(0)
        } else {
            filters.insert(0, json!("or"));
            Value::Array(filters)
        };
        let result = async {
            client.post("https://api.vndb.org/kana/vn").json(&json!({"filters":filters,"fields":"title,alttitle,developers.id,developers.name,developers.original,developers.aliases,developers.extlinks.url","results":3}))
                .send().await?.error_for_status()?.json::<Value>().await
        }.await;
        match result {
            Ok(value) => {
                let mut producers = Vec::new();
                for work in value["results"].as_array().into_iter().flatten() {
                    for field in ["title", "alttitle"] {
                        if let Some(title) = work[field].as_str() {
                            push_name(&mut context.game_names, title);
                        }
                    }
                    producers.extend(work["developers"].as_array().into_iter().flatten().cloned());
                }
                if let Some(id) = producer_id(&Value::Array(producers.clone()), name) {
                    for producer in producers
                        .iter()
                        .filter(|p| p["id"].as_str() == Some(id.as_str()))
                    {
                        for name in [producer["name"].as_str(), producer["original"].as_str()]
                            .into_iter()
                            .flatten()
                            .chain(
                                producer["aliases"]
                                    .as_array()
                                    .into_iter()
                                    .flatten()
                                    .filter_map(Value::as_str),
                            )
                        {
                            if context.names.len() < 12 {
                                push_name(&mut context.names, name);
                            }
                        }
                        for link in producer["extlinks"].as_array().into_iter().flatten() {
                            if let Some(url) = link["url"]
                                .as_str()
                                .and_then(|u| reqwest::Url::parse(u).ok())
                            {
                                if matches!(
                                    url.host_str(),
                                    Some("www.wikidata.org" | "wikidata.org")
                                ) {
                                    if let Some(id) = url
                                        .path()
                                        .strip_prefix("/wiki/")
                                        .filter(|id| valid_id(id, Some('Q')))
                                    {
                                        context.wikidata_ids.push(id.into());
                                    }
                                }
                            }
                        }
                    }
                }
            }
            Err(_) => context.failed = true,
        }
    }
    Ok(context)
}

pub(super) async fn bangumi_search(
    client: &reqwest::Client,
    context: &Context,
) -> CmdResult<Option<String>> {
    let token = crate::bangumi_sync::credentials::load().ok().flatten();
    let mut people = BTreeMap::new();
    for name in context.names.iter().take(3) {
        let mut request = client
            .post("https://api.bgm.tv/v0/search/persons")
            .query(&[("limit", "10")])
            .json(&json!({"keyword":name}));
        if let Some(token) = &token {
            request = request.bearer_auth(token);
        }
        let result: Value = request
            .send()
            .await
            .map_err(err)?
            .error_for_status()
            .map_err(err)?
            .json()
            .await
            .map_err(err)?;
        for person in result["data"].as_array().into_iter().flatten() {
            if producer_person(person) && matches_names(&person_names(person), &context.names) {
                if let Some(id) = person["id"].as_u64().filter(|id| *id > 0) {
                    people.insert(id, person.clone());
                }
            }
        }
    }
    let mut found = BTreeSet::new();
    let mut brands = Vec::new();
    if people.len() > 4 {
        return Ok(None);
    }
    for (id, person) in people {
        let mut request = client.get(format!("https://api.bgm.tv/v0/persons/{id}/subjects"));
        if let Some(token) = &token {
            request = request.bearer_auth(token);
        }
        let works: Value = request
            .send()
            .await
            .map_err(err)?
            .error_for_status()
            .map_err(err)?
            .json()
            .await
            .map_err(err)?;
        if verified_bangumi_brand(
            &person,
            &context.names,
            &works,
            &context.game_ids,
            &context.game_names,
        ) {
            found.insert(id);
            brands.push(person);
        }
    }
    if found.len() != 1 {
        return Ok(None);
    }
    Ok(["large", "medium", "small"]
        .into_iter()
        .filter_map(|size| brands[0]["images"][size].as_str())
        .find(|url| url.starts_with("https://") && !url.contains("no_icon"))
        .map(str::to_owned))
}

fn err(error: impl std::fmt::Display) -> CmdError {
    CmdError(error.to_string())
}

pub(super) fn wikidata_matches(entity: &Value, names: &[String], trusted_id: bool) -> bool {
    let human = entity["claims"]["P31"].as_array().is_some_and(|claims| {
        claims
            .iter()
            .any(|claim| claim["mainsnak"]["datavalue"]["value"]["id"].as_str() == Some("Q5"))
    });
    if human {
        return false;
    }
    if trusted_id {
        return true;
    }
    let labels = entity["labels"]
        .as_object()
        .into_iter()
        .flat_map(|o| o.values())
        .filter_map(|v| v["value"].as_str());
    let aliases = entity["aliases"]
        .as_object()
        .into_iter()
        .flat_map(|o| o.values())
        .flat_map(|v| v.as_array().into_iter().flatten())
        .filter_map(|v| v["value"].as_str());
    let matching = labels.chain(aliases).any(|label| {
        names
            .iter()
            .any(|name| !identity(name).is_empty() && identity(name) == identity(label))
    });
    let gaming = entity["descriptions"]
        .as_object()
        .is_some_and(|descriptions| {
            descriptions
                .values()
                .filter_map(|v| v["value"].as_str())
                .any(|v| {
                    let v = v.to_lowercase();
                    [
                        "video game",
                        "videogame",
                        "visual novel",
                        "eroge",
                        "ゲーム",
                        "游戏",
                        "遊戲",
                    ]
                    .iter()
                    .any(|word| v.contains(word))
                        && [
                            "developer",
                            "publisher",
                            "company",
                            "brand",
                            "studio",
                            "circle",
                            "group",
                            "software house",
                            "ブランド",
                            "メーカー",
                            "会社",
                            "企業",
                            "サークル",
                            "集団",
                            "公司",
                            "品牌",
                            "社团",
                            "社團",
                            "工作室",
                            "制作组",
                            "製作組",
                            "开发商",
                            "開發商",
                            "发行商",
                            "發行商",
                        ]
                        .iter()
                        .any(|word| v.contains(word))
                })
        });
    matching && gaming
}

pub(super) fn wikidata_logo_file(entity: &Value) -> Option<String> {
    let claims = entity["claims"]["P154"].as_array()?;
    let has_preferred = claims
        .iter()
        .any(|c| c["rank"].as_str() == Some("preferred"));
    let names: BTreeSet<_> = claims
        .iter()
        .filter(|c| c["rank"].as_str() == Some(if has_preferred { "preferred" } else { "normal" }))
        .filter_map(|c| c["mainsnak"]["datavalue"]["value"].as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect();
    (names.len() == 1)
        .then(|| names.into_iter().next())
        .flatten()
}

pub(super) fn commons_raster_url(info: &Value) -> Option<String> {
    let raster = |mime: &str| {
        matches!(
            mime,
            "image/png" | "image/jpeg" | "image/webp" | "image/gif"
        )
    };
    let url = if info["thumbmime"].as_str().is_some_and(raster) {
        info["thumburl"].as_str()
    } else if info["mime"].as_str().is_some_and(raster) {
        info["url"].as_str()
    } else {
        None
    }?;
    let parsed = reqwest::Url::parse(url).ok()?;
    (parsed.scheme() == "https"
        && matches!(
            parsed.host_str(),
            Some("upload.wikimedia.org" | "thumb.wikimedia.org")
        ))
    .then(|| url.into())
}

async fn wiki_json(
    client: &reqwest::Client,
    host: &str,
    query: &[(&str, &str)],
) -> CmdResult<Value> {
    let value: Value = client
        .get(host)
        .query(query)
        .send()
        .await
        .map_err(err)?
        .error_for_status()
        .map_err(err)?
        .json()
        .await
        .map_err(err)?;
    if !value["error"].is_null() {
        return Err(CmdError("Wikimedia 查询暂时不可用".into()));
    }
    Ok(value)
}

pub(super) async fn wikidata(
    client: &reqwest::Client,
    context: &Context,
) -> CmdResult<Option<String>> {
    let mut ids: BTreeSet<String> = context.wikidata_ids.iter().cloned().collect();
    if ids.is_empty() {
        for name in context.names.iter().take(2) {
            for language in ["en", "ja"] {
                let result = wiki_json(
                    client,
                    "https://www.wikidata.org/w/api.php",
                    &[
                        ("action", "wbsearchentities"),
                        ("search", name),
                        ("language", language),
                        ("limit", "5"),
                        ("format", "json"),
                    ],
                )
                .await?;
                for entity in result["search"].as_array().into_iter().flatten() {
                    if let Some(id) = entity["id"].as_str().filter(|id| valid_id(id, Some('Q'))) {
                        ids.insert(id.into());
                    }
                }
            }
        }
    }
    if ids.is_empty() {
        return Ok(None);
    }
    let ids = ids.into_iter().take(20).collect::<Vec<_>>().join("|");
    let result = wiki_json(
        client,
        "https://www.wikidata.org/w/api.php",
        &[
            ("action", "wbgetentities"),
            ("ids", &ids),
            ("props", "labels|aliases|descriptions|claims"),
            ("languages", "en|ja|zh"),
            ("format", "json"),
        ],
    )
    .await?;
    let matches: Vec<_> = result["entities"]
        .as_object()
        .into_iter()
        .flat_map(|o| o.values())
        .filter(|entity| {
            let trusted = entity["id"]
                .as_str()
                .is_some_and(|id| context.wikidata_ids.iter().any(|known| known == id));
            wikidata_matches(entity, &context.names, trusted)
        })
        .collect();
    if matches.len() != 1 {
        return Ok(None);
    }
    let Some(file) = wikidata_logo_file(matches[0]) else {
        return Ok(None);
    };
    let title = format!("File:{file}");
    let result = wiki_json(
        client,
        "https://commons.wikimedia.org/w/api.php",
        &[
            ("action", "query"),
            ("titles", &title),
            ("prop", "imageinfo"),
            ("iiprop", "url|mime|thumbmime"),
            ("iiurlwidth", "512"),
            ("format", "json"),
            ("formatversion", "2"),
        ],
    )
    .await?;
    Ok(result["query"]["pages"]
        .as_array()
        .and_then(|pages| pages.first())
        .and_then(|page| page["imageinfo"].as_array())
        .and_then(|info| info.first())
        .and_then(commons_raster_url))
}
