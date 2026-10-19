import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { CoverImage } from "@/components/ui/cover-image";
import { GeometryIcon } from "@/components/ui/geometry-icon";
import { Tabs } from "@/components/ui/tabs";
import { playSessionsForPeriod } from "@/lib/db";
import { cn } from "@/lib/utils";
import type { Game, PlaySession } from "@/types/game";
import { buildPlayTimeSummary, movePlayTimePeriod, playTimePeriodWindow, playTimeWindow } from "./play-time";
import type { PlayTimePeriod } from "./play-time";
import { PlayTimeCalendar } from "./PlayTimeCalendar";

const PERIODS = [
  { value: "day", label: "本日" },
  { value: "week", label: "本周" },
  { value: "month", label: "本月" },
] as const;
const UNITS = { day: "日", week: "周", month: "月" } as const;

/** The result belongs to an exact request, so a changed range never flashes old data. */
function usePeriodSessions(bounds: { start: string; end: string }, refreshKey: string, attempt: number, setNow: (date: Date) => void) {
  const key = JSON.stringify([bounds.start, bounds.end, refreshKey, attempt]);
  const [result, setResult] = useState<{ key: string; sessions: PlaySession[]; error: string | null } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void playSessionsForPeriod(bounds.start, bounds.end).then(sessions => {
      if (!cancelled) { setResult({ key, sessions, error: null }); setNow(new Date()); }
    }).catch(cause => {
      if (!cancelled) setResult({ key, sessions: [], error: cause instanceof Error ? cause.message : String(cause) });
    });
    return () => { cancelled = true; };
  }, [bounds.start, bounds.end, key, setNow]);
  return { sessions: result?.key === key ? result.sessions : [], loading: result?.key !== key, error: result?.key === key ? result.error : null };
}

function duration(value: number): string {
  const seconds = Math.max(0, Math.round(value));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  if (!seconds) return "0 分钟";
  if (!hours && !minutes) return `${seconds} 秒`;
  return [hours ? `${hours} 小时` : "", minutes ? `${minutes} 分钟` : "", !hours && seconds % 60 ? `${seconds % 60} 秒` : ""].filter(Boolean).join(" ");
}

function chartMaximum(value: number): number {
  return [60, 300, 900, 1800, 3600].find(step => step >= value) ?? Math.ceil(value / 3600) * 3600;
}

export function PlayTimeChart({ games, refreshKey }: { games: Game[]; refreshKey: string }) {
  const [period, setPeriod] = useState<PlayTimePeriod>("week");
  const [now, setNow] = useState(() => new Date());
  const [anchor, setAnchor] = useState<Date | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [selectedStart, setSelectedStart] = useState<number | null>(null);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const calendarButton = useRef<HTMLButtonElement>(null);
  const window = playTimeWindow(now);
  const selectedAnchor = anchor ?? now;
  const selectedWindow = playTimePeriodWindow(selectedAnchor, period);
  const currentWindow = playTimePeriodWindow(now, period);
  const isCurrent = selectedWindow.start === currentWindow.start;
  const overview = usePeriodSessions(window, refreshKey, attempt, setNow);
  const review = usePeriodSessions(selectedWindow, refreshKey, attempt, setNow);
  const { loading, error } = review;

  useEffect(() => {
    const update = () => setNow(new Date());
    const timer = globalThis.setInterval(update, 60_000);
    document.addEventListener("visibilitychange", update);
    return () => { globalThis.clearInterval(timer); document.removeEventListener("visibilitychange", update); };
  }, []);

  const summary = useMemo(() => buildPlayTimeSummary(overview.sessions, now), [overview.sessions, now]);
  const current = useMemo(() => buildPlayTimeSummary(review.sessions, now, selectedAnchor)[period], [review.sessions, now, selectedAnchor, period]);
  const gamesById = useMemo(() => new Map(games.map(game => [game.id, game])), [games]);
  const maximum = chartMaximum(Math.max(0, ...current.buckets.map(bucket => bucket.seconds)));
  const selected = current.buckets.find(bucket => bucket.start === selectedStart)
    ?? current.buckets.find(bucket => bucket.start <= +now && bucket.end > +now)
    ?? current.buckets[current.buckets.length - 1];
  const periodLabel = isCurrent ? PERIODS.find(item => item.value === period)!.label : `所选${UNITS[period]}`;
  const rangeStart = new Date(selectedWindow.start);
  const rangeEnd = new Date(Date.parse(selectedWindow.end) - 1);
  const formatDate = (date: Date) => date.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" });
  const rangeLabel = period === "day" ? formatDate(rangeStart) : period === "month"
    ? rangeStart.toLocaleDateString("zh-CN", { year: "numeric", month: "long" })
    : `${formatDate(rangeStart)} — ${formatDate(rangeEnd)}`;
  const move = (direction: -1 | 1) => {
    setAnchor(value => {
      const next = movePlayTimePeriod(value ?? now, period, direction, now);
      return +next === Date.parse(currentWindow.start) ? null : next;
    });
    setSelectedStart(null);
  };
  const axisLabel = (seconds: number) => maximum >= 3600 ? `${Number((seconds / 3600).toFixed(1))} 时` : maximum >= 300 ? `${Math.round(seconds / 60)} 分` : `${Math.round(seconds)} 秒`;

  return <section data-home-play-time data-period={period} aria-labelledby="home-play-time-heading" className="min-w-0 overflow-hidden rounded-lg border border-border bg-card p-4 text-card-foreground">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <h2 id="home-play-time-heading" className="flex items-center gap-2 text-sm font-semibold"><GeometryIcon name="chart" className="text-primary" />游玩时长</h2>
      <div className="flex flex-wrap items-center gap-2">
        <Button ref={calendarButton} size="sm" variant="outline" aria-haspopup="dialog" onClick={() => setCalendarOpen(true)}><GeometryIcon name="calendar" className="size-3.5" />日历回顾</Button>
        <Tabs label="游玩时长统计范围" className="w-40 max-w-full" value={period} onValueChange={value => { setPeriod(value as PlayTimePeriod); setSelectedStart(null); }} items={PERIODS.map(item => ({ value: item.value, label: UNITS[item.value] }))} />
      </div>
    </header>
    <dl className="mt-4 grid grid-cols-3 gap-2" aria-label="日周月游玩总时长">
      {PERIODS.map(item => <div key={item.value} className={cn("min-w-0 rounded-lg border px-2.5 py-2", period === item.value ? "border-primary/30 bg-primary/5" : "border-border bg-muted/20")}>
        <dt className="text-[11px] text-muted-foreground">{item.label}</dt>
        <dd data-period-total={item.value} data-total-seconds={!overview.loading && !overview.error ? summary[item.value].totalSeconds : undefined} className="mt-1 break-words text-sm font-semibold tabular-nums">{overview.loading || overview.error ? "—" : duration(summary[item.value].totalSeconds)}</dd>
      </div>)}
    </dl>
    {overview.error ? <p role="alert" className="mt-2 text-xs text-destructive">当前概览载入失败：{overview.error} <button className="underline" onClick={() => setAttempt(value => value + 1)}>重试</button></p> : null}
    <div className="mt-4 flex flex-wrap items-center justify-between gap-2" aria-label="切换游玩统计日期">
      <div className="flex min-w-0 items-center gap-2">
        <Button variant="outline" size="icon" aria-label={`上一${UNITS[period]}`} onClick={() => move(-1)}>‹</Button>
        <p data-play-time-range aria-live="polite" className="min-w-0 text-xs font-medium tabular-nums">{rangeLabel}{isCurrent ? <span className="ml-1.5 text-primary">· {periodLabel}</span> : null}</p>
        <Button variant="outline" size="icon" aria-label={`下一${UNITS[period]}`} disabled={isCurrent} onClick={() => move(1)}>›</Button>
      </div>
      <Button size="sm" variant="ghost" disabled={isCurrent} onClick={() => { setAnchor(null); setSelectedStart(null); }}>回到{PERIODS.find(item => item.value === period)!.label}</Button>
    </div>
    {loading ? <div role="status" className="flex h-56 items-center justify-center text-xs text-muted-foreground">正在统计游玩时长…</div>
      : error ? <div className="flex h-56 flex-col items-start justify-center gap-3">
        <p role="alert" className="text-xs text-destructive">时长统计载入失败：{error}</p>
        <Button variant="outline" size="sm" onClick={() => setAttempt(value => value + 1)}>重试时长统计</Button>
      </div>
      : <div aria-label={`${periodLabel}游玩时长图表`}>
        <p data-selected-period-total data-total-seconds={current.totalSeconds} className="mt-3 text-xs font-semibold tabular-nums">{periodLabel}累计 · {duration(current.totalSeconds)}</p>
        <p className="mt-1 text-[11px] text-muted-foreground">{period === "day" ? "按小时统计" : period === "week" ? "周一至周日 · 按天统计" : `${rangeStart.getMonth() + 1} 月 · 按天统计`} · {current.gameCount} 部游戏 · {current.activeDays} 天游玩</p>
        <div className="mt-4 flex gap-2">
          <div aria-hidden="true" className="flex h-36 w-10 shrink-0 flex-col justify-between text-[10px] tabular-nums text-muted-foreground"><span>{axisLabel(maximum)}</span><span>{axisLabel(maximum / 2)}</span><span>0</span></div>
          <div className="relative min-w-0 flex-1">
            <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 flex h-36 flex-col justify-between border-b border-border"><span className="border-t border-dashed border-border/70" /><span className="border-t border-dashed border-border/50" /><span /></div>
            <div className="grid gap-0.5" style={{ gridTemplateColumns: `repeat(${current.buckets.length}, minmax(0, 1fr))` }}>
              {current.buckets.map((bucket, index) => {
                const active = bucket.start === selected.start;
                const showLabel = period === "week" || index === 0 || index === current.buckets.length - 1 || active || (period === "day" ? index % 4 === 0 : (index + 1) % 5 === 0);
                return <button key={bucket.start} data-play-time-bucket={index} data-seconds={bucket.seconds} type="button"
                  aria-label={`${bucket.description}，游玩 ${duration(bucket.seconds)}`} aria-pressed={active}
                  title={`${bucket.description} · ${duration(bucket.seconds)}`} onClick={() => setSelectedStart(bucket.start)}
                  className="group relative min-w-0 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card">
                  <span className="flex h-36 items-end justify-center px-px">
                    <span data-play-time-fill className={cn("block w-full max-w-10 rounded-t-sm transition-[height,background-color] duration-300 motion-reduce:transition-none", active ? "bg-primary" : "bg-primary/40 group-hover:bg-primary/75")}
                      style={{ height: `${bucket.seconds / maximum * 100}%`, minHeight: bucket.seconds > 0 ? 3 : 0 }} />
                  </span>
                  <span aria-hidden="true" className={cn("mt-1.5 block text-[9px] tabular-nums", active ? "font-semibold text-primary" : "text-muted-foreground", !showLabel && "invisible")}>{bucket.label}</span>
                </button>;
              })}
            </div>
          </div>
        </div>
        <p role="status" aria-live="polite" data-play-time-selection className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-primary/5 px-3 py-2 text-xs"><span className="text-muted-foreground">{selected.description}</span><span className="font-semibold tabular-nums text-primary">{duration(selected.seconds)}</span></p>
        {current.totalSeconds === 0 ? <p className="mt-2 text-center text-xs text-muted-foreground">{periodLabel}还没有已结算的游玩时长，结束游戏后会自动更新。</p> : null}
        <section aria-label={`${rangeLabel}游玩作品`} className="mt-4 border-t border-border pt-3">
          <h3 className="text-xs font-semibold">{periodLabel}游玩的作品 <span className="font-normal text-muted-foreground">· 点击查看游玩记录</span></h3>
          {current.games.length ? <ul className="mt-2 max-h-56 divide-y divide-border overflow-y-auto">{current.games.map(entry => {
            const game = gamesById.get(entry.gameId);
            const content = <><div className="h-10 w-7 shrink-0 overflow-hidden rounded bg-muted"><CoverImage gameId={game?.id} path={game?.coverPath ?? null} alt="" fallbackText="" className="h-full w-full object-cover" /></div><span title={game?.title} className="min-w-0 flex-1 truncate text-xs">{game?.title ?? "已移除的作品"}</span><span className="shrink-0 text-xs font-medium tabular-nums">{duration(entry.seconds)}</span></>;
            return <li key={entry.gameId} data-play-time-game={entry.gameId} data-seconds={entry.seconds}>{game ? <Link to={`/library/${game.id}?tab=history`} className="flex items-center gap-2.5 rounded px-1 py-2 hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{content}</Link> : <div className="flex items-center gap-2.5 px-1 py-2">{content}</div>}</li>;
          })}</ul> : <p className="mt-2 text-xs text-muted-foreground">此时间段暂无已结算的游玩记录。</p>}
        </section>
      </div>}
    <p className="mt-3 text-[10px] leading-relaxed text-muted-foreground">按本机时间统计已结束的记录，跨日时长拆分到对应日期；游戏退出后自动刷新。点击柱子查看具体时长。</p>
    {calendarOpen ? <PlayTimeCalendar games={games} refreshKey={refreshKey} onClose={() => { setCalendarOpen(false); calendarButton.current?.focus({ preventScroll: true }); }} /> : null}
  </section>;
}
