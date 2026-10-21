import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type { GameExitedPayload } from "@/features/io/io";
import { useAppStore } from "@/store/app";
import { gameProcesses } from "./game-process";
import type { GameProcessState } from "./process-state";

const IDLE: GameProcessState = { status: "idle", pid: null, sessionId: null };

function refresh(id: number) {
  void gameProcesses.refresh(id).catch(cause => console.warn("[game-process] refresh:", cause));
}

/** Refresh the visible game's backend state on navigation and window focus. */
export function useGameProcess(gameId: number, enabled = true) {
  const process = useAppStore(state => state.gameProcesses[gameId] ?? IDLE);
  useEffect(() => {
    if (!enabled || !Number.isFinite(gameId) || gameId <= 0) return;
    const refreshVisible = () => {
      if (document.visibilityState !== "hidden") refresh(gameId);
    };
    refreshVisible();
    window.addEventListener("focus", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      window.removeEventListener("focus", refreshVisible);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [gameId, enabled]);
  return process;
}

/** App owns this listener, so closing a panel or changing routes never loses
 * process exits. The fallback poll only checks games currently marked running. */
export function useGameProcessSync() {
  useEffect(() => {
    let disposed = false;
    let remove: UnlistenFn | undefined;
    void listen('play-history-changed', () => {
      if (!disposed) useAppStore.getState().bumpPlayTimeRevision();
    }).then(unlisten => { if (disposed) unlisten(); else remove = unlisten; }).catch(cause => console.warn('[history] listener:', cause));
    return () => { disposed = true; remove?.(); };
  }, []);
  const runningIds = useAppStore(state => Object.entries(state.gameProcesses)
    .filter(([, process]) => process.status === "running")
    .map(([id]) => id).join(","));

  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    void listen<GameExitedPayload>("game-exited", ({ payload }) => {
      if (!disposed) gameProcesses.exited(payload.gameId, payload.sessionId);
    }).then(remove => {
      if (disposed) remove();
      else {
        unlisten = remove;
        // Reconcile any exits that happened before registration completed.
        for (const id of Object.keys(useAppStore.getState().gameProcesses)) refresh(Number(id));
      }
    }).catch(cause => {
      if (!disposed) console.warn("[game-process] game-exited listener:", cause);
    });
    return () => { disposed = true; unlisten?.(); };
  }, []);

  useEffect(() => {
    if (!runningIds) return;
    const ids = runningIds.split(",").map(Number);
    const refreshRunning = () => {
      if (document.visibilityState === "hidden") return;
      for (const id of ids) refresh(id);
    };
    const timer = window.setInterval(refreshRunning, 5000);
    window.addEventListener("focus", refreshRunning);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshRunning);
    };
  }, [runningIds]);
}
