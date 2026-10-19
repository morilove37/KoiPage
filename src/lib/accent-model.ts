/** Persisted accent choice is independent from the light/dark/glass theme. */
export const ACCENT_PRESETS = [
  { id: 'purple', label: '紫色', hex: '#7C3AED' },
  { id: 'blue', label: '蓝色', hex: '#2563EB' },
  { id: 'cyan', label: '青色', hex: '#0891B2' },
  { id: 'green', label: '绿色', hex: '#16A34A' },
  { id: 'orange', label: '橙色', hex: '#EA580C' },
  { id: 'pink', label: '粉色', hex: '#DB2777' },
] as const;

export type AccentPreset = (typeof ACCENT_PRESETS)[number]['id'];
export interface AccentSettings {
  preset: AccentPreset | 'custom';
  customHex: string;
}
export const DEFAULT_ACCENT: AccentSettings = { preset: 'purple', customHex: '#7C3AED' };
export const ACCENT_SETTING_KEY = 'appearance_accent';

/** Only solid RGB colors are accepted; never pass arbitrary CSS to a token. */
export function normalizeAccentHex(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const hex = value.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(hex)) {
    return `#${hex.split('').map(char => char + char).join('').toUpperCase()}`;
  }
  return /^[0-9a-f]{6}$/i.test(hex) ? `#${hex.toUpperCase()}` : null;
}

export function parseAccentSettings(value: string | null): AccentSettings {
  try {
    const parsed: unknown = JSON.parse(value ?? 'null');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...DEFAULT_ACCENT };
    const { preset, customHex } = parsed as Record<string, unknown>;
    const normalized = normalizeAccentHex(customHex);
    if (preset === 'custom' && normalized) return { preset, customHex: normalized };
    if (ACCENT_PRESETS.some(option => option.id === preset)) {
      return { preset: preset as AccentPreset, customHex: normalized ?? DEFAULT_ACCENT.customHex };
    }
  } catch { /* Missing, damaged, or newer settings use the default accent. */ }
  return { ...DEFAULT_ACCENT };
}

export function accentColor(settings: AccentSettings): string {
  return settings.preset === 'custom'
    ? normalizeAccentHex(settings.customHex) ?? DEFAULT_ACCENT.customHex
    : ACCENT_PRESETS.find(option => option.id === settings.preset)?.hex ?? DEFAULT_ACCENT.customHex;
}

type RGB = [number, number, number];
function rgb(hex: string): RGB {
  return [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16)) as RGB;
}
function luminance(hex: string): number {
  const channels = rgb(hex).map(value => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}
function contrast(first: string, second: string): number {
  const a = luminance(first), b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
function readableAccent(hex: string, background: string, dark: boolean): string {
  if (contrast(hex, background) >= 4.5) return hex;
  const channels = rgb(hex);
  // Keep the chosen hue while moving toward the nearest readable tint/shade.
  for (let step = 1; step <= 100; step++) {
    const amount = step / 100;
    const adjusted = `#${channels.map(channel => Math.round(channel + ((dark ? 255 : 0) - channel) * amount).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
    if (contrast(adjusted, background) >= 4.5) return adjusted;
  }
  return dark ? '#FFFFFF' : '#000000';
}
function hsl(hex: string): string {
  const [r, g, b] = rgb(hex).map(channel => channel / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  const lightness = (max + min) / 2;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
  let hue = 0;
  if (delta) {
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue = (hue * 60 + 360) % 360;
  }
  return `${Number(hue.toFixed(2))} ${Number((saturation * 100).toFixed(2))}% ${Number((lightness * 100).toFixed(2))}%`;
}

export type AccentMode = 'light' | 'dark' | 'glass';
export function accentTokens(settings: AccentSettings, mode: AccentMode) {
  const hex = accentColor(settings);
  const background = mode === 'light' ? '#FFFFFF' : mode === 'glass' ? '#191427' : '#0A0A0B';
  const foregroundHex = contrast(hex, '#FFFFFF') >= contrast(hex, '#000000') ? '#FFFFFF' : '#000000';
  const textHex = readableAccent(hex, background, mode !== 'light');
  return { hex, foregroundHex, textHex, primary: hsl(hex), foreground: hsl(foregroundHex), text: hsl(textHex) };
}
