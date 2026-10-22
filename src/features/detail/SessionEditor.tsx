import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import type { PlaySession } from '@/types/game';
import { deleteSession, saveSession, settleOrphanSession } from './session-api';

function localDate(value: string) {
  const parsed = new Date(value);
  const date = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
}

export default function SessionEditor({ gameId, session, onClose }: { gameId: number; session?: PlaySession; onClose?: () => void }) {
  const [open, setOpen] = useState(Boolean(session));
  const [start, setStart] = useState(() => localDate(session?.startedAt ?? new Date().toISOString()));
  const [seconds, setSeconds] = useState(String(session?.durationSeconds ?? 0));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  function close() {
    setOpen(false);
    onClose?.();
  }
  function show() {
    setStart(localDate(new Date().toISOString()));
    setSeconds('0');
    setError(''); setConfirmDelete(false); setOpen(true);
  }
  async function act(action: () => Promise<unknown>) {
    setBusy(true); setError('');
    try { await action(); close(); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }
  return <>
    {!session && <Button size="sm" variant="outline" onClick={show}>补记游玩</Button>}
    <Dialog open={open} onClose={() => { if (!busy) close(); }} title={session ? '修正游玩记录' : '补记游玩记录'}
      description="填写实际游玩时长；结束时间按开始时间和时长计算。累计时长将同步调整。"
      footer={<><Button variant="ghost" disabled={busy} onClick={close}>取消</Button><Button disabled={busy || !start || !Number.isSafeInteger(Number(seconds)) || Number(seconds) < 0} onClick={() => void act(() => saveSession({ id: session?.id, gameId, startedAt: new Date(start).toISOString(), durationSeconds: Number(seconds) }))}>{busy ? '处理中…' : '保存记录'}</Button></>}>
      <div className="space-y-3">
        <label className="block text-sm">开始时间<input aria-label="开始时间" type="datetime-local" step="1" className="mt-1 w-full rounded-md border bg-background p-2" value={start} onChange={event => setStart(event.target.value)} disabled={busy} /></label>
        <label className="block text-sm">实际时长（秒）<input aria-label="实际时长（秒）" type="number" min="0" max="315576000" step="1" autoFocus className="mt-1 w-full rounded-md border bg-background p-2" value={seconds} onChange={event => setSeconds(event.target.value)} disabled={busy} /></label>
        {session && !session.endedAt && <div className="space-y-2 text-xs text-muted-foreground"><p>未结束记录可按最后保存的时长结算。运行中的游戏需先结束，才能修改或删除。</p><Button variant="outline" disabled={busy} onClick={() => void act(() => settleOrphanSession(session.id))}>按已保存时长结算</Button></div>}
        {session && <div className="rounded border border-destructive/30 p-2 text-xs">{confirmDelete ? <><p className="mb-2">删除后将从累计时长中扣除此记录，确定删除？</p><Button variant="destructive" disabled={busy} onClick={() => void act(() => deleteSession(session.id))}>确定删除记录</Button></> : <Button variant="ghost" disabled={busy} onClick={() => setConfirmDelete(true)}>删除此记录</Button>}</div>}
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      </div>
    </Dialog>
  </>;
}
