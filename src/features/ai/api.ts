import { invoke } from '@tauri-apps/api/core';
import { initDatabase, gameGet, gamesList, gamesStats, gameUpdate, tagsList } from '@/lib/db';
import { gameProcesses } from '@/features/launch/game-process';
import { useAppStore } from '@/store/app';
import type { GameListFilter, GamePatch } from '@/types/game';
import { TOOLS, createToolExecutor, launchChecked, type Message } from './agent';

export interface AiConfig { baseUrl: string; model: string; hasKey: boolean }
export async function getConfig(): Promise<AiConfig> {
  await initDatabase(); return invoke<AiConfig>('ai_config_get');
}
export async function saveConfig(config: Pick<AiConfig, 'baseUrl' | 'model'>, apiKey: string, clearKey = false): Promise<AiConfig> {
  await initDatabase(); return invoke<AiConfig>('ai_config_save', { config: { baseUrl: config.baseUrl, model: config.model }, apiKey: apiKey || null, clearKey });
}
async function request<T>(payload: Record<string, unknown>, signal: AbortSignal): Promise<T> {
  await initDatabase(); signal.throwIfAborted();
  const id = crypto.randomUUID();
  const cancel = () => { void invoke('ai_cancel', { id }).catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try { return await invoke<T>('ai_request', { request: { ...payload, id } }); }
  finally { signal.removeEventListener('abort', cancel); }
}
export function testConfig(config: Pick<AiConfig, 'baseUrl' | 'model'>, apiKey: string, signal: AbortSignal) {
  return request<{ ok: boolean; message: string }>({ test: true, config, apiKey: apiKey || null }, signal);
}
export function chat(messages: Message[], signal: AbortSignal): Promise<Message> {
  return request<Message>({ messages, tools: TOOLS }, signal);
}
export function executor(navigate: (path: string) => void, confirmLaunch: (title: string) => Promise<boolean>, signal: AbortSignal) {
  return createToolExecutor({
    list: async filter => (await gamesList(filter as GameListFilter)).map(game => ({ ...game })),
    get: async id => ({ ...await gameGet(id) }), tags: tagsList, stats: gamesStats,
    update: (id, patch) => gameUpdate(id, patch as GamePatch),
    open: async id => { navigate(`/library/${id}`); },
    launch: id => launchChecked(gameProcesses, id, signal), confirmLaunch,
    changed: () => useAppStore.getState().bumpPlayTimeRevision(),
  }, signal);
}
