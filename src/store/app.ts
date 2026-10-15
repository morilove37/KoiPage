import { create } from "zustand";

/**
 * Global UI/session state.
 *
 * Deliberately small: game and tag data is fetched per-page from the Rust
 * commands. This store only holds state that must survive navigation.
 */

/** Where the user last left the library view. */
export type ViewMode = "grid" | "list";

export type SortKey =
  | "title"
  | "releaseDate"
  | "rating"
  | "lastPlayedAt"
  | "playTime";

export type SortDirection = "asc" | "desc";

interface LibraryPreferences {
  viewMode: ViewMode;
  sortKey: SortKey;
  sortDirection: SortDirection;
}

interface AppState {
  /** Library display preferences (not persisted to SQLite). */
  library: LibraryPreferences;
  setViewMode: (viewMode: ViewMode) => void;
  setSort: (sortKey: SortKey, sortDirection?: SortDirection) => void;

  /**
   * Ids of games with a launch in flight, so buttons can show a spinner and be
   * disabled without every page keeping its own registry.
   */
  launching: Record<number, boolean>;
  setLaunching: (gameId: number, value: boolean) => void;

  /**
   * Bumped whenever play sessions change (a game exits), so pages can refetch
   * without polling. Read it in a `useEffect` dependency array.
   */
  playTimeRevision: number;
  bumpPlayTimeRevision: () => void;
}

export const useAppStore = create<AppState>((set) => ({
  library: {
    viewMode: "grid",
    sortKey: "title",
    sortDirection: "asc",
  },

  setViewMode: (viewMode) =>
    set((state) => ({ library: { ...state.library, viewMode } })),

  setSort: (sortKey, sortDirection) =>
    set((state) => ({
      library: {
        ...state.library,
        sortKey,
        // Flip direction when re-selecting the active column, like a table header.
        sortDirection:
          sortDirection ??
          (state.library.sortKey === sortKey
            ? state.library.sortDirection === "asc"
              ? "desc"
              : "asc"
            : "asc"),
      },
    })),

  launching: {},
  setLaunching: (gameId, value) =>
    set((state) => {
      const launching = { ...state.launching };
      if (value) launching[gameId] = true;
      else delete launching[gameId];
      return { launching };
    }),

  playTimeRevision: 0,
  bumpPlayTimeRevision: () =>
    set((state) => ({ playTimeRevision: state.playTimeRevision + 1 })),
}));
