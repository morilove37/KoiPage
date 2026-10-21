import { create } from "zustand";
import type { GameProcessState } from "@/features/launch/process-state";

/**
 * Global UI/session state.
 *
 * Deliberately small: game and tag data is fetched per-page from the Rust
 * commands. This store only holds state that must survive navigation.
 */

import { readLibraryPreferences, writeLibraryPreferences, normalizeFilters, savePreset } from "@/features/library/preferences";
import type { ViewMode, SortKey, SortDirection, LibraryPreferences, LibraryFilters } from "@/features/library/preferences";
export type { ViewMode, SortKey, SortDirection } from "@/features/library/preferences";

interface AppState {
  /** Library display preferences (not persisted to SQLite). */
  library: LibraryPreferences;
  setLibraryFilters: (filters: LibraryFilters) => void;
  saveLibraryPreset: (name: string) => void;
  deleteLibraryPreset: (name: string) => void;
  setViewMode: (viewMode: ViewMode) => void;
  setSort: (sortKey: SortKey, sortDirection?: SortDirection) => void;

  /**
   * Ids of games with a launch in flight, so buttons can show a spinner and be
   * disabled without every page keeping its own registry.
   */
  launching: Record<number, boolean>;
  /** Backend-confirmed process state shared by pages and the launch panel. */
  gameProcesses: Record<number, GameProcessState>;
  setGameProcess: (gameId: number, value: GameProcessState) => void;

  /**
   * Bumped whenever play sessions change (a game exits), so pages can refetch
   * without polling. Read it in a `useEffect` dependency array.
   */
  playTimeRevision: number;
  bumpPlayTimeRevision: () => void;
}

export const useAppStore = create<AppState>((set) => ({
  library: readLibraryPreferences(),
  setLibraryFilters: (filters) => set(state => persistLibrary({ ...state.library, filters: normalizeFilters(filters) })),
  saveLibraryPreset: (name) => set(state => persistLibrary(savePreset(state.library, name))),
  deleteLibraryPreset: (name) => set(state => persistLibrary({ ...state.library, presets: state.library.presets.filter(p => p.name !== name) })),
  setViewMode: (viewMode) => set(state => persistLibrary({ ...state.library, viewMode })),
  setSort: (sortKey, sortDirection) => set(state => persistLibrary({ ...state.library, sortKey,
    sortDirection: sortDirection ?? (state.library.sortKey === sortKey ? state.library.sortDirection === "asc" ? "desc" : "asc" : sortKey === "createdAt" ? "desc" : "asc") })),

  launching: {},
  gameProcesses: {},
  setGameProcess: (gameId, value) =>
    set((state) => {
      const launching = { ...state.launching };
      if (value.status === "starting") launching[gameId] = true;
      else delete launching[gameId];
      return { launching, gameProcesses: { ...state.gameProcesses, [gameId]: value } };
    }),

  playTimeRevision: 0,
  bumpPlayTimeRevision: () =>
    set((state) => ({ playTimeRevision: state.playTimeRevision + 1 })),
}));

function persistLibrary(library: LibraryPreferences): { library: LibraryPreferences } {
 writeLibraryPreferences(library);
 return { library };
}
