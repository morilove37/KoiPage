import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptsLibraryShortcut, isTypingTarget, libraryKeyIntent, nextFocusIndex, rowFocusIndex } from '../src/features/library/keyboard.ts';

const press = (key, patch = {}) => ({ key, ...patch });
const element = (patch = {}) => ({ tagName: 'DIV', getAttribute: () => null, closest: () => null, ...patch });

test('typing targets keep native keyboard behaviour', () => {
  assert.equal(isTypingTarget({ tagName: 'INPUT' }), true);
  assert.equal(isTypingTarget({ tagName: 'textarea' }), true);
  assert.equal(isTypingTarget({ tagName: 'SELECT' }), true);
  assert.equal(isTypingTarget({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(isTypingTarget({ tagName: 'DIV', getAttribute: name => (name === 'role' ? 'textbox' : null) }), true);
  assert.equal(isTypingTarget({ tagName: 'DIV' }), false);
  assert.equal(isTypingTarget(null), false);
});

test('shortcuts are refused inside fields and native controls but not on a game card', () => {
  assert.equal(acceptsLibraryShortcut({ tagName: 'INPUT', closest: () => null }), false);
  const card = element({ closest: selector => (selector === '[data-game-entry]' ? {} : null) });
  assert.equal(acceptsLibraryShortcut(card), true);
  const button = element({ closest: selector => (selector.startsWith('[data-game-entry]') ? null : {}) });
  assert.equal(acceptsLibraryShortcut(button), false);
  assert.equal(acceptsLibraryShortcut(element()), true);
  assert.equal(acceptsLibraryShortcut(null), false);
});

test('arrow keys move the roving focus and Enter opens the detail page', () => {
  assert.deepEqual(libraryKeyIntent(press('ArrowRight'), { selectMode: false }), { type: 'move', delta: 1 });
  assert.deepEqual(libraryKeyIntent(press('ArrowLeft'), { selectMode: false }), { type: 'move', delta: -1 });
  assert.deepEqual(libraryKeyIntent(press('ArrowDown'), { selectMode: false }), { type: 'row', delta: 1 });
  assert.deepEqual(libraryKeyIntent(press('ArrowUp'), { selectMode: false }), { type: 'row', delta: -1 });
  assert.deepEqual(libraryKeyIntent(press('PageDown'), { selectMode: false }), { type: 'page', delta: 1 });
  assert.deepEqual(libraryKeyIntent(press('PageUp'), { selectMode: false }), { type: 'page', delta: -1 });
  assert.deepEqual(libraryKeyIntent(press('Enter'), { selectMode: false }), { type: 'open' });
});

test('vim-style j/k are not shortcuts, so typing them does nothing', () => {
  assert.equal(libraryKeyIntent(press('j'), { selectMode: false }), null);
  assert.equal(libraryKeyIntent(press('K'), { selectMode: false }), null);
});

test('letters map to favourite, launch and multi-select', () => {
  assert.deepEqual(libraryKeyIntent(press('f'), { selectMode: false }), { type: 'favorite' });
  assert.deepEqual(libraryKeyIntent(press('L'), { selectMode: false }), { type: 'launch' });
  assert.deepEqual(libraryKeyIntent(press('x'), { selectMode: false }), { type: 'toggleSelect' });
});

test('digits set the six game statuses and out-of-range digits are ignored', () => {
  assert.deepEqual(libraryKeyIntent(press('1'), { selectMode: false }), { type: 'status', status: 'unplayed' });
  assert.deepEqual(libraryKeyIntent(press('3'), { selectMode: false }), { type: 'status', status: 'playing' });
  assert.deepEqual(libraryKeyIntent(press('6'), { selectMode: false }), { type: 'status', status: 'dropped' });
  assert.equal(libraryKeyIntent(press('7'), { selectMode: false }), null);
  assert.equal(libraryKeyIntent(press('0'), { selectMode: false }), null);
});

test('modifier keys never trigger a shortcut except Ctrl+A while selecting', () => {
  assert.equal(libraryKeyIntent(press('j', { ctrlKey: true }), { selectMode: false }), null);
  assert.equal(libraryKeyIntent(press('a', { ctrlKey: true }), { selectMode: false }), null);
  assert.deepEqual(libraryKeyIntent(press('a', { ctrlKey: true }), { selectMode: true }), { type: 'selectAll' });
  assert.deepEqual(libraryKeyIntent(press('A', { metaKey: true }), { selectMode: true }), { type: 'selectAll' });
  assert.equal(libraryKeyIntent(press('j', { altKey: true }), { selectMode: false }), null);
  assert.equal(libraryKeyIntent(press('Tab'), { selectMode: false }), null);
});

test('Escape always reports so the page can exit selection or clear focus', () => {
  assert.deepEqual(libraryKeyIntent(press('Escape'), { selectMode: false }), { type: 'escape' });
  assert.deepEqual(libraryKeyIntent(press('Escape'), { selectMode: true }), { type: 'escape' });
});

test('Home, End and question mark jump or open the cheat sheet', () => {
  assert.deepEqual(libraryKeyIntent(press('Home'), { selectMode: false }), { type: 'first' });
  assert.deepEqual(libraryKeyIntent(press('End'), { selectMode: false }), { type: 'last' });
  assert.deepEqual(libraryKeyIntent(press('?'), { selectMode: false }), { type: 'help' });
  assert.deepEqual(libraryKeyIntent(press('F1'), { selectMode: false }), { type: 'help' });
});

test('focus movement clamps to the list and enters from the correct end', () => {
  assert.equal(nextFocusIndex(-1, 1, 5), 0);
  assert.equal(nextFocusIndex(-1, -1, 5), 4);
  assert.equal(nextFocusIndex(0, 1, 5), 1);
  assert.equal(nextFocusIndex(4, 1, 5), 4);
  assert.equal(nextFocusIndex(0, -1, 5), 0);
  assert.equal(nextFocusIndex(3, 1, 0), -1);
  assert.equal(nextFocusIndex(9, 1, 5), 0);
});

test('arrow up/down step a visual row in the grid and clamp at the last row', () => {
  // Four columns, ten games: rows are 0-3, 4-7, 8-9.
  assert.equal(rowFocusIndex(0, 1, 10, 4), 4);
  assert.equal(rowFocusIndex(4, 1, 10, 4), 8);
  assert.equal(rowFocusIndex(9, 1, 10, 4), 9);
  assert.equal(rowFocusIndex(8, -1, 10, 4), 4);
  assert.equal(rowFocusIndex(1, -1, 10, 4), 0);
  // A single column is a plain list: up/down walk one item at a time.
  assert.equal(rowFocusIndex(2, 1, 10, 1), 3);
  assert.equal(rowFocusIndex(2, -1, 10, 1), 1);
  // Entering from nothing behaves like moving along the reading order.
  assert.equal(rowFocusIndex(-1, 1, 10, 4), 0);
  assert.equal(rowFocusIndex(-1, -1, 10, 4), 9);
  assert.equal(rowFocusIndex(0, 1, 0, 4), -1);
});
