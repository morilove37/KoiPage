import { create } from 'zustand';
import { settingsGet, settingsSet } from '@/lib/db';
import { parseBirthdayReminderPreferences, planBirthdayCelebration } from './model';
import type { BirthdayReminderPreferences } from './model';
import type { BirthdayCharacter } from './types';

export const BIRTHDAY_REMINDER_SETTING = 'birthday_reminder_preferences_v1';
interface BirthdayReminderState {
  preferences: BirthdayReminderPreferences | null;
  activeDate: string | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
}
export const useBirthdayReminderStore = create<BirthdayReminderState>(() => ({
  preferences: null, activeDate: null, loading: true, saving: false, error: null,
}));
let initialization: Promise<void> | null = null;
let writeQueue: Promise<void> = Promise.resolve();
let pendingWrites = 0;
let writeRevision = 0;
let pendingCelebrationDate: string | null = null;
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

export function initializeBirthdayReminder(): Promise<void> {
  if (useBirthdayReminderStore.getState().preferences) return Promise.resolve();
  if (!initialization) {
    useBirthdayReminderStore.setState({ loading: true, error: null });
    initialization = (async () => {
      try {
        const stored = await settingsGet(BIRTHDAY_REMINDER_SETTING);
        useBirthdayReminderStore.setState({ preferences: parseBirthdayReminderPreferences(stored), loading: false });
      } catch (cause) {
        // Do not assume the user enabled reminders when their setting is unreadable.
        useBirthdayReminderStore.setState({ loading: false, error: `生日提醒设置读取失败：${message(cause)}` });
      }
    })().finally(() => { initialization = null; });
  }
  return initialization;
}

async function persist(preferences: BirthdayReminderPreferences): Promise<void> {
  const revision = ++writeRevision;
  pendingWrites++;
  useBirthdayReminderStore.setState({ saving: true, error: null });
  const write = writeQueue.then(() => settingsSet(BIRTHDAY_REMINDER_SETTING, JSON.stringify(preferences)));
  writeQueue = write.catch(() => {});
  try {
    await write;
    if (revision === writeRevision) useBirthdayReminderStore.setState({ error: null });
    const latest = useBirthdayReminderStore.getState().preferences;
    if (pendingCelebrationDate && preferences.enabled && preferences.lastShownDate === pendingCelebrationDate
      && latest?.enabled && latest.lastShownDate === pendingCelebrationDate) {
      const activeDate = pendingCelebrationDate;
      pendingCelebrationDate = null;
      useBirthdayReminderStore.setState({ activeDate });
    }
  } catch (cause) {
    if (revision === writeRevision) useBirthdayReminderStore.setState({ error: `生日提醒设置保存失败：${message(cause)}` });
    throw cause;
  } finally {
    pendingWrites--;
    useBirthdayReminderStore.setState({ saving: pendingWrites > 0 });
  }
}

/** Claim synchronously so StrictMode, refreshes and focus events cannot repeat a day. */
export function showBirthdayCelebration(characters: BirthdayCharacter[], now = new Date()): boolean {
  const state = useBirthdayReminderStore.getState();
  if (!state.preferences) return false;
  const plan = planBirthdayCelebration(state.preferences, characters, now);
  if (!plan) return false;
  const preferences = { ...state.preferences, lastShownDate: plan.date };
  pendingCelebrationDate = plan.date;
  useBirthdayReminderStore.setState({ preferences });
  // Commit before presentation: even an immediate exit after seeing the greeting
  // must retain today's record. The synchronous claim still prevents duplicates.
  void persist(preferences).catch(() => {});
  return true;
}

export function dismissBirthdayCelebration(): void {
  pendingCelebrationDate = null;
  useBirthdayReminderStore.setState({ activeDate: null });
}

export async function setBirthdayReminderEnabled(enabled: boolean): Promise<void> {
  await initializeBirthdayReminder();
  const state = useBirthdayReminderStore.getState();
  if (!state.preferences) return;
  const preferences = { ...state.preferences, enabled };
  if (!enabled) pendingCelebrationDate = null;
  useBirthdayReminderStore.setState({ preferences, ...(!enabled ? { activeDate: null } : {}) });
  await persist(preferences);
}

export async function retryBirthdayReminderSave(): Promise<void> {
  const preferences = useBirthdayReminderStore.getState().preferences;
  if (preferences) await persist(preferences);
  else await initializeBirthdayReminder();
}
