import { ready } from '@/lib/db';
import { invoke } from '@/lib/logging';
import type { GameStatus } from '@/types/game';
export interface LibraryBatchPatch { status?: GameStatus; favorite?: boolean; addTagIds?: number[]; removeTagIds?: number[] }
export function gamesBatchUpdate(ids: number[], patch: LibraryBatchPatch): Promise<number> {
 return ready.then(() => invoke<number>('games_batch_update', { ids, patch }));
}
