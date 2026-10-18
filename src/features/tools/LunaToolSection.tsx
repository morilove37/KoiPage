import { useCallback, useEffect, useRef, useState } from 'react';
import { openPath, openUrl, revealItemInDir } from '@tauri-apps/plugin-opener';
import { Button } from '@/components/ui/button';
import { settingsGet, settingsSet } from '@/lib/db';
import { errorMessage } from '@/features/io/io';
import { cn } from '@/lib/utils';
import { lunaLaunch, lunaQuit, lunaStatus } from './io';
import type { LunaStatus } from './io';

const DOCS = 'https://docs.lunatranslator.org/zh/README';
const USAGE = 'https://docs.lunatranslator.org/zh/basicuse';
const PROJECT = 'https://github.com/HIllya51/LunaTranslator';

export function LunaToolSection() {
  const [status, setStatus] = useState<LunaStatus | null>(null);
  const [autostart, setAutostart] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const alive = useRef(true);
  const operation = useRef(false);
  const reading = useRef(false);

  const refresh = useCallback(async () => {
    const next = await lunaStatus();
    if (alive.current) setStatus(next);
    return next;
  }, []);
  useEffect(() => {
    alive.current = true;
    const preference = settingsGet('luna_autostart').then(value => {
      if (alive.current) setAutostart(['1', 'true', 'yes', 'on'].includes(value?.trim().toLowerCase() ?? ''));
    });
    void Promise.allSettled([refresh(), preference]).then(results => {
      const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failed && alive.current) setError(errorMessage(failed.reason));
    })
      .finally(() => { if (alive.current) setLoading(false); });
    return () => { alive.current = false; };
  }, [refresh]);
  useEffect(() => {
    if (loading) return;
    const poll = () => {
      if (document.visibilityState !== 'visible' || operation.current || reading.current) return;
      reading.current = true;
      void refresh().catch(e => { if (alive.current) setError(errorMessage(e)); }).finally(() => { reading.current = false; });
    };
    const timer = window.setInterval(poll, 3000);
    window.addEventListener('focus', poll);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', poll); };
  }, [loading, refresh]);

  async function act(task: () => Promise<string | null>) {
    if (operation.current || loading) return;
    operation.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      const result = await task();
      if (alive.current) setNotice(result);
    } catch (e) { if (alive.current) setError(errorMessage(e)); }
    finally { operation.current = false; if (alive.current) setBusy(false); }
  }
  async function launch() {
    const started = await lunaLaunch();
    let next = await refresh();
    for (let i = 0; started && !next.running && i < 5; i++) {
      await new Promise(resolve => window.setTimeout(resolve, 400));
      next = await refresh();
    }
    return !started ? '内置 LunaTranslator 已在运行。'
      : next.running ? '已启动 LunaTranslator，请在翻译器中选择文本提取方式与翻译接口。' : '已请求启动 LunaTranslator，请稍候；若未出现，请查看官方教程。';
  }
  async function quit() {
    try {
      const stopped = await lunaQuit();
      await refresh();
      return stopped ? 'LunaTranslator 已退出。' : 'LunaTranslator 当前未运行。';
    } catch (e) {
      await refresh().catch(() => {});
      throw e;
    }
  }
  return <div data-luna-tools className="space-y-4">
    <div className="space-y-2 rounded-lg border border-border bg-primary/5 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">内置 LunaTranslator {status?.version ?? '12.1.2.9'}</p>
        <span role="status" className={cn('rounded-full px-2 py-0.5 text-[11px]', status?.running ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-muted text-muted-foreground')}>
          {loading ? '正在准备组件…' : status?.running ? '运行中' : status?.available ? '已就绪 · 未运行' : '暂不可用'}
        </span>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">无需另行下载。支持 HOOK 文本提取、OCR、翻译接口与语言学习；提取方式、游戏绑定和翻译设置在 Luna 中管理。</p>
      <p className="text-xs leading-relaxed text-muted-foreground">内置程序可离线启动；在线翻译接口需要联网，离线翻译需在 Luna 中配置本地引擎。</p>
      {status?.path ? <p className="break-all text-[11px] text-muted-foreground" title={status.path}>程序位置：{status.path}</p> : null}
    </div>
    <div className="flex flex-wrap gap-2">
      <Button size="sm" disabled={loading || busy || !status?.available || status.running} loading={busy} onClick={() => void act(launch)}>{status?.running ? 'Luna 已运行' : '启动 Luna'}</Button>
      <Button size="sm" variant="outline" disabled={loading || busy || !status?.running} onClick={() => void act(quit)}>退出 Luna</Button>
      <Button size="sm" variant="outline" disabled={loading || busy || !status?.path} onClick={() => void act(async () => { await revealItemInDir(status!.path); return null; })}>打开程序目录</Button>
      <Button size="sm" variant="outline" disabled={loading || busy} onClick={() => void act(async () => { await refresh(); return '已重新检查内置 LunaTranslator。'; })}>重新检查</Button>
      <Button size="sm" variant="ghost" onClick={() => { void openUrl(USAGE).catch(e => setError(errorMessage(e))); }}>使用教程 ↗</Button>
    </div>
    <div className="flex items-center justify-between gap-4 border-t border-border pt-4">
      <div className="space-y-1"><h3 id="luna-autostart-label" className="text-sm font-medium">随游戏启动</h3><p className="text-xs leading-relaxed text-muted-foreground">启动游戏时一并打开 Luna；开启后，仍需在 Luna 中配置文本提取与翻译。</p></div>
      <button type="button" role="switch" aria-labelledby="luna-autostart-label" aria-checked={autostart} disabled={loading || busy || (!autostart && !status?.available)}
        onClick={() => void act(async () => { const next = !autostart; await settingsSet('luna_autostart', next ? '1' : '0'); if (alive.current) setAutostart(next); return next ? '已开启 Luna 随游戏启动。' : '已关闭 Luna 随游戏启动。'; })}
        className={cn('relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50', autostart ? 'bg-primary' : 'bg-muted-foreground/40')}>
        <span className={cn('inline-block h-4 w-4 rounded-full bg-white transition-transform', autostart ? 'translate-x-6' : 'translate-x-1')} />
      </button>
    </div>
    <p className="text-[11px] leading-relaxed text-muted-foreground">由 HIllya51 与 LunaTranslator 贡献者维护，按 GPLv3 分发；保留原始程序、第三方许可与对应版本源码。已有配置和 Luna 自更新文件会保留。</p>
    <div className="flex flex-wrap gap-x-4 gap-y-2 text-[11px] text-muted-foreground">
      <button type="button" className="text-primary hover:underline" onClick={() => { void openUrl(PROJECT).catch(e => setError(errorMessage(e))); }}>作者项目 ↗</button>
      <button type="button" className="text-primary hover:underline" onClick={() => { void openUrl(DOCS).catch(e => setError(errorMessage(e))); }}>官方下载与帮助 ↗</button>
      <button type="button" disabled={!status?.licensePath} className="text-primary hover:underline disabled:opacity-50" onClick={() => { if (status) void openPath(status.licensePath).catch(e => setError(errorMessage(e))); }}>查看许可</button>
      <button type="button" disabled={!status?.sourcePath} className="text-primary hover:underline disabled:opacity-50" onClick={() => { if (status) void revealItemInDir(status.sourcePath).catch(e => setError(errorMessage(e))); }}>对应版本源码</button>
    </div>
    {notice ? <p role="status" className="text-xs text-emerald-600 dark:text-emerald-400">{notice}</p> : null}
    {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
  </div>;
}
