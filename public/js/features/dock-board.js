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
import { showToast } from '../ui/feedback.js';
import { openWizard } from './erfassung.js';
import { updateContributionSummary } from '../calculations.js';
import { showSection, showErfassung, toggleUnsavedBadge } from '../navigation.js';
import { renderPortfolio } from './portfolio.js';
import { getDockFilters, setDockFilters, setDockSelection, getDockSelection, setDockHints, getDockHints, bumpDockPhaseHistory } from '../state/dock-state.js';
import { getHistoryFilters, setPendingDelete } from '../state/history-state.js';
import { getFrameworkFilters, setFrameworkFilters } from '../state/framework-state.js';
import { renderHistory } from './history.js';

const DOCK_PHASES = [1, 2, 3];

const DEFAULT_FILTERS = {
  search: '',
  phase: 'all',
  team: 'all',
  client: 'all',
  product: 'all',
  bucket: 'all',
  kv: 'all',
  showConflicts: true,
  showOnlyIncomplete: false,
  showOnlyNeedsAttention: false,
};

let dockAutoCheckQueue = new Map();
let dockAutoAdvanceTimer = null;
let dockAutoDowngradeTimer = null;
let lastAutoDockMutationAt = 0;
let dockReloadTimer = null;

function now() {
  return Date.now();
}

function debounce(fn, delay) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), delay);
  };
}

function withLoading(button, on) {
  if (!button) return;
  button.disabled = !!on;
  button.classList.toggle('is-loading', !!on);
}

function getDockContainer() {
  return document.getElementById('dockBoard');
}

function ensureDockDom() {
  const container = getDockContainer();
  if (!container) {
    console.warn('[dock] dockBoard container missing');
    return null;
  }
  return container;
}

function getDockToolbarEl() {
  return document.getElementById('dockToolbar');
}

function getDockFiltersEl() {
  return document.getElementById('dockFilters');
}

function getDockStatsEl() {
  return document.getElementById('dockStats');
}

function getDockColumnsEl() {
  return document.getElementById('dockColumns');
}

function getDockSelectionEl() {
  return document.getElementById('dockSelection');
}

function getDockHintsEl() {
  return document.getElementById('dockHints');
}

function getDockSearchEl() {
  return document.getElementById('dockSearch');
}

function getDockPhaseFilterEl() {
  return document.getElementById('dockPhaseFilter');
}

function getDockTeamFilterEl() {
  return document.getElementById('dockTeamFilter');
}

function getDockClientFilterEl() {
  return document.getElementById('dockClientFilter');
}

function getDockProductFilterEl() {
  return document.getElementById('dockProductFilter');
}

function getDockBucketFilterEl() {
  return document.getElementById('dockBucketFilter');
}

function getDockKvFilterEl() {
  return document.getElementById('dockKvFilter');
}

function getDockConflictsToggleEl() {
  return document.getElementById('dockConflictsToggle');
}

function getDockIncompleteToggleEl() {
  return document.getElementById('dockIncompleteToggle');
}

function getDockNeedsAttentionToggleEl() {
  return document.getElementById('dockNeedsAttentionToggle');
}

function getDockReloadBtn() {
  return document.getElementById('dockReload');
}

function getDockBulkAdvanceBtn() {
  return document.getElementById('dockBulkAdvance');
}

function getDockBulkDowngradeBtn() {
  return document.getElementById('dockBulkDowngrade');
}

function getDockBulkAssignBtn() {
  return document.getElementById('dockBulkAssign');
}

function getDockBulkArchiveBtn() {
  return document.getElementById('dockBulkArchive');
}

function getDockBulkMergeBtn() {
  return document.getElementById('dockBulkMerge');
}

function getDockBulkDeleteBtn() {
  return document.getElementById('dockBulkDelete');
}

function getDockToastContainer() {
  return document.getElementById('dockToast');
}

function parseDockBool(value, fallback) {
  if (value === true || value === false) return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function normalizeFilterValue(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return trimmed;
}

function buildDockChecklist(entry) {
  const amount = Number(entry.amount || entry.budget || 0);
  const hasClient = normalizeDockString(entry.client).length > 0;
  const hasProjectNumber = normalizeDockString(entry.projectNumber).length > 0;
  const hasKv = normalizeDockString(entry.kv_nummer || entry.kvNummer || entry.kv).length > 0;
  const salesContributions = Array.isArray(entry.list) ? entry.list : [];
  const hasSalesContributions = salesContributions.length > 0;
  const hasSubmittedBy = normalizeDockString(entry.submittedBy).length > 0;
  const isComplete = amount > 0 && hasClient && hasProjectNumber && hasKv && hasSalesContributions;
  return { amount, hasClient, hasProjectNumber, hasKv, hasSalesContributions, hasSubmittedBy, isComplete };
}

function isPhaseTwoReady(checklist) {
  return checklist.amount && checklist.hasClient && checklist.hasProjectNumber && checklist.hasKv && checklist.hasSalesContributions;
}

function shouldDisplayInDock(entry) {
  if (!entry || typeof entry !== 'object') return false;

  const source = normalizeDockString(entry.source).toLowerCase();
  const phase = Number(entry.dockPhase);

  // Phase 4 = Portfolio -> niemals im Dock anzeigen
  if (Number.isFinite(phase) && phase >= 4) return false;

  // Excel / ERP-Importe sollen direkt im Portfolio landen
  if (source === 'erp-import') return false;

  // Nicht-HubSpot Deals nur anzeigen, wenn sie explizit eine Dock-Phase haben
  if (source !== 'hubspot' && entry.dockPhase == null) return false;

  // Sobald final zugeordnet, nicht mehr im Dock anzeigen
  if (entry.dockFinalAssignment) return false;

  return true;
}

function augmentDockEntry(entry) {
  const checklist = buildDockChecklist(entry);
  const phase = getDockPhase(entry);
  return {
    ...entry,
    phase,
    show: shouldDisplayInDock(entry),
    checklist,
    checklistComplete: checklist.isComplete,
    needsAttention: !checklist.isComplete && (phase === 2 || phase === 3),
  };
}

function matchesDockFilters(item) {
  const filters = getDockFilters() || DEFAULT_FILTERS;
  if (!item.show) return false;

  const search = normalizeFilterValue(filters.search, '');
  if (search) {
    const haystack = [
      item.title,
      item.client,
      item.projectNumber,
      item.kv_nummer,
      item.kvNummer,
      item.dealId,
    ].map((v) => normalizeDockString(v).toLowerCase()).join(' ');
    if (!haystack.includes(search.toLowerCase())) return false;
  }

  const phaseFilter = normalizeFilterValue(filters.phase, 'all');
  if (phaseFilter !== 'all' && String(item.phase) !== phaseFilter) return false;

  const teamFilter = normalizeFilterValue(filters.team, 'all');
  if (teamFilter !== 'all' && normalizeDockString(item.team).toLowerCase() !== teamFilter.toLowerCase()) return false;

  const clientFilter = normalizeFilterValue(filters.client, 'all');
  if (clientFilter !== 'all' && normalizeDockString(item.client).toLowerCase() !== clientFilter.toLowerCase()) return false;

  const productFilter = normalizeFilterValue(filters.product, 'all');
  if (productFilter !== 'all' && normalizeDockString(item.product).toLowerCase() !== productFilter.toLowerCase()) return false;

  const bucketFilter = normalizeFilterValue(filters.bucket, 'all');
  if (bucketFilter !== 'all' && normalizeDockString(item.bucket).toLowerCase() !== bucketFilter.toLowerCase()) return false;

  const kvFilter = normalizeFilterValue(filters.kv, 'all');
  if (kvFilter !== 'all') {
    const kvValue = normalizeDockString(item.kv_nummer || item.kvNummer || item.kv);
    if (!kvValue || kvValue.toLowerCase() !== kvFilter.toLowerCase()) return false;
  }

  if (filters.showOnlyIncomplete && item.checklistComplete) return false;
  if (filters.showOnlyNeedsAttention && !item.needsAttention) return false;

  return true;
}

function byDockPhaseThenUpdated(a, b) {
  if (a.phase !== b.phase) return a.phase - b.phase;
  const aTs = Number(a.modified || a.ts || 0);
  const bTs = Number(b.modified || b.ts || 0);
  return bTs - aTs;
}

function collectDockOptions(augmented) {
  const options = {
    teams: new Set(),
    clients: new Set(),
    products: new Set(),
    buckets: new Set(),
    kvs: new Set(),
  };

  augmented.forEach((item) => {
    if (!item || !item.show) return;
    const team = normalizeDockString(item.team);
    if (team) options.teams.add(team);
    const client = normalizeDockString(item.client);
    if (client) options.clients.add(client);
    const product = normalizeDockString(item.product);
    if (product) options.products.add(product);
    const bucket = normalizeDockString(item.bucket);
    if (bucket) options.buckets.add(bucket);
    const kv = normalizeDockString(item.kv_nummer || item.kvNummer || item.kv);
    if (kv) options.kvs.add(kv);
  });

  return {
    teams: Array.from(options.teams).sort((a, b) => a.localeCompare(b)),
    clients: Array.from(options.clients).sort((a, b) => a.localeCompare(b)),
    products: Array.from(options.products).sort((a, b) => a.localeCompare(b)),
    buckets: Array.from(options.buckets).sort((a, b) => a.localeCompare(b)),
    kvs: Array.from(options.kvs).sort((a, b) => a.localeCompare(b)),
  };
}

function fillSelectOptions(select, values, fallbackLabel) {
  if (!select) return;
  const current = select.value || 'all';
  select.innerHTML = '';
  const optAll = document.createElement('option');
  optAll.value = 'all';
  optAll.textContent = fallbackLabel || 'Alle';
  select.appendChild(optAll);

  values.forEach((value) => {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = value;
    select.appendChild(opt);
  });

  if (Array.from(select.options).some((opt) => opt.value === current)) {
    select.value = current;
  } else {
    select.value = 'all';
  }
}

function updateDockFilterOptions(augmented) {
  const options = collectDockOptions(augmented);
  fillSelectOptions(getDockTeamFilterEl(), options.teams, 'Alle Teams');
  fillSelectOptions(getDockClientFilterEl(), options.clients, 'Alle Kunden');
  fillSelectOptions(getDockProductFilterEl(), options.products, 'Alle Produkte');
  fillSelectOptions(getDockBucketFilterEl(), options.buckets, 'Alle Buckets');
  fillSelectOptions(getDockKvFilterEl(), options.kvs, 'Alle KV');
}

function updateDockStats(filtered) {
  const statsEl = getDockStatsEl();
  if (!statsEl) return;
  const total = filtered.length;
  const incomplete = filtered.filter((e) => !e.checklistComplete).length;
  const needsAttention = filtered.filter((e) => e.needsAttention).length;
  statsEl.textContent = `Deals: ${total} | Unvollständig: ${incomplete} | Attention: ${needsAttention}`;
}

function makeDockCard(item) {
  const card = document.createElement('div');
  card.className = 'dock-card';
  card.dataset.id = item.id;

  const title = escapeHtml(item.title || '(kein Titel)');
  const client = escapeHtml(item.client || '');
  const projectNumber = escapeHtml(item.projectNumber || '');
  const kv = escapeHtml(item.kv_nummer || item.kvNummer || item.kv || '');
  const budget = fmtCurr0(Number(item.amount || item.budget || 0));
  const checklist = item.checklist || {};
  const missing = [];
  if (!checklist.amount) missing.push('Budget');
  if (!checklist.hasClient) missing.push('Kunde');
  if (!checklist.hasProjectNumber) missing.push('Projekt-Nr.');
  if (!checklist.hasKv) missing.push('KV');
  if (!checklist.hasSalesContributions) missing.push('Sales');
  const missingText = missing.length ? `Fehlt: ${missing.join(', ')}` : 'Vollständig';

  card.innerHTML = `
    <div class="dock-card__header">
      <div class="dock-card__title">${title}</div>
      <div class="dock-card__meta">${client}</div>
    </div>
    <div class="dock-card__body">
      <div class="dock-card__row"><span>Projekt</span><span>${projectNumber}</span></div>
      <div class="dock-card__row"><span>KV</span><span>${kv}</span></div>
      <div class="dock-card__row"><span>Budget</span><span>${budget}</span></div>
      <div class="dock-card__row dock-card__row--check">${escapeHtml(missingText)}</div>
    </div>
    <div class="dock-card__actions">
      <button class="btn btn-sm" data-action="open">Öffnen</button>
      <button class="btn btn-sm" data-action="advance">Weiter</button>
      <button class="btn btn-sm" data-action="downgrade">Zurück</button>
    </div>
  `;

  return card;
}

function renderDockColumns(grouped) {
  const columnsEl = getDockColumnsEl();
  if (!columnsEl) return;
  columnsEl.innerHTML = '';

  DOCK_PHASES.forEach((phase) => {
    const col = document.createElement('div');
    col.className = 'dock-column';
    col.dataset.phase = String(phase);
    const header = document.createElement('div');
    header.className = 'dock-column__header';
    header.textContent = `Phase ${phase}`;
    const list = document.createElement('div');
    list.className = 'dock-column__list';
    const items = grouped.get(phase) || [];
    items.sort(byDockPhaseThenUpdated).forEach((item) => {
      list.appendChild(makeDockCard(item));
    });
    col.appendChild(header);
    col.appendChild(list);
    columnsEl.appendChild(col);
  });
}

function getEntryUpdateUrl(entryId) {
  return `${WORKER_BASE}/entries/${encodeURIComponent(entryId)}`;
}

async function updateEntry(entryId, updates, reason) {
  const url = getEntryUpdateUrl(entryId);
  const payload = {
    ...updates,
    modified: now(),
  };
  return fetchWithRetry(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }, {
    retry: 2,
    retryDelay: 500,
    context: { reason: reason || 'dock_update', entryId },
  });
}

async function updateDockPhase(entryId, targetPhase) {
  const entry = findEntryById(entryId);
  if (!entry) return null;
  const currentPhase = Number(entry.dockPhase);
  if (Number.isFinite(currentPhase) && currentPhase === targetPhase) return entry;

  const updated = {
    dockPhase: targetPhase,
    dockPhaseHistory: bumpDockPhaseHistory(entry.dockPhaseHistory, targetPhase),
  };

  const res = await updateEntry(entryId, updated, 'dock_phase_update');
  if (!res.ok) throw new Error(`Dock Phase update failed (${res.status})`);

  const saved = await res.json();
  return saved;
}

async function bulkUpdateDockPhase(entryIds, targetPhase) {
  if (!Array.isArray(entryIds) || entryIds.length === 0) return [];
  const results = [];
  for (const id of entryIds) {
    try {
      const updated = await updateDockPhase(id, targetPhase);
      results.push({ id, ok: true, updated });
    } catch (err) {
      console.error('[dock] bulk phase update failed', id, err);
      results.push({ id, ok: false, error: err.message });
    }
  }
  return results;
}

async function bulkAssignDock(entryIds, assignment) {
  if (!Array.isArray(entryIds) || entryIds.length === 0) return [];
  const results = [];
  for (const id of entryIds) {
    try {
      const res = await updateEntry(id, { dockFinalAssignment: assignment, dockFinalAssignmentAt: now() }, 'dock_assign');
      if (!res.ok) throw new Error(`Assign failed (${res.status})`);
      results.push({ id, ok: true, updated: await res.json() });
    } catch (err) {
      console.error('[dock] bulk assign failed', id, err);
      results.push({ id, ok: false, error: err.message });
    }
  }
  return results;
}

async function bulkArchiveDock(entryIds) {
  return bulkAssignDock(entryIds, 'archived');
}

async function bulkMergeDock(entryIds) {
  return bulkAssignDock(entryIds, 'merged');
}

async function bulkDeleteDock(entryIds) {
  if (!Array.isArray(entryIds) || entryIds.length === 0) return [];
  const results = [];
  for (const id of entryIds) {
    try {
      const url = getEntryUpdateUrl(id);
      const res = await fetchWithRetry(url, { method: 'DELETE' }, { retry: 2, retryDelay: 500, context: { reason: 'dock_delete', id } });
      if (!res.ok) throw new Error(`Delete failed (${res.status})`);
      results.push({ id, ok: true });
    } catch (err) {
      console.error('[dock] bulk delete failed', id, err);
      results.push({ id, ok: false, error: err.message });
    }
  }
  return results;
}

function getSelectedDockIds() {
  const selection = getDockSelection();
  if (!selection) return [];
  return Object.keys(selection).filter((id) => selection[id]);
}

function setSelectedDockId(id, selected) {
  const selection = { ...(getDockSelection() || {}) };
  if (selected) selection[id] = true;
  else delete selection[id];
  setDockSelection(selection);
}

function clearDockSelection() {
  setDockSelection({});
}

function getSelectedDockItems(current) {
  const ids = new Set(getSelectedDockIds());
  return current.filter((item) => ids.has(item.id));
}

function toggleDockCardSelection(cardEl) {
  if (!cardEl) return;
  const id = cardEl.dataset.id;
  if (!id) return;
  const selection = getDockSelection() || {};
  const selected = !!selection[id];
  setSelectedDockId(id, !selected);
  cardEl.classList.toggle('selected', !selected);
}

function applySelectionStyles(container) {
  const selection = getDockSelection() || {};
  container.querySelectorAll('.dock-card').forEach((card) => {
    const id = card.dataset.id;
    card.classList.toggle('selected', !!selection[id]);
  });
}

function clearDockAutoQueues() {
  dockAutoCheckQueue.clear();
  if (dockAutoAdvanceTimer) {
    clearTimeout(dockAutoAdvanceTimer);
    dockAutoAdvanceTimer = null;
  }
  if (dockAutoDowngradeTimer) {
    clearTimeout(dockAutoDowngradeTimer);
    dockAutoDowngradeTimer = null;
  }
}

function queueDockAutoCheck(entryId, reason) {
  if (!entryId) return;
  dockAutoCheckQueue.set(entryId, { ts: now(), reason: reason || 'auto' });
}

async function handleDockAutoCheck(entryId) {
  const entry = findEntryById(entryId);
  if (!entry) return;
  const phase = getDockPhase(entry);
  if (phase !== 3) return;
  if (!shouldDisplayInDock(entry)) {
    const hints = { ...(getDockHints() || {}) };
    if (hints[entryId]) {
      delete hints[entryId];
      setDockHints(hints);
    }
    return;
  }

  const checklist = buildDockChecklist(entry);
  const conflicts = [];
  const allEntries = getEntries() || [];
  const currentKv = normalizeDockString(entry.kv_nummer || entry.kvNummer || entry.kv);
  if (currentKv) {
    allEntries.forEach((other) => {
      if (!other || other.id === entry.id) return;
      if (!shouldDisplayInDock(other)) return;
      const otherKv = normalizeDockString(other.kv_nummer || other.kvNummer || other.kv);
      if (!otherKv) return;
      if (otherKv === currentKv) {
        conflicts.push({ id: other.id, title: other.title, client: other.client });
      }
    });
  }

  const hint = {
    checklist,
    conflicts,
    updatedAt: now(),
  };
  const hints = { ...(getDockHints() || {}) };
  hints[entryId] = hint;
  setDockHints(hints);
}

async function runDockAutoChecks() {
  const entries = Array.from(dockAutoCheckQueue.keys());
  dockAutoCheckQueue.clear();
  for (const id of entries) {
    try {
      await handleDockAutoCheck(id);
    } catch (err) {
      console.error('[dock] auto check failed', id, err);
    }
  }
}

function scheduleDockAutoAdvance(filtered) {
  if (dockAutoAdvanceTimer) clearTimeout(dockAutoAdvanceTimer);
  dockAutoAdvanceTimer = setTimeout(async () => {
    dockAutoAdvanceTimer = null;
    const selectedIds = getSelectedDockIds();
    const toAdvance = filtered.filter((item) => selectedIds.includes(item.id)).filter((item) => item.checklistComplete && item.phase < 3);
    if (!toAdvance.length) return;
    const ids = toAdvance.map((i) => i.id);
    try {
      lastAutoDockMutationAt = now();
      await bulkUpdateDockPhase(ids, 3);
      showToast('Ausgewählte Deals automatisch auf Phase 3 gesetzt', 'success');
      await reloadDock();
    } catch (err) {
      console.error('[dock] auto advance failed', err);
      showToast('Auto-Advance fehlgeschlagen', 'error');
    }
  }, 400);
}

function scheduleDockAutoDowngrade(filtered) {
  if (dockAutoDowngradeTimer) clearTimeout(dockAutoDowngradeTimer);
  dockAutoDowngradeTimer = setTimeout(async () => {
    dockAutoDowngradeTimer = null;
    const toDowngrade = filtered.filter((item) => !item.checklistComplete && item.phase > 1);
    if (!toDowngrade.length) return;

    const downgradeTargets = new Map();
    toDowngrade.forEach((item) => {
      const checklist = item.checklist || buildDockChecklist(item);
      if (item.phase === 2 && !isPhaseTwoReady(checklist)) downgradeTargets.set(item.id, 1);
      if (item.phase === 3 && !checklist.isComplete) downgradeTargets.set(item.id, 2);
    });

    if (downgradeTargets.size === 0) return;

    const tasks = Array.from(downgradeTargets.entries());
    try {
      lastAutoDockMutationAt = now();
      for (const [id, targetPhase] of tasks) {
        await updateDockPhase(id, targetPhase);
      }
      showToast('Unvollständige Deals wurden automatisch zurückgestuft', 'info');
      await reloadDock();
    } catch (err) {
      console.error('[dock] auto downgrade failed', err);
    }
  }, 700);
}

async function reloadDock() {
  if (dockReloadTimer) clearTimeout(dockReloadTimer);
  dockReloadTimer = setTimeout(async () => {
    dockReloadTimer = null;
    await renderDockBoard();
  }, 200);
}

function handleDockCardClick(e) {
  const card = e.target.closest('.dock-card');
  if (!card) return;
  const actionBtn = e.target.closest('button[data-action]');
  if (actionBtn) {
    const action = actionBtn.dataset.action;
    const id = card.dataset.id;
    if (!id) return;
    if (action === 'open') {
      openWizard(id);
      showErfassung();
    }
    if (action === 'advance') {
      const entry = findEntryById(id);
      const phase = getDockPhase(entry);
      const next = Math.min(3, phase + 1);
      updateDockPhase(id, next).then(() => reloadDock()).catch((err) => showToast(err.message, 'error'));
    }
    if (action === 'downgrade') {
      const entry = findEntryById(id);
      const phase = getDockPhase(entry);
      const prev = Math.max(1, phase - 1);
      updateDockPhase(id, prev).then(() => reloadDock()).catch((err) => showToast(err.message, 'error'));
    }
    return;
  }

  toggleDockCardSelection(card);
}

function wireDockToolbarActions(current) {
  const bulkAdvanceBtn = getDockBulkAdvanceBtn();
  const bulkDowngradeBtn = getDockBulkDowngradeBtn();
  const bulkAssignBtn = getDockBulkAssignBtn();
  const bulkArchiveBtn = getDockBulkArchiveBtn();
  const bulkMergeBtn = getDockBulkMergeBtn();
  const bulkDeleteBtn = getDockBulkDeleteBtn();

  const selectedIds = getSelectedDockIds();
  const selectedItems = getSelectedDockItems(current);
  const hasSelection = selectedItems.length > 0;

  [bulkAdvanceBtn, bulkDowngradeBtn, bulkAssignBtn, bulkArchiveBtn, bulkMergeBtn, bulkDeleteBtn].forEach((btn) => {
    if (btn) btn.disabled = !hasSelection;
  });

  if (bulkAdvanceBtn) {
    bulkAdvanceBtn.onclick = async () => {
      const ids = selectedItems.map((i) => i.id);
      withLoading(bulkAdvanceBtn, true);
      try {
        await bulkUpdateDockPhase(ids, 3);
        clearDockSelection();
        await reloadDock();
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        withLoading(bulkAdvanceBtn, false);
      }
    };
  }

  if (bulkDowngradeBtn) {
    bulkDowngradeBtn.onclick = async () => {
      const ids = selectedItems.map((i) => i.id);
      withLoading(bulkDowngradeBtn, true);
      try {
        await bulkUpdateDockPhase(ids, 1);
        clearDockSelection();
        await reloadDock();
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        withLoading(bulkDowngradeBtn, false);
      }
    };
  }

  if (bulkAssignBtn) {
    bulkAssignBtn.onclick = async () => {
      const assignment = window.prompt('Finale Zuordnung (fix/rahmen/abruf):', 'fix');
      if (!assignment) return;
      const ids = selectedItems.map((i) => i.id);
      withLoading(bulkAssignBtn, true);
      try {
        await bulkAssignDock(ids, assignment);
        clearDockSelection();
        await reloadDock();
        renderPortfolio();
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        withLoading(bulkAssignBtn, false);
      }
    };
  }

  if (bulkArchiveBtn) {
    bulkArchiveBtn.onclick = async () => {
      const ids = selectedItems.map((i) => i.id);
      withLoading(bulkArchiveBtn, true);
      try {
        await bulkArchiveDock(ids);
        clearDockSelection();
        await reloadDock();
        renderPortfolio();
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        withLoading(bulkArchiveBtn, false);
      }
    };
  }

  if (bulkMergeBtn) {
    bulkMergeBtn.onclick = async () => {
      const ids = selectedItems.map((i) => i.id);
      withLoading(bulkMergeBtn, true);
      try {
        await bulkMergeDock(ids);
        clearDockSelection();
        await reloadDock();
        renderPortfolio();
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        withLoading(bulkMergeBtn, false);
      }
    };
  }

  if (bulkDeleteBtn) {
    bulkDeleteBtn.onclick = async () => {
      const ok = window.confirm('Wirklich löschen?');
      if (!ok) return;
      const ids = selectedItems.map((i) => i.id);
      withLoading(bulkDeleteBtn, true);
      try {
        await bulkDeleteDock(ids);
        clearDockSelection();
        await reloadDock();
        renderPortfolio();
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        withLoading(bulkDeleteBtn, false);
      }
    };
  }
}

function wireDockFilters(onChange) {
  const search = getDockSearchEl();
  const phase = getDockPhaseFilterEl();
  const team = getDockTeamFilterEl();
  const client = getDockClientFilterEl();
  const product = getDockProductFilterEl();
  const bucket = getDockBucketFilterEl();
  const kv = getDockKvFilterEl();
  const conflicts = getDockConflictsToggleEl();
  const incomplete = getDockIncompleteToggleEl();
  const attention = getDockNeedsAttentionToggleEl();

  const apply = () => {
    const next = {
      ...DEFAULT_FILTERS,
      ...(getDockFilters() || {}),
      search: search ? search.value : '',
      phase: phase ? phase.value : 'all',
      team: team ? team.value : 'all',
      client: client ? client.value : 'all',
      product: product ? product.value : 'all',
      bucket: bucket ? bucket.value : 'all',
      kv: kv ? kv.value : 'all',
      showConflicts: conflicts ? parseDockBool(conflicts.checked, true) : true,
      showOnlyIncomplete: incomplete ? parseDockBool(incomplete.checked, false) : false,
      showOnlyNeedsAttention: attention ? parseDockBool(attention.checked, false) : false,
    };
    setDockFilters(next);
    if (typeof onChange === 'function') onChange(next);
  };

  [search, phase, team, client, product, bucket, kv].forEach((el) => {
    if (!el) return;
    el.oninput = debounce(apply, 200);
    el.onchange = apply;
  });

  [conflicts, incomplete, attention].forEach((el) => {
    if (!el) return;
    el.onchange = apply;
  });
}

function restoreDockFilters() {
  const filters = { ...DEFAULT_FILTERS, ...(getDockFilters() || {}) };
  const search = getDockSearchEl();
  const phase = getDockPhaseFilterEl();
  const team = getDockTeamFilterEl();
  const client = getDockClientFilterEl();
  const product = getDockProductFilterEl();
  const bucket = getDockBucketFilterEl();
  const kv = getDockKvFilterEl();
  const conflicts = getDockConflictsToggleEl();
  const incomplete = getDockIncompleteToggleEl();
  const attention = getDockNeedsAttentionToggleEl();

  if (search) search.value = filters.search || '';
  if (phase) phase.value = filters.phase || 'all';
  if (team) team.value = filters.team || 'all';
  if (client) client.value = filters.client || 'all';
  if (product) product.value = filters.product || 'all';
  if (bucket) bucket.value = filters.bucket || 'all';
  if (kv) kv.value = filters.kv || 'all';
  if (conflicts) conflicts.checked = !!filters.showConflicts;
  if (incomplete) incomplete.checked = !!filters.showOnlyIncomplete;
  if (attention) attention.checked = !!filters.showOnlyNeedsAttention;
}

function wireDockReload() {
  const btn = getDockReloadBtn();
  if (!btn) return;
  btn.onclick = () => reloadDock();
}

export async function renderDockBoard() {
  const container = ensureDockDom();
  if (!container) return;

  const currentEntries = getEntries() || [];
  const augmented = currentEntries.map(augmentDockEntry);
  updateDockFilterOptions(augmented);

  restoreDockFilters();
  const filtered = augmented.filter(matchesDockFilters);
  filtered.sort(byDockPhaseThenUpdated);

  const grouped = new Map();
  DOCK_PHASES.forEach((phase) => grouped.set(phase, []));
  filtered.forEach((item) => {
    const list = grouped.get(item.phase);
    if (list) list.push(item);
  });

  renderDockColumns(grouped);
  updateDockStats(filtered);
  wireDockToolbarActions(filtered);

  container.onclick = handleDockCardClick;
  applySelectionStyles(container);

  augmented.forEach((item) => {
    if (item.phase === 3) queueDockAutoCheck(item.id, 'render');
  });
  await runDockAutoChecks();

  if (filtered.length && now() - lastAutoDockMutationAt > 2000) {
    scheduleDockAutoDowngrade(filtered);
  }
}

export function initDockBoard() {
  wireDockFilters(() => reloadDock());
  wireDockReload();
}
