export interface CoverPreferences { customPath: string | null; censored: boolean }
export const COVER_SETTING_PREFIX = 'game_cover:';
export const DEFAULT_COVER: Readonly<CoverPreferences> = { customPath: null, censored: false };

export function parseCoverPreferences(value: string | null): CoverPreferences {
  try {
    const parsed: unknown = JSON.parse(value ?? 'null');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...DEFAULT_COVER };
    const data = parsed as Record<string, unknown>;
    return {
      customPath: typeof data.customPath === 'string' && data.customPath.trim() ? data.customPath.trim() : null,
      censored: data.censored === true,
    };
  } catch { return { ...DEFAULT_COVER }; }
}
export function effectiveCoverPath(path: string | null, preferences: CoverPreferences): string | null {
  return preferences.customPath ?? path;
}
