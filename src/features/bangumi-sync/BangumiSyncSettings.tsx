import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { errorMessage } from '@/features/io/io';
import { syncConfigure, syncConnect, syncDisconnect, syncItems, syncResolve, syncRun, syncPause, syncStatus } from './api';
import type { SyncItem, SyncStatus } from './api';
import { SyncConflictPanel } from './SyncConflictPanel';
import { useSyncEvents } from './useSyncEvents';

export function BangumiSyncSettings() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [items, setItems] = useState<SyncItem[]>([]);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const alive = useRef(true);
  const refresh = useCallback(() => {
    void Promise.all([syncStatus(), syncItems()]).then(([next, list]) => {
      if (alive.current) { setStatus(next); setItems(list); }
    }).catch(cause => { if (alive.current) setError(errorMessage(cause)); });
  }, []);
  useEffect(() => { alive.current = true; refresh(); return () => { alive.current = false; }; }, [refresh]);
  useSyncEvents(refresh);
  async function act(action: () => Promise<unknown>, message: string) {
    if (busy) return;
    setBusy(true); setError(null); setNotice(null);
    try { await action(); if (alive.current) { setNotice(message); refresh(); } }
    catch (cause) { if (alive.current) setError(errorMessage(cause)); }
    finally { if (alive.current) setBusy(false); }
  }
  const problems = items.filter(item => item.conflict || item.error);
  const unbound = items.filter(item => item.subjectId === null);
  return <div className="space-y-4">
    <p className="text-sm text-muted-foreground">连接后可双向同步已绑定作品的游玩状态、独立的「我的评分」和 Bangumi 短评。社区评分、私人备注、资料标签不会上传；远端独有作品不会自动加入游戏库。</p>
    <div className="space-y-2 rounded-md border border-border p-3">
      <p className="text-sm font-medium">{status?.connected ? `已连接：${status.account?.nickname || status.account?.username || 'Bangumi 用户'}${status.account ? `（${status.account.username}）` : ''}` : '尚未连接 Bangumi'}</p>
      <p className="text-xs text-muted-foreground">令牌仅保存在 Windows 凭据管理器，不进入备份。验证连接不会上传收藏；更换账号或断开后需重新开启自动同步。</p>
      <p className="text-xs text-muted-foreground">已保存令牌也用于 Bangumi 资料搜索及 ID 补全，部分成人条目需要授权才能读取。只获取资料时可以保持自动同步关闭。</p>
      <label className="block space-y-1 text-sm"><span>{status?.connected ? '替换个人访问令牌' : '个人访问令牌'}</span>
        <Input type="password" autoComplete="off" spellCheck={false} value={token} disabled={busy} onChange={event => setToken(event.target.value)} placeholder="粘贴个人访问令牌" />
      </label>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={busy || !token.trim()} onClick={() => void act(async () => { await syncConnect(token.trim()); setToken(''); }, '令牌验证通过，连接已保存。自动同步保持关闭。')}>验证并保存连接</Button>
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void act(() => openUrl('https://next.bgm.tv/demo/access-token'), '已打开 Bangumi 官方令牌生成页面。')}>获取官方个人令牌 ↗</Button>
        {status?.connected && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void act(async () => { await syncDisconnect(); setToken(''); }, '已断开连接并删除保存的令牌。')}>断开连接</Button>}
      </div>
    </div>
    <label className="flex items-start gap-3 rounded-md border border-border p-3 text-sm">
      <input type="checkbox" role="switch" className="mt-1 accent-primary" checked={status?.enabled ?? false} disabled={busy || !status?.connected} onChange={event => void act(() => syncConfigure(event.target.checked, status?.privateNew ?? true), event.target.checked ? '已开启双向自动同步。' : '已关闭自动同步。')} />
      <span><span className="block font-medium">双向自动同步</span><span className="mt-1 block text-xs leading-relaxed text-muted-foreground">开启即允许自动上传状态、我的评分和 Bangumi 短评，也会下载远端修改。默认关闭；开启后约每 {status?.intervalSeconds ?? 120} 秒检查，本地保存后尽快同步。冲突需手动处理。</span></span>
    </label>
    <label className="flex items-center gap-3 text-sm"><input type="checkbox" role="switch" className="accent-primary" checked={status?.privateNew ?? true} disabled={busy || !status} onChange={event => void act(() => syncConfigure(status?.enabled ?? false, event.target.checked), '新建收藏的隐私设置已保存。')} />新建 Bangumi 收藏仅自己可见</label>
    <p className="text-xs text-muted-foreground">隐私开关只影响新建收藏，已有收藏的隐私及标签保持原样。已绑定且参与同步的「未游玩」作品会按「想玩」同步到 Bangumi，本地仍保留「未游玩」。</p>
    <div className="flex flex-wrap items-center gap-3"><Button type="button" disabled={busy || !status?.connected} onClick={() => void act(() => syncRun(true), '本次同步已完成，请查看结果与待处理项。')}>{busy ? '处理中…' : '立即双向同步'}</Button><span className="text-xs text-muted-foreground">手动同步同样可能上传个人记录。</span></div>
    <div className="text-xs text-muted-foreground" aria-live="polite">
      <p>上次运行：{status?.lastRunAt ?? '尚未运行'}</p>
      {status?.lastReport && <p className="mt-1">已同步 {status.lastReport.synced} · 上传 {status.lastReport.uploaded} · 下载 {status.lastReport.downloaded} · 冲突 {status.lastReport.conflicts} · 跳过 {status.lastReport.skipped} · 错误 {status.lastReport.errors}</p>}
    </div>
    {notice && <p role="status" className="text-sm text-emerald-500">{notice}</p>}
    {(error || status?.lastError) && <div role="alert" className="space-y-2 text-sm text-destructive"><p>{error || status?.lastError}</p><Button type="button" size="sm" variant="outline" disabled={busy} onClick={refresh}>重新读取状态</Button></div>}
    {problems.length > 0 && <div className="space-y-3"><h3 className="text-sm font-medium">待处理作品（{problems.length}）</h3>{problems.map(item => <div key={item.gameId} className="space-y-2 rounded-md border border-border p-3">
      <Link to={`/library/${item.gameId}`} className="text-sm font-medium text-primary underline">{item.title}</Link>
      {item.error && <p className="break-words text-xs text-destructive">{item.error}</p>}
      <SyncConflictPanel item={item} busy={busy} resolve={choice => void act(async () => { await syncResolve(item.gameId, choice); await syncRun(true); }, '冲突选择已保存，并已尝试同步。')} pause={() => void act(() => syncPause(item.gameId), '已暂停本款作品的同步。')} />
      {!item.conflict && item.enabled && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void act(() => syncPause(item.gameId), '已暂停本款作品的同步。')}>暂停本款同步</Button>}
    </div>)}</div>}
    {unbound.length > 0 && <details className="text-sm"><summary className="cursor-pointer">{unbound.length} 款作品未绑定 Bangumi ID</summary><p className="my-2 text-xs text-muted-foreground">启用 Bangumi 数据源后，可在「资料匹配」执行资料焕新来补齐可信的 ID；部分成人条目需先保存个人令牌。也可进入作品详情手动填写数字 ID。</p><div className="flex max-h-48 flex-col gap-2 overflow-y-auto">{unbound.map(item => <Link className="text-primary underline" key={item.gameId} to={`/library/${item.gameId}`}>{item.title}</Link>)}</div></details>}
  </div>;
}
