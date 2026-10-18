import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { errorMessage } from '@/features/io/io';
import { birthdaysList, birthdaysSyncCancel, birthdaysSyncStart } from './io';
import type { BirthdaySnapshot } from './types';

export function useBirthdays(libraryKey: string) {
  const [snapshot, setSnapshot] = useState<BirthdaySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const sequence = useRef(0);
  const requesting = useRef(false);
  const [starting, setStarting] = useState(false);
  const refresh = useCallback(async () => {
    const seq = ++sequence.current;
    try {
      const next = await birthdaysList();
      if (mounted.current && seq === sequence.current) { setSnapshot(next); setError(null); }
      return next;
    } catch (e) { if (mounted.current && seq === sequence.current) setError(errorMessage(e)); return null; }
  }, []);
  const sync = useCallback(async (force: boolean) => {
    if (requesting.current) return;
    requesting.current = true; if (mounted.current) setStarting(true);
    try { await birthdaysSyncStart(force); await refresh(); }
    catch (e) { if (mounted.current) setError(errorMessage(e)); }
    finally { requesting.current = false; if (mounted.current) setStarting(false); }
  }, [refresh]);
  const cancel = useCallback(async () => {
    try { await birthdaysSyncCancel(); await refresh(); }
    catch (e) { if (mounted.current) setError(errorMessage(e)); }
  }, [refresh]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; sequence.current++; }; }, []);
  useEffect(() => {
    let disposed = false;
    const update = () => { void refresh(); };
    const wake = () => { if (document.visibilityState === 'visible') { void refresh(); void sync(false); } };
    const subscription = listen('birthdays-updated', update);
    void subscription.then(remove => { if (disposed) remove(); }).catch(() => {});
    void refresh(); void sync(false);
    window.addEventListener('focus', wake); document.addEventListener('visibilitychange', wake);
    return () => {
      disposed = true; void subscription.then(remove => remove()).catch(() => {});
      window.removeEventListener('focus', wake); document.removeEventListener('visibilitychange', wake);
    };
  }, [libraryKey, refresh, sync]);
  useEffect(() => {
    if (!snapshot?.progress.running) return;
    const timer = window.setInterval(() => { void refresh(); }, 1500);
    return () => window.clearInterval(timer);
  }, [snapshot?.progress.running, refresh]);
  return { snapshot, error, starting, refresh, sync, cancel };
}

export function useLocalBirthdayDay() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer: number;
    const update = () => {
      window.clearTimeout(timer);
      const current = new Date(); setNow(current);
      const midnight = new Date(current.getFullYear(), current.getMonth(), current.getDate() + 1);
      timer = window.setTimeout(update, midnight.getTime() - current.getTime() + 100);
    };
    const visible = () => { if (document.visibilityState === 'visible') update(); };
    update(); window.addEventListener('focus', update); document.addEventListener('visibilitychange', visible);
    return () => { window.clearTimeout(timer); window.removeEventListener('focus', update); document.removeEventListener('visibilitychange', visible); };
  }, []);
  return now;
}
