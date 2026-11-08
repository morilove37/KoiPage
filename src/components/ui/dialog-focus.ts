const stacks = new WeakMap<Document, HTMLElement[]>();
const focusableSelector = 'a[href],area[href],button,input,select,textarea,[tabindex],[contenteditable="true"]';

/** A portal needs a real keyboard boundary in addition to aria-modal semantics. */
export function mountDialogFocus(panel: HTMLElement, onClose: () => void, returnFocus: Element | null): () => void {
  const doc = panel.ownerDocument;
  const stack = stacks.get(doc) ?? [];
  stacks.set(doc, stack);
  stack.push(panel);
  const isTop = () => stack[stack.length - 1] === panel;
  const controls = () => Array.from(panel.querySelectorAll<HTMLElement>(focusableSelector))
    .filter(element => element.tabIndex >= 0 && !element.closest('[disabled],[hidden],[inert],[aria-hidden="true"]') && element.getClientRects().length > 0);
  const focusInside = () => (controls()[0] ?? panel).focus({ preventScroll: true });
  const onFocus = () => {
    if (isTop() && !panel.contains(doc.activeElement)) focusInside();
  };
  const onKey = (event: KeyboardEvent) => {
    if (!isTop() || event.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopImmediatePropagation();
      onClose();
    } else if (event.key === 'Tab') {
      const items = controls(), current = doc.activeElement;
      const index = items.findIndex(element => element === current);
      if (index < 0 || (event.shiftKey ? index === 0 : index === items.length - 1)) {
        event.preventDefault();
        (event.shiftKey ? items[items.length - 1] ?? panel : items[0] ?? panel).focus({ preventScroll: true });
      }
    }
  };
  doc.addEventListener('keydown', onKey, true);
  doc.addEventListener('focusin', onFocus, true);
  onFocus();
  return () => {
    const wasTop = isTop();
    doc.removeEventListener('keydown', onKey, true);
    doc.removeEventListener('focusin', onFocus, true);
    const index = stack.indexOf(panel);
    if (index >= 0) stack.splice(index, 1);
    if (!wasTop) return;
    const parent = stack[stack.length - 1];
    if (returnFocus?.isConnected && 'focus' in returnFocus && (!parent || parent.contains(returnFocus))) {
      (returnFocus as HTMLElement).focus({ preventScroll: true });
    } else if (parent) {
      parent.focus({ preventScroll: true });
    }
  };
}
