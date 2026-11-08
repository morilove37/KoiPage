//! 2DFan's public, server-rendered catalogue (Nexus layout).
//! Scores use a five-point scale; normalize them before exposing metadata.
use super::{CmdError, CmdResult, MetadataCandidate, MetadataDetail, Provider, SourceRating};
use scraper::{ElementRef, Html, Selector};

const BASE: &str = "https://2dfan.com";

fn selector(css: &str) -> Selector { Selector::parse(css).expect("static 2DFan selector") }
fn text(element: ElementRef<'_>) -> String {
    element.text().collect::<Vec<_>>().join(" ").split_whitespace().collect::<Vec<_>>().join(" ")
}
fn first_text(root: ElementRef<'_>, css: &str) -> Option<String> {
    root.select(&selector(css)).map(text).find(|s| !s.is_empty())
}
fn absolute_url(value: &str) -> Option<String> {
    let url = reqwest::Url::parse(BASE).ok()?.join(value).ok()?;
    matches!(url.scheme(), "http" | "https").then(|| url.to_string())
}
fn score(value: f64) -> Option<f64> {
    (value.is_finite() && value > 0.0 && value <= 5.0).then(|| crate::rating::round_rating(value * 2.0))
}
fn island(root: ElementRef<'_>, name: &str) -> Option<serde_json::Value> {
    let css = format!("[data-island='{name}']");
    serde_json::from_str(root.select(&selector(&css)).next()?.attr("data-props")?).ok()
}

/// Nexus exposes aliases only when an alias matched the search. Never treat
/// body-text snippets as titles, and preserve words split by <mark> highlights.
fn search_aliases(card: ElementRef<'_>, query: &str) -> Vec<String> {
    let mut aliases = Vec::new();
    for matched in card.select(&selector(".subject-card-match")) {
        if first_text(matched, ".subject-card-match-label").as_deref() != Some("别名匹配") { continue; }
        let Some(snippet) = matched.select(&selector(".subject-card-match-text")).next() else { continue };
        let raw = snippet.text().collect::<String>();
        let raw = raw.split_whitespace().collect::<Vec<_>>().join(" ");
        // This is a flat excerpt, not a structured alias list. A space may
        // separate an edition suffix, so only trust a complete, exact excerpt.
        if !raw.is_empty() && !raw.contains('…') && !raw.contains("...")
            && super::matching::normalise(&raw) == super::matching::normalise(query)
            && !aliases.contains(&raw) {
            aliases.push(raw);
        }
    }
    aliases
}

fn parse_search(html: &str, query: &str, limit: usize) -> CmdResult<Vec<MetadataCandidate>> {
    let document = Html::parse_document(html);
    if document.select(&selector("#subject-list")).next().is_none() {
        return Err(CmdError("2DFan 搜索页面无法识别，可能需要登录、遇到访问验证或网站结构已变化".into()));
    }
    let mut result = Vec::new();
    for card in document.select(&selector("#subject-list .subject-card")).take(limit) {
        let Some(link) = card.select(&selector(".subject-card-title a")).next() else { continue };
        let Some(id) = link.attr("href").and_then(|href| href.strip_prefix("/subjects/"))
            .filter(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit())) else { continue };
        let title = text(link);
        if title.is_empty() { continue; }
        result.push(MetadataCandidate {
            provider: Provider::TwoDfan, external_id: id.into(), title,
            original_title: None, aliases: search_aliases(card, query),
            release_date: card.select(&selector("time[datetime]")).next().and_then(|e| e.attr("datetime")).map(str::to_owned),
            cover_url: card.select(&selector(".subject-card-cover img")).next().and_then(|e| e.attr("src")).and_then(absolute_url),
            rating: first_text(card, ".subject-card-score-value").and_then(|s| s.parse().ok()).and_then(score),
            source_label: "2DFan".into(),
        });
    }
    if limit > 0 && result.is_empty() && document.select(&selector("#subject-list .subject-card")).next().is_some() {
        return Err(CmdError("2DFan 搜索结果结构已变化，未能读取条目；请使用其他数据源或稍后重试".into()));
    }
    Ok(result)
}

fn parse_detail(html: &str, id: &str) -> CmdResult<MetadataDetail> {
    let document = Html::parse_document(html);
    let root = document.root_element();
    let title = first_text(root, "h1.subject-title").ok_or_else(|| CmdError("2DFan 详情页面无法识别，可能需要登录、遇到访问验证或网站结构已变化".into()))?;
    let mut developer = None;
    let mut release_date = None;
    let mut title_zh = None;
    let mut title_original = Some(title.clone());
    for row in root.select(&selector(".subject-meta-list .meta-row")) {
        let key = first_text(row, "dt").unwrap_or_default();
        let value = first_text(row, "dd");
        match key.trim_end_matches([':', '：']) {
            "品牌" | "开发商" => developer = value,
            "发售日期" => release_date = value.filter(|v| v != "未知" && v != "未定"),
            "中文名" | "中文名称" => title_zh = value,
            "原名" | "原题" => title_original = value,
            _ => {},
        }
    }
    let panel = island(root, "SubjectRatingPanel");
    let vote_count = panel.as_ref().and_then(|p| p.get("ranksCount")).and_then(|v| v.as_i64());
    let rating = panel.as_ref().and_then(|p| p.get("score")).and_then(|s| s.as_f64()).and_then(score)
        .filter(|_| vote_count != Some(0));
    let cover_url = island(root, "SubjectCoverImage").and_then(|p| p.get("src").and_then(|s| s.as_str()).and_then(absolute_url))
        .or_else(|| root.select(&selector(".subject-cover-img")).next().and_then(|img| img.attr("src")).and_then(absolute_url));
    let description = root.select(&selector(".subject-intro .intro-content")).next().map(|intro| {
        let mut output = String::new();
        for node in intro.descendants() {
            match node.value() {
                scraper::Node::Text(value) => output.push_str(value),
                scraper::Node::Element(element) if matches!(element.name(), "p" | "br" | "div" | "li") => output.push('\n'),
                _ => {},
            }
        }
        output.lines().map(str::trim).filter(|line| !line.is_empty()).collect::<Vec<_>>().join("\n")
    }).filter(|s| !s.is_empty());
    let mut tags = Vec::new();
    for tag in root.select(&selector(".subject-tags a[href^='/tags/'], .subject-tags-inline a[href^='/tags/']")) {
        let name = text(tag);
        if !name.is_empty() && !tags.contains(&name) { tags.push(name); }
    }
    Ok(MetadataDetail {
        provider: Some(Provider::TwoDfan), external_id: Some(id.into()), title, title_zh, title_original,
        developer, release_date, cover_url, description,
        description_lang: Some("zh".into()), description_source: Some(Provider::TwoDfan), tags, rating,
        ratings: rating.map(|score| vec![SourceRating { source: "2dfan".into(), score, vote_count }]).unwrap_or_default(),
        attribution: Some("2DFan".into()),
        ..Default::default()
    })
}

async fn fetch(url: reqwest::Url) -> CmdResult<String> {
    let mut response = super::http_client()?.get(url).header(reqwest::header::REFERER, BASE).send().await
        .map_err(|e| CmdError(if e.is_timeout() { "2DFan 请求超时，请稍后重试".into() } else { format!("2DFan 请求失败：{e}") }))?;
    let status = response.status();
    if response.headers().get("cf-mitigated").is_some_and(|value| value == "challenge") {
        return Err(CmdError("2DFan 触发了 Cloudflare 访问验证，暂时无法读取资料；请使用其他数据源，或稍后重试。浏览器验证状态不会自动同步到应用。".into()));
    }
    if !status.is_success() { return Err(CmdError(format!("2DFan 返回 HTTP {status}，请稍后重试或在浏览器检查访问状态"))); }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| CmdError(format!("2DFan 页面读取失败：{e}")))? {
        if bytes.len() + chunk.len() > 4 * 1024 * 1024 { return Err(CmdError("2DFan 页面过大，无法解析".into())); }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes).map_err(|_| CmdError("2DFan 页面编码无法识别".into()))
}

pub async fn search(query: &str, limit: u32) -> CmdResult<Vec<MetadataCandidate>> {
    let mut url = reqwest::Url::parse(&format!("{BASE}/search")).unwrap();
    url.query_pairs_mut().append_pair("keyword", query);
    parse_search(&fetch(url).await?, query, limit as usize)
}
pub async fn detail(id: &str) -> CmdResult<MetadataDetail> {
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit()) { return Err(CmdError("2DFan 条目 ID 必须为数字".into())); }
    let url = reqwest::Url::parse(&format!("{BASE}/subjects/{id}")).unwrap();
    parse_detail(&fetch(url).await?, id)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SEARCH: &str = r#"<div id="subject-list"><div class="subject-card" id="subject_card_21">
      <h3 class="subject-card-title"><a href="/subjects/21">Test &amp; Story</a></h3>
      <div class="subject-card-cover"><img src="https://img.achost.top/test.jpg"></div>
      <span class="subject-card-score-value">4.5</span><time datetime="2004-04-28"></time>
    </div><div class="subject-card" id="subject_card_22">
      <h3 class="subject-card-title"><a href="/subjects/22">Other</a></h3>
    </div></div>"#;
    const DETAIL: &str = r#"<h1 class="subject-title">Test &amp; Story</h1>
      <div data-island="SubjectCoverImage" data-props="{&quot;src&quot;:&quot;https://img.achost.top/full.jpg&quot;}"></div>
      <div class="subject-meta-list">
        <div class="meta-row"><dt>品牌</dt><dd><a>Studio</a></dd></div>
        <div class="meta-row"><dt>发售日期</dt><dd>2004-04-28</dd></div>
        <div class="meta-row"><dt>又名</dt><dd>测试物语</dd></div>
      </div>
      <div data-island="SubjectRatingPanel" data-props="{&quot;score&quot;:4.5,&quot;ranksCount&quot;:330}"></div>
      <div class="subject-tags"><a href="/tags/adv">ADV</a></div>
      <section class="subject-intro"><div class="intro-content"><p>第一段。</p><p>第二段 &amp; 尾声。</p></div></section>"#;

    #[test]
    fn search_reads_only_subject_cards_and_normalizes_five_point_score() {
        let result = parse_search(SEARCH, "Test & Story", 1).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].external_id, "21");
        assert_eq!(result[0].provider.as_str(), "2dfan");
        assert_eq!(result[0].title, "Test & Story");
        assert_eq!(result[0].rating, Some(9.0));
        assert_eq!(result[0].release_date.as_deref(), Some("2004-04-28"));
        assert_eq!(parse_search(SEARCH, "Test & Story", 10).unwrap()[1].rating, None);
    }

    #[test]
    fn alias_matches_keep_highlighted_chinese_and_multiword_english_titles() {
        for (query, snippet) in [("魔女的夜宴", "<mark>魔</mark>女的夜宴"), ("Sanoba Witch", "<mark>Sanoba</mark> Witch")] {
            let html = SEARCH.replace("Test &amp; Story</a>", "サノバウィッチ</a>")
                .replace("<span class=\"subject-card-score-value\">", &format!(r#"<p class="subject-card-match"><span class="subject-card-match-label">别名匹配</span><span class="subject-card-match-text">{snippet}</span></p><span class="subject-card-score-value">"#));
            let result = parse_search(&html, query, 1).unwrap();
            assert_eq!(result[0].aliases, vec![query.to_string()]);
            assert_eq!(super::super::matching::score(query, &result[0]), super::super::matching::Match::Exact);
        }
    }

    #[test]
    fn prose_matches_and_truncated_aliases_do_not_become_automatic_matches() {
        for (label, snippet) in [("正文匹配", "<mark>魔</mark>女的夜宴"), ("别名匹配", "魔女的夜宴…"), ("别名匹配", "CLANNAD Side Stories…")] {
            let html = SEARCH.replace("Test &amp; Story</a>", "Other title</a>")
                .replace("<span class=\"subject-card-score-value\">", &format!(r#"<p class="subject-card-match"><span class="subject-card-match-label">{label}</span><span class="subject-card-match-text">{snippet}</span></p><span class="subject-card-score-value">"#));
            let result = parse_search(&html, "魔女的夜宴", 1).unwrap();
            assert!(result[0].aliases.is_empty(), "{label}: {snippet}");
        }
    }

    #[test]
    fn mixed_alias_snippets_cannot_turn_a_remake_into_the_original() {
        for snippet in ["<mark>纯</mark>白交响曲 SANA EDITION Mashir…", "<mark>纯</mark>白交响曲 -Love is pure white…", "纯白交响曲 SANA EDITION", "纯白交响曲 FHD"] {
            let html = SEARCH.replace("Test &amp; Story</a>", "ましろ色シンフォニー SANA EDITION</a>")
                .replace("<span class=\"subject-card-score-value\">", &format!(r#"<p class="subject-card-match"><span class="subject-card-match-label">别名匹配</span><span class="subject-card-match-text">{snippet}</span></p><span class="subject-card-score-value">"#));
            let result = parse_search(&html, "纯白交响曲", 1).unwrap();
            assert!(!super::super::matching::score("纯白交响曲", &result[0]).is_confident(), "{snippet}");
        }
    }

    #[test]
    fn changed_nonempty_cards_are_an_error_instead_of_a_successful_empty_search() {
        assert!(parse_search("<div id='subject-list'><div class='subject-card'><h3>Changed markup</h3></div></div>", "test", 10).is_err());
        assert!(parse_search(SEARCH, "test", 0).unwrap().is_empty());
    }

    #[tokio::test]
    async fn cloudflare_challenge_has_a_specific_actionable_error() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
            let mut request = [0; 4096];
            socket.read(&mut request).unwrap();
            socket.write_all(b"HTTP/1.1 403 Forbidden\r\ncf-mitigated: challenge\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
        });
        let error = fetch(reqwest::Url::parse(&format!("http://{address}/search")).unwrap()).await.unwrap_err();
        server.join().unwrap();
        assert!(error.0.contains("访问验证"), "{}", error.0);
        assert!(error.0.contains("其他数据源"));
    }

    #[tokio::test]
    #[ignore = "requests live 2DFan alias search"]
    async fn live_search_keeps_alias_candidates() {
        for (query, id) in [("魔女的夜宴", "2588"), ("Senren Banka", "3100")] {
            let results = search(query, 5).await.unwrap();
            let candidate = results.iter().find(|c| c.external_id == id).expect("expected subject");
            println!("{query}: {} candidates; title={}", results.len(), candidate.title);
        }
    }
    #[test]
    fn detail_extracts_fields_and_keeps_paragraphs_without_html() {
        let detail = parse_detail(DETAIL, "21").unwrap();
        assert_eq!(detail.title, "Test & Story");
        assert_eq!(detail.developer.as_deref(), Some("Studio"));
        assert_eq!(detail.release_date.as_deref(), Some("2004-04-28"));
        assert_eq!(detail.cover_url.as_deref(), Some("https://img.achost.top/full.jpg"));
        assert_eq!(detail.rating, Some(9.0));
        assert_eq!(detail.ratings[0].vote_count, Some(330));
        assert_eq!(detail.tags, vec!["ADV"]);
        assert!(detail.description.as_deref().unwrap().contains("第一段。\n"));
        assert!(!detail.description.as_deref().unwrap().contains("<p>"));
    }
    #[test]
    fn challenge_and_changed_markup_report_failure_instead_of_no_matches() {
        assert!(parse_search("<html>Just a moment...</html>", "test", 10).is_err());
        assert!(parse_detail("<h1>登录</h1>", "21").is_err());
        assert!(parse_search("<div id='subject-list'></div>", "test", 10).unwrap().is_empty());
    }
    #[test]
    fn unrated_subject_does_not_gain_a_zero_rating() {
        let detail = parse_detail(&DETAIL.replace("4.5", "0.0").replace("330", "0"), "21").unwrap();
        assert_eq!(detail.rating, None);
        assert!(detail.ratings.is_empty());
    }

    #[tokio::test]
    #[ignore = "requests the live 2DFan website"]
    async fn live_search_and_detail() {
        let results = search("CLANNAD", 3).await.unwrap();
        let candidate = results.iter().find(|c| c.external_id == "21").expect("CLANNAD should be present");
        let detail = detail(&candidate.external_id).await.unwrap();
        assert_eq!(detail.title, "CLANNAD");
        assert_eq!(detail.developer.as_deref(), Some("Key"));
        assert_eq!(detail.release_date.as_deref(), Some("2004-04-28"));
        assert!(detail.cover_url.is_some());
        assert!(detail.description.as_deref().unwrap_or("").contains("CLANNAD"));
        assert!(detail.tags.contains(&"ADV".to_string()));
        assert!(detail.ratings[0].vote_count.unwrap_or_default() > 0);
        println!("2DFan: {} hits; {} / {:?} / {:?}; {} tags", results.len(), detail.title, detail.developer, detail.rating, detail.tags.len());
    }
}
