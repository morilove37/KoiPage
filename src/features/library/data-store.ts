import { create } from 'zustand';

import { gamesList, gamesStats, gamesTagsGet, settingsGet, tagsList } from '@/lib/db';
import { onLibraryDataChanged } from '@/lib/library-signal';
import { snapshotValue } from '@/lib/settings-snapshot';
import type { SettingsSnapshot } from '@/lib/settings-snapshot';
import type { Game, GameStats, Tag } from '@/types/game';

import { FOLDERS_KEY, parseFolders } from './folders';
import type { LibraryFolder } from './folders';

/**
 * Shared cache for the rows every library-flavoured page renders.
 *
 * 首页、游戏库 and 游戏文件夹 all show the same `games_list` / `tags_list` /
 * `games_tags_get` / `games_stats` rows, and `App.tsx` keys `<main>` by
 * pathname, so each navigation mounted a brand-new page component with its own
 * `useState` — which meant a full reload and a blank screen on every single
 * visit. This store owns that data instead:
 *
 * - `refreshLibraryData()` is the only entry point. Concurrent callers share
 *   one in-flight request, so a navigation during a refresh joins it instead
 *   of queueing another.
 * - The rows already on screen are kept until the new ones arrive. `loading`
 *   is only true when there is nothing cached to show, so the shimmer and the
 *   "载入中…" labels stay for a genuine first load and never flash on the way
 *   back from another page.
 * - `revision` bumps after every successful refresh, for views built from the
 *   same rows (游玩记录 / 统计) that need to re-run their own effects.
 */
interface LibraryDataState {
  games: Game[];
  tags: Tag[];
  links: Array<[number, number]>;
  stats: GameStats | null;
  folders: LibraryFolder[];
  /** True once the game rows were read at least once. */
  loaded: boolean;
  /** True once the folder definitions were read (or seeded) at least once. */
  foldersLoaded: boolean;
  /** A load with nothing to show yet — the only state that blanks a page. */
  loading: boolean;
  /** A background refresh while cached rows stay on screen. */
  refreshing: boolean;
  revision: number;
  /** Set only when a load failed and there was no cached data to fall back on. */
  error: string | null;
}

export const useLibraryDataStore = create<LibraryDataState>(() => ({
  games: [],
  tags: [],
  links: [],
  stats: null,
  folders: [],
  loaded: false,
  foldersLoaded: false,
  // Mirrors the old `useState(true)`: the first render must not briefly show
  // the "游戏库还是空的" empty state before the mount effect runs.
  loading: true,
  refreshing: false,
  revision: 0,
  error: null,
}));

let fetchInFlight: Promise<void> | null = null;
/**
 * Bumped by every write. A read snapshots it when it starts and compares it
 * when it finishes: a write that landed mid-read may not be reflected in the
 * rows it fetched, so the store reads once more instead of publishing stale
 * data (and then waits for the next navigation to notice).
 */
let writeSequence = 0;

/**
 * Writes anywhere in the app (标签页, 详情页, 元数据, AI 助手) announce
 * themselves through `library-signal`, so the cached rows here never outlive an
 * edit made elsewhere. The refresh keeps whatever is on screen until the new
 * rows arrive, exactly like a manual refresh.
 */
onLibraryDataChanged(() => {
  writeSequence += 1;
  void refreshLibraryData();
});

/** Read the game rows once; later calls resolve immediately. */
export function ensureLibraryData(): Promise<void> {
  if (useLibraryDataStore.getState().loaded) return Promise.resolve();
  return refreshLibraryData();
}

/**
 * Re-read the game rows.
 *
 * Never rejects: a failure is recorded in `error` for the page to render while
 * the cached rows stay on screen, and the next navigation retries.
 */
export function refreshLibraryData(): Promise<void> {
  // A caller arriving during a read joins it; if a write landed meanwhile the
  // finishing read re-runs itself, so joining is still correct.
  if (fetchInFlight) return fetchInFlight;
  const startedAt = writeSequence;
  const blank = !useLibraryDataStore.getState().loaded;
  useLibraryDataStore.setState(blank
    ? { loading: true, refreshing: false, error: null }
    : { refreshing: true, error: null });
  fetchInFlight = Promise.all([gamesList(), tagsList(), gamesTagsGet(), gamesStats()])
    .then(([games, tags, links, stats]) => {
      useLibraryDataStore.setState(state => ({
        games, tags, links, stats, loaded: true, error: null, revision: state.revision + 1,
      }));
    })
    .catch(cause => {
      useLibraryDataStore.setState({ error: cause instanceof Error ? cause.message : String(cause) });
    })
    .finally(() => {
      fetchInFlight = null;
      useLibraryDataStore.setState({ loading: false, refreshing: false });
      if (writeSequence !== startedAt) void refreshLibraryData();
    });
  return fetchInFlight;
}

/**
 * Seed the folder definitions from the startup settings dump.
 *
 * `main.tsx` already reads every setting once; taking the folder key from that
 * same snapshot means 游戏文件夹 can paint its folder list on the first frame
 * instead of waiting for its own `settings_get`.
 */
export function seedLibraryFolders(snapshot: SettingsSnapshot): void {
  const raw = snapshotValue(snapshot, FOLDERS_KEY);
  if (raw === undefined) return;
  useLibraryDataStore.setState({ folders: parseFolders(raw ?? null), foldersLoaded: true });
}

/** Read the folder definitions from the settings table. */
export function readLibraryFolders(): Promise<LibraryFolder[]> {
  return settingsGet(FOLDERS_KEY).then(raw => parseFolders(raw));
}

/** Publish folder definitions after they were read or saved. */
export function applyLibraryFolders(next: LibraryFolder[]): void {
  useLibraryDataStore.setState({ folders: next, foldersLoaded: true });
}

/** Optimistic game updates (favourite toggles, status changes) land here. */
export function setLibraryGames(value: Game[] | ((current: Game[]) => Game[])): void {
  useLibraryDataStore.setState(state => ({
    games: typeof value === 'function' ? value(state.games) : value,
  }));
}

export function setLibraryStats(value: GameStats | ((current: GameStats | null) => GameStats)): void {
  useLibraryDataStore.setState(state => ({
    stats: typeof value === 'function' ? value(state.stats) : value,
  }));
}
