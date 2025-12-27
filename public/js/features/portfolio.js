import { getEntries, findEntryById } from '../entries-state.js';
import { setPendingDelete } from '../state/history-state.js';
import { openWizard } from './erfassung.js';

let currentFilter = 'all';
let deps = {};
let showArchivedFrameworks = false;
const PORTFOLIO_SORT_DEFAULTS = {
  type: 'asc',
  projectNumber: 'asc',
  title: 'asc',
  client: 'asc',
  budget: 'desc',
  status: 'desc',
};

let portfolioSortState = { ...PORTFOLIO_SORT_DEFAULTS };

function getSortValue(entry, key) {
  switch (key) {
    case 'type':
      return (entry.projectType || '').toLowerCase();
    case 'projectNumber':
      return (entry.projectNumber || '').toLowerCase();
    case 'title':
      return (entry.title || '').toLowerCase();
    case 'client':
      return (entry.client || '').toLowerCase();
    case 'budget':
      return Number(entry.amount || entry.budget || 0);
    case 'status':
      return entry.complete ? 1 : 0;
    default:
      return '';
  }
}

function sortEntries(entries) {
  const sortKeys = Object.keys(portfolioSortState);

  return entries.sort((a, b) => {
    for (const key of sortKeys) {
      const dir = portfolioSortState[key];
      if (!dir) continue;
      const va = getSortValue(a, key);
      const vb = getSortValue(b, key);
      if (va < vb) return dir === 'asc' ? -1 : 1;
      if (va > vb) return dir === 'asc' ? 1 : -1;
    }
    return 0;
  });
}

function entryMatchesSearch(entry, query) {
  if (!query) return true;
  const haystack = [
    entry.projectNumber,
    entry.title,
    entry.client,
    entry.kv_nummer,
    entry.kvNummer,
    entry.kv,
    entry.source,
  ]
    .filter(Boolean)
    .map((x) => String(x).toLowerCase());

  return haystack.some((x) => x.includes(query));
}

function renderSortButtons() {
  const container = document.getElementById('portfolioSort');
  if (!container) return;

  const setBtnState = (btn, state) => {
    btn.classList.toggle('active', Boolean(state));
    btn.setAttribute('aria-pressed', Boolean(state));
    const label = btn.getAttribute('data-label') || btn.textContent;
    btn.textContent = state ? `${label} ${state === 'asc' ? '↑' : '↓'}` : label;
  };

  container.querySelectorAll('button[data-sort]').forEach((btn) => {
    const key = btn.getAttribute('data-sort');
    setBtnState(btn, portfolioSortState[key]);
  });
}

function toggleSort(key) {
  const current = portfolioSortState[key];
  const next = current === 'asc' ? 'desc' : current === 'desc' ? null : 'asc';
  portfolioSortState[key] = next;
  renderPortfolio();
}

function attachSortListeners() {
  const container = document.getElementById('portfolioSort');
  if (!container) return;

  container.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-sort]');
    if (!btn) return;
    const key = btn.getAttribute('data-sort');
    if (!key) return;
    toggleSort(key);
  });
}

function renderFilterButtons() {
  const btnAll = document.getElementById('btnPortfolioAll');
  const btnFix = document.getElementById('btnPortfolioFix');
  const btnRahmen = document.getElementById('btnPortfolioRahmen');

  if (btnAll) btnAll.classList.toggle('active', currentFilter === 'all');
  if (btnFix) btnFix.classList.toggle('active', currentFilter === 'fix');
  if (btnRahmen) btnRahmen.classList.toggle('active', currentFilter === 'rahmen');
}

function setFilter(filter) {
  currentFilter = filter;
  renderPortfolio();
}

function attachFilterListeners() {
  document.getElementById('btnPortfolioAll')?.addEventListener('click', () => setFilter('all'));
  document.getElementById('btnPortfolioFix')?.addEventListener('click', () => setFilter('fix'));
  document.getElementById('btnPortfolioRahmen')?.addEventListener('click', () => setFilter('rahmen'));

  const toggleArchive = document.getElementById('toggleArchiveFrameworks');
  if (toggleArchive) {
    toggleArchive.addEventListener('change', (e) => {
      showArchivedFrameworks = Boolean(e.target.checked);
      renderPortfolio();
    });
  }
}

function attachSearchListener() {
  document.getElementById('portfolioSearch')?.addEventListener('input', () => renderPortfolio());
}

function renderPortfolioTable(entries) {
  const tbody = document.getElementById('portfolioTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  entries.forEach((entry) => {
    const tr = document.createElement('tr');
    tr.dataset.id = entry.id;

    const typeLabel = entry.projectType === 'rahmen' ? 'Rahmen' : 'Fix';
    const budget = Number(entry.amount || entry.budget || 0);
    const budgetText = budget ? new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(budget) : '—';
    const status = entry.complete ? 'vollständig' : 'unvollständig';
    const title = entry.title || '—';
    const client = entry.client || '—';
    const pn = entry.projectNumber || '—';

    tr.innerHTML = `
      <td>${typeLabel}</td>
      <td>${pn}</td>
      <td>${title}</td>
      <td>${client}</td>
      <td>${budgetText}</td>
      <td>${status}</td>
      <td style="white-space:nowrap;">
        <button class="btn btn-sm port-open">Öffnen</button>
        <button class="btn btn-sm warn port-del">Löschen</button>
      </td>
    `;

    tbody.appendChild(tr);
  });
}

function attachTableListeners() {
  const tbody = document.getElementById('portfolioTableBody');
  if (!tbody) return;

  tbody.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    const id = tr.getAttribute('data-id');
    if (!id) return;

    if (e.target.closest('.port-open')) {
      const entry = findEntryById(id);
      if (entry) openWizard(entry);
      return;
    }

    if (e.target.closest('.port-del')) {
      const entry = findEntryById(id);
      if (!entry) return;
      setPendingDelete(entry);
      document.getElementById('confirmDlgTitle').textContent = 'Eintrag löschen';
      document.getElementById('confirmDlgText').textContent = `Wollen Sie "${entry.title || entry.projectNumber || entry.id}" wirklich löschen?`;
      document.getElementById('confirmDlg').showModal();
    }
  });
}

export function initPortfolio(initDeps = {}) {
  deps = initDeps || {};
  attachFilterListeners();
  attachSearchListener();
  attachSortListeners();
}

export function renderPortfolio() {
  const entries = (getEntries() || []).slice();

  const searchInput = document.getElementById('portfolioSearch');
  const query = searchInput ? searchInput.value.trim().toLowerCase() : '';

  let filteredEntries = entries.filter((e) => {
    // 1. DOCK FILTER
    const isGraduated = !!e.dockFinalAssignment;
    const isHubSpot = (e.source || '').trim().toLowerCase() === 'hubspot';

    const phaseNum = Number(e.dockPhase);
    const isActiveDockPhase = Number.isFinite(phaseNum) && phaseNum >= 1 && phaseNum <= 3;

    // "Im Dock" bedeutet nur: HubSpot-Deals (ohne Phase 4) oder explizit Phase 1-3.
    // Phase 4+ soll im Portfolio bleiben.
    const isInDock = !isGraduated && (isActiveDockPhase || (isHubSpot && e.dockPhase == null));

    if (isInDock) return false;

    // 2. ARCHIV FILTER
    const isArchived = e.isArchived === true;
    if (!showArchivedFrameworks && isArchived) return false;

    return true;
  });

  // Filter (all/fix/rahmen)
  if (currentFilter === 'fix') {
    filteredEntries = filteredEntries.filter((e) => (e.projectType || 'fix') === 'fix');
  } else if (currentFilter === 'rahmen') {
    filteredEntries = filteredEntries.filter((e) => e.projectType === 'rahmen');
  }

  // Search
  filteredEntries = filteredEntries.filter((e) => entryMatchesSearch(e, query));

  // Sort
  sortEntries(filteredEntries);

  renderFilterButtons();
  renderSortButtons();
  renderPortfolioTable(filteredEntries);
  attachTableListeners();
}
