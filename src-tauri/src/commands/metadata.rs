//! `metadata_*` commands — external metadata lookup and application.
//!
//! These orchestrate the provider modules in [`crate::metadata`]: search across
//! sources, resolve a chosen candidate into a merged detail, then optionally
//! write the selected fields onto a game row.
//!
//! Nothing here runs automatically. The frontend drives every step and shows the
//! results for confirmation, because upstream data is frequently wrong or
//! matches the wrong work — silently overwriting a user's curated fields would
//! be worse than storing nothing.

use tauri::AppHandle;

use crate::metadata::{
    self, bangumi, merge, nextmoe, vndb, MetadataCandidate, MetadataDetail, Provider,
};

use super::error::{CmdError, CmdResult};
use super::games::pool;
use super::settings::settings_get_impl;
use super::util::{now_iso8601, required_string};

/// Settings key holding the optional NextMoe API key.
const NEXTMOE_KEY: &str = "nextmoe_api_key";

/// Which providers a search should query.
///
/// Public because [`search_all`] takes it as a parameter, which is what lets the
/// fan-out be tested against the live APIs without a Tauri `AppHandle`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sources {
    Nextmoe,
    Vndb,
    Bangumi,
}

impl Sources {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "nextmoe" => Some(Self::Nextmoe),
            "vndb" => Some(Self::Vndb),
            "bangumi" => Some(Self::Bangumi),
            _ => None,
        }
    }
}

/// Read the optional NextMoe API key.
///
/// Absent key is normal: anonymous reads are allowed, just rate-limited lower.
async fn nextmoe_key(app: &AppHandle) -> Option<String> {
    let pool = pool(app).await.ok()?;
    settings_get_impl(&pool, NEXTMOE_KEY).await.ok().flatten()
}

/// Fan a search out across `wanted` providers and collect whatever comes back.
///
/// Split out from the command so it can be exercised against the live APIs
/// without a Tauri `AppHandle`. The command itself is a thin shell around this;
/// the interesting behaviour (concurrency, per-provider error isolation) lives
/// here.
///
/// A provider that fails — network trouble, VNDB's 200-request/5-minute limit,
/// an occasional Bangumi 5xx — contributes an entry to the returned error list
/// rather than failing the whole search. Losing every result because one source
/// is throttled would be a poor trade, and the UI surfaces the errors so the
/// user can tell "no match" apart from "that source is down".
pub async fn search_all(
    query: &str,
    wanted: &[Sources],
    limit: u32,
    nextmoe_key: Option<&str>,
) -> (Vec<MetadataCandidate>, Vec<ProviderError>) {
    // Each future is independent, so one slow provider cannot delay the others.
    let nextmoe_fut = async {
        if wanted.contains(&Sources::Nextmoe) {
            Some(nextmoe::search(query, limit, nextmoe_key).await)
        } else {
            None
        }
    };
    let vndb_fut = async {
        if wanted.contains(&Sources::Vndb) {
            Some(vndb::search(query, limit).await)
        } else {
            None
        }
    };
    let bangumi_fut = async {
        if wanted.contains(&Sources::Bangumi) {
            Some(bangumi::search(query, limit).await)
        } else {
            None
        }
    };

    let (n, v, b) = tokio::join!(nextmoe_fut, vndb_fut, bangumi_fut);

    let mut candidates: Vec<MetadataCandidate> = Vec::new();
    let mut errors: Vec<ProviderError> = Vec::new();

    for (provider, outcome) in [
        (Provider::Nextmoe, n),
        (Provider::Vndb, v),
        (Provider::Bangumi, b),
    ] {
        match outcome {
            None => {}
            Some(Ok(mut found)) => candidates.append(&mut found),
            Some(Err(error)) => errors.push(ProviderError {
                provider,
                message: error.0,
            }),
        }
    }

    (candidates, errors)
}

/// `metadata_search` — query one or more providers and return the merged list.
#[tauri::command]
pub async fn metadata_search(
    app: AppHandle,
    query: String,
    sources: Vec<String>,
    limit: Option<u32>,
) -> CmdResult<MetadataSearchResult> {
    let query = required_string(&query, "query")?;
    let limit = limit.unwrap_or(10).clamp(1, 30);

    let wanted: Vec<Sources> = if sources.is_empty() {
        vec![Sources::Nextmoe, Sources::Vndb, Sources::Bangumi]
    } else {
        sources.iter().filter_map(|s| Sources::parse(s)).collect()
    };
    if wanted.is_empty() {
        return Err(CmdError(
            "sources 里没有可识别的数据源（可用：nextmoe / vndb / bangumi）".to_string(),
        ));
    }

    let key = nextmoe_key(&app).await;
    let (candidates, errors) = search_all(&query, &wanted, limit, key.as_deref()).await;

    Ok(MetadataSearchResult { candidates, errors })
}

/// `metadata_detail` — resolve one provider record into merged metadata.
///
/// When the chosen provider is not NextMoe, the external id is also used to try
/// and pull the *other* sources through NextMoe's `refs=` batch lane. That costs
/// one extra request and frequently fills in a Chinese title or extra ratings
/// that the primary source lacks.
#[tauri::command]
pub async fn metadata_detail(
    app: AppHandle,
    provider: String,
    external_id: String,
) -> CmdResult<MetadataDetail> {
    let provider = Sources::parse(&provider)
        .ok_or_else(|| CmdError(format!("未知的数据源：{provider}")))?;
    let external_id = required_string(&external_id, "externalId")?;

    let key = nextmoe_key(&app).await;
    let key_ref = key.as_deref();

    let primary = match provider {
        Sources::Nextmoe => nextmoe::detail(&external_id, key_ref).await?,
        Sources::Vndb => vndb::detail(&external_id).await?,
        Sources::Bangumi => bangumi::detail(&external_id).await?,
    };

    // Try to enrich from NextMoe when the user picked a raw provider. Failure is
    // expected (NextMoe may not know the work) and must not break the flow.
    let mut detail = primary;
    if provider != Sources::Nextmoe {
        let source_name = match provider {
            Sources::Vndb => "vndb",
            Sources::Bangumi => "bangumi",
            Sources::Nextmoe => unreachable!(),
        };
        let reference = format!("{source_name}:{external_id}");
        // `Ok(None)` means NextMoe does not know this work; only enrich when it
        // actually resolved something.
        if let Ok(Some(extra)) = nextmoe::detail_by_ref(&reference, key_ref).await {
            merge::merge_into(&mut detail, extra);
        }
    }

    Ok(detail)
}

/// `metadata_apply` — copy selected metadata onto an existing game.
///
/// Only fields the caller explicitly lists are written, so the user can accept a
/// title while rejecting an upstream description. Tags are looked up by name and
/// created when missing, then merged into the game's existing set rather than
/// replacing it.
/// Text columns to write for the accepted `fields`.
///
/// A field the caller accepted but the provider has no value for is **skipped**,
/// never written as NULL. Applying metadata can therefore only ever *add*
/// information; clearing a column stays the job of the edit form. Binding NULL
/// here would silently destroy a value the user had curated themselves — which
/// is what the first version of this command did.
///
/// Extracted from the command so the rule is testable without a database.
fn text_columns(
    detail: &MetadataDetail,
    fields: &[String],
) -> CmdResult<Vec<(&'static str, String)>> {
    let wants = |name: &str| fields.iter().any(|f| f == name);
    let mut columns: Vec<(&'static str, String)> = Vec::new();

    if wants("title") {
        let title = detail
            .title_zh
            .clone()
            .filter(|t| !t.trim().is_empty())
            .unwrap_or_else(|| detail.title.clone());
        if title.trim().is_empty() {
            return Err(CmdError("拒绝应用空标题".to_string()));
        }
        columns.push(("title", title));
    }

    // Appended only when the provider actually supplies a non-blank value.
    let mut push = |column: &'static str, value: Option<String>| {
        if let Some(value) = value.filter(|v| !v.trim().is_empty()) {
            columns.push((column, value));
        }
    };

    if wants("original_title") {
        push("original_title", detail.title_original.clone());
    }
    if wants("developer") {
        push("developer", detail.developer.clone());
    }
    if wants("release_date") {
        push("release_date", detail.release_date.clone());
    }
    if wants("description") {
        push("description", detail.description.clone());
    }
    if wants("vndb_id") {
        push("vndb_id", detail.vndb_id.clone());
    }
    if wants("bangumi_id") {
        push("bangumi_id", detail.bangumi_id.clone());
    }

    Ok(columns)
}

/// Fields the auto-fetch path writes when it is confident about a match.
///
/// The cover is handled separately (it is downloaded, not copied from the
/// detail), and `vndb_id`/`bangumi_id` are included so the link survives for
/// later refreshes.
pub const AUTOFETCH_FIELDS: &[&str] = &[
    "title",
    "original_title",
    "developer",
    "release_date",
    "rating",
    "description",
    "tags",
    "vndb_id",
    "bangumi_id",
];

/// Write `detail` onto `game_id`, touching only `fields`.
///
/// Shared by the `metadata_apply` command and the auto-fetch batch so both paths
/// write identically — in particular so both inherit the "never write NULL for
/// an absent upstream field" rule from [`text_columns`].
pub(crate) async fn apply_detail(
    pool: &sqlx::Pool<sqlx::Sqlite>,
    game_id: i64,
    detail: &MetadataDetail,
    fields: &[String],
    tag_mode: Option<&str>,
) -> CmdResult<AppliedMetadata> {
    let wants = |name: &str| fields.iter().any(|f| f == name);
    let now = now_iso8601();

    // Build the update from only the accepted fields, dropping any the provider
    // has no value for. See `text_columns` for why that matters.
    let columns = text_columns(detail, fields)?;

    // A typed binding list keeps the `?` placeholders and the `.bind()` calls in
    // a single ordered walk. Building the SQL by string surgery instead (e.g.
    // splicing a clause in with `replace`) is easy to get subtly wrong.
    enum Binding {
        Text(String),
        Real(f64),
    }

    let mut sets: Vec<String> = Vec::new();
    let mut bindings: Vec<Binding> = Vec::new();

    for (column, value) in columns {
        sets.push(format!("{column} = ?"));
        bindings.push(Binding::Text(value));
    }

    if wants("rating") {
        // `rating` is guarded separately: it is numeric, and an upstream with
        // no score must not overwrite a rating the user set.
        if let Some(rating) = super::util::validate_rating(detail.rating)? {
            sets.push("rating = ?".to_string());
            bindings.push(Binding::Real(rating));
        }
    }

    if sets.is_empty() {
        // Nothing to write to the row itself; only tags will change below.
    } else {
        sets.push("updated_at = ?".to_string());
        bindings.push(Binding::Text(now.clone()));

        let query = format!("UPDATE games SET {} WHERE id = ?", sets.join(", "));
        let mut statement = sqlx::query(&query);
        for binding in &bindings {
            statement = match binding {
                Binding::Text(value) => statement.bind(value),
                Binding::Real(value) => statement.bind(value),
            };
        }
        let result = statement.bind(game_id).execute(pool).await?;
        if result.rows_affected() == 0 {
            return Err(CmdError(format!("游戏 {game_id} 不存在")));
        }
    }

    // Tags: `merge` (default) keeps existing tags and adds new ones; `replace`
    // swaps the whole set for the metadata's.
    let mut tags_added = 0usize;
    if wants("tags") && !detail.tags.is_empty() {
        let replace = tag_mode == Some("replace");
        if replace {
            sqlx::query("DELETE FROM game_tags WHERE game_id = ?")
                .bind(game_id)
                .execute(pool)
                .await?;
        }
        for name in &detail.tags {
            let trimmed = name.trim();
            if trimmed.is_empty() {
                continue;
            }
            // `INSERT OR IGNORE` then read back: works whether or not it existed.
            sqlx::query("INSERT OR IGNORE INTO tags (name) VALUES (?)")
                .bind(trimmed)
                .execute(pool)
                .await?;
            let tag_id: Option<i64> = sqlx::query_scalar("SELECT id FROM tags WHERE name = ?")
                .bind(trimmed)
                .fetch_optional(pool)
                .await?;
            if let Some(tag_id) = tag_id {
                let inserted = sqlx::query(
                    "INSERT OR IGNORE INTO game_tags (game_id, tag_id) VALUES (?, ?)",
                )
                .bind(game_id)
                .bind(tag_id)
                .execute(pool)
                .await?;
                tags_added += inserted.rows_affected() as usize;
            }
        }
    }

    Ok(AppliedMetadata {
        game_id,
        // Count the columns actually written, not the fields requested: a
        // requested-but-empty field is skipped, and telling the user otherwise
        // would be a lie.
        fields_applied: sets
            .iter()
            .filter(|s| !s.starts_with("updated_at"))
            .count(),
        tags_added,
    })
}

#[tauri::command]
pub async fn metadata_apply(
    app: AppHandle,
    game_id: i64,
    detail: MetadataDetail,
    fields: Vec<String>,
    tag_mode: Option<String>,
) -> CmdResult<AppliedMetadata> {
    let pool = pool(&app).await?;
    apply_detail(&pool, game_id, &detail, &fields, tag_mode.as_deref()).await
}

/// `metadata_cover_cache` — download a remote cover next to the game and return
/// the local path.
///
/// Caching locally keeps the library rendering when offline (or when the
/// upstream CDN blocks us), which the user asked for. The file is written
/// beside the game folder so that moving the install folder keeps the cover.
#[tauri::command]
pub async fn metadata_cover_cache(
    game_id: i64,
    cover_url: String,
    install_path: String,
) -> CmdResult<String> {
    let url = required_string(&cover_url, "coverUrl")?;
    let install = required_string(&install_path, "installPath")?;
    cache_cover(game_id, &url, &install).await
}

/// Search result: merged candidates plus per-provider failures.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataSearchResult {
    pub candidates: Vec<MetadataCandidate>,
    pub errors: Vec<ProviderError>,
}

/// One provider that failed during a search.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderError {
    pub provider: Provider,
    pub message: String,
}

/// Outcome of applying metadata.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppliedMetadata {
    pub game_id: i64,
    pub fields_applied: usize,
    pub tags_added: usize,
}

/// What auto-fetch did for one game.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AutofetchStatus {
    /// A confident match was found and its fields were written.
    Applied,
    /// A match was found but not confidently, so nothing was written. The
    /// candidate is reported so the UI can offer it for confirmation.
    NeedsReview,
    /// Nothing matched this title.
    NoMatch,
    /// The lookup itself failed (network, rate limit, upstream error).
    Failed,
}

/// Result for one game in an auto-fetch batch.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutofetchOutcome {
    pub game_id: i64,
    /// The game's title at the time of the lookup, for display.
    pub title: String,
    pub status: AutofetchStatus,
    pub provider: Option<Provider>,
    pub external_id: Option<String>,
    /// The matched work's title, useful even when nothing was written.
    pub matched_title: Option<String>,
    /// `exact` or `strong` when a match was accepted; `weak` for review.
    pub confidence: Option<String>,
    /// How many columns were written (0 unless `Applied`).
    pub fields_applied: usize,
    pub tags_added: usize,
    /// Local path of the cached cover, when one was downloaded.
    pub cover_path: Option<String>,
    /// Failure reason, present only for `Failed`.
    pub message: Option<String>,
}

/// Summary of an auto-fetch batch.
#[derive(Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutofetchSummary {
    pub outcomes: Vec<AutofetchOutcome>,
    pub applied: usize,
    pub needs_review: usize,
    pub no_match: usize,
    pub failed: usize,
}

impl AutofetchSummary {
    fn push(&mut self, outcome: AutofetchOutcome) {
        match outcome.status {
            AutofetchStatus::Applied => self.applied += 1,
            AutofetchStatus::NeedsReview => self.needs_review += 1,
            AutofetchStatus::NoMatch => self.no_match += 1,
            AutofetchStatus::Failed => self.failed += 1,
        }
        self.outcomes.push(outcome);
    }
}

/// Payload of the `metadata-autofetch-progress` event.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutofetchProgress {
    pub game_id: i64,
    pub title: String,
    /// 1-based position in the batch.
    pub index: usize,
    pub total: usize,
    pub status: AutofetchStatus,
}

/// Confidence as a wire string.
fn confidence_label(strength: crate::metadata::matching::Match) -> Option<String> {
    use crate::metadata::matching::Match;
    match strength {
        Match::Exact => Some("exact".to_string()),
        Match::Strong => Some("strong".to_string()),
        Match::Weak => Some("weak".to_string()),
        Match::None => None,
    }
}

/// Delay between games, to stay inside the upstream rate limits.
///
/// Anonymous NextMoe allows 30 requests/minute and VNDB 200 per 5 minutes, and
/// each game costs one search per enabled source. A pause keeps a bulk import of
/// a few dozen games from tripping the limits; a throttled source still reports
/// per-game rather than aborting the batch.
const DEFAULT_AUTOFETCH_DELAY_MS: u64 = 700;

/// `metadata_autofetch` — look up and apply metadata for a batch of games.
///
/// This is what runs immediately after an import, so the user does not have to
/// search each game by hand.
///
/// ## Why "found something" is not enough to write it
///
/// A wrong match is worse than no match: it silently replaces the correct title
/// with an unrelated work's. So a candidate is only written when
/// [`crate::metadata::matching::Match::is_confident`] — an exact or prefix match
/// on the normalised title. A weaker match is reported as
/// [`AutofetchStatus::NeedsReview`] with its candidate, and the user decides.
///
/// ## Progress
///
/// One `metadata-autofetch-progress` event is emitted per game so the UI can
/// show movement during a batch that may take a minute. Games are processed
/// sequentially, spaced by `delay_ms`, to respect upstream rate limits.
#[tauri::command]
pub async fn metadata_autofetch(
    app: AppHandle,
    game_ids: Vec<i64>,
    sources: Vec<String>,
    apply: Option<bool>,
    delay_ms: Option<u64>,
) -> CmdResult<AutofetchSummary> {
    if game_ids.is_empty() {
        return Ok(AutofetchSummary::default());
    }
    let apply = apply.unwrap_or(true);
    let delay = delay_ms.unwrap_or(DEFAULT_AUTOFETCH_DELAY_MS).min(10_000);

    let wanted: Vec<Sources> = if sources.is_empty() {
        vec![Sources::Nextmoe, Sources::Vndb, Sources::Bangumi]
    } else {
        sources.iter().filter_map(|s| Sources::parse(s)).collect()
    };
    if wanted.is_empty() {
        return Err(CmdError(
            "sources 里没有可识别的数据源（可用：nextmoe / vndb / bangumi）".to_string(),
        ));
    }

    let pool = pool(&app).await?;
    let key = settings_get_impl(&pool, NEXTMOE_KEY).await.ok().flatten();
    let key_ref = key.as_deref();

    let fields: Vec<String> = AUTOFETCH_FIELDS.iter().map(|f| f.to_string()).collect();
    let total = game_ids.len();
    let mut summary = AutofetchSummary::default();

    for (position, game_id) in game_ids.iter().enumerate() {
        // Re-read each time so a title edited mid-batch is respected.
        let row: Option<(String, String)> =
            sqlx::query_as("SELECT title, install_path FROM games WHERE id = ?")
                .bind(game_id)
                .fetch_optional(&pool)
                .await?;

        let Some((title, install_path)) = row else {
            summary.push(AutofetchOutcome {
                game_id: *game_id,
                title: String::new(),
                status: AutofetchStatus::Failed,
                provider: None,
                external_id: None,
                matched_title: None,
                confidence: None,
                fields_applied: 0,
                tags_added: 0,
                cover_path: None,
                message: Some(format!("游戏 {game_id} 不存在")),
            });
            continue;
        };

        let mut outcome = AutofetchOutcome {
            game_id: *game_id,
            title: title.clone(),
            status: AutofetchStatus::NoMatch,
            provider: None,
            external_id: None,
            matched_title: None,
            confidence: None,
            fields_applied: 0,
            tags_added: 0,
            cover_path: None,
            message: None,
        };

        let (candidates, errors) = search_all(&title, &wanted, 8, key_ref).await;
        // Every source failing is a lookup failure, not a "no match".
        if candidates.is_empty() && !errors.is_empty() {
            outcome.status = AutofetchStatus::Failed;
            outcome.message = Some(
                errors
                    .iter()
                    .map(|e| format!("{}: {}", e.provider.as_str(), e.message))
                    .collect::<Vec<_>>()
                    .join("；"),
            );
            emit_progress(&app, &outcome, position + 1, total);
            summary.push(outcome);
            sleep_between(delay).await;
            continue;
        }

        match metadata::matching::best_match(&title, &candidates) {
            None => {
                outcome.status = AutofetchStatus::NoMatch;
            }
            Some((candidate, strength)) => {
                outcome.provider = Some(candidate.provider);
                outcome.external_id = Some(candidate.external_id.clone());
                outcome.matched_title = Some(candidate.title.clone());
                outcome.confidence = confidence_label(strength);

                let provider = candidate.provider;
                let external_id = candidate.external_id.clone();

                if !strength.is_confident() {
                    // Deliberately write nothing: confirm with the user first.
                    outcome.status = AutofetchStatus::NeedsReview;
                } else if !apply {
                    // Caller asked for a dry run.
                    outcome.status = AutofetchStatus::NeedsReview;
                } else {
                    match fetch_detail(provider, &external_id, key_ref).await {
                        Err(error) => {
                            outcome.status = AutofetchStatus::Failed;
                            outcome.message = Some(error.0);
                        }
                        Ok(detail) => {
                            match apply_detail(&pool, *game_id, &detail, &fields, None).await {
                                Err(error) => {
                                    outcome.status = AutofetchStatus::Failed;
                                    outcome.message = Some(error.0);
                                }
                                Ok(applied) => {
                                    outcome.status = AutofetchStatus::Applied;
                                    outcome.fields_applied = applied.fields_applied;
                                    outcome.tags_added = applied.tags_added;
                                }
                            }
                            // Cover is best-effort: a missing image must not
                            // downgrade a successful metadata write.
                            if let Some(url) = detail.cover_url.as_deref() {
                                match cache_cover(*game_id, url, &install_path).await {
                                    Ok(path) => {
                                        if let Err(error) = sqlx::query(
                                            "UPDATE games SET cover_path = ? WHERE id = ?",
                                        )
                                        .bind(&path)
                                        .bind(game_id)
                                        .execute(&pool)
                                        .await
                                        {
                                            eprintln!("[autofetch] cover_path update failed: {error}");
                                        } else {
                                            outcome.cover_path = Some(path);
                                        }
                                    }
                                    Err(error) => {
                                        eprintln!("[autofetch] cover cache failed: {}", error.0);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        emit_progress(&app, &outcome, position + 1, total);
        summary.push(outcome);
        // Space the requests out; skip the wait after the final game.
        if position + 1 < total {
            sleep_between(delay).await;
        }
    }

    Ok(summary)
}

/// Emit one progress event, ignoring a failure to deliver it.
fn emit_progress(app: &AppHandle, outcome: &AutofetchOutcome, index: usize, total: usize) {
    use tauri::Emitter;
    let payload = AutofetchProgress {
        game_id: outcome.game_id,
        title: outcome.title.clone(),
        index,
        total,
        status: outcome.status,
    };
    if let Err(error) = app.emit("metadata-autofetch-progress", payload) {
        // The UI missing a progress tick must not abort the batch.
        eprintln!("[autofetch] could not emit progress: {error}");
    }
}

/// Sleep between upstream calls, unless the delay is zero.
async fn sleep_between(delay_ms: u64) {
    if delay_ms > 0 {
        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
    }
}

/// Fetch a detail record from the provider the candidate came from.
async fn fetch_detail(
    provider: Provider,
    external_id: &str,
    nextmoe_key: Option<&str>,
) -> CmdResult<MetadataDetail> {
    match provider {
        Provider::Nextmoe => nextmoe::detail(external_id, nextmoe_key).await,
        Provider::Vndb => vndb::detail(external_id).await,
        Provider::Bangumi => bangumi::detail(external_id).await,
    }
}

/// Download a cover next to the game and return the local path.
///
/// Split out from the command so auto-fetch can reuse it without an
/// `AppHandle`.
async fn cache_cover(game_id: i64, url: &str, install_path: &str) -> CmdResult<String> {
    use crate::metadata::http_client;

    let response = http_client()?
        .get(url)
        .header("Accept", "image/*")
        .send()
        .await
        .map_err(|error| CmdError(format!("封面下载失败：{error}")))?;

    let status = response.status();
    if !status.is_success() {
        return Err(CmdError(format!("封面下载返回 HTTP {status}")));
    }

    // Derive the extension from the URL path. The upstream CDNs serve
    // webp/jpg/png and the URL suffix is a reliable enough signal.
    let ext = url
        .split('?')
        .next()
        .and_then(|u| u.rsplit('.').next())
        .filter(|e| {
            matches!(
                e.to_ascii_lowercase().as_str(),
                "jpg" | "jpeg" | "png" | "webp" | "bmp"
            )
        })
        .unwrap_or("jpg");

    let directory = std::path::Path::new(install_path);
    if !directory.is_dir() {
        return Err(CmdError(format!("安装目录不存在：{install_path}")));
    }

    let target = directory.join(format!("cover_cache_{game_id}.{ext}"));
    let bytes = response
        .bytes()
        .await
        .map_err(|error| CmdError(format!("封面数据读取失败：{error}")))?;
    if bytes.is_empty() {
        return Err(CmdError("封面下载内容为空".to_string()));
    }
    std::fs::write(&target, &bytes)
        .map_err(|error| CmdError(format!("封面写入失败：{error}")))?;

    Ok(target.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn applying_metadata_rounds_rating_to_hundredths() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new().max_connections(1)
            .connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(include_str!("../../migrations/0001_init.sql"))
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO games (id, title, install_path, created_at, updated_at, rating) VALUES (1, 'Test', 'decimal', 'now', 'now', 8)")
            .execute(&pool).await.unwrap();
        let detail = MetadataDetail { rating: Some(8.725), ..Default::default() };
        apply_detail(&pool, 1, &detail, &fields(&["rating"]), None).await.unwrap();
        let rating: Option<f64> = sqlx::query_scalar("SELECT rating FROM games WHERE id = 1")
            .fetch_one(&pool).await.unwrap();
        assert_eq!(rating, Some(8.73));
        apply_detail(&pool, 1, &MetadataDetail::default(), &fields(&["rating"]), None).await.unwrap();
        let rating: Option<f64> = sqlx::query_scalar("SELECT rating FROM games WHERE id = 1")
            .fetch_one(&pool).await.unwrap();
        assert_eq!(rating, Some(8.73));
    }

    fn fields(names: &[&str]) -> Vec<String> {
        names.iter().map(|n| n.to_string()).collect()
    }

    /// The regression test for a data-loss bug found in review: the first version
    /// of `metadata_apply` bound NULL for every accepted field, so accepting a
    /// field the provider had no value for wiped the user's own data.
    #[test]
    fn absent_provider_values_are_skipped_not_bound_as_null() {
        let detail = MetadataDetail {
            title: "CLANNAD".to_string(),
            // These are all absent upstream...
            title_original: None,
            developer: None,
            release_date: None,
            description: None,
            vndb_id: None,
            bangumi_id: None,
            ..Default::default()
        };
        // ...but the caller accepted all of them.
        let accepted = fields(&[
            "title",
            "original_title",
            "developer",
            "release_date",
            "description",
            "vndb_id",
            "bangumi_id",
        ]);

        let columns = text_columns(&detail, &accepted).expect("title is present");

        assert_eq!(
            columns.len(),
            1,
            "only the present field should be written, got {columns:?}"
        );
        assert_eq!(columns[0].0, "title");
    }

    #[test]
    fn blank_strings_count_as_absent() {
        let detail = MetadataDetail {
            title: "T".to_string(),
            developer: Some("   ".to_string()),
            description: Some(String::new()),
            ..Default::default()
        };
        let columns =
            text_columns(&detail, &fields(&["developer", "description"])).expect("no title wanted");
        assert!(
            columns.is_empty(),
            "whitespace and empty strings must not be written, got {columns:?}"
        );
    }

    #[test]
    fn only_requested_fields_are_written() {
        let detail = MetadataDetail {
            title: "T".to_string(),
            developer: Some("Key".to_string()),
            description: Some("Desc".to_string()),
            ..Default::default()
        };
        // Caller only accepted the developer.
        let columns = text_columns(&detail, &fields(&["developer"])).expect("ok");
        assert_eq!(columns.len(), 1);
        assert_eq!(columns[0], ("developer", "Key".to_string()));
    }

    /// Chinese title wins when present, since that is the whole point of
    /// consulting NextMoe.
    #[test]
    fn chinese_title_takes_precedence() {
        let detail = MetadataDetail {
            title: "クラナド".to_string(),
            title_zh: Some("克兰纳德".to_string()),
            ..Default::default()
        };
        let columns = text_columns(&detail, &fields(&["title"])).expect("ok");
        assert_eq!(columns[0], ("title", "克兰纳德".to_string()));
    }

    #[test]
    fn an_empty_title_is_rejected_rather_than_silently_skipped() {
        // A blank title is a caller error, not an absent field: silently writing
        // nothing would leave the user thinking their pick was applied.
        let detail = MetadataDetail {
            title: "   ".to_string(),
            ..Default::default()
        };
        assert!(text_columns(&detail, &fields(&["title"])).is_err());
    }

    #[test]
    fn no_accepted_fields_yields_no_columns() {
        let detail = MetadataDetail {
            title: "T".to_string(),
            developer: Some("Key".to_string()),
            ..Default::default()
        };
        assert!(text_columns(&detail, &[]).expect("ok").is_empty());
    }
}
