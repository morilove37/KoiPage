/**
 * A tiny broadcast that says "the game rows changed".
 *
 * `src/features/library/data-store.ts` caches `games_list` / `tags_list` /
 * `games_tags_get` / `games_stats` so that 首页, 游戏库 and 游戏文件夹 do not
 * re-read them on every navigation. That cache has to know when a write
 * happened somewhere else — 标签页 renaming a tag, 详情页 changing a status,
 * 元数据对话框 applying a batch — otherwise the cached rows go stale and only
 * a restart would fix them.
 *
 * This module is deliberately dependency-free (it must not import the database
 * layer, or the store that imports it), so `db.ts` can notify after its own
 * writes without creating an import cycle.
 */

type Listener = () => void;

const listeners = new Set<Listener>();

/** Subscribe to game-row changes. Returns the unsubscribe function. */
export function onLibraryDataChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Tell the library cache that rows it may be holding are out of date. */
export function notifyLibraryDataChanged(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (cause) {
      // A broken subscriber must not break the write that triggered it.
      console.warn('[library] data change listener failed:', cause);
    }
  }
}
