import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';

export function useSyncEvents(refresh: () => void) {
  useEffect(() => {
    let alive = true;
    const cleanup: (() => void)[] = [];
    for (const event of ['bangumi-sync-updated', 'bangumi-sync-config-changed']) {
      void listen(event, () => { if (alive) refresh(); }).then(unlisten => {
        if (alive) cleanup.push(unlisten); else unlisten();
      }).catch(() => {});
    }
    return () => { alive = false; cleanup.forEach(unlisten => unlisten()); };
  }, [refresh]);
}
