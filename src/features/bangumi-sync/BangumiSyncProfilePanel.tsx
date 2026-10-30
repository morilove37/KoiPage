import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { errorMessage } from '@/features/io/io';
import { syncPause, syncProfile, syncResolve, syncRun, syncSaveProfile } from './api';
import type { SyncItem } from './api';
import { profileDraft, profileInput, rebaseProfileDraft } from './model';
import type { ProfileDraft } from './model';
import { SyncConflictPanel } from './SyncConflictPanel';
import { useSyncEvents } from './useSyncEvents';

export function BangumiSyncProfilePanel({ gameId }: { gameId: number }) {
  const [item, setItem] = useState<SyncItem | null>(null);
  const [draft, setDraft] = useState<ProfileDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const dirty = useRef(false);
  const alive = useRef(true);
  const request = useRef(0);
  const refresh = useCallback(() => {
    const currentRequest = ++request.current;
    void syncProfile(gameId).then(next => {
      if (!alive.current || currentRequest !== request.current) return;
      setItem(next);
      setDraft(current => dirty.current && current ? rebaseProfileDraft(next, current) : profileDraft(next));
    }).catch(cause => { if (alive.current && currentRequest === request.current) setError(errorMessage(cause)); });
  }, [gameId]);
  useEffect(() => {
    alive.current = true; dirty.current = false; setItem(null); setDraft(null); refresh();
    return () => { alive.current = false; request.current++; };
  }, [refresh]);
  useSyncEvents(refresh);
  function edit(patch: Partial<ProfileDraft>) { dirty.current = true; setDraft(current => current ? { ...current, ...patch } : current); setNotice(null); }
  async function act(action: () => Promise<SyncItem>, message: string) {
    if (busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const next = await action();
      if (alive.current) { request.current++; setItem(next); dirty.current = false; setDraft(profileDraft(next)); setNotice(message); }
    } catch (cause) { if (alive.current) { setError(errorMessage(cause)); refresh(); } }
    finally { if (alive.current) setBusy(false); }
  }
  return <Card><CardHeader><CardTitle>Bangumi 个人记录与同步</CardTitle></CardHeader><CardContent className="space-y-3">
    <p className="text-xs leading-relaxed text-muted-foreground">这里的「我的评分」和「Bangumi 短评」与社区评分、私人备注分开保存。启用账号同步后，这些个人记录及已保存的游玩状态可双向同步。在设置中连接账号并开启自动同步。</p>
    {!draft || !item ? <p className="text-sm text-muted-foreground">正在读取个人记录…</p> : <>
      <fieldset disabled={busy} className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm"><span>Bangumi 数字 ID</span><Input inputMode="numeric" value={draft.subjectId} onChange={event => edit({ subjectId: event.target.value, subjectEdited: true })} placeholder="例如 12345；留空解除绑定" /></label>
        <label className="space-y-1 text-sm"><span>我的评分（0–10 整数）</span><Input type="number" min={0} max={10} step={1} value={draft.rate} onChange={event => edit({ rate: event.target.value, rateEdited: true })} placeholder="尚无个人评分；0 表示未评分" /></label>
        <label className="space-y-1 text-sm sm:col-span-2"><span>Bangumi 短评</span><Textarea value={draft.comment} onChange={event => edit({ comment: event.target.value, commentEdited: true })} placeholder="会同步到 Bangumi，请勿填写私人备注" /></label>
        <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" role="switch" className="accent-primary" checked={draft.enabled} onChange={event => edit({ enabled: event.target.checked, enabledEdited: true })} />允许本款作品参与同步</label>
      </fieldset>
      {!draft.subjectId.trim() && <p className="text-xs text-muted-foreground">填写正确的 Bangumi 游戏条目 ID 后才会同步，不会自动按名称匹配。</p>}
      <div className="flex flex-wrap items-center gap-3"><Button type="button" disabled={busy} onClick={() => void act(() => syncSaveProfile(profileInput(item, draft)), '本款同步设置与个人记录已保存。')}>{busy ? '处理中…' : '保存个人记录与同步设置'}</Button><span className="text-xs text-muted-foreground">独立保存，不影响上方未保存的基本信息。</span></div>
      <p className="text-xs text-muted-foreground">上次成功同步：{item.lastSyncedAt ?? '尚未同步'}{!item.enabled ? ' · 本款已暂停' : ''}</p>
      {item.error && <p role="alert" className="break-words text-sm text-destructive">{item.error}</p>}
      {dirty.current && item.conflict && <p className="text-xs text-muted-foreground">请先保存个人记录，再处理同步冲突。</p>}
      <SyncConflictPanel item={item} busy={busy || dirty.current} resolve={choice => void act(async () => {
        await syncResolve(gameId, choice); await syncRun(true); return syncProfile(gameId);
      }, '冲突选择已保存，并已尝试同步。')} pause={() => void act(() => syncPause(gameId), '本款作品已暂停同步。')} />
    </>}
    {error && <div role="alert" className="space-y-2 text-sm text-destructive"><p>{error}</p><Button type="button" size="sm" variant="outline" disabled={busy} onClick={refresh}>重新读取</Button></div>}
    {notice && <p role="status" className="text-sm text-emerald-500">{notice}</p>}
  </CardContent></Card>;
}
