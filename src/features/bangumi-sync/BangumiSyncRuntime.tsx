import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { initDatabase } from '@/lib/db';
import { syncRun } from './api';
import { runExclusive, startSyncPolling } from './runtime';

export function BangumiSyncRuntime() {
  useEffect(() => {
    let alive = true;
    let stop: (() => void) | undefined;
    let unlisten: (() => void) | undefined;
    void initDatabase().then(async () => {
      if (!alive) return;
      stop = startSyncPolling(() => syncRun(false), window);
      const cleanup = await listen('bangumi-sync-config-changed', () => {
        if (alive) void runExclusive(() => syncRun(false)).catch(() => {});
      });
      if (alive) unlisten = cleanup; else cleanup();
    }).catch(() => {});
    return () => { alive = false; stop?.(); unlisten?.(); };
  }, []);
  return null;
}
