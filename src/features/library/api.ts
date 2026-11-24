import { ready } from '@/lib/db';
import { notifyLibraryDataChanged } from '@/lib/library-signal';
import { invoke } from '@/lib/logging';
import type { GameStatus } from '@/types/game';
export interface LibraryBatchPatch { status?: GameStatus; favorite?: boolean; addTagIds?: number[]; removeTagIds?: number[] }
export function gamesBatchUpdate(ids: number[], patch: LibraryBatchPatch): Promise<number> {
 return ready
   .then(() => invoke<number>('games_batch_update', { ids, patch }))
   // The shared library cache renders these rows; a batch edit made here or by
   // the AI 助手 has to invalidate it, same as a single `game_update`.
   .then(count => { notifyLibraryDataChanged(); return count; });
}
