import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { createPortal } from 'react-dom';
import { GeometryIcon } from '@/components/ui/geometry-icon';
import { chat, executor, getConfig } from './api';
import { runAgent, type Message, type AgentEvent } from './agent';
import { EMPTY_USAGE, addUsage, estimateCost, formatCost, formatTokens, loadPricing, type UsageTotals } from './pricing';

type Entry = AgentEvent | { kind: 'user' | 'error'; text: string };
const button = 'rounded-md border border-border px-3 py-1.5 text-xs transition-colors hover:bg-accent disabled:opacity-50';
const labels: Record<string, string> = { list_games: '查询游戏库', get_game: '读取游戏资料', get_stats: '统计游戏库', update_game: '修改游戏', open_game: '打开游戏详情', launch_game: '启动游戏' };
/** 操作记录里的具体游戏名：新事件直接带 detail；旧记录从结果 JSON 里补出标题。 */
function entryDetail(entry: AgentEvent): string | undefined {
  if (entry.detail) return entry.detail;
  const separator = entry.text.indexOf('：');
  if (separator < 0) return undefined;
  try {
    const result = JSON.parse(entry.text.slice(separator + 1)) as Record<string, unknown>;
    if (typeof result.title === 'string' && result.title.trim()) return result.title.trim().slice(0, 40);
    if (typeof result.total === 'number') return `${result.total} 部游戏`;
  } catch { /* 错误信息等非 JSON 结果不显示附注 */ }
  return undefined;
}
const MIN_PANEL_WIDTH = 320;
const DEFAULT_PANEL_WIDTH = 440;
const PANEL_VIEWPORT_GAP = 48;
const PANEL_WIDTH_KEY = 'koipage.ai.assistant.width';
function clampPanelWidth(value: number) {
  const max = Math.max(MIN_PANEL_WIDTH, window.innerWidth - PANEL_VIEWPORT_GAP);
  return Math.min(Math.max(value, Math.min(MIN_PANEL_WIDTH, max)), max);
}
function loadPanelWidth() {
  const saved = Number(window.localStorage.getItem(PANEL_WIDTH_KEY));
  return clampPanelWidth(Number.isFinite(saved) && saved > 0 ? saved : DEFAULT_PANEL_WIDTH);
}
function savePanelWidth(value: number) {
  try { window.localStorage.setItem(PANEL_WIDTH_KEY, String(Math.round(value))); } catch { /* 无痕模式下忽略 */ }
}
export function AiAssistant() {
  const [open, setOpen] = useState(false); const [draft, setDraft] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]); const [busy, setBusy] = useState(false);
  const [width, setWidth] = useState(loadPanelWidth);
  const [usage, setUsage] = useState<UsageTotals>(EMPTY_USAGE);
  const resizing = useRef(false);
  const [status, setStatus] = useState('');
  const [pending, setPending] = useState<{ title: string; resolve: (value: boolean) => void } | null>(null);
  const history = useRef<Message[]>([]); const control = useRef<AbortController | null>(null);
  const log = useRef<HTMLDivElement>(null); const input = useRef<HTMLTextAreaElement>(null);
  const navigate = useNavigate();
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight, behavior: 'smooth' }); }, [entries, status, pending, open]);
  useEffect(() => { if (open) input.current?.focus(); }, [open]);
  useEffect(() => {
    const clampOnWindowResize = () => setWidth(current => clampPanelWidth(current));
    window.addEventListener('resize', clampOnWindowResize);
    return () => window.removeEventListener('resize', clampOnWindowResize);
  }, []);
  useEffect(() => () => {
    control.current?.abort();
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
  }, []);
  const add = (entry: Entry) => setEntries(old => [...old, entry]);
  function stop() { control.current?.abort(); setStatus('正在停止后续操作…'); }
  function close() { if (control.current) stop(); setOpen(false); }
  async function send(text: string) {
    text = text.trim(); if (!text || control.current) return;
    const current = new AbortController(); control.current = current;
    setBusy(true); setDraft(''); add({ kind: 'user', text }); setStatus('正在连接…');
    try {
      const config = await getConfig(); current.signal.throwIfAborted();
      if (!config.baseUrl || !config.model) throw new Error('请先在「设置 → AI 助手」填写 API 地址和模型并保存。');
      history.current.push({ role: 'user', content: text });
      const confirm = (title: string) => new Promise<boolean>(resolve => {
        const finish = (accepted: boolean) => { current.signal.removeEventListener('abort', aborted); setPending(null); resolve(accepted); };
        const aborted = () => finish(false);
        current.signal.addEventListener('abort', aborted, { once: true });
        if (current.signal.aborted) finish(false); else { setStatus('等待确认启动…'); setPending({ title, resolve: finish }); }
      });
      await runAgent({ history: history.current, signal: current.signal,
        request: messages => chat(messages, current.signal), execute: executor(navigate, confirm, current.signal),
        onEvent: event => {
          if (event.kind === 'thinking') setStatus(event.text.replace(/list_games|get_game|get_stats|update_game|open_game|launch_game/g, name => labels[name]));
          else if (event.kind === 'usage') { if (event.usage) setUsage(old => addUsage(old, event.usage!)); }
          else add(event);
        },
      });
    } catch (cause) {
      add({ kind: 'error', text: current.signal.aborted ? '已停止。已经完成的操作会保留，后续操作已取消。' : String(cause instanceof Error ? cause.message : cause) });
    } finally { setBusy(false); setStatus(''); setPending(null); control.current = null; input.current?.focus(); }
  }
  function startResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    resizing.current = true;
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* 捕获失败时仍可拖动 */ }
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    setWidth(clampPanelWidth(window.innerWidth - event.clientX));
  }
  function moveResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (!resizing.current) return;
    setWidth(clampPanelWidth(window.innerWidth - event.clientX));
  }
  function finishResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (!resizing.current) return;
    resizing.current = false;
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* ignore */ }
    const next = clampPanelWidth(window.innerWidth - event.clientX);
    setWidth(next);
    savePanelWidth(next);
  }
  function cancelResize() {
    if (!resizing.current) return;
    resizing.current = false;
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
  }
  function nudgeWidth(delta: number) {
    setWidth(current => {
      const next = clampPanelWidth(current + delta);
      savePanelWidth(next);
      return next;
    });
  }
  function resetWidth() {
    const next = clampPanelWidth(DEFAULT_PANEL_WIDTH);
    setWidth(next);
    savePanelWidth(next);
  }
  const price = loadPricing();
  const cost = estimateCost(usage, price);
  return <>
    <button type="button" aria-label="打开 AI 助手" aria-expanded={open} onClick={() => { if (open) close(); else setOpen(true); }} className="mx-2 mb-2 flex h-10 shrink-0 items-center gap-2.5 rounded-md border border-primary/25 bg-primary/5 px-3 text-sm text-primary hover:bg-primary/10">
      <GeometryIcon name="assistant" /><span>AI 助手</span>{busy && <span className="ml-auto text-xs">处理中</span>}
    </button>
    {open && createPortal(<aside aria-label="AI 助手" style={{ width }} className="fixed inset-y-0 right-0 z-40 flex max-w-[calc(100vw-48px)] flex-col border-l border-border bg-card text-foreground shadow-2xl">
      <div role="separator" aria-orientation="vertical" aria-label="拖动调整 AI 助手宽度，双击恢复默认" title="拖动调整宽度，双击恢复默认" tabIndex={0}
        aria-valuemin={MIN_PANEL_WIDTH} aria-valuemax={Math.max(MIN_PANEL_WIDTH, Math.round(window.innerWidth - PANEL_VIEWPORT_GAP))} aria-valuenow={Math.round(width)}
        className="group absolute inset-y-0 left-0 z-10 w-3 -translate-x-1/2 cursor-col-resize touch-none outline-none"
        onPointerDown={startResize} onPointerMove={moveResize} onPointerUp={finishResize} onPointerCancel={cancelResize}
        onDoubleClick={resetWidth}
        onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>) => {
          if (event.key === 'ArrowLeft') { event.preventDefault(); nudgeWidth(24); }
          else if (event.key === 'ArrowRight') { event.preventDefault(); nudgeWidth(-24); }
          else if (event.key === 'Home') { event.preventDefault(); resetWidth(); }
        }}>
        <span className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors group-hover:bg-primary/70 group-focus-visible:bg-primary" />
        <span className="pointer-events-none absolute left-1/2 top-1/2 h-10 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-muted-foreground/30 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
      </div>
      <header className="flex shrink-0 items-center justify-between border-b border-border px-5 py-4">
        <div className="flex items-center gap-2"><GeometryIcon name="assistant" /><h2 className="font-semibold">AI 助手</h2></div>
        <div className="flex items-center gap-1">
          <button className={button} disabled={busy} onClick={() => { history.current = []; setEntries([]); setUsage(EMPTY_USAGE); }}>清空对话</button>
          <button className={button} onClick={() => { close(); navigate('/settings'); window.setTimeout(() => document.getElementById('settings-ai')?.scrollIntoView({ block: 'start' }), 200); }}>配置</button>
          <button aria-label="关闭 AI 助手" className="rounded p-2 hover:bg-accent" onClick={close}><GeometryIcon name="close" /></button>
        </div>
      </header>
      <div ref={log} role="log" aria-label="AI 对话记录" aria-live="polite" className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-5">
        {!entries.length && <div className="py-6">
          <p className="text-base font-medium">用一句话管理你的游戏库</p>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">先在配置中接入你的模型，再告诉我你想做什么。每一步操作的实际结果都会显示在这里。</p>
          <div className="mt-5 flex flex-col items-start gap-2">{['统计一下我的游戏库', '找出未游玩的游戏，按评分排序', '我想翻译并替换一款游戏的简介'].map(text => <button key={text} className={`${button} text-left`} onClick={() => void send(text)}>{text}</button>)}</div>
        </div>}
        {entries.map((entry, index) => {
          if (entry.kind === 'tool') {
            const detail = entryDetail(entry);
            return <details key={index} className="rounded-md border border-border bg-background/50 p-3 text-xs"><summary className="cursor-pointer font-medium">{entry.ok ? '已执行' : '操作失败'} · {labels[entry.name ?? entry.text.split('：')[0]] ?? '工具调用'}{detail ? ` · ${detail}` : ''}</summary><p className="mt-2 whitespace-pre-wrap break-all leading-relaxed text-muted-foreground">{entry.text}</p></details>;
          }
          return <div key={index} className={`whitespace-pre-wrap break-words rounded-lg px-4 py-3 text-sm leading-relaxed ${entry.kind === 'user' ? 'ml-6 bg-primary/10' : entry.kind === 'error' ? 'border border-destructive/30 text-destructive' : 'mr-3 bg-muted/50'}`}>
            <p className="mb-1 text-[11px] font-medium text-muted-foreground">{entry.kind === 'user' ? '你' : entry.kind === 'error' ? '提示' : 'AI'}</p>{entry.text}
          </div>;
        })}
        {pending && <div className="rounded-lg border border-primary/40 bg-primary/5 p-4">
          <p className="text-sm font-medium">启动「{pending.title}」？</p><p className="mt-1 text-xs text-muted-foreground">将按该游戏已保存的启动配置运行。</p>
          <div className="mt-3 flex gap-2"><button className={button} onClick={() => pending.resolve(true)}>确认启动</button><button className={button} onClick={() => pending.resolve(false)}>取消</button></div>
        </div>}
        {status && <p role="status" className="animate-pulse text-xs text-muted-foreground">{status}</p>}
      </div>
      {usage.requests > 0 && <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-0.5 border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
        <span>本次对话：输入 {formatTokens(usage.promptTokens)} · 输出 {formatTokens(usage.completionTokens)} · 合计 {formatTokens(usage.totalTokens)} tokens</span>
        {usage.cacheHitTokens > 0 && <span>· 缓存命中 {formatTokens(usage.cacheHitTokens)}</span>}
        {cost && <span>· 估算 {formatCost(cost.cny)}</span>}
      </div>}
      <form className="shrink-0 border-t border-border p-4" onSubmit={e => { e.preventDefault(); void send(draft); }}>
        <label className="sr-only" htmlFor="ai-message">发送给 AI 的指令</label>
        <textarea ref={input} id="ai-message" className="h-24 w-full resize-none rounded-lg border border-input bg-background p-3 text-sm outline-none focus:ring-2 focus:ring-ring" maxLength={4000} value={draft} onChange={e => setDraft(e.target.value)} placeholder="例如：把《游戏名》的简介翻译成中文并替换" disabled={busy} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(draft); } }} />
        <div className="mt-2 flex items-center justify-between gap-2"><p className="text-[11px] text-muted-foreground">Enter 发送 · Shift+Enter 换行</p>{busy ? <button type="button" className={button} onClick={stop}>停止后续操作</button> : <button type="submit" disabled={!draft.trim()} className={`${button} bg-primary text-primary-foreground hover:bg-primary/90`}>发送</button>}</div>
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">使用你配置的 API 服务。AI 可能出错，请以操作记录为准。</p>
      </form>
    </aside>, document.body)}
  </>;
}
