import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { CoverImage } from "@/components/ui/cover-image";
import { Dialog } from "@/components/ui/dialog";
import { GeometryIcon } from "@/components/ui/geometry-icon";
import { playSessionsForPeriod } from "@/lib/db";
import { cn } from "@/lib/utils";
import type { Game, PlaySession } from "@/types/game";
import { calendarDateKey, calendarMonth, monthWindow } from "./play-time-calendar";

function duration(value: number, compact = false): string {
  const total = Math.max(0, Math.round(value));
  const hours = Math.floor(total / 3600), minutes = Math.floor(total % 3600 / 60);
  if (!total) return compact ? "—" : "0 分钟";
  if (!hours && !minutes) return `${total} 秒`;
  return compact ? `${hours ? `${hours}时` : ""}${minutes ? `${minutes}分` : ""}`
    : [hours ? `${hours} 小时` : "", minutes ? `${minutes} 分钟` : "", !hours && total % 60 ? `${total % 60} 秒` : ""].filter(Boolean).join(" ");
}

export function PlayTimeCalendar({ games, refreshKey, onClose }: { games: Game[]; refreshKey: string; onClose: () => void }) {
  const [now, setNow] = useState(() => new Date());
  const currentMonth = calendarDateKey(now).slice(0, 7);
  const [monthKey, setMonthKey] = useState(currentMonth);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [result, setResult] = useState<{ month: string; sessions: PlaySession[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ month: string; message: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [year, month] = monthKey.split("-").map(Number);
  const chosenMonth = new Date(year, month - 1, 1);
  const bounds = monthWindow(chosenMonth);
  const gamesById = useMemo(() => new Map(games.map(game => [game.id, game])), [games]);

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
    void playSessionsForPeriod(bounds.start, bounds.end).then(sessions => {
      if (!cancelled) { setResult({ month: monthKey, sessions }); setNow(new Date()); }
    }).catch(cause => {
      if (!cancelled) setError({ month: monthKey, message: cause instanceof Error ? cause.message : String(cause) });
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [bounds.start, bounds.end, monthKey, refreshKey, attempt]);

  const calendar = useMemo(() => calendarMonth(result?.month === monthKey ? result.sessions : [], new Date(year, month - 1, 1), now), [result, monthKey, year, month, now]);
  const ready = !loading && result?.month === monthKey && error?.month !== monthKey;
  const selected = calendar.days.find(day => day.key === selectedKey)
    ?? calendar.days.find(day => day.key === calendarDateKey(now))
    ?? [...calendar.days].reverse().find(day => day.seconds > 0)
    ?? calendar.days[0];
  const maximum = Math.max(1, ...calendar.days.map(day => day.seconds));
  const chooseMonth = (next: string) => {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(next) || next < "1900-01" || next > currentMonth) return;
    setMonthKey(next); setSelectedKey(null);
  };
  const moveMonth = (direction: number) => chooseMonth(calendarDateKey(new Date(year, month - 1 + direction, 1)).slice(0, 7));
  const cellCount = Math.ceil((calendar.leadingDays + calendar.days.length) / 7) * 7;
  const cells = Array.from({ length: cellCount }, (_, index) => calendar.days[index - calendar.leadingDays]);

  return createPortal(<Dialog open onClose={onClose} className="max-w-4xl"
    title={<span className="flex items-center gap-2 text-base"><GeometryIcon name="calendar" className="text-primary" />游玩时长 · 日历回顾</span>}
    description="翻看往期每天的游玩时长，点击日期查看当天的作品。"
    footer={<Button onClick={onClose}>关闭回顾</Button>}
  >
    <div data-play-time-calendar data-month={monthKey} className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" aria-label="上个月" disabled={monthKey === "1900-01"} onClick={() => moveMonth(-1)}>‹</Button>
          <input type="month" aria-label="选择回顾月份" min="1900-01" max={currentMonth} value={monthKey} onChange={event => chooseMonth(event.target.value)} className="h-9 min-w-0 rounded-md border border-border bg-background px-2 text-sm font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [.glass_&]:bg-[hsl(var(--glass-soft))]" />
          <Button variant="outline" size="icon" aria-label="下个月" disabled={monthKey >= currentMonth} onClick={() => moveMonth(1)}>›</Button>
        </div>
        <Button size="sm" variant="ghost" disabled={monthKey === currentMonth} onClick={() => chooseMonth(currentMonth)}>回到本月</Button>
      </div>
      <dl className="grid grid-cols-3 gap-2" aria-label="回顾月份概览">
        {[
          { label: "本月累计", value: duration(calendar.totalSeconds), key: "total" },
          { label: "游玩天数", value: `${calendar.activeDays} 天`, key: "days" },
          { label: "游玩作品", value: `${calendar.gameCount} 部`, key: "games" },
        ].map(item => <div key={item.key} className="min-w-0 rounded-lg border border-border bg-primary/5 px-3 py-2"><dt className="text-[11px] text-muted-foreground">{item.label}</dt><dd data-calendar-stat={item.key} className="mt-1 break-words text-sm font-semibold tabular-nums">{ready ? item.value : "—"}</dd></div>)}
      </dl>
      {error?.month === monthKey ? <div className="flex min-h-64 flex-col items-center justify-center gap-3 text-center">
        <p role="alert" className="text-sm text-destructive">回顾读取失败：{error.message}</p>
        <Button variant="outline" size="sm" onClick={() => setAttempt(value => value + 1)}>重试日历回顾</Button>
      </div> : !ready ? <p role="status" className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">正在读取 {year} 年 {month} 月的游玩记录…</p> : <div key={monthKey} className="grid items-start gap-4 animate-fade-in sm:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-3">
        <div role="group" aria-label={`${year} 年 ${month} 月每日游玩时长`}
          onKeyDown={event => {
            const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-calendar-day]');
            if (!button) return;
            const day = Number(button.dataset.calendarDay);
            const delta = ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 } as Record<string, number>)[event.key];
            if (!delta) return;
            const next = event.currentTarget.querySelector<HTMLButtonElement>(`button[data-calendar-day="${day + delta}"]`);
            if (!next || next.disabled) return;
            event.preventDefault(); next.focus({ preventScroll: true }); setSelectedKey(calendar.days[day + delta - 1].key);
          }}>
          <div className="mb-2 grid grid-cols-7 gap-1 text-center text-[11px] text-muted-foreground">{["一", "二", "三", "四", "五", "六", "日"].map(day => <span key={day}>周{day}</span>)}</div>
          <div className="grid grid-cols-7 gap-1 sm:gap-1.5">
            {cells.map((day, index) => {
              if (!day) return <span key={`empty-${index}`} aria-hidden className="min-h-12" />;
              const active = day.key === selected.key;
              const intensity = day.seconds / maximum;
              return <button key={day.key} type="button" data-calendar-day={day.date} data-seconds={day.seconds} disabled={day.future}
                aria-pressed={active} aria-label={`${day.key}，${day.future ? "尚未到来" : `游玩 ${duration(day.seconds)}`}`} aria-current={day.key === calendarDateKey(now) ? "date" : undefined}
                title={`${day.key} · ${day.future ? "尚未到来" : duration(day.seconds)}`} onClick={() => setSelectedKey(day.key)}
                className={cn("flex min-h-12 min-w-0 flex-col items-center justify-center gap-1 rounded-lg border text-xs tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card disabled:cursor-default disabled:opacity-35",
                  active ? "border-primary bg-primary text-primary-foreground" : "border-border hover:border-primary/60",
                  !active && (day.seconds === 0 ? "bg-muted/20" : intensity > 0.75 ? "bg-primary/40" : intensity > 0.5 ? "bg-primary/30" : intensity > 0.25 ? "bg-primary/20" : "bg-primary/10"),
                  !active && day.key === calendarDateKey(now) && "border-primary/70")}
              ><span className="font-medium">{day.date}</span><span className={cn("max-w-full truncate px-0.5 text-[9px] sm:text-[10px]", !active && "text-muted-foreground")}>{day.future ? "" : duration(day.seconds, true)}</span></button>;
            })}
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground"><span>颜色越深，当天游玩越久</span><span className="flex items-center gap-1" aria-hidden>少{["bg-muted/20", "bg-primary/10", "bg-primary/20", "bg-primary/30", "bg-primary/40"].map(color => <span key={color} className={cn("size-2.5 rounded-sm border border-border", color)} />)}多</span></div>
        </div>
        <section aria-live="polite" data-calendar-selection={selected.key} className="max-h-80 min-w-0 overflow-y-auto rounded-lg border border-border bg-muted/20 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">{new Date(selected.start).toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "short" })}</h3><span className="text-sm font-semibold tabular-nums text-primary">{duration(selected.seconds)}</span></div>
          {selected.games.length ? <ul className="mt-2 divide-y divide-border">{selected.games.map(entry => {
            const game = gamesById.get(entry.gameId);
            const content = <><div className="h-10 w-7 shrink-0 overflow-hidden rounded bg-muted"><CoverImage gameId={game?.id} path={game?.coverPath ?? null} alt="" fallbackText="" className="h-full w-full object-cover" /></div><span title={game?.title} className="min-w-0 flex-1 truncate text-xs">{game?.title ?? "已移除的作品"}</span><span className="shrink-0 text-xs font-medium tabular-nums">{duration(entry.seconds)}</span></>;
            return <li key={entry.gameId} data-calendar-game={entry.gameId}>{game ? <Link to={`/library/${game.id}?tab=history`} onClick={onClose} className="flex items-center gap-2.5 rounded px-1 py-2 hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{content}</Link> : <div className="flex items-center gap-2.5 px-1 py-2">{content}</div>}</li>;
          })}</ul> : <p className="mt-2 text-xs text-muted-foreground">这一天没有已结算的游玩记录。</p>}
        </section>
      </div>}
      <p className="text-[10px] leading-relaxed text-muted-foreground">按本机日期统计已结束的记录，跨午夜的时长会拆分到对应日期；当月游戏退出后自动刷新。</p>
    </div>
  </Dialog>, document.body);
}
