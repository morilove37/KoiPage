import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { CoverImage } from "@/components/ui/cover-image";
import { GeometryIcon } from "@/components/ui/geometry-icon";
import { playSessionsPage } from "@/lib/db";
import { cn } from "@/lib/utils";
import { formatPlayTime } from "@/types/game";
import type { Game, PlaySession } from "@/types/game";

const PREVIEW_COUNT = 3;
const PAGE_SIZE = 50;
const errorMessage = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const dateTime = (value: string) => new Date(value).toLocaleString("zh-CN", {
  year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
});
const duration = (seconds: number) => seconds < 60 ? `${Math.max(0, Math.floor(seconds))} 秒` : formatPlayTime(seconds);

interface SessionGroup {
  gameId: number;
  game: Game | undefined;
  sessions: PlaySession[];
}

/**
 * Fold consecutive sessions of the same game into one row.
 *
 * Sessions arrive newest-first, so "consecutive" means the same game played
 * back-to-back without another game in between — those belong in one timeline
 * instead of repeating the cover and title for every session.
 */
function groupSessions(sessions: PlaySession[], gamesById: Map<number, Game>): SessionGroup[] {
  const groups: SessionGroup[] = [];
  for (const session of sessions) {
    const last = groups[groups.length - 1];
    if (last && last.gameId === session.gameId) {
      last.sessions.push(session);
      continue;
    }
    groups.push({ gameId: session.gameId, game: gamesById.get(session.gameId), sessions: [session] });
  }
  return groups;
}

export function RecentPlayHistory({ games, refreshKey }: { games: Game[]; refreshKey: string }) {
  const [sessions, setSessions] = useState<PlaySession[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const revision = useRef(0);
  const morePending = useRef(false);
  const headerButton = useRef<HTMLButtonElement>(null);
  const gamesById = useMemo(() => new Map(games.map(game => [game.id, game])), [games]);
  const groups = useMemo(() => groupSessions(sessions, gamesById), [sessions, gamesById]);

  useEffect(() => {
    const request = ++revision.current;
    morePending.current = false;
    setLoading(true);
    setLoadingMore(false);
    setError(null);
    setMoreError(null);
    void playSessionsPage(PAGE_SIZE + 1).then(page => {
      if (request !== revision.current) return;
      setSessions(page.slice(0, PAGE_SIZE));
      setHasMore(page.length > PAGE_SIZE);
    }).catch(cause => {
      if (request === revision.current) setError(errorMessage(cause));
    }).finally(() => { if (request === revision.current) setLoading(false); });
    return () => { revision.current++; };
  }, [refreshKey, attempt]);

  const loadMore = async () => {
    const cursor = sessions[sessions.length - 1];
    if (!cursor || !hasMore || loading || morePending.current) return;
    const request = revision.current;
    morePending.current = true;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await playSessionsPage(PAGE_SIZE + 1, cursor);
      if (request !== revision.current) return;
      setSessions(previous => {
        const ids = new Set(previous.map(session => session.id));
        return [...previous, ...page.slice(0, PAGE_SIZE).filter(session => !ids.has(session.id))];
      });
      setHasMore(page.length > PAGE_SIZE);
    } catch (cause) {
      if (request === revision.current) setMoreError(errorMessage(cause));
    } finally {
      if (request === revision.current) { morePending.current = false; setLoadingMore(false); }
    }
  };

  /** One entry of the vertical timeline: 开始时间 → 结束时间 / 时长. */
  const timelineEntry = (session: PlaySession) => <li key={session.id} data-session-id={session.id} className="flex min-w-0 items-start gap-2">
    <span aria-hidden="true" className="mt-[5px] size-1.5 shrink-0 rounded-full bg-primary/60" />
    <p className="min-w-0 flex-1 break-words text-[11px] leading-relaxed text-muted-foreground">
      <time dateTime={session.startedAt}>{dateTime(session.startedAt)}</time>
      {session.endedAt ? <> → <time dateTime={session.endedAt}>{dateTime(session.endedAt)}</time></> : " · 记录未结束"}
    </p>
    <p className="shrink-0 text-[11px] font-medium tabular-nums">{session.endedAt ? duration(session.durationSeconds) : "未结束"}</p>
  </li>;

  const row = (group: SessionGroup) => {
    const { game, gameId } = group;
    const title = game?.title ?? "已移除的作品";
    const groupKey = `${gameId}-${group.sessions[0].id}`;
    const timelineId = `home-history-timeline-${groupKey}`;
    const timelineExpanded = expandedGroups.has(groupKey);
    const totalSeconds = group.sessions.reduce((total, session) => total + session.durationSeconds, 0);
    const header = <>
      <div className="h-12 w-9 shrink-0 overflow-hidden rounded bg-muted"><CoverImage gameId={game?.id} path={game?.coverPath ?? null} alt={title} className="h-full w-full object-cover" fallbackText="" /></div>
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-sm font-medium">{title}</h3>
        <p className="mt-1 text-[11px] text-muted-foreground">{group.sessions.length > 1 ? `连续游玩 ${group.sessions.length} 次` : "游玩 1 次"} · 合计 {duration(totalSeconds)}</p>
      </div>
      <p className="shrink-0 text-[11px] text-muted-foreground">{game ? "查看历史 ↗" : "作品已移除"}</p>
    </>;
    return <li key={groupKey} data-game-id={gameId} className="px-4 py-3">
      {game
        ? <Link to={`/library/${game.id}?tab=history`} className="flex min-w-0 items-center gap-3 rounded-md transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">{header}</Link>
        : <div className="flex min-w-0 items-center gap-3">{header}</div>}
      <div className="ml-12 mt-1 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <p className="text-[11px] text-muted-foreground">最近 <time dateTime={group.sessions[0].startedAt}>{dateTime(group.sessions[0].startedAt)}</time></p>
        <button type="button" aria-expanded={timelineExpanded} aria-controls={timelineId}
          aria-label={`${timelineExpanded ? "收起" : "展开"}${title}的游玩明细`}
          onClick={() => setExpandedGroups(previous => {
            const next = new Set(previous);
            if (next.has(groupKey)) next.delete(groupKey); else next.add(groupKey);
            return next;
          })}
          className="flex shrink-0 items-center gap-1 rounded px-1 py-1 text-[11px] text-primary hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {timelineExpanded ? "收起明细" : "游玩明细"}
          <svg aria-hidden="true" viewBox="0 0 20 20" className={cn("size-3 transition-transform motion-reduce:transition-none", timelineExpanded && "rotate-180")}><path d="M5.5 8l4.5 4.5L14.5 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      </div>
      {timelineExpanded ? <ol id={timelineId} aria-label={`${title}的游玩明细`} tabIndex={0}
        className="ml-12 mt-2 max-h-48 space-y-1 overflow-y-auto overscroll-contain border-l border-border pl-3 pr-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{group.sessions.map(timelineEntry)}</ol> : null}
    </li>;
  };

  const toggle = () => { setExpanded(value => !value); };
  return <section data-home-history aria-labelledby="home-history-heading" className="min-w-0 overflow-hidden rounded-lg border border-border bg-card text-card-foreground">
    <h2 id="home-history-heading" className="border-b border-border text-sm font-semibold">
      <button ref={headerButton} type="button" aria-expanded={expanded} aria-controls="home-history-expanded"
        aria-label={expanded ? "收起全部游玩记录" : "展开全部游玩记录"} onClick={toggle}
        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left transition-colors hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        <span className="flex items-center gap-2"><GeometryIcon name="clock" className="text-primary" />最近游玩记录</span>
        <span className="flex shrink-0 items-center gap-2 text-xs font-normal text-muted-foreground">
          <span>{loading ? "读取中…" : expanded ? hasMore ? `已加载 ${sessions.length} 次` : `共 ${sessions.length} 次` : `最近 ${Math.min(PREVIEW_COUNT, groups.length)} 款`}</span>
          <span className="text-primary">{expanded ? "收起" : "查看全部"}</span>
          <svg aria-hidden="true" viewBox="0 0 20 20" className={cn("size-3.5 transition-transform duration-300 motion-reduce:transition-none", expanded && "rotate-180")}><path d="M5.5 8l4.5 4.5L14.5 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </span>
      </button>
    </h2>
    {loading && sessions.length === 0 ? <p role="status" className="px-4 py-5 text-xs text-muted-foreground">正在读取游玩记录…</p> : null}
    {error ? <div className="flex flex-col items-start gap-2 px-4 py-4 text-xs">
      <p role="alert" className="text-destructive">游玩记录载入失败：{error}</p>
      <Button size="sm" variant="outline" onClick={() => setAttempt(value => value + 1)}>重试游玩记录</Button>
    </div> : null}
    <div id="home-history-expanded">
      {groups.length > 0 ? <div role={expanded ? "region" : undefined} tabIndex={expanded ? 0 : undefined}
        aria-label={expanded ? "全部游玩记录" : undefined}
        className={cn(expanded && "max-h-96 overflow-y-auto overscroll-contain focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring")}>
        <ol className="divide-y divide-border">{(expanded ? groups : groups.slice(0, PREVIEW_COUNT)).map(row)}</ol>
      </div>
        : !loading && !error ? <div className="flex flex-col items-center gap-2 px-4 py-7 text-center">
          <GeometryIcon name="clock" className="size-8 text-muted-foreground/50" />
          <p className="text-sm">还没有游玩记录</p>
          <p className="text-xs text-muted-foreground">从管理器启动游戏后，每次游玩的时间会记录在这里。</p>
        </div> : null}
      {expanded ? <div className="flex flex-col gap-3 border-t border-border px-4 py-3">
        {moreError ? <p role="alert" className="text-xs text-destructive">更早记录载入失败：{moreError}。可点击下方按钮重试。</p> : null}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p role="status" className="text-xs text-muted-foreground">{loading ? "正在刷新记录…" : hasMore ? `已加载 ${sessions.length} 次游玩，可继续查看更早的游玩。` : `已显示全部 ${sessions.length} 次游玩`}</p>
          <div className="flex gap-2">
            {hasMore ? <Button size="sm" variant="outline" loading={loadingMore} disabled={loading} onClick={() => void loadMore()}>加载更早记录</Button> : null}
            <Button size="sm" variant="ghost" onClick={() => { setExpanded(false); headerButton.current?.focus({ preventScroll: true }); }}>收起记录</Button>
          </div>
        </div>
      </div> : null}
    </div>
  </section>;
}
