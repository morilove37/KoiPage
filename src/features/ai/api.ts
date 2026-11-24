import { invoke } from '@tauri-apps/api/core';
import {
  initDatabase, gameGet, gamesList, gamesStats, gameUpdate, tagsList, tagCreate,
  settingsGet, settingsSet, metadataSearch, metadataDetail, metadataApply,
} from '@/lib/db';
import { gameProcesses } from '@/features/launch/game-process';
import { useAppStore } from '@/store/app';
import type { GameListFilter, GamePatch } from '@/types/game';
import { gamesBatchUpdate } from '@/features/library/api';
import { applyLibraryFolders } from '@/features/library/data-store';
import { FOLDERS_KEY, parseFolders } from '@/features/library/folders';
import type { LibraryFolder } from '@/features/library/folders';
import { TOOLS, createToolExecutor, launchChecked, type ConfirmationPreview, type Message } from './agent';

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
export function executor(
  navigate: (path: string) => void,
  confirm: (preview: ConfirmationPreview) => Promise<boolean>,
  signal: AbortSignal,
) {
  return createToolExecutor({
    list: async filter => (await gamesList(filter as GameListFilter)).map(game => ({ ...game })),
    get: async id => ({ ...await gameGet(id) }), tags: tagsList, stats: gamesStats,
    update: (id, patch) => gameUpdate(id, patch as GamePatch),
    open: async id => { navigate(`/library/${id}`); },
    launch: id => launchChecked(gameProcesses, id, signal), confirmLaunch: title => confirm({ title: `启动「${title}」？`, detail: '将按该游戏已保存的启动配置运行。' }),
    confirm,
    batchUpdate: (ids, patch) => gamesBatchUpdate(ids, patch as Parameters<typeof gamesBatchUpdate>[1]),
    searchMetadata: (query, sources) => metadataSearch(query, (sources?.length ? sources : ['nextmoe', 'vndb', 'bangumi', '2dfan']) as Parameters<typeof metadataSearch>[1]),
    metadataDetail: (provider, externalId) => metadataDetail(provider as Parameters<typeof metadataDetail>[0], externalId) as unknown as Promise<Record<string, unknown>>,
    applyMetadata: (id, detail, fields, tagMode) => metadataApply(
      id, detail as unknown as Parameters<typeof metadataApply>[1], fields as Parameters<typeof metadataApply>[2],
      tagMode as Parameters<typeof metadataApply>[3],
    ),
    folders: async () => parseFolders(await settingsGet(FOLDERS_KEY)),
    saveFolders: async (folders: LibraryFolder[]) => {
      try {
        await settingsSet(FOLDERS_KEY, JSON.stringify(folders));
        // 游戏文件夹 renders the shared folder cache, so a folder edit made by
        // the assistant has to land there too instead of waiting for a reload.
        applyLibraryFolders(folders);
        return true;
      } catch { return false; }
    },
    createTag: (name, color) => tagCreate(name, color ?? null),
    changed: () => useAppStore.getState().bumpPlayTimeRevision(),
  }, signal);
}
