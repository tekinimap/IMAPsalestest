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

export function initPortfolio(options = {}) {
  deps = options || {};
  const filterEl = document.getElementById('portfolioFilter');
  const searchEl = document.getElementById('portfolioSearch');
  const toggleArchivedEl = document.getElementById('portfolioToggleArchived');
  const sortSelect = document.getElementById('portfolioSort');

  if (filterEl) {
    filterEl.onchange = () => {
      currentFilter = filterEl.value;
      renderPortfolio();
    };
  }

  if (searchEl) {
    searchEl.oninput = () => renderPortfolio();
  }

  if (toggleArchivedEl) {
    toggleArchivedEl.onchange = () => {
      showArchivedFrameworks = !!toggleArchivedEl.checked;
      renderPortfolio();
    };
  }

  if (sortSelect) {
    sortSelect.onchange = () => {
      const [key, direction] = (sortSelect.value || 'title:asc').split(':');
      sortState = { key, direction };
      renderPortfolio();
    };
  }
}

function compare(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), 'de');
}

function sortEntries(entries) {
  const { key, direction } = sortState || { key: 'title', direction: 'asc' };
  const dir = direction === 'desc' ? -1 : 1;
  return [...entries].sort((a, b) => dir * compare(a?.[key], b?.[key]));
}

function formatType(entry) {
  const type = (entry.projectType || '').toLowerCase();
  if (type === 'rahmen') return 'Rahmen';
  if (type === 'abruf') return 'Abruf';
  return 'Fix';
}

function formatStatus(entry) {
  if (entry.isArchived) return 'Archiv';
  if (entry.dockFinalAssignment) return String(entry.dockFinalAssignment);
  return 'Aktiv';
}

function normalizeString(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

function entryMatchesSearch(entry, q) {
  if (!q) return true;
  const hay = [
    entry.title,
    entry.client,
    entry.projectNumber,
    entry.kv_nummer,
    entry.kvNummer,
    entry.kv,
    entry.dealId,
  ].map((v) => normalizeString(v).toLowerCase()).join(' ');
  return hay.includes(q);
}

function getTableBody() {
  return document.querySelector('#portfolioTable tbody');
}

function clearTableBody(body) {
  if (!body) return;
  body.innerHTML = '';
}

function buildRow(entry) {
  const tr = document.createElement('tr');
  tr.dataset.id = entry.id;

  const type = formatType(entry);
  const status = formatStatus(entry);
  const client = entry.client || '';
  const title = entry.title || '';
  const projectNumber = entry.projectNumber || '';
  const budget = Number(entry.amount || entry.budget || 0);

  tr.innerHTML = `
    <td>${type}</td>
    <td>${projectNumber}</td>
    <td>${title}</td>
    <td>${client}</td>
    <td style="text-align:right;">${budget.toLocaleString('de-DE')}</td>
    <td>${status}</td>
    <td style="white-space:nowrap;">
      <button class="btn btn-sm" data-action="open">Öffnen</button>
      <button class="btn btn-sm btn-danger" data-action="delete">Löschen</button>
    </td>
  `;
  return tr;
}

function wireRowActions(body) {
  if (!body) return;
  body.onclick = (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const tr = btn.closest('tr');
    const id = tr?.dataset?.id;
    if (!id) return;

    if (action === 'open') {
      openWizard(id);
      return;
    }

    if (action === 'delete') {
      const entry = findEntryById(id);
      if (!entry) return;
      const ok = window.confirm(`Wirklich löschen? "${entry.title || id}"`);
      if (!ok) return;
      setPendingDelete({ id, title: entry.title || '' });
      if (deps?.onDelete) deps.onDelete(id);
      return;
    }
  };
}

export function renderPortfolio() {
  const entries = getEntries() || [];
  const searchInput = document.getElementById('portfolioSearch');
  const query = searchInput ? searchInput.value.trim().toLowerCase() : '';
  
  let filteredEntries = entries.filter((e) => {
    if (!e || !e.id) return false;

    // 1. Dock-Deals ausblenden (Portfolio soll nur Portfolio sein)
    const isGraduated = Boolean(e.dockFinalAssignment);

    const source = (e.source || '').trim().toLowerCase();
    const isHubSpot = source === 'hubspot';
    const isErpImport = source === 'erp-import';

    const phase = Number(e.dockPhase);
    const hasDockPhase = e.dockPhase != null && Number.isFinite(phase);
    const isPortfolioPhase = hasDockPhase && phase >= 4;

    const isInDock = !isGraduated && !isPortfolioPhase && !isErpImport && (isHubSpot || hasDockPhase);

    if (isInDock) return false;
    
    // 2. ARCHIV FILTER
    const isArchived = e.isArchived === true;
    if (!showArchivedFrameworks && isArchived) return false;

    return showArchivedFrameworks || e.projectType !== 'rahmen' || !isArchived;
  });

  if (currentFilter === 'fix') {
    filteredEntries = filteredEntries.filter((e) => (e.projectType || '').toLowerCase() === 'fix');
  } else if (currentFilter === 'rahmen') {
    filteredEntries = filteredEntries.filter((e) => (e.projectType || '').toLowerCase() === 'rahmen');
  } else if (currentFilter === 'abruf') {
    filteredEntries = filteredEntries.filter((e) => (e.projectType || '').toLowerCase() === 'abruf');
  }

  if (query) {
    filteredEntries = filteredEntries.filter((e) => entryMatchesSearch(e, query));
  }

  filteredEntries = sortEntries(filteredEntries);

  const body = getTableBody();
  if (!body) return;

  clearTableBody(body);
  const fragment = document.createDocumentFragment();
  filteredEntries.forEach((entry) => {
    fragment.appendChild(buildRow(entry));
  });
  body.appendChild(fragment);

  wireRowActions(body);
}
