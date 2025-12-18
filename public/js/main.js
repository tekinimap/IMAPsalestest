import './app.js';

import { fetchWithRetry } from './api.js';
import { DEFAULT_WEIGHTS, WORKER_BASE } from './config.js';
import { getEntries } from './entries-state.js';
import { loadState, saveState, getHasUnsavedChanges, setHasUnsavedChanges, getIsBatchRunning } from './state.js';
import { getPendingDockAbrufAssignment } from './state/dock-state.js';
import { initNavigation, showView } from './features/navigation.js';
import { initHistory, loadHistory, renderHistory } from './features/history.js';
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
import { showToast, hideBatchProgress, showLoader, hideLoader } from './ui/feedback.js';
import { formatDateForInput } from './utils/format.js';

const VALID_VIEWS = new Set(['erfassung', 'portfolio', 'analytics', 'admin']);
const DEFAULT_VIEW = 'erfassung';

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
  initCommonEvents({
    dockEntryDialog,
    onDockDialogCloseRequest: requestDockEntryDialogClose,
    onDockDialogClosed: () => clearInputFields(),
  });

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
