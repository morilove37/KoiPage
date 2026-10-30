import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { initDatabase } from '@/lib/db';
import { invoke } from '@/lib/logging';
import { errorMessage } from '@/features/io/io';
import { acceptRefreshState, isRefreshActive } from './metadata-refresh-state';
import type { RefreshPhase, RefreshState } from './metadata-refresh-state';

const phaseLabels: Record<RefreshPhase, string> = {
  idle: '尚未运行', backingUp: '正在备份，尚未改写资料', running: '正在刷新资料',
  completed: '刷新完成', stopped: '已停止，已应用的资料仍保留', failed: '刷新未完成',
};
const overwriteWarning = '将覆盖已有游戏名、原名、开发商、发售日期、公共评分和简介，并合并标签。';

export function MetadataRefreshPanel() {
  const [state, setState] = useState<RefreshState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [stopRequested, setStopRequested] = useState(false);
  const [retry, setRetry] = useState(0);
  const lifetime = useRef(0);
  const actionPending = useRef(false);
  const active = isRefreshActive(state);

  useEffect(() => {
    const generation = ++lifetime.current;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    setReady(false);
    setError(null);
    const accept = (next: RefreshState) => {
      if (!disposed && generation === lifetime.current) setState(current => acceptRefreshState(current, next));
    };
    void (async () => {
      await initDatabase();
      if (disposed) return;
      // Subscribe first: the job may finish while the status request is in flight.
      const cleanup = await listen<RefreshState>('metadata-refresh-progress', event => accept(event.payload));
      if (disposed) { cleanup(); return; }
      unlisten = cleanup;
      accept(await invoke<RefreshState>('metadata_refresh_status'));
      if (!disposed) setReady(true);
    })().catch(cause => { if (!disposed) setError(errorMessage(cause)); });
    return () => { disposed = true; lifetime.current++; unlisten?.(); };
  }, [retry]);

  useEffect(() => { if (!active) setStopRequested(false); }, [active]);

  async function start() {
    if (actionPending.current || !ready || active) return;
    actionPending.current = true;
    const generation = lifetime.current;
    setBusy(true); setError(null); setConfirmOpen(false); setStopRequested(false);
    try {
      const next = await invoke<RefreshState>('metadata_refresh_start', { confirmed: true });
      if (generation === lifetime.current) setState(current => acceptRefreshState(current, next));
    } catch (cause) {
      if (generation === lifetime.current) setError(errorMessage(cause));
    } finally {
      actionPending.current = false;
      if (generation === lifetime.current) setBusy(false);
    }
  }

  async function stop() {
    if (actionPending.current || !active) return;
    actionPending.current = true;
    const generation = lifetime.current;
    setBusy(true); setError(null); setStopRequested(true);
    try {
      const next = await invoke<RefreshState>('metadata_refresh_cancel');
      if (generation === lifetime.current) setState(current => acceptRefreshState(current, next));
    } catch (cause) {
      if (generation === lifetime.current) { setError(errorMessage(cause)); setStopRequested(false); }
    } finally {
      actionPending.current = false;
      if (generation === lifetime.current) setBusy(false);
    }
  }

  const unresolved = state?.outcomes.filter(outcome => outcome.status !== 'updated') ?? [];
  return <div className="mt-5 space-y-3 border-t border-border pt-4">
    <h3 className="text-sm font-semibold">一键资料焕新</h3>
    <p className="text-sm leading-relaxed text-muted-foreground">按当前启用的数据源、默认源和标题语言设置，重新获取游戏库中已有作品的资料；简介按当前中文简介优先设置获取。</p>
    <p className="text-sm leading-relaxed text-amber-600 dark:text-amber-400">{overwriteWarning}</p>
    <p className="text-xs leading-relaxed text-muted-foreground">保留游戏路径、游玩状态与时长、私人备注、存档、封面、我的评分及 Bangumi 短评；已有外部 ID 保持不变。只要启用了 Bangumi 数据源，就会尝试补全缺失的 Bangumi ID，不受默认数据源选择影响；匹配不明确的作品会列为待确认，不会强行绑定。</p>
    <p className="text-xs leading-relaxed text-muted-foreground">部分成人条目需要 Bangumi 个人令牌才能检索。可在「设置 → Bangumi 同步」验证并保存令牌，资料查询会自动使用该令牌；无需开启双向自动同步。</p>
    <p className="text-xs leading-relaxed text-muted-foreground">请先退出正在运行的游戏。开始改写前会自动生成资料库 .koibak 备份；备份失败则中止。若已开启 Bangumi 自动同步，新绑定的作品可能在本批次完成后参与同步。</p>
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" disabled={!ready || busy || active} onClick={() => setConfirmOpen(true)}>{state && state.phase !== 'idle' ? '重新焕新全部资料' : '一键资料焕新'}</Button>
      {active && <Button type="button" variant="outline" disabled={busy || stopRequested} onClick={() => void stop()}>{stopRequested ? '正在等待停止…' : '停止刷新'}</Button>}
      {!ready && !error && <span className="text-xs text-muted-foreground">正在读取刷新任务…</span>}
    </div>
    {state && state.phase !== 'idle' && <div className="space-y-2 rounded-md border border-border p-3">
      <div role="status" aria-live="polite" className="space-y-1 text-sm">
        <p className="font-medium">{phaseLabels[state.phase]}{stopRequested && active ? ' · 已请求停止' : ''}</p>
        <p>{state.processed} / {state.total} 款 · 已更新 {state.updated} · 待确认 {state.needsReview} · 失败 {state.failed} · 跳过 {state.skipped}</p>
        {state.currentTitle && active && <p className="break-words text-xs text-muted-foreground">当前作品：{state.currentTitle}</p>}
      </div>
      <progress aria-label="资料刷新进度" max={Math.max(1, state.total)} value={state.processed} className="h-2 w-full accent-primary" />
      {state.backupPath && <p className="break-all text-xs text-muted-foreground">本次资料库备份：<span className="select-text">{state.backupPath}</span></p>}
      {state.needsReview > 0 && <p className="text-xs text-muted-foreground">待确认也可能包含资料已更新、Bangumi ID 仍待匹配的作品。</p>}
      {unresolved.length > 0 && <details open className="text-sm"><summary className="cursor-pointer font-medium">待处理与跳过详情（{unresolved.length}）</summary><ul className="mt-2 max-h-72 space-y-2 overflow-y-auto">{unresolved.map((outcome, index) => <li key={`${outcome.gameId}-${index}`} className="rounded-md border border-border p-2">
        <p><Link to={`/library/${outcome.gameId}`} className="text-primary underline">{outcome.title}</Link><span className="ml-2 text-xs text-muted-foreground">{outcome.status === 'needsAuthorization' ? '需配置令牌' : outcome.status === 'needsReview' ? '待确认' : outcome.status === 'failed' ? '失败' : '已跳过'}</span></p>
        <p className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">{outcome.message}</p>
      </li>)}</ul></details>}
    </div>}
    {active && <p className="text-xs leading-relaxed text-muted-foreground">离开设置页后任务仍会继续。停止会等待当前网络请求结束，在下一次改写前停止；已经应用的资料不会撤回。</p>}
    {(error || state?.error) && <div role="alert" className="space-y-2 text-sm text-destructive"><p className="whitespace-pre-wrap break-words">{error || state?.error}</p>{!active && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setRetry(value => value + 1)}>重新读取任务状态</Button>}</div>}
    <ConfirmDialog open={confirmOpen} title="确认刷新已有游戏资料？" confirmText="备份并开始刷新" busy={busy} onCancel={() => setConfirmOpen(false)} onConfirm={() => void start()} description={<div className="space-y-3">
      <p>{overwriteWarning}这会替换你手动编辑过的对应资料。</p>
      <p>将先生成完整 .koibak 备份，备份失败不会改写。游戏路径、状态、时长、私人备注、存档、封面及个人评分和短评会保留。</p>
      <p>启用 Bangumi 源时还会补全可信的缺失 ID；若已开启自动同步，新绑定作品可能在刷新完成后参与同步。</p>
    </div>} />
  </div>;
}
