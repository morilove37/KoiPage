import type { Game } from "@/types/game";

export type ShareSort = "lastPlayedAt" | "playTimeSeconds" | "rating" | "title" | "releaseDate";
export type ShareDirection = "asc" | "desc";
export const SHARE_PAGE_SIZE = 60;
export const SHARE_SORTS: ReadonlyArray<{ value: ShareSort; label: string }> = [
  { value: "lastPlayedAt", label: "最近游玩" }, { value: "playTimeSeconds", label: "游玩时长" },
  { value: "rating", label: "评分" }, { value: "title", label: "游戏名称" }, { value: "releaseDate", label: "发售日" },
];

/** Manually marking a game as played also counts when no launch was tracked. */
export function hasPlayed(game: Game): boolean {
  return game.playTimeSeconds > 0 || Boolean(game.lastPlayedAt)
    || ["playing", "completed", "on_hold", "dropped"].includes(game.status);
}

export function shareGames(games: readonly Game[], hidden: ReadonlySet<number>, sort: ShareSort, direction: ShareDirection): Game[] {
  return games.filter(game => hasPlayed(game) && !hidden.has(game.id)).sort((a, b) => {
    const x = a[sort], y = b[sort];
    const emptyX = x === null || x === "", emptyY = y === null || y === "";
    if (emptyX !== emptyY) return emptyX ? 1 : -1;
    let comparison = 0;
    if (!emptyX && !emptyY) {
      comparison = typeof x === "number" && typeof y === "number" ? x - y
        : String(x).localeCompare(String(y), "zh-CN", { numeric: true });
    }
    return (direction === "asc" ? comparison : -comparison) || a.id - b.id;
  });
}

export function sharePages(games: readonly Game[]): Game[][] {
  const pages: Game[][] = [];
  for (let index = 0; index < games.length; index += SHARE_PAGE_SIZE) pages.push(games.slice(index, index + SHARE_PAGE_SIZE));
  return pages;
}
