import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { CoverImage } from "@/components/ui/cover-image";
import { GeometryIcon } from "@/components/ui/geometry-icon";
import { playSessionsPage } from "@/lib/db";
import { cn } from "@/lib/utils";
import { formatPlayTime } from "@/types/game";
import type { Game, PlaySession } from "@/types/game";

const PREVIEW_COUNT = 6;
const PAGE_SIZE = 50;
const errorMessage = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const dateTime = (value: string) => new Date(value).toLocaleString("zh-CN", {
  year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
});
const duration = (seconds: number) => seconds < 60 ? `${Math.max(0, Math.floor(seconds))} 秒` : formatPlayTime(seconds);

export function RecentPlayHistory({ games, refreshKey }: { games: Game[]; refreshKey: string }) {
  const [sessions, setSessions] = useState<PlaySession[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [opened, setOpened] = useState(false);
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

  const row = (session: PlaySession) => {
    const game = gamesById.get(session.gameId);
    const content = <>
      <div className="h-12 w-9 shrink-0 overflow-hidden rounded bg-muted"><CoverImage gameId={game?.id} path={game?.coverPath ?? null} alt={game?.title ?? "已移除的作品"} className="h-full w-full object-cover" fallbackText="" /></div>
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-sm font-medium">{game?.title ?? "已移除的作品"}</h3>
        <p className="mt-1 break-words text-[11px] leading-relaxed text-muted-foreground"><time dateTime={session.startedAt}>{dateTime(session.startedAt)}</time>{session.endedAt ? <> → <time dateTime={session.endedAt}>{dateTime(session.endedAt)}</time></> : " · 记录未结束"}</p>
      </div>
      <div className="shrink-0 text-right">
        <p className="text-xs font-medium tabular-nums">{session.endedAt ? duration(session.durationSeconds) : "未结束"}</p>
        <p className="mt-1 text-[11px] text-muted-foreground">{game ? "查看历史 ↗" : "作品已移除"}</p>
      </div>
    </>;
    return <li key={session.id}>
      {game ? <Link to={`/library/${game.id}?tab=history`} data-session-id={session.id} className="flex min-w-0 items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">{content}</Link>
        : <div data-session-id={session.id} className="flex min-w-0 items-center gap-3 px-4 py-3">{content}</div>}
    </li>;
  };

  const toggle = () => { setOpened(true); setExpanded(value => !value); };
  return <section data-home-history aria-labelledby="home-history-heading" className="min-w-0 overflow-hidden rounded-lg border border-border bg-card text-card-foreground">
    <h2 id="home-history-heading" className="border-b border-border text-sm font-semibold">
      <button ref={headerButton} type="button" aria-expanded={expanded} aria-controls="home-history-expanded"
        aria-label={expanded ? "收起全部游玩记录" : "展开全部游玩记录"} onClick={toggle}
        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left transition-colors hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        <span className="flex items-center gap-2"><GeometryIcon name="clock" className="text-primary" />最近游玩记录</span>
        <span className="flex shrink-0 items-center gap-2 text-xs font-normal text-muted-foreground">
          <span>{loading ? "读取中…" : expanded ? hasMore ? `已加载 ${sessions.length} 条` : `共 ${sessions.length} 条` : `最近 ${Math.min(PREVIEW_COUNT, sessions.length)} 次`}</span>
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
    {sessions.length > 0 ? <ol className="divide-y divide-border">{sessions.slice(0, PREVIEW_COUNT).map(row)}</ol>
      : !loading && !error ? <div className="flex flex-col items-center gap-2 px-4 py-7 text-center">
        <GeometryIcon name="clock" className="size-8 text-muted-foreground/50" />
        <p className="text-sm">还没有游玩记录</p>
        <p className="text-xs text-muted-foreground">从管理器启动游戏后，每次游玩的时间会记录在这里。</p>
      </div> : null}
    <div id="home-history-expanded" aria-hidden={!expanded} ref={node => { if (node) node.inert = !expanded; }}
      className="grid transition-[grid-template-rows,opacity] duration-[320ms] ease-out motion-reduce:transition-none"
      style={{ gridTemplateRows: expanded ? "1fr" : "0fr", opacity: expanded ? 1 : 0 }}>
      <div className="min-h-0 overflow-hidden">
        {opened ? <>
          <div className="max-h-96 overflow-y-auto overscroll-contain border-t border-border" role="region" tabIndex={expanded && sessions.length > PREVIEW_COUNT ? 0 : -1} aria-label="更早的游玩记录">
            <ol start={PREVIEW_COUNT + 1} className="divide-y divide-border">{sessions.slice(PREVIEW_COUNT).map(row)}</ol>
          </div>
          <div className="flex flex-col gap-3 border-t border-border px-4 py-3">
            {moreError ? <p role="alert" className="text-xs text-destructive">更早记录载入失败：{moreError}。可点击下方按钮重试。</p> : null}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p role="status" className="text-xs text-muted-foreground">{loading ? "正在刷新记录…" : hasMore ? `已加载 ${sessions.length} 条记录，可继续查看更早的游玩。` : `已显示全部 ${sessions.length} 条记录`}</p>
              <div className="flex gap-2">
                {hasMore ? <Button size="sm" variant="outline" loading={loadingMore} disabled={loading} onClick={() => void loadMore()}>加载更早记录</Button> : null}
                <Button size="sm" variant="ghost" onClick={() => { setExpanded(false); headerButton.current?.focus({ preventScroll: true }); }}>收起记录</Button>
              </div>
            </div>
          </div>
        </> : null}
      </div>
    </div>
  </section>;
}
