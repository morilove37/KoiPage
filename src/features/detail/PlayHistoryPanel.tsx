import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { GeometryIcon } from "@/components/ui/geometry-icon";
import { cn } from "@/lib/utils";
import type { GameDetail, PlaySession } from "@/types/game";
import { formatPlayTime } from "@/types/game";
import SessionEditor from './SessionEditor';

function timestamp(value: string): number {
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : 0;
}

function seconds(session: PlaySession): number {
  return Number.isFinite(session.durationSeconds) ? Math.max(0, Math.floor(session.durationSeconds)) : 0;
}

function duration(value: number): string {
  const total = Math.max(0, Math.floor(value));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total % 3600 / 60);
  const rest = total % 60;
  return [hours ? `${hours} 小时` : "", minutes ? `${minutes} 分钟` : "", rest || !total ? `${rest} 秒` : ""].filter(Boolean).join(" ");
}

function dateLabel(value: string, short = false): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return date.toLocaleDateString("zh-CN", short ? { month: "numeric", day: "numeric" } : { year: "numeric", month: "long", day: "numeric", weekday: "short" });
}

function dateTime(value: string | null): string {
  if (!value) return "暂无记录";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleString("zh-CN", { hour12: false });
}

/** Charts describe the fetched sessions; only cumulative time is all-time. */
export default function PlayHistoryPanel({ game, sessions }: { game: GameDetail; sessions: PlaySession[] }) {
  const [showAll, setShowAll] = useState(false);
  const [editing, setEditing] = useState<PlaySession | null>(null);
  const [range, setRange] = useState<10 | 20>(10);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const ordered = useMemo(() => [...sessions].sort((a, b) => timestamp(b.startedAt) - timestamp(a.startedAt) || b.id - a.id), [sessions]);
  const completed = useMemo(() => ordered.filter(session => Boolean(session.endedAt)), [ordered]);
  const chartSessions = useMemo(() => completed.slice(0, range).reverse(), [completed, range]);
  const longest = Math.max(0, ...completed.map(seconds));
  const average = completed.length ? Math.round(completed.reduce((sum, session) => sum + seconds(session), 0) / completed.length) : 0;
  const maximum = Math.max(1, ...chartSessions.map(seconds));
  // Range changes and refreshed data always leave a real, visible selection.
  const selected = chartSessions.find(session => session.id === selectedId) ?? chartSessions[chartSessions.length - 1];
  const unfinished = ordered.length - completed.length;

  return (
    <Card data-play-history>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><GeometryIcon name="history" className="text-primary" />游玩历史</CardTitle>

      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <SessionEditor gameId={game.id} />
          {editing && <SessionEditor key={editing.id} gameId={game.id} session={editing} onClose={() => setEditing(null)} />}
        </div>
        <div className="grid grid-cols-2 gap-2" aria-label="游玩历史概览">
          {([
            { icon: "clock", label: "累计游玩", value: formatPlayTime(game.playTimeSeconds), hint: "全部历史累计", key: "total" },
            { icon: "calendar", label: "本页记录", value: `${ordered.length} 次`, hint: unfinished ? `${unfinished} 次记录未结束` : "按开始时间倒序", key: "count" },
          ] as const).map(item => <div key={item.key} data-history-stat={item.key} className="flex min-w-0 items-start gap-2.5 rounded-lg border border-border bg-muted/30 p-3">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><GeometryIcon name={item.icon} /></span>
            <div className="min-w-0">
              <p className="text-[11px] text-muted-foreground">{item.label}</p>
              <p className="mt-0.5 break-words text-sm font-semibold tabular-nums">{item.value}</p>
              <p className="mt-0.5 text-[10px] text-muted-foreground">{item.hint}</p>
            </div>
          </div>)}
        </div>

        {ordered.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-4 py-8 text-center">
            <GeometryIcon name="play" className="size-8 text-primary/60" />
            <p className="text-sm font-medium">还没有游玩记录</p>
            <p className="text-xs text-muted-foreground">启动游戏后会自动记录，在这里查看每次游玩的时长。</p>
          </div>
        ) : <>
          <section aria-labelledby="history-timeline-title" className="rounded-lg border border-border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 id="history-timeline-title" className="text-sm font-semibold">{showAll ? "游玩记录" : "最近游玩记录"}</h4>
              {ordered.length > 3 ? <Button size="sm" variant="ghost" aria-expanded={showAll} aria-controls="history-timeline" onClick={() => setShowAll(value => !value)}>
                {showAll ? "只显示最近 3 条" : `查看全部 ${ordered.length} 条`}
              </Button> : null}
            </div>
            <ol id="history-timeline" className="mt-2 divide-y divide-border">
              {(showAll ? ordered : ordered.slice(0, 3)).map(session => <li key={session.id} data-history-session={session.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs">
                <div className="min-w-0">
                  <time dateTime={session.startedAt} className="font-medium tabular-nums">{dateTime(session.startedAt)}</time>
                  {showAll && session.endedAt ? <p className="mt-1 text-muted-foreground">结束于 <time dateTime={session.endedAt}>{dateTime(session.endedAt)}</time></p> : null}
                </div>
                <div className="ml-auto flex shrink-0 items-center gap-2">
                  <span className="font-medium tabular-nums">{session.endedAt ? duration(seconds(session)) : "记录未结束"}</span>
                  <Button size="sm" variant="outline" aria-label={`修正 ${dateTime(session.startedAt)} 的游玩记录`} onClick={() => setEditing(session)}>修正</Button>
                </div>
              </li>)}
            </ol>
          </section>
          <section aria-labelledby="history-chart-title" className="rounded-lg border border-border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 id="history-chart-title" className="flex items-center gap-1.5 text-xs font-medium"><GeometryIcon name="chart" className="size-4 text-primary" />单次游玩时长</h4>
              <div className="flex gap-1" aria-label="图表记录范围">
                {([10, 20] as const).map(count => <Button key={count} size="sm" variant={range === count ? "default" : "ghost"} aria-pressed={range === count} onClick={() => setRange(count)}>
                  近 {count} 次
                </Button>)}
              </div>
            </div>
            {completed.length ? <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
              <div className="flex gap-1.5" data-history-stat="average"><dt className="text-muted-foreground">近期平均</dt><dd className="font-medium tabular-nums">{duration(average)}</dd></div>
              <div className="flex gap-1.5" data-history-stat="longest"><dt className="text-muted-foreground">近期最长</dt><dd className="font-medium tabular-nums">{duration(longest)}</dd></div>
            </dl> : null}
            {chartSessions.length > 0 ? <>
              <p className="mt-2 text-[11px] text-muted-foreground">最近 {chartSessions.length} 次已结束记录 · 点击柱子查看详情</p>
              <div className="mt-3 flex gap-2">
                <div aria-hidden="true" className="flex h-36 w-12 shrink-0 flex-col justify-between pb-1 text-[10px] tabular-nums text-muted-foreground">
                  <span>{duration(maximum)}</span><span>0</span>
                </div>
                <div className="min-w-0 flex-1 overflow-x-auto pb-1">
                  <div className="relative grid gap-1" style={{ gridTemplateColumns: `repeat(${chartSessions.length}, minmax(24px, 1fr))` }} aria-label="单次游玩时长柱状图">
                    <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 flex h-36 flex-col justify-between border-b border-border">
                      <span className="border-t border-dashed border-border/70" /><span className="border-t border-dashed border-border/50" /><span />
                    </div>
                    {chartSessions.map(session => <button key={session.id} type="button" data-history-bar={session.id}
                      aria-label={`${dateTime(session.startedAt)}，游玩 ${duration(seconds(session))}`} aria-pressed={selected?.id === session.id}
                      title={`${dateTime(session.startedAt)} → ${dateTime(session.endedAt)}\n${duration(seconds(session))}`}
                      onClick={() => setSelectedId(session.id)}
                      className="group relative min-w-0 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card">
                      <span className="flex h-36 items-end justify-center px-0.5">
                        <span className={cn("block w-full max-w-9 rounded-t-sm transition-colors", selected?.id === session.id ? "bg-primary" : "bg-primary/35 group-hover:bg-primary/70")}
                          data-history-bar-fill style={{ height: `${seconds(session) / maximum * 100}%`, minHeight: 2 }} />
                      </span>
                      <span className="mt-1.5 block truncate text-[9px] tabular-nums text-muted-foreground">{dateLabel(session.startedAt, true)}</span>
                    </button>)}
                  </div>
                </div>
              </div>
              {selected ? <div role="status" aria-live="polite" data-history-selection={selected.id} className="mt-3 flex items-start gap-2 rounded-md bg-primary/10 px-3 py-2 text-xs">
                <GeometryIcon name="clock" className="mt-0.5 size-4 text-primary" />
                <div className="min-w-0"><p className="font-medium text-primary">{duration(seconds(selected))}</p>
                  <p className="mt-1 break-words text-muted-foreground">{dateTime(selected.startedAt)} → {dateTime(selected.endedAt)}</p>
                </div>
              </div> : null}
            </> : <p className="py-6 text-center text-xs text-muted-foreground">还没有已结束的记录，结束游玩后将显示时长图表。</p>}
          </section>


        </>}
        <p className="text-xs leading-relaxed text-muted-foreground">
          最多显示最近 50 条记录。平均和最长时长按这些记录中已结束的场次计算。
        </p>
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">游玩时长如何记录</summary>
          <p className="mt-2 leading-relaxed">每 30 秒保存时长。异常退出时按最后保存的时长结算，停机期间不计时。管理器重启后会停止跟踪此前运行的游戏。</p>
        </details>
      </CardContent>
    </Card>
  );
}
