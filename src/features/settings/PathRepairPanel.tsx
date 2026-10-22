import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { PathInput } from '@/components/ui/path-input';
import { Field } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/ui/dialog';
import { ready } from '@/lib/db';
import { invoke } from '@/lib/logging';
import { errorMessage } from '@/features/io/io';
import { useAppStore } from '@/store/app';

interface PathCheck { id: number; title: string; installPath: string; exePath: string | null; state: 'archived' | 'ok' | 'offline' | 'missingFolder' | 'missingExe' }
interface Relocation { id: number; title: string; oldInstallPath: string; newInstallPath: string; newExePath: string | null; newWorkdir: string | null; newSavePath: string | null; ready: boolean; message: string; fingerprint: string }
const stateLabels = { archived: '已卸载 / 已归档', ok: '正常', offline: '磁盘离线或不可访问', missingFolder: '安装目录缺失', missingExe: '启动文件缺失' };

export function PathRepairPanel() {
  const [checks, setChecks] = useState<PathCheck[] | null>(null);
  const [oldRoot, setOldRoot] = useState('');
  const [newRoot, setNewRoot] = useState('');
  const [preview, setPreview] = useState<Relocation[] | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const bump = useAppStore(state => state.bumpPlayTimeRevision);
  async function operation(action: () => Promise<void>) {
    setBusy(true); setError(null); setNotice(null);
    try { await ready; await action(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  async function check() { await operation(async () => { setChecks(await invoke<PathCheck[]>('game_paths_check')); }); }
  async function inspect() { await operation(async () => {
    const rows = await invoke<Relocation[]>('game_paths_preview', { oldRoot, newRoot });
    setPreview(rows); setSelected(new Set(rows.filter(row => row.ready).map(row => row.id)));
  }); }
  async function apply() { setConfirm(false); await operation(async () => {
    const expected = (preview ?? []).filter(row => selected.has(row.id)).map(row => ({ id: row.id, fingerprint: row.fingerprint }));
    const count = await invoke<number>('game_paths_apply', { oldRoot, newRoot, ids: [...selected], expected });
    setPreview(null); setSelected(new Set()); setChecks(await invoke<PathCheck[]>('game_paths_check')); bump();
    setNotice(`已修复 ${count} 部游戏的路径，游玩历史和标签已保留。`);
  }); }
  const updateRoot = (kind: 'old' | 'new', value: string) => { if (kind === 'old') setOldRoot(value); else setNewRoot(value); setPreview(null); setSelected(new Set()); };
  return <div className="space-y-4">
    <div><Button variant="outline" loading={busy} onClick={() => void check()}>检查游戏路径</Button><p className="mt-2 text-xs leading-relaxed text-muted-foreground">检查安装目录与启动程序；已卸载 / 已归档的游戏不计入路径异常，也不参与批量修复。外接硬盘暂未连接时保留收藏，重新连接后再检查即可。</p></div>
    {checks ? <div className="space-y-2 text-xs"><p>已检查 {checks.length} 部，正常 {checks.filter(row => row.state === 'ok').length} 部，已归档 {checks.filter(row => row.state === 'archived').length} 部，需检查 {checks.filter(row => row.state !== 'ok' && row.state !== 'archived').length} 部。</p><ul className="max-h-48 divide-y divide-border overflow-y-auto rounded-md border border-border">{checks.filter(row => row.state !== 'ok').map(row => <li key={row.id} className="space-y-1 p-2"><p className="font-medium">{row.title} · {stateLabels[row.state]}</p><p className="break-all text-muted-foreground">{row.exePath || row.installPath}</p></li>)}</ul></div> : null}
    <div className="space-y-3 border-t border-border pt-4"><h3 className="text-sm font-medium">游戏搬盘后的批量修复</h3><p className="text-xs text-muted-foreground">例如将 D:\Galgame 改为 E:\Games。同步更新目录下的启动程序、工作目录与存档路径，只更新记录，不搬动游戏文件。</p>
      <Field label="原游戏根目录"><PathInput label="原游戏根目录" kind="directory" value={oldRoot} disabled={busy} onChange={value => updateRoot('old', value)} /></Field>
      <Field label="新游戏根目录"><PathInput label="新游戏根目录" kind="directory" value={newRoot} disabled={busy} onChange={value => updateRoot('new', value)} /></Field>
      <Button size="sm" variant="outline" disabled={busy || !oldRoot.trim() || !newRoot.trim()} onClick={() => void inspect()}>预览路径变更</Button>
    </div>
    {preview ? <div className="space-y-3"><ul className="max-h-80 divide-y divide-border overflow-y-auto rounded-md border border-border">{preview.map(row => <li key={row.id} className="space-y-1 p-3 text-xs"><label className="flex gap-2"><input type="checkbox" aria-label={`修复${row.title}`} disabled={!row.ready || busy} checked={selected.has(row.id)} onChange={event => { setSelected(current => { const next = new Set(current); if (event.target.checked) next.add(row.id); else next.delete(row.id); return next; }); }} /><span className="font-medium">{row.title}</span></label><p className="break-all text-muted-foreground">原目录：{row.oldInstallPath}</p><p className="break-all">新目录：{row.newInstallPath}</p><p className="break-all text-muted-foreground">启动：{row.newExePath || '未设置'}{row.newWorkdir ? ` · 工作目录：${row.newWorkdir}` : ''}</p>{row.newSavePath ? <p className="break-all text-muted-foreground">存档：{row.newSavePath}</p> : null}<p className={row.ready ? 'text-primary' : 'text-destructive'}>{row.message}</p></li>)}</ul><Button size="sm" disabled={busy || selected.size === 0} onClick={() => setConfirm(true)}>更新选中的 {selected.size} 部游戏</Button></div> : null}
    {notice ? <p role="status" className="text-xs text-primary">{notice}</p> : null}{error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    <ConfirmDialog open={confirm} title="确认更新游戏路径？" description={`将更新选中的 ${selected.size} 部游戏。启动程序与工作目录会再次检查，记录 ID、标签和游玩历史保留。`} confirmText="确认修复" onCancel={() => setConfirm(false)} onConfirm={() => void apply()} />
  </div>;
}
