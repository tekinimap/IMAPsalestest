import { getHasUnsavedChanges, getIsBatchRunning, setHasUnsavedChanges } from '../state.js';

export function initCommonEvents({
  dockEntryDialog,
  onDockDialogCloseRequest,
  onDockDialogClosed,
}) {
  if (dockEntryDialog) {
    dockEntryDialog.addEventListener('cancel', (event) => {
      if (getHasUnsavedChanges()) {
        const confirmed = confirm('Ungespeicherte Änderungen gehen verloren. Trotzdem schließen?');
        if (!confirmed) {
          event.preventDefault();
        }
      }
    });

    dockEntryDialog.addEventListener('close', () => {
      onDockDialogClosed?.();
      setHasUnsavedChanges(false);
    });
  }

  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!target || !(target instanceof HTMLElement)) return;
    if (target.tagName !== 'DIALOG') return;
    const dialogEl = target;
    if (!dialogEl.open) return;
    if (dialogEl.id === 'dockEntryDialog') {
      onDockDialogCloseRequest?.();
    } else {
      dialogEl.close();
    }
  });

  window.addEventListener('beforeunload', (e) => {
    if (getHasUnsavedChanges() || getIsBatchRunning()) {
      const msg = getIsBatchRunning()
        ? 'Eine Batch-Verarbeitung läuft noch. Sind Sie sicher, dass Sie die Seite verlassen wollen?'
        : 'Ungespeicherte Änderungen gehen verloren. Sind Sie sicher?';
      e.preventDefault();
      e.returnValue = msg;
      return msg;
    }
    return undefined;
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target?.tagName === 'INPUT' && !e.target.closest('#viewAdmin')) {
      e.preventDefault();
    }
  });
}
