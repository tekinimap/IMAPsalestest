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
import { normalizeDockString, getDockPhase } from '../utils/dock-helpers.js';
import { showLoader, hideLoader, showToast } from '../ui/feedback.js';
import { openWizard } from './erfassung.js';
import { getEntryRewardFactor } from './calculations.js';
import { showView } from './navigation.js';
import { renderPortfolio } from './portfolio.js';
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
  Nachhaltigkeit: 'Public Impact',
  'Bundes- und Landesbehörden': 'Organisational Excellence',
  'Sozial- und Krankenversicherungen': 'Organisational Excellence',
  Kommunalverwaltungen: 'Organisational Excellence',
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

  resetFrameworkVolumeDialog();
  onFrameworkVolumeSubmit = onSubmit;

  const currentValue = getFrameworkVolume(entry);
  frameworkVolumeInput.value = currentValue != null ? formatAmountInput(currentValue) : '';

  if (typeof frameworkVolumeDialog.showModal === 'function') {
    frameworkVolumeDialog.showModal();
  } else {
    frameworkVolumeDialog.setAttribute('open', 'open');
  }
}

if (frameworkVolumeCancel) {
  frameworkVolumeCancel.addEventListener('click', (e) => {
    e.preventDefault();
    closeFrameworkVolumeDialog();
  });
}

if (frameworkVolumeCancelFooter) {
  frameworkVolumeCancelFooter.addEventListener('click', (e) => {
    e.preventDefault();
    closeFrameworkVolumeDialog();
  });
}

if (frameworkVolumeForm) {
  frameworkVolumeForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const value = normalizeFrameworkVolume(frameworkVolumeInput?.value);
    if (value == null) {
      if (frameworkVolumeError) {
        frameworkVolumeError.textContent = 'Bitte ein positives Volumen eingeben.';
      }
      return;
    }
    const submit = onFrameworkVolumeSubmit;
    closeFrameworkVolumeDialog();
    try {
      submit?.(value);
    } catch (err) {
      console.error(err);
      showToast('Volumen konnte nicht gespeichert werden.', 'bad');
    }
  });
}

function firstNonEmptyString(values) {
  for (const value of values) {
    const normalized = normalizeDockString(value);
    if (normalized) return normalized;
  }
  return '';
}

function deriveBusinessUnitFromTeam(marketTeam) {
  if (!marketTeam) return '';
  return MARKET_TEAM_TO_BU[marketTeam] || '';
}

function parseCsvList(value) {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeDockString(item))
      .filter(Boolean)
      .filter((item, idx, arr) => arr.indexOf(item) === idx);
  }
  if (typeof value === 'string') {
    return value
      .split(/[,\n;]/g)
      .map((item) => normalizeDockString(item))
      .filter(Boolean)
      .filter((item, idx, arr) => arr.indexOf(item) === idx);
  }
  return [];
}

function getEntryKvList(entry) {
  if (!entry || typeof entry !== 'object') return [];
  const direct = parseCsvList(entry.kv_nummer || entry.kvNummer || entry.kv || entry.kv_numbers || entry.kvNumbers);
  const list = parseCsvList(entry.kvList || entry.kv_list || entry.kvNummern);
  const trans = Array.isArray(entry.transactions)
    ? entry.transactions
        .flatMap((t) => parseCsvList(t?.kv_nummer || t?.kvNummer || t?.kv))
        .filter(Boolean)
    : [];
  const merged = [...direct, ...list, ...trans].map((v) => normalizeDockString(v)).filter(Boolean);
  return merged.filter((item, idx, arr) => arr.indexOf(item) === idx);
}

function computeDockChecklist(entry) {
  const rawAmount = entry?.amount ?? entry?.budget;
  const parsedAmount = Number(rawAmount);
  const amount =
    rawAmount != null && !(typeof rawAmount === 'string' && rawAmount.trim() === '') && Number.isFinite(parsedAmount) && parsedAmount >= 0;
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

  const phase = Number(entry.dockPhase);
  if (Number.isFinite(phase) && phase >= 4) return false;

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

let dockFilterState = getDockFilterState();
let dockSelection = getDockSelection();
let dockAutoAdvanceQueue = getDockAutoAdvanceQueue();
let dockAutoAdvanceProcessed = getDockAutoAdvanceProcessed();
let dockAutoDowngradeQueue = getDockAutoDowngradeQueue();
let dockAutoDowngradeProcessed = getDockAutoDowngradeProcessed();
let dockAutoCheckQueue = getDockAutoCheckQueue();
let dockAutoCheckHistory = getDockAutoCheckHistory();
let dockConflictHints = getDockConflictHints();

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
    const id = card.dataset.id;
    if (!id) return;
    card.classList.toggle('selected', dockSelection.has(id));
  });
}

function setDockFilterState(nextState) {
  dockFilterState = nextState;
  updateDockFilterState(nextState);
}

function renderDockFilterOptions(items) {
  const marketTeams = new Set();
  const businessUnits = new Set();
  const assessmentOwners = new Set();

  items.forEach((item) => {
    if (!item || !item.show) return;
    if (item.marketTeam) marketTeams.add(item.marketTeam);
    if (item.businessUnit) businessUnits.add(item.businessUnit);
    if (item.assessmentOwner) assessmentOwners.add(item.assessmentOwner);
  });

  const setSelectOptions = (selectEl, values, emptyLabel) => {
    if (!selectEl) return;
    const current = selectEl.value;
    selectEl.innerHTML = `<option value="">${escapeHtml(emptyLabel)}</option>`;
    Array.from(values)
      .sort((a, b) => a.localeCompare(b, 'de'))
      .forEach((value) => {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = value;
        selectEl.appendChild(opt);
      });
    if (current) {
      selectEl.value = current;
    }
  };

  setSelectOptions(dockFilterMarketTeam, marketTeams, 'Alle Market Teams');
  setSelectOptions(dockFilterBu, businessUnits, 'Alle Business Units');
  setSelectOptions(dockFilterAssessment, assessmentOwners, 'Alle Zuständigkeiten');
}

function createDockColumns() {
  if (!dockBoardEl) return;
  dockBoardEl.innerHTML = '';

  const dockColumns = new Map();
  const dockColumnBodies = new Map();
  const dockColumnCounts = new Map();

  DOCK_PHASES.forEach((phase) => {
    const column = document.createElement('div');
    column.className = 'dock-column';
    column.dataset.phase = String(phase.id);
    column.innerHTML = `
      <div class="dock-column-header">
        <div class="dock-column-header-content">
          <h2>${escapeHtml(phase.title)}</h2>
          <p>${escapeHtml(phase.description)}</p>
        </div>
        <span class="dock-column-count" data-phase-count=${phase.id}>0</span>
      </div>
      <div class="dock-column-body" data-phase-body=${phase.id}></div>
    `;
    dockBoardEl.appendChild(column);
    dockColumns.set(phase.id, column);
    dockColumnBodies.set(phase.id, column.querySelector(`[data-phase-body="${phase.id}"]`));
    dockColumnCounts.set(phase.id, column.querySelector(`[data-phase-count="${phase.id}"]`));
  });

  return { dockColumns, dockColumnBodies, dockColumnCounts };
}

let dockColumnsUi = null;

function ensureDockColumns() {
  if (dockColumnsUi) return dockColumnsUi;
  dockColumnsUi = createDockColumns();
  return dockColumnsUi;
}

function showDockEmptyState(show) {
  if (!dockEmptyState) return;
  dockEmptyState.classList.toggle('hide', !show);
}

function createDockCard(item) {
  const { entry, checklist, kvList, phase, conflictHint, isFlagship } = item;

  const title = normalizeDockString(entry?.title) || 'Ohne Titel';
  const client = normalizeDockString(entry?.client) || '—';
  const projectNumber = normalizeDockString(entry?.projectNumber) || '—';

  // ✅ FIX: fmtCurr0 ist ein Intl.NumberFormat -> daher .format(...)
  const amount = checklist.amount ? fmtCurr0.format(Number(entry.amount || entry.budget || 0)) : '—';

  const assessmentOwner = normalizeDockString(item.assessmentOwner) || '—';
  const businessUnit = normalizeDockString(item.businessUnit) || '—';
  const marketTeam = normalizeDockString(item.marketTeam) || '—';

  const checklistState = [];
  if (!checklist.amount) checklistState.push('Budget');
  if (!checklist.hasClient) checklistState.push('Kunde');
  if (!checklist.hasProjectNumber) checklistState.push('Projekt-Nr.');
  if (!checklist.hasKv) checklistState.push('KV');
  if (!checklist.hasSalesContributions) checklistState.push('Sales');
  const checklistMissing = checklistState.length ? `Fehlt: ${checklistState.join(', ')}` : 'Vollständig';

  const kvText = kvList.length ? kvList.join(', ') : '—';

  const conflictText = conflictHint?.conflicts?.length
    ? `⚠️ KV doppelt: ${conflictHint.conflicts.map((c) => c.kv).join(', ')}`
    : '';

  const reward = getEntryRewardFactor(entry);

  const card = document.createElement('div');
  card.className = 'dock-card';
  card.dataset.id = entry.id;
  card.dataset.phase = String(phase);
  card.innerHTML = `
    <div class="dock-card-top">
      <div class="dock-card-title">
        ${escapeHtml(title)}
        ${isFlagship ? '<span class="badge badge-flagship">Flagship</span>' : ''}
      </div>
      <div class="dock-card-client">${escapeHtml(client)}</div>
    </div>

    <div class="dock-card-meta">
      <div><span class="muted">Projekt</span> ${escapeHtml(projectNumber)}</div>
      <div><span class="muted">KV</span> ${escapeHtml(kvText)}</div>
      <div><span class="muted">Budget</span> ${escapeHtml(amount)}</div>
      <div><span class="muted">BU</span> ${escapeHtml(businessUnit)}</div>
      <div><span class="muted">Market</span> ${escapeHtml(marketTeam)}</div>
      <div><span class="muted">Zuständig</span> ${escapeHtml(assessmentOwner)}</div>
      <div><span class="muted">Check</span> ${escapeHtml(checklistMissing)}</div>
      <div><span class="muted">Reward</span> ${escapeHtml(String(reward))}</div>
      ${conflictText ? `<div class="dock-card-conflict">${escapeHtml(conflictText)}</div>` : ''}
    </div>

    <div class="dock-card-actions">
      <button class="btn btn-sm dock-open">Öffnen</button>
      <button class="btn btn-sm dock-select">${dockSelection.has(entry.id) ? 'Markiert' : 'Markieren'}</button>
      <button class="btn btn-sm dock-delete">Löschen</button>
    </div>
  `;
  return card;
}

function renderDockItems(items) {
  const columns = ensureDockColumns();
  if (!columns) return;
  const { dockColumnBodies, dockColumnCounts } = columns;

  const filtered = items.filter(matchesDockFilters);
  const grouped = new Map(DOCK_PHASES.map((phase) => [phase.id, []]));
  filtered.forEach((item) => {
    const list = grouped.get(item.phase);
    if (list) list.push(item);
  });

  DOCK_PHASES.forEach((phase) => {
    const body = dockColumnBodies.get(phase.id);
    const countEl = dockColumnCounts.get(phase.id);
    if (!body) return;
    body.innerHTML = '';

    const items = grouped.get(phase.id) || [];
    items
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .forEach((item) => {
        body.appendChild(createDockCard(item));
      });

    if (countEl) {
      const amount = grouped.get(phase.id)?.length || 0;
      countEl.textContent = String(amount);
    }
  });

  showDockEmptyState(filtered.length === 0);
}

async function saveDockEntry(entryId, updates) {
  const url = `${WORKER_BASE}/entries/${encodeURIComponent(entryId)}`;
  const payload = { ...updates, modified: Date.now() };

  const response = await fetchWithRetry(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    let detail = '';
    try {
      const json = await response.json();
      detail = json?.error || json?.details || '';
    } catch {}
    throw new Error(`Speichern fehlgeschlagen (${response.status}) ${detail}`.trim());
  }

  const saved = await response.json();
  saveState({ dirty: true });
  return saved;
}

async function handleDockDelete(entryId) {
  const entry = findEntryById(entryId);
  if (!entry) return;

  const ok = confirm(`Deal wirklich löschen?\n\n${entry.title || entry.projectNumber || entry.id}`);
  if (!ok) return;

  setPendingDelete(entry);
  showView('history');
  await loadHistory();
}

async function handleDockOpen(entryId) {
  const entry = findEntryById(entryId);
  if (!entry) return;
  openWizard(entry);
}

async function handleDockSelect(entryId) {
  toggleDockSelection(entryId);
  dockSelection = getDockSelection();
  updateDockSelectionUi();
}

async function handleDockCardClick(e) {
  const card = e.target.closest('.dock-card');
  if (!card) return;
  const id = card.dataset.id;
  if (!id) return;

  if (e.target.closest('.dock-open')) {
    await handleDockOpen(id);
    return;
  }
  if (e.target.closest('.dock-select')) {
    await handleDockSelect(id);
    return;
  }
  if (e.target.closest('.dock-delete')) {
    await handleDockDelete(id);
    return;
  }
}

function syncFilterInputsFromState() {
  if (dockFilterBu) dockFilterBu.value = dockFilterState.bu || '';
  if (dockFilterMarketTeam) dockFilterMarketTeam.value = dockFilterState.marketTeam || '';
  if (dockFilterAssessment) dockFilterAssessment.value = dockFilterState.assessment || '';
  if (dockSearchInput) dockSearchInput.value = dockFilterState.search || '';
}

function attachFilterListeners() {
  if (dockFilterBu) {
    dockFilterBu.addEventListener('change', () => {
      setDockFilterState({ ...dockFilterState, bu: dockFilterBu.value });
      rerenderDockBoard();
    });
  }
  if (dockFilterMarketTeam) {
    dockFilterMarketTeam.addEventListener('change', () => {
      setDockFilterState({ ...dockFilterState, marketTeam: dockFilterMarketTeam.value });
      rerenderDockBoard();
    });
  }
  if (dockFilterAssessment) {
    dockFilterAssessment.addEventListener('change', () => {
      setDockFilterState({ ...dockFilterState, assessment: dockFilterAssessment.value });
      rerenderDockBoard();
    });
  }
  if (dockSearchInput) {
    dockSearchInput.addEventListener('input', () => {
      setDockFilterState({ ...dockFilterState, search: dockSearchInput.value.trim().toLowerCase() });
      rerenderDockBoard();
    });
  }
}

function rerenderDockBoard() {
  if (isDockBoardRerenderScheduled()) return;
  setDockBoardRerenderScheduled(true);
  setTimeout(() => {
    setDockBoardRerenderScheduled(false);
    renderDockBoard();
  }, 50);
}

function handleManualDealClick() {
  openWizard(null, { mode: 'manual' });
}

function handleCloseManualDeal() {
  if (dockEntryDialog) {
    if (typeof dockEntryDialog.close === 'function') {
      dockEntryDialog.close();
    } else {
      dockEntryDialog.removeAttribute('open');
    }
  }
}

function updateManualDealButtons() {
  if (!btnManualDeal) return;
  const hasUnsaved = getHasUnsavedChanges?.() || false;
  btnManualDeal.disabled = hasUnsaved;
}

async function initializeDockBoard() {
  if (isDockBoardInitialized()) return;
  markDockBoardInitialized();
  syncFilterInputsFromState();
  attachFilterListeners();

  if (dockBoardEl) {
    dockBoardEl.addEventListener('click', (e) => {
      handleDockCardClick(e);
    });
  }

  if (btnManualDeal) {
    btnManualDeal.addEventListener('click', handleManualDealClick);
  }

  if (btnCloseManualDeal) {
    btnCloseManualDeal.addEventListener('click', handleCloseManualDeal);
  }

  if (btnDockBatchDelete) {
    btnDockBatchDelete.addEventListener('click', () => {
      if (dockSelection.size === 0) return;
      const ok = confirm(`Wirklich ${dockSelection.size} Deals löschen?`);
      if (!ok) return;
      const entries = Array.from(dockSelection)
        .map((id) => findEntryById(id))
        .filter(Boolean);
      if (entries.length) {
        setPendingDelete(entries[0]);
      }
    });
  }

  isInitialized = true;
}

function updateDockEmptyState(items) {
  const filtered = items.filter(matchesDockFilters);
  showDockEmptyState(filtered.length === 0);
}

async function checkDockEntryConflicts(item) {
  const { entry, kvList } = item;
  if (!entry?.id) return;

  const allEntries = getEntries() || [];
  const conflicts = [];

  kvList.forEach((kv) => {
    const normalizedKv = normalizeDockString(kv);
    if (!normalizedKv) return;

    const dupes = allEntries.filter((other) => {
      if (!other || other.id === entry.id) return false;
      const otherKvs = getEntryKvList(other);
      return otherKvs.includes(normalizedKv);
    });

    if (dupes.length) {
      conflicts.push({
        kv: normalizedKv,
        entries: dupes.map((d) => ({
          id: d.id,
          title: d.title,
          projectNumber: d.projectNumber,
        })),
      });
    }
  });

  dockConflictHints.set(entry.id, { checkedAt: Date.now(), conflicts });
}

async function runDockAutoChecks(items) {
  const queue = dockAutoCheckQueue;
  if (!queue.length) return;

  const now = Date.now();
  const maxPerRun = 8;

  let processed = 0;
  while (queue.length && processed < maxPerRun) {
    const next = queue.shift();
    processed += 1;
    if (!next?.id) continue;

    const already = dockAutoCheckHistory.get(next.id);
    if (already && now - already < 10_000) continue;

    const item = items.find((i) => i.entry?.id === next.id);
    if (!item) continue;
    if (item.phase !== 3) continue;

    dockAutoCheckHistory.set(next.id, now);
    await checkDockEntryConflicts(item);
  }
}

async function runDockAutoAdvance(items) {
  if (isDockAutoAdvanceRunning()) return;
  const queue = dockAutoAdvanceQueue;
  if (!queue.length) return;

  setDockAutoAdvanceRunning(true);
  try {
    const now = Date.now();
    const next = queue.shift();
    if (!next?.id) return;

    const already = dockAutoAdvanceProcessed.get(next.id);
    if (already && now - already < 10_000) return;

    const entry = findEntryById(next.id);
    if (!entry) return;

    const checklist = computeDockChecklist(entry);
    const phase = getDockPhase(entry);

    if (phase === 1 && isPhaseTwoReady(checklist)) {
      await saveDockEntry(entry.id, { dockPhase: 2 });
      dockAutoAdvanceProcessed.set(entry.id, now);
      showToast('Deal automatisch auf Phase 2 gesetzt.', 'ok');
    }
  } catch (err) {
    console.error(err);
  } finally {
    setDockAutoAdvanceRunning(false);
  }
}

async function runDockAutoDowngrade(items) {
  if (isDockAutoDowngradeRunning()) return;
  const queue = dockAutoDowngradeQueue;
  if (!queue.length) return;

  setDockAutoDowngradeRunning(true);
  try {
    const now = Date.now();
    const next = queue.shift();
    if (!next?.id) return;

    const already = dockAutoDowngradeProcessed.get(next.id);
    if (already && now - already < 10_000) return;

    const entry = findEntryById(next.id);
    if (!entry) return;

    const checklist = computeDockChecklist(entry);
    const checklistComplete = checklist.isComplete;
    const phase = getDockPhase(entry);

    if (phase === 2 && !checklistComplete) {
      await saveDockEntry(entry.id, { dockPhase: 1 });
      dockAutoDowngradeProcessed.set(entry.id, now);
      showToast('Deal automatisch zurück auf Phase 1 gesetzt.', 'warn');
    } else if (phase === 3 && !checklistComplete) {
      await saveDockEntry(entry.id, { dockPhase: 2 });
      dockAutoDowngradeProcessed.set(entry.id, now);
      showToast('Deal automatisch zurück auf Phase 2 gesetzt.', 'warn');
    }
  } catch (err) {
    console.error(err);
  } finally {
    setDockAutoDowngradeRunning(false);
  }
}

function scheduleDockAutoAdvance(entry) {
  if (!entry?.id) return;
  dockAutoAdvanceQueue.push({ id: entry.id });
}

function scheduleDockAutoDowngrade(entry) {
  if (!entry?.id) return;
  dockAutoDowngradeQueue.push({ id: entry.id });
}

function scheduleDockAutoCheck(entry) {
  if (!entry?.id) return;
  dockAutoCheckQueue.push({ id: entry.id });
}

function scheduleDockAutomation(items) {
  items.forEach((item) => {
    if (!item?.entry?.id) return;

    if (item.phase === 3) {
      scheduleDockAutoCheck(item.entry);
    }

    const checklist = item.checklist;
    const checklistComplete = checklist.isComplete;
    if (item.phase === 1 && isPhaseTwoReady(checklist)) {
      scheduleDockAutoAdvance(item.entry);
    }

    if ((item.phase === 2 || item.phase === 3) && !checklistComplete) {
      scheduleDockAutoDowngrade(item.entry);
    }
  });
}

function isUnsavedChangesBlocker() {
  try {
    return getHasUnsavedChanges?.() || false;
  } catch {
    return false;
  }
}

export async function renderDockBoard() {
  await initializeDockBoard();
  if (!dockBoardEl) return;

  if (isUnsavedChangesBlocker()) {
    showToast('Bitte erst speichern oder Änderungen verwerfen, bevor der Dock aktualisiert wird.', 'warn');
    return;
  }

  showLoader('Dock wird geladen…');

  try {
    const entries = getEntries() || [];
    const items = entries.map(augmentDockEntry);

    renderDockFilterOptions(items);
    renderDockItems(items);
    updateDockSelectionUi();
    updateDockEmptyState(items);

    scheduleDockAutomation(items);

    await runDockAutoChecks(items);
    await runDockAutoAdvance(items);
    await runDockAutoDowngrade(items);

    updateManualDealButtons();
  } catch (err) {
    console.error(err);
    showToast('Dock konnte nicht geladen werden.', 'bad');
  } finally {
    hideLoader();
  }
}

export function initDockBoard(dockDeps = {}) {
  deps = dockDeps;
  if (isInitialized) return;
  initializeDockBoard();
}

export async function finalizeDockAssignment(entryId, assignment, extraUpdates = {}) {
  const entry = findEntryById(entryId);
  if (!entry) return;

  const updates = {
    dockFinalAssignment: assignment,
    dockFinalAssignmentAt: Date.now(),
    dockPhase: 3,
    ...extraUpdates,
  };

  await saveDockEntry(entryId, updates);

  showToast(`Deal abgeschlossen: ${DOCK_ASSIGNMENT_LABELS[assignment] || assignment}`, 'ok');

  clearDockSelection();
  dockSelection = getDockSelection();
  updateDockSelectionUi();

  renderPortfolio();
  await renderDockBoard();
}

export async function finalizeAsAbruf(entryId, parentFrameworkId) {
  if (!entryId) return;
  setPendingDockAbrufAssignment({ entryId, parentFrameworkId });
  showView('frameworks');
}

export async function confirmAbrufAssignment(frameworkEntry) {
  const pending = getPendingDockAbrufAssignment();
  if (!pending?.entryId || !frameworkEntry?.id) return;

  try {
    await finalizeDockAssignment(pending.entryId, 'abruf', {
      dockAbrufFrameworkId: frameworkEntry.id,
      dockAbrufFrameworkProjectNumber: frameworkEntry.projectNumber || '',
    });
  } finally {
    setPendingDockAbrufAssignment(null);
  }
}

export async function createManualDeal(payload) {
  const now = Date.now();
  const entry = {
    ...payload,
    id: payload?.id || `m_${now}`,
    ts: payload?.ts || now,
    modified: now,
    source: payload?.source || 'manuell',
  };

  const response = await fetchWithRetry(`${WORKER_BASE}/entries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(entry),
  });

  if (!response.ok) throw new Error(await response.text());
  const saved = await response.json();
  saveState({ dirty: true });
  return saved;
}

export function requestDockEntryDialogClose() {
  if (dockEntryDialog) {
    if (typeof dockEntryDialog.close === 'function') {
      dockEntryDialog.close();
    } else {
      dockEntryDialog.removeAttribute('open');
    }
  }
}

export function hideManualPanel() {
  const panel = document.getElementById('manualPanel');
  if (panel) panel.classList.add('hide');
}

export function showManualPanel() {
  const panel = document.getElementById('manualPanel');
  if (panel) panel.classList.remove('hide');
}

export function queueDockAutoCheck(entryId) {
  if (!entryId) return;
  dockAutoCheckQueue.push({ id: entryId });
}

export function findDockKvConflict(entryId) {
  const hint = dockConflictHints.get(entryId);
  if (!hint?.conflicts?.length) return null;
  return hint;
}

export async function finalizeDockAbruf() {
  const pending = getPendingDockAbrufAssignment();
  if (!pending?.entryId) return;
  const frameworkId = getCurrentFrameworkEntryId();
  if (!frameworkId) return;
  await finalizeDockAssignment(pending.entryId, 'abruf', {
    dockAbrufFrameworkId: frameworkId,
  });
  setPendingDockAbrufAssignment(null);
}

export function clearInputFields() {
  // Der neue Wizard verwaltet seine Felder selbst; hier nur Kompatibilität
  // für den Aufruf aus main.js.
}

export { finalizeDockAbruf, hideManualPanel, requestDockEntryDialogClose };
