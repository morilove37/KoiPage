import type { Game } from '@/types/game';

export function currentMetadataValues(game: Partial<Game>, tags: readonly string[]): Record<string, unknown> {
  return {
    title: game.title, original_title: game.originalTitle, developer: game.developer,
    release_date: game.releaseDate, rating: game.rating, description: game.description,
    vndb_id: game.vndbId, bangumi_id: game.bangumiId, tags: tags.length ? `已有 ${tags.length} 个标签` : null,
  };
}

export function protectExistingFields<T extends Record<string, boolean>>(
  available: T, current: Record<string, unknown> | null,
): T {
  return Object.fromEntries(Object.entries(available).map(([field, enabled]) => {
    const value = current?.[field];
    const populated = value !== null && value !== undefined && String(value).trim() !== '';
    return [field, enabled && !populated];
  })) as T;
}
