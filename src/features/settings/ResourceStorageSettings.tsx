import { useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { invoke } from '@/lib/logging';

interface StorageInfo {
  directory: string;
  databasePath: string;
  available: boolean;
  copiedFiles: number;
  restartRequired: boolean;
  pendingDirectory: string | null;
}

function storageError(cause: unknown): string {
  const message = String(cause);
  return /resource_storage_.*not found|not found.*resource_storage_/i.test(message)
    ? '当前运行的程序不支持资源目录设置，请使用包含此功能的版本后重试。'
    : message;
}

export function ResourceStorageSettings() {
  const [info, setInfo] = useState<StorageInfo | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void invoke<StorageInfo>('resource_storage_info')
      .then(value => { if (active) setInfo(value); })
      .catch(cause => { if (active) setError(storageError(cause)); });
    return () => { active = false; };
  }, []);

  async function choose() {
    setBusy(true); setError(null); setNotice(null);
    try {
      const path = await open({ directory: true, multiple: false, title: '选择数据存储位置（将在其中创建恋页专用子目录）' });
      if (typeof path === 'string') setSelected(path);
    } catch (cause) { setError(storageError(cause)); }
    finally { setBusy(false); }
  }

  async function migrate() {
    if (!selected) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await invoke<StorageInfo>('resource_storage_change', { parentPath: selected });
      setInfo(result); setSelected(null);
      setNotice(`已复制并校验 ${result.copiedFiles} 个资源文件及完整数据库。新目录将在重启后生效，当前已暂停数据读写。原数据库和文件均已保留。`);
    } catch (cause) { setError(storageError(cause)); }
    finally { setBusy(false); }
  }

  async function restart() {
    setBusy(true); setError(null);
    try { await invoke<void>('resource_storage_restart'); }
    catch (cause) { setError(storageError(cause)); setBusy(false); }
  }

  return <div className="space-y-3 rounded-md border border-border p-4" aria-busy={busy}>
    <h3 className="text-sm font-medium">数据存储位置</h3>
    <p className="text-xs text-muted-foreground">可自定义数据库、游戏简介、收藏记录、设置、封面、自定义封面、会社 Logo、角色头像及完整备份恢复资源的位置。选择文件夹后，会在其中创建专用子目录，复制校验后通过重启切换。</p>
    <p className="text-xs text-muted-foreground">请先退出正在运行的游戏，并等待图片处理、生日同步和资料更新完成。游戏安装文件、普通存档快照、系统保存的登录凭据及日志保留各自位置。原配置目录保留启动位置记录，旧数据库和文件作为恢复副本保留。</p>
    {info ? <dl className="space-y-1 text-xs text-muted-foreground">
      <div><dt className="inline">当前资源目录：</dt><dd className="inline break-all">{info.directory}</dd></div>
      <div><dt className="inline">数据库：</dt><dd className="inline break-all">{info.databasePath}</dd></div>
    </dl> : null}
    {info && !info.available ? <p role="alert" className="text-xs text-destructive">当前资源目录不可用。请先连接原磁盘或恢复目录，再迁移已有资源。</p> : null}
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" disabled={busy || !info || !info.available || info.restartRequired} onClick={() => void choose()}>选择新位置</Button>
    </div>
    {selected ? <div className="space-y-2 rounded-md bg-muted/40 p-3">
      <p className="break-all text-xs">新位置：{selected}</p>
      <p className="text-xs text-muted-foreground">迁移期间请保持应用打开。准备完成后将暂停数据读写，重启后使用新目录。原数据库与文件会保留，准备失败时恢复使用原数据库。</p>
      <div className="flex gap-2">
        <Button disabled={busy} onClick={() => void migrate()}>{busy ? '正在复制并校验…' : '迁移数据库和资源'}</Button>
        <Button variant="ghost" disabled={busy} onClick={() => setSelected(null)}>取消</Button>
      </div>
    </div> : null}
    {notice ? <p role="status" className="text-xs text-muted-foreground">{notice}</p> : null}
    {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    <Dialog open={Boolean(info?.restartRequired)} onClose={() => {}} title="数据迁移已准备完成"
      description="重启恋页后使用新的数据库和资源目录。"
      footer={<Button disabled={busy} onClick={() => void restart()}>{busy ? '正在重启…' : '重启恋页并生效'}</Button>}>
      <p className="text-sm leading-relaxed">数据库及资源已校验完成，当前已暂停数据读写。请重启恋页；原数据库和文件仍保留在原位置。</p>
      {info?.pendingDirectory ? <p className="mt-3 break-all text-xs text-muted-foreground">新目录：{info.pendingDirectory}</p> : null}
      <p className="mt-3 text-xs text-muted-foreground">若无法自动重启，请完全退出恋页（包括托盘）后重新打开。</p>
      {error ? <p role="alert" className="mt-3 text-xs text-destructive">{error}</p> : null}
    </Dialog>
  </div>;
}
