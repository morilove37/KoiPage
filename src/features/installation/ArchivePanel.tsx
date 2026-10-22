import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/dialog';
import { useAppStore } from '@/store/app';
import { loadInstallationState, setGameArchived, useGameInstallation } from './store';

export function ArchivePanel({ gameId, onChanged }: { gameId: number; onChanged?: () => void }) {
  const { archived, loaded, saving, error: loadError } = useGameInstallation(gameId);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const process = useAppStore(state => state.gameProcesses[gameId]);
  const running = process?.status === 'running' || process?.status === 'starting';
  async function change(next: boolean) {
    setError(null); setNotice(null);
    try {
      await setGameArchived(gameId, next);
      setConfirm(false);
      setNotice(next ? '已标记为已卸载，库记录与游玩历史已保留。' : '路径检查通过，已恢复为已安装。');
      onChanged?.();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  return <Card><CardHeader><CardTitle>安装状态 <Badge variant="outline">{loaded ? archived ? '已卸载 / 已归档' : '已安装' : '载入中…'}</Badge></CardTitle></CardHeader><CardContent className="space-y-3">
    <p className="text-xs leading-relaxed text-muted-foreground">卸载游戏后可将记录归档，保留封面、标签、评分、游玩历史和存档快照。此操作只标记安装状态，不会删除磁盘上的游戏或存档文件。</p>
    {archived ? <p className="text-xs text-muted-foreground">重新安装后，先在启动设置中更新并保存安装目录与启动程序，再恢复为已安装。恢复时会检查已保存的路径。</p> : null}
    <Button size="sm" variant="outline" disabled={!loaded || saving || running} loading={saving} onClick={() => archived ? void change(false) : setConfirm(true)}>{archived ? '恢复为已安装' : '标记为已卸载并归档'}</Button>
    {running ? <p className="text-xs text-muted-foreground">请先退出游戏再更改安装状态。</p> : null}
    {notice ? <p role="status" className="text-xs text-primary">{notice}</p> : null}
    {error || loadError ? <p role="alert" className="text-xs text-destructive">{error || loadError}</p> : null}
    {!loaded && loadError ? <Button size="sm" variant="outline" onClick={() => void loadInstallationState().catch(() => {})}>重试载入</Button> : null}
    <ConfirmDialog open={confirm} title="标记为已卸载并归档？" description="不会删除任何游戏或存档文件。该游戏的库记录、封面、标签、评分、游玩历史及存档快照全部保留；重新安装后可以恢复。" confirmText="确认归档" busy={saving} onCancel={() => { if (!saving) setConfirm(false); }} onConfirm={() => void change(true)} />
  </CardContent></Card>;
}
