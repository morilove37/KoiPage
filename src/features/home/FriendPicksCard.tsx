import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CoverImage } from '@/components/ui/cover-image';
import { GeometryIcon } from '@/components/ui/geometry-icon';
import { friendsProfile, friendsSnapshot } from '@/features/friends/api';
import { useFriendsStore } from '@/features/friends/store';
import { formatRating } from '@/lib/rating';
import type { Game } from '@/types/game';
import { friendPicks, isUnstarted, readPublicFriendLibraries } from './friend-picks';

let profileRequests: number[] = [];
function takeProfileRequest(): boolean {
  const now = Date.now();
  profileRequests = profileRequests.filter(time => now - time < 60_000);
  // Keep most of the profile endpoint's 120 requests per minute available for browsing.
  if (profileRequests.length >= 24) return false;
  profileRequests.push(now);
  return true;
}

export function FriendPicksCard({ games, refreshKey }: { games: readonly Game[]; refreshKey: number }) {
  const status = useFriendsStore(state => state.status);
  const epoch = useFriendsStore(state => state.epoch);
  if (!status?.account || !status.config.enabled || !status.config.shareLibrary || !games.some(isUnstarted)) return null;
  return <PublishedPicks key={`${status.account.id}:${epoch}:${refreshKey}`} accountId={status.account.id} games={games} />;
}

function PublishedPicks({ accountId, games }: { accountId: string; games: readonly Game[] }) {
  const [libraries, setLibraries] = useState<Awaited<ReturnType<typeof readPublicFriendLibraries>>>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const snapshot = await friendsSnapshot(null);
      if (cancelled || snapshot.unchanged || snapshot.me.id !== accountId) return;
      const targets = [...new Set(snapshot.friends.map(friend => friend.id))];
      const published = await readPublicFriendLibraries(targets, friendsProfile, takeProfileRequest, () => cancelled);
      if (!cancelled) setLibraries(published);
    })().catch(() => {});
    return () => { cancelled = true; };
  }, [accountId]);

  const picks = useMemo(() => friendPicks(games, libraries).slice(0, 4), [games, libraries]);
  if (!picks.length) return null;
  return <section aria-labelledby="home-friend-picks" className="overflow-hidden rounded-lg border border-border bg-card text-card-foreground">
    <h2 id="home-friend-picks" className="flex items-center gap-2 border-b border-border px-4 py-3 text-sm font-semibold">
      <GeometryIcon name="friends" className="text-primary" />好友同好
    </h2>
    <ul className="divide-y divide-border">
      {picks.map(({ game, friend, rating }) => <li key={game.id} className="flex min-w-0 items-center gap-3 px-4 py-3">
        <Link to={`/library/${game.id}`} aria-label={`查看 ${game.title}`} className="h-12 w-9 shrink-0 overflow-hidden rounded bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <CoverImage gameId={game.id} path={game.coverPath} alt="" fallbackText="" className="h-full w-full object-cover" />
        </Link>
        <div className="min-w-0 flex-1">
          <Link to={`/library/${game.id}`} title={game.title} className="block truncate rounded text-sm font-medium hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{game.title}</Link>
          <Link to={`/friends/${encodeURIComponent(friend.id)}`} className="mt-1 block truncate rounded text-xs text-muted-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{friend.nickname} 的评分</Link>
        </div>
        <span className="shrink-0 text-xs font-semibold tabular-nums text-primary">{formatRating(rating)} / 10</span>
      </li>)}
    </ul>
  </section>;
}
