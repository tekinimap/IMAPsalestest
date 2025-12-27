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
  co
