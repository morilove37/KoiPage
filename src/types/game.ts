/**
 * Domain types for the galgame manager.
 *
 * These mirror the SQLite schema in `src-tauri/migrations/0001_init.sql` and
 * the Rust structs in `src-tauri/src/commands/model.rs`. Rust serialises with
 * `#[serde(rename_all = "camelCase")]`, so every field here is camelCase.
 *
 * All timestamps are ISO8601 UTC strings (e.g. `2024-05-01T12:34:56Z`).
 */

/** ISO8601 UTC timestamp, e.g. `2024-05-01T12:34:56Z`. */
export type IsoDateTime = string;

/** Canonical `games.status` values. */
export const GAME_STATUSES = [
  'unplayed',
  'wishlist',
  'playing',
  'completed',
  'on_hold',
  'dropped',
] as const;

export type GameStatus = (typeof GAME_STATUSES)[number];

/** Human-readable labels for `GameStatus`. */
export const GAME_STATUS_LABELS: Record<GameStatus, string> = {
  unplayed: '未游玩',
  wishlist: '想玩',
  playing: '游玩中',
  completed: '已通关',
  on_hold: '搁置',
  dropped: '弃坑',
};

/** A row of the `games` table. */
export interface Game {
  id: number;
  title: string;
  originalTitle: string | null;
  developer: string | null;
  releaseDate: string | null;
  status: GameStatus;
  /** 0-10, preserving decimal precision; null when unrated. */
  rating: number | null;
  /** SQLite has no boolean type; this is 0 or 1. */
  favorite: number;
  coverPath: string | null;
  description: string | null;
  installPath: string;
  exePath: string | null;
  launchArgs: string | null;
  workdir: string | null;
  savePath: string | null;
  playTimeSeconds: number;
  lastPlayedAt: IsoDateTime | null;
  notes: string | null;
  vndbId: string | null;
  bangumiId: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** A row of the `tags` table. */
export interface Tag {
  id: number;
  name: string;
  color: string | null;
}

/** A row of the `scan_roots` table. */
export interface ScanRoot {
  id: number;
  path: string;
  /** 0 or 1. */
  enabled: number;
  maxDepth: number;
}

/** A row of the `play_sessions` table. */
export interface PlaySession {
  id: number;
  gameId: number;
  startedAt: IsoDateTime;
  endedAt: IsoDateTime | null;
  durationSeconds: number;
}

/** A `settings` row, as returned by `settings_get_all`. */
export interface Setting {
  key: string;
  value: string | null;
}

/** `game_get` result: the game plus its tag ids. */
export interface GameDetail extends Game {
  tags: number[];
}

/** Aggregate counters returned by `games_stats`. */
export interface GameStats {
  total: number;
  favorite: number;
  playTimeSeconds: number;
  /** `[status, count]` pairs. */
  byStatus: Array<[GameStatus, number]>;
}

/** Payload for `game_create`. `title` and `installPath` are required. */
export interface GameInput {
  title: string;
  installPath: string;
  originalTitle?: string | null;
  developer?: string | null;
  releaseDate?: string | null;
  status?: GameStatus;
  rating?: number | null;
  favorite?: number;
  coverPath?: string | null;
  description?: string | null;
  exePath?: string | null;
  launchArgs?: string | null;
  workdir?: string | null;
  savePath?: string | null;
  playTimeSeconds?: number;
  lastPlayedAt?: IsoDateTime | null;
  notes?: string | null;
  vndbId?: string | null;
  bangumiId?: string | null;
  /** Optional initial tag set. */
  tags?: number[];
  /** Tag names created and attached atomically when importing a new game. */
  tagNames?: string[];
}

/**
 * Payload for `game_update`.
 *
 * Omitted keys are left untouched. Passing an explicit `null` clears a
 * nullable column; `title` and `installPath` cannot be cleared.
 */
export type GamePatch = Partial<{
  title: string;
  originalTitle: string | null;
  developer: string | null;
  releaseDate: string | null;
  status: GameStatus;
  rating: number | null;
  favorite: number;
  coverPath: string | null;
  description: string | null;
  installPath: string;
  exePath: string | null;
  launchArgs: string | null;
  workdir: string | null;
  savePath: string | null;
  playTimeSeconds: number;
  lastPlayedAt: IsoDateTime | null;
  notes: string | null;
  vndbId: string | null;
  bangumiId: string | null;
  /** Replaces the game's tag set wholesale when present. */
  tags: number[];
  /** Creates or reuses these names and attaches them in the same save transaction. */
  tagNames: string[];
}>;

/** Filters accepted by `games_list`. */
export interface GameListFilter {
  /** Case-insensitive substring match on title / originalTitle / developer. */
  search?: string;
  status?: GameStatus;
  favoriteOnly?: boolean;
}

/** Convenience helper: `favorite` is stored as 0/1. */
export function isFavorite(game: Pick<Game, 'favorite'>): boolean {
  return game.favorite === 1;
}

/** Convenience helper: format a duration for display. */
export function formatPlayTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0 分钟';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return minutes > 0 ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`;
  return `${minutes} 分钟`;
}
