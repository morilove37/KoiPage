import { invoke } from '@/lib/logging';
import { initDatabase } from '@/lib/db';

export interface Account { id: number; username: string; nickname: string }
export interface SyncValue { collectionType: number | null; rate: number; comment: string }
export interface SyncConflict { local: SyncValue; remote: SyncValue; base: SyncValue | null; fields: string[]; reason: string }
export interface SyncReport { synced: number; uploaded: number; downloaded: number; conflicts: number; skipped: number; errors: number }
export interface SyncStatus {
  connected: boolean; account: Account | null; enabled: boolean; intervalSeconds: number; privateNew: boolean;
  lastRunAt: string | null; lastError: string | null; lastReport: SyncReport | null;
}
export interface SyncItem {
  gameId: number; title: string; subjectId: number | null; enabled: boolean;
  personalRate: number | null; personalComment: string | null; lastSyncedAt: string | null;
  error: string | null; conflict: SyncConflict | null; revision: number;
}
export type ProfileInput = Pick<SyncItem, 'gameId' | 'subjectId' | 'enabled' | 'personalRate' | 'personalComment'> & { expectedRevision?: number };
async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  await initDatabase();
  return invoke<T>(command, args);
}
export const syncStatus = () => call<SyncStatus>('bangumi_sync_status');
export const syncConnect = (token: string) => call<SyncStatus>('bangumi_sync_connect', { token });
export const syncDisconnect = () => call<SyncStatus>('bangumi_sync_disconnect');
export const syncConfigure = (enabled: boolean, privateNew: boolean) => call<SyncStatus>('bangumi_sync_configure', { enabled, privateNew });
export const syncRun = (force: boolean) => call<SyncReport>('bangumi_sync_run', { force });
export const syncItems = () => call<SyncItem[]>('bangumi_sync_items');
export const syncProfile = (gameId: number) => call<SyncItem>('bangumi_sync_profile_get', { gameId });
export const syncSaveProfile = (input: ProfileInput) => call<SyncItem>('bangumi_sync_profile_save', { ...input });
export const syncPause = (gameId: number) => call<SyncItem>('bangumi_sync_pause', { gameId });
export const syncResolve = (gameId: number, choice: 'local' | 'remote') => call<SyncItem>('bangumi_sync_resolve', { gameId, choice });
