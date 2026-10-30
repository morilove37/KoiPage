/** Shared guard survives React StrictMode's effect setup/cleanup cycle. */
let running: Promise<unknown> | null = null;
export function runExclusive(run: () => Promise<unknown>): Promise<unknown> {
  if (running) return running;
  running = Promise.resolve().then(run).finally(() => { running = null; });
  return running;
}
export function startSyncPolling(run: () => Promise<unknown>, host: Pick<Window, 'setInterval' | 'clearInterval' | 'addEventListener' | 'removeEventListener'>): () => void {
  let alive = true;
  const tick = () => { if (alive) void runExclusive(run).catch(() => { /* Backend persists actionable errors in status. */ }); };
  const timer = host.setInterval(tick, 10_000);
  host.addEventListener('focus', tick);
  host.addEventListener('online', tick);
  tick();
  return () => { alive = false; host.clearInterval(timer); host.removeEventListener('focus', tick); host.removeEventListener('online', tick); };
}
