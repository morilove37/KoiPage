import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  contextMenuTargets, gameContextActions, contextMenuPosition, nextMenuIndex,
  isContextMenuKey, allowsGameContextEvent, isContextMenuCurrent, restoreFocusAfterOutsideClick,
} from '../src/features/library/context-menu.ts';

const game = (id, patch = {}) => ({ id, title: `游戏 ${id}`, favorite: 0, status: 'unplayed',
  installPath: 'E:\\Games\\Title', exePath: 'E:\\Games\\Title\\game.exe', savePath: 'E:\\Saves', ...patch });
const ready = { loaded: true, archived: false, process: 'idle', busy: false };

test('a selected target opens only the currently visible selection in display order', () => {
  assert.deepEqual(contextMenuTargets(2, new Set([99, 3, 2]), [game(1), game(2), game(3)]).map(g => g.id), [2, 3]);
  assert.deepEqual(contextMenuTargets(1, new Set([2, 3]), [game(1), game(2), game(3)]).map(g => g.id), [1]);
  assert.deepEqual(contextMenuTargets(99, new Set([99]), [game(1)]), []);
});

test('a menu snapshot closes when its target disappears or its filter and selection scope changes', () => {
  const snapshot = { scope: 'selected:2,3', gameIds: [2, 3] };
  assert.equal(isContextMenuCurrent(snapshot, 'selected:2,3', [game(2), game(3)]), true);
  assert.equal(isContextMenuCurrent(snapshot, 'selected:2,3', [game(2)]), false);
  assert.equal(isContextMenuCurrent(snapshot, 'selected:2', [game(2), game(3)]), false);
});

test('single game actions reflect favourite, status and configured backup destination', () => {
  const actions = gameContextActions([game(1, { favorite: 1, status: 'playing' })], ready);
  assert.equal(actions.find(a => a.id === 'favorite:off').disabled, false);
  assert.equal(actions.find(a => a.id === 'status:playing').checked, true);
  assert.equal(actions.find(a => a.id === 'backup').destination, 'backup');
  assert.equal(actions.find(a => a.id === 'metadata').disabled, false);
  assert.equal(actions.some(a => a.id === 'directory'), false);
});

test('archived, missing paths and starting games cannot be launched from the menu', () => {
  for (const [entry, state] of [[game(1), { ...ready, archived: true }],
    [game(1, { exePath: '  ', installPath: '' }), ready], [game(1), { ...ready, loaded: false }],
    [game(1), { ...ready, process: 'starting' }]]) {
    const actions = gameContextActions([entry], state);
    assert.equal(actions.find(a => a.id === 'launch').disabled, true);
    assert.equal(actions.find(a => a.id === 'files').disabled, false);
  }
});

test('running games open their launch panel and cannot be backed up before exit', () => {
  const actions = gameContextActions([game(1)], { ...ready, process: 'running' });
  assert.equal(actions.find(a => a.id === 'launch').destination, 'launch');
  assert.equal(actions.find(a => a.id === 'launch').disabled, false);
  assert.equal(actions.find(a => a.id === 'backup').disabled, true);
});

test('backup without a persisted save path leads to configuration instead of reporting a backup', () => {
  const actions = gameContextActions([game(1, { savePath: '  ' })], ready);
  assert.equal(actions.find(a => a.id === 'backup').destination, 'saves');
  assert.equal(actions.find(a => a.id === 'backup').disabled, false);
  const running = gameContextActions([game(1, { savePath: null })], { ...ready, process: 'running', backupBlocked: true });
  assert.equal(running.find(a => a.id === 'backup').disabled, false, 'Opening the existing setup partition performs no backup and remains available');
});

test('backup respects the existing server rule requiring every tracked game to have exited', () => {
  const actions = gameContextActions([game(1)], { ...ready, backupBlocked: true });
  assert.equal(actions.find(a => a.id === 'backup').disabled, true);
  assert.equal(actions.find(a => a.id === 'launch').disabled, false);
});

test('multi-selection exposes only batch-safe favourites and statuses and disables them while writing', () => {
  const actions = gameContextActions([game(1), game(2, { favorite: 1 })], ready);
  assert.deepEqual(actions.filter(a => !a.id.startsWith('status:')).map(a => a.id), ['favorite:on', 'favorite:off']);
  assert.equal(actions.filter(a => a.id.startsWith('status:')).length, 6);
  assert.equal(gameContextActions([game(1), game(2)], { ...ready, busy: true }).every(a => a.disabled), true);
  assert.deepEqual(gameContextActions([], ready), []);
});

test('menu placement remains within viewport even beside bottom and right edges', () => {
  assert.deepEqual(contextMenuPosition({ x: 990, y: 790 }, { width: 260, height: 450 }, { width: 1000, height: 800 }), { left: 732, top: 342 });
  assert.deepEqual(contextMenuPosition({ x: -40, y: -5 }, { width: 260, height: 900 }, { width: 300, height: 400 }), { left: 8, top: 8 });
});

test('keyboard navigation wraps and skips disabled actions with Home and End support', () => {
  const actions = [{ disabled: true }, { disabled: false }, { disabled: true }, { disabled: false }];
  assert.equal(nextMenuIndex(actions, -1, 'ArrowDown'), 1);
  assert.equal(nextMenuIndex(actions, 3, 'ArrowDown'), 1);
  assert.equal(nextMenuIndex(actions, 1, 'ArrowUp'), 3);
  assert.equal(nextMenuIndex(actions, 3, 'Home'), 1);
  assert.equal(nextMenuIndex(actions, 1, 'End'), 3);
  assert.equal(nextMenuIndex([{ disabled: true }], 0, 'ArrowDown'), -1);
  assert.equal(isContextMenuKey({ key: 'F10', shiftKey: true }), true);
  assert.equal(isContextMenuKey({ key: 'ContextMenu', shiftKey: false }), true);
  assert.equal(isContextMenuKey({ key: 'F10', shiftKey: false }), false);
});

test('global right-click suppression allows only game triggers and custom menu surfaces', () => {
  const target = { closest: selector => selector.includes('data-game-context-trigger') ? {} : null };
  assert.equal(allowsGameContextEvent(target), true);
  assert.equal(allowsGameContextEvent({ closest: () => null }), false);
  assert.equal(allowsGameContextEvent(null), false);
  assert.equal(allowsGameContextEvent({ closest: () => null }, 'contextmenu'), true,
    'Allow contextmenu observers to dismiss an open menu on an outside right-click; preventDefault still suppresses the native menu');
});

test('outside blank clicks restore the trigger while a clicked input or button keeps its focus', () => {
  assert.equal(restoreFocusAfterOutsideClick({ closest: () => null }, 0), true);
  assert.equal(restoreFocusAfterOutsideClick({ closest: () => ({}) }, 0), false);
  assert.equal(restoreFocusAfterOutsideClick({ closest: () => ({}) }, 2), true);
});
