import type { InstallationFilter } from '../library/preferences';

export const ARCHIVE_SETTING_PREFIX = 'game_archived:';
export function archivedGameIds(settings: ReadonlyArray<{ key: string; value: string | null }>): Record<number, boolean> {
  const archived: Record<number, boolean> = {};
  for (const setting of settings) {
    if (!setting.key.startsWith(ARCHIVE_SETTING_PREFIX) || setting.value !== 'true') continue;
    const suffix = setting.key.slice(ARCHIVE_SETTING_PREFIX.length);
    const id = Number(suffix);
    if (Number.isSafeInteger(id) && id > 0 && String(id) === suffix) archived[id] = true;
  }
  return archived;
}
export function matchesInstallation(filter: InstallationFilter, archived: boolean): boolean {
  return filter === 'all' || (filter === 'archived' ? archived : !archived);
}
