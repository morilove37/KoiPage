export type AnnouncementKind = "welcome" | "version";

export interface AnnouncementPreferences {
  welcomeDismissed: boolean;
  lastVersion: string | null;
  updateNoticeVersion: string | null;
  dismissedUpdateVersion: string | null;
}

export function parsePreferences(value: string | null): AnnouncementPreferences {
  let parsed: Partial<AnnouncementPreferences> = {};
  try {
    const candidate: unknown = value ? JSON.parse(value) : null;
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) parsed = candidate;
  } catch { /* A damaged preference must not prevent application startup. */ }
  const version = (value: unknown) => typeof value === "string" && value.trim() ? value : null;
  return {
    welcomeDismissed: parsed.welcomeDismissed === true,
    lastVersion: version(parsed.lastVersion),
    updateNoticeVersion: version(parsed.updateNoticeVersion),
    dismissedUpdateVersion: version(parsed.dismissedUpdateVersion),
  };
}

export function planStartup(previous: AnnouncementPreferences, version: string) {
  const preferences: AnnouncementPreferences = {
    ...previous,
    lastVersion: version,
    updateNoticeVersion: previous.lastVersion && previous.lastVersion !== version
      ? version : previous.updateNoticeVersion,
  };
  const queue: AnnouncementKind[] = [];
  if (!preferences.welcomeDismissed) queue.push("welcome");
  if (preferences.updateNoticeVersion === version && preferences.dismissedUpdateVersion !== version) queue.push("version");
  return { preferences, queue };
}

export function setDismissed(previous: AnnouncementPreferences, kind: AnnouncementKind, version: string, dismissed: boolean): AnnouncementPreferences {
  return kind === "welcome"
    ? { ...previous, welcomeDismissed: dismissed }
    : { ...previous, dismissedUpdateVersion: dismissed ? version : null };
}
