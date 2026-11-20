import type { Friend, FriendProfile, ProfileFilters, SharedLibraryGame } from '@/features/friends/types';
import type { Game } from '@/types/game';

type RecommendingFriend = Pick<Friend, 'id' | 'nickname'>;
type Work = Pick<Game, 'title' | 'originalTitle' | 'developer' | 'vndbId' | 'bangumiId'>;
interface PublicFriendLibrary { friend: RecommendingFriend; games: SharedLibraryGame[] }
interface FriendPick { game: Game; friend: RecommendingFriend; rating: number }

export function isUnstarted(game: Game): boolean {
  return (game.status === 'unplayed' || game.status === 'wishlist') && game.playTimeSeconds === 0 && !game.lastPlayedAt;
}

const idFields = ['vndbId', 'bangumiId'] as const;
const identity = (value: string | null) => value?.normalize('NFKC').trim().toLowerCase() || '';

function idKeys(work: Work): string[] {
  return idFields.flatMap(field => identity(work[field]) ? [`${field}:${identity(work[field])}`] : []);
}

function titleKeys(work: Work): string[] {
  const developer = identity(work.developer);
  const titles = new Set([identity(work.title), identity(work.originalTitle)]);
  return developer ? [...titles].filter(Boolean).map(title => JSON.stringify([developer, title])) : [];
}

export function friendPicks(games: readonly Game[], libraries: readonly PublicFriendLibrary[]): FriendPick[] {
  const byKey = new Map<string, Game[]>();
  for (const game of games) {
    for (const key of [...idKeys(game), ...titleKeys(game)]) {
      const matches = byKey.get(key);
      if (matches) matches.push(game);
      else byKey.set(key, [game]);
    }
  }
  const findGames = (keys: string[]) => new Set(keys.flatMap(key => byKey.get(key) ?? []));
  const picks = new Map<number, FriendPick>();
  for (const { friend, games: shared } of libraries) {
    for (const work of shared) {
      const rating = work.rating;
      if (rating === null || !Number.isFinite(rating) || rating < 8 || rating > 10) continue;
      const byId = findGames(idKeys(work));
      const candidates = byId.size ? byId : findGames(titleKeys(work));
      const [game] = candidates;
      if (candidates.size !== 1 || !isUnstarted(game)) continue;
      if (idFields.some(field => work[field] && game[field] && identity(work[field]) !== identity(game[field]))) continue;
      const previous = picks.get(game.id);
      if (!previous || rating > previous.rating) picks.set(game.id, { game, friend, rating });
    }
  }
  return [...picks.values()].sort((a, b) => b.rating - a.rating || a.game.title.localeCompare(b.game.title, 'zh-CN') || a.game.id - b.game.id);
}

export async function readPublicFriendLibraries(
  targets: readonly string[],
  load: (filters: ProfileFilters) => Promise<FriendProfile>,
  takeRequest: () => boolean,
  cancelled: () => boolean,
): Promise<PublicFriendLibrary[]> {
  const libraries = new Map<string, PublicFriendLibrary>();
  const pages = targets.map(target => ({ target, offset: 0 }));
  for (const { target, offset } of pages) {
    if (cancelled() || !takeRequest()) break;
    let page: FriendProfile;
    try {
      page = await load({ target, query: '', status: null, offset });
    } catch (cause) {
      if (!String(cause).includes('FRIENDS_UNAVAILABLE')) break;
      libraries.delete(target);
      continue;
    }
    if (cancelled()) break;
    if (page.self || page.profile?.id !== target || !page.libraryShared || !page.viewerLibraryShared) {
      libraries.delete(target);
      continue;
    }
    const library = libraries.get(target) ?? { friend: page.profile, games: [] };
    library.games.push(...page.games);
    libraries.set(target, library);
    const next = offset + page.pageSize;
    if (page.games.length && next > offset && next < page.total && next <= 10_000) pages.push({ target, offset: next });
  }
  return cancelled() ? [] : [...libraries.values()];
}
