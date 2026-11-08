export interface LibraryModalState {
  launch: boolean;
  metadata: boolean;
  scan: boolean;
  share: boolean;
  folderPicker: boolean;
  folderMove: boolean;
  metadataImport: boolean;
  batchImport: boolean;
  deleteConfirmation: boolean;
}

export const LIBRARY_MODAL_SELECTOR = '[role="dialog"][aria-modal="true"]';

export function canOpenLibraryContextMenu(state: LibraryModalState, document: Pick<Document, 'querySelector'>): boolean {
  return !Object.values(state).some(Boolean) && !document.querySelector(LIBRARY_MODAL_SELECTOR);
}

/** Focus the actual mounted modal surface, without assuming that a portal was ready during activation. */
export function focusLibraryModal(document: Pick<Document, 'querySelectorAll' | 'activeElement'>): boolean {
  const dialogs = document.querySelectorAll<HTMLElement>(LIBRARY_MODAL_SELECTOR);
  const dialog = dialogs[dialogs.length - 1];
  if (!dialog) return false;
  if (!dialog.contains(document.activeElement)) {
    if (!dialog.hasAttribute('tabindex')) dialog.setAttribute('tabindex', '-1');
    dialog.focus({ preventScroll: true });
  }
  return dialog.contains(document.activeElement);
}
