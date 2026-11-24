//! `twodfan_topics_list` / `twodfan_topic_read` — 2DFan guides for one game.
//!
//! Scraping is expensive and 2DFan rate-limits hard, so results are cached in
//! SQLite (`twodfan_topic_list` / `twodfan_topic`) and only re-fetched when the
//! caller asks to refresh or the cached copy is older than [`CACHE_TTL`].

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tauri::{AppHandle, Manager};

use super::error::{CmdError, CmdResult};
use super::games::pool;
use super::util::{now_iso8601, optional_string};
use crate::metadata::twodfan_topics::{self, TwodfanTopic, TwodfanTopicContent};
use crate::metadata::{matching, twodfan, MetadataCandidate};

/// How long a cached copy is served before the next open re-scrapes.
const CACHE_TTL_SECONDS: i64 = 24 * 60 * 60;

/// How long a failed auto-bind attempt is remembered.
///
/// Without this, opening an unbound game would pay two 20-second timeouts every
/// time, because 2DFan is frequently unreachable and each query has its own
/// request budget.
const AUTOBIND_COOLDOWN_SECONDS: i64 = 6 * 60 * 60;

/// How long one VNDB relations answer is reused.
///
/// Relations are near-static, so a long window costs nothing in correctness and
/// saves one API round-trip per game in a series.
const RELATION_CACHE_TTL_SECONDS: i64 = 7 * 24 * 60 * 60;

/// Settings key holding the last auto-bind attempt for one game.
fn autobind_key(game_id: i64) -> String {
    format!("twodfan_autobind:{game_id}")
}

/// Read `games.twodfan_id` for one game, so the UI can tell bound from unbound.
async fn bound_subject(pool: &SqlitePool, game_id: i64) -> CmdResult<Option<String>> {
    let row: Option<(Option<String>,)> = sqlx::query_as("SELECT twodfan_id FROM games WHERE id = ?")
        .bind(game_id)
        .fetch_optional(pool)
        .await?;
    match row {
        Some((value,)) => Ok(optional_string(value)),
        None => Err(CmdError(format!("游戏 {game_id} 不存在"))),
    }
}

/// Seconds since an ISO8601 instant, or `None` when it cannot be parsed.
fn age_seconds(fetched_at: &str) -> Option<i64> {
    let parsed = time::OffsetDateTime::parse(fetched_at, &time::format_description::well_known::Rfc3339).ok()?;
    Some((time::OffsetDateTime::now_utc() - parsed).whole_seconds())
}

fn is_fresh(fetched_at: &str) -> bool {
    is_recent(fetched_at, CACHE_TTL_SECONDS)
}

/// Whether a recorded instant is inside `window` seconds of the past.
fn is_recent(fetched_at: &str, window: i64) -> bool {
    age_seconds(fetched_at).is_some_and(|age| (0..window).contains(&age))
}

/// Outcome of one automatic binding attempt.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutobindResult {
    /// The subject id that was just written to `games.twodfan_id`, if any.
    pub subject_id: Option<String>,
    /// The matched 2DFan title, for the confirmation toast.
    pub title: Option<String>,
    /// Why nothing was bound; `None` when `subject_id` is set.
    pub reason: Option<String>,
    /// True when the attempt failed because 2DFan could not be reached at all.
    ///
    /// A sweep stops on the first such failure: one timeout already proves the
    /// site is unreachable, so paying it once per game would keep the app busy
    /// for half an hour for nothing.
    #[serde(default)]
    pub transport_error: bool,
}

impl AutobindResult {
    fn bound(candidate: &MetadataCandidate) -> Self {
        Self {
            subject_id: Some(candidate.external_id.clone()),
            title: Some(candidate.title.clone()),
            reason: None,
            transport_error: false,
        }
    }

    fn skipped(reason: impl Into<String>) -> Self {
        Self {
            subject_id: None,
            title: None,
            reason: Some(reason.into()),
            transport_error: false,
        }
    }

    fn unreachable(error: String) -> Self {
        Self {
            subject_id: None,
            title: None,
            reason: Some(format!("自动匹配 2DFan 失败：{error}")),
            transport_error: true,
        }
    }
}

/// Titles worth searching for, most specific first.
///
/// The Chinese title is the one 2DFan itself uses, so it is the best key; the
/// original-script title catches entries that were never localized.
fn search_terms(title: &str, original_title: Option<&str>) -> Vec<String> {
    let mut terms = Vec::new();
    for value in [Some(title), original_title].into_iter().flatten() {
        let trimmed = value.trim();
        if !trimmed.is_empty() && !terms.iter().any(|existing| existing == trimmed) {
            terms.push(trimmed.to_string());
        }
    }
    terms
}

/// Search 2DFan for one game and bind the subject when the match is confident.
///
/// Only `Exact` and `Strong` matches bind: a `Weak` overlap is exactly the kind
/// of false positive that would silently attach the wrong walkthrough. Failures
/// are remembered for [`AUTOBIND_COOLDOWN_SECONDS`] so reopening the panel while
/// 2DFan is unreachable does not spend another two request timeouts each time.
#[tauri::command]
pub async fn twodfan_autobind(app: AppHandle, game_id: i64, force: Option<bool>) -> CmdResult<AutobindResult> {
    let pool = pool(&app).await?;
    autobind_one(&pool, game_id, force.unwrap_or(false)).await
}

/// Bind one game to a 2DFan subject, or explain why not.
///
/// Shared by the per-panel command and the startup sweep so both obey the same
/// rules: never bind a `Weak` match, never spend more than one transport timeout,
/// and remember a miss for [`AUTOBIND_COOLDOWN_SECONDS`].
async fn autobind_one(pool: &SqlitePool, game_id: i64, force: bool) -> CmdResult<AutobindResult> {
    let row: Option<(String, Option<String>, Option<String>)> =
        sqlx::query_as("SELECT title, original_title, twodfan_id FROM games WHERE id = ?")
            .bind(game_id)
            .fetch_optional(pool)
            .await?;
    let Some((title, original_title, twodfan_id)) = row else {
        return Err(CmdError(format!("游戏 {game_id} 不存在")));
    };
    if let Some(existing) = optional_string(twodfan_id) {
        return Ok(AutobindResult {
            subject_id: Some(existing),
            title: None,
            reason: None,
            transport_error: false,
        });
    }

    let key = autobind_key(game_id);
    if !force {
        // A site-wide wall outranks the per-game cooldown: while it is up, no
        // search would succeed, so asking 2DFan again only prolongs it. The
        // panel's "重新自动匹配" passes `force` to override this deliberately.
        if let Some(blocked_at) = super::settings::settings_get_impl(pool, SWEEP_BLOCKED_KEY).await? {
            if is_recent(&blocked_at, SWEEP_BLOCKED_SECONDS) {
                return Ok(AutobindResult::skipped("2DFan 最近拒绝了自动匹配，一小时后再试，或点击重新自动匹配。"));
            }
        }
        if let Some(recorded) = super::settings::settings_get_impl(pool, &key).await? {
            if is_recent(&recorded, AUTOBIND_COOLDOWN_SECONDS) {
                return Ok(AutobindResult::skipped("最近一次自动匹配没有结果，稍后会自动重试。"));
            }
        }
    }

    let terms = search_terms(&title, original_title.as_deref());
    if terms.is_empty() {
        return Ok(AutobindResult::skipped("这个游戏还没有标题，无法自动匹配 2DFan 作品。"));
    }

    let mut failure: Option<String> = None;
    for term in &terms {
        let candidates = match twodfan::search(term, 10).await {
            Ok(candidates) => candidates,
            Err(error) => {
                failure = Some(error.0);
                // A transport failure (timeout, verification wall) is not
                // query-specific: the next term would burn the same 20 seconds
                // and fail the same way, so stop after the first one.
                break;
            }
        };
        // 2DFan's own spelling is the query, so an exact hit is meaningful; a
        // `Strong` prefix hit is accepted too, `Weak` never is.
        let matched = matching::best_match(term, &candidates)
            .filter(|(_, strength)| strength.is_confident())
            .map(|(candidate, _)| candidate.clone());
        let Some(candidate) = matched else { continue };

        super::games::write_twodfan_id(pool, game_id, &candidate.external_id).await?;
        sqlx::query("DELETE FROM settings WHERE key = ?").bind(&key).execute(pool).await?;
        return Ok(AutobindResult::bound(&candidate));
    }

    // Remember a genuine "no match" so the next open is cheap. A transport
    // failure is *not* recorded: the title may well match once 2DFan answers
    // again, and a 6-hour cooldown would hide that behind a network blip.
    if failure.is_none() {
        sqlx::query(
            "INSERT INTO settings (key, value) VALUES (?, ?) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .bind(&key)
        .bind(now_iso8601())
        .execute(pool)
        .await?;
    }

    Ok(match failure {
        Some(error) => AutobindResult::unreachable(error),
        None => AutobindResult::skipped("没有找到匹配的 2DFan 作品，请手动搜索绑定。"),
    })
}

/// How long the sweep waits between two games.
///
/// 2DFan answers a burst of searches with HTTP 429, and the whole sweep is a
/// burst by definition (one search per unbound game). A pause keeps it under the
/// limit; the sweep runs in the background, so the wall-clock cost is invisible.
const SWEEP_PAUSE: std::time::Duration = std::time::Duration::from_millis(1200);

/// Settings key remembering that the last sweep hit a verification wall.
///
/// Per-game cooldowns only cover "this title has no match". A wall (429, a
/// Cloudflare challenge, a login prompt) is site-wide and would otherwise be
/// re-probed on every launch, which keeps the wall alive instead of letting it
/// expire.
const SWEEP_BLOCKED_KEY: &str = "twodfan_sweep_blocked";

/// How long a site-wide wall suppresses the next sweep.
const SWEEP_BLOCKED_SECONDS: i64 = 60 * 60;

/// Result of one startup sweep over the whole library.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutobindSweep {
    /// Games that were unbound when the sweep started.
    pub pending: usize,
    /// Games this sweep bound to a 2DFan subject.
    pub bound: usize,
    /// Games that were searched but had no confident match.
    pub missed: usize,
    /// Games skipped because a cooldown from an earlier attempt is still active.
    pub cooling: usize,
    /// Set when the sweep stopped early because 2DFan was unreachable.
    pub stopped: Option<String>,
}

/// Bind every unbound game in the background, one at a time.
///
/// Runs after the window is up so opening the app never waits on 2DFan. Games
/// with an active cooldown are skipped without a request, and the whole sweep
/// stops at the first transport failure: if the site is unreachable, every
/// remaining game would pay the same 20-second timeout for the same answer.
///
/// `twodfan_autobind_sweep` is idempotent — a second call while one is running
/// returns immediately.
#[tauri::command]
pub async fn twodfan_autobind_sweep(app: AppHandle) -> CmdResult<AutobindSweep> {
    let sweep = app.state::<AutobindSweepJob>();
    if sweep.running.swap(true, std::sync::atomic::Ordering::AcqRel) {
        return Ok(AutobindSweep::default());
    }

    let outcome = run_autobind_sweep(&app).await;
    sweep.running.store(false, std::sync::atomic::Ordering::Release);
    outcome
}

/// State guarding against two concurrent startup sweeps.
#[derive(Default)]
pub struct AutobindSweepJob {
    running: std::sync::atomic::AtomicBool,
}

async fn run_autobind_sweep(app: &AppHandle) -> CmdResult<AutobindSweep> {
    let pool = pool(app).await?;

    // A recent wall means 2DFan is still refusing automated traffic; probing it
    // again on every launch is what keeps the wall up.
    if let Some(blocked_at) = super::settings::settings_get_impl(&pool, SWEEP_BLOCKED_KEY).await? {
        if is_recent(&blocked_at, SWEEP_BLOCKED_SECONDS) {
            return Ok(AutobindSweep {
                stopped: Some("2DFan 最近拒绝了自动匹配，一小时后再试。".to_string()),
                ..Default::default()
            });
        }
    }

    let ids: Vec<i64> = sqlx::query_scalar(
        "SELECT id FROM games WHERE twodfan_id IS NULL OR TRIM(twodfan_id) = '' ORDER BY id",
    )
    .fetch_all(&pool)
    .await?;

    let mut report = AutobindSweep { pending: ids.len(), ..Default::default() };
    let mut first = true;
    for game_id in ids {
        if !first {
            // Space the searches out: one per game back-to-back is exactly the
            // burst 2DFan answers with 429.
            tokio::time::sleep(SWEEP_PAUSE).await;
        }
        first = false;
        let result = match autobind_one(&pool, game_id, false).await {
            Ok(result) => result,
            // A single game that vanished (or a SQLite hiccup) must not abort
            // the sweep for every other game.
            Err(_) => continue,
        };
        if result.subject_id.is_some() {
            report.bound += 1;
        } else if result.transport_error {
            // A wall is site-wide, so remember it for the next launch too.
            sqlx::query(
                "INSERT INTO settings (key, value) VALUES (?, ?) \
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            )
            .bind(SWEEP_BLOCKED_KEY)
            .bind(now_iso8601())
            .execute(&pool)
            .await?;
            report.stopped = result.reason;
            break;
        } else if result.reason.as_deref().is_some_and(|reason| reason.starts_with("最近一次")) {
            report.cooling += 1;
        } else {
            report.missed += 1;
        }
    }
    Ok(report)
}

/// The topic list of the game's bound 2DFan subject.
///
/// `refresh` forces a re-scrape; otherwise a cached copy younger than
/// [`CACHE_TTL_SECONDS`] is returned as-is. An unbound game yields an empty
/// list rather than an error, because "not linked yet" is a normal state the UI
/// renders as a search box.
#[tauri::command]
pub async fn twodfan_topics_list(app: AppHandle, game_id: i64, refresh: Option<bool>) -> CmdResult<Vec<TwodfanTopic>> {
    let pool = pool(&app).await?;
    let Some(subject_id) = bound_subject(&pool, game_id).await? else { return Ok(Vec::new()) };
    let refresh = refresh.unwrap_or(false);

    if !refresh {
        let cached: Option<(String, String)> = sqlx::query_as(
            "SELECT fetched_at, topics_json FROM twodfan_topic_list WHERE subject_id = ?",
        )
        .bind(&subject_id)
        .fetch_optional(&pool)
        .await?;
        if let Some((fetched_at, topics_json)) = cached {
            if is_fresh(&fetched_at) {
                if let Ok(topics) = serde_json::from_str::<Vec<TwodfanTopic>>(&topics_json) {
                    return Ok(topics);
                }
            }
        }
    }

    let topics = twodfan_topics::topics(&subject_id).await?;
    let json = serde_json::to_string(&topics).map_err(|e| CmdError(format!("2DFan 攻略列表缓存失败：{e}")))?;
    sqlx::query(
        "INSERT INTO twodfan_topic_list (subject_id, fetched_at, topics_json) VALUES (?, ?, ?) \
         ON CONFLICT(subject_id) DO UPDATE SET fetched_at = excluded.fetched_at, topics_json = excluded.topics_json",
    )
    .bind(&subject_id)
    .bind(now_iso8601())
    .bind(json)
    .execute(&pool)
    .await?;
    Ok(topics)
}

/// One topic's parsed body, following pagination on the first read.
///
/// The whole body is cached, so expanding the same topic twice costs one
/// request set rather than two.
#[tauri::command]
pub async fn twodfan_topic_read(app: AppHandle, topic_id: i64, refresh: Option<bool>) -> CmdResult<TwodfanTopicContent> {
    let pool = pool(&app).await?;
    let refresh = refresh.unwrap_or(false);

    if !refresh {
        let cached: Option<(String, i64, Option<String>, Option<String>, i64, String)> = sqlx::query_as(
            "SELECT title, topic_id, author, published_at, page_count, blocks_json FROM twodfan_topic WHERE topic_id = ?",
        )
        .bind(topic_id)
        .fetch_optional(&pool)
        .await?;
        if let Some((title, topic_id, author, published_at, page_count, blocks_json)) = cached {
            if let Ok(blocks) = serde_json::from_str(&blocks_json) {
                return Ok(TwodfanTopicContent {
                    topic_id,
                    title,
                    author,
                    published_at,
                    url: format!("https://2dfan.com/topics/{topic_id}"),
                    page_count: u32::try_from(page_count).unwrap_or(1),
                    blocks,
                });
            }
        }
    }

    let content = twodfan_topics::topic(topic_id).await?;
    let blocks_json = serde_json::to_string(&content.blocks)
        .map_err(|e| CmdError(format!("2DFan 攻略正文缓存失败：{e}")))?;
    // The subject is unknown here (a topic can be opened without a bound game),
    // so it stays NULL and only the game-level cache uses it.
    sqlx::query(
        "INSERT INTO twodfan_topic (topic_id, subject_id, title, author, published_at, page_count, blocks_json, fetched_at) \
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(topic_id) DO UPDATE SET title = excluded.title, author = excluded.author, \
         published_at = excluded.published_at, page_count = excluded.page_count, \
         blocks_json = excluded.blocks_json, fetched_at = excluded.fetched_at",
    )
    .bind(topic_id)
    .bind(&content.title)
    .bind(&content.author)
    .bind(&content.published_at)
    .bind(i64::from(content.page_count))
    .bind(blocks_json)
    .bind(now_iso8601())
    .execute(&pool)
    .await?;
    Ok(content)
}

/// One related work, flattened for the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataRelation {
    pub provider: String,
    pub external_id: String,
    pub relation: String,
    pub relation_label: String,
    pub title: String,
    pub original_title: Option<String>,
    pub release_date: Option<String>,
    pub rating: Option<f64>,
    pub cover_url: Option<String>,
    pub url: String,
    /// Local game id when this work is already in the library, so the card can
    /// jump straight to it instead of opening the browser.
    pub library_game_id: Option<i64>,
}

/// Find the local game that corresponds to one relation.
///
/// The VNDB id is authoritative; only when it is absent do we fall back to the
/// exact-title comparison that metadata matching already uses. Titles alone are
/// deliberately *not* fuzzy-matched here — a wrong jump would be worse than no
/// jump at all.
async fn library_game_for(
    pool: &SqlitePool,
    relation_id: &str,
    title: &str,
    original_title: Option<&str>,
) -> CmdResult<Option<i64>> {
    let by_id: Option<(i64,)> = sqlx::query_as("SELECT id FROM games WHERE vndb_id = ? LIMIT 1")
        .bind(relation_id)
        .fetch_optional(pool)
        .await?;
    if let Some((id,)) = by_id {
        return Ok(Some(id));
    }

    let rows: Vec<(i64, String, Option<String>)> = sqlx::query_as("SELECT id, title, original_title FROM games")
        .fetch_all(pool)
        .await?;
    let wanted = [Some(title), original_title]
        .into_iter()
        .flatten()
        .map(matching::normalise)
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    if wanted.is_empty() {
        return Ok(None);
    }
    Ok(rows
        .into_iter()
        .find(|(_, game_title, game_original)| {
            [Some(game_title.as_str()), game_original.as_deref()]
                .into_iter()
                .flatten()
                .map(matching::normalise)
                .any(|value| wanted.iter().any(|needle| *needle == value))
        })
        .map(|(id, _, _)| id))
}

/// Related works (sequels, prequels, fandiscs, ...) for one external id.
///
/// Only VNDB models relations; 2DFan has no series concept and Bangumi's
/// relations are not exposed, so any other provider is rejected explicitly
/// instead of silently returning an empty list.
///
/// The provider answer is cached in `vndb_relation` because relations change
/// rarely while every game in a series asks for the same list. The library
/// lookup (`libraryGameId`) is *not* cached: it must reflect the current
/// library, so it is recomputed on every call.
#[tauri::command]
pub async fn metadata_relations(
    app: AppHandle,
    provider: String,
    external_id: String,
    refresh: Option<bool>,
) -> CmdResult<Vec<MetadataRelation>> {
    let provider = provider.trim().to_ascii_lowercase();
    if provider != "vndb" {
        return Err(CmdError("关联作品目前只支持 VNDB 数据源".into()));
    }
    let external_id = external_id.trim().to_string();
    if external_id.is_empty() {
        return Err(CmdError("VNDB 条目 ID 不能为空".into()));
    }
    let pool = pool(&app).await?;
    let relations = cached_relations(&pool, &external_id, refresh.unwrap_or(false)).await?;
    let mut out = Vec::with_capacity(relations.len());
    for relation in relations {
        let library_game_id = library_game_for(
            &pool,
            &relation.id,
            &relation.title,
            relation.original_title.as_deref(),
        )
        .await?;
        out.push(MetadataRelation {
            provider: "vndb".to_string(),
            external_id: relation.id,
            relation: relation.relation,
            relation_label: relation.relation_label,
            title: relation.title,
            original_title: relation.original_title,
            release_date: relation.release_date,
            rating: relation.rating,
            cover_url: relation.cover_url,
            url: relation.url,
            library_game_id,
        });
    }
    Ok(out)
}

/// VNDB relations for one id, served from `vndb_relation` while fresh.
///
/// A cache entry that cannot be parsed is treated as a miss, so a bad row can
/// never wedge the panel permanently.
async fn cached_relations(
    pool: &SqlitePool,
    vndb_id: &str,
    refresh: bool,
) -> CmdResult<Vec<crate::metadata::vndb::VndbRelation>> {
    if !refresh {
        let cached: Option<(String, String)> =
            sqlx::query_as("SELECT fetched_at, relations_json FROM vndb_relation WHERE vndb_id = ?")
                .bind(vndb_id)
                .fetch_optional(pool)
                .await?;
        if let Some((fetched_at, relations_json)) = cached {
            if is_recent(&fetched_at, RELATION_CACHE_TTL_SECONDS) {
                if let Ok(relations) =
                    serde_json::from_str::<Vec<crate::metadata::vndb::VndbRelation>>(&relations_json)
                {
                    return Ok(relations);
                }
            }
        }
    }

    let relations = crate::metadata::vndb::relations(vndb_id).await?;
    let json = serde_json::to_string(&relations)
        .map_err(|e| CmdError(format!("VNDB 关联作品缓存失败：{e}")))?;
    sqlx::query(
        "INSERT INTO vndb_relation (vndb_id, fetched_at, relations_json) VALUES (?, ?, ?) \
         ON CONFLICT(vndb_id) DO UPDATE SET fetched_at = excluded.fetched_at, \
         relations_json = excluded.relations_json",
    )
    .bind(vndb_id)
    .bind(now_iso8601())
    .bind(json)
    .execute(pool)
    .await?;
    Ok(relations)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cache_entry_is_fresh_only_inside_the_ttl_window() {
        let now = time::OffsetDateTime::now_utc();
        let format = |offset: i64| {
            (now - time::Duration::seconds(offset))
                .replace_nanosecond(0)
                .unwrap()
                .format(&time::format_description::well_known::Rfc3339)
                .unwrap()
        };
        assert!(is_fresh(&format(0)));
        assert!(is_fresh(&format(CACHE_TTL_SECONDS - 60)));
        assert!(!is_fresh(&format(CACHE_TTL_SECONDS + 60)));
        // A clock skew into the future must not keep a stale row alive forever.
        assert!(!is_fresh(&format(-3600)));
        assert!(!is_fresh("not a timestamp"));
    }

    #[test]
    fn the_autobind_cooldown_is_shorter_than_the_list_cache() {
        // A miss is retried sooner than a cached list expires, otherwise one
        // unlucky network moment would hide the guides for a whole day.
        assert!(AUTOBIND_COOLDOWN_SECONDS < CACHE_TTL_SECONDS);
        let now = time::OffsetDateTime::now_utc();
        let at = |offset: i64| {
            (now - time::Duration::seconds(offset))
                .replace_nanosecond(0)
                .unwrap()
                .format(&time::format_description::well_known::Rfc3339)
                .unwrap()
        };
        assert!(is_recent(&at(AUTOBIND_COOLDOWN_SECONDS - 60), AUTOBIND_COOLDOWN_SECONDS));
        assert!(!is_recent(&at(AUTOBIND_COOLDOWN_SECONDS + 60), AUTOBIND_COOLDOWN_SECONDS));
    }

    #[test]
    fn search_terms_prefer_the_localized_title_and_skip_blanks_and_duplicates() {
        assert_eq!(
            search_terms("Ｅスクールライフ", Some("E School Life")),
            vec!["Ｅスクールライフ".to_string(), "E School Life".to_string()]
        );
        // The same title twice is one query, not two.
        assert_eq!(search_terms("CLANNAD", Some(" CLANNAD ")), vec!["CLANNAD".to_string()]);
        assert_eq!(search_terms("   ", None), Vec::<String>::new());
        assert_eq!(search_terms("", Some("")), Vec::<String>::new());
    }

    /// The relation cache must round-trip through the same JSON the frontend sees.
    ///
    /// A `Serialize`-only struct could not be read back from `vndb_relation`, so
    /// this pins the `Deserialize` side and the camelCase field names together.
    #[test]
    fn cached_relations_round_trip_through_their_stored_json() {
        let relation = crate::metadata::vndb::VndbRelation {
            id: "v20431".to_string(),
            relation: "seq".to_string(),
            relation_label: "续作".to_string(),
            title: "樱之刻－漫步于樱花之森下－".to_string(),
            original_title: Some("サクラノ刻".to_string()),
            release_date: Some("2023-02-24".to_string()),
            rating: Some(8.7),
            cover_url: None,
            nsfw: Some(false),
            url: "https://vndb.org/v20431".to_string(),
        };
        let json = serde_json::to_string(&vec![relation]).unwrap();
        // camelCase is part of the stored contract, not just the IPC payload.
        assert!(json.contains("\"relationLabel\""), "stored JSON must stay camelCase: {json}");
        let back: Vec<crate::metadata::vndb::VndbRelation> = serde_json::from_str(&json).unwrap();
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].title, "樱之刻－漫步于樱花之森下－");
        assert_eq!(back[0].relation_label, "续作");
        assert_eq!(back[0].original_title.as_deref(), Some("サクラノ刻"));
    }
}
