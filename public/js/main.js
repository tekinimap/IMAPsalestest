import { fetchWithRetry } from './api.js';
import { DEFAULT_WEIGHTS, WORKER_BASE, CONFIG_WARNINGS, CONFIG_ERRORS } from './config.js';
import { getEntries, findEntryById, upsertEntry, removeEntryById } from './entries-state.js';
import { loadState, saveState, getHasUnsavedChanges, setHasUnsavedChanges, getIsBatchRunning } from './state.js';
import { getPendingDockAbrufAssignment, clearDockSelection } from './state/dock-state.js';
import { getPendingDelete, resetPendingDelete, setPendingDelete } from './state/history-state.js';
import { initNavigation, showView } from './features/navigation.js';
import { autoComplete, filtered, getSelectedFixIds, initHistory, loadHistory, renderHistory } from './features/history.js';
import {
  initDockBoard,
  renderDockBoard,
  dockEntryDialog,
  requestDockEntryDialogClose,
  clearInputFields,
  queueDockAutoCheck,
  findDockKvConflict,
  finalizeDockAbruf,
  hideManualPanel,
  showManualPanel,
  openFrameworkVolumeDialog,
} from './features/dock-board.js';
import {
  initFrameworks,
  renderFrameworkContracts,
  renderRahmenDetails,
  openEditTransactionModal,
} from './features/frameworks.js';
import { initAnalytics } from './features/analytics.js';
import { initErfassung, initFromState } from './features/erfassung.js';
import { initPortfolio, renderPortfolio } from './features/portfolio.js';
import { loadSession, loadPeople } from './features/people.js';
import { initCommonEvents } from './features/common-events.js';
import { handleAdminClick, initAdminModule } from './features/admin.js';
import { clampDockRewardFactor, DOCK_WEIGHTING_DEFAULT } from './features/calculations.js';
import { initImporter } from './features/importer.js';
import {
  showToast,
  hideBatchProgress,
  showLoader,
  hideLoader,
  showBatchProgress,
  updateBatchProgress,
} from './ui/feedback.js';
import { formatDateForInput } from './utils/format.js';

const VALID_VIEWS = new Set(['erfassung', 'portfolio', 'analytics', 'admin']);
const DEFAULT_VIEW = 'erfassung';

function showConfigMessages() {
  const hasConfigWarnings = CONFIG_WARNINGS.length > 0;
  const hasConfigErrors = CONFIG_ERRORS.length > 0;

  if (hasConfigWarnings && typeof console !== 'undefined') {
    console.groupCollapsed?.('Konfiguration – Hinweise');
    CONFIG_WARNINGS.forEach((msg) => console.warn(msg));
    console.groupEnd?.();
  }

  if (hasConfigErrors && typeof console !== 'undefined') {
    console.groupCollapsed?.('Konfiguration – Fehler');
    CONFIG_ERRORS.forEach((msg) => console.error(msg));
    console.groupEnd?.();
  }

  if (hasConfigErrors) {
    showToast(
      `Konfiguration konnte nicht vollständig geladen werden (${CONFIG_ERRORS.length} Fehler). Es werden Standardwerte verwendet. Siehe Konsole für Details.`,
      'bad',
      9000
    );
  } else if (hasConfigWarnings) {
    const summary =
      CONFIG_WARNINGS.length === 1
        ? CONFIG_WARNINGS[0]
        : `Konfiguration geladen mit ${CONFIG_WARNINGS.length} Hinweis(en). Siehe Konsole für Details.`;
    showToast(summary, 'warn', 7000);
  }
}

function getInitialView() {
  const hash = (window.location.hash || '').replace('#', '').trim().toLowerCase();
  return VALID_VIEWS.has(hash) ? hash : DEFAULT_VIEW;
}

function clearEditingState() {
  const state = loadState();
  if (!state || !state.editingId) return state;

  const { editingId, ...rest } = state;
  saveState(rest);
  return rest;
}

function handleEditEntry(id) {
  const entry = getEntries().find((item) => item.id === id);
  if (!entry) return;

  const state = {
    source: entry.source || 'manuell',
    editingId: entry.id,
    input: {
      client: entry.client || '',
      title: entry.title || '',
      amount: entry.amount || 0,
      amountKnown: entry.amount > 0,
      projectType: entry.projectType || 'fix',
      submittedBy: entry.submittedBy || '',
      projectNumber: entry.projectNumber || '',
      kvNummer: entry.kv_nummer || '',
      freigabedatum: formatDateForInput(entry.freigabedatum || entry.ts),
      ts: entry.ts,
      rows:
        Array.isArray(entry.rows) && entry.rows.length
          ? entry.rows
          : Array.isArray(entry.list)
            ? entry.list.map((row) => ({ name: row.name, cs: 0, konzept: 0, pitch: 0 }))
            : [],
      weights: Array.isArray(entry.weights)
        ? entry.weights
        : [
            { key: 'cs', weight: DEFAULT_WEIGHTS.cs },
            { key: 'konzept', weight: DEFAULT_WEIGHTS.konzept },
            { key: 'pitch', weight: DEFAULT_WEIGHTS.pitch },
          ],
      dockRewardFactor: clampDockRewardFactor(entry.dockRewardFactor ?? DOCK_WEIGHTING_DEFAULT),
    },
  };

  saveState(state);
  initFromState(true);
  showView('erfassung');
  showManualPanel(entry.id);
}

async function updateFrameworkVolume(entry, volume) {
  try {
    showLoader();
    const res = await fetchWithRetry(`${WORKER_BASE}/entries/${encodeURIComponent(entry.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ frameworkVolume: volume }),
    });
    if (!res.ok) throw new Error(await res.text());
    showToast('Volumen aktualisiert', 'ok');
    await loadHistory(true);
  } catch (err) {
    console.error(err);
    showToast('Fehler beim Speichern: ' + err.message, 'bad');
  } finally {
  hideLoader();
}

function setupBatchDeleteButton() {
  const btnBatchDelete = document.getElementById('btnBatchDelete');
  if (!btnBatchDelete) return;

  btnBatchDelete.addEventListener('click', () => {
    const selectedIds = getSelectedFixIds();
    if (selectedIds.length === 0) return;

    setPendingDelete({ ids: selectedIds, type: 'batch-entry' });
    const title = document.getElementById('confirmDlgTitle');
    const text = document.getElementById('confirmDlgText');
    const dialog = document.getElementById('confirmDlg');

    if (title) title.textContent = 'Einträge löschen';
    if (text) text.textContent = `Wollen Sie die ${selectedIds.length} markierten Einträge wirklich löschen?`;
    dialog?.showModal();
  });
}

function setupXlsxExport() {
  const btnXlsx = document.getElementById('btnXlsx');
  if (!btnXlsx) return;

  btnXlsx.addEventListener('click', () => {
    const exportRows = filtered('fix').map((entry) => ({
      Projektnummer: entry.projectNumber || '',
      Titel: entry.title || '',
      Auftraggeber: entry.client || '',
      Quelle: entry.source || '',
      Status: autoComplete(entry) ? 'vollständig' : 'unvollständig',
      Wert_EUR: entry.amount || 0,
      Abschlussdatum: entry.freigabedatum
        ? new Date(entry.freigabedatum).toISOString().split('T')[0]
        : entry.ts
          ? new Date(entry.ts).toISOString().split('T')[0]
          : '',
    }));

    const worksheet = XLSX.utils.json_to_sheet(exportRows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Fixaufträge');
    XLSX.writeFile(workbook, 'fixauftraege_export.xlsx');
  });
}

function setupConfirmDialogHandlers() {
  const dialog = document.getElementById('confirmDlg');
  const btnNo = document.getElementById('btnNo');
  const btnYes = document.getElementById('btnYes');

  btnNo?.addEventListener('click', () => dialog?.close());

  if (!btnYes) return;

  btnYes.addEventListener('click', async () => {
    const { id, ids, type, parentId, fromDock } = getPendingDelete();
    dialog?.close();

    showLoader();
    try {
      if (type === 'entry') {
        if (!id) return;
        const response = await fetchWithRetry(`${WORKER_BASE}/entries/${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (!response.ok) throw new Error(await response.text());
        showToast('Eintrag gelöscht.', 'ok');
        removeEntryById(id);
        renderHistory();
        renderFrameworkContracts();
        renderPortfolio();
      } else if (type === 'batch-entry') {
        if (!ids || ids.length === 0) return;
        hideLoader();
        showBatchProgress(`Lösche ${ids.length} Einträge...`, 1);

        const response = await fetchWithRetry(`${WORKER_BASE}/entries/bulk-delete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids }),
        });
        updateBatchProgress(1, 1);

        if (!response.ok) {
          const errData = await response.json().catch(() => ({ error: 'Unbekannter Fehler beim Löschen' }));
          throw new Error(errData.error || `Serverfehler ${response.status}`);
        }

        const result = await response.json();
        showToast(`${result.deletedCount || 0} Einträge erfolgreich gelöscht.`, 'ok');
        await loadHistory();
        renderHistory();
        if (fromDock) {
          clearDockSelection();
          renderDockBoard();
        }
        renderPortfolio();
      } else if (type === 'transaction') {
        if (!id || !parentId) return;
        const entry = findEntryById(parentId);
        if (!entry || !Array.isArray(entry.transactions)) throw new Error('Parent entry or transactions not found');
        const originalTransactions = JSON.parse(JSON.stringify(entry.transactions));
        entry.transactions = entry.transactions.filter((transaction) => transaction.id !== id);
        entry.modified = Date.now();
        const response = await fetchWithRetry(`${WORKER_BASE}/entries/${encodeURIComponent(parentId)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(entry),
        });
        if (!response.ok) {
          entry.transactions = originalTransactions;
          throw new Error(await response.text());
        }
        showToast('Abruf gelöscht.', 'ok');
        upsertEntry(entry);
        renderRahmenDetails(parentId);
        renderPortfolio();
      }
    } catch (error) {
      showToast('Aktion fehlgeschlagen.', 'bad');
      console.error(error);
    } finally {
      hideLoader();
      hideBatchProgress();
      resetPendingDelete();
    }
  });
}
}

function setupBatchDeleteButton() {
  const btnBatchDelete = document.getElementById('btnBatchDelete');
  if (!btnBatchDelete) return;

  btnBatchDelete.addEventListener('click', () => {
    const selectedIds = getSelectedFixIds();
    if (selectedIds.length === 0) return;

    setPendingDelete({ ids: selectedIds, type: 'batch-entry' });
    const title = document.getElementById('confirmDlgTitle');
    const text = document.getElementById('confirmDlgText');
    const dialog = document.getElementById('confirmDlg');

    if (title) title.textContent = 'Einträge löschen';
    if (text) text.textContent = `Wollen Sie die ${selectedIds.length} markierten Einträge wirklich löschen?`;
    dialog?.showModal();
  });
}

function setupXlsxExport() {
  const btnXlsx = document.getElementById('btnXlsx');
  if (!btnXlsx) return;

  btnXlsx.addEventListener('click', () => {
    const exportRows = filtered('fix').map((entry) => ({
      Projektnummer: entry.projectNumber || '',
      Titel: entry.title || '',
      Auftraggeber: entry.client || '',
      Quelle: entry.source || '',
      Status: autoComplete(entry) ? 'vollständig' : 'unvollständig',
      Wert_EUR: entry.amount || 0,
      Abschlussdatum: entry.freigabedatum
        ? new Date(entry.freigabedatum).toISOString().split('T')[0]
        : entry.ts
          ? new Date(entry.ts).toISOString().split('T')[0]
          : '',
    }));

    const worksheet = XLSX.utils.json_to_sheet(exportRows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Fixaufträge');
    XLSX.writeFile(workbook, 'fixauftraege_export.xlsx');
  });
}

function setupConfirmDialogHandlers() {
  const dialog = document.getElementById('confirmDlg');
  const btnNo = document.getElementById('btnNo');
  const btnYes = document.getElementById('btnYes');

  btnNo?.addEventListener('click', () => dialog?.close());

  if (!btnYes) return;

  btnYes.addEventListener('click', async () => {
    const { id, ids, type, parentId, fromDock } = getPendingDelete();
    dialog?.close();

    showLoader();
    try {
      if (type === 'entry') {
        if (!id) return;
        const response = await fetchWithRetry(`${WORKER_BASE}/entries/${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (!response.ok) throw new Error(await response.text());
        showToast('Eintrag gelöscht.', 'ok');
        removeEntryById(id);
        renderHistory();
        renderFrameworkContracts();
        renderPortfolio();
      } else if (type === 'batch-entry') {
        if (!ids || ids.length === 0) return;
        hideLoader();
        showBatchProgress(`Lösche ${ids.length} Einträge...`, 1);

        const response = await fetchWithRetry(`${WORKER_BASE}/entries/bulk-delete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids }),
        });
        updateBatchProgress(1, 1);

        if (!response.ok) {
          const errData = await response.json().catch(() => ({ error: 'Unbekannter Fehler beim Löschen' }));
          throw new Error(errData.error || `Serverfehler ${response.status}`);
        }

        const result = await response.json();
        showToast(`${result.deletedCount || 0} Einträge erfolgreich gelöscht.`, 'ok');
        await loadHistory();
        renderHistory();
        if (fromDock) {
          clearDockSelection();
          renderDockBoard();
        }
        renderPortfolio();
      } else if (type === 'transaction') {
        if (!id || !parentId) return;
        const entry = findEntryById(parentId);
        if (!entry || !Array.isArray(entry.transactions)) throw new Error('Parent entry or transactions not found');
        const originalTransactions = JSON.parse(JSON.stringify(entry.transactions));
        entry.transactions = entry.transactions.filter((transaction) => transaction.id !== id);
        entry.modified = Date.now();
        const response = await fetchWithRetry(`${WORKER_BASE}/entries/${encodeURIComponent(parentId)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(entry),
        });
        if (!response.ok) {
          entry.transactions = originalTransactions;
          throw new Error(await response.text());
        }
        showToast('Abruf gelöscht.', 'ok');
        upsertEntry(entry);
        renderRahmenDetails(parentId);
        renderPortfolio();
      }
    } catch (error) {
      showToast('Aktion fehlgeschlagen.', 'bad');
      console.error(error);
    } finally {
      hideLoader();
      hideBatchProgress();
      resetPendingDelete();
    }
  });
}

function initFeatureModules() {
  initDockBoard({ renderFrameworkContracts, renderRahmenDetails, onEditEntry: handleEditEntry });
  initErfassung({
    clampDockRewardFactor,
    dockWeightingDefault: DOCK_WEIGHTING_DEFAULT,
    findDockKvConflict,
    queueDockAutoCheck,
    loadHistory,
    renderHistory,
    renderDockBoard,
    renderFrameworkContracts,
    finalizeDockAbruf,
    hideManualPanel,
    showView,
    getPendingDockAbrufAssignment,
  });
  initPortfolio({
    openEditTransactionModal,
    openFrameworkVolumeDialog,
    onUpdateFrameworkVolume: updateFrameworkVolume,
  });
}

async function showErfassungView(reloadHistory = true) {
  clearEditingState();

  if (getHasUnsavedChanges()) {
    const confirmed = confirm('Ungespeicherte Änderungen gehen verloren. Möchtest du fortfahren?');
    if (!confirmed) return;
    setHasUnsavedChanges(false);
  }

  if (reloadHistory) {
    await loadHistory();
  }

  hideManualPanel();
  renderDockBoard();
  showView('erfassung');
}

async function showPortfolioView(reloadHistory = true) {
  if (reloadHistory) {
    await loadHistory(true);
  }
  showView('portfolio');
  renderPortfolio();
}

async function showAnalyticsView(reloadHistory = true) {
  if (reloadHistory) {
    await loadHistory(true);
  }
  showView('analytics');
  initAnalytics();
}

async function showAdminView() {
  showView('admin');
  await handleAdminClick();
}

async function showViewByName(viewName, { reloadHistory = true } = {}) {
  switch (viewName) {
    case 'portfolio':
      await showPortfolioView(reloadHistory);
      break;
    case 'analytics':
      await showAnalyticsView(reloadHistory);
      break;
    case 'admin':
      await showAdminView();
      break;
    default:
      await showErfassungView(reloadHistory);
      break;
  }
}

function setupNavigation() {
  initNavigation({
    getIsBatchRunning,
    showToast,
    hideBatchProgress,
    onShowPortfolio: () => showViewByName('portfolio'),
    onShowAnalytics: () => showViewByName('analytics'),
    onShowAdmin: () => showAdminView(),
    onShowErfassung: () => showErfassungView(),
  });
}

async function bootstrap() {
  showConfigMessages();

  initCommonEvents({
    dockEntryDialog,
    onDockDialogCloseRequest: requestDockEntryDialogClose,
    onDockDialogClosed: () => clearInputFields(),
  });

  setupConfirmDialogHandlers();
  setupBatchDeleteButton();
  setupXlsxExport();
  initImporter();

  initFeatureModules();
  initAdminModule();

  try {
    await loadSession();
    await loadPeople();
  } catch (err) {
    console.error('Initialisierung von Session/Personen fehlgeschlagen:', err);
    showToast('Cloudflare-Session oder Personenliste konnten nicht geladen werden.', 'bad');
  }

  await initHistory({ renderDockBoard, renderPortfolio, onEditEntry: handleEditEntry });
  initFrameworks();
  initFromState();
  setupNavigation();

  const initialView = getInitialView();
  await showViewByName(initialView, { reloadHistory: false });

  window.addEventListener('hashchange', () => {
    showViewByName(getInitialView());
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}
