import { WORKER_BASE } from '../config.js';
import { saveState, getHasUnsavedChanges } from '../state.js';
import { getEntries, findEntryById } from '../entries-state.js';
import { fetchWithRetry } from '../api.js';
import {
  fmtCurr0,
  formatAmountInput,
  getTodayDate,
  formatDateForInput,
  parseAmountInput,
  escapeHtml,
} from '../utils/format.js';
import { showLoader, hideLoader, showToast } from '../ui/feedback.js';
import { openWizard } from './erfassung.js';
import { getEntryRewardFactor } from './calculations.js';
import { showView } from './navigation.js';
import {
  getDockFilterState,
  updateDockFilterState,
  getDockSelection,
  toggleDockSelection,
  clearDockSelection,
  isDockBoardInitialized,
  markDockBoardInitialized,
  getDockAutoAdvanceQueue,
  getDockAutoAdvanceProcessed,
  isDockAutoAdvanceRunning,
  setDockAutoAdvanceRunning,
  getDockAutoDowngradeQueue,
  getDockAutoDowngradeProcessed,
  isDockAutoDowngradeRunning,
  setDockAutoDowngradeRunning,
  getDockAutoCheckQueue,
  getDockAutoCheckHistory,
  getDockConflictHints,
  isDockBoardRerenderScheduled,
  setDockBoardRerenderScheduled,
  getPendingDockAbrufAssignment,
  setPendingDockAbrufAssignment,
} from '../state/dock-state.js';
import { setPendingDelete } from '../state/history-state.js';
import { getCurrentFrameworkEntryId } from '../state/framework-state.js';
import { loadHistory } from './history.js';

const DOCK_PHASES = [
  {
    id: 1,
    title: 'Phase 1 · Eingetroffen von HubSpot',
    description: 'Neu importierte Deals warten auf die erste Prüfung und das Ergänzen fehlender Angaben.',
  },
  {
    id: 2,
    title: 'Phase 2 · Vollständig ausgefüllt',
    description: 'Alle Pflichtfelder sind gepflegt – jetzt muss der BU Lead die Sales-Verteilung prüfen.',
  },
  {
    id: 3,
    title: 'Phase 3 · BU-Freigabe & Abschluss',
    description:
      'Der BU Lead hat freigegeben. Sales finalisiert die Zuordnung oder markiert den Deal als Rahmenvertrag bzw. Abruf.',
  },
];

const MARKET_TEAM_TO_BU = {
  'Vielfalt+': 'Public Impact',
  'Evaluation und Beteiligung': 'Public Impact',
  'Nachhaltigkeit': 'Public Impact',
  'Bundes- und Landesbehörden': 'Organisational Excellence',
  'Sozial- und Krankenversicherungen': 'Organisational Excellence',
  'Kommunalverwaltungen': 'Organisational Excellence',
  'Internationale Zusammenarbeit': 'Organisational Excellence',
  ChangePartner: 'Organisational Excellence',
};

const DOCK_ASSIGNMENT_LABELS = {
  fix: 'Fixauftrag',
  rahmen: 'Neuer Rahmenvertrag',
  abruf: 'Abruf aus Rahmenvertrag',
};

const dockBoardEl = document.getElementById('dockBoard');
const dockEmptyState = document.getElementById('dockEmptyState');
export const dockEntryDialog = document.getElementById('app-modal');
const frameworkVolumeDialog = document.getElementById('frameworkVolumeDialog');
const frameworkVolumeForm = document.getElementById('frameworkVolumeForm');
const frameworkVolumeInput = document.getElementById('frameworkVolumeInput');
const frameworkVolumeError = document.getElementById('frameworkVolumeError');
const frameworkVolumeCancel = document.getElementById('frameworkVolumeCancel');
const frameworkVolumeCancelFooter = document.getElementById('frameworkVolumeCancelFooter');
const dockFilterBu = document.getElementById('dockFilterBu');
const dockFilterMarketTeam = document.getElementById('dockFilterMarketTeam');
const dockFilterAssessment = document.getElementById('dockFilterAssessment');
const dockSearchInput = document.getElementById('dockSearch');
const btnManualDeal = document.getElementById('btnManualDeal');
const btnCloseManualDeal = document.getElementById('btnCloseManualDeal');
const btnDockBatchDelete = document.getElementById('btnDockBatchDelete');
if (btnDockBatchDelete && !btnDockBatchDelete.dataset.baseLabel) {
  btnDockBatchDelete.dataset.baseLabel = btnDockBatchDelete.textContent.trim();
}

let deps = {
  renderFrameworkContracts: null,
  renderRahmenDetails: null,
  onEditEntry: null,
};

let isInitialized = false;

function normalizeFrameworkVolume(value) {
  if (value == null) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value === 'string') {
    const parsed = parseAmountInput(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

export function getFrameworkVolume(entry) {
  if (!entry || typeof entry !== 'object') return null;

  const directKeys = [
    'frameworkVolume',
    'framework_volume',
    'rahmenVolume',
    'rahmenvolumen',
    'rahmenVolumen',
    'rahmenvertragVolumen',
    'volume',
    'maxVolume',
    'amount',
  ];

  for (const key of directKeys) {
    if (key in entry) {
      const normalized = normalizeFrameworkVolume(entry[key]);
      if (normalized != null) {
        return normalized;
      }
    }
  }

  const nestedKeys = ['meta', 'details', 'data'];
  for (const nestedKey of nestedKeys) {
    const nested = entry[nestedKey];
    if (nested && typeof nested === 'object') {
      for (const [key, value] of Object.entries(nested)) {
        if (/volumen|volume/i.test(key)) {
          const normalized = normalizeFrameworkVolume(value);
          if (normalized != null) {
            return normalized;
          }
        }
      }
    }
  }

  return null;
}

let onFrameworkVolumeSubmit = null;

function resetFrameworkVolumeDialog() {
  onFrameworkVolumeSubmit = null;
  if (frameworkVolumeError) {
    frameworkVolumeError.textContent = '';
  }
}

function closeFrameworkVolumeDialog() {
  if (frameworkVolumeDialog) {
    if (typeof frameworkVolumeDialog.close === 'function') {
      frameworkVolumeDialog.close();
    } else {
      frameworkVolumeDialog.removeAttribute('open');
    }
  }
  resetFrameworkVolumeDialog();
}

export function openFrameworkVolumeDialog(entry, onSubmit) {
  if (typeof onSubmit !== 'function') return;

  if (!frameworkVolumeDialog || !frameworkVolumeInput) {
    const manualInput = prompt('Höchstabrufsvolumen (EUR):');
    const parsedManual = parseAmountInput(manualInput);
    if (Number.isFinite(parsedManual) && parsedManual > 0) {
      onSubmit(parsedManual);
    } else {
      showToast('Ungültiges Volumen. Bitte eine positive Zahl eingeben.', 'bad');
    }
    return;
  }

  onFrameworkVolumeSubmit = onSubmit;
  if (frameworkVolumeError) {
    frameworkVolumeError.textContent = '';
  }
  const existingVolume = getFrameworkVolume(entry);
  frameworkVolumeInput.value = existingVolume != null ? formatAmountInput(existingVolume) : '';

  if (typeof frameworkVolumeDialog.showModal === 'function') {
    frameworkVolumeDialog.showModal();
  } else {
    frameworkVolumeDialog.setAttribute('open', 'open');
  }

  if (typeof frameworkVolumeInput.focus === 'function') {
    frameworkVolumeInput.focus();
    frameworkVolumeInput.select?.();
  }
}

if (frameworkVolumeForm) {
  frameworkVolumeForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const rawValue = frameworkVolumeInput?.value ?? '';
    const parsed = parseAmountInput(rawValue);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      if (frameworkVolumeError) {
        frameworkVolumeError.textContent = 'Bitte gib eine positive Zahl ein.';
      }
      frameworkVolumeInput?.focus();
      return;
    }

    const callback = onFrameworkVolumeSubmit;
    closeFrameworkVolumeDialog();
    if (callback) {
      callback(parsed);
    }
  });
}

const handleFrameworkVolumeCancel = () => {
  closeFrameworkVolumeDialog();
};

frameworkVolumeCancel?.addEventListener('click', handleFrameworkVolumeCancel);
frameworkVolumeCancelFooter?.addEventListener('click', handleFrameworkVolumeCancel);
frameworkVolumeDialog?.addEventListener('cancel', (event) => {
  event.preventDefault();
  closeFrameworkVolumeDialog();
});

const dockColumnBodies = new Map();
const dockColumnCounts = new Map();
const dockFilterState = getDockFilterState();
const dockSelection = getDockSelection();
const dockAutoAdvanceQueue = getDockAutoAdvanceQueue();
const dockAutoAdvanceProcessed = getDockAutoAdvanceProcessed();
const dockAutoDowngradeQueue = getDockAutoDowngradeQueue();
const dockAutoDowngradeProcessed = getDockAutoDowngradeProcessed();
const dockAutoCheckQueue = getDockAutoCheckQueue();
const dockAutoCheckHistory = getDockAutoCheckHistory();
const dockConflictHints = getDockConflictHints();
let dockAutoAdvanceRunning = isDockAutoAdvanceRunning();
let dockAutoDowngradeRunning = isDockAutoDowngradeRunning();

function normalizeProjectNumber(value) {
  return normalizeDockString(value).toLowerCase();
}

function normalizeDockString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function requestDockBoardRerender() {
  if (isDockBoardRerenderScheduled()) return;
  const scheduler = typeof window !== 'undefined' && window.requestAnimationFrame
    ? window.requestAnimationFrame.bind(window)
    : (cb) => setTimeout(cb, 0);
  setDockBoardRerenderScheduled(true);
  scheduler(() => {
    setDockBoardRerenderScheduled(false);
    renderDockBoard();
  });
}

function firstNonEmptyString(values = []) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function deriveBusinessUnitFromTeam(team) {
  const normalized = normalizeDockString(team);
  if (!normalized) return '';
  const direct = MARKET_TEAM_TO_BU[normalized];
  if (direct) return direct;
  const lower = normalized.toLowerCase();
  for (const [key, value] of Object.entries(MARKET_TEAM_TO_BU)) {
    if (key.toLowerCase() === lower) return value;
  }
  return '';
}

function ensureDockBoard() {
  if (!dockBoardEl || isDockBoardInitialized()) return;
  markDockBoardInitialized();
  dockBoardEl.innerHTML = '';
  DOCK_PHASES.forEach((phase) => {
    const column = document.createElement('section');
    column.className = 'dock-column';
    column.dataset.phase = String(phase.id);
    column.innerHTML = `
      <header class=\"dock-column-header\">
        <div>
          <h2>${escapeHtml(phase.title)}</h2>
          <p>${escapeHtml(phase.description)}</p>
        </div>
        <span class=\"dock-column-count\" data-phase-count=${phase.id}>0</span>
      </header>
      <div class=\"dock-column-body\" data-phase-body=${phase.id}></div>
    `;
    dockBoardEl.appendChild(column);
    dockColumnBodies.set(phase.id, column.querySelector(`[data-phase-body="${phase.id}"]`));
    dockColumnCounts.set(phase.id, column.querySelector(`[data-phase-count="${phase.id}"]`));
  });
}

function ensureAbrufAssignmentDialog() {
  let dialog = document.getElementById('abrufAssignDlg');
  if (dialog) return dialog;

  dialog = document.createElement('dialog');
  dialog.id = 'abrufAssignDlg';
  dialog.innerHTML = `
    <button class=\"dialog-close\" type=\"button\" aria-label=\"Modal schließen\">×</button>
    <div class=\"hd\"><h1>Abruf zuordnen</h1></div>
    <div class=\"ct\">
      <div id=\"abrufAssignValidation\" class=\"validation-summary\"></div>
      <div class=\"grid-1\">
        <label for=\"abrufAssignFramework\">Rahmenvertrag auswählen *</label>
        <select id=\"abrufAssignFramework\"></select>
      </div>
      <div style=\"margin-top:12px\">
        <label>Abruf-Typ *</label>
        <div class=\"radio-group\">
          <label><input type=\"radio\" name=\"abrufAssignType\" value=\"founder\"> Passiver Abruf (Founder)</label>
          <label><input type=\"radio\" name=\"abrufAssignType\" value=\"hunter\" checked> Aktiver Abruf (Hunter)</label>
        </div>
      </div>
      <div class=\"hr\"></div>
      <div style=\"display:flex;gap:10px;justify-content:flex-end;\">
        <button class=\"btn\" data-abort>Abbrechen</button>
        <button class=\"btn ok\" data-confirm>Abruf erfassen</button>
      </div>
    </div>
  `;
  document.body.appendChild(dialog);

  dialog.addEventListener('click', (ev) => {
    if (ev.target.matches('.dialog-close') || ev.target.dataset.abort !== undefined) {
      dialog.close();
      setPendingDockAbrufAssignment(null);
    }
  });

  const confirmBtn = dialog.querySelector('[data-confirm]');
  if (confirmBtn) {
    confirmBtn.addEventListener('click', (ev) => handleAbrufAssignConfirm(ev));
  }

  return dialog;
}

function populateAbrufAssignmentDialog(frameworks, preselectId) {
  const dialog = ensureAbrufAssignmentDialog();
  const select = dialog.querySelector('#abrufAssignFramework');
  const validation = dialog.querySelector('#abrufAssignValidation');
  if (!select || !validation) return;

  validation.textContent = '';
  select.innerHTML = '<option value="">-- Bitte Rahmenvertrag wählen --</option>';
  let hasPreselect = false;
  frameworks
    .sort((a, b) => (a.title || '').localeCompare(b.title || ''))
    .forEach((fw) => {
      const opt = document.createElement('option');
      opt.value = fw.id;
      opt.textContent = `${fw.title || 'Unbenannt'} (${fw.client || '–'})`;
      if (preselectId && fw.id === preselectId) {
        opt.selected = true;
        hasPreselect = true;
      }
      select.appendChild(opt);
    });
  if (hasPreselect) {
    select.value = preselectId;
  }
}

async function finalizeDockAbruf(entryId) {
  const entry = findEntryById(entryId);
  if (!entry) {
    setPendingDockAbrufAssignment(null);
    return;
  }
  try {
    await updateDockPhase(
      entry,
      entry.dockPhase || 3,
      { dockFinalAssignment: 'abruf', dockFinalAssignmentAt: Date.now() },
      'Deal als Abruf markiert.',
      { silent: true }
    );
    showToast('Deal als Abruf markiert.', 'ok');
  } catch (err) {
    console.error('Abruf-Markierung fehlgeschlagen', err);
    showToast('Dock-Status konnte nach dem Abruf nicht aktualisiert werden.', 'bad');
  } finally {
    setPendingDockAbrufAssignment(null);
  }
}

function startAbrufMode(entry, framework) {
  if (!framework) return;
  const freigabeDate = entry.freigabedatum ? formatDateForInput(entry.freigabedatum) : getTodayDate();
  saveState({
    source: 'manuell',
    isAbrufMode: true,
    parentEntry: framework,
    dockAssignmentId: entry.id,
    input: {
      client: framework.client || entry.client || '',
      title: entry.title || '',
      amountKnown: entry.amount > 0,
      amount: entry.amount || 0,
      rows: entry.rows || [],
      weights: entry.weights || [],
      submittedBy: entry.submittedBy || '',
      projectNumber: framework.projectNumber || '',
      kvNummer: entry.kv_nummer || entry.kv || '',
      freigabedatum: freigabeDate,
    },
  });
  showManualPanel(entry.id);
  showView('erfassung');
}

function startDockAbrufAssignment(entry) {
  if (!entry) return;
  const frameworks = getEntries().filter((item) => (item.projectType || 'fix') === 'rahmen');
  if (!frameworks.length) {
    showToast('Kein Rahmenvertrag verfügbar. Bitte zuerst einen Rahmenvertrag anlegen.', 'warn');
    return;
  }

  const hint = dockConflictHints.get(entry.id);
  const hintFrameworkId = hint?.frameworkId;
  let preselectId = hintFrameworkId;
  if (!preselectId) {
    const normalizedProject = normalizeProjectNumber(entry.projectNumber);
    if (normalizedProject) {
      const matchingFramework = frameworks.find(
        (fw) => normalizeProjectNumber(fw.projectNumber) === normalizedProject
      );
      if (matchingFramework) {
        preselectId = matchingFramework.id;
      }
    }
  }
  if (hintFrameworkId) {
    const framework = findEntryById(hintFrameworkId);
    if (framework) {
      openFrameworkAssignmentPrompt(entry, framework);
      return;
    }
  }

  setPendingDockAbrufAssignment({ entry });
  populateAbrufAssignmentDialog(frameworks, preselectId);

  const dialog = ensureAbrufAssignmentDialog();
  try {
    dialog.showModal();
  } catch (err) {
    console.error('Abruf-Dialog konnte nicht geöffnet werden.', err);
    showToast('Abruf-Auswahl konnte nicht geöffnet werden.', 'bad');
    setPendingDockAbrufAssignment(null);
  }
}

async function handleAbrufAssignConfirm(ev) {
  const dialog = ensureAbrufAssignmentDialog();
  const select = dialog.querySelector('#abrufAssignFramework');
  const validation = dialog.querySelector('#abrufAssignValidation');
  const confirmBtn = ev?.currentTarget || dialog.querySelector('[data-confirm]');
  const type = dialog.querySelector('input[name="abrufAssignType"]:checked')?.value || 'hunter';

  const pendingAssignment = getPendingDockAbrufAssignment();
  if (!pendingAssignment || !select || !validation) {
    dialog.close();
    setPendingDockAbrufAssignment(null);
    return;
  }

  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.classList.add('disabled');
  }

  const frameworkId = select.value;
  if (!frameworkId) {
    validation.textContent = 'Bitte Rahmenvertrag auswählen.';
    confirmBtn?.classList.remove('disabled');
    confirmBtn && (confirmBtn.disabled = false);
    return;
  }
  const framework = findEntryById(frameworkId);
  if (!framework) {
    validation.textContent = 'Rahmenvertrag konnte nicht geladen werden.';
    confirmBtn?.classList.remove('disabled');
    confirmBtn && (confirmBtn.disabled = false);
    return;
  }

  const entryProject = normalizeProjectNumber(pendingAssignment.entry?.projectNumber);
  const frameworkProject = normalizeProjectNumber(framework.projectNumber);
  if (entryProject && frameworkProject && entryProject !== frameworkProject) {
    validation.textContent = 'Warnung: Die Projektnummer des Abrufs stimmt nicht mit der Projektnummer des Rahmenvertrags überein. Bitte überprüfen Sie die Eingabe.';
    confirmBtn?.classList.remove('disabled');
    confirmBtn && (confirmBtn.disabled = false);
    return;
  }

  pendingAssignment.frameworkId = frameworkId;
  pendingAssignment.mode = type;
  dialog.close();

  try {
    if (type === 'founder') {
      if (!confirm('Warnung: Dieser Rahmenvertrag hat bereits Founder und die im Deal angegebenen Sales Verteilungen werden verworfen. Fortfahren?')) {
        confirmBtn?.classList.remove('disabled');
        confirmBtn && (confirmBtn.disabled = false);
        return;
      }
      await createDockAbrufTransaction(pendingAssignment.entry, framework, 'founder');
    } else {
      await createDockAbrufTransaction(pendingAssignment.entry, framework, 'hunter');
    }
  } catch (err) {
    console.error('Fehler bei der Zuweisung:', err);
    showToast('Ein Fehler ist aufgetreten: ' + err.message, 'bad');
  } finally {
    confirmBtn?.classList.remove('disabled');
    confirmBtn && (confirmBtn.disabled = false);
  }
}

function rndId(prefix = '') {
  return (prefix || '') + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
}

function buildTransactionFromDockEntry(entry, type = 'hunter') {
  const kvNummer = normalizeDockString(entry?.kv_nummer || entry?.kv || '');
  const fallbackDate = Number.isFinite(entry?.freigabedatum) ? entry.freigabedatum : entry?.ts;
  const freigabe = Number.isFinite(fallbackDate) ? fallbackDate : Date.now();

  if (type === 'founder') {
    return {
      id: rndId('trans_'),
      type: 'founder',
      amount: Number(entry?.amount) || 0,
      kv_nummer: kvNummer,
      projectNumber: entry?.projectNumber || '',
      title: entry?.title || '',
      ts: Date.now(),
      freigabedatum: freigabe,
    };
  }

  return {
    id: rndId('trans_'),
    type: 'hunter',
    amount: Number(entry?.amount) || 0,
    kv_nummer: kvNummer,
    projectNumber: entry?.projectNumber || '',
    title: entry?.title || '',
    ts: Date.now(),
    freigabedatum: freigabe,
    rows: Array.isArray(entry?.rows) ? entry.rows : [],
    list: Array.isArray(entry?.list) ? entry.list : [],
    weights: Array.isArray(entry?.weights) ? entry.weights : [],
    submittedBy: entry?.submittedBy || '',
  };
}

async function createDockAbrufTransaction(entry, framework, type = 'hunter') {
  if (!entry || !framework) return;
  const transaction = buildTransactionFromDockEntry(entry, type);
  if (!Array.isArray(framework.transactions)) {
    framework.transactions = [];
  }
  framework.transactions.push(transaction);
  framework.modified = Date.now();

  showLoader();
  try {
    const r = await fetchWithRetry(`${WORKER_BASE}/entries/${encodeURIComponent(framework.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(framework),
    });
    if (!r.ok) throw new Error(await r.text());

    const successMessage = type === 'founder'
      ? 'Passiver Abruf hinzugefügt.'
      : 'Aktiver Abruf hinzugefügt.';
    showToast(successMessage, 'ok');
    await loadHistory();
    deps.renderFrameworkContracts?.();
    if (getCurrentFrameworkEntryId() === framework.id) {
      deps.renderRahmenDetails?.(framework.id);
    }
    const assignmentId = entry.id || getPendingDockAbrufAssignment()?.entry?.id;
    if (assignmentId) {
      await finalizeDockAbruf(assignmentId);
    }
  } catch (err) {
    console.error('Abruf konnte nicht gespeichert werden.', err);
    showToast('Abruf konnte nicht gespeichert werden.', 'bad');
  } finally {
    setPendingDockAbrufAssignment(null);
    hideLoader();
  }
}

export function showManualPanel(entryId = null) {
  const entryObj = entryId ? findEntryById(entryId) : null;
  openWizard(entryObj || entryId);
}

export function clearInputFields() {
  // Der neue Wizard verwaltet seine Felder selbst; hier nur Kompatibilitäts-Stubs.
}

function hideManualPanel() {
  if (dockEntryDialog && dockEntryDialog.open) {
    dockEntryDialog.close();
  }
}

function requestDockEntryDialogClose() {
  if (!dockEntryDialog) return false;
  if (dockEntryDialog.open && getHasUnsavedChanges()) {
    const confirmed = confirm('Ungespeicherte Änderungen gehen verloren. Trotzdem schließen?');
    if (!confirmed) {
      return false;
    }
  }
  hideManualPanel();
  return true;
}

function getEntryKvList(entry) {
  if (!entry || typeof entry !== 'object') return [];
  if (Array.isArray(entry.kvNummern) && entry.kvNummern.length) return entry.kvNummern;
  if (Array.isArray(entry.kv_list) && entry.kv_list.length) return entry.kv_list;
  const single = entry.kv_nummer || entry.kv;
  return normalizeDockString(single) ? [normalizeDockString(single)] : [];
}

export function getDockPhase(entry) {
  if (!entry || typeof entry !== 'object') return 1;
  const raw = Number(entry.dockPhase);
  if (Number.isFinite(raw) && raw >= 1) {
    return Math.min(3, Math.max(1, raw));
  }
  if (normalizeDockString(entry.source).toLowerCase() === 'hubspot') {
    return 1;
  }
  return 3;
}

function computeDockChecklist(entry) {
  const amount = Number(entry?.amount) > 0;
  const hasClient = !!normalizeDockString(entry?.client);
  const hasProjectNumber = !!normalizeDockString(entry?.projectNumber);
  const kvList = getEntryKvList(entry);
  const hasKv = kvList.length > 0;
  const list = Array.isArray(entry?.list) ? entry.list : [];
  const hasSalesContributions = list.some((item) => {
    if (!item) return false;
    const pct = Number(item.pct);
    const money = Number(item.money);
    return (Number.isFinite(pct) && pct > 0) || (Number.isFinite(money) && money > 0);
  });
  const hasSubmittedBy = !!normalizeDockString(entry?.submittedBy);
  const isComplete = Boolean(entry?.complete) || (amount && hasProjectNumber && hasKv && hasSalesContributions);
  return { amount, hasClient, hasProjectNumber, hasKv, hasSalesContributions, hasSubmittedBy, isComplete };
}

function isPhaseTwoReady(checklist) {
  return checklist.amount && checklist.hasClient && checklist.hasProjectNumber && checklist.hasKv && checklist.hasSalesContributions;
}

function shouldDisplayInDock(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const source = normalizeDockString(entry.source).toLowerCase();
  if (source !== 'hubspot' && entry.dockPhase == null) return false;
  if (entry.dockFinalAssignment) return false;
  return true;
}

function resolveAssessmentOwner(entry) {
  return firstNonEmptyString([
    entry?.assessmentOwner,
    entry?.assessment_owner,
    entry?.dockAssessmentOwner,
    entry?.einschaetzung_abzugeben_von,
    entry?.einschätzung_abzugeben_von,
    entry?.submittedBy,
  ]);
}

function parseFlagshipValue(value) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return false;
    if (['1', 'true', 'yes', 'ja', 'y', 'on', 'wahr'].includes(normalized)) {
      return true;
    }
    if (['0', 'false', 'no', 'nein', 'n', 'off'].includes(normalized)) {
      return false;
    }
  }
  return false;
}

function isFlagshipProject(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const rawValue = entry.flagship_projekt ?? entry.flagshipProjekt ?? entry.flagshipProject;
  return parseFlagshipValue(rawValue);
}

function augmentDockEntry(entry) {
  const phase = getDockPhase(entry);
  const checklist = computeDockChecklist(entry);
  const marketTeam = normalizeDockString(entry?.marketTeam || entry?.market_team || '');
  const businessUnit = normalizeDockString(entry?.businessUnit || deriveBusinessUnitFromTeam(marketTeam));
  const assessmentOwner = resolveAssessmentOwner(entry);
  const kvList = getEntryKvList(entry);
  const updatedAt = Number(entry?.modified || entry?.updatedAt || entry?.ts || 0);
  return {
    entry,
    phase,
    checklist,
    marketTeam,
    businessUnit,
    assessmentOwner,
    kvList,
    updatedAt,
    show: shouldDisplayInDock(entry),
    conflictHint: dockConflictHints.get(entry.id) || null,
    isFlagship: isFlagshipProject(entry),
  };
}

function matchesDockFilters(item) {
  if (!item.show) return false;
  if (dockFilterState.bu && item.businessUnit !== dockFilterState.bu) return false;
  if (dockFilterState.marketTeam && item.marketTeam !== dockFilterState.marketTeam) return false;
  if (dockFilterState.assessment && item.assessmentOwner !== dockFilterState.assessment) return false;
  if (dockFilterState.search) {
    const query = dockFilterState.search;
    const haystack = [
      item.entry?.title,
      item.entry?.client,
      item.entry?.projectNumber,
      ...(item.kvList || []),
    ]
      .map((value) => normalizeDockString(value).toLowerCase())
      .filter(Boolean);
    const matches = haystack.some((value) => value.includes(query));
    if (!matches) return false;
  }
  return true;
}

function updateDockSelectionUi() {
  if (btnDockBatchDelete) {
    const count = dockSelection.size;
    const baseLabel = btnDockBatchDelete.dataset.baseLabel || 'Markierte Löschen';
    btnDockBatchDelete.disabled = count === 0;
    btnDockBatchDelete.textContent = count > 0 ? `${baseLabel} (${count})` : baseLabel;
  }
  if (!dockBoardEl) return;
  dockBoardEl.querySelectorAll('.dock-card').forEach((card) => {
    const id = card.dataset.entryId;
    if (!id) return;
    const selected = dockSelection.has(id);
    card.classList.toggle('is-selected', selected);
    const checkbox = card.querySelector('input[data-dock-select][data-id]');
    if (checkbox) {
      checkbox.checked = selected;
    }
  });
}

function updateDockFilterOptions(items) {
  if (!dockFilterMarketTeam && !dockFilterAssessment) return;
  const teams = new Set();
  const assessments = new Set();
  items.forEach((item) => {
    if (!item.show) return;
    if (!dockFilterState.bu || item.businessUnit === dockFilterState.bu) {
      if (item.marketTeam) teams.add(item.marketTeam);
    }
    if (item.assessmentOwner) assessments.add(item.assessmentOwner);
  });

  if (dockFilterMarketTeam) {
    const selected = dockFilterState.marketTeam;
    const options = ['']
      .concat(Array.from(teams).sort((a, b) => a.localeCompare(b, 'de')))
      .map((team) => ({ value: team, label: team || 'Alle Market Teams' }));
    dockFilterMarketTeam.innerHTML = '';
    options.forEach(({ value, label }) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label || 'Alle Market Teams';
      if (value === selected) option.selected = true;
      dockFilterMarketTeam.appendChild(option);
    });
  }

  if (dockFilterAssessment) {
    const selected = dockFilterState.assessment;
    const options = ['']
      .concat(Array.from(assessments).sort((a, b) => a.localeCompare(b, 'de')))
      .map((person) => ({ value: person, label: person || 'Alle Personen' }));
    dockFilterAssessment.innerHTML = '';
    options.forEach(({ value, label }) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label || 'Alle Personen';
      if (value === selected) option.selected = true;
      dockFilterAssessment.appendChild(option);
    });
  }
}

export function renderDockBoard() {
  if (!dockBoardEl) return;
  ensureDockBoard();

  const currentEntries = getEntries();
  const augmented = currentEntries.map(augmentDockEntry);
  updateDockFilterOptions(augmented);
  augmented.forEach((item) => {
    const entryId = item.entry?.id;
    if (!entryId) return;
    if (item.phase === 3) {
      queueDockAutoCheck(entryId, { entry: item.entry });
    } else {
      dockAutoCheckHistory.delete(entryId);
      if (dockConflictHints.has(entryId)) {
        dockConflictHints.delete(entryId);
      }
    }
  });
  const filtered = augmented.filter(matchesDockFilters);
  const visibleIds = new Set(filtered.map((item) => item.entry?.id).filter(Boolean));
  Array.from(dockSelection).forEach((id) => {
    if (!visibleIds.has(id)) {
      dockSelection.delete(id);
    }
  });

  const grouped = new Map(DOCK_PHASES.map((phase) => [phase.id, []]));
  filtered.forEach((item) => {
    const list = grouped.get(item.phase);
    if (list) list.push(item);
  });

  let totalVisible = 0;
  DOCK_PHASES.forEach((phase) => {
    const body = dockColumnBodies.get(phase.id);
    const countEl = dockColumnCounts.get(phase.id);
    if (body) {
      body.innerHTML = '';
      const items = grouped.get(phase.id) || [];
      items
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .forEach((item) => {
          body.appendChild(buildDockCard(item));
        });
      totalVisible += items.length;
    }
    if (countEl) {
      const amount = grouped.get(phase.id)?.length || 0;
      countEl.textContent = String(amount);
    }
  });

  if (dockEmptyState) {
    dockEmptyState.classList.toggle('hide', totalVisible > 0);
  }
  updateDockSelectionUi();
  scheduleDockAutoAdvance(filtered);
  scheduleDockAutoDowngrade(filtered);
  processDockAutoChecks();
}

function scheduleDockAutoAdvance(items = []) {
  let hasNewItems = false;
  (Array.isArray(items) ? items : []).forEach((item) => {
    const entryId = item?.entry?.id;
    if (!entryId) return;
    const ready = item.phase === 1 && isPhaseTwoReady(item.checklist);
    if (!ready) {
      dockAutoAdvanceProcessed.delete(entryId);
      return;
    }
    if (dockAutoAdvanceProcessed.has(entryId)) {
      return;
    }
    dockAutoAdvanceQueue.push(item.entry);
    dockAutoAdvanceProcessed.add(entryId);
    hasNewItems = true;
  });
  if (hasNewItems) {
    processDockAutoAdvanceQueue();
  }
}

async function processDockAutoAdvanceQueue() {
  if (dockAutoAdvanceRunning) return;
  dockAutoAdvanceRunning = true;
  setDockAutoAdvanceRunning(true);
  while (dockAutoAdvanceQueue.length) {
    const entry = dockAutoAdvanceQueue.shift();
    if (!entry || !entry.id) continue;
    try {
      await updateDockPhase(entry, 2, {}, 'Deal automatisch in Phase 2 verschoben.', { silent: true });
    } catch (err) {
      console.error('Automatischer Phasenwechsel fehlgeschlagen', err);
      dockAutoAdvanceProcessed.delete(entry.id);
    }
  }
  dockAutoAdvanceRunning = false;
  setDockAutoAdvanceRunning(false);
}

function scheduleDockAutoDowngrade(items = []) {
  let hasNewItems = false;
  (Array.isArray(items) ? items : []).forEach((item) => {
    const entryId = item?.entry?.id;
    if (!entryId) return;

    const checklistComplete = isPhaseTwoReady(item.checklist);
    let targetPhase = null;

    if (item.phase === 2 && !checklistComplete) {
      targetPhase = 1;
    } else if (item.phase === 3 && !checklistComplete) {
      targetPhase = 2;
    } else {
      dockAutoDowngradeProcessed.delete(entryId);
      return;
    }

    if (dockAutoDowngradeProcessed.has(entryId)) {
      return;
    }

    dockAutoDowngradeQueue.push({ entry: item.entry, targetPhase });
    dockAutoDowngradeProcessed.add(entryId);
    hasNewItems = true;
  });

  if (hasNewItems) {
    processDockAutoDowngradeQueue();
  }
}

async function processDockAutoDowngradeQueue() {
  if (dockAutoDowngradeRunning) return;
  dockAutoDowngradeRunning = true;
  setDockAutoDowngradeRunning(true);
  while (dockAutoDowngradeQueue.length) {
    const payload = dockAutoDowngradeQueue.shift();
    const entry = payload?.entry;
    if (!entry || !entry.id) continue;
    const targetPhase = payload?.targetPhase || 1;
    try {
      await updateDockPhase(
        entry,
        targetPhase,
        {},
        targetPhase === 1
          ? 'Deal automatisch in Phase 1 zurückgestuft (Pflichtfelder fehlen).'
          : 'Deal automatisch in Phase 2 zurückgestuft (Pflichtfelder fehlen).',
        { silent: true }
      );
    } catch (err) {
      console.error('Automatische Rückstufung fehlgeschlagen', err);
      dockAutoDowngradeProcessed.delete(entry.id);
    }
  }
  dockAutoDowngradeRunning = false;
  setDockAutoDowngradeRunning(false);
}

export function queueDockAutoCheck(id, context = {}) {
  if (!id) return;
  const previous = dockAutoCheckQueue.get(id) || {};
  const merged = { ...previous, ...context };
  if (!merged.entry) {
    const allEntries = getEntries();
    const existing = allEntries.find((item) => item?.id === id);
    if (existing) {
      merged.entry = existing;
    }
  }
  merged.queuedAt = Date.now();
  dockAutoCheckQueue.set(id, merged);
}

function processDockAutoChecks() {
  if (dockAutoCheckQueue.size === 0) return;
  const list = Array.from(dockAutoCheckQueue.entries());
  dockAutoCheckQueue.clear();
  const allEntries = getEntries();
  list.forEach(([id, context]) => {
    const entry = context.entry || allEntries.find((item) => item.id === id);
    if (entry) {
      handleDockAutoCheck(entry, context);
    }
  });
}

function handleDockAutoCheck(entry, context = {}) {
  const phase = getDockPhase(entry);
  if (phase !== 3) {
    dockAutoCheckHistory.delete(entry.id);
    if (dockConflictHints.delete(entry.id)) {
      requestDockBoardRerender();
    }
    return;
  }

  if (!shouldDisplayInDock(entry)) {
    dockAutoCheckHistory.delete(entry.id);
    if (dockConflictHints.delete(entry.id)) {
      requestDockBoardRerender();
    }
    return;
  }

  const kvList = getEntryKvList(entry);
  const projectNumber = normalizeDockString(entry.projectNumber);
  const normalizedPn = projectNumber.toLowerCase();
  const snapshot = JSON.stringify({
    projectNumber: normalizedPn,
    kv: kvList.map((kv) => normalizeDockString(kv).toLowerCase()).sort(),
    phase,
    finalAssignment: entry.dockFinalAssignment || '',
  });
  if (dockAutoCheckHistory.get(entry.id) === snapshot) {
    return;
  }
  dockAutoCheckHistory.set(entry.id, snapshot);

  const allEntries = getEntries();
  const others = allEntries.filter((item) => item && item.id !== entry.id && shouldDisplayInDock(item));

  if (projectNumber) {
    const sameProject = others.filter((item) => normalizeDockString(item.projectNumber).toLowerCase() === normalizedPn);
    const frameworkMatches = sameProject.filter((item) => (item.projectType || 'fix') === 'rahmen');
    if (frameworkMatches.length > 0) {
      const framework = frameworkMatches[0];
      dockConflictHints.set(entry.id, {
        type: 'framework',
        severity: 'warn',
        title: 'Rahmenvertrag gefunden',
        message: 'Für diese Projektnummer existiert bereits ein Rahmenvertrag. Ordne den Deal als Abruf zu, falls es derselbe Vertrag ist.',
        frameworkId: framework.id,
        primaryAction: { act: 'hint-assign-framework', label: 'Als Abruf zuordnen' },
        dismissLabel: 'Später prüfen',
      });
      showToast('Passender Rahmenvertrag entdeckt. Prüfe die Zuordnung als Abruf.', 'warn', 6000);
      requestDockBoardRerender();
      return;
    }
  }

  if (kvList.length > 0) {
    const conflict = kvList
      .map((kv) => normalizeDockString(kv).toLowerCase())
      .filter(Boolean);
    if (conflict.length) {
      const conflictingEntry = others.find((item) => {
        if (!shouldDisplayInDock(item)) return false;
        const otherKvList = getEntryKvList(item).map((kv) => normalizeDockString(kv).toLowerCase());
        return otherKvList.some((kv) => conflict.includes(kv));
      });
      if (conflictingEntry) {
        dockConflictHints.set(entry.id, {
          type: 'kv-conflict',
          severity: 'bad',
          title: 'KV-Nummer bereits vergeben',
          message: 'Zu dieser KV-Nummer gibt es im Dock schon einen Deal. Bitte prüfe die Angaben, bevor du fortfährst.',
          dismissLabel: 'Verstanden',
        });
        showToast('Zu dieser KV-Nummer existiert im Dock bereits ein Deal. Bitte prüfen.', 'bad', 6000);
        requestDockBoardRerender();
        return;
      }
    }
  }

  if (dockConflictHints.has(entry.id)) {
    dockConflictHints.delete(entry.id);
    requestDockBoardRerender();
  }
}

export function findDockKvConflict(kvValue, excludeId) {
  const normalized = normalizeDockString(kvValue).toLowerCase();
  if (!normalized) return null;
  const allEntries = getEntries();
  return allEntries.find((item) => {
    if (!item || item.id === excludeId) return false;
    if (!shouldDisplayInDock(item)) return false;
    return getEntryKvList(item)
      .map((kv) => normalizeDockString(kv).toLowerCase())
      .some((kv) => kv === normalized);
  });
}

function openFrameworkAssignmentPrompt(entry, framework) {
  if (!framework) return;
  deps.renderFrameworkContracts?.();
  deps.renderRahmenDetails?.(framework.id);
  showView('rahmenDetails');
  showToast('Rahmenvertrag geöffnet. Lege den Abruf im Detailbereich an.', 'warn');
}

function createDockElement(tag, options = {}) {
  const element = document.createElement(tag);
  const { className, text, attrs = {}, dataset = {} } = options;
  if (className) {
    element.className = className;
  }
  if (Object.prototype.hasOwnProperty.call(options, 'text')) {
    element.textContent = text;
  }
  Object.entries(attrs).forEach(([key, value]) => {
    if (value != null) {
      element.setAttribute(key, String(value));
    }
  });
  Object.entries(dataset).forEach(([key, value]) => {
    if (value != null) {
      element.dataset[key] = String(value);
    }
  });
  return element;
}

function buildDockHint(entryId, hint) {
  if (!hint) return null;
  const classes = ['dock-card-hint'];
  if (hint.severity) {
    classes.push(`hint-${hint.severity}`);
  }
  const wrapper = createDockElement('div', { className: classes.join(' ') });
  const textBlock = createDockElement('p', { className: 'dock-card-hint-text' });
  if (hint.title) {
    const titleEl = createDockElement('strong', { text: hint.title });
    textBlock.appendChild(titleEl);
    if (hint.message) {
      textBlock.appendChild(document.createTextNode(` ${hint.message}`));
    }
  } else if (hint.message) {
    textBlock.textContent = hint.message;
  }
  wrapper.appendChild(textBlock);

  const actions = createDockElement('div', { className: 'dock-card-hint-actions' });
  let hasAction = false;
  if (hint.primaryAction && hint.primaryAction.act && hint.primaryAction.label) {
    const primaryBtn = createDockElement('button', {
      className: 'btn tight',
      text: hint.primaryAction.label,
      attrs: { type: 'button' },
      dataset: { dockAct: hint.primaryAction.act, id: entryId },
    });
    actions.appendChild(primaryBtn);
    hasAction = true;
  }

  if (hint.dismissLabel !== null) {
    const dismissBtn = createDockElement('button', {
      className: 'btn tight',
      text: hint.dismissLabel || 'Hinweis ausblenden',
      attrs: { type: 'button' },
      dataset: { dockAct: 'dismiss-hint', id: entryId },
    });
    actions.appendChild(dismissBtn);
    hasAction = true;
  }

  if (hasAction) {
    wrapper.appendChild(actions);
  }
  return wrapper;
}

function buildDockCard(item) {
  const { entry, checklist, marketTeam, businessUnit, assessmentOwner, kvList, phase, conflictHint, isFlagship } = item;
  const card = createDockElement('article', { className: 'dock-card' });
  card.dataset.entryId = entry.id;

  const header = createDockElement('div', { className: 'dock-card-header' });
  const headline = createDockElement('div', { className: 'dock-card-headline' });
  const selectLabel = createDockElement('label', { className: 'dock-card-select' });
  const checkbox = createDockElement('input', {
    attrs: { type: 'checkbox', 'aria-label': 'Deal auswählen' },
    dataset: { dockSelect: 'card', id: entry.id },
  });
  checkbox.checked = dockSelection.has(entry.id);
  selectLabel.appendChild(checkbox);
  const title = createDockElement('h3', { className: 'dock-card-title' });
  if (isFlagship) {
    const flagIcon = createDockElement('span', {
      className: 'dock-card-flag',
      text: '⛵',
      attrs: { title: 'Flagship-Projekt', role: 'img', 'aria-label': 'Flagship-Projekt' },
    });
    title.appendChild(flagIcon);
  }
  const titleText = createDockElement('span', { className: 'dock-card-title-text', text: entry.title || 'Ohne Titel' });
  title.appendChild(titleText);
  headline.append(selectLabel, title);
  header.appendChild(headline);

  card.appendChild(header);

  const badgeItems = [];
  if (businessUnit) badgeItems.push({ className: 'dock-pill accent', text: businessUnit });
  if (marketTeam) badgeItems.push({ className: 'dock-pill', text: marketTeam });
  if (normalizeDockString(entry.source).toLowerCase() !== 'hubspot') {
    badgeItems.push({ className: 'dock-pill warn', text: 'Manuell' });
  }
  if (badgeItems.length) {
    const badgeRow = createDockElement('div', { className: 'dock-badge-row' });
    badgeItems.forEach((badge) => {
      badgeRow.appendChild(
        createDockElement('span', {
          className: badge.className,
          text: badge.text,
          dataset: badge.dataset || {},
        })
      );
    });
    card.appendChild(badgeRow);
  }

  const amountText = Number(entry.amount) > 0 ? fmtCurr0.format(entry.amount) : '–';
  const kvText = kvList.length ? kvList.join(', ') : '–';
  const meta = createDockElement('p', { className: 'dock-card-meta' });
  const metaRows = [
    { label: 'Auftragswert', value: amountText, ok: checklist.amount },
    { label: 'Auftraggeber', value: entry.client || '–', ok: checklist.hasClient },
    { label: 'Projektnummer', value: entry.projectNumber || '–', ok: checklist.hasProjectNumber },
    { label: 'KV-Nummern', value: kvText, ok: checklist.hasKv },
    { label: 'Salesbeiträge', value: checklist.hasSalesContributions ? '✓' : '✕', ok: checklist.hasSalesContributions },
    { label: 'Einschätzung', value: assessmentOwner || '–', ok: !!assessmentOwner },
  ];
  metaRows.forEach(({ label, value, ok }) => {
    const row = createDockElement('span', { className: `dock-card-meta-row ${ok ? 'ok' : 'missing'}` });
    row.appendChild(createDockElement('span', { className: 'status-icon', text: ok ? '✓' : '!' }));
    row.appendChild(createDockElement('strong', { text: `${label}:` }));
    row.appendChild(document.createTextNode(` ${value || '–'}`));
    meta.appendChild(row);
  });
  card.appendChild(meta);

  const hintEl = buildDockHint(entry.id, conflictHint);
  if (hintEl) {
    card.appendChild(hintEl);
  }

  const footer = createDockElement('div', { className: 'dock-card-footer' });

  if (phase === 2) {
    footer.appendChild(
      createDockElement('button', {
        className: 'btn ok tight',
        text: 'HoBU Freigabe',
        attrs: { type: 'button' },
        dataset: { dockAct: 'bu-approve', id: entry.id },
      })
    );
  } else if (phase === 3) {
    footer.appendChild(
      createDockElement('button', {
        className: 'btn tight',
        text: 'Fixauftrag',
        attrs: { type: 'button' },
        dataset: { dockAct: 'assign', targetAssignment: 'fix', id: entry.id },
      })
    );
    footer.appendChild(
      createDockElement('button', {
        className: 'btn tight',
        text: 'Neuer Rahmenvertrag',
        attrs: { type: 'button' },
        dataset: { dockAct: 'assign', targetAssignment: 'rahmen', id: entry.id },
      })
    );
    footer.appendChild(
      createDockElement('button', {
        className: 'btn tight',
        text: 'Abruf aus Rahmenvertrag',
        attrs: { type: 'button' },
        dataset: { dockAct: 'assign', targetAssignment: 'abruf', id: entry.id },
      })
    );
  }

  if (footer.childElementCount > 0) {
    card.appendChild(footer);
  }

  if (dockSelection.has(entry.id)) {
    card.classList.add('is-selected');
  }

  return card;
}

async function updateDockPhase(entry, targetPhase, extra = {}, successMessage = 'Dock-Status aktualisiert.', options = {}) {
  const { silent = false } = options;
  const resets = {};
  if (targetPhase === 1) {
    resets.dockBuApproved = false;
    resets.dockBuApprovedAt = null;
  }
  const updates = { ...extra, ...resets };
  const history = { ...(entry.dockPhaseHistory || {}) };
  const key = String(targetPhase);
  if (!history[key]) {
    history[key] = Date.now();
  }
  updates.dockPhase = targetPhase;
  updates.dockPhaseHistory = history;

  const response = await fetchWithRetry(`${WORKER_BASE}/entries/${encodeURIComponent(entry.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || 'Unbekannter Fehler');
  }

  if (!silent) {
    showToast(successMessage, 'ok');
  }
  await loadHistory(silent);
}

function handleDockBoardClick(event) {
  const button = event.target.closest('button[data-dock-act]');
  if (button) {
    const id = button.dataset.id;
    const action = button.dataset.dockAct;
    if (!id || !action) return;
    if (button.classList.contains('disabled') || button.disabled) {
      event.preventDefault();
      return;
    }

    const entry = findEntryById(id);
    if (!entry) return;
    const rewardFactor = getEntryRewardFactor(entry);
    const rewardComment = typeof entry.dockRewardComment === 'string' ? entry.dockRewardComment.trim() : '';

    if (action === 'hint-assign-framework') {
      const hint = dockConflictHints.get(id);
      if (hint?.frameworkId) {
        const framework = findEntryById(hint.frameworkId);
        if (framework) {
          openFrameworkAssignmentPrompt(entry, framework);
        } else {
          showToast('Rahmenvertrag konnte nicht geladen werden. Bitte Ansicht aktualisieren.', 'warn');
        }
      }
      dockConflictHints.delete(id);
      requestDockBoardRerender();
      return;
    }

    if (action === 'dismiss-hint') {
      dockConflictHints.delete(id);
      requestDockBoardRerender();
      return;
    }

    if (action === 'edit') {
      deps.onEditEntry?.(id);
      return;
    }

    const runUpdate = async (targetPhase, extra, message) => {
      let success = false;
      try {
        button.disabled = true;
        button.classList.add('disabled');
        showLoader();
        await updateDockPhase(entry, targetPhase, extra, message);
        success = true;
      } catch (err) {
        console.error('Dock-Update fehlgeschlagen', err);
        showToast('Dock-Status konnte nicht aktualisiert werden.', 'bad');
      } finally {
        hideLoader();
      }
      return success;
    };

    if (action === 'bu-approve') {
      if (!confirm('HoBU-Freigabe bestätigen?')) return;
      const payload = {
        dockBuApproved: true,
        dockBuApprovedAt: Date.now(),
        dockRewardFactor: rewardFactor,
        dockRewardComment: rewardComment,
      };
      runUpdate(3, payload, 'Freigabe erfasst.');
    } else if (action === 'assign') {
      const target = button.dataset.targetAssignment;
      if (!target) return;
      if (target === 'abruf') {
        if (!confirm('Abruf erfassen und Deal aus dem Dock entfernen?')) return;
        startDockAbrufAssignment(entry);
        return;
      }
      if (target === 'rahmen') {
        openFrameworkVolumeDialog(entry, (volume) => {
          const label = DOCK_ASSIGNMENT_LABELS[target] || target;
          if (!confirm(`Deal endgültig als ${label} zuweisen?`)) return;
          const message = 'Deal als Rahmenvertrag markiert. Bitte Abschluss im entsprechenden Bereich prüfen.';
          const payload = {
            dockFinalAssignment: target,
            dockFinalAssignmentAt: Date.now(),
            dockRewardFactor: rewardFactor,
            dockRewardComment: rewardComment,
            projectType: 'rahmen',
            frameworkVolume: volume,
          };
          queueDockAutoCheck(entry.id, { entry, projectNumber: entry.projectNumber || '', finalAssignment: target });
          runUpdate(3, payload, message);
        });
        return;
      }
      const label = DOCK_ASSIGNMENT_LABELS[target] || target;
      if (!confirm(`Deal endgültig als ${label} zuweisen?`)) return;
      const message = 'Zuweisung gespeichert. Der Deal verschwindet aus dem Dock.';
      const payload = {
        dockFinalAssignment: target,
        dockFinalAssignmentAt: Date.now(),
        dockRewardFactor: rewardFactor,
        dockRewardComment: rewardComment,
      };
      queueDockAutoCheck(entry.id, { entry, projectNumber: entry.projectNumber || '', finalAssignment: target });
      runUpdate(3, payload, message);
    }
    return;
  }

  const card = event.target.closest('.dock-card');
  if (!card) return;
  if (event.target.closest('.dock-card-select')) {
    return;
  }

  const { entryId } = card.dataset;
  if (!entryId) return;
  deps.onEditEntry?.(entryId);
}

export function initDockBoard(options = {}) {
  deps = { ...deps, ...options };
  if (isInitialized) return;
  isInitialized = true;
  ensureDockBoard();
  if (dockBoardEl) {
    dockBoardEl.addEventListener('click', handleDockBoardClick);
    dockBoardEl.addEventListener('change', (event) => {
      const checkbox = event.target.closest('input[data-dock-select]');
      if (!checkbox) return;
      const { id } = checkbox.dataset;
      if (!id) return;
      toggleDockSelection(id, checkbox.checked);
      updateDockSelectionUi();
    });
  }

  if (dockFilterBu) {
    dockFilterBu.addEventListener('change', () => {
      updateDockFilterState({ bu: dockFilterBu.value });
      const filterState = getDockFilterState();
      if (filterState.bu && filterState.marketTeam) {
        const buForTeam = deriveBusinessUnitFromTeam(filterState.marketTeam);
        if (buForTeam && buForTeam !== filterState.bu) {
          updateDockFilterState({ marketTeam: '' });
        }
      }
      renderDockBoard();
    });
  }

  if (dockFilterMarketTeam) {
    dockFilterMarketTeam.addEventListener('change', () => {
      updateDockFilterState({ marketTeam: dockFilterMarketTeam.value });
      renderDockBoard();
    });
  }

  if (dockFilterAssessment) {
    dockFilterAssessment.addEventListener('change', () => {
      updateDockFilterState({ assessment: dockFilterAssessment.value });
      renderDockBoard();
    });
  }

  if (dockSearchInput) {
    dockSearchInput.addEventListener('input', () => {
      updateDockFilterState({ search: dockSearchInput.value.trim().toLowerCase() });
      renderDockBoard();
    });
  }

  if (btnManualDeal) {
    btnManualDeal.addEventListener('click', () => {
      if (!confirm('Standardprozess: Deals kommen automatisch aus HubSpot. Nur in Ausnahmefällen manuell anlegen. Fortfahren?')) {
        return;
      }
      showManualPanel();
    });
  }

  if (btnCloseManualDeal) {
    btnCloseManualDeal.addEventListener('click', () => {
      requestDockEntryDialogClose();
    });
  }

  if (btnDockBatchDelete) {
    btnDockBatchDelete.addEventListener('click', () => {
      const ids = Array.from(dockSelection);
      if (!ids.length) return;
      setPendingDelete({ ids, type: 'batch-entry', fromDock: true });
      document.getElementById('confirmDlgTitle').textContent = 'Deals löschen';
      document.getElementById('confirmDlgText').textContent = `Wollen Sie die ${ids.length} ausgewählten Deals wirklich löschen?`;
      document.getElementById('confirmDlg').showModal();
    });
  }
}

export { finalizeDockAbruf, hideManualPanel, requestDockEntryDialogClose };
