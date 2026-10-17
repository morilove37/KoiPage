import { create } from "zustand";
import { BRAND } from "@/lib/brand";
import { settingsGet, settingsSet } from "@/lib/db";
import { parsePreferences, planStartup, setDismissed } from "./model";
import type { AnnouncementKind, AnnouncementPreferences } from "./model";

export const ANNOUNCEMENTS_SETTING = "announcements_preferences_v1";

interface AnnouncementState {
  preferences: AnnouncementPreferences | null;
  queue: AnnouncementKind[];
  manual: AnnouncementKind | null;
  revision: number;
  loading: boolean;
  saving: boolean;
  error: string | null;
}

export const useAnnouncementStore = create<AnnouncementState>(() => ({
  preferences: null, queue: [], manual: null, revision: 0,
  loading: true, saving: false, error: null,
}));
let initialization: Promise<void> | null = null;

/** One startup per process, including React StrictMode's effect replay. */
export function initializeAnnouncements(): Promise<void> {
  if (useAnnouncementStore.getState().preferences) return Promise.resolve();
  if (!initialization) {
    useAnnouncementStore.setState({ loading: true, error: null });
    initialization = (async () => {
      try {
        const stored = await settingsGet(ANNOUNCEMENTS_SETTING);
        const plan = planStartup(parsePreferences(stored), BRAND.version);
        const serialized = JSON.stringify(plan.preferences);
        if (serialized !== stored) await settingsSet(ANNOUNCEMENTS_SETTING, serialized);
        useAnnouncementStore.setState({ ...plan, loading: false });
      } catch (cause) {
        useAnnouncementStore.setState({ loading: false, error: `公告设置读取失败：${String(cause instanceof Error ? cause.message : cause)}` });
      }
    })().finally(() => { initialization = null; });
  }
  return initialization;
}

export function openAnnouncement(kind: AnnouncementKind): void {
  if (!useAnnouncementStore.getState().preferences || useAnnouncementStore.getState().saving) return;
  useAnnouncementStore.setState(state => ({ manual: kind, revision: state.revision + 1, error: null }));
}

export async function closeAnnouncement(dismissed: boolean): Promise<void> {
  const state = useAnnouncementStore.getState();
  const kind = state.manual ?? state.queue[0];
  if (!kind || !state.preferences || state.saving) return;
  useAnnouncementStore.setState({ saving: true, error: null });
  try {
    const preferences = setDismissed(state.preferences, kind, BRAND.version, dismissed);
    if (JSON.stringify(preferences) !== JSON.stringify(state.preferences)) {
      await settingsSet(ANNOUNCEMENTS_SETTING, JSON.stringify(preferences));
    }
    useAnnouncementStore.setState(current => ({
      preferences, manual: null, queue: current.queue.filter(item => item !== kind),
      saving: false, revision: current.revision + 1,
    }));
  } catch (cause) {
    useAnnouncementStore.setState({ saving: false, error: `公告设置保存失败，请重试：${String(cause instanceof Error ? cause.message : cause)}` });
  }
}
