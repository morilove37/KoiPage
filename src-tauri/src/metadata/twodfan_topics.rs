//! 2DFan's guide/topic pages (`/subjects/{id}/topics` and `/topics/{id}`).
//!
//! The topic body is *structured* here rather than passed through as HTML: the
//! frontend never renders raw markup, so this module is the only place that has
//! to understand 2DFan's (very inconsistent) authoring markup. Bodies range from
//! plain `<p>`/`<br>` line dumps to nested tables and figure images, so blocks
//! are produced by walking the element tree instead of matching a fixed shape.

use super::twodfan::{absolute_url, fetch, first_text, selector, VERIFY_HINT};
use super::{CmdError, CmdResult};
use scraper::{ElementRef, Html, Node};
use serde::{Deserialize, Serialize};

/// One row of `/subjects/{id}/topics`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TwodfanTopic {
    pub topic_id: i64,
    /// Discussion type as labelled by 2DFan (`攻略` / `感想`), when present.
    pub kind: Option<String>,
    pub title: String,
    pub author: Option<String>,
    /// Raw `datetime` attribute of the row's `<time>`, i.e. an ISO instant.
    pub published_at: Option<String>,
    pub url: String,
}

/// Block kinds the frontend knows how to render.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TopicBlockKind {
    Paragraph,
    /// One hard-wrapped line (`<br>`-separated) of a paragraph.
    Line,
    Heading,
    Table,
    Image,
}

/// One renderable chunk of a topic body.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicBlock {
    pub kind: TopicBlockKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub src: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rows: Option<Vec<Vec<String>>>,
}

impl TopicBlock {
    fn text(kind: TopicBlockKind, value: impl Into<String>) -> Self {
        Self { kind, text: Some(value.into()), src: None, rows: None }
    }
    fn image(src: impl Into<String>) -> Self {
        Self { kind: TopicBlockKind::Image, text: None, src: Some(src.into()), rows: None }
    }
    fn table(rows: Vec<Vec<String>>) -> Self {
        Self { kind: TopicBlockKind::Table, text: None, src: None, rows: Some(rows) }
    }
}

/// A whole topic: every page concatenated into one block list.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TwodfanTopicContent {
    pub topic_id: i64,
    pub title: String,
    pub author: Option<String>,
    pub published_at: Option<String>,
    pub url: String,
    pub page_count: u32,
    pub blocks: Vec<TopicBlock>,
}

/// Collapse runs of whitespace, the way every other 2DFan reader does.
fn normalise(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn is_ad(element: ElementRef<'_>) -> bool {
    is_ad_element(element.value())
}

/// Split a paragraph's text into hard-wrapped lines.
///
/// `<p>a<br>b</p>` must stay two lines (guides use `<br>` as the line
/// separator), while `a\n  b` from source indentation must collapse to one.
fn lines_of(raw: &str) -> Vec<String> {
    raw.split('\n').map(normalise).filter(|line| !line.is_empty()).collect()
}

/// Flatten an element's inline content, treating `<br>` as a newline.
///
/// Images are collected separately: they are block-level for the UI and must
/// not be dropped just because they sit inside a paragraph.
fn inline_content(element: ElementRef<'_>, images: &mut Vec<String>) -> String {
    let mut output = String::new();
    for node in element.descendants() {
        match node.value() {
            Node::Text(value) => output.push_str(value),
            Node::Element(inner) if inner.name() == "br" => output.push('\n'),
            Node::Element(inner) if inner.name() == "img" => {
                if is_ad_element(inner) {
                    continue;
                }
                if let Some(src) = inner.attr("src").and_then(absolute_url) {
                    images.push(src);
                }
            }
            _ => {},
        }
    }
    output
}

fn is_ad_element(element: &scraper::node::Element) -> bool {
    element
        .attr("class")
        .is_some_and(|classes| classes.split_whitespace().any(|class| class.starts_with("nexus-ad")))
}

/// Emit text blocks for one flow container (paragraph, list item, heading).
fn push_flow(element: ElementRef<'_>, heading: bool, out: &mut Vec<TopicBlock>) {
    let mut images = Vec::new();
    let raw = inline_content(element, &mut images);
    let lines = lines_of(&raw);
    if heading {
        if let Some(first) = lines.first() {
            out.push(TopicBlock::text(TopicBlockKind::Heading, first.clone()));
        }
    } else if lines.len() == 1 {
        out.push(TopicBlock::text(TopicBlockKind::Paragraph, lines[0].clone()));
    } else {
        for line in lines {
            out.push(TopicBlock::text(TopicBlockKind::Line, line));
        }
    }
    for src in images {
        out.push(TopicBlock::image(src));
    }
}

/// Emit one table block. Rows keep their `th`/`td` cells in document order.
fn push_table(element: ElementRef<'_>, out: &mut Vec<TopicBlock>) {
    let mut rows = Vec::new();
    for row in element.select(&selector("tr")) {
        let cells: Vec<String> = row
            .select(&selector("th, td"))
            .map(|cell| normalise(&cell.text().collect::<String>()))
            .collect();
        if cells.iter().any(|cell| !cell.is_empty()) {
            rows.push(cells);
        }
    }
    if !rows.is_empty() {
        out.push(TopicBlock::table(rows));
    }
}

fn push_image(element: ElementRef<'_>, out: &mut Vec<TopicBlock>) {
    if is_ad(element) {
        return;
    }
    if let Some(src) = element.attr("src").and_then(absolute_url) {
        out.push(TopicBlock::image(src));
    }
}

/// Does this element contain block-level children that must be walked separately?
fn has_block_children(element: ElementRef<'_>) -> bool {
    element
        .select(&selector("table, figure, div, section, article, blockquote, ul, ol"))
        .next()
        .is_some()
}

/// Walk one container's children, dispatching on the tag name.
///
/// `scraper` does not re-export `ego_tree::NodeRef`, so the walk stays on
/// `ElementRef` (which derefs to a node reference) and only child elements are
/// visited; text nodes are picked up by [`inline_content`] further down.
fn walk_children(node: ElementRef<'_>, out: &mut Vec<TopicBlock>) {
    for child in node.children() {
        let Some(element) = ElementRef::wrap(child) else { continue };
        match element.value().name() {
            "table" => push_table(element, out),
            "figure" => {
                if is_ad(element) {
                    continue;
                }
                if let Some(table) = element.select(&selector("table")).next() {
                    push_table(table, out);
                } else if let Some(image) = element.select(&selector("img")).next() {
                    push_image(image, out);
                }
            }
            "img" => push_image(element, out),
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => push_flow(element, true, out),
            "p" | "li" | "blockquote" => {
                if has_block_children(element) {
                    walk_children(element, out);
                } else {
                    push_flow(element, false, out);
                }
            }
            "div" | "section" | "article" | "ul" | "ol" | "tbody" | "center" => {
                walk_children(element, out);
            }
            "br" | "hr" | "script" | "style" => {},
            // A stray inline element at block level still carries text.
            _ => push_flow(element, false, out),
        }
    }
}

/// Body blocks of one page.
fn parse_blocks(html: &str) -> CmdResult<Vec<TopicBlock>> {
    let document = Html::parse_document(html);
    let body = document
        .select(&selector("#topic-content-body"))
        .next()
        .ok_or_else(|| CmdError(format!("2DFan 攻略正文无法识别，可能需要登录、遇到访问验证或网站结构已变化。{VERIFY_HINT}")))?;
    let mut blocks = Vec::new();
    walk_children(body, &mut blocks);
    Ok(blocks)
}

/// Highest page number advertised by the pagination bar (1 when absent).
fn page_count(html: &str) -> u32 {
    let document = Html::parse_document(html);
    let Some(nav) = document.select(&selector(".topic-content-pagination")).next() else { return 1 };
    let mut highest = 1u32;
    for item in nav.select(&selector("a, span")) {
        let from_href = item
            .attr("href")
            .and_then(|href| href.split("page=").nth(1))
            .and_then(|value| value.split(['&', '#']).next())
            .and_then(|value| value.parse::<u32>().ok());
        let from_text = item.text().collect::<String>().trim().parse::<u32>().ok();
        if let Some(page) = from_href.or(from_text) {
            highest = highest.max(page);
        }
    }
    highest
}

/// `h1.topic-title`, author and publish time of a topic page.
fn parse_header(html: &str, topic_id: i64) -> (String, Option<String>, Option<String>) {
    let document = Html::parse_document(html);
    let root = document.root_element();
    let title = first_text(root, "h1.topic-title").unwrap_or_else(|| format!("2DFan 帖子 {topic_id}"));
    let author = first_text(root, ".topic-author-name");
    let published_at = root
        .select(&selector("time.topic-time"))
        .next()
        .and_then(|element| element.attr("datetime"))
        .map(str::to_owned);
    (title, author, published_at)
}

/// Parse the topic list of one subject page.
pub fn parse_topics(html: &str) -> CmdResult<Vec<TwodfanTopic>> {
    let document = Html::parse_document(html);
    let rows = document.select(&selector(".resource-topic-row")).collect::<Vec<_>>();
    // An empty subject still renders the (empty) list container or the
    // "目前还没有该游戏的帖子" placeholder, so only a missing container is an error.
    if rows.is_empty()
        && document.select(&selector(".resource-topic-list")).next().is_none()
        && document.select(&selector(".review-empty")).next().is_none()
    {
        return Err(CmdError(format!("2DFan 攻略列表无法识别，可能需要登录、遇到访问验证或网站结构已变化。{VERIFY_HINT}")));
    }

    let mut topics = Vec::new();
    for row in rows {
        let Some(link) = row.select(&selector(".resource-topic-row__title")).next() else { continue };
        let Some(topic_id) = link
            .attr("href")
            .and_then(|href| href.strip_prefix("/topics/"))
            .and_then(|rest| rest.split(['?', '#', '/']).next())
            .and_then(|value| value.parse::<i64>().ok())
        else {
            continue;
        };
        let title = normalise(&link.text().collect::<String>());
        if title.is_empty() {
            continue;
        }
        let kind = first_text(row, ".resource-topic-row__type").filter(|value| !value.is_empty());
        let published_at = row
            .select(&selector(".resource-topic-row__meta time"))
            .next()
            .and_then(|element| element.attr("datetime"))
            .map(str::to_owned);
        // The author is the plain text before the `·` separator, when present.
        let author = first_text(row, ".resource-topic-row__meta").and_then(|meta| {
            let head = meta.split('·').next().unwrap_or_default().trim().to_string();
            (!head.is_empty() && head != meta.trim()).then_some(head)
        });
        topics.push(TwodfanTopic {
            topic_id,
            kind,
            title,
            author,
            published_at,
            url: format!("https://2dfan.com/topics/{topic_id}"),
        });
    }
    Ok(topics)
}

/// Reject anything that is not a bare 2DFan numeric id before building a URL.
fn numeric_id(value: &str) -> CmdResult<&str> {
    let value = value.trim();
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(CmdError("2DFan 条目 ID 必须为数字".into()));
    }
    Ok(value)
}

/// Scrape the topic list of a subject.
pub async fn topics(subject_id: &str) -> CmdResult<Vec<TwodfanTopic>> {
    let subject_id = numeric_id(subject_id)?;
    let url = reqwest::Url::parse(&format!("https://2dfan.com/subjects/{subject_id}/topics")).unwrap();
    parse_topics(&fetch(url).await?)
}

/// Scrape a whole topic, following its pagination.
///
/// Pages are fetched sequentially: 2DFan rate-limits aggressively and a guide
/// can run to a dozen pages, so parallelism would only earn a challenge page.
pub async fn topic(topic_id: i64) -> CmdResult<TwodfanTopicContent> {
    if topic_id <= 0 {
        return Err(CmdError("2DFan 帖子 ID 必须为正整数".into()));
    }
    const MAX_PAGES: u32 = 30;
    let first_url = reqwest::Url::parse(&format!("https://2dfan.com/topics/{topic_id}")).unwrap();
    let first = fetch(first_url).await?;
    let (title, author, published_at) = parse_header(&first, topic_id);
    let page_count = page_count(&first).clamp(1, MAX_PAGES);
    let mut blocks = parse_blocks(&first)?;
    for page in 2..=page_count {
        let url = reqwest::Url::parse(&format!("https://2dfan.com/topics/{topic_id}?page={page}")).unwrap();
        let html = fetch(url).await?;
        blocks.extend(parse_blocks(&html)?);
    }
    Ok(TwodfanTopicContent {
        topic_id,
        title,
        author,
        published_at,
        url: format!("https://2dfan.com/topics/{topic_id}"),
        page_count,
        blocks,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIST: &str = r#"
    <div class="resource-topic-list">
      <article class="resource-topic-row">
        <span class="resource-topic-row__type">攻略</span>
        <a class="resource-topic-row__title" href="/topics/19294">CLANNAD宿管智代线攻略</a>
        <span class="resource-topic-row__meta">
          9385311 · <time datetime="2025-01-03T18:38:30+08:00">2025-01-03</time>
        </span>
      </article>
      <article class="resource-topic-row">
        <a class="resource-topic-row__title" href="/topics/7794">Little Busters!EX 中文攻略 </a>
        <span class="resource-topic-row__meta"><time datetime="2017-01-02T03:04:05+08:00">2017-01-02</time></span>
      </article>
    </div>"#;

    const EMPTY: &str = r#"<div class="review-empty"><span class="empty-icon">?</span><p>目前还没有该游戏的帖子</p></div>"#;

    const BODY: &str = r#"
    <turbo-frame id="topic-content">
      <div class="topic-content" id="topic-content-body">
        <h2>标题</h2>
        <p>【SAVE4】<br>受理<br>藤林姐妹</p>
        <figure class="table"><table border="1"><tbody>
          <tr><td>线</td><td>结果</td></tr>
          <tr><td>智代</td><td>TRUE END</td></tr>
        </tbody></table></figure>
        <figure class="nexus-ad"><img class="nexus-ad__img" src="https://img.achost.top/ad/banner.jpg" /></figure>
        <figure><img src="/uploads/subjects/packages/normal_abc.jpg" /></figure>
        <p></p>
      </div>
      <div class="topic-content-pagination"><nav class="nexus-pagination">
        <span class="nexus-pagination-item nexus-pagination-item--active">1</span>
        <a class="nexus-pagination-item" rel="next" href="/topics/7879?page=2">2</a>
        <a class="nexus-pagination-last" href="/topics/7879?page=7">尾页</a>
      </nav></div>
    </turbo-frame>"#;

    #[test]
    fn topic_rows_are_trimmed_and_keep_kind_author_and_date() {
        let topics = parse_topics(LIST).unwrap();
        assert_eq!(topics.len(), 2);
        assert_eq!(topics[0].topic_id, 19294);
        assert_eq!(topics[0].kind.as_deref(), Some("攻略"));
        assert_eq!(topics[0].author.as_deref(), Some("9385311"));
        assert_eq!(topics[0].published_at.as_deref(), Some("2025-01-03T18:38:30+08:00"));
        // Trailing space in the anchor text must not survive.
        assert_eq!(topics[1].title, "Little Busters!EX 中文攻略");
        // A row without the type span (the /walkthroughs layout) has no kind.
        assert_eq!(topics[1].kind, None);
        assert_eq!(topics[1].author, None);
    }

    #[test]
    fn an_empty_subject_is_an_empty_list_not_an_error() {
        assert!(parse_topics(EMPTY).unwrap().is_empty());
    }

    #[test]
    fn unrecognisable_list_pages_report_the_verification_hint() {
        let error = parse_topics("<html><body><p>blocked</p></body></html>").unwrap_err();
        assert!(error.0.contains("2DFan 攻略列表无法识别"), "{}", error.0);
    }

    #[test]
    fn body_blocks_split_hard_wrapped_lines_and_keep_tables_and_images() {
        let blocks = parse_blocks(BODY).unwrap();
        assert_eq!(blocks[0].kind, TopicBlockKind::Heading);
        assert_eq!(blocks[0].text.as_deref(), Some("标题"));
        // `a<br>b<br>c` is three lines, never one run-together paragraph.
        assert_eq!(blocks[1].kind, TopicBlockKind::Line);
        assert_eq!(blocks[1].text.as_deref(), Some("【SAVE4】"));
        assert_eq!(blocks[3].text.as_deref(), Some("藤林姐妹"));
        let table = blocks.iter().find(|block| block.kind == TopicBlockKind::Table).unwrap();
        assert_eq!(table.rows.as_ref().unwrap().len(), 2);
        assert_eq!(table.rows.as_ref().unwrap()[1], vec!["智代".to_string(), "TRUE END".to_string()]);
        // The ad figure is dropped; the real figure image is made absolute.
        let images = blocks.iter().filter(|block| block.kind == TopicBlockKind::Image).collect::<Vec<_>>();
        assert_eq!(images.len(), 1);
        assert_eq!(images[0].src.as_deref(), Some("https://2dfan.com/uploads/subjects/packages/normal_abc.jpg"));
        assert!(blocks.iter().all(|block| block.text.as_deref() != Some("")));
    }

    #[test]
    fn pagination_reports_the_last_advertised_page() {
        assert_eq!(page_count(BODY), 7);
        assert_eq!(page_count("<div class='topic-content' id='topic-content-body'></div>"), 1);
        // A last page has only first/prev links, so the max still comes from the numbers.
        let last = r#"<div class="topic-content-pagination"><nav>
            <a class="nexus-pagination-first" href="/topics/7879">首页</a>
            <a class="nexus-pagination-prev" rel="prev" href="/topics/7879?page=6">上一页</a>
            <span class="nexus-pagination-item nexus-pagination-item--active">7</span>
        </nav></div>"#;
        assert_eq!(page_count(last), 7);
    }

    #[test]
    fn a_page_without_the_body_container_is_an_actionable_error() {
        let error = parse_blocks("<html><body></body></html>").unwrap_err();
        assert!(error.0.contains("2DFan 攻略正文无法识别"), "{}", error.0);
    }

    #[test]
    fn subject_ids_must_be_numeric() {
        // The check runs before any request, so no server is needed here.
        assert!(numeric_id("21").is_ok());
        assert!(numeric_id("../../etc").unwrap_err().0.contains("必须为数字"));
        assert!(numeric_id("  ").unwrap_err().0.contains("必须为数字"));
    }
}
