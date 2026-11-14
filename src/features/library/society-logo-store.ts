import { useEffect } from 'react';
import { create } from 'zustand';
import { invoke } from '@/lib/logging';

export interface SocietyLogo { path: string | null; custom: boolean; source: string | null; checkedAt: number; retryAfter: number }
interface Entry { logo?: SocietyLogo; loading: boolean; saving: boolean; error: string | null }
const empty: Entry = { loading: false, saving: false, error: null };
export const useSocietyLogoStore = create<{ entries: Record<string, Entry> }>(() => ({ entries: {} }));
const pending = new Map<string, Promise<void>>();
const revisions = new Map<string, number>();
const revision = (name: string) => revisions.get(name) ?? 0;
function patch(name: string, update: Partial<Entry>) {
  useSocietyLogoStore.setState(state => ({ entries: { ...state.entries, [name]: { ...empty, ...state.entries[name], ...update } } }));
}

export function loadSocietyLogo(name: string, force = false): Promise<void> {
  name = name.trim();
  const cached = useSocietyLogoStore.getState().entries[name]?.logo;
  if (!name || !force && cached && (cached.custom || cached.path || cached.retryAfter > Date.now() / 1000)) return Promise.resolve();
  if (!force && pending.has(name)) return pending.get(name)!;
  const version = revision(name);
  patch(name, { loading: true });
  const task = invoke<SocietyLogo>('society_logo_get', { name }).then(logo => {
    if (revision(name) === version) patch(name, { logo, error: null });
  }).catch(cause => {
    if (revision(name) === version) patch(name, { error: String(cause) });
  }).finally(() => {
    if (revision(name) === version) patch(name, { loading: false });
    if (pending.get(name) === task) pending.delete(name);
  });
  pending.set(name, task);
  return task;
}

export async function saveSocietyLogo(name: string, path: string | null) {
  name = name.trim();
  if (!name || useSocietyLogoStore.getState().entries[name]?.saving) return;
  patch(name, { saving: true, error: null });
  try {
    const logo = await invoke<SocietyLogo>('society_logo_set', { name, path });
    revisions.set(name, revision(name) + 1);
    patch(name, { logo, loading: false });
    if (path === null) await loadSocietyLogo(name, true);
  } catch (cause) {
    patch(name, { error: String(cause), loading: false });
    throw cause;
  } finally { patch(name, { saving: false }); }
}

export function useSocietyLogo(name: string) {
  const entry = useSocietyLogoStore(state => state.entries[name.trim()] ?? empty);
  useEffect(() => { void loadSocietyLogo(name); }, [name]);
  return entry;
}
