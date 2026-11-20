import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Tabs } from '@/components/ui/tabs';
import { saveShare } from '@/features/share/io';
import type { Game } from '@/types/game';
import { buildPlayTimeSummary, formatPlayDuration, movePlayTimePeriod, playTimePeriodWindow } from './play-time';
import type { PlayTimeSeries } from './play-time';
import { usePeriodSessions } from './use-period-sessions';

type Metric = { label: string; value: string };
type PlayedWork = { gameId: number; title: string; duration: string; available: boolean };
const months = [{ value: 'current', label: '本月' }, { value: 'previous', label: '上月' }];
const exportLimit = 5;

function renderReview(month: string, metrics: Metric[], works: PlayedWork[]): Promise<Blob> {
  const canvas = document.createElement('canvas');
  const entries = works.slice(0, exportLimit);
  canvas.width = 880;
  canvas.height = 332 + entries.length * 58 + (works.length > exportLimit ? 28 : 0);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法生成回顾图片');

  const background = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
  background.addColorStop(0, '#fff9fb');
  background.addColorStop(1, '#eae4fa');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const drawText = (value: string, x: number, y: number, size: number, weight: number, color: string, maxWidth = Infinity) => {
    ctx.font = `${weight} ${size}px "Microsoft YaHei UI", sans-serif`;
    ctx.fillStyle = color;
    if (ctx.measureText(value).width > maxWidth) {
      const chars = Array.from(value);
      while (chars.length && ctx.measureText(`${chars.join('')}…`).width > maxWidth) chars.pop();
      value = `${chars.join('')}…`;
    }
    ctx.fillText(value, x, y);
  };

  drawText('恋页 KoiPage', 44, 56, 20, 600, '#755484');
  drawText(`${month}游玩回顾`, 44, 116, 40, 700, '#32233d');
  metrics.forEach(({ label, value }, index) => {
    const x = 44 + 268 * index;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.roundRect(x, 146, 256, 96, 14);
    ctx.fill();
    drawText(label, x + 16, 177, 17, 500, '#755484');
    drawText(value, x + 16, 215, 26, 700, '#32233d', 224);
  });
  drawText('最常游玩的作品', 44, 291, 24, 700, '#32233d');
  entries.forEach(({ title, duration }, index) => {
    const y = 344 + 58 * index;
    drawText(`${index + 1}`, 44, y, 20, 600, '#755484');
    drawText(title, 84, y, 22, 600, '#32233d', 530);
    ctx.textAlign = 'right';
    drawText(duration, 836, y, 20, 600, '#755484', 190);
    ctx.textAlign = 'left';
  });
  if (works.length > exportLimit) drawText(`还有 ${works.length - exportLimit} 部作品`, 44, canvas.height - 27, 17, 500, '#755484');
  return new Promise((resolve, reject) => canvas.toBlob(blob => {
    if (blob) resolve(blob);
    else reject(new Error('无法生成 PNG 图片'));
  }, 'image/png'));
}

interface MonthlyReviewProps {
  now: Date;
  setNow: (date: Date) => void;
  refreshKey: string;
  gamesById: ReadonlyMap<number, Game>;
  currentMonth: PlayTimeSeries;
  currentLoading: boolean;
  currentError: string | null;
  retryCurrent: () => void;
  onClose: () => void;
}

export function MonthlyReview({ now, setNow, refreshKey, gamesById, currentMonth, currentLoading, currentError, retryCurrent, onClose }: MonthlyReviewProps) {
  const [month, setMonth] = useState('current');
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<{ error: boolean; text: string } | null>(null);
  const previous = month === 'previous';
  const previousMonth = useMemo(() => movePlayTimePeriod(now, 'month', -1, now), [now]);
  const previousResult = usePeriodSessions(playTimePeriodWindow(previousMonth, 'month'), refreshKey, attempt, setNow, previous);
  const loading = previous ? previousResult.loading : currentLoading;
  const error = previous ? previousResult.error : currentError;
  const result = previous && !loading && !error ? buildPlayTimeSummary(previousResult.sessions, now, previousMonth).month : currentMonth;
  const label = (previous ? previousMonth : now).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long' });
  const metrics = [
    { label: '总游玩时长', value: formatPlayDuration(result.totalSeconds) },
    { label: '游玩天数', value: `${result.activeDays} 天` },
    { label: '游玩作品', value: `${result.gameCount} 部` },
  ];
  const works = result.games.map(({ gameId, seconds }) => {
    const game = gamesById.get(gameId);
    return { gameId, title: game?.title ?? '已移除的作品', duration: formatPlayDuration(seconds), available: Boolean(game) };
  });

  const exportReview = async () => {
    setSaving(true);
    setSaveStatus(null);
    try {
      const image = await renderReview(label, metrics, works);
      if (await saveShare([image], `${label}游玩回顾`)) setSaveStatus({ error: false, text: '回顾图片已保存。' });
    } catch (cause) {
      setSaveStatus({ error: true, text: `保存失败：${String(cause)}` });
    } finally {
      setSaving(false);
    }
  };

  return <Dialog open title="月度游玩回顾" onClose={() => { if (!saving) onClose(); }} footer={
    <Button size="sm" loading={saving} disabled={loading || Boolean(error) || !works.length} onClick={() => void exportReview()}>导出 PNG</Button>
  }>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-lg font-semibold" aria-live="polite">{label}</p>
      <Tabs label="回顾月份" className="w-40" value={month} items={months} onValueChange={value => {
        if (!saving) { setMonth(value); setSaveStatus(null); }
      }} />
    </div>
    {loading ? <p role="status" className="mt-4 text-sm text-muted-foreground">正在读取游玩记录…</p>
      : error ? <div role="alert" className="mt-4 space-y-2 text-sm">
        <p className="text-destructive">读取回顾失败：{error}</p>
        <Button size="sm" variant="outline" onClick={previous ? () => setAttempt(value => value + 1) : retryCurrent}>重试</Button>
      </div> : <>
        <dl className="mt-4 grid grid-cols-3 gap-2">
          {metrics.map(metric => <div key={metric.label} className="rounded-lg border border-border bg-primary/5 px-3 py-3">
            <dt className="text-xs text-muted-foreground">{metric.label}</dt>
            <dd className="mt-1 break-words text-sm font-semibold tabular-nums text-primary">{metric.value}</dd>
          </div>)}
        </dl>
        {works.length ? <>
          <h3 className="mt-4 text-sm font-semibold">最常游玩的作品</h3>
          <ol className="mt-2 divide-y divide-border">
            {works.map((work, index) => <li key={work.gameId} className="flex min-w-0 items-center gap-2 py-2 text-sm">
              <span className="w-6 shrink-0 text-xs tabular-nums text-muted-foreground">{index + 1}.</span>
              {work.available ? <Link to={`/library/${work.gameId}?tab=history`} title={work.title} className="min-w-0 flex-1 truncate rounded hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{work.title}</Link>
                : <span className="min-w-0 flex-1 truncate">{work.title}</span>}
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{work.duration}</span>
            </li>)}
          </ol>
        </> : <p className="mt-4 text-sm text-muted-foreground">这个月还没有已结算的游玩记录。</p>}
      </>}
    {saveStatus ? <p role={saveStatus.error ? 'alert' : 'status'} className={`mt-3 text-xs ${saveStatus.error ? 'text-destructive' : 'text-muted-foreground'}`}>{saveStatus.text}</p> : null}
  </Dialog>;
}
