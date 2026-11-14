/** Shared scheduling: foreground only, back off after five minutes without input. */
export const FRIENDS_IDLE_MS = 5 * 60_000;
export function observeFriendsActivity(report: (idle: boolean) => void) {
  let last = Date.now(), previous: boolean | undefined;
  const check = () => {
    const idle = document.hidden || !document.hasFocus() || Date.now() - last >= FRIENDS_IDLE_MS;
    if (idle !== previous) { previous = idle; report(idle); }
  };
  const input = () => { last = Date.now(); check(); };
  const focus = () => { if (!document.hidden && document.hasFocus()) last = Date.now(); check(); };
  const events = ['pointerdown', 'pointermove', 'keydown', 'wheel'] as const;
  events.forEach(event => window.addEventListener(event, input, {passive: true}));
  window.addEventListener('focus', focus); window.addEventListener('blur', check);
  document.addEventListener('visibilitychange', focus);
  const timer = window.setInterval(check, 10_000); check();
  return () => {
    clearInterval(timer); events.forEach(event => window.removeEventListener(event, input));
    window.removeEventListener('focus', focus); window.removeEventListener('blur', check);
    document.removeEventListener('visibilitychange', focus);
  };
}
export function startFriendsPolling(refresh: () => void | Promise<void>, activeMs = 30_000) {
  let stopped = false, idle = false, pending = false, last = 0;
  const run = () => {
    if (stopped || pending || document.hidden || !document.hasFocus() || Date.now() - last < 5_000) return;
    last = Date.now(); pending = true;
    void Promise.resolve().then(refresh).catch(() => {}).finally(() => { pending = false; });
  };
  const remove = observeFriendsActivity(value => { const resume = idle && !value; idle = value; if (resume) run(); });
  const timer = window.setInterval(() => {
    if (Date.now() - last >= (idle ? Math.max(activeMs, 120_000) : activeMs)) run();
  }, 5_000);
  run();
  return () => { stopped = true; clearInterval(timer); remove(); };
}
