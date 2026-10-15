import { flushSync } from "react-dom";
import type { MouseEvent } from "react";

let revision = 0;
type GameViewTransition = Pick<ReturnType<Document["startViewTransition"]>, "ready" | "finished" | "skipTransition">;
let active: { token: number; transition: GameViewTransition | null; cleanup: () => void } | null = null;

export function isGameOpeningTransition(): boolean {
  return active !== null;
}

/** Wait for the loaded detail DOM, without waiting for a suppressed paint. */
function waitForDetail(gameId: number, token: number): Promise<boolean> {
  return new Promise(resolve => {
    let timer = 0;
    let finishing = false;
    let settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      observer.disconnect();
      resolve(ready);
    };
    const check = () => {
      if (finishing || settled) return;
      if (token !== revision || location.pathname !== `/library/${gameId}`) { finish(false); return; }
      const cover = document.querySelector<HTMLElement>(`[data-game-detail][data-game-id="${gameId}"] [data-detail-cover]`);
      if (document.querySelector(`[data-detail-state="error"][data-game-id="${gameId}"]`)) { finish(true); return; }
      if (!cover) return;
      finishing = true;
      observer.disconnect();
      const image = cover.querySelector('img');
      if (!image) { finish(true); return; }
      // Detail covers load eagerly. A slow or broken image must not hold the UI.
      void image.decode().catch(() => {}).then(() => finish(true));
      window.clearTimeout(timer);
      timer = window.setTimeout(() => finish(true), 160);
    };
    const observer = new MutationObserver(check);
    observer.observe(document.getElementById('root') ?? document.body, { childList: true, subtree: true });
    timer = window.setTimeout(() => finish(false), 1200);
    check();
  });
}

/** Keep normal Link behavior for modifiers, unsupported browsers and reduced motion. */
export function openGameWithTransition(event: MouseEvent<HTMLAnchorElement>, gameId: number, navigate: () => void): void {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  if (event.currentTarget.target && event.currentTarget.target !== '_self') return;
  if (typeof document.startViewTransition !== 'function' || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const cover = event.currentTarget.closest('[data-game-entry]')?.querySelector<HTMLElement>('[data-game-cover]');
  if (!cover) return;
  const bounds = cover.getBoundingClientRect();
  if (!bounds.width || !bounds.height || bounds.bottom <= 0 || bounds.top >= innerHeight) return;

  event.preventDefault();
  const token = ++revision;
  active?.transition?.skipTransition();
  active?.cleanup();
  const origin = location.pathname;
  cover.style.viewTransitionName = 'game-cover';
  cover.dataset.openingToken = String(token);
  const onPopState = () => {
    if (active?.token !== token) return;
    revision++;
    active.transition?.skipTransition();
    active.cleanup();
  };
  const cleanup = () => {
    if (cover.dataset.openingToken === String(token)) {
      cover.style.removeProperty('view-transition-name');
      delete cover.dataset.openingToken;
    }
    window.removeEventListener('popstate', onPopState);
    if (active?.token === token) active = null;
  };
  active = { token, transition: null, cleanup };
  window.addEventListener('popstate', onPopState);
  try {
    const transition = document.startViewTransition(async () => {
      // A second click or another navigation must win over this pending open.
      if (token !== revision || location.pathname !== origin) return;
      flushSync(navigate);
      const ready = await waitForDetail(gameId, token);
      if (!ready && active?.token === token) active.transition?.skipTransition();
    });
    if (active?.token === token) active.transition = transition;
    // Missing snapshots / duplicate names should only skip animation.
    void transition.ready.catch(() => {});
    void transition.finished.then(cleanup, cleanup);
  } catch {
    cleanup();
    if (token === revision && location.pathname === origin) navigate();
  }
}
