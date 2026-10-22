import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { initDatabase } from '@/lib/db';
import { backupSummary, canRestore, type BackupPreview } from './model';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

const filters = [{ name: '恋页完整备份', extensions: ['koibak'] }];
const button = 'rounded-lg border border-border px-3 py-2 text-xs font-medium hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50';

export function BackupPanel() {
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<BackupPreview | null>(null);
  const [path, setPath] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [prepared, setPrepared] = useState(false);
  useEffect(() => {
    let active = true;
    void invoke<string | null>('backup_restore_notice').then(notice => {
      if (active && notice) setError(notice);
    }).catch(() => {});
    return () => { active = false; };
  }, []);

  async function perform(action: () => Promise<void>) {
    setBusy(true); setError(''); setMessage('');
    try { await initDatabase(); await action(); }
    catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }
  function create() {
    void perform(async () => {
      const dest = await save({ defaultPath: `恋页备份-${new Date().toISOString().slice(0, 10)}.koibak`, filters });
      if (!dest) return;
      const result = await invoke<BackupPreview>('backup_create', { path: dest });
      setMessage(`已创建完整备份：${backupSummary(result)}。保存至 ${dest}`);
    });
  }
  function inspect() {
    void perform(async () => {
      const source = await open({ multiple: false, directory: false, filters });
      if (!source || typeof source !== 'string') return;
      setPreview(null); setConfirmed(false); setPath('');
      const result = await invoke<BackupPreview>('backup_preview', { path: source });
      setPath(source); setPreview(result);
    });
  }
  function restore() {
    if (!canRestore(preview, confirmed, busy) || !preview) return;
    void perform(async () => {
      const result = await invoke<{ safetyBackup: string; restartRequired: boolean }>('backup_restore_prepare', { path, confirmed, expectedSha256: preview.archiveSha256 });
      setPrepared(true);
      setMessage(`恢复已准备完成。请完全退出恋页（包括托盘）后重新打开；恢复将在启动时生效。当前数据的安全备份：${result.safetyBackup}。退出前请勿继续编辑数据。`);
    });
  }
  return <div className="mt-5 border-t border-border pt-4">
    <h3 className="text-sm font-medium">完整备份与恢复</h3>
    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">保存数据库、游戏封面、角色生日头像与自定义背景。包含设置和游玩记录，不包含游戏本体、实际存档及存档快照文件。实际存档请在游戏详情的「存档备份」中单独备份，迁移电脑时也需复制该备份目录。备份与恢复前请结束正在运行的游戏。</p>
    <div className="mt-3 flex flex-wrap gap-2">
      <button type="button" className={button} disabled={busy || prepared} onClick={create}>{busy ? '处理中…' : '创建完整备份…'}</button>
      <button type="button" className={button} disabled={busy || prepared} onClick={inspect}>选择备份并预览…</button>
    </div>
    {preview && !prepared ? <div className="mt-3 rounded-lg border border-border bg-background/50 p-3 text-xs">
      <p className="font-medium">{backupSummary(preview)}</p>
      <p className="mt-1 text-muted-foreground">创建于 {new Date(preview.createdAt).toLocaleString()} · 恋页 {preview.appVersion} · 已通过数据库、图片及 SHA-256 校验</p>
      <p className="mt-1 break-all text-muted-foreground">{path}</p>
      <label className="mt-3 flex items-start gap-2"><input type="checkbox" className="mt-0.5" checked={confirmed} disabled={busy} onChange={e => setConfirmed(e.target.checked)} /><span>我确认用此备份替换当前全部数据。恋页会先保存当前数据的安全备份，恢复在完全退出并重新启动后生效。</span></label>
      <button type="button" className={`${button} mt-3 border-destructive/40 text-destructive`} disabled={!canRestore(preview, confirmed, busy)} onClick={restore}>确认恢复并准备重启</button>
    </div> : null}
    {message ? <p role="status" className="mt-3 break-all text-xs leading-relaxed text-primary">{message}</p> : null}
    {error ? <p role="alert" className="mt-3 break-all text-xs text-destructive">{error}</p> : null}
    <Dialog open={prepared} onClose={() => {}} title="恢复已准备完成" description="完全退出后重新打开恋页，应用校验通过的备份。" footer={<Button loading={busy} onClick={() => void perform(async () => { await invoke('app_quit'); })}>退出恋页</Button>}>
      <p className="break-all text-sm leading-relaxed">{message}</p><p className="mt-3 text-xs text-muted-foreground">当前数据已单独保存。恢复前请先退出，避免继续编辑的内容被覆盖。</p>{error ? <p role="alert" className="mt-3 text-xs text-destructive">{error}</p> : null}
    </Dialog>
  </div>;
}
