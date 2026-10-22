export interface CropRect { x: number; y: number; width: number; height: number }
export interface CoverCrop extends CropRect { path: string }
export interface CoverPreferences { customPath: string | null; censored: boolean; crop: CoverCrop | null }
export const COVER_SETTING_PREFIX = 'game_cover:';
export const DEFAULT_COVER: Readonly<CoverPreferences> = { customPath: null, censored: false, crop: null };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function normalizeCoverCrop(value: unknown): CoverCrop | null {
  if (!value || typeof value !== 'object') return null;
  const crop = value as Record<string, unknown>;
  if (typeof crop.path !== 'string' || !crop.path.trim()) return null;
  if (![crop.x, crop.y, crop.width, crop.height].every(n => typeof n === 'number' && Number.isFinite(n))) return null;
  if ((crop.width as number) <= 0 || (crop.height as number) <= 0) return null;
  const width = Math.min(crop.width as number, 1);
  const height = Math.min(crop.height as number, 1);
  return { path: crop.path, x: clamp(crop.x as number, 0, 1 - width), y: clamp(crop.y as number, 0, 1 - height), width, height };
}

export function parseCoverPreferences(value: string | null): CoverPreferences {
  try {
    const parsed: unknown = JSON.parse(value ?? 'null');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...DEFAULT_COVER };
    const data = parsed as Record<string, unknown>;
    return {
      customPath: typeof data.customPath === 'string' && data.customPath.trim() ? data.customPath.trim() : null,
      censored: data.censored === true,
      crop: normalizeCoverCrop(data.crop),
    };
  } catch { return { ...DEFAULT_COVER }; }
}
export function effectiveCoverPath(path: string | null, preferences: CoverPreferences): string | null {
  return preferences.customPath ?? path;
}

export function effectiveCoverCrop(path: string | null, preferences: CoverPreferences): CoverCrop | null {
  return preferences.crop?.path === effectiveCoverPath(path, preferences) ? preferences.crop : null;
}

export function mergeCoverPreferences(current: CoverPreferences, patch: Partial<CoverPreferences>): CoverPreferences {
  const next = { ...current, ...patch };
  if (patch.customPath !== undefined && patch.customPath !== current.customPath) next.crop = null;
  return { ...next, crop: normalizeCoverCrop(next.crop) };
}

/** The ratio is in real image pixels, not normalized coordinates. */
export function cropFromDrag(start: { x: number; y: number }, end: { x: number; y: number }, size: { width: number; height: number }): CropRect {
  const ratio = 0.75 * size.height / size.width;
  const sx = clamp(start.x, 0, 1), sy = clamp(start.y, 0, 1);
  const dx = end.x >= sx ? 1 : -1, dy = end.y >= sy ? 1 : -1;
  const width = Math.min(Math.max(Math.abs(end.x - sx), Math.abs(end.y - sy) * ratio),
    dx > 0 ? 1 - sx : sx, (dy > 0 ? 1 - sy : sy) * ratio);
  const height = width / ratio;
  return { x: dx > 0 ? sx : sx - width, y: dy > 0 ? sy : sy - height, width, height };
}

export function centeredCoverCrop(size: { width: number; height: number }): CropRect {
  const ratio = 0.75 * size.height / size.width;
  const width = Math.min(1, ratio), height = width / ratio;
  return { x: (1 - width) / 2, y: (1 - height) / 2, width, height };
}

export function moveCoverCrop(crop: CropRect, dx: number, dy: number): CropRect {
  return { ...crop, x: clamp(crop.x + dx, 0, 1 - crop.width), y: clamp(crop.y + dy, 0, 1 - crop.height) };
}
