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
let sortState = { key: 'title', direction: PORTFOLIO_SORT_DEFAULTS.title };

export function initPortfolio(portfolioDeps = {}) {
  deps = portfolioDeps;

  const filterContainer = document.getElementById('portfolioFilters');
  if (filterContainer) {
    filterContainer.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-filter]');
      if (!btn) return;
      currentFilter = btn.dataset.filter;
      Array.from(filterContainer.querySelectorAll('button')).forEach((b) =>
        b.classList.remove('accent', 'ok', 'warn')
      );
      if (currentFilter === 'all') {
        btn.classList.add('accent');
      } else if (currentFilter === 'critical') {
        btn.classList.add('warn');
      } else {
        btn.classList.add('accent');
      }
      renderPortfolio();
    });
  }

  const searchInput = document.getElementById('portfolioSearch');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      renderPortfolio();
    });
  }

  const showArchivedToggle = document.getElementById('portfolioShowArchived');
  if (showArchivedToggle) {
    showArchivedFrameworks = !!showArchivedToggle.checked;
    showArchivedToggle.addEventListener('change', () => {
      showArchivedFrameworks = !!showArchivedToggle.checked;
      renderPortfolio();
    });
  }

  document.querySelectorAll('#viewPortfolio th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (!key) return;
      if (sortState.key === key) {
        sortState = { key, direction: sortState.direction === 'asc' ? 'desc' : 'asc' };
      } else {
        const defaultDirection = PORTFOLIO_SORT_DEFAULTS[key] || 'asc';
        sortState = { key, direction: defaultDirection };
      }
      renderPortfolio();
    });
  });

  const tableBody = document.getElementById('portfolioBody');
  const portfolioView = document.getElementById('viewPortfolio');
  const clickTarget = tableBody || portfolioView;
  if (clickTarget) {
    clickTarget.addEventListener('click', (event) => handlePortfolioClick(event, tableBody));
  }
}

function handlePortfolioClick(e, tableBody) {
  const targetRow = e.target.closest('tr');
  if (!targetRow || (tableBody && !tableBody.contains(targetRow))) return;
  const isTransactionRow = targetRow.dataset.parentId;
  const entryId = targetRow.dataset.id;
  const transId = targetRow.dataset.transId;
  const actBtn = e.target.closest('[data-act]');

  if (actBtn) {
    const action = actBtn.dataset.act;
    const id = actBtn.dataset.id;
    if (action === 'edit') {
      if (isTransactionRow) {
        const parentId = targetRow.dataset.parentId;
        const parentEntry = findEntryById(parentId);
        if (!parentEntry) return;
        const transaction = (parentEntry.transactions || []).find((t) => t.id === transId);
        if (!transaction) return;
        deps.openEditTransactionModal?.(transaction, parentEntry);
      } else {
        editEntryById(id);
      }
    } else if (action === 'edit-volume') {
      e.preventDefault();
      e.stopPropagation(); 

      const id = actBtn.dataset.id;
      if (!id) return;

      const entry = findEntryById(id);
      if (!entry) return;

      if (typeof deps.openFrameworkVolumeDialog === 'function') {
        try {
          deps.openFrameworkVolumeDialog(entry, (vol) => {
            if (typeof deps.onUpdateFrameworkVolume === 'function') {
              deps.onUpdateFrameworkVolume(entry, vol);
            }
          });
        } catch (err) {
          console.error(err);
        }
      }
    } else if (action === 'del') {
      const id = actBtn.dataset.id;
      const parentId = targetRow.dataset.parentId;
      if (isTransactionRow && parentId && transId) {
        const parentEntry = findEntryById(parentId);
        if (!parentEntry) return;
        const transaction = (parentEntry.transactions || []).find((t) => t.id === transId);
        if (!transaction) return;
        deps.openDeleteTransactionModal?.(transaction, parentEntry);
      } else {
        const entry = findEntryById(id);
        if (!entry) return;
        setPendingDelete(entry);
      }
    }
  } else if (entryId) {
    if (isTransactionRow) {
      const parentId = targetRow.dataset.parentId;
      const parentEntry = findEntryById(parentId);
      if (!parentEntry) return;
      const transaction = (parentEntry.transactions || []).find((t) => t.id === transId);
      if (!transaction) return;
      deps.openEditTransactionModal?.(transaction, parentEntry);
    } else {
      editEntryById(entryId);
    }
  }
}

function editEntryById(id) {
  const entry = findEntryById(id);
  if (!entry) return;
  openWizard(entry);
}

function fmtCurr2(amount) {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(amount || 0);
}

function fmtInt(amount) {
  return new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 }).format(amount || 0);
}

function getFrameworkUsage(entry) {
  const total = Number(entry.amount || 0);
  const transactions = entry.transactions || [];
  const used = transactions.reduce((sum, t) => sum + Number(t.amount || 0), 0);
  return { total, used };
}

function updatePortfolioSortIcons() {
  document.querySelectorAll('#viewPortfolio th.sortable').forEach((th) => {
    th.classList.remove('sorted-asc', 'sorted-desc');
    const key = th.dataset.sort;
    if (key && sortState.key === key) {
      th.classList.add(sortState.direction === 'asc' ? 'sorted-asc' : 'sorted-desc');
    }
  });
}

function sortEntries(entries) {
  const { key, direction } = sortState;
  const dir = direction === 'asc' ? 1 : -1;

  return [...entries].sort((a, b) => {
    let va = a[key];
    let vb = b[key];
    if (key === 'budget') {
      va = Number(a.amount || 0);
      vb = Number(b.amount || 0);
    }
    if (key === 'status') {
      va = a.dockFinalAssignment || '';
      vb = b.dockFinalAssignment || '';
    }

    if (va == null && vb == null) return 0;
    if (va == null) return -1 * dir;
    if (vb == null) return 1 * dir;
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
    return String(va).localeCompare(String(vb), 'de') * dir;
  });
}

function renderPortfolioRow(e, fragment) {
  const tr = document.createElement('tr');
  tr.dataset.id = e.id;

  const typeLabel =
    e.projectType === 'rahmen' ? 'Rahmenvertrag' : e.projectType === 'abruf' ? 'Abruf' : 'Fix';
  const projectNumber = e.projectNumber || '–';
  const title = e.title || '–';
  const client = e.client || '–';
  const amount = Number(e.amount || 0);
  const status = e.dockFinalAssignment ? e.dockFinalAssignment : 'Portfolio';

  const amountCell =
    e.projectType === 'rahmen'
      ? (() => {
          const { total, used } = getFrameworkUsage(e);
          const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
          return `${fmtCurr2(used)} / ${fmtCurr2(total)} (${pct}%)`;
        })()
      : fmtCurr2(amount);

  const actions = `
    <button class="iconbtn" data-act="edit" data-id="${e.id}" title="Bearbeiten">✏️</button>
    ${
      e.projectType === 'rahmen'
        ? `<button class="iconbtn" data-act="edit-volume" data-id="${e.id}" title="Volumen ändern">📦</button>`
        : ''
    }
    <button class="iconbtn" data-act="del" data-id="${e.id}" title="Löschen">🗑️</button>
  `;

  tr.innerHTML = `
    <td>${typeLabel}</td>
    <td>${projectNumber}</td>
    <td>${title}</td>
    <td>${client}</td>
    <td class="text-right">${amountCell}</td>
    <td>${status}</td>
    <td class="cell-actions">${actions}</td>
  `;

  fragment.appendChild(tr);
}

export function renderPortfolio() {
  const entries = getEntries() || [];
  const searchInput = document.getElementById('portfolioSearch');
  const query = searchInput ? searchInput.value.trim().toLowerCase() : '';
  
  let filteredEntries = entries.filter((e) => {
    // 1. DOCK FILTER
    const isGraduated = !!e.dockFinalAssignment; 
    const isHubSpot = (e.source || '').trim().toLowerCase() === 'hubspot';
    const phase = Number(e.dockPhase);
    const isPortfolioPhase = Number.isFinite(phase) && phase >= 4;
    const hasDockPhase = e.dockPhase != null;
    const isInDock = !isGraduated && !isPortfolioPhase && (isHubSpot || hasDockPhase);
    
    if (isInDock) return false;
    
    // 2. ARCHIV FILTER
    const isArchived = e.isArchived === true;
    if (!showArchivedFrameworks && isArchived) return false;

    return showArchivedFrameworks || e.projectType !== 'rahmen' || !isArchived;
  });

  if (currentFilter === 'fix') {
    filteredEntries = filteredEntries.filter((e) => (e.projectType || 'fix') === 'fix');
  } else if (currentFilter === 'rahmen') {
    filteredEntries = filteredEntries.filter((e) => e.projectType === 'rahmen');
  } else if (currentFilter === 'critical') {
    filteredEntries = filteredEntries.filter((e) => {
      if (e.projectType !== 'rahmen') return false;
      const { total, used } = getFrameworkUsage(e);
      return total > 0 && used / total > 0.8;
    });
  }

  if (query) {
    filteredEntries = filteredEntries.filter((e) => {
      const fields = [e.title || '', e.client || '', e.projectNumber || '', e.kv_nummer || ''].join(' ').toLowerCase();
      let transFields = '';
      if (e.transactions && e.transactions.length) {
        transFields = e.transactions
          .map((t) => `${t.kv_nummer || ''} ${t.title || ''}`)
          .join(' ')
          .toLowerCase();
      }
      return fields.includes(query) || transFields.includes(query);
    });
  }

  filteredEntries = sortEntries(filteredEntries);

  const tbody = document.getElementById('portfolioBody');
  const emptyState = document.getElementById('portfolioEmptyState');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (filteredEntries.length === 0) {
    if (emptyState) emptyState.classList.remove('hide');
    updatePortfolioSortIcons();
    return;
  }

  if (emptyState) emptyState.classList.add('hide');

  const fragment = document.createDocumentFragment();
  filteredEntries.forEach((e) => renderPortfolioRow(e, fragment));
  tbody.appendChild(fragment);
  updatePortfolioSortIcons();
}
