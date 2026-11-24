import { useEffect } from 'react';
import { create } from 'zustand';
import { settingsGetAll, settingsSet, syncAssetScope } from '@/lib/db';
import type { SettingsSnapshot } from '@/lib/settings-snapshot';
import { COVER_SETTING_PREFIX, DEFAULT_COVER, parseCoverPreferences, mergeCoverPreferences } from './model';
import type { CoverPreferences } from './model';

interface CoverState {
  loaded: boolean;
  error: string | null;
  preferences: Record<number, CoverPreferences>;
  saving: Record<number, boolean>;
}
export const useCoverStore = create<CoverState>(() => ({ loaded: false, error: null, preferences: {}, saving: {} }));
let hydration: Promise<void> | null = null;

/** A startup snapshot captured by `main.tsx`, consumed by the first hydration. */
let seedSnapshot: SettingsSnapshot | null = null;

/**
 * Hand the startup settings read to the cover store.
 *
 * `main.tsx` already reads every setting once before the first paint; the
 * preferences live in that same table under `game_cover:<id>`, so the first
 * cover render can be seeded from it instead of issuing a second full dump.
 */
export function seedCoverPreferences(snapshot: SettingsSnapshot): void {
  seedSnapshot = snapshot;
}

function preferencesFrom(settings: Iterable<{ key: string; value: string | null }>): Record<number, CoverPreferences> {
  const preferences: Record<number, CoverPreferences> = {};
  for (const setting of settings) {
    if (!setting.key.startsWith(COVER_SETTING_PREFIX)) continue;
    const id = Number(setting.key.slice(COVER_SETTING_PREFIX.length));
    if (Number.isSafeInteger(id) && id > 0) preferences[id] = parseCoverPreferences(setting.value);
  }
  return preferences;
}

export function loadCoverPreferences(): Promise<void> {
  if (useCoverStore.getState().loaded) return Promise.resolve();
  if (!hydration) {
    hydration = (async () => {
      const seed = seedSnapshot;
      seedSnapshot = null;
      const preferences = seed
        ? preferencesFrom(Array.from(seed, ([key, value]) => ({ key, value })))
        : preferencesFrom(await settingsGetAll());
      await syncAssetScope();
      useCoverStore.setState({ preferences, loaded: true, error: null });
    })().catch(cause => {
      useCoverStore.setState({ error: String(cause) });
      throw cause;
    }).finally(() => { hydration = null; });
  }
  return hydration;
}

/** Persist before publishing so a failed write never looks like a saved change. */
export async function updateCoverPreferences(gameId: number, patch: Partial<CoverPreferences>): Promise<void> {
  await loadCoverPreferences();
  if (useCoverStore.getState().saving[gameId]) throw new Error('封面正在保存，请稍候。');
  useCoverStore.setState(state => ({ saving: { ...state.saving, [gameId]: true } }));
  try {
    const next = mergeCoverPreferences(useCoverStore.getState().preferences[gameId] ?? DEFAULT_COVER, patch);
    await settingsSet(`${COVER_SETTING_PREFIX}${gameId}`, JSON.stringify(next));
    useCoverStore.setState(state => ({ preferences: { ...state.preferences, [gameId]: next } }));
  } finally {
    useCoverStore.setState(state => ({ saving: { ...state.saving, [gameId]: false } }));
  }
}

export function useGameCover(gameId?: number) {
  const preferences = useCoverStore(state => gameId === undefined ? DEFAULT_COVER : state.preferences[gameId] ?? DEFAULT_COVER);
  const loaded = useCoverStore(state => state.loaded);
  const saving = useCoverStore(state => gameId === undefined ? false : Boolean(state.saving[gameId]));
  const error = useCoverStore(state => state.error);
  useEffect(() => {
    if (gameId !== undefined) void loadCoverPreferences().catch(() => {});
  }, [gameId]);
  return { preferences, loaded: gameId === undefined || loaded, saving, error };
}
