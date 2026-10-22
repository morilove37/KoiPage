import { useEffect } from 'react';
import { create } from 'zustand';
import { settingsGetAll, settingsSet, syncAssetScope } from '@/lib/db';
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

export function loadCoverPreferences(): Promise<void> {
  if (useCoverStore.getState().loaded) return Promise.resolve();
  if (!hydration) {
    hydration = (async () => {
      const settings = await settingsGetAll();
      await syncAssetScope();
      const preferences: Record<number, CoverPreferences> = {};
      for (const setting of settings) {
        if (!setting.key.startsWith(COVER_SETTING_PREFIX)) continue;
        const id = Number(setting.key.slice(COVER_SETTING_PREFIX.length));
        if (Number.isSafeInteger(id) && id > 0) preferences[id] = parseCoverPreferences(setting.value);
      }
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
