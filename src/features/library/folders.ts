export interface LibraryFolder { id: string; name: string; gameIds: number[]; parentId?: string; contentMode?: 'folders' | 'games' }
export const FOLDERS_KEY = 'library.custom-folders.v1';

interface SocietyGame { id: number; developer: string | null }
export function matchesSociety(value: string, game: SocietyGame): boolean {
  return (game.developer ?? '').trim() === value;
}
export function groupBySociety(games: readonly SocietyGame[]): Array<{ name: string; value: string; gameIds: number[] }> {
  const groups = new Map<string, number[]>();
  for (const game of games) {
    const value = (game.developer ?? '').trim();
    const ids = groups.get(value) ?? [];
    ids.push(game.id);
    groups.set(value, ids);
  }
  return [...groups].sort(([a], [b]) => !a ? 1 : !b ? -1 : a.localeCompare(b, 'zh-Hans-CN'))
    .map(([value, gameIds]) => ({ name: value || '未知社团', value, gameIds }));
}

export function parseFolders(raw: string | null): LibraryFolder[] {
  let value: unknown;
  try { value = JSON.parse(raw ?? '[]'); } catch { return []; }
  if (!Array.isArray(value)) return [];
  const folders: LibraryFolder[] = [];
  for (const item of value) {
    if (!item || typeof item.id !== 'string' || !item.id || item.id === 'unfiled' || typeof item.name !== 'string') continue;
    const name = item.name.trim().slice(0, 40);
    if (!name || folders.some(folder => folder.id === item.id)) continue;
    const gameIds = Array.isArray(item.gameIds)
      ? [...new Set(item.gameIds.filter((id: unknown): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id > 0))] as number[] : [];
    folders.push({ id: item.id, name, gameIds, ...(typeof item.parentId === 'string' && item.parentId ? {parentId:item.parentId} : {}), ...(item.contentMode === 'folders' || item.contentMode === 'games' ? {contentMode:item.contentMode} : {}) });
  }
  const byId = new Map(folders.map(folder => [folder.id, folder]));
  for (const folder of folders) {
    const seen = new Set([folder.id]);
    let parentId = folder.parentId;
    while (parentId) {
      if (seen.has(parentId) || !byId.has(parentId)) { delete folder.parentId; break; }
      seen.add(parentId);
      parentId = byId.get(parentId)?.parentId;
    }
  }
  return folders;
}

function validName(folders: LibraryFolder[], value: string, exceptId?: string, parentId?: string): string {
  const name = value.trim().slice(0, 40);
  if (!name) throw new Error('请输入文件夹名称。');
  if (folders.some(folder => folder.id !== exceptId && folder.parentId === parentId && folder.name === name)) throw new Error('当前层级已存在同名文件夹。');
  return name;
}

export function createFolder(folders: LibraryFolder[], value: string, id: string, parentId?: string): LibraryFolder[] {
  if (parentId && !folders.some(folder => folder.id === parentId)) throw new Error('父文件夹不存在，请返回后重试。');
  const name = validName(folders, value, undefined, parentId);
  const next = parentId ? selectFolderMode(folders, parentId, 'folders') : folders;
  return [...next, { id, name, gameIds: [], ...(parentId ? {parentId} : {}) }];
}

export function getFolderMode(folders: LibraryFolder[], id: string): 'folders' | 'games' | 'mixed' | null {
  const folder = folders.find(item => item.id === id);
  if (!folder) return null;
  const hasChildren = folders.some(item => item.parentId === id);
  if (hasChildren && folder.gameIds.length > 0) return 'mixed';
  if (hasChildren) return 'folders';
  if (folder.gameIds.length > 0) return 'games';
  return folder.contentMode ?? null;
}
export function selectFolderMode(folders: LibraryFolder[], id: string, mode: 'folders' | 'games'): LibraryFolder[] {
  if (!folders.some(folder => folder.id === id)) throw new Error('文件夹不存在，请返回后重试。');
  const previous = getFolderMode(folders,id);
  if (previous && previous !== mode) throw new Error(previous === 'folders' ? '此文件夹用于收纳子文件夹，不能直接添加游戏。' : '此文件夹用于收纳游戏，不能创建子文件夹。');
  return folders.map(folder => folder.id === id ? {...folder,contentMode:mode} : folder);
}
export function renameFolder(folders: LibraryFolder[], id: string, value: string): LibraryFolder[] {
  const name = validName(folders, value, id, folders.find(folder => folder.id === id)?.parentId);
  return folders.map(folder => folder.id === id ? { ...folder, name } : folder);
}

export function folderPath(folders: LibraryFolder[], id: string): LibraryFolder[] {
  const path: LibraryFolder[] = [];
  const seen = new Set<string>();
  let current = folders.find(folder => folder.id === id);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.unshift(current);
    current = folders.find(folder => folder.id === current?.parentId);
  }
  return path;
}
export function removeFolderTree(folders: LibraryFolder[], id: string): LibraryFolder[] {
  const removed = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const folder of folders) if (folder.parentId && removed.has(folder.parentId) && !removed.has(folder.id)) { removed.add(folder.id); changed = true; }
  }
  return folders.filter(folder => !removed.has(folder.id)).map(folder =>
    !folder.contentMode && getFolderMode(folders,folder.id) === 'folders' ? {...folder,contentMode:'folders'} : folder,
  );
}
export function assignFolder(folders: LibraryFolder[], id: string, gameIds: number[], add: boolean): LibraryFolder[] {
  const next = add && gameIds.length ? selectFolderMode(folders,id,'games') : folders;
  return next.map(folder => folder.id !== id ? folder : {
    ...folder, ...(getFolderMode(folders,id) === 'games' ? {contentMode:'games' as const} : {}),
    gameIds: add ? [...new Set([...folder.gameIds, ...gameIds])] : folder.gameIds.filter(gameId => !gameIds.includes(gameId)),
  });
}
export function matchesFolder(folders: LibraryFolder[], id: string, gameId: number): boolean {
  if (!id) return true;
  if (id === 'unfiled') return !folders.some(folder => folder.gameIds.includes(gameId));
  return folders.some(folder => folder.id === id && folder.gameIds.includes(gameId));
}
