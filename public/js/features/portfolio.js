import { getEntries, findEntryById } from '../entries-state.js';
import { setPendingDelete } from '../state/history-state.js';
import { saveState } from '../state.js';
import { initFromState } from './erfassung.js';
import { showView } from './navigation.js';
import { formatDateForInput } from '../utils/format.js';
import { clampDockRewardFactor, DOCK_WEIGHTING_DEFAULT } from './calculations.js';
import { DEFAULT_WEIGHTS } from '../config.js';

let currentFilter = 'all';
let deps = {};
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
  if (tableBody) {
    tableBody.addEventListener('click', (e) => {
      const targetRow = e.target.closest('tr');
      if (!targetRow) return;
      const isTransactionRow = targetRow.dataset.parentId;
      const entryId = targetRow.dataset.id;
      const transId = targetRow.dataset.transId;
      const actBtn = e.target.closest('button[data-act]');
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
        } else if (action === 'del') {
          if (isTransactionRow) {
            const parentId = targetRow.dataset.parentId;
            setPendingDelete({ id: transId, type: 'transaction', parentId });
          } else {
            setPendingDelete({ id: id, type: 'entry', parentId: null });
          }
          const confirmDlg = document.getElementById('confirmDlg');
          const titleEl = document.getElementById('confirmDlgTitle');
          const textEl = document.getElementById('confirmDlgText');
          if (titleEl && textEl && confirmDlg) {
            titleEl.textContent = 'Eintrag löschen';
            textEl.textContent = `Wollen Sie den ${isTransactionRow ? 'Abruf' : 'Eintrag'} wirklich löschen?`;
            confirmDlg.showModal();
          }
        }
        e.stopPropagation();
        return;
      }

      if (isTransactionRow) {
        const parentEntry = findEntryById(targetRow.dataset.parentId);
        const transaction = parentEntry?.transactions?.find((t) => t.id === transId);
        if (transaction) {
          deps.openEditTransactionModal?.(transaction, parentEntry);
        }
        return;
      }

      if (!isTransactionRow) {
        const entry = findEntryById(entryId);
        if (entry && entry.projectType === 'rahmen') {
          const alreadyExpanded = targetRow.classList.contains('expanded');
          if (alreadyExpanded) {
            const childRows = tableBody.querySelectorAll(`tr[data-parent-id="${entryId}"]`);
            childRows.forEach((r) => r.remove());
            targetRow.classList.remove('expanded');
          } else {
            if (entry.transactions && entry.transactions.length > 0) {
              entry.transactions.sort((a, b) => {
                const dateA = a.freigabedatum || a.ts || 0;
                const dateB = b.freigabedatum || b.ts || 0;
                return dateB - dateA;
              });
              const fragment = document.createDocumentFragment();
              entry.transactions.forEach((trans) => {
                const tr = document.createElement('tr');
                tr.classList.add('transaction-row', 'clickable');
                tr.dataset.parentId = entryId;
                tr.dataset.transId = trans.id;
                let datum = '–';
                if (trans.freigabedatum) {
                  datum = new Date(trans.freigabedatum).toLocaleDateString('de-DE');
                } else if (trans.ts) {
                  datum = new Date(trans.ts).toLocaleDateString('de-DE');
                }
                tr.innerHTML = `
                  <td></td>
                  <td>${trans.kv_nummer || '–'}</td>
                  <td>${trans.type === 'founder' ? 'Passiv' : 'Aktiv'}</td>
                  <td>${trans.title || '–'}</td>
                  <td class="text-right">${fmtCurr2(trans.amount)}</td>
                  <td class="text-right">${datum}</td>
                  <td class="cell-actions">
                    <button class="iconbtn" data-act="del" data-id="${trans.id}" title="Löschen">🗑️</button>
                  </td>`;
                fragment.appendChild(tr);
              });
              if (targetRow.nextSibling) {
                tableBody.insertBefore(fragment, targetRow.nextSibling);
              } else {
                tableBody.appendChild(fragment);
              }
            }
            targetRow.classList.add('expanded');
          }
        }
      }
    });
  }
}

export function renderPortfolio() {
  const entries = getEntries() || [];
  const searchInput = document.getElementById('portfolioSearch');
  const query = searchInput ? searchInput.value.trim().toLowerCase() : '';
  let filteredEntries = entries;

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

  filteredEntries.sort(comparePortfolioEntries);

  const frag = document.createDocumentFragment();
  for (const entry of filteredEntries) {
    const isFramework = entry.projectType === 'rahmen';
    const tr = document.createElement('tr');
    tr.dataset.id = entry.id;
    tr.classList.add(isFramework ? 'entry-rahmen' : 'entry-fix');
    const typeSymbol = isFramework ? 'R' : 'F';
    let budgetCellContent = '';
    if (isFramework) {
      const { total, used, pct } = getFrameworkUsage(entry);
      const ratio = total > 0 ? used / total : 0;
      const barColorClass = ratio > 1 ? 'bad' : ratio > 0.8 ? 'warn' : 'ok';
      budgetCellContent = `
        <div class="progress-bar">
          <div class="progress-fill ${barColorClass}" style="width:${Math.min(pct, 100)}%;"></div>
        </div>
        <small>${fmtCurr2(used)} / ${fmtCurr2(total)}</small>`;
    } else {
      budgetCellContent = fmtCurr2(entry.amount);
    }
    let statusContent = '';
    if (!isFramework) {
      const complete = autoComplete(entry);
      statusContent = `<span class="status-indicator ${complete ? 'ok' : 'bad'}">${complete ? '✓' : '!'}</span>`;
    } else {
      const { pct } = getFrameworkUsage(entry);
      statusContent = `${pct || 0} %`;
    }
    tr.innerHTML = `
      <td>${typeSymbol}</td>
      <td>${escapeHtml(entry.projectNumber) || '–'}</td>
      <td>${escapeHtml(entry.title) || '–'}</td>
      <td>${escapeHtml(entry.client) || '–'}</td>
      <td class="text-right">${budgetCellContent}</td>
      <td class="text-right">${statusContent}</td>
      <td class="cell-actions">
        <button class="iconbtn" data-act="edit" data-id="${entry.id}" title="Bearbeiten">✏️</button>
        <button class="iconbtn" data-act="del" data-id="${entry.id}" title="Löschen">🗑️</button>
      </td>`;
    frag.appendChild(tr);
  }
  tbody.appendChild(frag);
  updatePortfolioSortIcons();
}

function comparePortfolioEntries(a, b) {
  const direction = sortState.direction === 'asc' ? 1 : -1;
  const key = sortState.key;
  const aVal = getSortValue(a, key);
  const bVal = getSortValue(b, key);

  if (typeof aVal === 'string' && typeof bVal === 'string') {
    return aVal.localeCompare(bVal) * direction;
  }
  if (aVal === bVal) return 0;
  return (aVal > bVal ? 1 : -1) * direction;
}

function getSortValue(entry, key) {
  switch (key) {
    case 'type':
      return entry.projectType === 'rahmen' ? 1 : 0;
    case 'projectNumber':
      return (entry.projectNumber || '').toString().toLowerCase();
    case 'title':
      return (entry.title || '').toString().toLowerCase();
    case 'client':
      return (entry.client || '').toString().toLowerCase();
    case 'budget':
      return Number(entry.amount) || 0;
    case 'status':
      if (entry.projectType === 'rahmen') {
        return getFrameworkUsage(entry).pct;
      }
      return autoComplete(entry) ? 1 : 0;
    default:
      return (entry.title || '').toString().toLowerCase();
  }
}

function getFrameworkUsage(entry) {
  const total = entry.amount || 0;
  const used = (entry.transactions || []).reduce((sum, t) => sum + (t.amount || 0), 0);
  const pct = total > 0 ? Math.round((used / total) * 100) : 0;
  return { total, used, pct };
}

function updatePortfolioSortIcons() {
  document.querySelectorAll('#viewPortfolio th.sortable .sort-icon').forEach((icon) => {
    icon.textContent = '';
    icon.style.opacity = 0.5;
  });

  const activeIcon = document.querySelector(`#viewPortfolio th[data-sort="${sortState.key}"] .sort-icon`);
  if (activeIcon) {
    activeIcon.textContent = sortState.direction === 'asc' ? '▲' : '▼';
    activeIcon.style.opacity = 1;
  }
}

function escapeHtml(str) {
  return str
    ? str.toString().replace(/[&<>"']/g, (s) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s] || s))
    : '';
}

function fmtCurr2(value) {
  const num = Number(value) || 0;
  return new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
  }).format(num);
}

function autoComplete(e) {
  if (!(e && e.client && e.title && e.amount > 0)) return false;
  const list = Array.isArray(e.list) ? e.list : [];
  if (!list.length) return false;
  let sumPct = 0;
  let hasPositive = false;
  for (const item of list) {
    let pct = Number(item.pct);
    const amt = Number(e.amount) || 0;
    if (!Number.isFinite(pct) && amt > 0) {
      const money = Number(item.money);
      if (Number.isFinite(money)) pct = (money / amt) * 100;
    }
    if (!Number.isFinite(pct)) pct = 0;
    if (pct > 0.0001) hasPositive = true;
    sumPct += pct;
  }
  if (!hasPositive) return false;
  if (sumPct < 99.5) return false;
  if (!(e.totals && (e.totals.cs || e.totals.konzept || e.totals.pitch))) return false;
  return true;
}

function editEntryById(entryId) {
  const e = findEntryById(entryId);
  if (!e) return;
  const st = {
    source: e.source || 'manuell',
    editingId: e.id,
    input: {
      client: e.client || '',
      title: e.title || '',
      amount: e.amount || 0,
      amountKnown: !!(e.amount && e.amount > 0),
      projectType: e.projectType || 'fix',
      submittedBy: e.submittedBy || '',
      projectNumber: e.projectNumber || '',
      kvNummer: e.kv_nummer || '',
      freigabedatum: formatDateForInput(e.freigabedatum || e.ts),
      ts: e.ts || Date.now(),
      rows: Array.isArray(e.rows) && e.rows.length
        ? e.rows
        : Array.isArray(e.list)
          ? e.list.map((x) => ({ name: x.name, cs: 0, konzept: 0, pitch: 0 }))
          : [],
      weights: Array.isArray(e.weights)
        ? e.weights
        : [
            { key: 'cs', weight: DEFAULT_WEIGHTS.cs },
            { key: 'konzept', weight: DEFAULT_WEIGHTS.konzept },
            { key: 'pitch', weight: DEFAULT_WEIGHTS.pitch },
          ],
      dockRewardFactor: clampDockRewardFactor(e.dockRewardFactor ?? DOCK_WEIGHTING_DEFAULT),
    },
  };
  saveState(st);
  initFromState(true);
  const dockEntryDialog = document.getElementById('dockEntryDialog');
  if (dockEntryDialog && !dockEntryDialog.open) {
    try {
      dockEntryDialog.showModal();
    } catch (err) {
      /* ignoriert */
    }
  }
  showView('erfassung');
}
