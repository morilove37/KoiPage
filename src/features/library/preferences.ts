export type ViewMode = 'grid' | 'list';
export type SortKey = 'title' | 'developer' | 'releaseDate' | 'rating' | 'lastPlayedAt' | 'playTime' | 'createdAt';
export type SortDirection = 'asc' | 'desc';
export type InstallationFilter = 'all' | 'installed' | 'archived';
/** `status` / `developer` are multi-select: an empty array means "all". */
export interface LibraryFilters { installation: InstallationFilter; search: string; status: string[]; favoriteOnly: boolean; activeTagIds: number[]; developer: string[] }
export interface FilterPreset { name: string; filters: LibraryFilters }
export interface LibraryPreferences { viewMode: ViewMode; sortKey: SortKey; sortDirection: SortDirection; filters: LibraryFilters; presets: FilterPreset[] }
const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const text = (v: unknown) => typeof v === 'string' ? v.slice(0, 500) : '';
const STATUS_VALUES = ['unplayed','wishlist','playing','completed','on_hold','dropped'];
/**
 * Read a multi-select filter, migrating the v1 single-string shape to `[value]`.
 *
 * Stored data predates multi-select, so a bare string is a valid legacy value
 * and must keep filtering instead of silently resetting to "all". Arrays are
 * cleaned item by item (invalid statuses dropped, blanks dropped) and deduped
 * because a repeated value would make the count in the trigger lie.
 */
function list(value: unknown, valid: (item: string) => boolean): string[] {
 const items = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
 return [...new Set(items.filter((item): item is string => typeof item === 'string').map(text).filter(item => item !== '' && valid(item)))].slice(0, 500);
}
export function normalizeFilters(value: unknown): LibraryFilters {
 const v = object(value);
 return { installation: v.installation === 'installed' || v.installation === 'archived' ? v.installation : 'all', search: text(v.search), status: list(v.status, item => STATUS_VALUES.includes(item)), favoriteOnly: v.favoriteOnly === true, developer: list(v.developer, () => true), activeTagIds: Array.isArray(v.activeTagIds) ? [...new Set(v.activeTagIds.filter((id): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id > 0))].slice(0,500) : [] };
}
export function parseLibraryPreferences(raw: string | null): LibraryPreferences {
 let value: unknown; try { value = raw ? JSON.parse(raw) : {}; } catch { value = {}; }
 const v = object(value);
 const presets: FilterPreset[] = [];
 if (Array.isArray(v.presets)) for (const item of v.presets.slice(0,30)) {
  const p = object(item); const name = text(p.name).trim().slice(0,40);
  if (name && !presets.some(p => p.name === name)) presets.push({ name, filters: normalizeFilters(p.filters) });
 }
 return { viewMode: v.viewMode === 'list' ? 'list' : 'grid', sortKey: ['title','developer','releaseDate','rating','lastPlayedAt','playTime','createdAt'].includes(String(v.sortKey)) ? v.sortKey as SortKey : 'title', sortDirection: v.sortDirection === 'desc' ? 'desc' : 'asc', filters: normalizeFilters(v.filters), presets };
}
export function savePreset(p: LibraryPreferences, value: string): LibraryPreferences {
 const name = value.trim().slice(0,40); if (!name) return p;
 const preset = { name, filters: normalizeFilters(p.filters) };
 return { ...p, presets: [...p.presets.filter(item => item.name !== name), preset].slice(-30) };
}
export function visibleSelection(selected: ReadonlySet<number>, visible: ReadonlyArray<{id: number}>): number[] { return visible.filter(game => selected.has(game.id)).map(game => game.id); }
export const LIBRARY_PREFERENCES_KEY = 'galgame.library.preferences.v1';
export function readLibraryPreferences(): LibraryPreferences {
 try { return parseLibraryPreferences(localStorage.getItem(LIBRARY_PREFERENCES_KEY)); } catch { return parseLibraryPreferences(null); }
}
export function writeLibraryPreferences(value: LibraryPreferences): void {
 try { localStorage.setItem(LIBRARY_PREFERENCES_KEY, JSON.stringify(value)); } catch { /* Storage may be disabled or full; keep in-memory preferences. */ }
}
