// --- Kompletter Inhalt für public/js/app.js ---

import {
  WORKER_BASE,
  TEAMS,
  DEFAULT_WEIGHTS,
  CATEGORY_NAMES,
  FOUNDER_SHARE_PCT,
  CONFIG_WARNINGS,
  CONFIG_ERRORS,
} from './config.js';
import {
  saveState,
  loadState,
  getHasUnsavedChanges,
  setHasUnsavedChanges,
  getIsBatchRunning,
} from './state.js';
import { getEntries, setEntries, upsertEntry, findEntryById, removeEntryById } from './entries-state.js';
import { throttle, fetchWithRetry } from './api.js';
import {
  fmtPct,
  fmtInt,
  fmtCurr2,
  fmtCurr0,
  formatAmountInput,
  getTodayDate,
  formatDateForInput,
  formatIsoDate as formatIsoDateDisplay,
  clamp01,
  toInt0,
  parseAmountInput,
  escapeHtml,
} from './utils/format.js';
import {
  showLoader,
  hideLoader,
  showToast,
  showBatchProgress,
  updateBatchProgress,
  hideBatchProgress,
} from './ui/feedback.js';

const hasConfigWarnings = CONFIG_WARNINGS.length > 0;
const hasConfigErrors = CONFIG_ERRORS.length > 0;

if (hasConfigWarnings) {
  if (typeof console !== 'undefined' && CONFIG_WARNINGS.length) {
    console.groupCollapsed?.('Konfiguration – Hinweise');
    CONFIG_WARNINGS.forEach((msg) => console.warn(msg));
    console.groupEnd?.();
  }
}

if (hasConfigErrors) {
  if (typeof console !== 'undefined' && CONFIG_ERRORS.length) {
    console.groupCollapsed?.('Konfiguration – Fehler');
    CONFIG_ERRORS.forEach((msg) => console.error(msg));
    console.groupEnd?.();
  }
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
import {
  appendRow as appendFormRow,
  readRows,
  createRowTemplate,
  setupRow,
} from './ui/forms.js';

/* ---------- Navigation ---------- */
const views = { erfassung: document.getElementById('viewErfassung'), fixauftraege: document.getElementById('viewFixauftraege'), rahmen: document.getElementById('viewRahmen'), rahmenDetails: document.getElementById('viewRahmenDetails'), admin: document.getElementById('viewAdmin'), analytics: document.getElementById('viewAnalytics') };
const navLinks = document.querySelectorAll('.nav-link');

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
const dockEntryDialog = document.getElementById('dockEntryDialog');
const dockManualPanel = document.getElementById('dockManualPanel');

let currentSession = { email: '', name: '', rawName: '', person: null };

function updateRecognizedPersonFromPeople() {
  if (!Array.isArray(people) || people.length === 0) {
    if (currentSession.person) {
      currentSession.person = null;
    }
    return;
  }
  const emailLower = String(currentSession.email || '').toLowerCase();
  if (emailLower) {
    const matchedByEmail = people.find((person) => String(person?.email || '').toLowerCase() === emailLower);
    if (matchedByEmail) {
      currentSession.person = matchedByEmail;
      currentSession.name = matchedByEmail.name || currentSession.name || '';
      return;
    }
  }
  const nameLower = String(currentSession.name || '').trim().toLowerCase();
  if (nameLower) {
    const matchedByName = people.find((person) => String(person?.name || '').trim().toLowerCase() === nameLower);
    if (matchedByName) {
      currentSession.person = matchedByName;
      currentSession.name = matchedByName.name || currentSession.name || '';
    }
  }
}
const dockIntroEl = document.getElementById('erfassungSub');
const dockIntroDefaultText = dockIntroEl ? dockIntroEl.textContent : '';
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

let people = [];

const dockColumnBodies = new Map();
const dockColumnCounts = new Map();
const dockFilterState = { bu: '', marketTeam: '', assessment: '', search: '' };
const dockSelection = new Set();
let dockBoardInitialized = false;
const dockAutoAdvanceQueue = [];
const dockAutoAdvanceProcessed = new Set();
let dockAutoAdvanceRunning = false;
const dockAutoCheckQueue = new Map();
const dockAutoCheckHistory = new Map();
const dockConflictHints = new Map();
let dockBoardRerenderScheduled = false;
let pendingDockAbrufAssignment = null;

function normalizeDockString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function requestDockBoardRerender() {
  if (dockBoardRerenderScheduled) return;
  const scheduler = typeof window !== 'undefined' && window.requestAnimationFrame
    ? window.requestAnimationFrame.bind(window)
    : (cb) => setTimeout(cb, 0);
  dockBoardRerenderScheduled = true;
  scheduler(() => {
    dockBoardRerenderScheduled = false;
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
  if (!dockBoardEl || dockBoardInitialized) return;
  dockBoardInitialized = true;
  dockBoardEl.innerHTML = '';
  DOCK_PHASES.forEach((phase) => {
    const column = document.createElement('section');
    column.className = 'dock-column';
    column.dataset.phase = String(phase.id);
    column.innerHTML = `
      <header class="dock-column-header">
        <div>
          <h2>${escapeHtml(phase.title)}</h2>
          <p>${escapeHtml(phase.description)}</p>
        </div>
        <span class="dock-column-count" data-phase-count="${phase.id}">0</span>
      </header>
      <div class="dock-column-body" data-phase-body="${phase.id}"></div>
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
    <button class="dialog-close" type="button" aria-label="Modal schließen">×</button>
    <div class="hd"><h1>Abruf zuordnen</h1></div>
    <div class="ct">
      <div id="abrufAssignValidation" class="validation-summary"></div>
      <div class="grid-1">
        <label for="abrufAssignFramework">Rahmenvertrag auswählen *</label>
        <select id="abrufAssignFramework"></select>
      </div>
      <div style="margin-top:12px">
        <label>Abruf-Typ *</label>
        <div class="radio-group">
          <label><input type="radio" name="abrufAssignType" value="founder"> Passiver Abruf (Founder)</label>
          <label><input type="radio" name="abrufAssignType" value="hunter" checked> Aktiver Abruf (Hunter)</label>
        </div>
      </div>
      <div class="hr"></div>
      <div style="display:flex;gap:10px;justify-content:flex-end;">
        <button class="btn" data-abort>Abbrechen</button>
        <button class="btn ok" data-confirm>Abruf erfassen</button>
      </div>
    </div>
  `;
  document.body.appendChild(dialog);

  dialog.addEventListener('click', (ev) => {
    if (ev.target.matches('.dialog-close') || ev.target.dataset.abort !== undefined) {
      dialog.close();
      pendingDockAbrufAssignment = null;
    }
  });

  const confirmBtn = dialog.querySelector('[data-confirm]');
  if (confirmBtn) {
    confirmBtn.addEventListener('click', () => handleAbrufAssignConfirm());
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
  frameworks
    .sort((a, b) => (a.title || '').localeCompare(b.title || ''))
    .forEach((fw) => {
      const opt = document.createElement('option');
      opt.value = fw.id;
      opt.textContent = `${fw.title || 'Unbenannt'} (${fw.client || '–'})`;
      if (preselectId && fw.id === preselectId) {
        opt.selected = true;
      }
      select.appendChild(opt);
    });
}

async function finalizeDockAbruf(entryId) {
  const entry = findEntryById(entryId);
  if (!entry) {
    pendingDockAbrufAssignment = null;
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
    pendingDockAbrufAssignment = null;
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
  showManualPanel();
  initFromState();
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
  const preselectId = hint?.frameworkId;
  if (preselectId) {
    const framework = findEntryById(preselectId);
    if (framework) {
      openFrameworkAssignmentPrompt(entry, framework);
      return;
    }
  }

  pendingDockAbrufAssignment = { entry };
  populateAbrufAssignmentDialog(frameworks, preselectId);

  const dialog = ensureAbrufAssignmentDialog();
  try {
    dialog.showModal();
  } catch (err) {
    console.error('Abruf-Dialog konnte nicht geöffnet werden.', err);
    showToast('Abruf-Auswahl konnte nicht geöffnet werden.', 'bad');
    pendingDockAbrufAssignment = null;
  }
}

function handleAbrufAssignConfirm() {
  const dialog = ensureAbrufAssignmentDialog();
  const select = dialog.querySelector('#abrufAssignFramework');
  const validation = dialog.querySelector('#abrufAssignValidation');
  const type = dialog.querySelector('input[name="abrufAssignType"]:checked')?.value || 'hunter';

  if (!pendingDockAbrufAssignment || !select || !validation) {
    dialog.close();
    pendingDockAbrufAssignment = null;
    return;
  }

  const frameworkId = select.value;
  if (!frameworkId) {
    validation.textContent = 'Bitte Rahmenvertrag auswählen.';
    return;
  }
  const framework = findEntryById(frameworkId);
  if (!framework) {
    validation.textContent = 'Rahmenvertrag konnte nicht geladen werden.';
    return;
  }

  pendingDockAbrufAssignment.frameworkId = frameworkId;
  pendingDockAbrufAssignment.mode = type;
  dialog.close();

  if (type === 'founder') {
    const transactionTemplate = {
      type: 'founder',
      amount: pendingDockAbrufAssignment.entry?.amount || 0,
      kv_nummer: pendingDockAbrufAssignment.entry?.kv_nummer || pendingDockAbrufAssignment.entry?.kv || '',
      freigabedatum:
        pendingDockAbrufAssignment.entry?.freigabedatum || pendingDockAbrufAssignment.entry?.ts || Date.now(),
    };
    openEditTransactionModal(transactionTemplate, framework);
  } else {
    startAbrufMode(pendingDockAbrufAssignment.entry, framework);
  }
}

function showManualPanel() {
  if (dockEntryDialog && !dockEntryDialog.open) {
    try {
      dockEntryDialog.showModal();
    } catch (err) {
      console.error('Dialog konnte nicht geöffnet werden', err);
    }
  }
  if (dockManualPanel) {
    dockManualPanel.scrollTop = 0;
  }
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

function getDockPhase(entry) {
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

function renderDockBoard() {
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
}

function queueDockAutoCheck(id, context = {}) {
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
    const fixMatches = sameProject.filter((item) => (item.projectType || 'fix') === 'fix');
    if (fixMatches.length > 0) {
      dockConflictHints.set(entry.id, {
        type: 'merge',
        severity: 'warn',
        title: 'Projektnummer doppelt vergeben',
        message: 'Es gibt bereits einen Fixauftrag mit derselben Projektnummer. Prüfe, ob beide Deals zusammengehören.',
        mergeIds: [entry.id, ...fixMatches.map((item) => item.id)],
        primaryAction: { act: 'hint-merge', label: 'Deals zusammenführen' },
        dismissLabel: 'Später prüfen',
      });
      showToast('Doppelte Projektnummer entdeckt. Du kannst die Deals zusammenführen.', 'warn', 6000);
      requestDockBoardRerender();
      return;
    }

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

function findDockKvConflict(kvValue, excludeId) {
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
  renderFrameworkContracts();
  renderRahmenDetails(framework.id);
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
  const svgNs = 'http://www.w3.org/2000/svg';

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

  const actions = createDockElement('div', { className: 'dock-card-actions' });
  const editBtn = createDockElement('button', {
    className: 'dock-card-edit',
    attrs: { type: 'button', 'aria-label': 'Deal bearbeiten', title: 'Deal bearbeiten' },
    dataset: { dockAct: 'edit', id: entry.id },
  });
  const icon = document.createElementNS(svgNs, 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('focusable', 'false');
  icon.setAttribute('aria-hidden', 'true');
  const framePath = document.createElementNS(svgNs, 'path');
  framePath.setAttribute('d', 'M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7');
  framePath.setAttribute('fill', 'none');
  framePath.setAttribute('stroke', 'currentColor');
  framePath.setAttribute('stroke-width', '1.5');
  framePath.setAttribute('stroke-linecap', 'round');
  framePath.setAttribute('stroke-linejoin', 'round');
  const pencilPath = document.createElementNS(svgNs, 'path');
  pencilPath.setAttribute('d', 'M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z');
  pencilPath.setAttribute('fill', 'none');
  pencilPath.setAttribute('stroke', 'currentColor');
  pencilPath.setAttribute('stroke-width', '1.5');
  pencilPath.setAttribute('stroke-linecap', 'round');
  pencilPath.setAttribute('stroke-linejoin', 'round');
  icon.append(framePath, pencilPath);
  editBtn.appendChild(icon);
  actions.appendChild(editBtn);
  header.appendChild(actions);
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
      badgeRow.appendChild(createDockElement('span', { className: badge.className, text: badge.text }));
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
    if (entry.dockBuApproved) {
      footer.appendChild(createDockElement('span', { className: 'dock-pill ok', text: 'BU freigegeben' }));
    } else {
      footer.appendChild(
        createDockElement('button', {
          className: 'btn ok tight',
          text: 'BU-Freigabe bestätigen',
          attrs: { type: 'button' },
          dataset: { dockAct: 'bu-approve', id: entry.id },
        })
      );
    }
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
  const updates = { ...extra };
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

    if (action === 'hint-merge') {
      const hint = dockConflictHints.get(id);
      if (hint?.mergeIds?.length >= 2) {
        showView('fixauftraege');
        selectFixEntries(hint.mergeIds, true);
        showToast('Deals mit identischer Projektnummer wurden markiert.', 'warn', 5000);
      }
      dockConflictHints.delete(id);
      requestDockBoardRerender();
      return;
    }

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
      editEntry(id);
      return;
    }

    const runUpdate = async (targetPhase, extra, message) => {
      try {
        button.disabled = true;
        button.classList.add('disabled');
        showLoader();
        await updateDockPhase(entry, targetPhase, extra, message);
      } catch (err) {
        console.error('Dock-Update fehlgeschlagen', err);
        showToast('Dock-Status konnte nicht aktualisiert werden.', 'bad');
      } finally {
        hideLoader();
      }
    };

    if (action === 'bu-approve') {
      if (!confirm('BU-Freigabe bestätigen?')) return;
      runUpdate(3, { dockBuApproved: true, dockBuApprovedAt: Date.now() }, 'Freigabe erfasst.');
    } else if (action === 'assign') {
      const target = button.dataset.targetAssignment;
      if (!target) return;
      if (target === 'abruf') {
        if (!confirm('Abruf erfassen und Deal aus dem Dock entfernen?')) return;
        startDockAbrufAssignment(entry);
        return;
      }
      const label = DOCK_ASSIGNMENT_LABELS[target] || target;
      if (!confirm(`Deal endgültig als ${label} zuweisen?`)) return;
      const message = target === 'rahmen'
        ? 'Deal als Rahmenvertrag markiert. Bitte Abschluss im entsprechenden Bereich prüfen.'
        : 'Zuweisung gespeichert. Der Deal verschwindet aus dem Dock.';
      const payload = {
        dockFinalAssignment: target,
        dockFinalAssignmentAt: Date.now(),
      };
      if (target === 'rahmen') {
        payload.projectType = 'rahmen';
      }
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
  editEntry(entryId);
}

ensureDockBoard();
if (dockBoardEl) {
  dockBoardEl.addEventListener('click', handleDockBoardClick);
  dockBoardEl.addEventListener('change', (event) => {
    const checkbox = event.target.closest('input[data-dock-select]');
    if (!checkbox) return;
    const { id } = checkbox.dataset;
    if (!id) return;
    if (checkbox.checked) {
      dockSelection.add(id);
    } else {
      dockSelection.delete(id);
    }
    updateDockSelectionUi();
  });
}

if (dockFilterBu) {
  dockFilterBu.addEventListener('change', () => {
    dockFilterState.bu = dockFilterBu.value;
    if (dockFilterState.bu && dockFilterState.marketTeam) {
      const buForTeam = deriveBusinessUnitFromTeam(dockFilterState.marketTeam);
      if (buForTeam && buForTeam !== dockFilterState.bu) {
        dockFilterState.marketTeam = '';
      }
    }
    renderDockBoard();
  });
}

if (dockFilterMarketTeam) {
  dockFilterMarketTeam.addEventListener('change', () => {
    dockFilterState.marketTeam = dockFilterMarketTeam.value;
    renderDockBoard();
  });
}

if (dockFilterAssessment) {
  dockFilterAssessment.addEventListener('change', () => {
    dockFilterState.assessment = dockFilterAssessment.value;
    renderDockBoard();
  });
}

if (dockSearchInput) {
  dockSearchInput.addEventListener('input', () => {
    dockFilterState.search = dockSearchInput.value.trim().toLowerCase();
    renderDockBoard();
  });
}

if (btnManualDeal) {
  btnManualDeal.addEventListener('click', () => {
    if (!confirm('Standardprozess: Deals kommen automatisch aus HubSpot. Nur in Ausnahmefällen manuell anlegen. Fortfahren?')) {
      return;
    }
    clearInputFields();
    initFromState();
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
    pendingDelete = { ids, type: 'batch-entry', fromDock: true };
    document.getElementById('confirmDlgTitle').textContent = 'Deals löschen';
    document.getElementById('confirmDlgText').textContent = `Wollen Sie die ${ids.length} ausgewählten Deals wirklich löschen?`;
    document.getElementById('confirmDlg').showModal();
  });
}

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
    clearInputFields();
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
    requestDockEntryDialogClose();
  } else {
    dialogEl.close();
  }
});

function showView(viewName) {
  if (getIsBatchRunning()) {
      showToast('Bitte warten Sie, bis die aktuelle Verarbeitung abgeschlossen ist.', 'bad');
      return;
  }
  Object.values(views).forEach(v => v.classList.add('hide'));
  navLinks.forEach(l => l.classList.remove('active'));
  hideBatchProgress();
  
  if (views[viewName]) {
    views[viewName].classList.remove('hide');
    const activeLink = document.querySelector(`.nav-link[data-view="${viewName}"]`);
    if (activeLink) activeLink.classList.add('active');
  }
  window.scrollTo(0,0);
}

navLinks.forEach(link => {
  link.addEventListener('click', (e) => {
    e.preventDefault();
    if (getIsBatchRunning()) {
        showToast('Bitte warten Sie, bis die aktuelle Verarbeitung abgeschlossen ist.', 'bad');
        return;
    }
    const viewName = e.target.getAttribute('data-view');
    
    if (viewName === 'fixauftraege') {
      loadHistory().then(() => showView('fixauftraege'));
    } else if (viewName === 'rahmen') {
      loadHistory().then(() => { renderFrameworkContracts(); showView('rahmen'); });
    } else if (viewName === 'analytics') {
      loadHistory().then(() => { initAnalytics(); showView('analytics'); });
    } else if (viewName === 'admin') {
      handleAdminClick();
    } else if (viewName === 'erfassung') {
      const dockView = views.erfassung;
      const dockVisible = dockView && !dockView.classList.contains('hide');
      const manualVisible = dockEntryDialog ? dockEntryDialog.open : false;
      if (getHasUnsavedChanges() && dockVisible && manualVisible) {
        const confirmed = confirm('Ungespeicherte Änderungen gehen verloren. Möchtest du fortfahren?');
        if (!confirmed) return;
      }

      const state = loadState();
      const isEditing = !!state?.editingId;

      if (!isEditing) {
        hideManualPanel();
        clearInputFields();
        initFromState();
      } else {
        showManualPanel();
        initFromState(true);
      }

      loadHistory().then(() => {
        renderDockBoard();
        showView('erfassung');
      });
    }
  });
});

async function handleAdminClick() {
  try {
    showLoader();
    await loadPeople();
    populateAdminTeamOptions();
    renderPeopleAdmin();
    showView('admin');
  } catch (e) {
    console.error('Admin init failed', e);
    showToast('Konnte Admin-Daten nicht laden.', 'bad');
  } finally { 
    hideLoader(); 
  }
}

/* ---------- People ---------- */
const peopleList = document.getElementById('peopleList');
async function loadSession() {
  try {
    // ##### KORREKTUR 1/3 #####
    const response = await fetchWithRetry(`${WORKER_BASE}/session`, { cache: 'no-store' });
    if (!response.ok) {
      if (response.status !== 404) {
        console.warn('Session konnte nicht geladen werden (Status):', response.status);
      }
      currentSession.email = '';
      currentSession.rawName = '';
      currentSession.person = null;
      currentSession.name = '';
      return;
    }
    const data = await response.json();
    currentSession.email = String(data?.email || '').trim();
    currentSession.rawName = String(data?.name || '').trim();
    currentSession.person = data?.person && typeof data.person === 'object' ? data.person : null;

    if (currentSession.person) {
      currentSession.name = String(currentSession.person.name || '').trim() || currentSession.rawName;
    } else {
      currentSession.name = String(data?.displayName || '').trim() || currentSession.rawName;
    }
  } catch (err) {
    console.warn('Session konnte nicht geladen werden:', err);
    currentSession.email = '';
    currentSession.rawName = '';
    currentSession.person = null;
    currentSession.name = '';
  }
  updateRecognizedPersonFromPeople();
}
async function loadPeople(){
  showLoader();
  try{
    // ##### KORREKTUR 2/3 #####
    const r=await fetchWithRetry(`${WORKER_BASE}/people`, { cache: 'no-store' });
    people = r.ok? await r.json(): [];
  }
  catch{ people=[]; showToast('Personenliste konnte nicht geladen werden.', 'bad');}
  finally { hideLoader(); }
  people = Array.isArray(people) ? people.map((person) => {
    const normalized = { ...person };
    if (normalized.email && typeof normalized.email === 'string') {
      normalized.email = normalized.email.trim();
    }
    return normalized;
  }) : [];
  people.sort((a,b)=>{ const lastA=(a.name||'').split(' ').pop(); const lastB=(b.name||'').split(' ').pop(); return lastA.localeCompare(lastB, 'de'); });

  if (peopleList){
    peopleList.innerHTML='';
    people.forEach(p=>{
      const o = document.createElement('option');
      o.value=p.name;
      peopleList.appendChild(o);
    });
  }
  updateRecognizedPersonFromPeople();
}
function findPersonByName(name){ return people.find(p=>p.name && p.name.toLowerCase()===String(name||'').toLowerCase()); }
function findPersonByEmail(email){
  const target = String(email || '').trim().toLowerCase();
  if (!target) return undefined;
  return people.find((person) => String(person?.email || '').trim().toLowerCase() === target);
}

/* ---------- Erfassung ---------- */
const tbody = document.getElementById('tbody');
const sumchips = document.getElementById('sumchips');
const auftraggeber = document.getElementById('auftraggeber');
const projekttitel = document.getElementById('projekttitel');
const auftragswert = document.getElementById('auftragswert');
const auftragswertBekannt = document.getElementById('auftragswertBekannt');
const submittedBy  = document.getElementById('submittedBy');
const projectNumber = document.getElementById('projectNumber');
const kvNummer = document.getElementById('kvNummer');
const freigabedatum = document.getElementById('freigabedatum');
const metaEditSection = document.getElementById('metaEditSection');
const btnMetaEditToggle = document.getElementById('btnMetaEditToggle');
const metaSummary = document.getElementById('metaSummary');
const metaSummaryFields = metaSummary ? {
  projectNumber: metaSummary.querySelector('[data-meta-field="projectNumber"]'),
  kvNummer: metaSummary.querySelector('[data-meta-field="kvNummer"]'),
  freigabedatum: metaSummary.querySelector('[data-meta-field="freigabedatum"]'),
} : null;
let metaQuickEditEnabled = false;
let metaBaseDisabledState = { projectNumber: false, kvNummer: false, freigabedatum: false };
const w_cs = document.getElementById('w_cs');
const w_konzept = document.getElementById('w_konzept');
const w_pitch = document.getElementById('w_pitch');
const w_note = document.getElementById('w_note');
const btnAddRow = document.getElementById('btnAddRow');
const btnSave = document.getElementById('btnSave');

function addRow(focus = false) {
  appendFormRow({
    tbody,
    focus,
    saveCurrentInputState,
    recalc,
    findPersonByName,
  });
}
function totals(rows){ return rows.reduce((a,r)=>{a.cs+=r.cs;a.konzept+=r.konzept;a.pitch+=r.pitch;return a;},{cs:0,konzept:0,pitch:0}); }
function renderChips(t){
  sumchips.innerHTML='';
  [["cs","Consultative Selling"],["konzept","Konzepterstellung"],["pitch","Pitch"]].forEach(([k,label])=>{
    const x=t[k]; const div=document.createElement('div');div.className='chip';
    const dot=document.createElement('span');dot.className='dot';
    const txt=document.createElement('span');txt.innerHTML=`<strong>${label}</strong> &nbsp; ${fmtInt.format(x)} / 100`;
    if(x===0 || x===100) div.classList.add('ok'); else if(x>100) div.classList.add('bad'); else div.classList.add('warn');
    div.appendChild(dot);div.appendChild(txt);sumchips.appendChild(div);
  });
}
function currentWeights(){return[{key:'cs',weight:clamp01(toInt0(w_cs.value))},{key:'konzept',weight:clamp01(toInt0(w_konzept.value))},{key:'pitch',weight:clamp01(toInt0(w_pitch.value))}]}
function updateWeightNote(){const ws=currentWeights();const sum=ws.reduce((a,c)=>a+Number(c.weight||0),0);w_note.textContent=`Summe Gewichte: ${sum} %`;}

function validateInput(forLive = false) {
    const errors = {};
    const st = loadState() || {};
    if (!forLive) {
        if (!auftraggeber.value.trim() && !st.isAbrufMode) errors.auftraggeber = 'Auftraggeber ist erforderlich.';
        if (!projekttitel.value.trim()) errors.projekttitel = st.isAbrufMode ? 'Titel des Abrufs ist erforderlich' : 'Projekttitel ist erforderlich.';
        if (!submittedBy.value) errors.submittedBy = 'Einschätzung von ist erforderlich.';
        
        if (st.isAbrufMode && !kvNummer.value.trim()) {
            errors.kvNummer = 'KV-Nummer ist für Abrufe erforderlich.';
        }

        if (!readRows().some(r => r.cs + r.konzept + r.pitch > 0)) errors.rows = 'Mindestens eine Person mit Punkten erfassen.';
        if (auftragswertBekannt.checked && parseAmountInput(auftragswert.value) <= 0) errors.auftragswert = 'Ein Auftragswert > 0 ist erforderlich.';
    }

    const t = totals(readRows());
    const weights = currentWeights();
    let categoryErrors = [];
    weights.forEach(w => {
        if (forLive) {
            if (t[w.key] > 100) categoryErrors.push(`${CATEGORY_NAMES[w.key]} > 100`);
        } else {
            if (w.weight > 0 && t[w.key] !== 100) {
                categoryErrors.push(`Für ${CATEGORY_NAMES[w.key]} (${w.weight}%) müssen 100 Punkte vergeben werden (aktuell ${t[w.key]}).`);
            }
            if (w.weight === 0 && t[w.key] > 0 && t[w.key] < 100) {
                 categoryErrors.push(`Für ${CATEGORY_NAMES[w.key]} (0%) müssen die Punkte 0 oder 100 sein.`);
            }
        }
    });
    if (categoryErrors.length > 0) errors.categories = categoryErrors.join(' | ');

    const sumW = weights.reduce((a, c) => a + Number(c.weight || 0), 0);
    if (!forLive && sumW !== 100) errors.weights = `Gewichtungs-Summe muss 100 sein (aktuell ${sumW}).`;
    if (forLive && sumW === 0) errors.weights = 'Gewichte dürfen nicht 0 sein für Live-Berechnung.';
    
    return errors;
}

function clearValidation(){
    document.querySelectorAll('.field-error').forEach(el => el.textContent = '');
    document.querySelectorAll('.invalid-field').forEach(el => el.classList.remove('invalid-field'));
}

function displayValidation(errors){
    clearValidation();
    Object.keys(errors).forEach(key => {
        const el = document.querySelector(`[data-validation-for="${key}"]`);
        if (el) el.textContent = errors[key];
        
        const input = document.getElementById(key);
        if(input) input.classList.add('invalid-field');
    });
}

function recalc(){
  const liveErrors = validateInput(true);
  const liveAmount = parseAmountInput(auftragswert.value);
  if (Object.keys(liveErrors).length === 0) {
    const result = compute(readRows(), currentWeights(), liveAmount, true);
    updateLiveResults(result.list);
  } else {
    updateLiveResults([]);
  }
  
  const finalErrors = validateInput(false);
  displayValidation(finalErrors);
  renderChips(totals(readRows()));

  if (Object.keys(finalErrors).length === 0) { 
    btnSave.classList.remove('disabled'); 
    btnSave.removeAttribute('aria-disabled'); 
  } else { 
    btnSave.classList.add('disabled'); 
    btnSave.setAttribute('aria-disabled', 'true'); 
  }
}

function updateLiveResults(resultList) {
  const resultByKey = new Map(resultList.map(item => [item.key, item]));
  document.querySelectorAll('#tbody tr').forEach((tr, index) => {
    const name = tr.querySelector('.name').value.trim();
    const resultEl = tr.querySelector('.live-result');
    const key = name || `_temp_${index}`;
    const resultData = resultByKey.get(key);

    if (resultData && auftragswertBekannt.checked) {
      resultEl.querySelector('.pct').textContent = `${fmtPct.format(resultData.pct)} %`;
      resultEl.querySelector('.money').textContent = `${fmtCurr0.format(resultData.money)}`;
    } else if (resultData) {
      resultEl.querySelector('.pct').textContent = `${fmtPct.format(resultData.pct)} %`;
      resultEl.querySelector('.money').textContent = `- €`;
    }
    else {
      resultEl.querySelector('.pct').textContent = `- %`;
      resultEl.querySelector('.money').textContent = `- €`;
    }
  });
}

function saveCurrentInputState() {
    const stPrev = loadState() || {};
    const currentInput = {
        client: auftraggeber.value.trim(),
        title: projekttitel.value.trim(),
        amount: parseAmountInput(auftragswert.value),
        amountKnown: auftragswertBekannt.checked,
        projectType: document.querySelector('input[name="projectType"]:checked').value,
        rows: readRows(),
        weights: currentWeights(),
        submittedBy: submittedBy.value,
        projectNumber: projectNumber.value.trim(),
        kvNummer: kvNummer.value.trim(),
        freigabedatum: freigabedatum.value || ''
    };
    saveState({ ...stPrev, input: currentInput });
}

function updateMetaSummary() {
    if (!metaSummaryFields) return;
    const pn = projectNumber?.value.trim();
    const kv = kvNummer?.value.trim();
    const dateValue = freigabedatum?.value;
    metaSummaryFields.projectNumber.textContent = pn ? pn : '–';
    metaSummaryFields.kvNummer.textContent = kv ? kv : '–';
    metaSummaryFields.freigabedatum.textContent = dateValue ? formatIsoDateDisplay(dateValue) : '–';
}

function applyMetaDisabledState(forceDisabled = false) {
    if (!projectNumber || !kvNummer || !freigabedatum) return;
    if (forceDisabled) {
        projectNumber.disabled = true;
        kvNummer.disabled = true;
        freigabedatum.disabled = true;
    } else {
        projectNumber.disabled = !!metaBaseDisabledState.projectNumber;
        kvNummer.disabled = !!metaBaseDisabledState.kvNummer;
        freigabedatum.disabled = !!metaBaseDisabledState.freigabedatum;
    }
}

function configureMetaQuickEdit(showQuickEdit, baseDisabled = { projectNumber: true, kvNummer: true, freigabedatum: false }) {
    metaBaseDisabledState = { ...baseDisabled };
    metaQuickEditEnabled = false;
    if (!btnMetaEditToggle || !metaEditSection) {
        applyMetaDisabledState(false);
        return;
    }
    btnMetaEditToggle.classList.toggle('hide', !showQuickEdit);
    btnMetaEditToggle.textContent = 'Bearbeiten';
    btnMetaEditToggle.disabled = false;
    metaEditSection.classList.remove('is-editing');
    metaEditSection.classList.toggle('meta-edit-inline', !showQuickEdit);
    if (showQuickEdit) {
        metaEditSection.classList.add('meta-edit-available');
        applyMetaDisabledState(true);
    } else {
        metaEditSection.classList.remove('meta-edit-available');
        applyMetaDisabledState(false);
    }
    updateMetaSummary();
}

function setMetaQuickEditActive(active) {
    metaQuickEditEnabled = active;
    if (!btnMetaEditToggle || !metaEditSection) {
        applyMetaDisabledState(false);
        return;
    }
    if (active) {
        metaEditSection.classList.add('is-editing');
        btnMetaEditToggle.textContent = 'Speichern';
        applyMetaDisabledState(false);
    } else {
        metaEditSection.classList.remove('is-editing');
        btnMetaEditToggle.textContent = 'Bearbeiten';
        const quickEditAvailable = !btnMetaEditToggle.classList.contains('hide');
        applyMetaDisabledState(quickEditAvailable);
    }
    updateMetaSummary();
}

[auftraggeber, projekttitel, auftragswert, submittedBy, projectNumber, kvNummer, freigabedatum].forEach(el => { el.addEventListener('input', () => { setHasUnsavedChanges(true); saveCurrentInputState(); recalc(); }); });
if (projectNumber) {
    projectNumber.addEventListener('input', updateMetaSummary);
    projectNumber.addEventListener('change', updateMetaSummary);
}
if (kvNummer) {
    kvNummer.addEventListener('input', updateMetaSummary);
    kvNummer.addEventListener('change', updateMetaSummary);
}
if (freigabedatum) {
    freigabedatum.addEventListener('input', updateMetaSummary);
    freigabedatum.addEventListener('change', updateMetaSummary);
}
document.querySelectorAll('input[name="projectType"]').forEach(radio => radio.addEventListener('change', () => { setHasUnsavedChanges(true); saveCurrentInputState(); recalc(); }));
auftragswertBekannt.addEventListener('change', () => {
    auftragswert.disabled = !auftragswertBekannt.checked;
    if(!auftragswertBekannt.checked) auftragswert.value = '';
    setHasUnsavedChanges(true);
    saveCurrentInputState();
    recalc();
});

auftragswert.addEventListener('blur',()=>{
    const raw=parseAmountInput(auftragswert.value);
    auftragswert.value=raw > 0 ? formatAmountInput(raw) : '';
    saveCurrentInputState(); recalc();
});
[w_cs,w_konzept,w_pitch].forEach(el=>el.addEventListener('input',()=>{
    el.value=String(clamp01(toInt0(el.value)));
    setHasUnsavedChanges(true); updateWeightNote(); saveCurrentInputState(); recalc();
}));
btnAddRow.addEventListener('click',()=>addRow(true));

btnSave.addEventListener('click', async () => {
  const errors = validateInput();
  if (Object.keys(errors).length > 0) {
    displayValidation(errors);
    return;
  }
  setHasUnsavedChanges(false);

  const st = loadState(); if(!st?.input) return;

  if (st.isAbrufMode) {
    // Save as a "Hunter" transaction on a framework contract
    await saveHunterAbruf(st);
  } else {
    // Save as a new Fixauftrag or Rahmenvertrag
    await saveNewEntry(st);
  }
});

if (btnMetaEditToggle) {
    btnMetaEditToggle.addEventListener('click', async () => {
        if (!metaQuickEditEnabled) {
            setMetaQuickEditActive(true);
            projectNumber?.focus();
            return;
        }

        const st = loadState() || {};
        const entryId = st.editingId;
        if (!entryId) {
            setMetaQuickEditActive(false);
            return;
        }

        const conflict = findDockKvConflict(kvNummer.value, entryId);
        if (conflict) {
            showToast('Zu dieser KV-Nummer existiert im Dock bereits ein Deal. Bitte prüfen.', 'bad');
            return;
        }

        btnMetaEditToggle.disabled = true;
        showLoader();
        let metaSaveSuccess = false;
        try {
            const payload = {
                projectNumber: projectNumber.value.trim(),
                kv_nummer: kvNummer.value.trim(),
            };
            let dateMs = null;
            if (freigabedatum.value) {
                const parsed = Date.parse(freigabedatum.value);
                if (!Number.isNaN(parsed)) {
                    dateMs = parsed;
                }
            }
            payload.freigabedatum = dateMs != null ? dateMs : null;

            const response = await fetchWithRetry(`${WORKER_BASE}/entries/${encodeURIComponent(entryId)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (!response.ok) {
                throw new Error(await response.text());
            }

            showToast('Metadaten aktualisiert.', 'ok');
            metaSaveSuccess = true;
            if (st.input) {
                st.input.projectNumber = payload.projectNumber;
                st.input.kvNummer = payload.kv_nummer;
                st.input.freigabedatum = freigabedatum.value || '';
                saveState(st);
            }
            queueDockAutoCheck(entryId, { projectNumber: payload.projectNumber, kvNummer: payload.kv_nummer });
            await loadHistory();
            renderHistory();
            renderFrameworkContracts();
        } catch (err) {
            console.error(err);
            showToast('Aktualisierung fehlgeschlagen.', 'bad');
        } finally {
            hideLoader();
            btnMetaEditToggle.disabled = false;
            if (metaSaveSuccess) {
                setMetaQuickEditActive(false);
            }
        }
    });
}

async function saveNewEntry(st) {
  const finalAmount = auftragswertBekannt.checked ? st.input.amount : 0;
  const resultData = compute(st.input.rows, st.input.weights, finalAmount);
  const isComplete=!!(st.input.client && st.input.title && finalAmount > 0 && st.input.rows.some(r=>r.cs+r.konzept+r.pitch>0));
  const date = st.input.freigabedatum ? Date.parse(st.input.freigabedatum) : null;
  const ts = st.editingId ? (st.input.ts || Date.now()) : Date.now(); // Preserve original ts on edit

  const payload={
    source:st.source||'manuell', complete:isComplete, client:st.input.client||'',
    title:st.input.title||'', amount:finalAmount,
    projectType: st.input.projectType || 'fix',
    rows: st.input.rows || [],
    list:resultData.list||[],
    totals:resultData.totals||{}, weights:resultData.effectiveWeights||[], submittedBy:st.input.submittedBy||'',
    projectNumber: st.input.projectNumber || '', kv_nummer: st.input.kvNummer, 
    freigabedatum: Number.isFinite(date) ? date : null,
    ts: ts,
    modified: st.editingId ? Date.now() : undefined, // Only set modified on update
    id:st.editingId||undefined,
    transactions: st.input.projectType === 'rahmen' ? [] : undefined
  };
  if (!st.editingId && payload.kv_nummer) {
    const conflict = findDockKvConflict(payload.kv_nummer, null);
    if (conflict) {
      showToast('Zu dieser KV-Nummer existiert im Dock bereits ein Deal. Bitte prüfen.', 'bad');
      return;
    }
  }
  showLoader();
  try{
    const method = st.editingId ? 'PUT' : 'POST';
    const url = st.editingId ? `${WORKER_BASE}/entries/${encodeURIComponent(st.editingId)}` : `${WORKER_BASE}/entries`;
    const r = await fetchWithRetry(url, {method, headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)});
    if(!r.ok) throw new Error(await r.text());
    let savedEntry = null;
    try {
      savedEntry = await r.json();
    } catch (err) {
      console.warn('Antwort konnte nicht gelesen werden:', err);
    }
    showToast(`Eintrag ${st.editingId?'aktualisiert':'gespeichert'}.`, 'ok');
    hideManualPanel();
    if (savedEntry && savedEntry.id) {
      queueDockAutoCheck(savedEntry.id, {
        entry: savedEntry,
        projectNumber: savedEntry.projectNumber || '',
        kvNummer: savedEntry.kv_nummer || '',
      });
    }
    await loadHistory(true);
    if (payload.projectType === 'rahmen') {
        renderFrameworkContracts();
    }
  }catch(e){ showToast('Speichern fehlgeschlagen.', 'bad'); console.error(e); }
  finally{ hideLoader(); }
}


function loadInputForm(inputData, isEditing = false) {
    const st = loadState() || {};
    const abrufInfo = document.getElementById('abrufInfo');
    const projectTypeWrapper = document.getElementById('projectTypeWrapper');
    
    // Reset all fields first
    auftraggeber.disabled = false;
    const baseDisabled = { projectNumber: true, kvNummer: true, freigabedatum: false };
    let defaultDate = '';
    if (inputData.freigabedatum) {
        defaultDate = formatDateForInput(inputData.freigabedatum);
    } else if (isEditing && inputData.ts) {
        defaultDate = formatDateForInput(inputData.ts);
    }
    if (!defaultDate && !isEditing) {
        defaultDate = getTodayDate();
    }
    freigabedatum.value = defaultDate;

    if (st.isAbrufMode && st.parentEntry) {
        // Hunter Abruf
        if (dockIntroEl) {
            dockIntroEl.textContent = 'Neuen aktiven Abruf erfassen.';
        }
        projectTypeWrapper.classList.add('hide');
        auftraggeber.value = st.parentEntry.client;
        auftraggeber.disabled = true;
        projekttitel.value = inputData.title || '';
        projectNumber.value = inputData.projectNumber || '';
        kvNummer.value = inputData.kvNummer || '';
        kvNummer.placeholder = 'KV-Nummer des Abrufs';
        freigabedatum.value = freigabedatum.value || getTodayDate();
        baseDisabled.projectNumber = true;
        baseDisabled.kvNummer = false;
        baseDisabled.freigabedatum = false;
        configureMetaQuickEdit(false, baseDisabled);

    } else {
        // Neue Erfassung oder Bearbeitung
        if (dockIntroEl) {
            dockIntroEl.textContent = dockIntroDefaultText;
        }
        projectTypeWrapper.classList.remove('hide');
        auftraggeber.value = inputData.client || '';
        projekttitel.value = inputData.title || '';
        projectNumber.value = inputData.projectNumber || '';
        kvNummer.value = inputData.kvNummer || '';

        baseDisabled.projectNumber = !isEditing;
        baseDisabled.kvNummer = !isEditing;
        baseDisabled.freigabedatum = (!isEditing && inputData.projectType === 'rahmen');
        const showQuickEdit = Boolean(isEditing);
        if (!freigabedatum.value && !isEditing) {
            freigabedatum.value = getTodayDate();
        }
        configureMetaQuickEdit(showQuickEdit, baseDisabled);

        projectNumber.placeholder = isEditing ? 'Projektnummer eintragen' : 'Wird später vergeben';
        kvNummer.placeholder = isEditing ? 'KV-Nummer eintragen' : 'Wird später vergeben';
    }

    auftragswertBekannt.checked = inputData.amountKnown !== false;
    auftragswert.disabled = !auftragswertBekannt.checked;
    auftragswert.value = inputData.amount > 0 ? formatAmountInput(inputData.amount) : '';
    submittedBy.value = inputData.submittedBy || '';
    document.querySelector(`input[name="projectType"][value="${inputData.projectType || 'fix'}"]`).checked = true;

    const weights = inputData.weights || [{key:'cs',weight:DEFAULT_WEIGHTS.cs},{key:'konzept',weight:DEFAULT_WEIGHTS.konzept},{key:'pitch',weight:DEFAULT_WEIGHTS.pitch}];
    const m = Object.fromEntries(weights.map(w=>[w.key,w.weight]));
    w_cs.value = String(clamp01(toInt0(m.cs??DEFAULT_WEIGHTS.cs)));
    w_konzept.value = String(clamp01(toInt0(m.konzept??DEFAULT_WEIGHTS.konzept)));
    w_pitch.value = String(clamp01(toInt0(m.pitch??DEFAULT_WEIGHTS.pitch)));
    tbody.innerHTML = '';
    const rows = Array.isArray(inputData.rows) ? inputData.rows : [];
    if(rows.length > 0){
      rows.forEach(r=>{
        const tr = createRowTemplate();
        tbody.appendChild(tr);
        setupRow(tr, { saveCurrentInputState, recalc, findPersonByName });
        const nm=r.name||''; tr.querySelector('.name').value=nm;
        const person=findPersonByName(nm); if(person) tr.querySelector('.name').dataset.personId=person.id;
        tr.querySelector('.cs').value=String(clamp01(toInt0(r.cs||0)));
        tr.querySelector('.konzept').value=String(clamp01(toInt0(r.konzept||0)));
        tr.querySelector('.pitch').value=String(clamp01(toInt0(r.pitch||0)));
      });
    } else { addRow(true); addRow(false); }
    setHasUnsavedChanges(false);
    recalc();
    updateMetaSummary();
}

function clearInputFields() {
    saveState({ source: 'manuell' });
    loadInputForm({}, false);
}

/* ---------- Berechnungslogik ---------- */
function compute(rows, weights, amount, forLive=false){
  const t = totals(rows); 
  const usedKeys = Object.entries(t).filter(([k,v])=>v>0).map(([k])=>k);
  const effWeights = (weights&&weights.length?weights:[{key:'cs',weight:DEFAULT_WEIGHTS.cs},{key:'konzept',weight:DEFAULT_WEIGHTS.konzept},{key:'pitch',weight:DEFAULT_WEIGHTS.pitch}]);
  
  const calcWeights = forLive ? effWeights : normalizeWeightsForUsed(effWeights, usedKeys);
  
  const map=new Map();
  rows.forEach((r, index)=>{
    const act=r.cs+r.konzept+r.pitch>0;
    const key = r.name.trim() || `_temp_${index}`;
    if (!r.name.trim() && !act) return;

    const cur=map.get(key) || { name: r.name, cs:0, konzept:0, pitch:0 };
    cur.cs+=r.cs; cur.konzept+=r.konzept; cur.pitch+=r.pitch;
    map.set(key,cur);
  });
  
  const wIdx = Object.fromEntries(calcWeights.map(w=>[w.key, w.weight / 100])); 
  const list=[];

  for(const [key, p] of map.entries()){
    let pct=0;
    const divCS = forLive ? 100 : (t.cs || 1);
    const divKonzept = forLive ? 100 : (t.konzept || 1);
    const divPitch = forLive ? 100 : (t.pitch || 1);

    if(usedKeys.includes('cs') && t.cs > 0) pct += wIdx.cs * (p.cs / divCS);
    if(usedKeys.includes('konzept') && t.konzept > 0) pct += wIdx.konzept * (p.konzept / divKonzept);
    if(usedKeys.includes('pitch') && t.pitch > 0) pct += wIdx.pitch * (p.pitch / divPitch);
    list.push({ key, name: p.name, pct: pct * 100 });
  }
  
  list.sort((a,b)=>b.pct-a.pct); 
  if(!forLive) {
      const sum=list.reduce((a,x)=>a+x.pct,0),resid=100-sum; 
      if(list.length&&Math.abs(resid)>1e-9) list[0].pct+=resid;
  }
  
  list.forEach(x=>{if(x.pct<0)x.pct=0;});
  const withMoney=list.map(x=>({ ...x, money: Math.round((amount>0?amount:0)*x.pct/100) }));
  return { totals:t, usedKeys, effectiveWeights: calcWeights, list:withMoney };
}

function normalizeWeightsForUsed(allWeights, usedKeys){
  const used=allWeights.filter(w=>usedKeys.includes(w.key)); const sum=used.reduce((a,w)=>a+w.weight,0);
  if(sum<=0) return allWeights.map(w=>({key:w.key,weight:w.weight}));
  const factor=100/sum;
  const out=allWeights.map(w=> usedKeys.includes(w.key)?{key:w.key,weight:w.weight*factor}:{key:w.key,weight:0});
  const rem=100-out.reduce((a,w)=>a+Math.round(w.weight),0); if(rem!==0){const ix=out.findIndex(x=>usedKeys.includes(x.key)); if(ix>=0) out[ix].weight+=rem;}
  return out.map(w=>({key:w.key,weight:Math.round(w.weight)}));
}


/* ---------- Übersicht & Rahmenverträge ---------- */
const historyBody=document.getElementById('historyBody');
const omniSearch = document.getElementById('omniSearch');
const personFilter = document.getElementById('personFilter');
const rahmenSearch = document.getElementById('rahmenSearch');
const btnXlsx=document.getElementById('btnXlsx');
const btnBatchDelete=document.getElementById('btnBatchDelete');
const btnMoveToFramework=document.getElementById('btnMoveToFramework');
const btnMergeFixEntries=document.getElementById('btnMergeFixEntries');
const mergeSuggestions=document.getElementById('mergeSuggestions');
const mergeFixDlg=document.getElementById('mergeFixDlg');
const mergeFixValidation=document.getElementById('mergeFixValidation');
const mergeFixSelectionBody=document.getElementById('mergeFixSelectionBody');
const mergeFixListBody=document.getElementById('mergeFixListBody');
const mergeFixProjectNumber=document.getElementById('mergeFixProjectNumber');
const mergeFixPreview=document.getElementById('mergeFixPreview');
const mergeFixTotal=document.getElementById('mergeFixTotal');
const btnMergeFixCancel=document.getElementById('btnMergeFixCancel');
const btnMergeFixConfirm=document.getElementById('btnMergeFixConfirm');
const checkAllFix=document.getElementById('checkAllFix');
const entries = getEntries();
let pendingDelete = { id: null, type: 'entry' }; // { id, ids?, type: 'entry'|'transaction'|'batch-entry', parentId? }
let currentSort = { key: 'freigabedatum', direction: 'desc' };
let currentMergeContext = null;

async function loadHistory(silent = false){
  if (!silent) {
    showLoader();
  }
  try{
    // ##### KORREKTUR 3/3 #####
    const r = await fetchWithRetry(`${WORKER_BASE}/entries`, { cache: 'no-store' });
    const fetchedEntries = r.ok ? await r.json() : []; // Lade in eine temporäre Variable
    setEntries(fetchedEntries);

  } catch (err) { // Fehlerobjekt fangen für bessere Logs
    console.error("Fehler in loadHistory:", err); // Logge den Fehler
    setEntries([]);
    showToast('Daten konnten nicht geladen werden.', 'bad');
  } finally{
    if (!silent) {
      hideLoader();
    }
  }
  // Stelle sicher, dass renderHistory auch aufgerufen wird, nachdem der Eintrags-Store aktualisiert wurde.
  // setEntries synchronisiert `window.entries` für ältere Module, daher bleibt die Reihenfolge kompatibel.
  renderHistory();
  renderDockBoard();
}
  
function hasPositiveDistribution(list = [], amount = 0){
  if (!Array.isArray(list) || list.length === 0) return { sum: 0, hasPositive: false };
  const amt = Number(amount) || 0;
  let sum = 0;
  let hasPositive = false;
  for (const item of list){
    if (!item || typeof item !== 'object') continue;
    let pct = Number(item.pct);
    if (!Number.isFinite(pct) && amt > 0){
      const money = Number(item.money);
      if (Number.isFinite(money)) pct = (money / amt) * 100;
    }
    if (!Number.isFinite(pct)) pct = 0;
    if (pct < 0) pct = 0;
    if (pct > 0.0001) hasPositive = true;
    sum += pct;
  }
  return { sum, hasPositive };
}

function hasAnyTotals(totals){
  if (!totals || typeof totals !== 'object') return false;
  return ['cs','konzept','pitch'].some(key => (Number(totals[key]) || 0) > 0);
}

function autoComplete(e){
  if (!(e && e.client && e.title && (e.amount > 0))) return false;
  const list = Array.isArray(e.list) ? e.list : [];
  if (!list.length) return false;
  const { sum, hasPositive } = hasPositiveDistribution(list, e.amount);
  if (!hasPositive) return false;
  if (sum < 99.5) return false;
  if (!hasAnyTotals(e.totals)) return false;
  return true;
}
function filtered(type = 'fix'){
  const currentEntries = getEntries();
  let arr = currentEntries.filter(e => (e.projectType || 'fix') === type); // Greift auf den zentralen Eintrags-Store zu
  const query = omniSearch.value.trim().toLowerCase();
  const selectedPerson = personFilter ? personFilter.value : '';

  if (type === 'fix') {
    arr = arr.filter(shouldIncludeInFixList);
  }

  if (selectedPerson) {
    const selectedLower = selectedPerson.toLowerCase();
    arr = arr.filter(e => (e.submittedBy || '').toLowerCase() === selectedLower);
  }

  if (query) {
      const terms = query.split(/\s+/);
      const filters = [];
      const searchTerms = [];

      terms.forEach(term => {
        if (term.includes(':')) {
          const [key, ...value] = term.split(':');
          if (value.length > 0) {
            filters.push({ key, value: value.join(':') });
          }
        } else {
          searchTerms.push(term);
        }
      });

      const searchText = searchTerms.join(' ');
      if (searchText) {
        arr = arr.filter(e => 
          String(e.title || '').toLowerCase().includes(searchText) || 
          String(e.client || '').toLowerCase().includes(searchText)
        );
      }

      filters.forEach(({ key, value }) => {
        if (key === 'status') {
          const wantOk = value.startsWith('v') || value.startsWith('o');
          arr = arr.filter(e => wantOk ? autoComplete(e) : !autoComplete(e));
        }
        if (key === 'quelle' || key === 'source') {
          arr = arr.filter(e => (e.source || '').toLowerCase().startsWith(value));
        }
        if ((key === 'wert' || key === 'amount') && (value.startsWith('>') || value.startsWith('<'))) {
          const num = parseFloat(value.substring(1));
          if (!isNaN(num)) {
            if (value.startsWith('>')) arr = arr.filter(e => (e.amount || 0) > num);
            if (value.startsWith('<')) arr = arr.filter(e => (e.amount || 0) < num);
          }
        }
      });
  }

  arr.sort((a,b) => {
    let valA, valB;
    if (currentSort.key === 'ts') { 
        valA = a.modified || a.ts || 0; 
        valB = b.modified || b.ts || 0; 
    } else if (currentSort.key === 'freigabedatum') {
        valA = a.freigabedatum || a.ts || 0;
        valB = b.freigabedatum || b.ts || 0;
    } else {
        valA = a[currentSort.key] || '';
        valB = b[currentSort.key] || '';
    }
    
    let comparison = 0;
    if (typeof valA === 'string' && typeof valB === 'string') {
      comparison = valA.localeCompare(valB, 'de');
    } else {
      comparison = (valA || 0) - (valB || 0);
    }
    return currentSort.direction === 'asc' ? comparison : -comparison;
  });

  return arr;
}

function shouldIncludeInFixList(entry) {
  if (!entry) return false;
  const source = normalizeDockString(entry.source).toLowerCase();
  if (source === 'hubspot') {
    const phase = getDockPhase(entry);
    if (phase < 4) return false;
    if (entry.dockFinalAssignment && entry.dockFinalAssignment !== 'fix' && entry.dockFinalAssignment !== 'abruf') {
      return false;
    }
  }
  return true;
}

function updatePersonFilterOptions() {
  if (!personFilter) return;

  const currentEntries = getEntries();
  const names = new Map();

  currentEntries
    .filter(e => (e.projectType || 'fix') === 'fix')
    .forEach(e => {
      const name = (e.submittedBy || '').trim();
      if (name && !names.has(name.toLowerCase())) {
        names.set(name.toLowerCase(), name);
      }
    });

  const previousValue = personFilter.value || '';
  const sortedNames = Array.from(names.values()).sort((a, b) => a.localeCompare(b, 'de', { sensitivity: 'base' }));
  const options = ['<option value="">Alle Personen</option>'];
  sortedNames.forEach(name => {
    const escaped = escapeHtml(name);
    options.push(`<option value="${escaped}">${escaped}</option>`);
  });
  personFilter.innerHTML = options.join('');

  if (previousValue) {
    const match = sortedNames.find(name => name.toLowerCase() === previousValue.toLowerCase());
    personFilter.value = match || '';
  } else {
    personFilter.value = '';
  }
}

function renderMergeSuggestions(list) {
  if (!mergeSuggestions) return;

  const groups = new Map();
  (Array.isArray(list) ? list : []).forEach(entry => {
    const projectNumber = (entry.projectNumber || '').trim();
    if (!projectNumber) {
      return;
    }
    if (!groups.has(projectNumber)) {
      groups.set(projectNumber, []);
    }
    groups.get(projectNumber).push(entry);
  });

  const duplicates = Array.from(groups.entries()).filter(([, items]) => items.length >= 2);
  mergeSuggestions.innerHTML = '';

  if (!duplicates.length) {
    mergeSuggestions.classList.add('hide');
    return;
  }

  mergeSuggestions.classList.remove('hide');

  const title = document.createElement('p');
  title.className = 'merge-suggestions-title';
  title.textContent = duplicates.length === 1
    ? 'Hinweis: 1 Projektnummer taucht mehrfach auf. Jetzt zusammenführen?'
    : `Hinweis: ${duplicates.length} Projektnummern tauchen mehrfach auf. Jetzt zusammenführen?`;
  mergeSuggestions.appendChild(title);

  const listEl = document.createElement('div');
  listEl.className = 'merge-suggestions-list';

  const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });
  duplicates.sort((a, b) => collator.compare(a[0], b[0]));

  duplicates.forEach(([projectNumber, items]) => {
    const item = document.createElement('div');
    item.className = 'merge-suggestion-item';

    const textWrap = document.createElement('div');
    textWrap.className = 'merge-suggestion-text';

    const pnEl = document.createElement('strong');
    pnEl.textContent = projectNumber;
    textWrap.appendChild(pnEl);

    const countSpan = document.createElement('span');
    const count = items.length;
    countSpan.textContent = count === 2 ? '2 passende Aufträge' : `${count} passende Aufträge`;
    textWrap.appendChild(countSpan);

    const titles = items.map(e => e.title).filter(Boolean);
    if (titles.length) {
      const detail = document.createElement('span');
      detail.className = 'merge-suggestion-detail';
      const preview = titles.slice(0, 2);
      detail.textContent = preview.join(' · ') + (titles.length > 2 ? ' …' : '');
      textWrap.appendChild(detail);
    }

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn tight';
    btn.textContent = 'Markieren & zusammenführen';
    const ids = items.map(e => e.id);
    btn.addEventListener('click', () => {
      selectFixEntries(ids, true);
    });

    item.appendChild(textWrap);
    item.appendChild(btn);
    listEl.appendChild(item);
  });

  mergeSuggestions.appendChild(listEl);
}

function renderHistory(){
  historyBody.innerHTML='';
  updateSortIcons();
  updatePersonFilterOptions();
  const arr = filtered('fix');
  renderMergeSuggestions(arr);
  let totalSum = 0;

  const groups = {
    complete: [],
    incomplete: []
  };

  for(const e of arr){
    const ok = autoComplete(e);
    totalSum += (e.amount || 0);
    groups[ok ? 'complete' : 'incomplete'].push({ entry: e, ok });
  }

  const createRow = (entry, ok) => {
    const statusIndicator = `<span class="status-indicator ${ok ? 'ok' : 'bad'}" aria-label="${ok ? 'Vollständig' : 'Unvollständig'}" title="${ok ? 'Vollständig' : 'Unvollständig'}">${ok ? '✓' : '!'}</span>`;
    const datum = entry.freigabedatum ? new Date(entry.freigabedatum).toLocaleDateString('de-DE') : (entry.ts ? new Date(entry.ts).toLocaleDateString('de-DE') : '–');
    const safeProjectNumber = escapeHtml(entry.projectNumber || '–');
    const safeTitle = escapeHtml(entry.title || '–');
    const safeClient = escapeHtml(entry.client || '–');
    const safeSource = escapeHtml(entry.source || '–');
    const safeSubmitted = escapeHtml(entry.submittedBy || '–');
    const tr=document.createElement('tr');
    tr.innerHTML=`
      <td class="col-check"><input type="checkbox" class="row-check" data-id="${entry.id}"></td>
      <td>${safeProjectNumber}</td>
      <td><div class="status-wrapper">${statusIndicator}<span>${safeTitle}</span></div></td>
      <td>${safeClient}</td>
      <td>${safeSource}</td>
      <td>${safeSubmitted}</td>
      <td class="col-amount">${entry.amount ? fmtCurr2.format(entry.amount) : '–'}</td>
      <td class="col-date">${datum}</td>
      <td class="cell-actions">
        <button class="iconbtn" data-act="edit" data-id="${entry.id}" title="Bearbeiten"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" stroke="currentColor" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
        <button class="iconbtn" data-act="del" data-id="${entry.id}" title="Löschen"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" stroke="currentColor" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
      </td>`;
    return tr;
  };

  const appendSection = (title, entries, variant = '') => {
    if (!entries.length) return;
    const sectionFragment = document.createDocumentFragment();
    const headerRow = document.createElement('tr');
    headerRow.classList.add('history-section-header');
    const td = document.createElement('td');
    td.colSpan = 9;

    const safeTitle = escapeHtml(title);
    td.innerHTML = `
      <span class="section-tag ${variant}">
        <span class="section-icon" aria-hidden="true">${variant === 'bad' ? '!' : '✓'}</span>
        <span class="section-title">${safeTitle}</span>
        <span class="section-count">${entries.length}</span>
      </span>
    `;
    headerRow.appendChild(td);
    sectionFragment.appendChild(headerRow);

    for (const { entry, ok } of entries) {
      sectionFragment.appendChild(createRow(entry, ok));
    }

    historyBody.appendChild(sectionFragment);
  };

  appendSection('Unvollständig', groups.incomplete, 'bad');
  appendSection('Vollständig', groups.complete, 'ok');

  document.getElementById('fixSumDisplay').innerHTML = `💰 <span>${fmtCurr0.format(totalSum)}</span> (gefilterte Ansicht)`;
  updateBatchButtons();
}
omniSearch.addEventListener('input', renderHistory);
if (personFilter) {
  personFilter.addEventListener('change', renderHistory);
}
rahmenSearch.addEventListener('input', renderFrameworkContracts);

function getSelectedFixIds() {
    return Array.from(document.querySelectorAll('#historyBody .row-check:checked')).map(cb => cb.dataset.id);
}

function selectFixEntries(ids = [], autoOpenMerge = false) {
    const idSet = new Set(Array.isArray(ids) ? ids : []);
    const highlightRows = [];

    document.querySelectorAll('#historyBody tr').forEach(row => row.classList.remove('merge-suggestion-highlight'));

    document.querySelectorAll('#historyBody .row-check').forEach(cb => {
        const shouldSelect = idSet.has(cb.dataset.id);
        cb.checked = shouldSelect;
        if (shouldSelect) {
            const row = cb.closest('tr');
            if (row) {
                highlightRows.push(row);
            }
        }
    });

    updateBatchButtons();

    if (highlightRows.length) {
        highlightRows.forEach(row => row.classList.add('merge-suggestion-highlight'));
        highlightRows[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(() => {
            highlightRows.forEach(row => row.classList.remove('merge-suggestion-highlight'));
        }, 2000);
    }

    if (autoOpenMerge && ids.length >= 2) {
        setTimeout(() => {
            if (!btnMergeFixEntries.classList.contains('hide')) {
                btnMergeFixEntries.click();
            }
        }, 100);
    }
}

function updateBatchButtons() {
    const selectedIds = getSelectedFixIds();
    if (selectedIds.length > 0) {
        btnBatchDelete.classList.remove('hide');
        btnMoveToFramework.classList.remove('hide');
        btnBatchDelete.textContent = `Markierte Löschen (${selectedIds.length})`;
        btnMoveToFramework.textContent = `Zuweisen... (${selectedIds.length})`;
        if (selectedIds.length >= 2) {
            const selectedEntries = entries.filter(e => selectedIds.includes(e.id));
            const projectNumbers = Array.from(new Set(selectedEntries.map(e => (e.projectNumber || '').trim())));
            const hasMismatch = projectNumbers.length > 1;
            btnMergeFixEntries.classList.remove('hide');
            btnMergeFixEntries.textContent = `Aufträge zusammenführen (${selectedIds.length})`;
            btnMergeFixEntries.title = hasMismatch
                ? 'Auswahl enthält unterschiedliche Projektnummern.'
                : '';
        } else {
            btnMergeFixEntries.classList.add('hide');
            btnMergeFixEntries.title = '';
        }
    } else {
        btnBatchDelete.classList.add('hide');
        btnMoveToFramework.classList.add('hide');
        btnMergeFixEntries.classList.add('hide');
        btnMergeFixEntries.title = '';
    }
    checkAllFix.checked = selectedIds.length > 0 && selectedIds.length === document.querySelectorAll('#historyBody .row-check').length;
}

checkAllFix.addEventListener('change', () => {
    document.querySelectorAll('#historyBody .row-check').forEach(cb => {
        cb.checked = checkAllFix.checked;
    });
    updateBatchButtons();
});

historyBody.addEventListener('change', (ev) => {
    if (ev.target.classList.contains('row-check')) {
        updateBatchButtons();
    }
});

btnMergeFixEntries.addEventListener('click', () => {
    const selectedIds = getSelectedFixIds();
    if (selectedIds.length < 2) {
        showToast('Bitte wählen Sie mindestens zwei Aufträge aus.', 'warn');
        return;
    }
    const selectedEntries = entries.filter(e => selectedIds.includes(e.id));
    if (selectedEntries.length < 2) {
        showToast('Die ausgewählten Einträge konnten nicht geladen werden.', 'bad');
        return;
    }
    currentMergeContext = prepareMergeContext(selectedEntries);
    renderMergeDialog(currentMergeContext);
    mergeFixDlg.showModal();
});

btnMergeFixCancel.addEventListener('click', () => {
    mergeFixDlg.close();
    currentMergeContext = null;
});

mergeFixDlg.addEventListener('close', () => {
    currentMergeContext = null;
});

btnMergeFixConfirm.addEventListener('click', async () => {
    if (!currentMergeContext || currentMergeContext.error || !currentMergeContext.mergedEntry || !currentMergeContext.primaryId) {
        return;
    }
    mergeFixDlg.close();
    showLoader();
    try {
        const { primaryId, mergedEntry, deleteIds } = currentMergeContext;
        const putRes = await fetchWithRetry(`${WORKER_BASE}/entries/${encodeURIComponent(primaryId)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(mergedEntry)
        });
        if (!putRes.ok) {
            throw new Error(await putRes.text());
        }

        for (const delId of deleteIds) {
            const delRes = await fetchWithRetry(`${WORKER_BASE}/entries/${encodeURIComponent(delId)}`, { method: 'DELETE' });
            if (!delRes.ok) {
                throw new Error(await delRes.text());
            }
        }

        showToast('Aufträge zusammengeführt.', 'ok');
        await loadHistory();
        renderHistory();
    } catch (err) {
        console.error('Fehler bei der Zusammenführung', err);
        showToast('Zusammenführung fehlgeschlagen.', 'bad');
    } finally {
        hideLoader();
        currentMergeContext = null;
    }
});

function prepareMergeContext(selectedEntries) {
    const sortedEntries = [...selectedEntries].sort((a, b) => {
        const aTs = Number.isFinite(a.freigabedatum) ? a.freigabedatum : (Number.isFinite(a.ts) ? a.ts : 0);
        const bTs = Number.isFinite(b.freigabedatum) ? b.freigabedatum : (Number.isFinite(b.ts) ? b.ts : 0);
        return aTs - bTs;
    });

    const projectNumbers = sortedEntries.map(e => (e.projectNumber || '').trim());
    const uniqueProjectNumbers = Array.from(new Set(projectNumbers));
    const context = {
        selectedEntries: sortedEntries,
        projectNumbers: uniqueProjectNumbers,
        projectNumber: uniqueProjectNumbers[0] || '',
        mismatch: uniqueProjectNumbers.length > 1,
        error: null,
        totalAmount: 0,
        combinedList: [],
        combinedRows: [],
        combinedTotals: { cs: 0, konzept: 0, pitch: 0 },
        combinedWeights: [],
        mergedEntry: null,
        deleteIds: [],
        primaryId: sortedEntries[0]?.id || null,
        kvNumbers: []
    };

    if (context.mismatch) {
        context.error = 'Die ausgewählten Aufträge haben unterschiedliche Projektnummern und können nicht zusammengeführt werden.';
        return context;
    }

    const totalAmount = sortedEntries.reduce((sum, entry) => sum + (Number(entry.amount) || 0), 0);
    context.totalAmount = Number(totalAmount.toFixed(2));

    const listMap = new Map();
    sortedEntries.forEach(entry => {
        (entry.list || []).forEach(item => {
            const key = (item.name || item.key || '').trim() || item.key || item.name || `person_${listMap.size}`;
            const current = listMap.get(key) || { key, name: item.name || item.key || '–', money: 0 };
            current.money += Number(item.money) || 0;
            listMap.set(key, current);
        });
    });

    let combinedList = Array.from(listMap.values()).map(item => {
        const money = Number(item.money.toFixed(2));
        const pct = totalAmount > 0 ? Number(((money / totalAmount) * 100).toFixed(4)) : 0;
        return { key: item.key, name: item.name, money, pct };
    });
    combinedList.sort((a, b) => b.money - a.money);
    if (combinedList.length > 0) {
        const pctSum = combinedList.reduce((sum, item) => sum + item.pct, 0);
        const adjust = Number((100 - pctSum).toFixed(4));
        combinedList[0].pct = Number((combinedList[0].pct + adjust).toFixed(4));
        const moneySum = combinedList.reduce((sum, item) => sum + item.money, 0);
        const moneyAdjust = Number((totalAmount - moneySum).toFixed(2));
        if (moneyAdjust !== 0) {
            combinedList[0].money = Number((combinedList[0].money + moneyAdjust).toFixed(2));
        }
    }

    const rowMap = new Map();
    const fallbackWeightArr = [
        { key: 'cs', weight: DEFAULT_WEIGHTS.cs },
        { key: 'konzept', weight: DEFAULT_WEIGHTS.konzept },
        { key: 'pitch', weight: DEFAULT_WEIGHTS.pitch }
    ];

    sortedEntries.forEach(entry => {
        const entryAmount = Number(entry.amount) || 0;
        const factor = totalAmount > 0
            ? entryAmount / totalAmount
            : (sortedEntries.length > 0 ? 1 / sortedEntries.length : 0);
        const rows = Array.isArray(entry.rows) ? entry.rows : [];
        rows.forEach(row => {
            const key = (row.name || '').trim() || `person_${rowMap.size}`;
            const current = rowMap.get(key) || { name: row.name || '', cs: 0, konzept: 0, pitch: 0 };
            current.cs += (Number(row.cs) || 0) * factor;
            current.konzept += (Number(row.konzept) || 0) * factor;
            current.pitch += (Number(row.pitch) || 0) * factor;
            rowMap.set(key, current);
        });
    });

    let combinedRows = Array.from(rowMap.values()).map(row => ({
        name: row.name,
        cs: Math.max(0, Math.min(100, Number(row.cs.toFixed(2)))),
        konzept: Math.max(0, Math.min(100, Number(row.konzept.toFixed(2)))),
        pitch: Math.max(0, Math.min(100, Number(row.pitch.toFixed(2))))
    })).filter(row => (row.name && (row.cs || row.konzept || row.pitch)));

    if (combinedRows.length === 0 && sortedEntries[0]) {
        combinedRows = Array.isArray(sortedEntries[0].rows)
            ? sortedEntries[0].rows.map(row => ({ ...row }))
            : [];
    }

    const weightTotals = { cs: 0, konzept: 0, pitch: 0 };
    sortedEntries.forEach(entry => {
        const entryAmount = Number(entry.amount) || 0;
        const factor = totalAmount > 0
            ? entryAmount / totalAmount
            : (sortedEntries.length > 0 ? 1 / sortedEntries.length : 0);
        const entryWeights = Array.isArray(entry.weights) && entry.weights.length > 0
            ? entry.weights
            : fallbackWeightArr;
        entryWeights.forEach(w => {
            if (weightTotals[w.key] === undefined) weightTotals[w.key] = 0;
            weightTotals[w.key] += (Number(w.weight) || 0) * factor;
        });
    });

    let combinedWeights = Object.keys(weightTotals).map(key => ({
        key,
        weight: Math.round(weightTotals[key])
    }));

    if (totalAmount <= 0) {
        combinedWeights = Array.isArray(sortedEntries[0]?.weights) && sortedEntries[0].weights.length > 0
            ? sortedEntries[0].weights.map(w => ({ ...w }))
            : fallbackWeightArr.map(w => ({ ...w }));
    } else if (combinedWeights.length > 0) {
        const weightSum = combinedWeights.reduce((sum, w) => sum + w.weight, 0);
        if (weightSum !== 100) {
            combinedWeights[0].weight += (100 - weightSum);
        }
    }

    const primaryClone = sortedEntries[0] ? JSON.parse(JSON.stringify(sortedEntries[0])) : {};
    primaryClone.amount = context.totalAmount;
    primaryClone.list = combinedList.map(item => ({
        key: item.key,
        name: item.name,
        pct: Math.max(0, Math.min(100, Number(item.pct.toFixed(2)))),
        money: Number(item.money.toFixed(2))
    }));
    const pctSumAfter = primaryClone.list.reduce((sum, item) => sum + (Number(item.pct) || 0), 0);
    const pctDiffAfter = Number((100 - pctSumAfter).toFixed(2));
    if (primaryClone.list.length > 0 && pctDiffAfter !== 0) {
        primaryClone.list[0].pct = Math.max(0, Math.min(100, Number((primaryClone.list[0].pct + pctDiffAfter).toFixed(2))));
    }
    const moneySumAfter = primaryClone.list.reduce((sum, item) => sum + (Number(item.money) || 0), 0);
    const moneyDiffAfter = Number((primaryClone.amount - moneySumAfter).toFixed(2));
    if (primaryClone.list.length > 0 && moneyDiffAfter !== 0) {
        primaryClone.list[0].money = Number((primaryClone.list[0].money + moneyDiffAfter).toFixed(2));
    }
    primaryClone.rows = combinedRows.map(row => ({
        name: row.name,
        cs: Number(row.cs),
        konzept: Number(row.konzept),
        pitch: Number(row.pitch)
    }));
    primaryClone.weights = combinedWeights.map(w => ({ key: w.key, weight: Number(w.weight) }));
    primaryClone.totals = totals(primaryClone.rows || []);
    primaryClone.projectNumber = context.projectNumber || '';
    const kvNumbers = Array.from(new Set(sortedEntries.map(e => (e.kv_nummer || '').trim()).filter(Boolean)));
    primaryClone.kv_nummer = kvNumbers.length === 1 ? kvNumbers[0] : '';
    primaryClone.modified = Date.now();
    primaryClone.complete = autoComplete(primaryClone);

    context.combinedList = primaryClone.list;
    context.combinedRows = primaryClone.rows;
    context.combinedTotals = primaryClone.totals;
    context.combinedWeights = primaryClone.weights;
    context.mergedEntry = primaryClone;
    context.kvNumbers = kvNumbers;
    context.deleteIds = sortedEntries.slice(1).map(e => e.id);

    return context;
}

function renderMergeDialog(ctx) {
    mergeFixSelectionBody.innerHTML = '';
    ctx.selectedEntries.forEach(entry => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${entry.id}</td>
            <td>${entry.title || '–'}</td>
            <td>${entry.client || '–'}</td>
            <td>${(entry.projectNumber || '').trim() || '–'}</td>
            <td>${entry.amount ? fmtCurr2.format(entry.amount) : '–'}</td>
        `;
        mergeFixSelectionBody.appendChild(tr);
    });

    const pnLabel = ctx.mismatch
        ? `Projektnummern der Auswahl: ${ctx.projectNumbers.map(p => p || '–').join(', ')}`
        : `Gemeinsame Projektnummer: ${ctx.projectNumber || '–'}`;
    mergeFixProjectNumber.textContent = pnLabel;

    if (ctx.error) {
        mergeFixValidation.textContent = ctx.error;
        mergeFixValidation.classList.remove('hide');
        mergeFixPreview.classList.add('hide');
        btnMergeFixConfirm.classList.add('disabled');
        btnMergeFixConfirm.disabled = true;
    } else {
        mergeFixValidation.textContent = '';
        mergeFixValidation.classList.add('hide');
        mergeFixPreview.classList.remove('hide');
        btnMergeFixConfirm.classList.remove('disabled');
        btnMergeFixConfirm.disabled = false;

        mergeFixTotal.textContent = fmtCurr2.format(ctx.totalAmount || 0);
        mergeFixListBody.innerHTML = '';
        if (!ctx.combinedList || ctx.combinedList.length === 0) {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td colspan="3" style="text-align:center; color: var(--muted);">Keine Verteilungsdaten vorhanden.</td>`;
            mergeFixListBody.appendChild(tr);
        } else {
            ctx.combinedList.forEach(item => {
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td>${item.name || '–'}</td>
                    <td>${fmtPct.format(item.pct || 0)}</td>
                    <td>${fmtCurr2.format(item.money || 0)}</td>
                `;
                mergeFixListBody.appendChild(tr);
            });
        }
    }
}

document.querySelectorAll('#viewFixauftraege th.sortable').forEach(th => {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    if (currentSort.key === key) {
      currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
    } else {
      currentSort.key = key;
      // Default sort direction based on column type
      currentSort.direction = (key === 'title' || key === 'client' || key === 'source' || key === 'projectNumber' || key === 'submittedBy') ? 'asc' : 'desc';
    }
    renderHistory();
  });
});

function updateSortIcons() {
  document.querySelectorAll('#viewFixauftraege th.sortable .sort-icon').forEach(icon => {icon.textContent = ''; icon.style.opacity=0.5;});
  const activeTh = document.querySelector(`#viewFixauftraege th[data-sort="${currentSort.key}"] .sort-icon`);
  if (activeTh) {
    activeTh.textContent = currentSort.direction === 'asc' ? '▲' : '▼';
    activeTh.style.opacity = 1;
  }
}

// PASSWORTFREI: Einzel-Löschung
function handleDeleteClick(id, type = 'entry', parentId = null) {
  // Passwortabfrage entfernt
  pendingDelete = { id, type, parentId };
  document.getElementById('confirmDlgTitle').textContent = `Eintrag löschen`;
  document.getElementById('confirmDlgText').textContent =
    `Wollen Sie den ${type === 'transaction' ? 'Abruf' : 'Eintrag'} wirklich löschen?`;
  document.getElementById('confirmDlg').showModal();
}

// PASSWORTFREI: Batch-Löschung
btnBatchDelete.addEventListener('click', () => {
  const selectedIds = getSelectedFixIds();
  if (selectedIds.length === 0) return;

  // Passwortabfrage entfernt
  pendingDelete = { ids: selectedIds, type: 'batch-entry' };
  document.getElementById('confirmDlgTitle').textContent = `Einträge löschen`;
  document.getElementById('confirmDlgText').textContent =
    `Wollen Sie die ${selectedIds.length} markierten Einträge wirklich löschen?`;
  document.getElementById('confirmDlg').showModal();
});


historyBody.addEventListener('click', async(ev)=>{
  const btn=ev.target.closest('button[data-act]'); if(!btn) return;
  const id=btn.getAttribute('data-id'); const act=btn.getAttribute('data-act');
  if(act==='edit'){
    editEntry(id);
  } else if(act==='del'){ 
    handleDeleteClick(id, 'entry'); 
  }
});

function editEntry(id) {
  const e=entries.find(x=>x.id===id); if(!e) return;
  const st={ source:e.source||'manuell', editingId:e.id,
    input:{ client:e.client||'', title:e.title||'', amount:e.amount||0, amountKnown: e.amount > 0, projectType: e.projectType || 'fix', submittedBy:e.submittedBy||'', projectNumber:e.projectNumber||'', kvNummer: e.kv_nummer || '',
            freigabedatum: formatDateForInput(e.freigabedatum || e.ts), ts: e.ts,
            rows:Array.isArray(e.rows)&&e.rows.length? e.rows : (Array.isArray(e.list)? e.list.map(x=>({name:x.name, cs:0, konzept:0, pitch:0})):[]),
            weights:Array.isArray(e.weights)? e.weights : [{key:'cs',weight:DEFAULT_WEIGHTS.cs},{key:'konzept',weight:DEFAULT_WEIGHTS.konzept},{key:'pitch',weight:DEFAULT_WEIGHTS.pitch}] }};
  saveState(st); initFromState(true);
  showManualPanel(true);
  showView('erfassung');
  showManualPanel();
}

document.getElementById('btnNo').addEventListener('click',()=>document.getElementById('confirmDlg').close());
// *** NEU: btnYes click handler (mit bulk-delete) ***
document.getElementById('btnYes').addEventListener('click',async()=>{
    const { id, ids, type, parentId, fromDock } = pendingDelete;
    document.getElementById('confirmDlg').close();
    
    showLoader();
    try {
        if (type === 'entry') {
            // Einzelnes Löschen (bleibt gleich)
            if (!id) return;
            const r = await fetchWithRetry(`${WORKER_BASE}/entries/${encodeURIComponent(id)}`, { method: 'DELETE' });
            if (!r.ok) throw new Error(await r.text());
            showToast('Eintrag gelöscht.', 'ok');
            removeEntryById(id);
            renderHistory();
            renderFrameworkContracts();

        } else if (type === 'batch-entry') {
            // *** NEU: BULK DELETE LOGIK ***
            if (!ids || ids.length === 0) return;
            hideLoader(); // Hide small loader, show batch progress
            showBatchProgress(`Lösche ${ids.length} Einträge...`, 1); // Nur 1 Schritt

            const r = await fetchWithRetry(`${WORKER_BASE}/entries/bulk-delete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids: ids })
            });
            updateBatchProgress(1, 1); // Schritt 1 von 1 erledigt
            
            if (!r.ok) {
               const errData = await r.json().catch(() => ({ error: "Unbekannter Fehler beim Löschen" }));
               throw new Error(errData.error || `Serverfehler ${r.status}`);
            }
            
            const result = await r.json();
            showToast(`${result.deletedCount || 0} Einträge erfolgreich gelöscht.`, 'ok');
            await loadHistory(); // Lade alle Daten neu
            renderHistory();
            if (fromDock) {
              dockSelection.clear();
              updateDockSelectionUi();
            }
            // *** ENDE NEUE LOGIK ***

        } else if (type === 'transaction') {
            // Transaktion löschen (bleibt gleich)
            if (!id || !parentId) return;
            const entry = findEntryById(parentId);
            if (!entry || !Array.isArray(entry.transactions)) throw new Error('Parent entry or transactions not found');
            const originalTransactions = JSON.parse(JSON.stringify(entry.transactions));
            entry.transactions = entry.transactions.filter(t => t.id !== id);
            entry.modified = Date.now();
            const r = await fetchWithRetry(`${WORKER_BASE}/entries/${encodeURIComponent(parentId)}`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry)
            });
            if (!r.ok) {
              entry.transactions = originalTransactions; // rollback on fail
              throw new Error(await r.text());
            }
            showToast('Abruf gelöscht.', 'ok');
            upsertEntry(entry);
            renderRahmenDetails(parentId);
        }
    } catch (e) {
        showToast('Aktion fehlgeschlagen.', 'bad');
        console.error(e);
    } finally {
        hideLoader();
        hideBatchProgress();
        pendingDelete = { id: null, type: 'entry' };
    }
});


/* Export XLSX */
btnXlsx.addEventListener('click',()=>{
  const arr=filtered('fix').map(e=>({
    Projektnummer: e.projectNumber||'', Titel: e.title||'', Auftraggeber: e.client||'', Quelle: e.source||'',
    Status: autoComplete(e)?'vollständig':'unvollständig', Wert_EUR: e.amount||0,
    Abschlussdatum: e.freigabedatum? new Date(e.freigabedatum).toISOString().split('T')[0] : (e.ts? new Date(e.ts).toISOString().split('T')[0]:'')
  }));
  const ws=XLSX.utils.json_to_sheet(arr);
  const wb=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Fixaufträge");
  XLSX.writeFile(wb, "fixauftraege_export.xlsx");
});

/* Rahmenverträge */
const rahmenBody = document.getElementById('rahmenBody');
let currentFrameworkEntryId = null;
let editingTransactionId = null;

function filteredFrameworks() {
    let arr = entries.filter(e => e.projectType === 'rahmen');
    const query = rahmenSearch.value.trim().toLowerCase();
    if (!query) return arr.sort((a, b) => (b.modified || b.ts) - (a.modified || a.ts));

    return arr.filter(e => {
      if (String(e.title || '').toLowerCase().includes(query)) return true;
      if (String(e.client || '').toLowerCase().includes(query)) return true;
      if ((e.list || []).some(p => String(p.name || '').toLowerCase().includes(query))) return true;

      if (Array.isArray(e.transactions)) {
        for (const trans of e.transactions) {
          if (trans.type === 'hunter') {
            if (String(trans.title || '').toLowerCase().includes(query)) return true;
            if ((trans.list || []).some(p => String(p.name || '').toLowerCase().includes(query))) return true;
          }
        }
      }
      return false;
    }).sort((a, b) => (b.modified || b.ts) - (a.modified || a.ts));
}

function renderFrameworkContracts() {
  rahmenBody.innerHTML = '';
  const rahmenEntries = filteredFrameworks();
  let totalSum = 0;
  for (const e of rahmenEntries) {
    const tr = document.createElement('tr');
    tr.classList.add('clickable');
    tr.dataset.id = e.id;
    const totalValue = (e.transactions || []).reduce((sum, trans) => sum + trans.amount, 0);
    totalSum += totalValue;
    tr.innerHTML = `
      <td>${e.projectNumber || '–'}</td>
      <td>${e.title || '–'}</td>
      <td>${e.client || '–'}</td>
      <td>${fmtCurr2.format(totalValue)}</td>
      <td style="display:flex;gap:8px;align-items:center">
        <button class="btn ok" data-act="founder-plus" data-id="${e.id}" title="Passiver Abruf">+ Founder</button>
        <button class="btn primary" data-act="hunter-plus" data-id="${e.id}" title="Aktiver Abruf">+ Hunter</button>
        <button class="iconbtn" data-act="details" data-id="${e.id}" title="Details anzeigen"><svg xmlns="http://www.w3.org/2000/svg" height="24" viewBox="0 -960 960 960" width="24" fill="currentColor"><path d="M480-320q75 0 127.5-52.5T660-500q0-75-52.5-127.5T480-680q-75 0-127.5 52.5T300-500q0 75 52.5 127.5T480-320Zm0-72q-45 0-76.5-31.5T372-500q0-45 31.5-76.5T480-608q45 0 76.5 31.5T588-500q0 45-31.5 76.5T480-392Zm0 192q-146 0-266-81.5T40-500q54-137 174-218.5T480-800q146 0 266 81.5T920-500q-54 137-174 218.5T480-200Zm0-300Zm0 220q113 0 207.5-59.5T832-500q-50-101-144.5-160.5T480-720q-113 0-207.5 59.5T128-500q50 101 144.5 160.5T480-280Z"/></svg></button>
        <button class="iconbtn" data-act="del" data-id="${e.id}" title="Löschen"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18m-2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
      </td>
    `;
    rahmenBody.appendChild(tr);
  }
  document.getElementById('rahmenSumDisplay').innerHTML = `💰 <span>${fmtCurr0.format(totalSum)}</span> (Summe aller Abrufe)`;
}

rahmenBody.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (btn) {
    e.stopPropagation(); // Stop click from bubbling to the row
    const act = btn.dataset.act;
    const id = btn.dataset.id;
    const entry = entries.find(en => en.id === id);
    if (!entry) return;
    
    if (act === 'founder-plus') {
      openEditTransactionModal({type:'founder'}, entry);
    } else if (act === 'hunter-plus') {
      saveState({ source: 'manuell', isAbrufMode: true, parentEntry: entry, input:{ projectNumber: entry.projectNumber || '', freigabedatum: getTodayDate() } });
      initFromState();
      showView('erfassung');
    } else if (act === 'details') {
      renderRahmenDetails(id);
      showView('rahmenDetails');
    } else if (act === 'del') {
      handleDeleteClick(id, 'entry');
    }
    return;
  }

  const row = e.target.closest('tr.clickable');
  if (row) {
    const id = row.dataset.id;
    const entry = entries.find(en => en.id === id);
    if (entry) openEditFrameworkContractModal(entry);
  }
});


async function saveHunterAbruf(st) {
    const parentEntry = entries.find(e => e.id === st.parentEntry.id);
    if (!parentEntry) { return showToast('Rahmenvertrag nicht gefunden.', 'bad'); }
    
    const abrufAmount = auftragswertBekannt.checked ? st.input.amount : 0;
    const resultData = compute(st.input.rows, st.input.weights, abrufAmount * (1 - (FOUNDER_SHARE_PCT / 100)));

    if (!Array.isArray(parentEntry.transactions)) { parentEntry.transactions = []; }
    let date = null;
    const rawDate = st.input.freigabedatum;
    if (rawDate) {
        const parsed = Date.parse(rawDate);
        if (Number.isFinite(parsed)) {
            date = parsed;
        }
    }

    const newTransaction = {
        id: `trans_${Date.now()}_${st.input.kvNummer.replace(/\s/g,'')}`,
        kv_nummer: st.input.kvNummer,
        type: 'hunter',
        title: st.input.title, 
        amount: abrufAmount, 
        ts: Date.now(),
        freigabedatum: date,
        submittedBy: st.input.submittedBy, 
        rows: st.input.rows, 
        list: resultData.list, 
        weights: resultData.effectiveWeights
    };
    
    parentEntry.transactions.push(newTransaction);
    parentEntry.modified = Date.now();

    showLoader();
    try {
        const r = await fetchWithRetry(`${WORKER_BASE}/entries/${encodeURIComponent(parentEntry.id)}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parentEntry)
        });
    if (!r.ok) throw new Error(await r.text());
    showToast(`Aktiver Abruf hinzugefügt`, 'ok');
    clearInputFields();
    await loadHistory();
    renderFrameworkContracts();
    const assignmentId = st.dockAssignmentId || pendingDockAbrufAssignment?.entry?.id;
    if (assignmentId) {
      await finalizeDockAbruf(assignmentId);
    }
    showView('rahmen');
    } catch (e) {
        showToast('Speichern des Abrufs fehlgeschlagen.', 'bad');
        console.error(e);
    } finally {
        hideLoader();
    }
}

/* Rahmenvertrag Details */
const rahmenTransaktionenBody = document.getElementById('rahmenTransaktionenBody');
const rahmenActualBody = document.getElementById('rahmenActualBody');
document.getElementById('backToRahmen').addEventListener('click', () => showView('rahmen'));

function calculateActualDistribution(entry, startDate = 0, endDate = Infinity) {
    const personTotals = new Map();
    const transactions = (entry.transactions || []).filter(t => {
        const d = t.freigabedatum || t.ts || 0;
        // Make sure start and end are valid numbers
        const validStart = Number.isFinite(startDate) ? startDate : 0;
        const validEnd = Number.isFinite(endDate) ? endDate : Infinity;
        return d >= validStart && d <= validEnd;
    });
    let totalVolume = 0;

    transactions.forEach(trans => {
        totalVolume += trans.amount;
        if (trans.type === 'founder') {
            (entry.list || []).forEach(founder => {
                const money = trans.amount * (founder.pct / 100);
                personTotals.set(founder.name, (personTotals.get(founder.name) || 0) + money);
            });
        } else if (trans.type === 'hunter') {
            const founderShareAmount = trans.amount * (FOUNDER_SHARE_PCT / 100);
            (entry.list || []).forEach(founder => {
                const money = founderShareAmount * (founder.pct / 100);
                personTotals.set(founder.name, (personTotals.get(founder.name) || 0) + money);
            });
            (trans.list || []).forEach(hunter => {
                personTotals.set(hunter.name, (personTotals.get(hunter.name) || 0) + hunter.money);
            });
        }
    });
    
    if (totalVolume === 0) return { list: [], total: 0 };
    
    const list = Array.from(personTotals, ([name, money]) => ({
        name,
        money,
        pct: (money / totalVolume) * 100
    })).sort((a, b) => b.money - a.money);
    
    return { list, total: totalVolume };
}

function renderRahmenDetails(id) {
    const entry = entries.find(e => e.id === id);
    if (!entry) return;
    currentFrameworkEntryId = id;

    document.getElementById('rahmenDetailsTitle').textContent = entry.title;
    
    const { list: actualDistribution, total: totalValue } = calculateActualDistribution(entry); // Calculate total based on ALL transactions
    document.getElementById('rahmenDetailsSub').textContent = `${entry.client} | ${entry.projectNumber || ''} | Gesamtwert: ${fmtCurr0.format(totalValue)}`;
    
    const foundersBody = document.getElementById('rahmenFoundersBody');
    foundersBody.innerHTML = '';
    (entry.list || []).forEach(founder => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${founder.name}</td><td>${fmtPct.format(founder.pct)} %</td>`;
        foundersBody.appendChild(tr);
    });
    
    rahmenActualBody.innerHTML = '';
    actualDistribution.forEach(person => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${person.name}</td><td>${fmtPct.format(person.pct)} %</td><td>${fmtCurr0.format(person.money)}</td>`;
        rahmenActualBody.appendChild(tr);
    });

    rahmenTransaktionenBody.innerHTML = '';
    (entry.transactions || []).sort((a,b) => (b.freigabedatum || b.ts) - (a.freigabedatum || a.ts)).forEach(trans => {
        const tr = document.createElement('tr');
        tr.classList.add('clickable');
        tr.dataset.transId = trans.id;
        const datum = trans.freigabedatum ? new Date(trans.freigabedatum).toLocaleDateString('de-DE') : (trans.ts ? new Date(trans.ts).toLocaleDateString('de-DE') : '–');
        tr.innerHTML = `
            <td>${trans.kv_nummer || '–'}</td>
            <td>${trans.type === 'founder' ? 'Passiv' : 'Aktiv'}</td>
            <td>${trans.title || '–'}</td>
            <td>${fmtCurr2.format(trans.amount)}</td>
            <td>${datum}</td>
            <td style="display:flex;gap:8px;align-items:center">
                <button class="iconbtn" data-act="del-trans" data-id="${trans.id}" title="Löschen"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" stroke="currentColor" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
            </td>
        `;
        rahmenTransaktionenBody.appendChild(tr);
    });
}

rahmenTransaktionenBody.addEventListener('click', (ev) => {
    const row = ev.target.closest('tr.clickable');
    const delBtn = ev.target.closest('button[data-act="del-trans"]');
    
    if (delBtn) {
        ev.stopPropagation();
        const transId = delBtn.dataset.id;
        handleDeleteClick(transId, 'transaction', currentFrameworkEntryId);
        return;
    }

    if (row) {
        const transId = row.dataset.transId;
        const parentEntry = entries.find(e => e.id === currentFrameworkEntryId);
        if (!parentEntry) return;
        const transaction = (parentEntry.transactions || []).find(t => t.id === transId);
        if (!transaction) return;
        openEditTransactionModal(transaction, parentEntry);
    }
});

/* ---------- Move Fix-Order Modal ---------- */
const moveToFrameworkDlg = document.getElementById('moveToFrameworkDlg');
const moveValidationSummary = document.getElementById('moveValidationSummary');
const moveTargetFramework = document.getElementById('moveTargetFramework');

btnMoveToFramework.addEventListener('click', () => {
    const selectedIds = getSelectedFixIds();
    if (selectedIds.length === 0) return;

    moveValidationSummary.textContent = '';
    document.getElementById('moveDlgCountLabel').textContent = `Sie sind dabei, ${selectedIds.length} Auftrag/Aufträge zuzuweisen.`;
    
    const rahmenEntries = entries.filter(e => e.projectType === 'rahmen').sort((a,b) => a.title.localeCompare(b.title));
    moveTargetFramework.innerHTML = '<option value="">-- Bitte Rahmenvertrag wählen --</option>';
    rahmenEntries.forEach(e => {
        const opt = document.createElement('option');
        opt.value = e.id;
        opt.textContent = `${e.title} (${e.client})`;
        moveTargetFramework.appendChild(opt);
    });
    
    moveToFrameworkDlg.showModal();
});

document.getElementById('btnConfirmMove').addEventListener('click', async () => {
    const selectedIds = getSelectedFixIds();
    const targetFrameworkId = moveTargetFramework.value;
    const moveType = document.querySelector('input[name="moveType"]:checked').value;
    
    moveValidationSummary.textContent = '';
    if (!targetFrameworkId) {
        moveValidationSummary.textContent = 'Bitte einen Ziel-Rahmenvertrag auswählen.';
        return;
    }
    
    const targetFramework = entries.find(e => e.id === targetFrameworkId);
    if (!targetFramework) {
        moveValidationSummary.textContent = 'Ziel-Rahmenvertrag nicht gefunden.';
        return;
    }

    const fixEntriesToMove = entries.filter(e => selectedIds.includes(e.id));
    
    // Pre-check for Hunter type
    if (moveType === 'hunter') {
        const incompleteEntries = fixEntriesToMove.filter(e => !autoComplete(e));
        if (incompleteEntries.length > 0) {
            moveValidationSummary.innerHTML = `<b>Fehler:</b> Für "Aktive Abrufe" müssen alle Einträge vollständig sein (Status "ok").<br>Folgende Einträge sind unvollständig: ${incompleteEntries.map(e => e.title).join(', ')}. <br>Bitte bearbeiten Sie diese Einträge zuerst.`;
            return;
        }
    }
    
    moveToFrameworkDlg.close();
    showBatchProgress(`Verschiebe Aufträge...`, selectedIds.length);
    
    let count = 0;
    try {
        for (const entry of fixEntriesToMove) {
            count++;
            updateBatchProgress(count, selectedIds.length);
            
            // 1. Create new transaction
            let newTransaction;
            if (moveType === 'founder') {
                newTransaction = {
                    id: `trans_${Date.now()}_${entry.kv_nummer.replace(/\W/g, '')}`,
                    kv_nummer: entry.kv_nummer,
                    type: 'founder',
                    amount: entry.amount,
                    ts: Date.now(),
                    freigabedatum: entry.freigabedatum || entry.ts
                };
            } else { // hunter
                // Create a clean copy for the transaction, removing framework-specific fields if they exist
                const { id, projectType, transactions, ...restOfEntry } = entry;
                newTransaction = {
                    ...restOfEntry, // copy relevant data
                    id: `trans_${Date.now()}_${entry.kv_nummer.replace(/\W/g, '')}`,
                    type: 'hunter',
                    ts: Date.now() // new internal timestamp
                    // freigabedatum is already part of 'restOfEntry'
                };
            }
            
             // Ensure targetFramework.transactions exists and is an array
            if (!Array.isArray(targetFramework.transactions)) {
                targetFramework.transactions = [];
            }
            targetFramework.transactions.push(newTransaction);
            targetFramework.modified = Date.now();
            
            // 2. Save target framework
            const rPut = await fetchWithRetry(`${WORKER_BASE}/entries/${encodeURIComponent(targetFramework.id)}`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(targetFramework)
            });
            if (!rPut.ok) throw new Error(`Fehler beim Speichern von Rahmenvertrag ${targetFramework.id}: ${await rPut.text()}`);
            
            // 3. Delete original fix order
            const rDel = await fetchWithRetry(`${WORKER_BASE}/entries/${encodeURIComponent(entry.id)}`, { method: 'DELETE' });
            if (!rDel.ok) throw new Error(`Fehler beim Löschen von Fixauftrag ${entry.id}: ${await rDel.text()}`);

            await throttle();
        }
        
        showToast(`${count} Einträge erfolgreich verschoben.`, 'ok');
    } catch (e) {
        showToast(`Fehler nach ${count} Einträgen: ${e.message}`, 'bad');
        console.error(e);
    } finally {
        hideBatchProgress();
        await loadHistory(); // Reload all data
        renderHistory();
        renderFrameworkContracts();
    }
});


/* ---------- Edit Modals ---------- */
const editTransactionDlg = document.getElementById('editTransactionDlg');
const editFounderTransView = document.getElementById('editFounderTransView');
const editHunterTransView = document.getElementById('editHunterTransView');
const editTransDlgTitle = document.getElementById('editTransDlgTitle');
const editFounderValueInput = document.getElementById('editFounderValueInput');
const editFounderKvNummer = document.getElementById('editFounderKvNummer');
const editFounderFreigabedatum = document.getElementById('editFounderFreigabedatum');
const editHunterTitle = document.getElementById('editHunterTitle');
const editHunterAmount = document.getElementById('editHunterAmount');
const editHunterKvNummer = document.getElementById('editHunterKvNummer');
const editHunterFreigabedatum = document.getElementById('editHunterFreigabedatum');
const editW_cs = document.getElementById('editW_cs');
const editW_konzept = document.getElementById('editW_konzept');
const editW_pitch = document.getElementById('editW_pitch');
const editTbody = document.getElementById('editTbody');
const editFrameworkContractDlg = document.getElementById('editFrameworkContractDlg');

function openEditTransactionModal(transaction, parentEntry) {
    currentFrameworkEntryId = parentEntry.id;
    editingTransactionId = transaction.id || null; // null for new founder transaction
    
    document.getElementById('editTransValidationSummary').textContent = '';
    
    if (transaction.type === 'founder') {
        editTransDlgTitle.textContent = editingTransactionId ? "Passiven Abruf bearbeiten" : "Passiven Abruf hinzufügen";
        editFounderValueInput.value = editingTransactionId ? formatAmountInput(transaction.amount) : '';
        editFounderKvNummer.value = editingTransactionId ? transaction.kv_nummer : '';
        const founderDateSource = transaction.freigabedatum ?? (editingTransactionId ? null : (transaction.ts || Date.now()));
        editFounderFreigabedatum.value = founderDateSource ? formatDateForInput(founderDateSource) : '';
        editFounderTransView.classList.remove('hide');
        editHunterTransView.classList.add('hide');
    } else { // hunter
        editTransDlgTitle.textContent = "Aktiven Abruf bearbeiten";
        editHunterTitle.value = transaction.title || '';
        editHunterAmount.value = formatAmountInput(transaction.amount);
        editHunterKvNummer.value = transaction.kv_nummer || '';
        const hunterDateSource = transaction.freigabedatum ?? (editingTransactionId ? null : (transaction.ts || Date.now()));
        editHunterFreigabedatum.value = hunterDateSource ? formatDateForInput(hunterDateSource) : '';
        
        const weights = transaction.weights || [{key:'cs',weight:DEFAULT_WEIGHTS.cs},{key:'konzept',weight:DEFAULT_WEIGHTS.konzept},{key:'pitch',weight:DEFAULT_WEIGHTS.pitch}];
        const m = Object.fromEntries(weights.map(w=>[w.key,w.weight]));
        editW_cs.value = m.cs ?? DEFAULT_WEIGHTS.cs;
        editW_konzept.value = m.konzept ?? DEFAULT_WEIGHTS.konzept;
        editW_pitch.value = m.pitch ?? DEFAULT_WEIGHTS.pitch;
        
        editTbody.innerHTML = '';
        (transaction.rows || []).forEach(r => addEditRow(r, '#editTbody'));

        editHunterTransView.classList.remove('hide');
        editFounderTransView.classList.add('hide');
    }
    editTransactionDlg.showModal();
}

function addEditRow(rowData = {}, tbodySelector) {
    const tbodyEl = document.querySelector(tbodySelector);
    if (!tbodyEl) return;
    const tr = document.createElement('tr');
    tr.innerHTML = `
        <td><input type="text" class="name" value="${rowData.name || ''}" list="peopleList"></td>
        <td><input type="number" class="cs" value="${rowData.cs || 0}"></td>
        <td><input type="number" class="konzept" value="${rowData.konzept || 0}"></td>
        <td><input type="number" class="pitch" value="${rowData.pitch || 0}"></td>
        <td><button class="delrow">X</button></td>
    `;
    tr.querySelector('.delrow').addEventListener('click', () => tr.remove());
    tbodyEl.appendChild(tr);
}
document.getElementById('editBtnAddRow').addEventListener('click', () => addEditRow({}, '#editTbody'));

document.getElementById('btnSaveTransaction').addEventListener('click', async () => {
    const parentEntry = entries.find(e => e.id === currentFrameworkEntryId);
    if (!parentEntry) return;

    const transIndex = editingTransactionId ? parentEntry.transactions.findIndex(t => t.id === editingTransactionId) : -1;
    
    let transaction = (transIndex > -1) ? JSON.parse(JSON.stringify(parentEntry.transactions[transIndex])) : {}; // Deep copy to avoid modifying original on error
    let validationError = '';

    if (!editHunterTransView.classList.contains('hide')) { // Saving a Hunter transaction
        const rows = readRows('#editTbody');
        const weights = [
            {key:'cs', weight: toInt0(editW_cs.value)},
            {key:'konzept', weight: toInt0(editW_konzept.value)},
            {key:'pitch', weight: toInt0(editW_pitch.value)}
        ];
        
        const errors = validateModalInput(rows, weights);
        if (Object.keys(errors).length > 0) {
            document.getElementById('editTransValidationSummary').innerHTML = Object.values(errors).join('<br>');
            return;
        }
        const amount = parseAmountInput(editHunterAmount.value);
        const hunterShareAmount = amount * (1 - (FOUNDER_SHARE_PCT / 100));
        const resultData = compute(rows, weights, hunterShareAmount);
        const hunterDate = editHunterFreigabedatum.value ? Date.parse(editHunterFreigabedatum.value) : null;

        transaction = {
            ...transaction,
            title: editHunterTitle.value.trim(),
            amount,
            rows,
            weights,
            list: resultData.list,
            kv_nummer: editHunterKvNummer.value.trim(),
            freigabedatum: Number.isFinite(hunterDate) ? hunterDate : null
        };

    } else { // Saving a Founder transaction
        if(!editFounderKvNummer.value) validationError = 'KV-Nummer ist erforderlich.';
        const founderDate = editFounderFreigabedatum.value ? Date.parse(editFounderFreigabedatum.value) : null;

        transaction.amount = parseAmountInput(editFounderValueInput.value);
        transaction.kv_nummer = editFounderKvNummer.value.trim();
        transaction.freigabedatum = Number.isFinite(founderDate) ? founderDate : null;
    }
    
    if (validationError) {
        document.getElementById('editTransValidationSummary').innerHTML = validationError;
        return;
    }
    
    if (transIndex === -1) { // New founder transaction
        transaction.id = `trans_${Date.now()}_${transaction.kv_nummer.replace(/\s/g,'')}`;
        transaction.ts = Date.now();
        transaction.type = 'founder';
        if (!Array.isArray(parentEntry.transactions)) parentEntry.transactions = []; // Ensure array exists
        parentEntry.transactions.push(transaction);
    } else {
        parentEntry.transactions[transIndex] = transaction;
    }
    
    parentEntry.modified = Date.now();
    showLoader();
    try {
        const r = await fetchWithRetry(`${WORKER_BASE}/entries/${encodeURIComponent(parentEntry.id)}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parentEntry)
        });
        if (!r.ok) throw new Error(await r.text());
        showToast('Abruf aktualisiert', 'ok');
        editTransactionDlg.close();
        await loadHistory();
        renderRahmenDetails(currentFrameworkEntryId);
        renderFrameworkContracts(); // Update list view sum
        if (pendingDockAbrufAssignment?.mode === 'founder' && pendingDockAbrufAssignment.entry?.id) {
          await finalizeDockAbruf(pendingDockAbrufAssignment.entry.id);
        }
    } catch (e) {
        showToast('Update fehlgeschlagen', 'bad'); console.error(e);
    } finally {
        hideLoader();
    }
});

const editFwClient = document.getElementById('editFwClient');
const editFwTitle = document.getElementById('editFwTitle');
const editFwProjectNumber = document.getElementById('editFwProjectNumber');
const editFwTbody = document.getElementById('editFwTbody');
const editFwW_cs = document.getElementById('editFwW_cs');
const editFwW_konzept = document.getElementById('editFwW_konzept');
const editFwW_pitch = document.getElementById('editFwW_pitch');
document.getElementById('editFwBtnAddRow').addEventListener('click', () => addEditRow({}, '#editFwTbody'));

function openEditFrameworkContractModal(entry) {
    currentFrameworkEntryId = entry.id;
    document.getElementById('editFwValidationSummary').textContent = '';
    editFwClient.value = entry.client || '';
    editFwTitle.value = entry.title || '';
    editFwProjectNumber.value = entry.projectNumber || '';

    const weights = entry.weights || [{key:'cs',weight:DEFAULT_WEIGHTS.cs},{key:'konzept',weight:DEFAULT_WEIGHTS.konzept},{key:'pitch',weight:DEFAULT_WEIGHTS.pitch}];
    const m = Object.fromEntries(weights.map(w=>[w.key,w.weight]));
    editFwW_cs.value = m.cs ?? DEFAULT_WEIGHTS.cs;
    editFwW_konzept.value = m.konzept ?? DEFAULT_WEIGHTS.konzept;
    editFwW_pitch.value = m.pitch ?? DEFAULT_WEIGHTS.pitch;

    editFwTbody.innerHTML = '';
    (entry.rows || []).forEach(r => addEditRow(r, '#editFwTbody'));
    editFrameworkContractDlg.showModal();
}

document.getElementById('btnSaveFrameworkContract').addEventListener('click', async () => {
    const entry = entries.find(e => e.id === currentFrameworkEntryId);
    if (!entry) return;

    const rows = readRows('#editFwTbody');
    const weights = [
        {key:'cs', weight: toInt0(editFwW_cs.value)},
        {key:'konzept', weight: toInt0(editFwW_konzept.value)},
        {key:'pitch', weight: toInt0(editFwW_pitch.value)}
    ];

    const errors = validateModalInput(rows, weights);
     if (rows.length === 0 || rows.every(r => r.name === '' && r.cs === 0 && r.konzept === 0 && r.pitch === 0)) {
        errors.rows = 'Mindestens eine Person muss dem Gründer-Team zugewiesen sein.';
    }
    if (Object.keys(errors).length > 0) {
        document.getElementById('editFwValidationSummary').innerHTML = Object.values(errors).join('<br>');
        return;
    }
    
    // Recalculate founder list based on new rows/weights (amount doesn't matter here)
    const resultData = compute(rows, weights, 100); // Amount 100 to get percentages

    entry.client = editFwClient.value.trim();
    entry.title = editFwTitle.value.trim();
    entry.projectNumber = editFwProjectNumber.value.trim();
    entry.rows = rows; // Save the raw input rows
    entry.weights = resultData.effectiveWeights; // Save the potentially normalized weights
    entry.list = resultData.list.map(({key, name, pct}) => ({key, name, pct})); // Save only pct, not money
    entry.modified = Date.now();

    showLoader();
    try {
        const r = await fetchWithRetry(`${WORKER_BASE}/entries/${encodeURIComponent(entry.id)}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry)
        });
        if (!r.ok) throw new Error(await r.text());
        showToast('Rahmenvertrag aktualisiert', 'ok');
        editFrameworkContractDlg.close();
        loadHistory().then(() => { // Reload data
            renderFrameworkContracts();
            if(document.getElementById('viewRahmenDetails').classList.contains('hide') === false) {
                 renderRahmenDetails(currentFrameworkEntryId); // Update details if visible
            }
        });
    } catch (e) {
        showToast('Update fehlgeschlagen', 'bad'); console.error(e);
    } finally {
        hideLoader();
    }
});

function validateModalInput(rows, weights) {
    const errors = {};
    const t = totals(rows);
    let categoryErrors = [];
    weights.forEach(w => {
        if (w.weight > 0 && t[w.key] !== 100) {
            categoryErrors.push(`Für ${CATEGORY_NAMES[w.key]} (${w.weight}%) müssen 100 Punkte vergeben werden (aktuell ${t[w.key]}).`);
        }
         if (w.weight === 0 && t[w.key] > 0 && t[w.key] < 100) {
             categoryErrors.push(`Für ${CATEGORY_NAMES[w.key]} (0%) müssen die Punkte 0 oder 100 sein.`);
        }
    });
    if (categoryErrors.length > 0) errors.categories = categoryErrors.join(' | ');

    const sumW = weights.reduce((a, c) => a + Number(c.weight || 0), 0);
    if (sumW !== 100) errors.weights = `Gewichtungs-Summe muss 100 sein (aktuell ${sumW}).`;
    
    return errors;
}

/* ---------- Admin ---------- */
const admName=document.getElementById('adm_name'), admTeam=document.getElementById('adm_team'), admBody=document.getElementById('adm_body'), adminSearch=document.getElementById('adminSearch');

function populateAdminTeamOptions() {
  if (!admTeam) return;
  const previousValue = admTeam.value;
  const placeholderText = admTeam.getAttribute('data-placeholder') || '— bitte wählen —';
  const fragment = document.createDocumentFragment();

  const placeholderOption = document.createElement('option');
  placeholderOption.value = '';
  placeholderOption.textContent = placeholderText;
  fragment.appendChild(placeholderOption);

  (TEAMS || []).forEach((teamName) => {
    const option = document.createElement('option');
    option.value = teamName;
    option.textContent = teamName;
    fragment.appendChild(option);
  });

  admTeam.innerHTML = '';
  admTeam.appendChild(fragment);

  if (previousValue && (TEAMS || []).includes(previousValue)) {
    admTeam.value = previousValue;
  } else {
    admTeam.value = '';
  }
}

document.getElementById('adm_add').onclick = () => adminCreate();
admName.addEventListener('keydown',(e)=>{ if(e.key==='Enter') adminCreate(); });
adminSearch.addEventListener('input', renderPeopleAdmin);

function renderPeopleAdmin(){
  admBody.innerHTML='';
  const query = adminSearch.value.toLowerCase();
  const filteredPeople = people.filter(p => {
    const nameMatch = (p.name || '').toLowerCase().includes(query);
    const teamMatch = (p.team || '').toLowerCase().includes(query);
    return nameMatch || teamMatch;
  });

  filteredPeople.forEach(p=>{
    const tr=document.createElement('tr');
    const safeName = escapeHtml(p.name || '');
    tr.innerHTML=`
      <td><input type="text" value="${safeName}"></td>
      <td><select>${TEAMS.map(t=>`<option value="${escapeHtml(t)}" ${p.team===t?'selected':''}>${escapeHtml(t)}</option>`).join('')}</select></td>
      <td style="display:flex;gap:8px">
        <button class="iconbtn" data-act="save" data-id="${p.id}" title="Speichern"><svg viewBox="0 0 24 24" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg></button>
        <button class="iconbtn" data-act="del" data-id="${p.id}" title="Löschen"><svg viewBox="0 0 24 24" stroke="currentColor" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
      </td>`;
    admBody.appendChild(tr);
  });
}
admBody.addEventListener('click',async(ev)=>{
  const btn=ev.target.closest('button[data-act]'); if(!btn) return;
  const id=btn.getAttribute('data-id'); const act=btn.getAttribute('data-act'); const tr=btn.closest('tr');
  showLoader();
  try{
    if(act==='save'){
      const name=tr.querySelector('td:nth-child(1) input').value.trim();
      const team=tr.querySelector('td:nth-child(2) select').value;
      if(!name) { showToast('Name darf nicht leer sein.', 'bad'); return; }
      const payload = { id, name, team };
      const r = await fetchWithRetry(`${WORKER_BASE}/people`,{method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)});
      if(!r.ok) throw new Error(await r.text());
      showToast('Person gespeichert.', 'ok'); await loadPeople(); renderPeopleAdmin();
    } else if(act==='del'){
      const r = await fetchWithRetry(`${WORKER_BASE}/people`,{method:'DELETE', headers:{'Content-Type':'application/json'}, body:JSON.stringify({id, _delete:true})});
      if(!r.ok) throw new Error(await r.text());
      showToast('Person gelöscht.', 'ok'); await loadPeople(); renderPeopleAdmin();
    }
  } catch(e){ showToast('Aktion fehlgeschlagen.', 'bad'); console.error(e); } finally { hideLoader(); }
});
async function adminCreate(){
  const name=admName.value.trim(); const team=admTeam.value;
  if(!name || !team){ showToast('Bitte Name und Team ausfüllen.', 'bad'); return; }
  showLoader();
  try{
    const payload = {id:`p_${Date.now()}`,name,team};
    const r = await fetchWithRetry(`${WORKER_BASE}/people`,{method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)});
    if(!r.ok) throw new Error(await r.text());
    showToast('Person angelegt.', 'ok');
    admName.value='';
    admTeam.value='';
    await loadPeople(); renderPeopleAdmin();
  }catch(err){ showToast('Anlegen fehlgeschlagen.', 'bad'); console.error('Network error',err); } finally { hideLoader(); }
}

/* ---------- ERP Import ---------- */
const btnErpImport = document.getElementById('btnErpImport');
btnErpImport.addEventListener('click', handleErpImport);

function getVal(row, keyName) {
    const normalizedKeyName = keyName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const keys = Object.keys(row);
    // Finde den Schlüssel, der am besten passt (enthält statt exakt)
    const foundKey = keys.find(k => k.toLowerCase().replace(/[^a-z0-9]/g, '').includes(normalizedKeyName));
    return foundKey ? row[foundKey] : undefined;
}

// Hilfsfunktion zum Parsen von Excel-Datumsangaben
function parseExcelDate(excelDate) {
    if (typeof excelDate === 'number') {
        // (excelDate - 25569) * 86400 * 1000 = Konvertierung von Excel-Datum (Zahl) zu JS-Timestamp
        // Fängt auch ungültige Excel-Daten ab (z.B. 0)
        if (excelDate > 0) {
            return new Date((excelDate - 25569) * 86400 * 1000);
        }
    }
    if (typeof excelDate === 'string') {
        // Versucht, ein Standard-Datumsformat zu parsen (ISO, locale etc.)
        const d = new Date(excelDate);
        if (!isNaN(d.getTime())) {
            return d;
        }
        // Versuch, DD.MM.YYYY oder MM/DD/YYYY zu parsen
        const parts = excelDate.match(/(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})/);
        if (parts) {
            // Annahme: DD.MM.YYYY zuerst (europäisch)
            let d = new Date(parts[3], parts[2] - 1, parts[1]);
            if (!isNaN(d.getTime())) return d;
            // Annahme: MM/DD/YYYY (amerikanisch)
            d = new Date(parts[3], parts[1] - 1, parts[2]);
            if (!isNaN(d.getTime())) return d;
        }
    }
    return null; // Ungültiges Format oder Wert
}


async function handleErpImport() {
    const fileInput = document.getElementById('erpFile');
    const importResult = document.getElementById('importResult');
    if (fileInput.files.length === 0) {
        showToast('Bitte eine Datei auswählen.', 'bad');
        return;
    }
    const file = fileInput.files[0];
    showLoader();
    importResult.classList.add('hide');
    
    try {
        await loadHistory(); // Ensure we have the latest data
        const data = await file.arrayBuffer();
        const workbook = XLSX.read(data);
        const sheetName = workbook.SheetNames[0];
        const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);

        let updatedCount = 0;
        let addedToFrameworkCount = 0;
        let newFixCount = 0;
        let skippedCount = 0;

        // Erstelle eine tiefe Kopie, um Seiteneffekte während der Schleife zu managen
        const allEntriesCopy = JSON.parse(JSON.stringify(entries));
        const changesToPush = [];
        
        // Erstelle einen schnellen Index für KV-Nummern aus der Kopie
        const kvIndex = new Map();
        allEntriesCopy.forEach(entry => {
            if (entry.kv_nummer) {
                kvIndex.set(entry.kv_nummer, { type: 'fix', entry: entry });
            }
            if (entry.projectType === 'rahmen' && Array.isArray(entry.transactions)) {
                entry.transactions.forEach(trans => {
                    if (trans.kv_nummer) {
                        kvIndex.set(trans.kv_nummer, { type: 'transaction', entry: entry, transaction: trans });
                    }
                });
            }
        });
        
        // Erstelle einen Index für Projektnummern von Rahmenverträgen aus der Kopie
        const frameworkProjectIndex = new Map();
        allEntriesCopy.forEach(entry => {
            if (entry.projectType === 'rahmen' && entry.projectNumber) {
                frameworkProjectIndex.set(entry.projectNumber, entry);
            }
        });

        for (const row of rows) {
            const kvNummer = String(getVal(row, 'KV-Nummer') || '').trim();
            if (!kvNummer) {
                skippedCount++;
                continue;
            }

            const projektNummer = String(getVal(row, 'Projekt Projektnummer') || '').trim();
            // Versucht, verschiedene Formate zu parsen (mit Komma als Dezimaltrenner)
            const amountRaw = getVal(row, 'Agenturleistung netto');
            const amount = parseAmountInput(amountRaw); 
            
            const clientName = getVal(row, 'Projekt Etat Kunde Name') || '';
            const title = getVal(row, 'Titel') || '';
            
            let freigabeTimestamp = Date.now(); // Fallback auf Import-Datum
            const excelDate = getVal(row, 'Abschlussdatum') || getVal(row, 'Freigabedatum'); // Suche nach Abschluss-/Freigabedatum
            if (excelDate) {
                const parsedDate = parseExcelDate(excelDate);
                if (parsedDate) {
                    freigabeTimestamp = parsedDate.getTime();
                } else {
                     console.warn(`Ungültiges Abschlussdatum in Zeile mit KV ${kvNummer}: ${excelDate}`);
                }
            } else {
                 console.warn(`Kein Abschlussdatum in Zeile mit KV ${kvNummer} gefunden, verwende Importdatum.`);
            }

            const existing = kvIndex.get(kvNummer);

            if (existing) { // Fall A: KV-Nummer wurde gefunden
                let currentAmount;
                if (existing.type === 'transaction') {
                    currentAmount = existing.transaction.amount;
                } else {
                    currentAmount = existing.entry.amount;
                }

                // Vergleiche Beträge mit kleiner Toleranz für Fließkomma-Ungenauigkeiten
                if (Math.abs(currentAmount - amount) > 0.001) {
                    if (existing.type === 'transaction') {
                        existing.transaction.amount = amount;
                        // Optional: Abschlussdatum aktualisieren, falls es sich geändert hat?
                        // existing.transaction.freigabedatum = freigabeTimestamp; 
                    } else {
                        existing.entry.amount = amount;
                        // Optional: Abschlussdatum aktualisieren?
                        // existing.entry.freigabedatum = freigabeTimestamp;
                    }
                    existing.entry.modified = Date.now();
                    // Stelle sicher, dass der Eintrag nur einmal in changesToPush landet
                    if (!changesToPush.some(item => item.id === existing.entry.id)) {
                        changesToPush.push(existing.entry);
                    }
                    updatedCount++;
                } else {
                    skippedCount++;
                }
            } else { // Fall B: KV-Nummer ist neu
                const parentFramework = frameworkProjectIndex.get(projektNummer);
                
                if (parentFramework) { // Fall B1: Rahmenvertrag gefunden
                    if (!Array.isArray(parentFramework.transactions)) {
                        parentFramework.transactions = [];
                    }
                     // Prüfen ob die Transaktion (KV) nicht doch schon da ist (Sicherheitsnetz)
                    if (!parentFramework.transactions.some(t => t.kv_nummer === kvNummer)) {
                        parentFramework.transactions.push({
                            id: `trans_${Date.now()}_${kvNummer.replace(/\W/g, '')}`,
                            kv_nummer: kvNummer,
                            type: 'founder', // Standard auf 'founder' (passiv)
                            amount: amount,
                            ts: Date.now(),
                            freigabedatum: freigabeTimestamp
                        });
                        parentFramework.modified = Date.now();
                         if (!changesToPush.some(item => item.id === parentFramework.id)) {
                            changesToPush.push(parentFramework);
                        }
                        addedToFrameworkCount++;
                    } else {
                         skippedCount++; // KV schon im RV vorhanden, aber nicht im Index (sollte nicht passieren)
                         console.warn(`KV ${kvNummer} bereits in Rahmenvertrag ${parentFramework.id} gefunden, obwohl nicht im Index.`);
                    }
                } else { // Fall B2: Neuer Fixauftrag
                    const newFixEntry = {
                        id: `entry_${Date.now()}_${kvNummer.replace(/\W/g, '')}`,
                        source: 'erp-import',
                        projectType: 'fix',
                        client: clientName,
                        title: title,
                        projectNumber: projektNummer,
                        kv_nummer: kvNummer,
                        amount: amount,
                        list: [],
                        rows: [],
                        weights: [],
                        ts: Date.now(),
                        freigabedatum: freigabeTimestamp,
                        complete: false // Ist unvollständig, da Verteilung fehlt
                    };
                    allEntriesCopy.push(newFixEntry); // Füge zur lokalen Kopie hinzu für spätere Index-Checks
                    kvIndex.set(kvNummer, {type: 'fix', entry: newFixEntry}); // Füge zum Index hinzu
                    changesToPush.push(newFixEntry);
                    newFixCount++;
                }
            }
        }

        // Keine Notwendigkeit mehr für uniqueChanges, da wir es jetzt direkt beim Pushen prüfen
        
        hideLoader();
        if (changesToPush.length > 0) {
            showBatchProgress('Speichere Import-Änderungen...', changesToPush.length);
            let count = 0;
            for (const entry of changesToPush) {
                count++;
                updateBatchProgress(count, changesToPush.length);
                
// *** KORREKTUR HIER: Prüfe gegen den *ursprünglichen* entries-Array ***
                const originalEntryExists = entries.some(originalEntry => originalEntry.id === entry.id);
                const url = !originalEntryExists ? `${WORKER_BASE}/entries` : `${WORKER_BASE}/entries/${encodeURIComponent(entry.id)}`;
                const method = !originalEntryExists ? 'POST' : 'PUT';

                // Stelle sicher, dass für PUT eine ID vorhanden ist
                if(method === 'PUT' && !entry.id) {
                     throw new Error(`Versuch, Eintrag ohne ID zu aktualisieren (KV: ${entry.kv_nummer || 'unbekannt'})`);
                }

                console.log(`Sending ${method} request to ${url} for KV ${entry.kv_nummer}`); // Debugging-Ausgabe

                const r = await fetchWithRetry(url, {
                    method: method,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(entry)
                });
                if (!r.ok) throw new Error(`Fehler (${method} ${url}) für Eintrag ${entry.id || ('(neu mit KV '+entry.kv_nummer+')')}: ${await r.text()}`);
                await throttle();
            }
        }

        const resultMsg = `Import abgeschlossen: ${updatedCount} Einträge aktualisiert, ${addedToFrameworkCount} neue Abrufe zu Rahmenverträgen hinzugefügt, ${newFixCount} neue Fixaufträge erstellt. ${skippedCount} Zeilen übersprungen (keine Änderungen oder fehlende KV-Nummer).`;
        importResult.innerHTML = resultMsg;
        importResult.classList.remove('hide');
        showToast('ERP-Daten erfolgreich importiert', 'ok');
        await loadHistory(); // Lade die finale Version vom Server

    } catch (e) {
        showToast('Fehler beim Importieren der Datei.', 'bad');
        console.error(e);
        importResult.textContent = 'Fehler: ' + e.message;
        importResult.classList.remove('hide');
    } finally {
        hideLoader();
        hideBatchProgress();
    }
}

// *** NEU: handleLegacySalesImport (mit bulk-v2) ***
async function handleLegacySalesImport() {
    const fileInput = document.getElementById('legacySalesFile');
    const importResult = document.getElementById('legacyImportResult');
    if (fileInput.files.length === 0) {
        showToast('Bitte eine Datei für den Legacy-Import auswählen.', 'bad');
        return;
    }
    const file = fileInput.files[0];
    showLoader();
    importResult.classList.add('hide');
    
    // Spaltenzuordnung
    const columnToPersonMap = {
        "% Evaluation und Beteiligung": "Evaluation und Beteiligung Mitarbeiter:in",
        "% Vielfalt+": "Vielfalt+ Mitarbeiter:in",
        "% Nachhaltigkeit": "Nachhaltigkeit Mitarbeiter:in",
        "% Sozial- und Krankenversicherungen": "Sozial- und Krankenversicherungen Mitarbeiter:in",
        "% ChangePartner": "ChangePartner Mitarbeiter:in",
        "% Bundes- & Landesbehörden": "Bundes- und Landesbehörden Mitarbeiter:in",
        "% Kommunalverwaltungen": "Kommunalverwaltungen Mitarbeiter:in",
        "% Internationale Zusammenarbeit": "Internationale Zusammenarbeit Mitarbeiter:in",
        "% BU OE": "BU Lead OE",
        "% BU PI": "BU Lead PI"
    };
    const percentageColumns = Object.keys(columnToPersonMap);
    const legacyWeights = [{key: 'cs', weight: 100}, {key: 'konzept', weight: 0}, {key: 'pitch', weight: 0}];

    try {
        await loadHistory(); // Aktuelle Daten laden (setzt window.entries)
        const data = await file.arrayBuffer();
        const workbook = XLSX.read(data);
        const sheetName = workbook.SheetNames[0];
        const excelRows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);

        let skippedCount = 0;
        
        // Verwende eine Kopie des globalen Zustands für die Vorbereitung
        const allEntriesCopy = JSON.parse(JSON.stringify(getEntries()));
        const changesToPush = []; // Hier sammeln wir die vollen, geänderten Objekte
        
        const kvIndex = new Map();
        allEntriesCopy.forEach(entry => {
            // Nur Fixaufträge indexieren
            if (entry.kv_nummer && entry.projectType !== 'rahmen') {
                kvIndex.set(entry.kv_nummer.trim(), { type: 'fix', entry: entry });
            }
             if (entry.kv && entry.projectType !== 'rahmen') {
                kvIndex.set(entry.kv.trim(), { type: 'fix', entry: entry });
            }
        });

        // 1. Daten vorbereiten (synchron)
        for (const row of excelRows) {
            const newSalesRows = []; 
            let totalPoints = 0;
            for (const colName of percentageColumns) {
                const percentageValue = parseFloat(getVal(row, colName) || 0); // getVal aus index.html
                if (percentageValue > 0) {
                    const personName = columnToPersonMap[colName];
                    const points = percentageValue * 100;
                    newSalesRows.push({ name: personName, cs: points, konzept: 0, pitch: 0 });
                    totalPoints += points;
                }
            }

            if (newSalesRows.length === 0) continue;
            
            if (Math.abs(totalPoints - 100) > 0.1) {
                console.warn(`Übersprungen (Vorb.): Zeile mit KV ${getVal(row, 'KV-Nummer')} hat Summe ${totalPoints}.`);
                skippedCount++;
                continue;
            }
            
            const kvString = String(getVal(row, 'KV-Nummer') || '').trim();
            if (!kvString) continue;

            const kvList = kvString.split(',').map(kv => kv.trim()).filter(kv => kv.length > 0);
            
            let firstFullKv = kvList.find(k => k.toLowerCase().startsWith('kv-')) || kvList[0];
            let kvPrefix = '';
            if (firstFullKv && firstFullKv.includes('-')) {
                 kvPrefix = firstFullKv.substring(0, firstFullKv.lastIndexOf('-') + 1); // z.B. "KV-2025-"
            }

            for (const kv of kvList) {
                let kvToUpdate = kv;
                if (!kvToUpdate.toLowerCase().startsWith('kv-') && kvPrefix) {
                    kvToUpdate = kvPrefix + kvToUpdate;
                } else if (!kvToUpdate.toLowerCase().startsWith('kv-') && !kvPrefix) {
                     console.warn(`Konnte Präfix für Suffix ${kv} nicht bestimmen (Zeile: ${kvString}). Überspringe.`);
                     skippedCount++;
                     continue;
                }

                const existing = kvIndex.get(kvToUpdate); // Suche im Index
                
                if (existing && existing.type === 'fix') { // Nur Fixaufträge bearbeiten
                    const entryToUpdate = existing.entry; 
                    
                    if (changesToPush.some(item => item.id === entryToUpdate.id)) {
                        console.log(`Eintrag ${entryToUpdate.id} bereits für Update vorgemerkt.`);
                        continue;
                    }

                    // Änderungen anwenden (auf die Kopie)
                    entryToUpdate.rows = newSalesRows;
                    entryToUpdate.weights = legacyWeights;
                    entryToUpdate.totals = {cs: 100, konzept: 0, pitch: 0}; 
                    const resultData = compute(newSalesRows, legacyWeights, (entryToUpdate.amount || 0)); // 'compute' ist in index.html
                    entryToUpdate.list = resultData.list; // Liste mit money-Werten
                    entryToUpdate.complete = autoComplete(entryToUpdate); // 'autoComplete' ist in index.html
                    entryToUpdate.modified = Date.now();
                    
                    changesToPush.push(entryToUpdate); // Zum Speichern vormerken
                } else if (!existing) {
                    console.warn(`Übersprungen (Vorb.): KV ${kvToUpdate} nicht gefunden.`);
                    skippedCount++;
                } else {
                    console.warn(`Übersprungen (Vorb.): KV ${kvToUpdate} ist Transaktion, kein Fixauftrag.`);
                     skippedCount++;
                }
            }
        }
        
        hideLoader(); // Vorbereitungs-Loader ausblenden

        if (changesToPush.length === 0) {
            importResult.innerHTML = `Legacy-Import: Keine Einträge gefunden oder alle übersprungen. ${skippedCount} Zeilen/KVs übersprungen.`;
            importResult.classList.remove('hide');
            showToast('Legacy-Import: Nichts zu aktualisieren.', 'warn');
            fileInput.value = '';
            return;
        }

        // *** NEU: Bulk-Upload Logik ***
        showBatchProgress(`Speichere ${changesToPush.length} Legacy-Änderungen...`, 1); // Nur 1 Schritt
        
        try {
            const bulkPayload = { rows: changesToPush }; // Sende die vollen, geänderten Objekte
            const r = await fetchWithRetry(`${WORKER_BASE}/entries/bulk-v2`, { // Verwende den v2-Endpunkt
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(bulkPayload)
            });
            
            updateBatchProgress(1, 1);
            const result = await r.json(); // Erwarte { ok: true/false, created, updated, skipped, errors, saved }

            if (!r.ok || !result.ok) {
                 const errorMsg = result.message || result.error || `Serverfehler ${r.status}`;
                 throw new Error(`Bulk save failed: ${errorMsg} (Details: ${result.details || 'N/A'})`);
            }

            const resultMsg = `Legacy-Import abgeschlossen: ${result.updated} Einträge erfolgreich aktualisiert. ${skippedCount} Zeilen/KVs in Vorbereitung übersprungen, ${result.skipped} beim Speichern übersprungen. ${result.errors} Fehler beim Speichern.`;
            importResult.innerHTML = resultMsg;
            importResult.classList.remove('hide');
            showToast('Sales-Daten (Altdaten) Import beendet.', result.errors > 0 ? 'warn' : 'ok');
            await loadHistory(); // Lade die finale Version vom Server

        } catch (e) {
            hideLoader();
            hideBatchProgress();
            showToast('Fehler beim Speichern der Legacy-Daten.', 'bad');
            console.error(e);
            importResult.textContent = 'Fehler beim Speichern: ' + e.message;
            importResult.classList.remove('hide');
        } finally {
            hideLoader();
            hideBatchProgress();
            fileInput.value = '';
        }
        // *** ENDE Bulk-Upload Logik ***
        
    } catch (e) {
        // Fehler beim Dateiverarbeiten (vor dem Speichern)
        hideLoader();
        hideBatchProgress();
        showToast('Fehler beim Verarbeiten der Datei.', 'bad');
        console.error(e);
        importResult.textContent = 'Fehler bei Dateiverarbeitung: ' + e.message;
        importResult.classList.remove('hide');
    } finally {
        hideLoader();
        hideBatchProgress();
        fileInput.value = '';
    }
}

/* ---------- Auswertung ---------- */
const anaYear = document.getElementById('anaYear');
const anaStartDate = document.getElementById('anaStartDate');
const anaEndDate = document.getElementById('anaEndDate');
const btnAnaThisYear = document.getElementById('btnAnaThisYear');
const btnAnaLastYear = document.getElementById('btnAnaLastYear');
const btnAnaRangeRefresh = document.getElementById('btnAnaRangeRefresh');
const trendFromMonth = document.getElementById('trendFromMonth');
const trendToMonth = document.getElementById('trendToMonth');
const btnTrendThisYear = document.getElementById('btnTrendThisYear');
const btnTrendLast12 = document.getElementById('btnTrendLast12');
const btnTrendLoad = document.getElementById('btnTrendLoad');
const btnTrendCsv = document.getElementById('btnTrendCsv');
const btnTrendXlsx = document.getElementById('btnTrendXlsx');
const trendSummary = document.getElementById('trendSummary');
const trendRevenueChart = document.getElementById('trendRevenueChart');
const trendCumulativeChart = document.getElementById('trendCumulativeChart');

function initAnalytics() {
    // Fülle Jahres-Dropdown (für Top-Listen)
    const currentYear = new Date().getFullYear();
    anaYear.innerHTML = '';
    for (let y = 2022; y <= currentYear + 1; y++) {
      const o = document.createElement('option'); o.value = String(y); o.textContent = String(y); anaYear.appendChild(o);
    }
    anaYear.value = String(currentYear);
    
    // Setze Standard-Datum (für Aktivitäts-Chart)
    setAnaDateRange('thisYear');

    // Führe beide Render-Funktionen aus
    renderAnalytics(); // Jährliche Auswertung
    renderActivityAnalytics(); // Zeitintervall-Auswertung
    initTrendControls();
    renderTrendInsights();
}

function setAnaDateRange(rangeType) {
    const now = new Date();
    let start, end;
    if (rangeType === 'thisYear') {
        start = new Date(now.getFullYear(), 0, 1); // 1. Jan
        end = now; // Heute
    } else { // lastYear
        const lastYear = now.getFullYear() - 1;
        start = new Date(lastYear, 0, 1); // 1. Jan letztes Jahr
        end = new Date(lastYear, 11, 31); // 31. Dez letztes Jahr
    }
    anaStartDate.value = formatDateForInput(start.getTime());
    anaEndDate.value = formatDateForInput(end.getTime());
}

btnAnaThisYear.addEventListener('click', () => {
    setAnaDateRange('thisYear');
    renderActivityAnalytics();
});
btnAnaLastYear.addEventListener('click', () => {
    setAnaDateRange('lastYear');
    renderActivityAnalytics();
});
btnAnaRangeRefresh.addEventListener('click', renderActivityAnalytics);

document.getElementById('anaRefresh').addEventListener('click', renderAnalytics); // Jährliche Auswertung
const btnAnaXlsx = document.getElementById('btnAnaXlsx');

let analyticsData = { persons: [], teams: [], totals: [] };
let trendData = null;

// Helper to get timestamp, ensuring it's a valid number or 0
function getTimestamp(dateStr) {
    try {
        const d = new Date(dateStr);
        return isNaN(d.getTime()) ? 0 : d.getTime();
    } catch { return 0; }
}

// Jährliche Top-Listen und Gesamtübersicht
function renderAnalytics() {
  const year = Number(anaYear.value);
  // Definiere Start- und End-Timestamp für das gewählte Jahr (UTC oder lokale Zeitzone beachten?)
  // Annahme: Lokale Zeitzone basierend auf formatDateForInput
  const startOfYear = getTimestamp(`${year}-01-01`);
  const endOfYear   = getTimestamp(`${year}-12-31T23:59:59.999`);

  const per = new Map();
  let fixTotal = 0;
  let rahmenTotal = 0;
  
getEntries().forEach(e => {
    const datum = e.freigabedatum || e.ts || 0; // Verwende Abschlussdatum primär
    
    if(e.projectType === 'fix') {
        // Prüfe, ob das Datum im gewählten Jahr liegt
        if (!(datum >= startOfYear && datum <= endOfYear)) return;
        
        const amount = e.amount || 0; if (amount <= 0) return;
        fixTotal += amount;
        // Zähle Personenbeiträge nur, wenn der Auftrag in diesem Jahr freigegeben wurde
        if (Array.isArray(e.list)) {
          e.list.forEach(x => { const key = x.name || 'Unbekannt'; per.set(key, (per.get(key) || 0) + (x.money || 0)); });
        }
    } else if (e.projectType === 'rahmen') {
        // Berechne die Verteilung basierend auf Abrufen *innerhalb* des Jahres
        const { list: actualDistribution, total: totalValueInYear } = calculateActualDistribution(e, startOfYear, endOfYear);
        rahmenTotal += totalValueInYear;
        actualDistribution.forEach(p => {
            per.set(p.name, (per.get(p.name) || 0) + p.money);
        });
    }
  });
  
  const perArr = Array.from(per, ([name, val]) => ({ name, val })).filter(x => x.val > 0).sort((a, b) => b.val - a.val).slice(0, 20);
  drawBars('chartPersons', perArr);
  analyticsData.persons = perArr;

  const byNameTeam = new Map(people.map(p => [p.name, p.team || '']));
  const teamMap = new Map();
  per.forEach((val, name) => {
    const team = byNameTeam.get(name) || 'Ohne Team';
    teamMap.set(team, (teamMap.get(team) || 0) + val);
  });
  const teamArr = Array.from(teamMap, ([name, val]) => ({ name, val })).filter(x => x.val > 0).sort((a, b) => b.val - a.val);
  drawBars('chartTeams', teamArr);
  analyticsData.teams = teamArr;
  
  const totalArr = [
    { name: 'Fixaufträge', val: fixTotal },
    { name: 'Rahmenverträge', val: rahmenTotal },
    { name: 'Gesamt', val: fixTotal + rahmenTotal }
  ];
  drawBars('chartTotals', totalArr);
  analyticsData.totals = totalArr;
}

// Zeitintervall-basierte Aktivität der Rahmenverträge
function renderActivityAnalytics() {
  const start = getTimestamp(anaStartDate.value);
  // Ende des Tages für das Enddatum nehmen
  const end = getTimestamp(`${anaEndDate.value}T23:59:59.999`);
  const titleEl = document.getElementById('chartActivityTitle');

  if (!start || !end || end < start) {
    showToast('Ungültiger Datumsbereich', 'bad');
    if (titleEl) {
      titleEl.textContent = 'Rahmenvertragsnutzung & Hunter/Founder-Anteile (ungültiger Zeitraum)';
    }
    renderFrameworkActivityChart('chartActivity', []);
    return;
  }

  const frameworks = getEntries().filter((entry) => entry.projectType === 'rahmen');
  const aggregated = [];

  frameworks.forEach((entry) => {
    let total = 0;
    let founderTotal = 0;
    let hunterTotal = 0;
    let otherTotal = 0;
    let count = 0;

    (entry.transactions || []).forEach((transaction) => {
      const date = Number(transaction?.freigabedatum ?? transaction?.ts ?? 0);
      if (!Number.isFinite(date) || date < start || date > end) {
        return;
      }

      const amountRaw = transaction?.amount;
      const amount =
        typeof amountRaw === 'string'
          ? parseAmountInput(amountRaw)
          : Number(amountRaw ?? 0);
      if (!Number.isFinite(amount)) {
        return;
      }

      total += amount;
      const type = String(transaction?.type || '').toLowerCase();
      if (type === 'founder') {
        founderTotal += amount;
      } else if (type === 'hunter') {
        hunterTotal += amount;
      } else {
        otherTotal += amount;
      }
      count += 1;
    });

    if (count === 0) {
      return;
    }

    const volume = getFrameworkVolume(entry);
    const utilizationPct = volume != null && volume > 0 ? (total / volume) * 100 : null;

    aggregated.push({
      id: entry.id,
      name: entry.title || '–',
      client: entry.client || '',
      projectNumber: entry.projectNumber || '',
      total,
      founder: founderTotal,
      hunter: hunterTotal,
      other: otherTotal,
      count,
      volume,
      utilizationPct,
    });
  });

  const topFrameworks = aggregated
    .filter((item) => item.total > 0 || (item.volume && item.utilizationPct != null))
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);

  const startLabel = new Date(start).toLocaleDateString('de-DE');
  const endLabel = new Date(end).toLocaleDateString('de-DE');
  if (titleEl) {
    titleEl.textContent = `Rahmenvertragsnutzung & Hunter/Founder-Anteile (${startLabel} – ${endLabel})`;
  }
  renderFrameworkActivityChart('chartActivity', topFrameworks);
}


function drawLineChart(hostOrId, points, options = {}) {
  const host = typeof hostOrId === 'string' ? document.getElementById(hostOrId) : hostOrId;
  if (!host) return;
  host.innerHTML = '';
  const list = Array.isArray(points) ? points : [];
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'log-metrics-empty';
    empty.textContent = options.emptyMessage || 'Keine Daten verfügbar.';
    host.appendChild(empty);
    return;
  }

  const formatter = options.formatter || ((value) => String(value));
  const color = options.color || '#3b82f6';
  const width = options.width || 1060;
  const height = options.height || 260;
  const padding = { top: 20, right: 24, bottom: 46, left: 80 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const coords = list.map((point, idx) => ({
    label: point.label,
    value: Number(point.value) || 0,
    raw: point,
    index: idx,
  }));

  let minVal = coords.reduce((min, p) => Math.min(min, p.value), Number.POSITIVE_INFINITY);
  let maxVal = coords.reduce((max, p) => Math.max(max, p.value), Number.NEGATIVE_INFINITY);
  if (!Number.isFinite(minVal)) minVal = 0;
  if (!Number.isFinite(maxVal)) maxVal = 0;
  if (typeof options.minValue === 'number') minVal = options.minValue;
  if (typeof options.maxValue === 'number') maxVal = options.maxValue;
  if (options.zeroBased) {
    if (minVal > 0) minVal = 0;
    if (maxVal < 0) maxVal = 0;
  }
  if (maxVal === minVal) {
    const adjust = Math.abs(maxVal || 1);
    maxVal += adjust;
    minVal -= adjust;
  }
  const range = maxVal - minVal || 1;
  const denom = Math.max(1, coords.length - 1);

  const positioned = coords.map((point) => {
    const ratio = coords.length === 1 ? 0.5 : point.index / denom;
    const x = padding.left + ratio * chartWidth;
    const y = padding.top + ((maxVal - point.value) / range) * chartHeight;
    return { ...point, x, y };
  });

  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'xMinYMin meet');

  const yAxis = document.createElementNS(svgNS, 'line');
  yAxis.setAttribute('x1', padding.left);
  yAxis.setAttribute('x2', padding.left);
  yAxis.setAttribute('y1', padding.top);
  yAxis.setAttribute('y2', height - padding.bottom);
  yAxis.setAttribute('stroke', '#1f2937');
  yAxis.setAttribute('stroke-width', '1');
  svg.appendChild(yAxis);

  const xAxis = document.createElementNS(svgNS, 'line');
  xAxis.setAttribute('x1', padding.left);
  xAxis.setAttribute('x2', width - padding.right);
  xAxis.setAttribute('y1', height - padding.bottom);
  xAxis.setAttribute('y2', height - padding.bottom);
  xAxis.setAttribute('stroke', '#1f2937');
  xAxis.setAttribute('stroke-width', '1');
  svg.appendChild(xAxis);

  const linePath = positioned
    .map((point, idx) => `${idx === 0 ? 'M' : 'L'}${point.x} ${point.y}`)
    .join(' ');

  const area = document.createElementNS(svgNS, 'path');
  const first = positioned[0];
  const last = positioned[positioned.length - 1];
  const baselineY = height - padding.bottom;
  const areaPath = `${linePath} L${last.x} ${baselineY} L${first.x} ${baselineY} Z`;
  area.setAttribute('d', areaPath);
  area.setAttribute('fill', 'rgba(59,130,246,0.18)');
  svg.appendChild(area);

  const line = document.createElementNS(svgNS, 'path');
  line.setAttribute('d', linePath);
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', color);
  line.setAttribute('stroke-width', '2');
  svg.appendChild(line);

  positioned.forEach((point) => {
    const circle = document.createElementNS(svgNS, 'circle');
    circle.setAttribute('cx', String(point.x));
    circle.setAttribute('cy', String(point.y));
    circle.setAttribute('r', '4');
    circle.setAttribute('fill', color);
    const title = document.createElementNS(svgNS, 'title');
    const formatted = formatter(point.value, point.raw);
    title.textContent = `${point.label}: ${formatted}`;
    circle.appendChild(title);
    svg.appendChild(circle);

    const valueLabel = document.createElementNS(svgNS, 'text');
    valueLabel.setAttribute('x', String(point.x));
    valueLabel.setAttribute('y', String(point.y - 10));
    valueLabel.setAttribute('fill', '#cbd5e1');
    valueLabel.setAttribute('font-size', '12');
    valueLabel.setAttribute('text-anchor', 'middle');
    valueLabel.textContent = formatted;
    svg.appendChild(valueLabel);

    const xLabel = document.createElementNS(svgNS, 'text');
    xLabel.setAttribute('x', String(point.x));
    xLabel.setAttribute('y', String(baselineY + 18));
    xLabel.setAttribute('fill', '#94a3b8');
    xLabel.setAttribute('font-size', '12');
    xLabel.setAttribute('text-anchor', 'middle');
    xLabel.textContent = point.label;
    svg.appendChild(xLabel);
  });

  const maxLabel = document.createElementNS(svgNS, 'text');
  maxLabel.setAttribute('x', String(padding.left - 12));
  maxLabel.setAttribute('y', String(padding.top + 4));
  maxLabel.setAttribute('fill', '#94a3b8');
  maxLabel.setAttribute('font-size', '12');
  maxLabel.setAttribute('text-anchor', 'end');
  maxLabel.textContent = formatter(maxVal, { label: 'max' });
  svg.appendChild(maxLabel);

  const minLabel = document.createElementNS(svgNS, 'text');
  minLabel.setAttribute('x', String(padding.left - 12));
  minLabel.setAttribute('y', String(baselineY));
  minLabel.setAttribute('fill', '#94a3b8');
  minLabel.setAttribute('font-size', '12');
  minLabel.setAttribute('text-anchor', 'end');
  minLabel.textContent = formatter(minVal, { label: 'min' });
  svg.appendChild(minLabel);

  host.appendChild(svg);
}

function drawBars(hostOrId, items, showCount = false, options = {}) {
  const host = typeof hostOrId === 'string' ? document.getElementById(hostOrId) : hostOrId;
  if (!host) return;
  host.innerHTML = '';
  const list = Array.isArray(items) ? items : [];
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'log-metrics-empty';
    empty.textContent = options.emptyMessage || 'Keine Daten verfügbar.';
    host.appendChild(empty);
    return;
  }

  const formatter = options.formatter || fmtCurr0;
  const valueFormatter = options.valueFormatter;
  const titleFormatter = options.titleFormatter;
  const barColor = options.barColor || '#3b82f6';
  const suffix = options.suffix || '';

  const max = list.reduce((m, x) => Math.max(m, Number(x.val) || 0), 0) || 1;
  const barH = 30;
  const gap = 8;
  const w = 1060;
  const h = list.length > 0 ? list.length * (barH + gap) + 10 : 50;
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('preserveAspectRatio', 'xMinYMin meet');

  let y = 10;
  const textWidth = 240;
  const barStartX = textWidth;
  const valueOffset = 120;

  list.forEach((item) => {
    const value = Number(item.val) || 0;
    const len = Math.max(4, Math.round((value / max) * (w - barStartX - valueOffset)));
    const g = document.createElementNS(svgNS, 'g');

    const formattedValue = valueFormatter ? valueFormatter(item) : `${formatter.format(value)}${suffix}`;
    const countText = showCount && item.count ? ` (${item.count})` : '';
    const titleText = titleFormatter
      ? titleFormatter(item, formattedValue)
      : `${item.name}: ${formattedValue}${countText}`;
    const title = document.createElementNS(svgNS, 'title');
    title.textContent = titleText;
    g.appendChild(title);

    const rect = document.createElementNS(svgNS, 'rect');
    rect.setAttribute('x', String(barStartX));
    rect.setAttribute('y', String(y));
    rect.setAttribute('rx', '6');
    rect.setAttribute('ry', '6');
    rect.setAttribute('width', String(len));
    rect.setAttribute('height', String(barH));
    rect.setAttribute('fill', barColor);

    const labelL = document.createElementNS(svgNS, 'text');
    labelL.setAttribute('x', '10');
    labelL.setAttribute('y', String(y + barH * 0.68));
    labelL.setAttribute('fill', '#cbd5e1');
    labelL.setAttribute('font-size', '14');
    labelL.textContent = item.name && item.name.length > 30 ? `${item.name.substring(0, 28)}…` : (item.name || '–');

    const labelV = document.createElementNS(svgNS, 'text');
    labelV.setAttribute('y', String(y + barH * 0.68));
    labelV.setAttribute('font-weight', '700');
    labelV.setAttribute('font-size', '14');
    const valueText = `${formattedValue}${countText}`;
    labelV.textContent = valueText;

    const valueTextLengthEstimate = valueText.length * 8;
    if (len < valueTextLengthEstimate + 10) {
      labelV.setAttribute('x', String(barStartX + len + 8));
      labelV.setAttribute('fill', '#cbd5e1');
    } else {
      labelV.setAttribute('x', String(barStartX + 10));
      labelV.setAttribute('fill', '#0a0f16');
    }

    g.appendChild(rect);
    g.appendChild(labelL);
    g.appendChild(labelV);
    svg.appendChild(g);
    y += barH + gap;
  });

  host.appendChild(svg);
}

function createActivityMetricCell(primaryText, secondaryLines = []) {
  const cell = document.createElement('td');
  cell.style.textAlign = 'right';
  cell.style.whiteSpace = 'nowrap';

  const main = document.createElement('div');
  main.textContent = primaryText;
  main.style.fontWeight = '600';
  cell.appendChild(main);

  secondaryLines.forEach((line) => {
    if (!line) return;
    const detail = document.createElement('div');
    detail.className = 'small';
    if (typeof line === 'string') {
      detail.style.color = 'var(--muted)';
      detail.textContent = line;
    } else if (typeof line === 'object') {
      detail.style.color = line.color || 'var(--muted)';
      detail.textContent = line.text || '';
    }
    cell.appendChild(detail);
  });

  return cell;
}

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

function getFrameworkVolume(entry) {
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

function renderFrameworkActivityChart(hostOrId, items) {
  const host = typeof hostOrId === 'string' ? document.getElementById(hostOrId) : hostOrId;
  if (!host) return;
  host.innerHTML = '';

  const list = Array.isArray(items) ? items : [];
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'log-metrics-empty';
    empty.textContent = 'Keine Rahmenvertragsabrufe im Zeitraum.';
    host.appendChild(empty);
    return;
  }

  const wrapper = document.createElement('div');
  wrapper.className = 'table-wrapper';

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  thead.innerHTML = `
    <tr>
      <th style="text-align:left">Rahmenvertrag</th>
      <th>Founder-Umsatz</th>
      <th>Hunter-Umsatz</th>
      <th>Summe Zeitraum</th>
      <th>Rahmenvolumen</th>
      <th>Ausnutzung</th>
    </tr>
  `;

  const tbody = document.createElement('tbody');
  list.forEach((item) => {
    const tr = document.createElement('tr');

    const metaParts = [];
    if (item.client) metaParts.push(item.client);
    if (item.projectNumber) metaParts.push(item.projectNumber);

    const nameCell = document.createElement('td');
    nameCell.style.textAlign = 'left';
    const title = document.createElement('div');
    title.textContent = item.name || '–';
    title.style.fontWeight = '600';
    nameCell.appendChild(title);
    if (metaParts.length) {
      const meta = document.createElement('div');
      meta.className = 'small';
      meta.style.color = 'var(--muted)';
      meta.textContent = metaParts.join(' • ');
      nameCell.appendChild(meta);
    }
    tr.appendChild(nameCell);

    const total = Number.isFinite(item.total) ? item.total : 0;
    const founder = Number.isFinite(item.founder) ? item.founder : 0;
    const hunter = Number.isFinite(item.hunter) ? item.hunter : 0;
    const other = Number.isFinite(item.other) ? item.other : 0;
    const hasShareBase = Math.abs(total) > 0.0001;
    const founderShare = hasShareBase ? (founder / total) * 100 : null;
    const hunterShare = hasShareBase ? (hunter / total) * 100 : null;

    tr.appendChild(
      createActivityMetricCell(fmtCurr0.format(founder),
        founderShare != null ? [`${fmtPct.format(founderShare)} % Anteil`] : [])
    );
    tr.appendChild(
      createActivityMetricCell(fmtCurr0.format(hunter),
        hunterShare != null ? [`${fmtPct.format(hunterShare)} % Anteil`] : [])
    );

    const sumDetails = [`Abrufe: ${fmtInt.format(item.count || 0)}`];
    if (Math.abs(other) > 0.01) {
      sumDetails.push(`Sonstige: ${fmtCurr0.format(other)}`);
    }
    tr.appendChild(createActivityMetricCell(fmtCurr0.format(total), sumDetails));

    const normalizedVolume = Number.isFinite(item.volume) ? item.volume : null;
    if (normalizedVolume != null) {
      const remaining = normalizedVolume - total;
      const secondary = [];
      if (Math.abs(remaining) > 0.01) {
        secondary.push(
          remaining >= 0
            ? `Rest: ${fmtCurr0.format(remaining)}`
            : { text: `Überzogen: ${fmtCurr0.format(Math.abs(remaining))}`, color: 'var(--warn)' }
        );
      }
      tr.appendChild(createActivityMetricCell(fmtCurr0.format(normalizedVolume), secondary));
    } else {
      tr.appendChild(createActivityMetricCell('–'));
    }

    const utilization = Number.isFinite(item.utilizationPct) ? item.utilizationPct : null;
    if (utilization != null) {
      tr.appendChild(createActivityMetricCell(`${fmtPct.format(utilization)} %`));
    } else {
      tr.appendChild(createActivityMetricCell('–'));
    }

    const tooltipParts = [
      `Summe: ${fmtCurr0.format(total)}`,
      `Founder: ${fmtCurr0.format(founder)}`,
      `Hunter: ${fmtCurr0.format(hunter)}`,
      `Abrufe: ${fmtInt.format(item.count || 0)}`,
    ];
    if (Math.abs(other) > 0.01) {
      tooltipParts.push(`Sonstige: ${fmtCurr0.format(other)}`);
    }
    if (normalizedVolume != null) {
      tooltipParts.push(`Volumen: ${fmtCurr0.format(normalizedVolume)}`);
    }
    if (utilization != null) {
      tooltipParts.push(`Ausnutzung: ${fmtPct.format(utilization)} %`);
    }
    tr.title = `${escapeHtml(item.name)}${item.client ? ` (${escapeHtml(item.client)})` : ''} • ${tooltipParts.join(' • ')}`;

    tbody.appendChild(tr);
  });

  table.appendChild(thead);
  table.appendChild(tbody);
  wrapper.appendChild(table);
  host.appendChild(wrapper);
}


const trendMonthFormatter = new Intl.DateTimeFormat('de-DE', { month: 'short', year: 'numeric' });
const trendAverageFormatter = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

function initTrendControls() {
  if (!trendFromMonth || !trendToMonth) {
    return;
  }
  if (!trendFromMonth.value || !trendToMonth.value) {
    setTrendRange('last12');
  }
  btnTrendThisYear?.addEventListener('click', () => {
    setTrendRange('thisYear');
    renderTrendInsights();
  });
  btnTrendLast12?.addEventListener('click', () => {
    setTrendRange('last12');
    renderTrendInsights();
  });
  btnTrendLoad?.addEventListener('click', () => renderTrendInsights());
  btnTrendCsv?.addEventListener('click', exportTrendCsv);
  btnTrendXlsx?.addEventListener('click', exportTrendXlsx);
}

function setTrendRange(rangeType) {
  if (!trendFromMonth || !trendToMonth) return;
  const now = new Date();
  let start;
  let end;
  if (rangeType === 'thisYear') {
    start = new Date(now.getFullYear(), 0, 1);
    end = new Date(now.getFullYear(), now.getMonth(), 1);
  } else {
    end = new Date(now.getFullYear(), now.getMonth(), 1);
    start = new Date(end.getFullYear(), end.getMonth() - 11, 1);
  }
  trendFromMonth.value = formatMonthInputValue(start);
  trendToMonth.value = formatMonthInputValue(end);
}

function formatMonthInputValue(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

function parseMonthValue(value) {
  if (!value || typeof value !== 'string') return null;
  const [yearStr, monthStr] = value.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return null;
  if (month < 1 || month > 12) return null;
  const date = new Date(year, month - 1, 1);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getEndOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59, 999);
}

function normalizeTrendTimestamp(value) {
  if (value == null) return Number.NaN;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return Number.NaN;
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return Number.NaN;
    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
      const numeric = Number(trimmed);
      if (!Number.isFinite(numeric)) return Number.NaN;
      return numeric > 1e12 ? numeric : numeric * 1000;
    }
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isNaN(time) ? Number.NaN : time;
  }
  return Number.NaN;
}

function normalizeTrendAmount(value) {
  if (value == null) return 0;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return 0;
    const parsed = parseAmountInput(trimmed);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function collectTrendItems(entry) {
  const items = [];
  if (!entry || typeof entry !== 'object') return items;

  const transactionItems = Array.isArray(entry.transactions)
    ? entry.transactions
        .map((tx) => {
          const ts = normalizeTrendTimestamp(tx?.freigabedatum ?? tx?.ts ?? tx?.date);
          const amount = normalizeTrendAmount(tx?.amount ?? tx?.value);
          if (!Number.isFinite(ts) || !(amount > 0)) {
            return null;
          }
          return { timestamp: ts, amount };
        })
        .filter(Boolean)
    : [];

  if (transactionItems.length) {
    items.push(...transactionItems);
    return items;
  }

  const baseTimestamp = normalizeTrendTimestamp(
    entry.freigabedatum ?? entry.ts ?? entry.abschlussdatum ?? entry.closeDate ?? entry.date
  );
  const baseAmount = normalizeTrendAmount(entry.amount ?? entry.value ?? entry.auftragswert);
  if (!Number.isFinite(baseTimestamp) || !(baseAmount > 0)) {
    return items;
  }

  const projectType = String(entry.projectType || '').toLowerCase();
  if (projectType === 'rahmen' && Array.isArray(entry.transactions) && entry.transactions.length > 0) {
    return items;
  }

  items.push({ timestamp: baseTimestamp, amount: baseAmount });
  return items;
}

function computeTrendData(fromDate, toDate) {
  const startMs = fromDate.getTime();
  const endMs = getEndOfMonth(toDate).getTime();
  const monthsMap = new Map();

  getEntries().forEach((entry) => {
    collectTrendItems(entry).forEach((item) => {
      if (!Number.isFinite(item.timestamp) || item.timestamp < startMs || item.timestamp > endMs) {
        return;
      }
      const date = new Date(item.timestamp);
      const year = date.getFullYear();
      const monthIndex = date.getMonth();
      const key = `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
      let bucket = monthsMap.get(key);
      if (!bucket) {
        bucket = {
          year,
          monthIndex,
          amount: 0,
          count: 0,
          label: trendMonthFormatter.format(new Date(year, monthIndex, 1)),
        };
        monthsMap.set(key, bucket);
      }
      bucket.amount += item.amount;
      bucket.count += 1;
    });
  });

  const sortedKeys = Array.from(monthsMap.keys()).sort();
  const months = sortedKeys.map((key) => {
    const bucket = monthsMap.get(key);
    return {
      key,
      label: bucket.label,
      amount: bucket.amount,
      count: bucket.count,
      year: bucket.year,
      monthIndex: bucket.monthIndex,
    };
  });

  let cumulative = 0;
  months.forEach((month) => {
    cumulative += month.amount;
    month.cumulativeAmount = cumulative;
  });

  const totalAmount = months.reduce((sum, month) => sum + month.amount, 0);
  const totalDeals = months.reduce((sum, month) => sum + month.count, 0);
  const averageAmount = months.length ? totalAmount / months.length : 0;
  const averageDeals = months.length ? totalDeals / months.length : 0;
  const bestMonth = months.reduce((best, month) => {
    if (!best || month.amount > best.amount) {
      return month;
    }
    return best;
  }, null);

  const revenueSeries = months.map((month) => ({
    label: month.label,
    value: Number(month.amount.toFixed(2)),
    count: month.count,
  }));
  const cumulativeSeries = months.map((month) => ({
    label: month.label,
    value: Number(month.cumulativeAmount.toFixed(2)),
  }));

  return {
    period: {
      from: formatMonthInputValue(fromDate),
      to: formatMonthInputValue(toDate),
      label: `${trendMonthFormatter.format(fromDate)} – ${trendMonthFormatter.format(toDate)}`,
    },
    months,
    totals: {
      amount: totalAmount,
      deals: totalDeals,
      averageAmount,
      averageDeals,
      bestMonth,
    },
    series: {
      revenue: revenueSeries,
      cumulative: cumulativeSeries,
    },
  };
}

function renderTrendSummary(data) {
  if (!trendSummary) return;
  if (!data || data.months.length === 0) {
    trendSummary.innerHTML = '<div class="log-metrics-empty">Keine Daten im gewählten Zeitraum.</div>';
    return;
  }

  const monthsCount = data.months.length;
  const totals = data.totals;
  const bestMonth = totals.bestMonth;
  const monthsLabel = monthsCount === 1 ? '1 Monat analysiert' : `${monthsCount} Monate analysiert`;
  const totalAmountText = fmtCurr2.format(totals.amount || 0);
  const avgAmountText = fmtCurr2.format(totals.averageAmount || 0);
  const totalDealsText = fmtInt.format(totals.deals || 0);
  const avgDealsText = trendAverageFormatter.format(totals.averageDeals || 0);
  const bestLabel = bestMonth ? bestMonth.label : '–';
  const bestSub = bestMonth
    ? `${fmtCurr2.format(bestMonth.amount || 0)} • ${fmtInt.format(bestMonth.count || 0)} Deals`
    : 'Noch keine Umsätze';

  trendSummary.innerHTML = `
    <div class="metric-card">
      <div class="label">Zeitraum</div>
      <div class="value">${data.period.label}</div>
      <div class="sub">${monthsLabel}</div>
    </div>
    <div class="metric-card">
      <div class="label">Gesamtumsatz</div>
      <div class="value">${totalAmountText}</div>
      <div class="sub">Ø ${avgAmountText} pro Monat</div>
    </div>
    <div class="metric-card">
      <div class="label">Deals</div>
      <div class="value">${totalDealsText}</div>
      <div class="sub">Ø ${avgDealsText} Deals pro Monat</div>
    </div>
    <div class="metric-card">
      <div class="label">Bester Monat</div>
      <div class="value">${bestLabel}</div>
      <div class="sub">${bestSub}</div>
    </div>
  `;
}

function renderTrendInsights() {
  if (!trendFromMonth || !trendToMonth) return;
  const from = parseMonthValue(trendFromMonth.value);
  const to = parseMonthValue(trendToMonth.value);
  if (!from || !to) {
    if (trendSummary) {
      trendSummary.innerHTML = '<div class="log-metrics-empty">Bitte gültige Monate auswählen.</div>';
    }
    showToast('Bitte wählen Sie einen gültigen Zeitraum.', 'warn');
    return;
  }
  if (from > to) {
    showToast('Der Startmonat darf nicht nach dem Endmonat liegen.', 'warn');
    return;
  }

  trendData = computeTrendData(from, to);
  renderTrendSummary(trendData);

  const revenueSeries = trendData.series?.revenue || [];
  const cumulativeSeries = trendData.series?.cumulative || [];

  drawLineChart(trendRevenueChart, revenueSeries, {
    formatter: (value) => fmtCurr2.format(value),
    emptyMessage: 'Keine Umsätze im Zeitraum.',
    color: '#3b82f6',
  });

  drawLineChart(trendCumulativeChart, cumulativeSeries, {
    formatter: (value) => fmtCurr2.format(value),
    emptyMessage: 'Keine Umsätze im Zeitraum.',
    color: '#22c55e',
  });
}

function buildTrendExportFilename(extension) {
  const from = trendData?.period?.from || 'start';
  const to = trendData?.period?.to || 'ende';
  const suffix = `${from}_${to}`.replace(/[^0-9A-Za-z_-]+/g, '_');
  return `umsatz_trends_${suffix}.${extension}`;
}

function downloadBlob(content, mimeType, filename) {
  try {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    setTimeout(() => {
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    }, 0);
  } catch (err) {
    console.error('Download fehlgeschlagen:', err);
    showToast('Download konnte nicht gestartet werden.', 'bad');
  }
}

function exportTrendCsv() {
  if (!trendData) {
    showToast('Keine Trenddaten zum Exportieren vorhanden.', 'warn');
    return;
  }

  const { period, totals, months } = trendData;
  const lines = [];
  lines.push('Abschnitt;Feld;Wert');
  lines.push(`Zeitraum;Von;${period.from || ''}`);
  lines.push(`Zeitraum;Bis;${period.to || ''}`);
  lines.push(`Zeitraum;Monate;${months.length}`);
  lines.push(
    `Gesamt;Umsatz_EUR;${(totals.amount || 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  );
  lines.push(`Gesamt;Deals;${totals.deals || 0}`);
  lines.push(
    `Gesamt;Ø_Monatsumsatz_EUR;${(totals.averageAmount || 0).toLocaleString('de-DE', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`
  );
  lines.push(
    `Gesamt;Ø_Deals_pro_Monat;${(totals.averageDeals || 0).toLocaleString('de-DE', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`
  );
  if (totals.bestMonth) {
    lines.push(`Gesamt;Bester_Monat;${totals.bestMonth.label}`);
    lines.push(
      `Gesamt;Bester_Monat_Umsatz_EUR;${(totals.bestMonth.amount || 0).toLocaleString('de-DE', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`
    );
    lines.push(`Gesamt;Bester_Monat_Deals;${totals.bestMonth.count || 0}`);
  }
  lines.push('');
  lines.push('Monate;Monat;Umsatz_EUR;Deals;Kumuliert_EUR');
  months.forEach((month) => {
    lines.push(
      `Monat;${month.label};${(month.amount || 0).toLocaleString('de-DE', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })};${month.count || 0};${(month.cumulativeAmount || 0).toLocaleString('de-DE', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`
    );
  });

  const csvContent = '\ufeff' + lines.join('\n');
  downloadBlob(csvContent, 'text/csv;charset=utf-8;', buildTrendExportFilename('csv'));
}

function exportTrendXlsx() {
  if (!trendData) {
    showToast('Keine Trenddaten zum Exportieren vorhanden.', 'warn');
    return;
  }
  if (typeof XLSX === 'undefined') {
    showToast('XLSX-Bibliothek nicht verfügbar.', 'bad');
    return;
  }

  const wb = XLSX.utils.book_new();
  const { period, totals, months } = trendData;

  const summarySheet = [
    { Kennzahl: 'Von', Wert: period.from || '' },
    { Kennzahl: 'Bis', Wert: period.to || '' },
    { Kennzahl: 'Monate', Wert: months.length },
    { Kennzahl: 'Gesamtumsatz EUR', Wert: Number((totals.amount || 0).toFixed(2)) },
    { Kennzahl: 'Ø Monatsumsatz EUR', Wert: Number((totals.averageAmount || 0).toFixed(2)) },
    { Kennzahl: 'Deals gesamt', Wert: totals.deals || 0 },
    { Kennzahl: 'Ø Deals pro Monat', Wert: Number((totals.averageDeals || 0).toFixed(2)) },
  ];

  if (totals.bestMonth) {
    summarySheet.push({ Kennzahl: 'Bester Monat', Wert: totals.bestMonth.label });
    summarySheet.push({ Kennzahl: 'Bester Monat Umsatz EUR', Wert: Number((totals.bestMonth.amount || 0).toFixed(2)) });
    summarySheet.push({ Kennzahl: 'Deals im besten Monat', Wert: totals.bestMonth.count || 0 });
  }

  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summarySheet), 'Übersicht');

  const monthSheet = months.map((month) => ({
    Monat: month.label,
    Umsatz_EUR: Number((month.amount || 0).toFixed(2)),
    Deals: month.count || 0,
    Kumuliert_EUR: Number((month.cumulativeAmount || 0).toFixed(2)),
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(monthSheet), 'Monate');

  XLSX.writeFile(wb, buildTrendExportFilename('xlsx'));
}

btnAnaXlsx.addEventListener('click', () => {
    const year = anaYear.value;
    const wb = XLSX.utils.book_new();

    // Ensure data exists before creating sheets
    if (analyticsData.persons && analyticsData.persons.length > 0) {
        const ws1Arr = analyticsData.persons.map(p => ({ Name: p.name, Betrag_EUR: p.val }));
        const ws1 = XLSX.utils.json_to_sheet(ws1Arr);
        XLSX.utils.book_append_sheet(wb, ws1, "Top Personen");
    }
    if (analyticsData.teams && analyticsData.teams.length > 0) {
        const ws2Arr = analyticsData.teams.map(t => ({ Team: t.name, Betrag_EUR: t.val }));
        const ws2 = XLSX.utils.json_to_sheet(ws2Arr);
        XLSX.utils.book_append_sheet(wb, ws2, "Teams Aggregiert");
    }
     if (analyticsData.totals && analyticsData.totals.length > 0) {
        const ws3Arr = analyticsData.totals.map(t => ({ Typ: t.name, Betrag_EUR: t.val }));
        const ws3 = XLSX.utils.json_to_sheet(ws3Arr);
        XLSX.utils.book_append_sheet(wb, ws3, "Gesamt");
    }
    
    // Add activity data if available (simple export of the current view)
    const activityChart = document.getElementById('chartActivity');
    if(activityChart && activityChart.innerHTML !== '') {
         const start = anaStartDate.value;
         const end = anaEndDate.value;
         const activityItems = Array.from(document.querySelectorAll('#chartActivity g')).map(g => {
             const name = g.querySelector('text[x="10"]').textContent;
             const valueText = g.querySelector('text[font-weight="700"]').textContent;
             const amountMatch = valueText.match(/([\d.]+,\d+)\s€/); // Extract amount
             const amount = amountMatch ? parseAmountInput(amountMatch[1]) : 0;
             const countMatch = valueText.match(/\((\d+)\)/); // Extract count
             const count = countMatch ? parseInt(countMatch[1]) : null;
             return { Rahmenvertrag: name, Betrag_EUR: amount, Abrufe: count };
         });
         if(activityItems.length > 0) {
             const ws4 = XLSX.utils.json_to_sheet(activityItems);
             XLSX.utils.book_append_sheet(wb, ws4, `Aktivität ${start}-${end}`);
         }
    }

    if(wb.SheetNames.length > 0) {
      XLSX.writeFile(wb, `auswertung_${year}_export.xlsx`);
    } else {
        showToast('Keine Daten zum Exportieren vorhanden.', 'warn');
    }
});

/* ---------- Init & Window Events ---------- */
function initFromState(isEditing = false){
  const st=loadState();
  if(st?.input){
    const isEditFromHistory = !!st.editingId;
    loadInputForm(st.input, isEditFromHistory);
  } else {
    loadInputForm({}, false); // Ensure default freigabedatum is set
  }
  updateWeightNote();
}

Object.assign(window, {
  showToast,
  showLoader,
  hideLoader,
  showBatchProgress,
  updateBatchProgress,
  hideBatchProgress,
  fetchWithRetry,
  throttle,
  loadHistory,
  populateAdminTeamOptions,
});

// Warnung bei ungespeicherten Änderungen oder laufendem Batch
window.addEventListener('beforeunload', (e) => {
  if (getHasUnsavedChanges() || getIsBatchRunning()) {
    const msg = getIsBatchRunning() ? 'Eine Batch-Verarbeitung läuft noch. Sind Sie sicher, dass Sie die Seite verlassen wollen?' : 'Ungespeicherte Änderungen gehen verloren. Sind Sie sicher?';
    e.preventDefault(); // Standard für die meisten Browser
    e.returnValue = msg; // Für ältere Browser / Electron
    return msg; // Für manche Browser
  }
});

async function initializeApp(){
  try {
    await loadSession();
    await loadPeople();
  } catch (err) {
    console.error('Initialisierung von Session/Personen fehlgeschlagen:', err);
    showToast('Cloudflare-Session oder Personenliste konnten nicht geladen werden.', 'bad');
  }

  populateAdminTeamOptions();
  initFromState();

  try {
    await loadHistory();
  } catch (err) {
    console.error('Initiales Laden der Historie fehlgeschlagen:', err);
  }
  renderDockBoard();
  showView('erfassung');

  const btnLegacySalesImport = document.getElementById('btnLegacySalesImport');
  if (btnLegacySalesImport) {
    btnLegacySalesImport.addEventListener('click', handleLegacySalesImport);
  } else {
    console.error('Button #btnLegacySalesImport nicht gefunden!');
  }
}

initializeApp();

// Deep Link zu Admin (optional)
if (location.hash === '#admin') { 
    // Warte kurz, damit die UI bereit ist
    setTimeout(handleAdminClick, 100); 
}

// Verhindere Standard-Enter-Verhalten in Inputs außerhalb von Admin
document.addEventListener('keydown',(e)=>{ 
    if(e.key==='Enter' && e.target?.tagName==='INPUT' && !e.target.closest('#viewAdmin')) {
        e.preventDefault(); 
    }
});
