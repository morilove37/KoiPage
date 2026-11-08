import { GAME_STATUSES, GAME_STATUS_LABELS, isFavorite } from '../../types/game.ts';
import type { Game, GameStatus } from '../../types/game.ts';

export type GameContextActionId = 'detail' | 'files' | 'launch' | 'directory' | 'metadata' | 'backup'
  | 'favorite:on' | 'favorite:off' | `status:${GameStatus}`;
export interface GameContextAction {
  id: GameContextActionId;
  label: string;
  group: 'game' | 'favorite' | 'status' | 'tools';
  disabled: boolean;
  checked?: boolean;
  hint?: string;
  destination?: 'launch' | 'backup' | 'saves';
}
export interface GameContextState {
  loaded: boolean;
  archived: boolean;
  process: string;
  busy: boolean;
  backupBlocked?: boolean;
}

/** Right-click preserves selection; only an already selected target addresses the visible selection. */
export function contextMenuTargets<T extends { id: number }>(targetId: number, selected: ReadonlySet<number>, visible: readonly T[]): T[] {
  if (!visible.some(game => game.id === targetId)) return [];
  return visible.filter(game => selected.has(targetId) ? selected.has(game.id) : game.id === targetId);
}

export function isContextMenuCurrent(snapshot: { scope: string; gameIds: readonly number[] }, scope: string, visible: readonly { id: number }[]): boolean {
  if (snapshot.scope !== scope || !snapshot.gameIds.length) return false;
  const available = new Set(visible.map(game => game.id));
  return snapshot.gameIds.every(id => available.has(id));
}

export function gameContextActions(games: readonly Game[], state: GameContextState): GameContextAction[] {
  if (!games.length) return [];
  const single = games.length === 1;
  const game = games[0];
  const busy = state.busy;
  const statuses: GameContextAction[] = GAME_STATUSES.map(status => ({
    id: `status:${status}`, label: `${single ? '' : '全部设为'}${GAME_STATUS_LABELS[status]}`,
    group: 'status', disabled: busy,
    checked: games.every(game => game.status === status),
  }));
  const favorites: GameContextAction[] = single ? [{
    id: isFavorite(game) ? 'favorite:off' : 'favorite:on', label: isFavorite(game) ? '取消收藏' : '加入收藏',
    group: 'favorite', disabled: busy,
  }] : [
    { id: 'favorite:on', label: '收藏选中的游戏', group: 'favorite', disabled: busy },
    { id: 'favorite:off', label: '取消选中游戏的收藏', group: 'favorite', disabled: busy },
  ];
  if (!single) return [...favorites, ...statuses];
  const starting = state.process === 'starting';
  const running = state.process === 'running' || state.process === 'stopping';
  const launchHint = !state.loaded ? '正在读取安装状态' : state.archived ? '请在路径与启动中恢复为已安装'
    : !game.exePath?.trim() ? '请先在路径与启动中设置可执行文件' : starting ? '正在启动，请稍候' : undefined;
  const hasSave = Boolean(game.savePath?.trim());
  const backupBlocked = running || starting || state.backupBlocked;
  return [
    { id: 'launch', label: starting ? '启动中…' : running ? '查看运行中的游戏' : '启动游戏', group: 'game',
      disabled: busy || Boolean(launchHint), hint: launchHint, destination: 'launch' },
    { id: 'directory', label: '打开游戏目录', group: 'game', disabled: busy || !state.loaded || state.archived || !game.installPath.trim(),
      hint: state.archived ? '游戏已卸载 / 已归档' : !game.installPath.trim() ? '尚未设置游戏目录' : undefined },
    { id: 'detail', label: '查看游戏详情', group: 'game', disabled: busy },
    { id: 'files', label: '路径与启动设置…', group: 'game', disabled: busy },
    ...favorites, ...statuses,
    { id: 'metadata', label: '联网获取资料…', group: 'tools', disabled: busy },
    { id: 'backup', label: hasSave ? '立即备份存档' : '设置存档与备份…', group: 'tools',
      disabled: busy || hasSave && Boolean(backupBlocked), destination: hasSave ? 'backup' : 'saves',
      hint: !hasSave ? '先在存档备份分区选择存档目录或文件' : backupBlocked ? '请先正常退出所有正在运行的游戏，再备份存档' : undefined },
  ];
}

export function contextMenuPosition(point: { x: number; y: number }, size: { width: number; height: number }, viewport: { width: number; height: number }) {
  return {
    left: Math.max(8, Math.min(point.x, viewport.width - size.width - 8)),
    top: Math.max(8, Math.min(point.y, viewport.height - size.height - 8)),
  };
}

export function nextMenuIndex(actions: readonly { disabled: boolean }[], current: number, key: string): number {
  const enabled = actions.flatMap((action, index) => action.disabled ? [] : [index]);
  if (!enabled.length) return -1;
  if (key === 'Home') return enabled[0];
  if (key === 'End') return enabled[enabled.length - 1];
  const position = enabled.indexOf(current);
  if (position < 0) return key === 'ArrowUp' ? enabled[enabled.length - 1] : enabled[0];
  return enabled[(position + (key === 'ArrowUp' ? -1 : 1) + enabled.length) % enabled.length];
}

export function isContextMenuKey(event: { key: string; shiftKey: boolean }): boolean {
  return event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey;
}

export function allowsGameContextEvent(target: { closest?: (selector: string) => unknown } | null, eventType = 'pointerdown'): boolean {
  return eventType === 'contextmenu' || Boolean(target?.closest?.('[data-game-context-trigger], [data-game-context-menu]'));
}

export function restoreFocusAfterOutsideClick(target: { closest?: (selector: string) => unknown } | null, button: number): boolean {
  return button === 2 || !target?.closest?.('a[href],button,input,select,textarea,[contenteditable="true"],[tabindex]:not([tabindex="-1"])');
}
