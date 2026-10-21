import type { BirthdayCharacter } from './types';

export interface BirthdayOccurrence { days: number; date: string; observed: boolean }
export interface BirthdayEntry extends BirthdayOccurrence { character: BirthdayCharacter }
const leap = (year: number) => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
const pad = (value: number) => String(value).padStart(2, '0');

/** Calendar dates, rather than elapsed milliseconds, also survive DST changes. */
export function birthdayOccurrence(month: number | null, day: number | null, now = new Date()): BirthdayOccurrence | null {
  if (month === null || day === null || !Number.isInteger(month) || !Number.isInteger(day)
    || month < 1 || month > 12 || day < 1 || day > new Date(2000, month, 0).getDate()) return null;
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  for (const year of [now.getFullYear(), now.getFullYear() + 1]) {
    const observed = month === 2 && day === 29 && !leap(year);
    const m = observed ? 3 : month;
    const d = observed ? 1 : day;
    const target = Date.UTC(year, m - 1, d);
    if (target >= today) return { days: Math.round((target - today) / 86400000), date: `${year}-${pad(m)}-${pad(d)}`, observed };
  }
  return null;
}

export function buildBirthdayEntries(characters: BirthdayCharacter[], now = new Date(), withinDays = 30): BirthdayEntry[] {
  const entries = characters.filter(c => !c.hidden).flatMap(character => {
    const next = birthdayOccurrence(character.birthdayMonth, character.birthdayDay, now);
    return next && next.days <= withinDays ? [{ character, ...next }] : [];
  });
  const favorite = (c: BirthdayCharacter) => Number(c.games.some(g => g.favorite > 0));
  const playing = (c: BirthdayCharacter) => Number(c.games.some(g => g.status === 'playing'));
  return entries.sort((a, b) => a.days - b.days || favorite(b.character) - favorite(a.character)
    || playing(b.character) - playing(a.character) || a.character.name.localeCompare(b.character.name, 'zh-CN')
    || a.character.id.localeCompare(b.character.id));
}

export function birthdayLabel(entry: BirthdayOccurrence): string {
  return entry.days === 0 ? '今天生日' : entry.days === 1 ? '明天生日' : `还有 ${entry.days} 天`;
}

export function birthdayDate(character: BirthdayCharacter): string {
  return character.birthdayMonth && character.birthdayDay ? `${character.birthdayMonth} 月 ${character.birthdayDay} 日` : '生日未知';
}

export interface BirthdayReminderPreferences { enabled: boolean; lastShownDate: string | null }
export interface BirthdayCelebration { date: string; entries: BirthdayEntry[] }

export function localBirthdayDate(now = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function parseBirthdayReminderPreferences(raw: string | null): BirthdayReminderPreferences {
  const defaults = { enabled: true, lastShownDate: null };
  try {
    const value: unknown = raw ? JSON.parse(raw) : null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return defaults;
    const stored = value as Record<string, unknown>;
    let lastShownDate: string | null = null;
    if (typeof stored.lastShownDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(stored.lastShownDate)) {
      const parsed = new Date(`${stored.lastShownDate}T00:00:00Z`);
      if (Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === stored.lastShownDate) lastShownDate = stored.lastShownDate;
    }
    return { enabled: typeof stored.enabled === 'boolean' ? stored.enabled : true, lastShownDate };
  } catch { return defaults; }
}

export function planBirthdayCelebration(
  preferences: BirthdayReminderPreferences, characters: BirthdayCharacter[], now = new Date(),
): BirthdayCelebration | null {
  const date = localBirthdayDate(now);
  if (!preferences.enabled || preferences.lastShownDate === date) return null;
  const entries = buildBirthdayEntries(characters.filter(c => c.games.length > 0), now, 0);
  return entries.length > 0 ? { date, entries } : null;
}
