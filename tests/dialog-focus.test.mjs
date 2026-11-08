import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountDialogFocus } from '../src/components/ui/dialog-focus.ts';

// Browser layout and focus APIs form the boundary. The production key/focus
// listeners, stack ordering and cleanup execute unchanged.
function scene() {
  const doc = new EventTarget();
  doc.activeElement = null;
  const node = (parent = null) => ({ parent, ownerDocument: doc, isConnected: true, tabIndex: 0,
    contains(other) { for (let n = other; n; n = n.parent) if (n === this) return true; return false; },
    focus() { doc.activeElement = this; doc.dispatchEvent(new Event('focusin')); },
    closest() { return null; }, getClientRects() { return [1]; },
  });
  const trigger = node(); trigger.focus();
  const modal = () => {
    const panel = node(); panel.tabIndex = -1;
    const first = node(panel), last = node(panel);
    panel.querySelectorAll = () => [first, last];
    return { panel, first, last };
  };
  const key = (value, shiftKey = false) => {
    const event = new Event('keydown', { cancelable: true });
    Object.assign(event, { key: value, shiftKey, isComposing: false });
    doc.dispatchEvent(event);
    return event;
  };
  return { doc, trigger, modal, key };
}

test('opening a dialog transfers background focus inside and closing restores its trigger', () => {
  const { doc, trigger, modal } = scene(); const { panel, first } = modal();
  const close = mountDialogFocus(panel, () => {}, trigger);
  assert.equal(doc.activeElement, first);
  close();
  assert.equal(doc.activeElement, trigger);
});

test('Shift+Tab from the dialog surface or first control wraps to its last control', () => {
  const { doc, trigger, modal, key } = scene(); const { panel, first, last } = modal();
  const close = mountDialogFocus(panel, () => {}, trigger);
  for (const start of [panel, first]) {
    start.focus();
    assert.equal(key('Tab', true).defaultPrevented, true);
    assert.equal(doc.activeElement, last);
  }
  close();
});

test('Tab wraps at the final control, and attempted background focus returns inside', () => {
  const { doc, trigger, modal, key } = scene(); const { panel, first, last } = modal();
  const close = mountDialogFocus(panel, () => {}, trigger);
  last.focus();
  assert.equal(key('Tab').defaultPrevented, true);
  assert.equal(doc.activeElement, first);
  trigger.focus();
  assert.equal(panel.contains(doc.activeElement), true);
  close();
});

test('only the top dialog handles Escape and focus returns to its parent before the page', () => {
  const { doc, trigger, modal, key } = scene();
  const parent = modal(), child = modal(); let parentCalls = 0, childCalls = 0;
  const closeParent = mountDialogFocus(parent.panel, () => parentCalls++, trigger);
  parent.last.focus();
  const closeChild = mountDialogFocus(child.panel, () => childCalls++, parent.last);
  key('Escape');
  assert.equal(childCalls, 1); assert.equal(parentCalls, 0);
  closeChild(); assert.equal(doc.activeElement, parent.last);
  key('Escape'); assert.equal(parentCalls, 1);
  closeParent(); assert.equal(doc.activeElement, trigger);
});

test('an empty dialog keeps focus on its surface, and removed triggers are not restored', () => {
  const { doc, trigger, modal, key } = scene(); const { panel } = modal();
  panel.querySelectorAll = () => [];
  const close = mountDialogFocus(panel, () => {}, trigger);
  assert.equal(doc.activeElement, panel);
  key('Tab', true); assert.equal(doc.activeElement, panel);
  trigger.isConnected = false; close();
  assert.notEqual(doc.activeElement, trigger);
});

test('existing input autofocus is preserved and disposed listeners cannot intercept keys', () => {
  const { doc, trigger, modal, key } = scene(); const { panel, last } = modal(); let calls = 0;
  last.focus();
  const close = mountDialogFocus(panel, () => calls++, trigger);
  assert.equal(doc.activeElement, last);
  close(); key('Escape');
  assert.equal(calls, 0);
  assert.equal(doc.activeElement, trigger);
});
