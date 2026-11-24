import { settingsGet, settingsSet } from './db';
import {
  ACCENT_SETTING_KEY,
  DEFAULT_ACCENT,
  accentTokens,
  parseAccentSettings,
  type AccentSettings,
} from './accent-model';
import { snapshotValue } from './settings-snapshot';
import type { SettingsSnapshot } from './settings-snapshot';

let currentAccent: AccentSettings = { ...DEFAULT_ACCENT };
let pendingWrite: Promise<void> = Promise.resolve();

/** Re-applied after a theme change so accent text/focus stay readable. */
export function applyAccent(settings: AccentSettings = currentAccent): void {
  currentAccent = parseAccentSettings(JSON.stringify(settings));
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const mode = root.classList.contains('glass') ? 'glass' : root.classList.contains('dark') ? 'dark' : 'light';
  const tokens = accentTokens(currentAccent, mode);
  const defaultPurple = currentAccent.preset === 'purple';
  root.toggleAttribute('data-custom-accent', !defaultPurple);
  // The default uses the original per-theme purple tokens, including glass.
  for (const [name, value] of [['--primary', tokens.primary], ['--primary-foreground', tokens.foreground], ['--ring', tokens.text]]) {
    if (defaultPurple) root.style.removeProperty(name);
    else root.style.setProperty(name, value);
  }
  root.style.setProperty('--primary-text', tokens.text);
}

/** `snapshot` is the startup settings read; omit it to read the key directly. */
export async function loadAccent(snapshot?: SettingsSnapshot): Promise<AccentSettings> {
  try {
    const stored = snapshot ? snapshotValue(snapshot, ACCENT_SETTING_KEY) : await settingsGet(ACCENT_SETTING_KEY);
    return parseAccentSettings(stored ?? null);
  } catch {
    return { ...DEFAULT_ACCENT };
  }
}

/** Apply synchronously; serialize writes so rapid picker changes cannot race. */
export function setAccent(settings: AccentSettings): Promise<void> {
  const normalized = parseAccentSettings(JSON.stringify(settings));
  applyAccent(normalized);
  const serialized = JSON.stringify(normalized);
  const write = pendingWrite.catch(() => {}).then(() => settingsSet(ACCENT_SETTING_KEY, serialized));
  pendingWrite = write;
  return write;
}

export async function initAccent(snapshot?: SettingsSnapshot): Promise<void> {
  applyAccent(await loadAccent(snapshot));
}
