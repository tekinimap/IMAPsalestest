import { getEntries } from '../entries-state.js';
import { fmtCurr0, fmtPct } from '../utils/format.js';

let deps = {};
let currentFilter = 'all';
let currentSearch = '';

export function initPortfolio(dependencies) {
  deps = dependencies;

  const filterContainer = document.getElementById('portfolioFilters');
  if (filterContainer) {
    filterContainer.addEventListener('click', (e) => {
      if (e.target.matches('.dock-pill')) {
        // Update active state
        filterContainer.querySelectorAll('.dock-pill').forEach(btn => btn.classList.remove('accent'));
        e.target.classList.add('accent');

        currentFilter = e.target.dataset.filter;
        renderPortfolio();
      }
    });
  }

  const searchInput = document.getElementById('portfolioSearch');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      currentSearch = e.target.value.toLowerCase().trim();
      renderPortfolio();
    });
  }
}

export function renderPortfolio() {
  const tbody = document.getElementById('portfolioBody');
  const emptyState = document.getElementById('portfolioEmptyState');
  if (!tbody) return;

  tbody.innerHTML = '';

  const entries = getEntries();
  const filtered = entries.filter(entry => {
    // 1. Type Filter
    const type = entry.projectType || 'fix';
    if (currentFilter === 'fix' && type !== 'fix') return false;
    if (currentFilter === 'rahmen' && type !== 'rahmen') return false;

    // 2. Critical Filter (Budget > 80%)
    if (currentFilter === 'critical') {
      if (type !== 'rahmen') return false;
      const { utilization } = calculateBudget(entry);
      if (utilization <= 80) return false;
    }

    // 3. Search
    if (currentSearch) {
      const searchFields = [
        entry.title,
        entry.client,
        entry.projectNumber,
        entry.kv_nummer || entry.kv,
        entry.submittedBy
      ];

      if (entry.transactions && Array.isArray(entry.transactions)) {
        entry.transactions.forEach(t => {
          searchFields.push(t.kv_nummer);
          searchFields.push(t.title);
          searchFields.push(t.projectNumber);
        });
      }

      const searchStr = searchFields.join(' ').toLowerCase();

      if (!searchStr.includes(currentSearch)) return false;
    }

    return true;
  });

  if (filtered.length === 0) {
    emptyState?.classList.remove('hide');
    return;
  }

  emptyState?.classList.add('hide');

  filtered.sort((a, b) => (b.modified || b.ts || 0) - (a.modified || a.ts || 0));

  filtered.forEach(entry => {
    const type = entry.projectType || 'fix';
    if (type === 'rahmen') {
      renderRahmenRow(tbody, entry);
    } else {
      renderFixRow(tbody, entry);
    }
  });
}

function calculateBudget(entry) {
  const total = entry.amount || 0; // Total budget from framework contract
  const transactions = entry.transactions || [];
  const used = transactions.reduce((sum, t) => sum + (t.amount || 0), 0);
  const utilization = total > 0 ? (used / total) * 100 : 0;
  return { total, used, utilization };
}

function renderFixRow(tbody, entry) {
  const tr = document.createElement('tr');
  tr.className = 'portfolio-row fix-row';
  tr.innerHTML = `
    <td><span class="dock-pill">Fix</span></td>
    <td>${entry.projectNumber || '–'}</td>
    <td>${entry.title || '–'}</td>
    <td>${entry.client || '–'}</td>
    <td class="text-right">${fmtCurr0.format(entry.amount || 0)}</td>
    <td class="text-right">
       ${entry.complete ? '<span class="status-icon ok">✓</span>' : '<span class="status-icon missing">!</span>'}
    </td>
    <td></td>
  `;
  tbody.appendChild(tr);
}

function renderRahmenRow(tbody, entry) {
  const { total, used, utilization } = calculateBudget(entry);
  let colorClass = 'bg-green-500';
  if (utilization > 80) colorClass = 'bg-yellow-500';
  if (utilization > 100) colorClass = 'bg-red-500';

  const tr = document.createElement('tr');
  tr.className = 'portfolio-row rahmen-row clickable';
  tr.dataset.id = entry.id;

  tr.innerHTML = `
    <td><span class="dock-pill accent">Rahmen</span></td>
    <td>${entry.projectNumber || '–'}</td>
    <td>${entry.title || '–'}</td>
    <td>${entry.client || '–'}</td>
    <td class="text-right">
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:2px">
        <span style="font-size:12px;color:var(--muted)">${fmtCurr0.format(used)} / ${fmtCurr0.format(total)}</span>
        <div style="width:80px;height:4px;background:#1e293b;border-radius:2px;overflow:hidden">
           <div style="width:${Math.min(utilization, 100)}%;height:100%;" class="${colorClass}"></div>
        </div>
      </div>
    </td>
    <td class="text-right">
      <span style="font-size:12px">${fmtPct.format(utilization / 100)}</span>
    </td>
    <td class="text-center">
      <button class="iconbtn toggle-details">▼</button>
    </td>
  `;

  tr.addEventListener('click', () => toggleDetails(tr, entry));
  tbody.appendChild(tr);
}

function toggleDetails(row, entry) {
  const next = row.nextElementSibling;
  if (next && next.classList.contains('details-row')) {
    next.remove();
    row.classList.remove('expanded');
    return;
  }

  row.classList.add('expanded');
  const detailsRow = document.createElement('tr');
  detailsRow.className = 'details-row';

  const transactions = entry.transactions || [];

  let transHtml = '';
  if (transactions.length === 0) {
    transHtml = '<div class="p-4 text-muted text-sm">Keine Abrufe vorhanden.</div>';
  } else {
    transHtml = `
      <table class="w-full" style="font-size:13px;background:var(--panel2)">
        <thead>
          <tr style="color:var(--muted)">
            <th class="text-left p-2">KV-Nummer</th>
            <th class="text-left p-2">Titel</th>
            <th class="text-right p-2">Betrag</th>
            <th class="text-right p-2">Datum</th>
          </tr>
        </thead>
        <tbody>
          ${transactions.map(t => `
            <tr>
              <td class="p-2 border-b border-white/5">${t.kv_nummer || '–'}</td>
              <td class="p-2 border-b border-white/5">${t.title || '–'}</td>
              <td class="p-2 border-b border-white/5 text-right">${fmtCurr0.format(t.amount || 0)}</td>
              <td class="p-2 border-b border-white/5 text-right">${t.freigabedatum ? new Date(t.freigabedatum).toLocaleDateString() : '–'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  detailsRow.innerHTML = `
    <td colspan="7" style="padding:0">
      <div class="details-content" style="border-left:4px solid var(--accent);background:var(--panel2)">
        ${transHtml}
      </div>
    </td>
  `;

  row.parentNode.insertBefore(detailsRow, row.nextSibling);
}
