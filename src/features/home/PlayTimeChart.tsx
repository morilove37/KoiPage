import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { GeometryIcon } from "@/components/ui/geometry-icon";
import { Tabs } from "@/components/ui/tabs";
import { playSessionsForPeriod } from "@/lib/db";
import { cn } from "@/lib/utils";
import type { Game, PlaySession } from "@/types/game";
import { buildPlayTimeSummary, playTimeWindow } from "./play-time";
import type { PlayTimePeriod } from "./play-time";
import { PlayTimeCalendar } from "./PlayTimeCalendar";

const PERIODS = [
  { value: "day", label: "本日" },
  { value: "week", label: "本周" },
  { value: "month", label: "本月" },
] as const;

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
  const [sessions, setSessions] = useState<PlaySession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [selectedStart, setSelectedStart] = useState<number | null>(null);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const calendarButton = useRef<HTMLButtonElement>(null);
  const window = playTimeWindow(now);

  useEffect(() => {
    const update = () => setNow(new Date());
    const timer = globalThis.setInterval(update, 60_000);
    document.addEventListener("visibilitychange", update);
    return () => { globalThis.clearInterval(timer); document.removeEventListener("visibilitychange", update); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void playSessionsForPeriod(window.start, window.end).then(next => {
      if (!cancelled) { setSessions(next); setNow(new Date()); }
    }).catch(cause => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [window.start, window.end, refreshKey, attempt]);

  const summary = useMemo(() => buildPlayTimeSummary(sessions, now), [sessions, now]);
  const current = summary[period];
  const maximum = chartMaximum(Math.max(0, ...current.buckets.map(bucket => bucket.seconds)));
  const selected = current.buckets.find(bucket => bucket.start === selectedStart)
    ?? current.buckets.find(bucket => bucket.start <= +now && bucket.end > +now)
    ?? current.buckets[current.buckets.length - 1];
  const periodLabel = PERIODS.find(item => item.value === period)!.label;
  const axisLabel = (seconds: number) => maximum >= 3600 ? `${Number((seconds / 3600).toFixed(1))} 时` : maximum >= 300 ? `${Math.round(seconds / 60)} 分` : `${Math.round(seconds)} 秒`;

  return <section data-home-play-time data-period={period} aria-labelledby="home-play-time-heading" className="min-w-0 overflow-hidden rounded-lg border border-border bg-card p-4 text-card-foreground">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <h2 id="home-play-time-heading" className="flex items-center gap-2 text-sm font-semibold"><GeometryIcon name="chart" className="text-primary" />游玩时长</h2>
      <div className="flex flex-wrap items-center gap-2">
        <Button ref={calendarButton} size="sm" variant="outline" aria-haspopup="dialog" onClick={() => setCalendarOpen(true)}><GeometryIcon name="calendar" className="size-3.5" />日历回顾</Button>
        <Tabs label="游玩时长统计范围" className="w-52 max-w-full" value={period} onValueChange={value => { setPeriod(value as PlayTimePeriod); setSelectedStart(null); }} items={PERIODS} />
      </div>
    </header>
    <dl className="mt-4 grid grid-cols-3 gap-2" aria-label="日周月游玩总时长">
      {PERIODS.map(item => <div key={item.value} className={cn("min-w-0 rounded-lg border px-2.5 py-2", period === item.value ? "border-primary/30 bg-primary/5" : "border-border bg-muted/20")}>
        <dt className="text-[11px] text-muted-foreground">{item.label}</dt>
        <dd data-period-total={item.value} data-total-seconds={!loading && !error ? summary[item.value].totalSeconds : undefined} className="mt-1 break-words text-sm font-semibold tabular-nums">{loading || error ? "—" : duration(summary[item.value].totalSeconds)}</dd>
      </div>)}
    </dl>
    {loading ? <div role="status" className="flex h-56 items-center justify-center text-xs text-muted-foreground">正在统计游玩时长…</div>
      : error ? <div className="flex h-56 flex-col items-start justify-center gap-3">
        <p role="alert" className="text-xs text-destructive">时长统计载入失败：{error}</p>
        <Button variant="outline" size="sm" onClick={() => setAttempt(value => value + 1)}>重试时长统计</Button>
      </div>
      : <div aria-label={`${periodLabel}游玩时长图表`}>
        <p className="mt-3 text-[11px] text-muted-foreground">{period === "day" ? "按小时统计" : period === "week" ? "周一至周日 · 按天统计" : `${now.getMonth() + 1} 月 · 按天统计`} · {current.gameCount} 部游戏 · {current.activeDays} 天游玩</p>
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
      </div>}
    <p className="mt-3 text-[10px] leading-relaxed text-muted-foreground">按本机时间统计已结束的记录，跨日时长拆分到对应日期；游戏退出后自动刷新。点击柱子查看具体时长。</p>
    {calendarOpen ? <PlayTimeCalendar games={games} refreshKey={refreshKey} onClose={() => { setCalendarOpen(false); calendarButton.current?.focus({ preventScroll: true }); }} /> : null}
  </section>;
}
