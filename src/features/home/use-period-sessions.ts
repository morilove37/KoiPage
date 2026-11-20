import { useEffect, useState } from 'react';
import { playSessionsForPeriod } from '@/lib/db';
import type { PlaySession } from '@/types/game';

/** Bind results to their requested range and revision. */
export function usePeriodSessions(bounds: { start: string; end: string }, refreshKey: string, attempt: number, setNow: (date: Date) => void, enabled = true) {
  const { start, end } = bounds;
  const key = JSON.stringify([start, end, refreshKey, attempt]);
  const [result, setResult] = useState<{ key: string; sessions: PlaySession[]; error: string | null } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void playSessionsForPeriod(start, end).then(sessions => {
      if (!cancelled) { setResult({ key, sessions, error: null }); setNow(new Date()); }
    }).catch(cause => {
      if (!cancelled) setResult({ key, sessions: [], error: cause instanceof Error ? cause.message : String(cause) });
    });
    return () => { cancelled = true; };
  }, [start, end, key, setNow, enabled]);
  return { sessions: result?.key === key ? result.sessions : [], loading: result?.key !== key, error: result?.key === key ? result.error : null };
}
