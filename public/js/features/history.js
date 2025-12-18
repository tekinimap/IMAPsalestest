import { WORKER_BASE } from '../config.js';
import { getEntries, setEntries } from '../entries-state.js';
import { fetchWithRetry } from '../api.js';
import { fmtCurr2, fmtCurr0, escapeHtml } from '../utils/format.js';
import { normalizeDockString, getDockPhase } from '../utils/dock-helpers.js';
import { showLoader, hideLoader, showToast } from '../ui/feedback.js';
import {
  getCurrentSort,
  setCurrentSort,
  getFixPagination,
  setFixPagination,
  initializeFixPageSize,
  setPendingDelete,
} from '../state/history-state.js';

const historyBody = document.getElementById('historyBody');
const omniSearch = document.getElementById('omniSearch');
const personFilter = document.getElementById('personFilter');
const btnBatchDelete = document.getElementById('btnBatchDelete');
const btnMoveToFramework = document.getElementById('btnMoveToFramework');
const checkAllFix = document.getElementById('checkAllFix');
const fixPaginationInfo = document.getElementById('fixPaginationInfo');
const fixPageIndicator = document.getElementById('fixPageIndicator');
const fixPrevPage = document.getElementById('fixPrevPage');
const fixNextPage = document.getElementById('fixNextPage');
const fixPageSizeSelect = document.getElementById('fixPageSize');
const fixSumDisplay = document.getElementById('fixSumDisplay');
const defaultFixPageSize = fixPageSizeSelect ? Number(fixPageSizeSelect.value) || 25 : 25;

let deps = {
  renderDockBoard: null,
  renderPortfolio: null,
  onEditEntry: null,
};
let isHistoryInitialized = false;

function hasPositiveDistribution(list = [], amount = 0) {
  if (!Array.isArray(list) || list.length === 0) return { sum: 0, hasPositive: false };
  const amt = Number(amount) || 0;
  let sum = 0;
  let hasPositive = false;
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    let pct = Number(item.pct);
    if (!Number.isFinite(pct) && amt > 0) {
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

function hasAnyTotals(totals) {
  if (!totals || typeof totals !== 'object') return false;
  return ['cs', 'konzept', 'pitch'].some((key) => (Number(totals[key]) || 0) > 0);
}

export function autoComplete(e) {
  if (!(e && e.client && e.title && e.amount > 0)) return false;
  const list = Array.isArray(e.list) ? e.list : [];
  if (!list.length) return false;
  const { sum, hasPositive } = hasPositiveDistribution(list, e.amount);
  if (!hasPositive) return false;
  if (sum < 99.5) return false;
  if (!hasAnyTotals(e.totals)) return false;
  return true;
}

export function filtered(type = 'fix') {
  const currentEntries = getEntries();
  let arr = currentEntries.filter((e) => (e.projectType || 'fix') === type);
  const query = omniSearch ? omniSearch.value.trim().toLowerCase() : '';
  const selectedPerson = personFilter ? personFilter.value : '';

  if (type === 'fix') {
    arr = arr.filter(shouldIncludeInFixList);
  }

  if (selectedPerson) {
    const selectedLower = selectedPerson.toLowerCase();
    arr = arr.filter((e) => (e.submittedBy || '').toLowerCase() === selectedLower);
  }

  if (query) {
    const terms = query.split(/\s+/);
    const filters = [];
    const searchTerms = [];

    terms.forEach((term) => {
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
      arr = arr.filter(
        (e) =>
          String(e.title || '').toLowerCase().includes(searchText) ||
          String(e.client || '').toLowerCase().includes(searchText) ||
          String(e.projectNumber || '').toLowerCase().includes(searchText)
      );
    }

    filters.forEach(({ key, value }) => {
      if (key === 'status') {
        const wantOk = value.startsWith('v') || value.startsWith('o');
        arr = arr.filter((e) => (wantOk ? autoComplete(e) : !autoComplete(e)));
      }
      if (key === 'quelle' || key === 'source') {
        arr = arr.filter((e) => (e.source || '').toLowerCase().startsWith(value));
      }
      if ((key === 'wert' || key === 'amount') && (value.startsWith('>') || value.startsWith('<'))) {
        const num = parseFloat(value.substring(1));
        if (!Number.isNaN(num)) {
          if (value.startsWith('>')) arr = arr.filter((e) => (e.amount || 0) > num);
          if (value.startsWith('<')) arr = arr.filter((e) => (e.amount || 0) < num);
        }
      }
    });
  }

  const activeSort = getCurrentSort();
  arr.sort((a, b) => {
    let valA;
    let valB;
    if (activeSort.key === 'ts') {
      valA = a.modified || a.ts || 0;
      valB = b.modified || b.ts || 0;
    } else if (activeSort.key === 'freigabedatum') {
      valA = a.freigabedatum || a.ts || 0;
      valB = b.freigabedatum || b.ts || 0;
    } else {
      valA = a[activeSort.key] || '';
      valB = b[activeSort.key] || '';
    }

    let comparison = 0;
    if (typeof valA === 'string' && typeof valB === 'string') {
      comparison = valA.localeCompare(valB, 'de');
    } else {
      comparison = (valA || 0) - (valB || 0);
    }
    return activeSort.direction === 'asc' ? comparison : -comparison;
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

export function updatePersonFilterOptions() {
  if (!personFilter) return;

  const currentEntries = getEntries();
  const names = new Map();

  currentEntries
    .filter((e) => (e.projectType || 'fix') === 'fix')
    .forEach((e) => {
      const name = (e.submittedBy || '').trim();
      if (name && !names.has(name.toLowerCase())) {
        names.set(name.toLowerCase(), name);
      }
    });

  const previousValue = personFilter.value || '';
  const sortedNames = Array.from(names.values()).sort((a, b) => a.localeCompare(b, 'de', { sensitivity: 'base' }));
  const options = ['<option value="">Alle Personen</option>'];
  sortedNames.forEach((name) => {
    const escaped = escapeHtml(name);
    options.push(`<option value="${escaped}">${escaped}</option>`);
  });
  personFilter.innerHTML = options.join('');

  if (previousValue) {
    const match = sortedNames.find((name) => name.toLowerCase() === previousValue.toLowerCase());
    personFilter.value = match || '';
  } else {
    personFilter.value = '';
  }
}

function resetFixPagination() {
  const { pageSize } = getFixPagination();
  setFixPagination({ page: 1, pageSize });
}

function getFixPaginationMeta(totalItems) {
  const pagination = getFixPagination();
  const totalPages = totalItems > 0 ? Math.ceil(totalItems / pagination.pageSize) : 0;
  const nextPage = totalPages > 0 ? Math.min(Math.max(pagination.page, 1), totalPages) : 1;
  setFixPagination({ page: nextPage });

  const startIndex = totalItems === 0 ? 0 : (nextPage - 1) * pagination.pageSize;
  const endIndex = totalItems === 0 ? 0 : Math.min(totalItems, startIndex + pagination.pageSize);

  return { totalPages, startIndex, endIndex };
}

function updateFixPaginationUI(totalItems, totalPages) {
  if (typeof totalPages !== 'number') {
    const { pageSize } = getFixPagination();
    totalPages = totalItems > 0 ? Math.ceil(totalItems / pageSize) : 0;
  }

  const { page, pageSize } = getFixPagination();
  const start = totalItems === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = totalItems === 0 ? 0 : Math.min(totalItems, page * pageSize);

  if (fixPaginationInfo) {
    fixPaginationInfo.textContent =
      totalItems === 0 ? 'Keine Fixaufträge gefunden.' : `Zeige ${start}–${end} von ${totalItems} Fixaufträgen`;
  }

  if (fixPageIndicator) {
    fixPageIndicator.textContent = totalPages === 0 ? 'Seite 0 / 0' : `Seite ${page} / ${totalPages}`;
  }

  if (fixPrevPage) fixPrevPage.disabled = totalItems === 0 || page <= 1;
  if (fixNextPage) fixNextPage.disabled = totalItems === 0 || page >= totalPages;
}

export function renderHistory() {
  if (!historyBody) return;
  historyBody.innerHTML = '';
  updateSortIcons();
  updatePersonFilterOptions();
  const arr = filtered('fix');
  let totalSum = 0;

  const decoratedEntries = arr.map((entry) => {
    const ok = autoComplete(entry);
    totalSum += entry.amount || 0;
    return { entry, ok };
  });

  const { totalPages, startIndex, endIndex } = getFixPaginationMeta(decoratedEntries.length);
  const pageItems = decoratedEntries.slice(startIndex, endIndex);

  const groups = {
    complete: [],
    incomplete: [],
  };

  for (const item of pageItems) {
    groups[item.ok ? 'complete' : 'incomplete'].push(item);
  }

  const createRow = (entry, ok) => {
    const statusIndicator = `<span class="status-indicator ${ok ? 'ok' : 'bad'}" aria-label="${
      ok ? 'Vollständig' : 'Unvollständig'
    }" title="${ok ? 'Vollständig' : 'Unvollständig'}">${ok ? '✓' : '!'}</span>`;
    const datum = entry.freigabedatum
      ? new Date(entry.freigabedatum).toLocaleDateString('de-DE')
      : entry.ts
        ? new Date(entry.ts).toLocaleDateString('de-DE')
        : '–';
    const safeProjectNumber = escapeHtml(entry.projectNumber || '–');
    const safeTitle = escapeHtml(entry.title || '–');
    const safeClient = escapeHtml(entry.client || '–');
    const safeSource = escapeHtml(entry.source || '–');
    const safeSubmitted = escapeHtml(entry.submittedBy || '–');
    const tr = document.createElement('tr');
    tr.innerHTML = `
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

  if (fixSumDisplay) {
    fixSumDisplay.innerHTML = `💰 <span>${fmtCurr0.format(totalSum)}</span> (gefilterte Ansicht)`;
  }
  updateFixPaginationUI(decoratedEntries.length, totalPages);
  if (checkAllFix) {
    checkAllFix.checked = false;
  }
  updateBatchButtons();
}

export function updateSortIcons() {
  document
    .querySelectorAll('#viewFixauftraege th.sortable .sort-icon')
    .forEach((icon) => {
      icon.textContent = '';
      icon.style.opacity = 0.5;
    });
  const activeSort = getCurrentSort();
  const activeTh = document.querySelector(`#viewFixauftraege th[data-sort="${activeSort.key}"] .sort-icon`);
  if (activeTh) {
    activeTh.textContent = activeSort.direction === 'asc' ? '▲' : '▼';
    activeTh.style.opacity = 1;
  }
}

export function handleDeleteClick(id, type = 'entry', parentId = null) {
  setPendingDelete({ id, type, parentId });
  const titleEl = document.getElementById('confirmDlgTitle');
  const textEl = document.getElementById('confirmDlgText');
  const confirmDlg = document.getElementById('confirmDlg');
  if (titleEl) titleEl.textContent = 'Eintrag löschen';
  if (textEl)
    textEl.textContent = `Wollen Sie den ${type === 'transaction' ? 'Abruf' : 'Eintrag'} wirklich löschen?`;
  confirmDlg?.showModal();
}

export async function loadHistory(silent = false) {
  if (!silent) {
    showLoader();
  }
  try {
    const r = await fetchWithRetry(`${WORKER_BASE}/entries`, { cache: 'no-store' });
    const fetchedEntries = r.ok ? await r.json() : [];
    setEntries(fetchedEntries);
  } catch (err) {
    console.error('Fehler in loadHistory:', err);
    setEntries([]);
    showToast('Daten konnten nicht geladen werden.', 'bad');
  } finally {
    if (!silent) {
      hideLoader();
    }
  }

  resetFixPagination();
  renderHistory();
  deps.renderDockBoard?.();
  deps.renderPortfolio?.();
}

export function getSelectedFixIds() {
  return Array.from(document.querySelectorAll('#historyBody .row-check:checked')).map((cb) => cb.dataset.id);
}

function updateBatchButtons() {
  if (!checkAllFix || !btnBatchDelete || !btnMoveToFramework) return;
  const selectedIds = getSelectedFixIds();
  if (selectedIds.length > 0) {
    btnBatchDelete.classList.remove('hide');
    btnMoveToFramework.classList.remove('hide');
    btnBatchDelete.textContent = `Markierte Löschen (${selectedIds.length})`;
    btnMoveToFramework.textContent = `Zuweisen... (${selectedIds.length})`;
  } else {
    btnBatchDelete.classList.add('hide');
    btnMoveToFramework.classList.add('hide');
  }
  checkAllFix.checked =
    selectedIds.length > 0 && selectedIds.length === document.querySelectorAll('#historyBody .row-check').length;
}

function handleOmniSearchInput() {
  resetFixPagination();
  renderHistory();
}

function handlePersonFilterChange() {
  resetFixPagination();
  renderHistory();
}

function handleFixPageSizeChange() {
  if (!fixPageSizeSelect) return;
  const parsed = Number(fixPageSizeSelect.value);
  const nextPageSize = Number.isFinite(parsed) && parsed > 0 ? parsed : 25;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    fixPageSizeSelect.value = '25';
  }
  const { page } = getFixPagination();
  setFixPagination({ page, pageSize: nextPageSize });
  resetFixPagination();
  renderHistory();
}

function handleFixPrevPage() {
  const pagination = getFixPagination();
  if (pagination.page > 1) {
    setFixPagination({ page: pagination.page - 1 });
    renderHistory();
  }
}

function handleFixNextPage() {
  const totalItems = filtered('fix').length;
  const { totalPages } = getFixPaginationMeta(totalItems);
  const pagination = getFixPagination();
  if (pagination.page < totalPages) {
    setFixPagination({ page: pagination.page + 1 });
    renderHistory();
  }
}

function handleCheckAllChange() {
  const isChecked = !!checkAllFix?.checked;
  document.querySelectorAll('#historyBody .row-check').forEach((cb) => {
    cb.checked = isChecked;
  });
  updateBatchButtons();
}

function handleHistoryBodyChange(ev) {
  if (ev.target.classList.contains('row-check')) {
    updateBatchButtons();
  }
}

function handleHistoryBodyClick(ev) {
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.getAttribute('data-id');
  const act = btn.getAttribute('data-act');
  if (act === 'edit') {
    deps.onEditEntry?.(id);
  } else if (act === 'del') {
    handleDeleteClick(id, 'entry');
  }
}

function handleSortClick(th) {
  const key = th.dataset.sort;
  const sortState = getCurrentSort();
  let nextSort;
  if (sortState.key === key) {
    nextSort = { ...sortState, direction: sortState.direction === 'asc' ? 'desc' : 'asc' };
  } else {
    const defaultDirection =
      key === 'title' || key === 'client' || key === 'source' || key === 'projectNumber' || key === 'submittedBy'
        ? 'asc'
        : 'desc';
    nextSort = { key, direction: defaultDirection };
  }
  setCurrentSort(nextSort);
  resetFixPagination();
  renderHistory();
}

export function initHistory(historyDeps = {}) {
  deps = { ...deps, ...historyDeps };
  if (isHistoryInitialized) return loadHistory(true);
  isHistoryInitialized = true;

  initializeFixPageSize(defaultFixPageSize);

  if (omniSearch) {
    omniSearch.addEventListener('input', handleOmniSearchInput);
  }
  if (personFilter) {
    personFilter.addEventListener('change', handlePersonFilterChange);
  }
  if (fixPageSizeSelect) {
    fixPageSizeSelect.addEventListener('change', handleFixPageSizeChange);
  }
  if (fixPrevPage) {
    fixPrevPage.addEventListener('click', handleFixPrevPage);
  }
  if (fixNextPage) {
    fixNextPage.addEventListener('click', handleFixNextPage);
  }
  if (checkAllFix) {
    checkAllFix.addEventListener('change', handleCheckAllChange);
  }
  if (historyBody) {
    historyBody.addEventListener('change', handleHistoryBodyChange);
    historyBody.addEventListener('click', handleHistoryBodyClick);
  }

  document.querySelectorAll('#viewFixauftraege th.sortable').forEach((th) => {
    th.addEventListener('click', () => handleSortClick(th));
  });

  return loadHistory();
}
