import { invoke as rawInvoke } from '@tauri-apps/api/core';
import type { InvokeArgs, InvokeOptions } from '@tauri-apps/api/core';
import { logValue, trackedCommand } from './log-model';

type Level = 'INFO' | 'WARN' | 'ERROR';
interface LogEntry { level: Level; module: string; message: string }
const queue: LogEntry[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
let inFlight: Promise<void> | undefined;

export async function flushLogs(): Promise<void> {
  if (timer) { clearTimeout(timer); timer = undefined; }
  while (queue.length || inFlight) {
    if (!inFlight) {
      const entries = queue.splice(0, 50);
      inFlight = rawInvoke<void>('logs_write', { entries })
        .catch(() => { /* Logging failures never replace the operation's own result. */ })
        .finally(() => { inFlight = undefined; });
    }
    await inFlight;
  }
}

export function recordLog(level: Level, module: string, ...values: unknown[]): void {
  queue.push({ level, module, message: values.map(logValue).join(' ').slice(0, 8192) });
  if (queue.length > 200) queue.splice(0, queue.length - 200);
  if (!timer) timer = setTimeout(() => { timer = undefined; void flushLogs(); }, 100);
}

/** A transparent IPC bridge: only summaries are logged, never arguments or payloads. */
export async function invoke<T>(command: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> {
  const tracked = trackedCommand(command);
  const start = performance.now();
  if (tracked) recordLog('INFO', 'operation', `${command} 开始`);
  try {
    const result = await rawInvoke<T>(command, args, options);
    if (tracked) recordLog('INFO', 'operation', `${command} 完成，耗时 ${Math.round(performance.now() - start)} ms`);
    return result;
  } catch (cause) {
    if (!command.startsWith('logs_')) recordLog('ERROR', 'operation', `${command} 失败`, cause);
    throw cause;
  }
}

export function initLogging(): () => void {
  const onError = (event: ErrorEvent) => recordLog('ERROR', 'frontend', event.error ?? event.message);
  const onRejection = (event: PromiseRejectionEvent) => recordLog('ERROR', 'promise', event.reason);
  const onHidden = () => { if (document.hidden) void flushLogs(); };
  const originalWarn = console.warn;
  const originalError = console.error;
  const warn = (...values: unknown[]) => { originalWarn.apply(console, values); recordLog('WARN', 'console', ...values); };
  const error = (...values: unknown[]) => { originalError.apply(console, values); recordLog('ERROR', 'console', ...values); };
  console.warn = warn;
  console.error = error;
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  document.addEventListener('visibilitychange', onHidden);
  recordLog('INFO', 'frontend', '界面初始化');
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
    document.removeEventListener('visibilitychange', onHidden);
    if (console.warn === warn) console.warn = originalWarn;
    if (console.error === error) console.error = originalError;
    void flushLogs();
  };
}
