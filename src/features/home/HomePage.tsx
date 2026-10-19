import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Link, useNavigate } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/card";
import { CoverImage } from "@/components/ui/cover-image";
import { GeometryIcon } from "@/components/ui/geometry-icon";
import LaunchDialog from "@/features/launch/LaunchDialog";
import { useGameLauncher } from "@/features/launch/useGameLauncher";
import { useGameProcess } from "@/features/launch/useGameProcess";
import { gamesList, gamesTagsGet, tagsList } from "@/lib/db";
import { useLocalizedTags } from "@/lib/localization";
import { formatRating } from "@/lib/rating";
import { useAppStore } from "@/store/app";
import { GAME_STATUSES, GAME_STATUS_LABELS, formatPlayTime, isFavorite } from "@/types/game";
import type { Game, GameStatus, Tag } from "@/types/game";
import { PlayTimeChart } from "./PlayTimeChart";
import { RecentPlayHistory } from "./RecentPlayHistory";
import { BirthdayCard } from "@/features/birthdays/BirthdayCard";

const STATUS_COLORS: Record<GameStatus, string> = {
  unplayed: "bg-primary/50", wishlist: "bg-sky-500", playing: "bg-primary",
  completed: "bg-emerald-500", on_hold: "bg-amber-500", dropped: "bg-slate-400",
};

function timestamp(value: string | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function playedAt(value: string | null): string {
  if (!timestamp(value)) return "尚未游玩";
  return new Date(value!).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

interface Selection {
  id: number | null;
  previousId: number | null;
  direction: 1 | -1;
  revision: number;
}

const INITIAL_SELECTION: Selection = { id: null, previousId: null, direction: 1, revision: 0 };

function GameSelector({ games, currentIndex, onSelect, onMove }: {
  games: Game[];
  currentIndex: number;
  onSelect: (index: number) => void;
  onMove: (direction: 1 | -1) => void;
}) {
  const rail = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; x: number; scrollLeft: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const move = useRef(onMove);
  const previousIndex = useRef(currentIndex);

  useEffect(() => { move.current = onMove; }, [onMove]);

  useEffect(() => {
    const container = rail.current;
    if (!container) return;
    const updateOverflow = () => { container.dataset.overflow = String(container.scrollWidth > container.clientWidth + 1); };
    const observer = new ResizeObserver(updateOverflow);
    observer.observe(container);
    updateOverflow();
    let accumulated = 0;
    let lastWheelAt = 0;
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey) return;
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (delta === 0) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? container.clientWidth : 1;
      // The wheel selects games even when every cover fits. Keep ownership at
      // both ends so wrapping never scrolls the page away from the pointer.
      event.preventDefault();
      const now = performance.now();
      if (now - lastWheelAt > 180 || Math.sign(accumulated) !== Math.sign(delta)) accumulated = 0;
      lastWheelAt = now;
      accumulated += delta * unit;
      // Accumulate fine trackpad movement, but a mouse notch (even a large
      // one) advances exactly one game rather than skipping several covers.
      if (Math.abs(accumulated) < 40) return;
      const direction = accumulated > 0 ? 1 : -1;
      accumulated = 0;
      move.current(direction);
    };
    container.addEventListener("wheel", wheel, { passive: false });
    return () => { observer.disconnect(); container.removeEventListener("wheel", wheel); };
  }, [games.length]);

  const endDrag = (container: HTMLDivElement, pointerId: number) => {
    if (drag.current?.pointerId !== pointerId) return;
    drag.current = null;
    delete container.dataset.dragging;
    if (container.hasPointerCapture(pointerId)) container.releasePointerCapture(pointerId);
  };
  useEffect(() => {
    const container = rail.current;
    const selected = container?.querySelector<HTMLButtonElement>('[aria-selected="true"]');
    if (!container || !selected) return;
    const wrapped = games.length > 2 && Math.abs(currentIndex - previousIndex.current) === games.length - 1;
    previousIndex.current = currentIndex;
    // Scroll only the cover strip; changing games must not move the page.
    const left = selected.offsetLeft - 8;
    const right = selected.offsetLeft + selected.offsetWidth + 8;
    const next = left < container.scrollLeft ? left
      : right > container.scrollLeft + container.clientWidth ? right - container.clientWidth
      : container.scrollLeft;
    container.scrollTo({ left: next, behavior: wrapped || window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  }, [currentIndex, games]);

  return (
    <div ref={rail} role="tablist" aria-label="选择首页游戏" aria-orientation="horizontal" className="home-game-selector"
      aria-description="滚轮可循环切换游戏，点击封面也可切换，拖动可横向浏览。"
      onDragStart={event => event.preventDefault()}
      onPointerDown={event => {
        suppressClick.current = false;
        if (event.button !== 0 || event.pointerType !== "mouse" || event.currentTarget.scrollWidth <= event.currentTarget.clientWidth) return;
        drag.current = { pointerId: event.pointerId, x: event.clientX, scrollLeft: event.currentTarget.scrollLeft, moved: false };
      }}
      onPointerMove={event => {
        const gesture = drag.current;
        if (!gesture || gesture.pointerId !== event.pointerId) return;
        const distance = event.clientX - gesture.x;
        if (!gesture.moved && Math.abs(distance) <= 6) return;
        if (!gesture.moved) {
          gesture.moved = true;
          suppressClick.current = true;
          event.currentTarget.setPointerCapture(event.pointerId);
          event.currentTarget.dataset.dragging = "true";
        }
        event.preventDefault();
        event.currentTarget.scrollLeft = gesture.scrollLeft - distance;
      }}
      onPointerUp={event => endDrag(event.currentTarget, event.pointerId)}
      onPointerCancel={event => endDrag(event.currentTarget, event.pointerId)}
      onLostPointerCapture={event => endDrag(event.currentTarget, event.pointerId)}
      onPointerLeave={() => { if (!drag.current?.moved) drag.current = null; }}
      onClickCapture={event => {
        if (!suppressClick.current || event.detail === 0) return;
        event.preventDefault();
        event.stopPropagation();
        suppressClick.current = false;
      }}
      onKeyDown={event => {
        let index: number;
        if (event.key === "ArrowRight") index = (currentIndex + 1) % games.length;
        else if (event.key === "ArrowLeft") index = (currentIndex - 1 + games.length) % games.length;
        else if (event.key === "Home") index = 0;
        else if (event.key === "End") index = games.length - 1;
        else return;
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "ArrowRight" || event.key === "ArrowLeft") onMove(event.key === "ArrowRight" ? 1 : -1);
        else onSelect(index);
        event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[index]?.focus({ preventScroll: true });
      }}>
      {games.map((game, index) => (
        <button key={game.id} type="button" role="tab" id={`home-game-tab-${game.id}`}
          aria-label={game.title} aria-selected={index === currentIndex} aria-controls="home-game-panel"
          tabIndex={index === currentIndex ? 0 : -1} title={game.title}
          className="home-game-choice" onClick={() => onSelect(index)}>
          <span className="home-game-thumbnail">
            <CoverImage gameId={game.id} path={game.coverPath} alt="" loading={index < 10 ? "eager" : "lazy"}
              className="h-full w-full object-cover" fallbackClassName="bg-slate-800 text-white/75" fallbackText="暂无封面" />
          </span>
          <span className="home-game-caption">{game.title}</span>
        </button>
      ))}
    </div>
  );
}

function HeroGame({ game, tags, lastPlayedId, active, onLaunch }: {
  game: Game;
  tags: Tag[];
  lastPlayedId: number | undefined;
  active: boolean;
  onLaunch?: () => void;
}) {
  const { t } = useLocalizedTags();
  const process = useGameProcess(game.id, active);
  const launching = process.status === "starting";

  return (
    <>
      <div aria-hidden="true" className="home-game-artwork absolute inset-0 overflow-hidden">
        <CoverImage gameId={game.id} path={game.coverPath} alt="" loading="eager" fitLandscape className="h-full w-full object-cover" fallbackText="" />
        <div className="home-game-shade absolute inset-0" />
      </div>
      <div className="home-game-copy text-white">
        <div className="flex items-center gap-2 text-xs font-medium tracking-wide text-white/75">
          <span className="h-px w-5 bg-white/50" aria-hidden="true" />
          {game.id === lastPlayedId ? "继续上次的故事" : lastPlayedId === undefined ? "从这里开始" : "下一段故事"}
        </div>
        <h2 className="home-game-title line-clamp-2 break-words font-semibold leading-tight tracking-tight" title={game.title}>{game.title}</h2>
        <p className="line-clamp-1 text-xs text-white/65">{game.developer || "未知开发商"}{game.releaseDate ? ` · ${game.releaseDate}` : ""}</p>
        <div className="flex gap-1.5 overflow-hidden whitespace-nowrap text-xs [&>*]:shrink-0">
          <span className="rounded-full border border-white/20 bg-white/10 px-2.5 py-1">{GAME_STATUS_LABELS[game.status]}</span>
          {game.rating !== null ? <span className="rounded-full border border-white/20 bg-white/10 px-2.5 py-1">评分 {formatRating(game.rating)}</span> : null}
          {tags.slice(0, 2).map(tag => <span key={tag.id} title={tag.name} className="max-w-24 truncate rounded-full border border-white/15 px-2.5 py-1 text-white/75">{t(tag.name)}</span>)}
        </div>
        <p className="line-clamp-2 whitespace-pre-line text-sm leading-relaxed text-white/75">
          {game.description || "打开游戏详情，看看这段故事。"}
        </p>
        <p className="text-xs text-white/55">{timestamp(game.lastPlayedAt) ? `上次游玩 ${playedAt(game.lastPlayedAt)} · ` : ""}累计 {formatPlayTime(game.playTimeSeconds)}</p>
        <div className="home-game-actions">
          {active ? (
            <>
              <button type="button" className="home-game-play disabled:cursor-wait disabled:opacity-60" disabled={launching} aria-busy={launching} onClick={onLaunch}><GeometryIcon name="play" />{launching ? "启动中…" : process.status === "running" ? "运行中" : game.playTimeSeconds > 0 ? "继续游玩" : "启动游戏"}</button>
              <Link to={`/library/${game.id}`} className="home-game-details">查看详情 <span aria-hidden="true">↗</span></Link>
            </>
          ) : <span className="home-game-play"><GeometryIcon name="play" />{game.playTimeSeconds > 0 ? "继续游玩" : "启动游戏"}</span>}
        </div>
      </div>
    </>
  );
}

export default function HomePage() {
  const navigate = useNavigate();
  const playTimeRevision = useAppStore(state => state.playTimeRevision);
  const [games, setGames] = useState<Game[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [links, setLinks] = useState<Array<[number, number]>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [selection, setSelection] = useState<Selection>(INITIAL_SELECTION);
  const launcher = useGameLauncher();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void Promise.all([gamesList(), tagsList(), gamesTagsGet()]).then(([nextGames, nextTags, nextLinks]) => {
      if (cancelled) return;
      setGames(nextGames);
      setTags(nextTags);
      setLinks(nextLinks);
      setSelection(INITIAL_SELECTION);
    }).catch(cause => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [playTimeRevision, reloadKey]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen("game-exited", () => setReloadKey(key => key + 1)).then(remove => {
      if (disposed) remove();
      else unlisten = remove;
    }).catch(cause => console.warn("[home] game-exited listener:", cause));
    return () => { disposed = true; unlisten?.(); };
  }, []);

  // A recent play always leads; unplayed games follow by import date.
  const orderedGames = useMemo(() => [...games].sort((a, b) =>
    timestamp(b.lastPlayedAt) - timestamp(a.lastPlayedAt)
    || timestamp(b.createdAt) - timestamp(a.createdAt)
    || b.id - a.id,
  ), [games]);
  const lastPlayedId = orderedGames.find(game => timestamp(game.lastPlayedAt) > 0)?.id;
  const currentIndex = Math.max(0, orderedGames.findIndex(game => game.id === selection.id));
  const current = orderedGames[currentIndex];
  const previous = orderedGames.find(game => game.id === selection.previousId);
  const gameTags = useMemo(() => {
    const byId = new Map(tags.map(tag => [tag.id, tag]));
    const map = new Map<number, Tag[]>();
    for (const [gameId, tagId] of links) {
      const tag = byId.get(tagId);
      if (tag) {
        const list = map.get(gameId);
        if (list) list.push(tag);
        else map.set(gameId, [tag]);
      }
    }
    return map;
  }, [tags, links]);

  useEffect(() => {
    if (selection.previousId === null) return;
    const revision = selection.revision;
    const timer = window.setTimeout(() => {
      setSelection(state => state.revision === revision ? { ...state, previousId: null } : state);
    }, 360);
    return () => window.clearTimeout(timer);
  }, [selection.previousId, selection.revision]);

  const move = (direction: 1 | -1) => {
    if (orderedGames.length < 2) return;
    setSelection(state => {
      const index = Math.max(0, orderedGames.findIndex(game => game.id === state.id));
      const next = (index + direction + orderedGames.length) % orderedGames.length;
      return { id: orderedGames[next].id, previousId: orderedGames[index].id, direction, revision: state.revision + 1 };
    });
  };

  const selectGame = (index: number) => {
    const target = orderedGames[index];
    if (!target) return;
    setSelection(state => {
      const from = Math.max(0, orderedGames.findIndex(game => game.id === state.id));
      if (orderedGames[from].id === target.id) return state;
      return { id: target.id, previousId: orderedGames[from].id, direction: index > from ? 1 : -1, revision: state.revision + 1 };
    });
  };

  const randomGame = () => {
    if (games.length === 0) return;
    const picked = games[Math.floor(Math.random() * games.length)];
    navigate(`/library/${picked.id}`);
  };
  const waitingGames = useMemo(() => games
    .filter(game => game.status === "unplayed" || game.status === "wishlist")
    .sort((a, b) => b.favorite - a.favorite || timestamp(b.createdAt) - timestamp(a.createdAt) || b.id - a.id), [games]);
  const statusCounts = useMemo(() => GAME_STATUSES.map(status => ({ status, count: games.filter(game => game.status === status).length })), [games]);
  const completedCount = games.filter(game => game.status === "completed").length;
  const completionRate = games.length > 0 ? Math.round(completedCount / games.length * 100) : 0;

  return (
    <div className="flex flex-col gap-4 px-4 py-3" data-home-page>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">首页</h1>
          <p className="text-xs text-muted-foreground">{loading ? "正在读取游戏库…" : `共 ${games.length} 部游戏 · 收藏 ${games.filter(isFavorite).length} 部 · 累计 ${formatPlayTime(games.reduce((sum, game) => sum + game.playTimeSeconds, 0))}`}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" loading={loading} onClick={() => setReloadKey(key => key + 1)}>刷新</Button>
          <Button disabled={loading || games.length === 0} onClick={randomGame}>随机选一款 <span aria-hidden="true">↗</span></Button>
        </div>
      </header>

      {error ? <div role="alert" className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">首页载入失败：{error}。请点击刷新重试。</div> : null}
      {launcher.error ? <p role="alert" className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">{launcher.error}</p> : null}
      {launcher.notice ? <p role="status" className="rounded-md border border-border bg-accent px-3 py-2 text-xs">{launcher.notice}</p> : null}

      {loading && games.length === 0 ? (
        <div role="status" aria-label="正在载入首页" className="home-hero shimmer rounded-xl border border-border" />
      ) : current ? (
        <section
          className="home-hero relative overflow-hidden rounded-xl border border-border bg-slate-950 shadow-sm"
          aria-label="首页游戏切换"
          tabIndex={0}
          onKeyDown={event => {
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              event.preventDefault();
              move(event.key === "ArrowRight" ? 1 : -1);
            }
          }}
          style={{ "--home-slide-direction": selection.direction } as CSSProperties}
        >
          {previous && previous.id !== current.id ? (
            <div key={`previous-${selection.revision}`} aria-hidden="true" className="home-hero-slide home-hero-slide-out pointer-events-none absolute inset-0">
              <HeroGame game={previous} tags={gameTags.get(previous.id) ?? []} lastPlayedId={lastPlayedId} active={false} />
            </div>
          ) : null}
          <div key={`${current.id}-${selection.revision}`} id="home-game-panel" role="tabpanel" aria-labelledby={`home-game-tab-${current.id}`} className={`home-hero-slide absolute inset-0${selection.revision > 0 ? " home-hero-slide-in" : ""}`} data-home-game-id={current.id}>
            <HeroGame game={current} tags={gameTags.get(current.id) ?? []} lastPlayedId={lastPlayedId} active onLaunch={() => void launcher.launch(current)} />
          </div>
          <div className="home-game-picker">
            <GameSelector games={orderedGames} currentIndex={currentIndex} onSelect={selectGame} onMove={move} />
          </div>
          <div className="absolute bottom-4 left-6 right-6 z-10 flex items-center justify-between gap-4 lg:left-8 lg:right-8">
            <div className="flex items-center gap-3 text-xs text-white/65">
              <span aria-live="polite" aria-atomic="true">{currentIndex + 1} / {orderedGames.length}</span>
              <div aria-hidden="true" className="h-0.5 w-20 overflow-hidden rounded-full bg-white/20">
                <div className="h-full bg-white/80 transition-[width] duration-300" style={{ width: `${((currentIndex + 1) / orderedGames.length) * 100}%` }} />
              </div>
            </div>
          </div>
        </section>
      ) : !error ? (
        <EmptyState title="从第一部游戏开始" description="添加游戏后，这里会展示上次游玩的作品、大封面和游玩记录。" action={<Link to="/library" className="text-sm font-medium text-primary underline-offset-4 hover:underline">前往游戏库添加游戏 →</Link>} />
      ) : null}

      {games.length > 0 ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="游玩概览">
          {([
            { icon: "clock", label: "累计游玩", value: formatPlayTime(games.reduce((sum, game) => sum + game.playTimeSeconds, 0)), hint: "所有游戏的累计时长" },
            { icon: "play", label: "游玩中", value: `${games.filter(game => game.status === "playing").length} 部`, hint: "正在追的故事" },
            { icon: "check", label: "已通关", value: `${completedCount} 部`, hint: `占游戏库的 ${completionRate}%` },
            { icon: "bookmark", label: "待开始", value: `${waitingGames.length} 部`, hint: "想玩与尚未游玩的作品" },
          ] as const).map(stat => (
            <div key={stat.label} className="flex min-w-0 items-center gap-3 rounded-lg border border-border bg-card px-3 py-3 text-card-foreground">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><GeometryIcon name={stat.icon} className="size-5" /></span>
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">{stat.label}</p>
                <p className="truncate text-sm font-semibold tabular-nums" title={stat.value}>{stat.value}</p>
                <p className="truncate text-[11px] text-muted-foreground">{stat.hint}</p>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {games.length > 0 ? (
        <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(250px,1fr)]">
          <div className="flex min-w-0 flex-col gap-4">
          <RecentPlayHistory games={games} refreshKey={`${playTimeRevision}:${reloadKey}`} />
          <PlayTimeChart games={games} refreshKey={`${playTimeRevision}:${reloadKey}`} />
          </div>

          <div className="flex flex-col gap-4">
            <BirthdayCard games={games} />
            <section aria-labelledby="home-waiting-heading" className="overflow-hidden rounded-lg border border-border bg-card text-card-foreground">
              <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
                <h2 id="home-waiting-heading" className="flex items-center gap-2 text-sm font-semibold"><GeometryIcon name="bookmark" className="text-primary" />等待开启的故事</h2>
                <span className="text-xs text-muted-foreground">{waitingGames.length} 部</span>
              </div>
              {waitingGames.length > 0 ? (
                <div className="divide-y divide-border">
                  {waitingGames.slice(0, 3).map(game => (
                    <Link key={game.id} to={`/library/${game.id}`} className="flex min-w-0 items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                      <div className="h-12 w-9 shrink-0 overflow-hidden rounded bg-muted"><CoverImage gameId={game.id} path={game.coverPath} alt={game.title} className="h-full w-full object-cover" fallbackText="" /></div>
                      <div className="min-w-0 flex-1">
                        <h3 className="truncate text-sm font-medium">{game.title}</h3>
                        <p className="mt-1 text-xs text-muted-foreground">{isFavorite(game) ? "★ 已收藏 · " : ""}{GAME_STATUS_LABELS[game.status]}</p>
                      </div>
                      <span aria-hidden="true" className="text-xs text-muted-foreground">↗</span>
                    </Link>
                  ))}
                </div>
              ) : <p className="px-4 py-5 text-xs text-muted-foreground">待玩清单已清空，继续享受正在游玩的故事吧。</p>}
            </section>

            <section aria-labelledby="home-progress-heading" className="rounded-lg border border-border bg-card p-4 text-card-foreground">
              <div className="flex items-center justify-between gap-2">
                <h2 id="home-progress-heading" className="flex items-center gap-2 text-sm font-semibold"><GeometryIcon name="check" className="text-primary" />游戏库进度</h2>
                <span className="text-lg font-semibold tabular-nums text-primary">{completionRate}%</span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">已通关 {completedCount} / {games.length} 部</p>
              <div aria-hidden="true" className="my-3 flex h-2 overflow-hidden rounded-full bg-muted">
                {statusCounts.filter(item => item.count > 0).map(item => <span key={item.status} className={STATUS_COLORS[item.status]} style={{ width: `${item.count / games.length * 100}%` }} />)}
              </div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                {statusCounts.map(item => (
                  <div key={item.status} className="flex items-center gap-1.5">
                    <span aria-hidden="true" className={`size-1.5 rounded-full ${STATUS_COLORS[item.status]}`} />
                    <dt className="text-muted-foreground">{GAME_STATUS_LABELS[item.status]}</dt>
                    <dd className="ml-auto font-medium tabular-nums">{item.count}</dd>
                  </div>
                ))}
              </dl>
            </section>
          </div>
        </div>
      ) : null}
      {launcher.dialogGame ? <LaunchDialog open game={launcher.dialogGame} onClose={launcher.closeDialog} /> : null}
    </div>
  );
}
