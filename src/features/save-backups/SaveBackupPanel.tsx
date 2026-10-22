import { useEffect, useRef, useState } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { openPath } from '@tauri-apps/plugin-opener';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { gameUpdate, initDatabase, settingsGet } from '@/lib/db';
import { invoke } from '@/lib/logging';
import { errorMessage } from '@/features/io/io';
import { DEFAULT_SAVE_BACKUP_CONFIG, formatSnapshotSize, normalizeSaveBackupConfig, parseAutomaticBackupResult, snapshotDate, snapshotReason, type AutomaticBackupResult, type SaveBackupConfig, type SaveSnapshot } from './model';

interface Props {
  gameId: number;
  savePath: string | null | undefined;
  onPathSaved?: (path: string) => void;
}
type Selection = { action: 'restore' | 'delete'; snapshot: SaveSnapshot };
interface BackupEvent { gameId: number; error?: string; message?: string }

export function SaveBackupPanel(props: Props) {
  return <SaveBackupContent key={`${props.gameId}:${props.savePath ?? ''}`} {...props} />;
}

function SaveBackupContent({ gameId, savePath, onPathSaved }: Props) {
  const [persistedPath, setPersistedPath] = useState(savePath ?? '');
  const [config, setConfig] = useState<SaveBackupConfig>(DEFAULT_SAVE_BACKUP_CONFIG);
  const [snapshots, setSnapshots] = useState<SaveSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [selection, setSelection] = useState<Selection | null>(null);
  const [automaticResult, setAutomaticResult] = useState<AutomaticBackupResult | null>(null);
  const [automaticStatusError, setAutomaticStatusError] = useState('');
  const alive = useRef(false);
  const locked = useRef(false);
  const listVersion = useRef(0);
  const automaticVersion = useRef(0);

  async function refreshAutomaticResult() {
    const version = ++automaticVersion.current;
    try {
      const result = parseAutomaticBackupResult(await settingsGet(`game_save_backup_last:${gameId}`));
      if (alive.current && version === automaticVersion.current) { setAutomaticResult(result); setAutomaticStatusError(''); }
    } catch (cause) {
      if (alive.current && version === automaticVersion.current) setAutomaticStatusError(`无法读取最近自动备份结果：${errorMessage(cause)}`);
    }
  }

  async function refreshList() {
    const version = ++listVersion.current;
    await initDatabase();
    const list = await invoke<SaveSnapshot[]>('save_backup_list', { gameId });
    if (alive.current && listVersion.current === version) setSnapshots(list);
  }

  async function load() {
    setLoading(true); setError('');
    try {
      await initDatabase();
      const [settings] = await Promise.all([
        invoke<SaveBackupConfig>('save_backup_settings_get', { gameId }), refreshList(), refreshAutomaticResult(),
      ]);
      if (alive.current) { setConfig(normalizeSaveBackupConfig(settings)); setLoaded(true); }
    } catch (cause) { if (alive.current) setError(errorMessage(cause)); }
    finally { if (alive.current) setLoading(false); }
  }

  useEffect(() => {
    alive.current = true;
    void load();
    let disposed = false;
    const unlisteners: UnlistenFn[] = [];
    function register(name: string, failed: boolean) {
      void listen<BackupEvent>(name, ({ payload }) => {
        if (!alive.current || payload.gameId !== gameId) return;
        void refreshAutomaticResult();
        if (!failed) {
          setMessage('已完成存档备份。');
          void refreshList().catch(cause => { if (alive.current) setError(errorMessage(cause)); });
        }
      }).then(unlisten => { if (disposed) unlisten(); else unlisteners.push(unlisten); })
        .catch(cause => { if (alive.current) setAutomaticStatusError(`无法监听自动备份通知：${errorMessage(cause)}`); });
    }
    register('save-backup-completed', false);
    register('save-backup-failed', true);
    return () => { disposed = true; alive.current = false; listVersion.current++; automaticVersion.current++; unlisteners.forEach(unlisten => unlisten()); };
    // This component remounts when the persisted game identity/path changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function perform(action: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(''); setMessage('');
    try { await initDatabase(); if (alive.current) await action(); }
    catch (cause) { if (alive.current) setError(errorMessage(cause)); }
    finally { locked.current = false; if (alive.current) setBusy(false); }
  }

  function chooseSource(directory: boolean) {
    void perform(async () => {
      const path = await open({ directory, multiple: false, title: directory ? '选择游戏存档目录' : '选择游戏存档文件' });
      if (!path || typeof path !== 'string' || !alive.current) return;
      await gameUpdate(gameId, { savePath: path });
      if (!alive.current) return;
      setPersistedPath(path); setMessage('存档路径已保存，后续备份与恢复使用此路径。');
      onPathSaved?.(path);
    });
  }

  function updateConfig(patch: Partial<SaveBackupConfig>) {
    const next = normalizeSaveBackupConfig({ ...config, ...patch });
    void perform(async () => {
      await invoke('save_backup_settings_set', { gameId, config: next });
      if (alive.current) { setConfig(next); setMessage('自动备份设置已保存。'); }
    });
  }

  function confirmSelection() {
    if (!selection) return;
    const { action, snapshot } = selection;
    void perform(async () => {
      if (action === 'restore') {
        const result = await invoke<{ safetyBackupId: string | null }>('save_backup_restore', { gameId, snapshotId: snapshot.id });
        if (alive.current) setMessage(result.safetyBackupId
          ? '存档已恢复。恢复前的当前存档已另存为安全备份，可在列表中再次恢复。'
          : '存档已恢复。原目标没有可备份的存档，因此未创建安全备份。');
      } else {
        await invoke('save_backup_delete', { gameId, snapshotId: snapshot.id });
        if (alive.current) setMessage('已删除所选存档备份。');
      }
      if (alive.current) setSelection(null);
      await refreshList();
    });
  }

  const disabled = busy || loading;
  const hasSource = Boolean(persistedPath.trim());
  return <section aria-label="游戏存档备份">
    <p className="text-xs leading-relaxed text-muted-foreground">备份所选存档目录或文件中的实际内容，每款游戏单独保存。此功能独立于设置中的完整 .koibak 备份。备份与恢复前请结束游戏。</p>
    <div className="mt-3 rounded-lg border border-border p-3">
      <p className="text-xs font-medium">存档目录 / 文件</p>
      <p className="mt-1 break-all text-xs text-muted-foreground">{persistedPath || '尚未设置，请先选择存档目录或文件。'}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => chooseSource(true)}>选择存档目录</Button>
        <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={() => chooseSource(false)}>选择单个文件</Button>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">选择后立即保存；若在“路径与启动”分区手动修改，请先点击保存。恢复始终写入此处已保存的路径。</p>
    </div>
    <div className="mt-3 flex flex-wrap gap-2">
      <Button type="button" size="sm" disabled={disabled || !loaded || !hasSource} loading={busy} onClick={() => void perform(async () => {
        await invoke<SaveSnapshot>('save_backup_create', { gameId });
        if (alive.current) setMessage('已创建手动存档备份。');
        await refreshList();
      })}>立即备份存档</Button>
      <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => void perform(async () => { await openPath(await invoke<string>('save_backup_directory', { gameId })); })}>打开备份目录</Button>
      <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={() => void load()}>刷新</Button>
    </div>
    <fieldset disabled={disabled || !loaded} className="mt-4 space-y-3 text-xs disabled:opacity-60">
      <legend className="mb-2 font-medium">此游戏的自动备份</legend>
      <div className="flex flex-wrap gap-x-5 gap-y-3">
        <label className="flex items-center gap-2"><input type="checkbox" disabled={!hasSource && !config.beforeLaunch} checked={config.beforeLaunch} onChange={event => updateConfig({ beforeLaunch: event.target.checked })} />启动游戏前备份</label>
        <label className="flex items-center gap-2"><input type="checkbox" disabled={!hasSource && !config.afterExit} checked={config.afterExit} onChange={event => updateConfig({ afterExit: event.target.checked })} />正常退出游戏后备份</label>
      </div>
      <label className="flex flex-wrap items-center gap-2">自动备份最多保留
        <select className="rounded-md border border-border bg-background px-2 py-1" value={config.keepAutomatic} onChange={event => updateConfig({ keepAutomatic: Number(event.target.value) })}>
          {Array.from({ length: 50 }, (_, index) => index + 1).map(count => <option key={count} value={count}>{count}</option>)}
        </select>份
      </label>
    </fieldset>
    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">自动备份默认关闭，仅对通过恋页启动、且恋页仍在运行的游戏生效。保留数量仅清理自动备份，手动备份及恢复前安全备份需自行删除。强制结束游戏不会触发退出后备份。</p>
    {automaticResult ? <div role="status" className={`mt-3 rounded-lg border border-border p-3 text-xs leading-relaxed ${automaticResult.success ? 'text-muted-foreground' : 'text-destructive'}`}>
      <p className="font-medium">最近一次自动备份：{automaticResult.success ? '成功' : '失败'} · {snapshotDate(automaticResult.createdAt)}</p>
      <p className="mt-1 break-all">{automaticResult.message}</p>
    </div> : null}
    {automaticStatusError ? <p role="status" className="mt-2 break-all text-xs text-destructive">{automaticStatusError}</p> : null}
    <div className="mt-4 border-t border-border pt-3">
      <h4 className="text-xs font-medium">存档快照 · {snapshots.length} 份</h4>
      {loading ? <p role="status" className="mt-2 text-xs text-muted-foreground">正在读取备份…</p>
        : snapshots.length === 0 ? <p className="mt-2 text-xs text-muted-foreground">{loaded ? '暂无存档备份。设置存档路径后可创建第一份快照。' : '未能读取备份，请点击刷新重试。'}</p> : null}
      <ul className="mt-2 max-h-80 space-y-2 overflow-y-auto">
        {snapshots.map(snapshot => <li key={snapshot.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
          <div className="min-w-0 text-xs"><p className="font-medium">{snapshotDate(snapshot.createdAt)}</p><p className="mt-1 text-muted-foreground">{snapshotReason(snapshot.reason)} · {snapshot.files} 个文件 · {formatSnapshotSize(snapshot.bytes)}</p><p className="mt-1 break-all text-muted-foreground" title={snapshot.sourcePath}>来源：{snapshot.sourcePath}</p></div>
          <div className="flex gap-1">
            <Button type="button" size="sm" variant="outline" disabled={disabled || !hasSource} onClick={() => setSelection({ action: 'restore', snapshot })}>恢复</Button>
            <Button type="button" size="sm" variant="ghost" className="text-destructive" disabled={disabled} onClick={() => setSelection({ action: 'delete', snapshot })}>删除</Button>
          </div>
        </li>)}
      </ul>
    </div>
    {message ? <p role="status" className="mt-3 break-all text-xs leading-relaxed text-primary">{message}</p> : null}
    {error ? <p role="alert" className="mt-3 break-all text-xs leading-relaxed text-destructive">{error}</p> : null}
    <Dialog open={selection !== null} title={selection?.action === 'restore' ? '确认恢复存档' : '删除存档备份'} onClose={() => { if (!locked.current) setSelection(null); }} footer={<>
      <Button type="button" variant="outline" disabled={busy} onClick={() => setSelection(null)}>取消</Button>
      <Button type="button" variant="destructive" loading={busy} onClick={confirmSelection}>{selection?.action === 'restore' ? '确认恢复' : '确认删除'}</Button>
    </>}>
      {selection ? <div className="space-y-3 text-sm leading-relaxed">
        <p>{snapshotDate(selection.snapshot.createdAt)} · {snapshotReason(selection.snapshot.reason)} · {selection.snapshot.files} 个文件 · {formatSnapshotSize(selection.snapshot.bytes)}</p>
        <p className="break-all text-xs text-muted-foreground">快照来源：{selection.snapshot.sourcePath}</p>
        {selection.action === 'restore' ? <><p className="break-all">恢复目标：{persistedPath}</p><p>将用此快照替换目标存档内容。恢复前会自动备份当前存档；游戏运行中无法恢复，请先正常退出游戏。</p></> : <p>此操作会永久删除这份备份，删除后无法恢复。</p>}
        {error ? <p role="alert" className="break-all text-xs text-destructive">{error}</p> : null}
      </div> : null}
    </Dialog>
  </section>;
}
