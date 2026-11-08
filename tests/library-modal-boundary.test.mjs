import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canOpenLibraryContextMenu, focusLibraryModal } from '../src/features/library/modal-boundary.ts';

const closed = { launch: false, metadata: false, scan: false, share: false, folderPicker: false,
  folderMove: false, metadataImport: false, batchImport: false, deleteConfirmation: false };
const modalSelector = '[role="dialog"][aria-modal="true"]';

// Only the native DOM boundary is represented here. The production policy and
// focus transfer execute unchanged, without a browser, native calls or game data.
function scene() {
  const doc = { activeElement: null, dialogs: [],
    querySelector: selector => selector === modalSelector ? doc.dialogs[0] ?? null : null,
    querySelectorAll: selector => selector === modalSelector ? doc.dialogs : [],
  };
  const node = (parent = null) => ({ parent, attributes: new Map(),
    contains(other) { for (let current = other; current; current = current.parent) if (current === this) return true; return false; },
    hasAttribute(name) { return this.attributes.has(name); },
    setAttribute(name, value) { this.attributes.set(name, value); },
    focus() { doc.activeElement = this; },
  });
  const card = node(); card.focus();
  return { doc, card, node, openModal() { const dialog = node(); doc.dialogs.push(dialog); return dialog; } };
}

test('every pending Library modal prevents a bottom card menu before its portal mounts', () => {
  const { doc } = scene();
  assert.equal(canOpenLibraryContextMenu(closed, doc), true);
  for (const name of Object.keys(closed)) {
    assert.equal(canOpenLibraryContextMenu({ ...closed, [name]: true }, doc), false, name);
  }
});

test('an existing modal prevents stale card keyboard and right-click handlers even when local state says closed', () => {
  const { doc, openModal } = scene();
  openModal();
  assert.equal(canOpenLibraryContextMenu(closed, doc), false);
  doc.dialogs = [];
  assert.equal(canOpenLibraryContextMenu(closed, doc), true);
});

test('launch and metadata handoffs move card focus into the mounted dialog surface', () => {
  for (const kind of ['launch', 'metadata']) {
    const { doc, card, openModal } = scene();
    assert.equal(focusLibraryModal(doc), false, 'A future dialog cannot receive focus before it exists');
    const dialog = openModal();
    assert.equal(doc.activeElement, card);
    assert.equal(focusLibraryModal(doc), true, kind);
    assert.equal(dialog.contains(doc.activeElement), true, kind);
    assert.equal(dialog.attributes.get('tabindex'), '-1');
    assert.equal(canOpenLibraryContextMenu(closed, doc), false, 'The menu key cannot reopen the underlying card menu');
  }
});

test('focus transfer targets the newest real dialog and preserves focus already inside it', () => {
  const { doc, node, openModal } = scene();
  const first = openModal();
  const latest = openModal();
  const input = node(latest); input.focus();
  assert.equal(focusLibraryModal(doc), true);
  assert.equal(doc.activeElement, input);
  first.focus();
  assert.equal(focusLibraryModal(doc), true);
  assert.equal(doc.activeElement, latest);
});
