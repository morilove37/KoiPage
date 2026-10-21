import { ready } from '@/lib/db';
import { invoke } from '@/lib/logging';

export interface SessionInput { id?: number; gameId: number; startedAt: string; durationSeconds: number }
export const saveSession = (input: SessionInput) => ready.then(() => invoke<number>('play_session_save', { input }));
export const deleteSession = (sessionId: number) => ready.then(() => invoke<void>('play_session_delete', { sessionId }));
export const settleOrphanSession = (sessionId: number) => ready.then(() => invoke<void>('settle_orphan_session', { sessionId }));
export const prepareManagerExit = () => ready.then(() => invoke<number>('prepare_manager_exit'));
// Recovery belongs to database initialization; do not call it whenever a detail panel mounts.
export const recoverSessions = () => ready.then(() => invoke<number>('recover_play_sessions'));
