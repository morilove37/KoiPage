import { useCallback } from "react";
import { create } from "zustand";
import { settingsGet, settingsSet } from "@/lib/db";
import dictionary from "./tag-translations.json";

export const LOCALIZATION_SETTING = "metadata_localization_enabled";
export const OFFLINE_TAG_COUNT = Object.keys(dictionary).length;

interface LocalizationState {
  loaded: boolean;
  enabled: boolean;
}

export const useLocalizationStore = create<LocalizationState>(() => ({
  loaded: false,
  enabled: false,
}));

let loadingPreference: Promise<void> | null = null;
let preferenceRevision = 0;

export function loadLocalizationPreference(): Promise<void> {
  if (!loadingPreference) {
    const revision = preferenceRevision;
    loadingPreference = settingsGet(LOCALIZATION_SETTING).then(value => {
      if (revision === preferenceRevision) {
        useLocalizationStore.setState({ loaded: true, enabled: value === "1" });
      }
    }).finally(() => { loadingPreference = null; });
  }
  return loadingPreference;
}

export async function setLocalizationEnabled(enabled: boolean): Promise<void> {
  await settingsSet(LOCALIZATION_SETTING, enabled ? "1" : "0");
  preferenceRevision++;
  useLocalizationStore.setState({ loaded: true, enabled });
}

/** Exact catalogue lookup after harmless spelling normalization; never guess. */
export function localizeTagName(original: string): string {
  const key = original.normalize("NFKC").trim().toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[‐‑‒–—]/g, "-")
    .replace(/\s+/g, " ");
  return Object.prototype.hasOwnProperty.call(dictionary, key)
    ? (dictionary as Record<string, string>)[key]
    : original;
}

/** Tags only: no network, cache, source writes or description translation. */
export function useLocalizedTags() {
  const enabled = useLocalizationStore(state => state.loaded && state.enabled);
  const t = useCallback((original: string) => enabled ? localizeTagName(original) : original, [enabled]);
  return { t, enabled };
}
