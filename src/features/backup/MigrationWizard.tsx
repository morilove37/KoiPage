import { useState } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import { invoke } from '@/lib/logging';
import { initDatabase } from '@/lib/db';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { formatSnapshotSize } from '@/features/save-backups/model';
import { backupSummary, type BackupPreview } from './model';

interface Estimate { games: number; sessions: number; assets: number; saveSnapshots: number; saveBytes: number; estimatedBytes: number; }

export function MigrationWizard({ onClose }: { onClose: () => void }) {
  const [includeSaves, setIncludeSaves] = useState(true);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [output, setOutput] = useState('');

  async function preview() {
    setBusy(true); setError('');
    try {
      await initDatabase();
      setEstimate(await invoke<Estimate>('backup_estimate', { includeSaveSnapshots: includeSaves }));
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }
  async function create() {
    setBusy(true); setError('');
    try {
      const now = new Date();
      const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const path = await save({ defaultPath: `恋页迁移-${day}.koibak`, filters: [{ name: '恋页迁移备份', extensions: ['koibak'] }] });
      if (!path) return;
      const result = await invoke<BackupPreview>('backup_create', { path, includeSaveSnapshots: includeSaves });
      setOutput(`${backupSummary(result)}。保存至 ${path}`);
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }
  return <Dialog open title="迁移到新电脑" onClose={() => { if (!busy) onClose(); }} description="将收藏、设置、图片与已备份的存档一起带走。" footer={output ? <Button onClick={onClose}>完成</Button> : <><Button variant="outline" disabled={busy} onClick={onClose}>取消</Button>{estimate ? <><Button variant="outline" disabled={busy} onClick={() => setEstimate(null)}>返回选择</Button><Button loading={busy} onClick={() => void create()}>导出迁移包…</Button></> : <Button loading={busy} onClick={() => void preview()}>校验并预览</Button>}</>}>
    {output ? <div className="space-y-3 text-sm"><p role="status" className="break-all text-primary">{output}</p><ol className="list-decimal space-y-2 pl-5"><li>将迁移包和游戏本体分别复制到新电脑。</li><li>在新电脑的「完整备份与恢复」中选择迁移包并预览，确认后完全退出再打开恋页。</li><li>通过「路径检查与修复」修正游戏路径；需要恢复存档时，先设置新电脑的实际存档位置。</li></ol></div> : <div className="space-y-4 text-sm">
      <p>包含游戏资料、标签、文件夹、游玩记录、设置和本地图片。</p>
      <label className="flex items-start gap-2"><input type="checkbox" checked={includeSaves} disabled={busy || estimate !== null} onChange={e => setIncludeSaves(e.target.checked)} /><span>包含已创建的存档快照<span className="mt-1 block text-xs text-muted-foreground">只迁移已备份的快照。请先为需要带走的最新存档创建快照；不会直接复制游戏本体或当前存档。</span></span></label>
      {estimate ? <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm"><p>{estimate.games} 款游戏 · {estimate.sessions} 条游玩记录 · {estimate.assets} 张图片</p><p className="mt-2">{includeSaves ? `${estimate.saveSnapshots} 个存档快照 · ${formatSnapshotSize(estimate.saveBytes)}` : '未选择迁移存档快照'}</p><p className="mt-2 font-medium">预计体积 {formatSnapshotSize(estimate.estimatedBytes)}</p><p className="mt-1 text-xs text-muted-foreground">已校验本地图片和快照内容。实际大小以导出结果为准；导出时会重新读取并校验。</p></div> : null}
      <p className="text-xs leading-relaxed text-muted-foreground">导出和恢复前请关闭正在运行的游戏。迁移包包含个人设置、备注及可能配置的服务密钥，请妥善保存。恢复时替换目标电脑的游戏库，实际游戏存档仍需按需手动恢复。</p>
    </div>}
    {error ? <p role="alert" className="mt-3 break-all text-sm text-destructive">{error}</p> : null}
  </Dialog>;
}
