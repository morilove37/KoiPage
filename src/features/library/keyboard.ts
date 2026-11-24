import { GAME_STATUSES } from '../../types/game.ts';
import type { GameStatus } from '../../types/game.ts';

/**
 * Keyboard navigation for the library grid/list.
 *
 * The rules live here as pure functions so they can be tested without a DOM:
 * `libraryKeyIntent` decides what a key press means, and `nextFocusIndex` /
 * `rowFocusIndex` move the roving focus. `LibraryPage` only performs the
 * resulting effects.
 *
 * Bindings follow what game launchers and media browsers settled on: arrow keys
 * move, Home/End jump to the ends, Enter opens, F favourites, Esc clears, and
 * `?`/F1 shows the cheat sheet. Vim-style J/K is deliberately not offered —
 * nobody reaches for it outside a terminal.
 */
export type LibraryKeyIntent =
  | { type: 'move'; delta: 1 | -1 }
  | { type: 'row'; delta: 1 | -1 }
  | { type: 'page'; delta: 1 | -1 }
  | { type: 'first' }
  | { type: 'last' }
  | { type: 'open' }
  | { type: 'launch' }
  | { type: 'favorite' }
  | { type: 'toggleSelect' }
  | { type: 'selectAll' }
  | { type: 'status'; status: GameStatus }
  | { type: 'help' }
  | { type: 'escape' };

interface KeyLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

interface ElementLike {
  tagName?: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
  getAttribute?: (name: string) => string | null;
}

/** True when the user is typing into a field: shortcuts must stay out of the way. */
export function isTypingTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const element = target as ElementLike;
  if (element.isContentEditable) return true;
  const tag = (element.tagName ?? '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return element.getAttribute?.('role') === 'textbox';
}

/**
 * True when a key press may be read as a library shortcut.
 *
 * Focus parked on a button or link keeps its native keyboard behaviour, but a
 * focused game card (which contains links and buttons) still accepts shortcuts
 * so arrow navigation keeps working after a card is focused.
 */
export function acceptsLibraryShortcut(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  if (isTypingTarget(target)) return false;
  const element = target as ElementLike;
  if (!element.closest) return true;
  if (element.closest('[data-game-entry]')) return true;
  return !element.closest('a, button, input, select, textarea, [role="button"], [role="checkbox"], [contenteditable="true"]');
}

export function libraryKeyIntent(event: KeyLike, options: { selectMode: boolean }): LibraryKeyIntent | null {
  const modified = Boolean(event.ctrlKey || event.metaKey);
  const key = event.key;
  if (modified) {
    // Ctrl/Cmd+A selects the whole filtered result set, but only while the
    // multi-select toolbar is already open; otherwise it stays "select text".
    if ((key === 'a' || key === 'A') && options.selectMode) return { type: 'selectAll' };
    return null;
  }
  if (event.altKey) return null;
  if (key === 'ArrowRight') return { type: 'move', delta: 1 };
  if (key === 'ArrowLeft') return { type: 'move', delta: -1 };
  if (key === 'ArrowDown') return { type: 'row', delta: 1 };
  if (key === 'ArrowUp') return { type: 'row', delta: -1 };
  if (key === 'PageDown') return { type: 'page', delta: 1 };
  if (key === 'PageUp') return { type: 'page', delta: -1 };
  if (key === 'Home') return { type: 'first' };
  if (key === 'End') return { type: 'last' };
  if (key === '?' || key === 'F1') return { type: 'help' };
  if (key === 'Enter') return { type: 'open' };
  if (key === 'f' || key === 'F') return { type: 'favorite' };
  if (key === 'l' || key === 'L') return { type: 'launch' };
  if (key === 'x' || key === 'X') return { type: 'toggleSelect' };
  if (key === 'Escape') return { type: 'escape' };
  const digit = Number(key);
  if (Number.isInteger(digit) && digit >= 1 && digit <= GAME_STATUSES.length) {
    return { type: 'status', status: GAME_STATUSES[digit - 1] };
  }
  return null;
}

/**
 * Next roving-focus index along the reading order, clamped to the list.
 *
 * `-1` means "nothing focused yet": moving forward enters at the top, moving
 * back enters at the bottom. An empty list stays at `-1`.
 */
export function nextFocusIndex(current: number, delta: number, length: number): number {
  if (length <= 0) return -1;
  if (current < 0 || current >= length) return delta > 0 ? 0 : length - 1;
  return Math.min(Math.max(current + delta, 0), length - 1);
}

/**
 * Focus index `rows` rows away in a grid of `columns` columns.
 *
 * Down from the last row lands on the final item rather than nowhere, which is
 * what every other grid does. A single-column list passes `columns = 1`, so
 * ArrowUp/ArrowDown behave like previous/next there.
 */
export function rowFocusIndex(current: number, rows: number, length: number, columns: number): number {
  if (length <= 0) return -1;
  const step = Math.max(1, Math.floor(columns)) * rows;
  if (current < 0 || current >= length) return nextFocusIndex(current, step, length);
  return Math.min(Math.max(current + step, 0), length - 1);
}
