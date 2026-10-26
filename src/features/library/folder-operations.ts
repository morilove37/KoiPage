import { folderPath, getFolderMode, selectFolderMode } from './folders.ts';
import type { LibraryFolder } from './folders.ts';

export interface FolderStatistics { childCount: number; descendantCount: number; gameCount: number }
export function folderStatistics(folders: LibraryFolder[], available: ReadonlySet<number>): Map<string, FolderStatistics> {
  const byId = new Map(folders.map(folder => [folder.id,folder]));
  const children = new Map<string, string[]>();
  for (const folder of folders) if (folder.parentId) children.set(folder.parentId,[...(children.get(folder.parentId) ?? []),folder.id]);
  const statistics = new Map<string, FolderStatistics>();
  for (const folder of folders) {
    const visited = new Set<string>();
    const games = new Set<number>();
    const pending = [folder.id];
    while (pending.length) {
      const id = pending.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      for (const gameId of byId.get(id)?.gameIds ?? []) if (available.has(gameId)) games.add(gameId);
      pending.push(...(children.get(id) ?? []));
    }
    statistics.set(folder.id,{childCount:children.get(folder.id)?.length ?? 0,descendantCount:visited.size-1,gameCount:games.size});
  }
  return statistics;
}

export function replaceFolderGames(folders: LibraryFolder[], id: string, selected: number[], available: ReadonlySet<number>): { folders: LibraryFolder[]; added: number; removed: number } {
  const folder = folders.find(item => item.id === id);
  if (!folder) throw new Error('文件夹已不存在，请返回后重试。');
  const chosen = new Set(selected.filter(gameId => available.has(gameId)));
  const before = new Set(folder.gameIds.filter(gameId => available.has(gameId)));
  const next = getFolderMode(folders,id) === 'mixed' ? folders : selectFolderMode(folders,id,'games');
  return {
    folders:next.map(item => item.id === id ? {...item,gameIds:[...item.gameIds.filter(gameId => !available.has(gameId)),...chosen]} : item),
    added:[...chosen].filter(gameId => !before.has(gameId)).length,
    removed:[...before].filter(gameId => !chosen.has(gameId)).length,
  };
}

export function canResetFolder(folders: LibraryFolder[], id: string, available: ReadonlySet<number>): boolean {
  const folder = folders.find(item => item.id === id);
  return Boolean(folder && !folder.gameIds.some(gameId => available.has(gameId)) && !folders.some(item => item.parentId === id));
}
export function resetEmptyFolder(folders: LibraryFolder[], id: string, available: ReadonlySet<number>): LibraryFolder[] {
  if (!canResetFolder(folders,id,available)) throw new Error('只有空文件夹才能重新选择类型，请先移出游戏或子文件夹。');
  return folders.map(folder => {
    if (folder.id !== id) return folder;
    const next = {...folder,gameIds:[]};
    delete next.contentMode;
    return next;
  });
}

/** Array order is the persisted order of siblings. The subtree keeps stable IDs. */
export function moveFolder(folders: LibraryFolder[], id: string, parentId?: string, beforeId?: string): LibraryFolder[] {
  const source = folders.find(folder => folder.id === id);
  if (!source) throw new Error('要移动的文件夹已不存在。');
  if (parentId && !folders.some(folder => folder.id === parentId)) throw new Error('目标文件夹已不存在。');
  if (parentId === id || parentId && folderPath(folders,parentId).some(folder => folder.id === id)) throw new Error('不能把文件夹移入自己或它的子文件夹。');
  if (beforeId === id && source.parentId === parentId) return folders;
  const before = beforeId ? folders.find(folder => folder.id === beforeId) : undefined;
  if (beforeId && (!before || before.parentId !== parentId)) throw new Error('排序位置已改变，请重新拖动。');
  if (folders.some(folder => folder.id !== id && folder.parentId === parentId && folder.name === source.name)) throw new Error('目标位置已有同名文件夹，请先重命名。');
  // Empty game folders remain game folders until explicitly reset by the user.
  let next = parentId && parentId !== source.parentId ? selectFolderMode(folders,parentId,'folders') : folders;
  next = next.map(folder => !folder.contentMode && getFolderMode(folders,folder.id) === 'folders' ? {...folder,contentMode:'folders'} : folder);
  const moved = {...next.find(folder => folder.id === id)!};
  if (parentId) moved.parentId = parentId; else delete moved.parentId;
  next = next.filter(folder => folder.id !== id);
  let index = beforeId ? next.findIndex(folder => folder.id === beforeId) : -1;
  if (index < 0) {
    const lastSibling = next.map((folder,position) => folder.parentId === parentId ? position : -1).filter(position => position >= 0).pop();
    index = lastSibling === undefined ? next.length : lastSibling+1;
  }
  return [...next.slice(0,index),moved,...next.slice(index)];
}
