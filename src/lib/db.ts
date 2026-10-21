/**
 * Thin typed wrapper around the Tauri `invoke` bridge.
 *
 * The Rust commands talk to the pool that `tauri-plugin-sql` owns, so the
 * database must be *connected* (and therefore migrated) before any command
 * runs. `Database.load()` is what does that: it creates the sqlite file if
 * needed and applies every migration registered for this URL on the Rust side.
 *
 * Every helper below awaits {@link ready} first, so callers cannot accidentally
 * issue a command against a database that has not been opened yet.
 */

import { invoke, recordLog } from './logging';
import Database from '@tauri-apps/plugin-sql';

import type {
  Game,
  GameDetail,
  GameInput,
  GameListFilter,
  GamePatch,
  GameStats,
  PlaySession,
  ScanRoot,
  Setting,
  Tag,
} from '../types/game';

/**
 * Connection string. Must match `commands::DB_URL` in
 * `src-tauri/src/commands/mod.rs`.
 */
export const DB_URL = 'sqlite:galgame.db';

export interface CoverMigrationReport { copied: number; alreadyManaged: number; missing: number; failed: number }
export function migrateCovers(): Promise<CoverMigrationReport> {
  return initDatabase().then(() => invoke<CoverMigrationReport>('covers_migrate'));
}

let loadPromise: Promise<Database> | null = null;

/**
 * Connect to the database, running migrations on first use.
 *
 * Concurrent callers share one in-flight promise, so the plugin opens exactly
 * one pool even if several components initialise in parallel. On failure the
 * promise is discarded so a later call can retry.
 */
export function initDatabase(): Promise<Database> {
  if (!loadPromise) {
    loadPromise = Database.load(DB_URL).then(async db => {
      // Runs once per connection lifetime before launch controls can become available.
      await invoke<number>('recover_play_sessions');
      return db;
    }).catch((error) => {
      recordLog('ERROR', 'database', '数据库初始化失败', error);
      loadPromise = null;
      throw error;
    });
  }
  return loadPromise;
}

/**
 * A retryable thenable used by the command wrappers below.
 *
 * Keeping a single eagerly-created Promise here made one startup failure
 * permanent: `initDatabase` cleared its cache, but every caller kept awaiting
 * the original rejected Promise. This delegates each `.then`/`await` to the
 * current connection attempt instead.
 */
export const ready = {
  then<TResult1 = Database, TResult2 = never>(
    onfulfilled?: ((value: Database) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return initDatabase().then(onfulfilled, onrejected);
  },
};

/** Await the connection, then hand the pool to `fn`. */
async function withDb<T>(fn: (db: Database) => Promise<T>): Promise<T> {
  const db = await ready;
  return fn(db);
}

// ---------------------------------------------------------------------------
// Games
// ---------------------------------------------------------------------------

export function gamesList(filter: GameListFilter = {}): Promise<Game[]> {
  return ready.then(() =>
    invoke<Game[]>('games_list', {
      search: filter.search ?? null,
      status: filter.status ?? null,
      favoriteOnly: filter.favoriteOnly ?? null,
    }),
  );
}

export function gameGet(id: number): Promise<GameDetail> {
  return ready.then(() => invoke<GameDetail>('game_get', { id }));
}

export function gameCreate(input: GameInput): Promise<Game> {
  return ready.then(() => invoke<Game>('game_create', { input }));
}

export function gameUpdate(id: number, patch: GamePatch): Promise<Game> {
  return ready.then(() => invoke<Game>('game_update', { id, patch }));
}

export function gameDelete(id: number): Promise<void> {
  return ready.then(() => invoke<void>('game_delete', { id }));
}

/** Outcome of {@link gamesDelete}. */
export interface DeleteGamesResult {
  /** How many ids were supplied, before de-duplication. */
  requested: number;
  deleted: number;
  /** Ids that matched no row (e.g. removed by another window). */
  missing: number[];
}

/**
 * Delete many games in one transaction.
 *
 * Used by the library's multi-select. One call rather than a loop of
 * {@link gameDelete}: a loop would be N round trips, and a failure part-way
 * through would leave the library half-deleted.
 *
 * Unknown ids come back in `missing` instead of rejecting, so a selection
 * containing a row that already vanished still deletes the rest.
 *
 * Tag links and play sessions are removed by `ON DELETE CASCADE`; the game
 * **files on disk are never touched**.
 */
export function gamesDelete(ids: number[]): Promise<DeleteGamesResult> {
  return ready.then(() => invoke<DeleteGamesResult>('games_delete', { ids }));
}

/** All `[gameId, tagId]` links, for rendering tag chips without N+1 queries. */
export function gamesTagsGet(): Promise<Array<[number, number]>> {
  return ready.then(() => invoke<Array<[number, number]>>('games_tags_get'));
}

export function gamesStats(): Promise<GameStats> {
  return ready.then(() => invoke<GameStats>('games_stats'));
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

export function tagsList(): Promise<Tag[]> {
  return ready.then(() => invoke<Tag[]>('tags_list'));
}

export function tagCreate(name: string, color?: string | null): Promise<Tag> {
  return ready.then(() => invoke<Tag>('tag_create', { name, color: color ?? null }));
}

export function tagUpdate(
  id: number,
  name?: string | null,
  color?: string | null,
): Promise<Tag> {
  return ready.then(() =>
    invoke<Tag>('tag_update', {
      id,
      name: name ?? null,
      // `undefined` means "leave colour alone"; `null` clears it.
      color: color === undefined ? null : color,
    }),
  );
}

export function tagDelete(id: number): Promise<void> {
  return ready.then(() => invoke<void>('tag_delete', { id }));
}

export function gameSetTags(gameId: number, tagIds: number[]): Promise<number[]> {
  return ready.then(() => invoke<number[]>('game_set_tags', { gameId, tagIds }));
}

// ---------------------------------------------------------------------------
// Play sessions
// ---------------------------------------------------------------------------

export function playSessionStart(gameId: number): Promise<PlaySession> {
  return ready.then(() => invoke<PlaySession>('play_session_start', { gameId }));
}

export function playSessionEnd(
  sessionId: number,
  durationSeconds?: number | null,
): Promise<PlaySession> {
  return ready.then(() =>
    invoke<PlaySession>('play_session_end', {
      sessionId,
      durationSeconds: durationSeconds ?? null,
    }),
  );
}

export function playSessionsList(gameId?: number, limit?: number): Promise<PlaySession[]> {
  return ready.then(() =>
    invoke<PlaySession[]>('play_sessions_list', {
      gameId: gameId ?? null,
      limit: limit ?? null,
    }),
  );
}

/** Complete ended-session range for calendar charts, independent of list limits. */
export function playSessionsForPeriod(start: string, end: string): Promise<PlaySession[]> {
  return ready.then(() => invoke<PlaySession[]>('play_sessions_list', {
    gameId: null, limit: null, startedBefore: end, endedAfter: start,
  }));
}

/** Cursor pagination for all-time history; no total-history record cap. */
export function playSessionsPage(limit: number, before?: Pick<PlaySession, 'startedAt' | 'id'>): Promise<PlaySession[]> {
  return ready.then(() => invoke<PlaySession[]>('play_sessions_list', {
    gameId: null, limit, beforeStartedAt: before?.startedAt ?? null, beforeId: before?.id ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function settingsGet(key: string): Promise<string | null> {
  return ready.then(() => invoke<string | null>('settings_get', { key }));
}

export function settingsSet(key: string, value: string | null): Promise<void> {
  return ready.then(() => invoke<void>('settings_set', { key, value }));
}

export function settingsGetAll(): Promise<Setting[]> {
  return ready.then(() => invoke<Setting[]>('settings_get_all'));
}

export function settingsDelete(key: string): Promise<boolean> {
  return ready.then(() => invoke<boolean>('settings_delete', { key }));
}

// ---------------------------------------------------------------------------
// Scan roots
// ---------------------------------------------------------------------------

export function scanRootsList(): Promise<ScanRoot[]> {
  return ready.then(() => invoke<ScanRoot[]>('scan_roots_list'));
}

/**
 * Restore read access to saved local cover files after the database connects.
 * The Rust create/update commands also grant access immediately for new covers.
 * Returns the number of existing local cover files granted.
 */
export function syncAssetScope(): Promise<number> {
  return ready.then(() => invoke<number>('sync_asset_scope'));
}

export function scanRootCreate(
  path: string,
  enabled?: number,
  maxDepth?: number,
): Promise<ScanRoot> {
  return ready.then(() =>
    invoke<ScanRoot>('scan_root_create', {
      path,
      enabled: enabled ?? null,
      maxDepth: maxDepth ?? null,
    }),
  );
}

export function scanRootUpdate(
  id: number,
  enabled?: number | null,
  maxDepth?: number | null,
): Promise<ScanRoot> {
  return ready.then(() =>
    invoke<ScanRoot>('scan_root_update', {
      id,
      enabled: enabled ?? null,
      maxDepth: maxDepth ?? null,
    }),
  );
}

export function scanRootDelete(id: number): Promise<void> {
  return ready.then(() => invoke<void>('scan_root_delete', { id }));
}

// ---------------------------------------------------------------------------
// Manual exe import
// ---------------------------------------------------------------------------

/**
 * `inspect_exe_file` — resolve one hand-picked `.exe` into an importable
 * candidate.
 *
 * Fetching the candidate shape from the command rather than rebuilding it in
 * TypeScript keeps the manual-import dialog and the scan dialog on the same
 * recogniser. The returned `suggestedExe` is always `path` itself: the user's
 * explicit choice outranks the heuristics, while `exePaths` still carries every
 * alternative found in `path`'s folder.
 *
 * Never rejects for a folder the scanner cannot recognise — a minimal candidate
 * comes back instead.
 */
export function inspectExeFile(path: string): Promise<ScanCandidatePayload> {
  return ready.then(() => invoke<ScanCandidatePayload>('inspect_exe_file', { path }));
}

/**
 * Wire shape of a scanner candidate.
 *
 * Declared locally (not imported from `features/scan/types`) so this module
 * stays free of feature-layer imports; the two are structurally identical and
 * `features/scan/types.ts` `ScanCandidate` remains the canonical one for UI
 * code.
 */
export interface ScanCandidatePayload {
  folderPath: string;
  folderName: string;
  exePaths: string[];
  suggestedExe: string | null;
  coverPath: string | null;
  suggestedTitle: string;
  sizeBytes: number;
  alreadyImported: boolean;
}

// ---------------------------------------------------------------------------
// Archive extraction (archive-import)
// ---------------------------------------------------------------------------

/** One dropped archive family; volumes collapse to the first volume. */
export interface ArchiveGroup {
  primary: string;
  displayName: string;
  paths: string[];
}

export type ArchiveExtractStatus = "ok" | "passwordRequired" | "wrongPassword" | "failed";

export interface ArchiveExtractResult {
  status: ArchiveExtractStatus;
  archive: string;
  /** Created folder; empty unless `status === "ok"`. */
  targetDir: string;
  message: string | null;
  /** Originals moved to the Recycle Bin after a successful extraction. */
  deletedFiles: string[];
  /** Set when the originals could not be moved to the Recycle Bin. */
  cleanupWarning: string | null;
}

/** Payload of the `archive-extract-progress` event. */
export interface ArchiveExtractProgress {
  archive: string;
  percent: number;
}

export const ARCHIVE_EXTRACT_PROGRESS_EVENT = "archive-extract-progress";

/**
 * `archive_group` — collapse dropped paths into archive families.
 *
 * Accepts any volume (`Game.part2.rar`, `Game.r01`, `Game.7z.002`, `Game.z01`)
 * and returns the first volume 7-Zip needs. Unsupported paths are omitted.
 */
export function archiveGroup(paths: string[]): Promise<ArchiveGroup[]> {
  return ready.then(() => invoke<ArchiveGroup[]>("archive_group", { paths }));
}

/**
 * `archive_extract` — extract one archive into `<destination>/<name>`.
 *
 * Password-protected archives return `passwordRequired` / `wrongPassword`
 * instead of rejecting, so the UI can prompt and retry. The folder is created
 * only for successful runs (a failed attempt cleans up after itself).
 */
export function archiveExtract(
  archive: string,
  destination: string,
  password?: string,
): Promise<ArchiveExtractResult> {
  return ready.then(() =>
    invoke<ArchiveExtractResult>("archive_extract", {
      archive,
      destination,
      password: password && password.length > 0 ? password : null,
    }),
  );
}

// ---------------------------------------------------------------------------
// Escape hatch
// ---------------------------------------------------------------------------

/**
 * Direct database access, for ad-hoc queries that do not warrant a Rust
 * command (e.g. scanner bookkeeping). Awaits the connection first.
 */
export function getDatabase(): Promise<Database> {
  return withDb((db) => Promise.resolve(db));
}

export { withDb };
export type {
  Game,
  GameDetail,
  GameInput,
  GameListFilter,
  GamePatch,
  GameStats,
  PlaySession,
  ScanRoot,
  Setting,
  Tag,
};

// ---------------------------------------------------------------------------
// External metadata (NextMoe / VNDB / Bangumi)
// ---------------------------------------------------------------------------
//
// All four commands are implemented in `src-tauri/src/commands/metadata.rs`.
// The HTTP requests happen in Rust on purpose (CORS, plus the `User-Agent`
// that VNDB and Bangumi require), so **nothing here talks to the network
// directly** and no capability/origin allowlist is involved.
//
// That also means every failure arrives as a rejected promise whose value is a
// plain string — see `CmdError`'s `Serialize` impl — so callers must use the
// `cause instanceof Error ? cause.message : String(cause)` idiom.

/** Providers `metadata_search` / `metadata_detail` understand. */
export type MetadataProvider = 'nextmoe' | 'vndb' | 'bangumi' | '2dfan';

export function backgroundAssetGrant(path: string): Promise<void> {
  return ready.then(() => invoke<void>('background_asset_grant', { path }));
}

export function gameCoverImport(gameId: number, sourcePath: string): Promise<string> {
  return ready.then(() => invoke<string>('game_cover_import', { gameId, sourcePath }));
}

export function metadataCoverPreview(coverUrl: string): Promise<ArrayBuffer> {
  return ready.then(() => invoke<ArrayBuffer>('metadata_cover_preview', { coverUrl }));
}

/**
 * One search hit, normalised across providers.
 *
 * Deliberately thin: the heavy payload only arrives once the user picks a
 * candidate, via {@link metadataDetail}.
 */
export interface MetadataCandidate {
  provider: MetadataProvider;
  /** Provider-local id, passed straight back to `metadata_detail`. */
  externalId: string;
  /** Best display title the provider offers (Chinese preferred when known). */
  title: string;
  originalTitle: string | null;
  /** Extra spellings used only by the Rust auto-fetch matcher, never rendered. */
  aliases?: string[];
  releaseDate: string | null;
  /** Remote cover URL; cache it with {@link metadataCoverCache}. */
  coverUrl: string | null;
  /** 0-10, already normalised by the Rust provider modules. */
  rating: number | null;
  /** Human-readable provider label, e.g. `鲲 Galgame 论坛`. */
  sourceLabel: string;
}

/**
 * A rating from one upstream source.
 *
 * `score` is always 0-10 here even though ErogameScape and HowLongToBeat use
 * 0-100 upstream: the Rust provider modules normalise before merging.
 */
export interface SourceRating {
  source: string;
  score: number;
  voteCount: number | null;
}

/** Fully resolved metadata for one work, merged across providers. */
export interface MetadataDetail {
  /** Which provider this detail primarily came from. */
  provider: MetadataProvider | null;
  externalId: string | null;
  /** The provider's own display title. */
  title: string;
  /** Chinese title when any provider knows one; what we prefer to store. */
  titleZh: string | null;
  /** Original-script (usually Japanese) title. */
  titleOriginal: string | null;
  developer: string | null;
  releaseDate: string | null;
  /** 0-10 score, stored to two decimal places in `games.rating`. */
  rating: number | null;
  /** Per-source breakdown, shown to the user for transparency. */
  ratings: SourceRating[];
  coverUrl: string | null;
  description: string | null;
  descriptionLang: string | null;
  tags: string[];
  vndbId: string | null;
  bangumiId: string | null;
  /**
   * Attribution the provider requires us to display, e.g. `鲲 Galgame 论坛`
   * (or `鲲 Galgame 论坛、VNDB` once merged). Never omit it from the UI.
   */
  attribution: string | null;
}

/** One provider that failed during a search. */
export interface ProviderError {
  provider: MetadataProvider;
  message: string;
}

/**
 * `metadata_search` result.
 *
 * A provider that fails does **not** fail the whole search: its reason lands in
 * `errors` while the other sources still return candidates. The UI must render
 * both, otherwise a rate-limited source (VNDB allows 200 requests / 5 minutes)
 * looks exactly like "this game does not exist".
 */
export interface MetadataSearchResult {
  candidates: MetadataCandidate[];
  errors: ProviderError[];
  /** Confident matches ranked by the saved default source, then relevance. */
  automaticCandidates: MetadataCandidate[];
}

/**
 * Field names `metadata_apply` accepts.
 *
 * Only the listed fields are written, so the user can take the title while
 * rejecting an upstream description. Note that covers are *not* part of this
 * list: they are downloaded separately by {@link metadataCoverCache} and stored
 * with {@link gameUpdate}.
 */
export type MetadataField =
  | 'title'
  | 'original_title'
  | 'developer'
  | 'release_date'
  | 'description'
  | 'rating'
  | 'vndb_id'
  | 'bangumi_id'
  | 'tags';

/** `merge` (default) keeps existing tags and appends; `replace` swaps them. */
export type MetadataTagMode = 'merge' | 'replace';

/** Result of `metadata_apply`. */
export interface AppliedMetadata {
  gameId: number;
  fieldsApplied: number;
  tagsAdded: number;
}

/**
 * Search every requested provider for `query`.
 *
 * Resolves (never rejects) for a provider that is merely unreachable — read
 * `errors`. It only rejects for caller mistakes such as an empty query, an
 * empty `sources` list, or unrecognised source names.
 */
export function metadataSearch(
  query: string,
  sources: MetadataProvider[],
  limit?: number,
): Promise<MetadataSearchResult> {
  return ready.then(() =>
    invoke<MetadataSearchResult>('metadata_search', {
      query,
      sources,
      limit: limit ?? null,
    }),
  );
}

/**
 * Resolve one candidate into merged metadata.
 *
 * When the chosen provider is not NextMoe, Rust additionally tries NextMoe's
 * `refs=` lane to backfill a Chinese title or extra ratings; that lookup
 * missing the work is normal (NextMoe covers roughly 27% of VNDB) and is not
 * an error.
 */
export function metadataDetail(
  provider: MetadataProvider,
  externalId: string,
): Promise<MetadataDetail> {
  return ready.then(() => invoke<MetadataDetail>('metadata_detail', { provider, externalId }));
}

/**
 * Write only `fields` from `detail` onto `gameId`.
 *
 * Tag names are created when missing and merged into the existing set unless
 * `tagMode` is `'replace'`. Fields whose upstream value is null **are** written
 * as null when listed, so the caller must not pre-check fields with no data.
 */
export function metadataApply(
  gameId: number,
  detail: MetadataDetail,
  fields: MetadataField[],
  tagMode?: MetadataTagMode,
): Promise<AppliedMetadata> {
  return ready.then(() =>
    invoke<AppliedMetadata>('metadata_apply', {
      gameId,
      detail,
      fields,
      tagMode: tagMode ?? null,
    }),
  );
}

/**
 * Download `coverUrl` into `installPath` and resolve the **local** file path.
 *
 * Store the result in `games.coverPath` (via {@link gameUpdate}) so the cover
 * keeps rendering offline. Rejects when the directory does not exist, the
 * download fails, or the response body is empty.
 */
export function metadataCoverCache(
  gameId: number,
  coverUrl: string,
  installPath: string,
): Promise<string> {
  return ready.then(() =>
    invoke<string>('metadata_cover_cache', { gameId, coverUrl, installPath }),
  );
}

// ---------------------------------------------------------------------------
// Auto-fetch (runs right after an import)
// ---------------------------------------------------------------------------

/** What auto-fetch did for one game. */
export type AutofetchStatus = 'applied' | 'needsReview' | 'noMatch' | 'failed';

/** Per-game outcome of {@link metadataAutofetch}. */
export interface AutofetchOutcome {
  gameId: number;
  /** The game's title when the lookup ran. */
  title: string;
  status: AutofetchStatus;
  provider: MetadataProvider | null;
  externalId: string | null;
  /** The matched work's title — useful even when nothing was written. */
  matchedTitle: string | null;
  /** `exact` / `strong` when accepted, `weak` when it needs review. */
  confidence: 'exact' | 'strong' | 'weak' | null;
  fieldsApplied: number;
  tagsAdded: number;
  /** Local path of the cached cover, when one was downloaded. */
  coverPath: string | null;
  /** Failure reason; only present for `failed`. */
  message: string | null;
}

/** Batch summary returned by {@link metadataAutofetch}. */
export interface AutofetchSummary {
  outcomes: AutofetchOutcome[];
  applied: number;
  needsReview: number;
  noMatch: number;
  failed: number;
}

/** Payload of the `metadata-autofetch-progress` event. */
export interface AutofetchProgress {
  gameId: number;
  title: string;
  /** 1-based position in the batch. */
  index: number;
  total: number;
  status: AutofetchStatus;
}

/** Event name emitted once per game during {@link metadataAutofetch}. */
export const AUTOFETCH_PROGRESS_EVENT = 'metadata-autofetch-progress';

/**
 * Look up and apply metadata for a batch of games.
 *
 * This is what runs immediately after an import, so the user does not have to
 * search every game by hand.
 *
 * A candidate is only written when the title match is **confident** (exact, or
 * one title prefixing the other with little surplus). Anything weaker comes back
 * as `needsReview` with its candidate and is left untouched — a wrong match
 * would silently replace the user's title with an unrelated work's.
 *
 * Games are processed one at a time, spaced by `delayMs`, because the upstreams
 * are rate-limited (VNDB 200 per 5 minutes; anonymous NextMoe 30 per minute).
 * A throttled source fails that one game rather than aborting the batch.
 *
 * Listen on {@link AUTOFETCH_PROGRESS_EVENT} to show progress during a batch
 * that can take a minute.
 */
export function metadataAutofetch(
  gameIds: number[],
  options: { sources?: MetadataProvider[]; apply?: boolean; delayMs?: number } = {},
): Promise<AutofetchSummary> {
  return ready.then(() =>
    invoke<AutofetchSummary>('metadata_autofetch', {
      gameIds,
      sources: options.sources ?? [],
      apply: options.apply ?? true,
      delayMs: options.delayMs ?? null,
    }),
  );
}
