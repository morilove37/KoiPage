import { useEffect, useState } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import { Button } from '@/components/ui/button';
import { invoke, flushLogs, recordLog } from '@/lib/logging';

interface LogInfo { directory: string; fileCount: number; totalBytes: number; maxFileBytes: number; maxFiles: number }
const size = (bytes: number) => bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function LogSettings() {
  const [info, setInfo] = useState<LogInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  async function refresh() {
    try { setInfo(await invoke<LogInfo>('logs_info')); setError(null); }
    catch (cause) { setError(String(cause)); }
  }
  useEffect(() => { void refresh(); }, []);
  async function exportLogs() {
    setBusy(true); setError(null); setNotice(null);
    try {
      const stamp = new Date().toLocaleDateString('sv-SE');
      const path = await save({ title: '导出诊断日志', defaultPath: `KoiPage-日志-${stamp}.txt`, filters: [{ name: '文本日志', extensions: ['txt'] }] });
      if (!path) return;
      recordLog('INFO', 'logs', '用户导出诊断日志');
      await flushLogs();
      await invoke<void>('logs_export', { path });
      setNotice('日志已导出，可用于反馈问题。');
      await refresh();
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }
  return <div className="space-y-3" data-log-settings>
    <p className="text-xs leading-relaxed text-muted-foreground">自动记录应用启动、扫描导入、资料匹配、游戏启动与退出及异常信息。日志仅保存在本机，密钥和令牌会过滤；导出为包含版本、系统信息和保留日志的 TXT 文件。</p>
    <div className="flex flex-wrap gap-2">
      <Button disabled={busy || !info} onClick={() => void exportLogs()}>{busy ? '导出中…' : '导出日志'}</Button>
      <Button variant="outline" disabled={busy || !info} onClick={() => {
        setError(null);
        void invoke<void>('logs_open_directory').catch(cause => setError(String(cause)));
      }}>打开日志目录</Button>
      <Button variant="ghost" disabled={busy} onClick={() => void refresh()}>刷新日志信息</Button>
    </div>
    {info ? <dl className="space-y-1 text-xs text-muted-foreground">
      <div><dt className="inline">存储位置：</dt><dd className="inline break-all">{info.directory}</dd></div>
      <div><dt className="inline">当前日志：</dt><dd className="inline">{info.fileCount} 个文件 · {size(info.totalBytes)}</dd></div>
      <div><dt className="inline">保留规则：</dt><dd className="inline">每个文件最多 {size(info.maxFileBytes)}，保留最近 {info.maxFiles} 个，自动轮换。</dd></div>
    </dl> : null}
    {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    {notice ? <p role="status" className="text-xs text-muted-foreground">{notice}</p> : null}
  </div>;
}
