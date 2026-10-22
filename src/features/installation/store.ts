import { useEffect } from 'react';
import { create } from 'zustand';
import { ready, settingsGetAll } from '@/lib/db';
import { invoke } from '@/lib/logging';
import { archivedGameIds } from './model';

interface InstallationState {
  loaded: boolean;
  archived: Record<number, boolean>;
  saving: Record<number, boolean>;
  error: string | null;
}
export const useInstallationStore = create<InstallationState>(() => ({ loaded: false, archived: {}, saving: {}, error: null }));
let hydration: Promise<void> | null = null;
export function loadInstallationState(): Promise<void> {
  if (useInstallationStore.getState().loaded) return Promise.resolve();
  if (!hydration) hydration = settingsGetAll().then(settings => {
    useInstallationStore.setState({ archived: archivedGameIds(settings), loaded: true, error: null });
  }).catch(cause => {
    useInstallationStore.setState({ error: String(cause) });
    throw cause;
  }).finally(() => { hydration = null; });
  return hydration;
}
export async function setGameArchived(gameId: number, archived: boolean): Promise<void> {
  await loadInstallationState();
  if (useInstallationStore.getState().saving[gameId]) throw new Error('安装状态正在保存，请稍候。');
  useInstallationStore.setState(state => ({ saving: { ...state.saving, [gameId]: true } }));
  try {
    await ready;
    await invoke<void>('game_archive_set', { gameId, archived });
    useInstallationStore.setState(state => ({ archived: { ...state.archived, [gameId]: archived } }));
  } finally {
    useInstallationStore.setState(state => ({ saving: { ...state.saving, [gameId]: false } }));
  }
}
export function useGameInstallation(gameId: number) {
  const archived = useInstallationStore(state => Boolean(state.archived[gameId]));
  const loaded = useInstallationStore(state => state.loaded);
  const saving = useInstallationStore(state => Boolean(state.saving[gameId]));
  const error = useInstallationStore(state => state.error);
  useEffect(() => { void loadInstallationState().catch(() => {}); }, [gameId]);
  return { archived, loaded, saving, error };
}
