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
import { people, loadSession, loadPeople, findPersonByName, findPersonByEmail } from './features/people.js';
import { initErfassung, initFromState } from './features/erfassung.js';
import { compute } from './features/compute.js';
import { initAdminModule, handleAdminClick as handleAdminDataLoad, populateAdminTeamOptions } from './features/admin.js';
import {
  calculateActualDistribution,
  clampDockRewardFactor,
  DOCK_WEIGHTING_DEFAULT,
  getEntryRewardFactor,
} from './features/calculations.js';
import { initNavigation, isViewVisible, showView } from './features/navigation.js';
import { initCommonEvents } from './features/common-events.js';
import { initPortfolio, renderPortfolio } from './features/portfolio.js';
import {
  autoComplete,
  filtered,
  getSelectedFixIds,
  handleDeleteClick,
  initHistory,
  loadHistory,
  renderHistory,
} from './features/history.js';
import { clearDockSelection, getPendingDockAbrufAssignment, setPendingDockAbrufAssignment } from './state/dock-state.js';
import {
  initDockBoard,
  renderDockBoard,
  queueDockAutoCheck,
  findDockKvConflict,
  finalizeDockAbruf,
  hideManualPanel,
  requestDockEntryDialogClose,
  openFrameworkVolumeDialog,
  showManualPanel,
  clearInputFields,
  getFrameworkVolume,
  dockEntryDialog,
  getDockPhase,
} from './features/dock-board.js';
import {
  getPendingDelete,
  setPendingDelete,
  resetPendingDelete,
} from './state/history-state.js';
import { getAnalyticsData, setAnalyticsData, getTrendData, setTrendData } from './state/analytics-state.js';
import {
  getCurrentFrameworkEntryId,
  setCurrentFrameworkEntryId,
  getEditingTransactionId,
  setEditingTransactionId,
} from './state/framework-state.js';

export async function handleAdminClick() {
  await handleAdminDataLoad();
  showView('admin');
}

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

function handleFixauftraegeNavigation() {
  showView('fixauftraege');
  loadHistory(true);
}

function handlePortfolioNavigation() {
  showView('portfolio');
  loadHistory(true).then(renderPortfolio);
}

function handleRahmenNavigation() {
  showView('rahmen');
  loadHistory(true).then(renderFrameworkContracts);
}

function handleAnalyticsNavigation() {
  showView('analytics');
  loadHistory(true).then(initAnalytics);
}

function clearEditingState() {
  const state = loadState();
  if (!state || !state.editingId) return state;

  const { editingId, ...rest } = state;
  saveState(rest);
  return rest;
}

function closeOpenDialogs() {
  document.querySelectorAll('dialog[open]').forEach((dialog) => {
    try {
      dialog.close();
    } catch (err) {
      console.warn('Dialog konnte nicht geschlossen werden.', err);
    }
  });
}

function handleErfassungNavigation() {
  clearEditingState();

  if (getHasUnsavedChanges()) {
    const confirmed = confirm('Ungespeicherte Änderungen gehen verloren. Möchtest du fortfahren?');
    if (!confirmed) return;
    setHasUnsavedChanges(false);
  }

  loadHistory().then(() => {
    closeOpenDialogs();
    hideManualPanel();
    renderDockBoard();
    showView('erfassung');
  });
}

export function setupNavigation() {
  initNavigation({
    getIsBatchRunning,
    showToast,
    hideBatchProgress,
    onShowPortfolio: handlePortfolioNavigation,
    onShowAnalytics: handleAnalyticsNavigation,
    onShowAdmin: handleAdminClick,
    onShowErfassung: handleErfassungNavigation,
  });
}
/* ---------- Übersicht & Rahmenverträge ---------- */
const rahmenSearch = document.getElementById('rahmenSearch');
const btnXlsx = document.getElementById('btnXlsx');
const btnBatchDelete = document.getElementById('btnBatchDelete');
const btnMoveToFramework = document.getElementById('btnMoveToFramework');
const entries = getEntries();

if (rahmenSearch) {
  rahmenSearch.addEventListener('input', renderFrameworkContracts);
}

// PASSWORTFREI: Batch-Löschung
if (btnBatchDelete) {
  btnBatchDelete.addEventListener('click', () => {
    const selectedIds = getSelectedFixIds();
    if (selectedIds.length === 0) return;

    setPendingDelete({ ids: selectedIds, type: 'batch-entry' });
    document.getElementById('confirmDlgTitle').textContent = `Einträge löschen`;
    document.getElementById('confirmDlgText').textContent =
      `Wollen Sie die ${selectedIds.length} markierten Einträge wirklich löschen?`;
    document.getElementById('confirmDlg').showModal();
  });
}


function editEntry(id) {
  const e = entries.find(x => x.id === id); if (!e) return;
  const st = {
    source: e.source || 'manuell', editingId: e.id,
    input: {
      client: e.client || '', title: e.title || '', amount: e.amount || 0, amountKnown: e.amount > 0, projectType: e.projectType || 'fix', submittedBy: e.submittedBy || '', projectNumber: e.projectNumber || '', kvNummer: e.kv_nummer || '',
      freigabedatum: formatDateForInput(e.freigabedatum || e.ts), ts: e.ts,
      rows: Array.isArray(e.rows) && e.rows.length ? e.rows : (Array.isArray(e.list) ? e.list.map(x => ({ name: x.name, cs: 0, konzept: 0, pitch: 0 })) : []),
      weights: Array.isArray(e.weights) ? e.weights : [{ key: 'cs', weight: DEFAULT_WEIGHTS.cs }, { key: 'konzept', weight: DEFAULT_WEIGHTS.konzept }, { key: 'pitch', weight: DEFAULT_WEIGHTS.pitch }],
      dockRewardFactor: clampDockRewardFactor(e.dockRewardFactor ?? DOCK_WEIGHTING_DEFAULT)
    }
  };
  saveState(st);
  initFromState(true);
  showView('erfassung');
  showManualPanel(e.id);
}

document.getElementById('btnNo').addEventListener('click', () => document.getElementById('confirmDlg').close());
// *** NEU: btnYes click handler (mit bulk-delete) ***
document.getElementById('btnYes').addEventListener('click', async () => {
  const { id, ids, type, parentId, fromDock } = getPendingDelete();
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
      renderPortfolio();

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
        clearDockSelection();
        renderDockBoard();
      }
      renderPortfolio();
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
      renderPortfolio();
    }
  } catch (e) {
    showToast('Aktion fehlgeschlagen.', 'bad');
    console.error(e);
  } finally {
    hideLoader();
    hideBatchProgress();
    resetPendingDelete();
  }
});


/* Export XLSX */
if (btnXlsx) {
  btnXlsx.addEventListener('click', () => {
    const arr = filtered('fix').map(e => ({
      Projektnummer: e.projectNumber || '', Titel: e.title || '', Auftraggeber: e.client || '', Quelle: e.source || '',
      Status: autoComplete(e) ? 'vollständig' : 'unvollständig', Wert_EUR: e.amount || 0,
      Abschlussdatum: e.freigabedatum ? new Date(e.freigabedatum).toISOString().split('T')[0] : (e.ts ? new Date(e.ts).toISOString().split('T')[0] : '')
    }));
    const ws = XLSX.utils.json_to_sheet(arr);
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Fixaufträge");
    XLSX.writeFile(wb, "fixauftraege_export.xlsx");
  });
}

/* Rahmenverträge */
const rahmenBody = document.getElementById('rahmenBody');

function filteredFrameworks() {
  let arr = entries.filter(e => e.projectType === 'rahmen');
  const query = rahmenSearch ? rahmenSearch.value.trim().toLowerCase() : '';
  if (!rahmenSearch) return arr.sort((a, b) => (b.modified || b.ts) - (a.modified || a.ts));
  if (!query) return arr.sort((a, b) => (b.modified || b.ts) - (a.modified || a.ts));

  return arr.filter(e => {
    if (String(e.projectNumber || '').toLowerCase().includes(query)) return true;
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
  if (!rahmenBody) return;
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
  const sumDisplay = document.getElementById('rahmenSumDisplay');
  if (sumDisplay) {
    sumDisplay.innerHTML = `💰 <span>${fmtCurr0.format(totalSum)}</span> (Summe aller Abrufe)`;
  }
}

if (rahmenBody) {
  rahmenBody.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (btn) {
      e.stopPropagation(); // Stop click from bubbling to the row
      const act = btn.dataset.act;
      const id = btn.dataset.id;
      const entry = entries.find(en => en.id === id);
      if (!entry) return;

      if (act === 'founder-plus') {
        openEditTransactionModal({ type: 'founder' }, entry);
      } else if (act === 'hunter-plus') {
        saveState({ source: 'manuell', isAbrufMode: true, parentEntry: entry, input: { projectNumber: entry.projectNumber || '', freigabedatum: getTodayDate() } });
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
}


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
    id: `trans_${Date.now()}_${st.input.kvNummer.replace(/\s/g, '')}`,
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
    const assignmentId = st.dockAssignmentId || getPendingDockAbrufAssignment()?.entry?.id;
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

function renderRahmenDetails(id) {
  const entry = entries.find(e => e.id === id);
  if (!entry) return;
  setCurrentFrameworkEntryId(id);

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
  (entry.transactions || []).sort((a, b) => (b.freigabedatum || b.ts) - (a.freigabedatum || a.ts)).forEach(trans => {
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
    handleDeleteClick(transId, 'transaction', getCurrentFrameworkEntryId());
    return;
  }

  if (row) {
    const transId = row.dataset.transId;
    const parentEntry = entries.find(e => e.id === getCurrentFrameworkEntryId());
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

if (btnMoveToFramework) {
  btnMoveToFramework.addEventListener('click', () => {
    const selectedIds = getSelectedFixIds();
    if (selectedIds.length === 0) return;

    moveValidationSummary.textContent = '';
    document.getElementById('moveDlgCountLabel').textContent = `Sie sind dabei, ${selectedIds.length} Auftrag/Aufträge zuzuweisen.`;

    const rahmenEntries = entries.filter(e => e.projectType === 'rahmen').sort((a, b) => a.title.localeCompare(b.title));
    moveTargetFramework.innerHTML = '<option value="">-- Bitte Rahmenvertrag wählen --</option>';
    rahmenEntries.forEach(e => {
      const opt = document.createElement('option');
      opt.value = e.id;
      opt.textContent = `${e.title} (${e.client})`;
      moveTargetFramework.appendChild(opt);
    });

    moveToFrameworkDlg.showModal();
  });
}

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
  setCurrentFrameworkEntryId(parentEntry.id);
  setEditingTransactionId(transaction.id || null); // null for new founder transaction
  const editingTransactionId = getEditingTransactionId();

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

    const weights = transaction.weights || [{ key: 'cs', weight: DEFAULT_WEIGHTS.cs }, { key: 'konzept', weight: DEFAULT_WEIGHTS.konzept }, { key: 'pitch', weight: DEFAULT_WEIGHTS.pitch }];
    const m = Object.fromEntries(weights.map(w => [w.key, w.weight]));
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
  const parentEntry = entries.find(e => e.id === getCurrentFrameworkEntryId());
  if (!parentEntry) return;

  const editingTransactionId = getEditingTransactionId();
  const transIndex = editingTransactionId ? parentEntry.transactions.findIndex(t => t.id === editingTransactionId) : -1;

  let transaction = (transIndex > -1) ? JSON.parse(JSON.stringify(parentEntry.transactions[transIndex])) : {}; // Deep copy to avoid modifying original on error
  let validationError = '';

  if (!editHunterTransView.classList.contains('hide')) { // Saving a Hunter transaction
    const rows = readRows('#editTbody');
    const weights = [
      { key: 'cs', weight: toInt0(editW_cs.value) },
      { key: 'konzept', weight: toInt0(editW_konzept.value) },
      { key: 'pitch', weight: toInt0(editW_pitch.value) }
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
    if (!editFounderKvNummer.value) validationError = 'KV-Nummer ist erforderlich.';
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
    transaction.id = `trans_${Date.now()}_${transaction.kv_nummer.replace(/\s/g, '')}`;
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
    renderRahmenDetails(getCurrentFrameworkEntryId());
    renderFrameworkContracts(); // Update list view sum
    const pendingAssignment = getPendingDockAbrufAssignment();
    if (pendingAssignment?.mode === 'founder' && pendingAssignment.entry?.id) {
      await finalizeDockAbruf(pendingAssignment.entry.id);
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
  setCurrentFrameworkEntryId(entry.id);
  document.getElementById('editFwValidationSummary').textContent = '';
  editFwClient.value = entry.client || '';
  editFwTitle.value = entry.title || '';
  editFwProjectNumber.value = entry.projectNumber || '';

  const weights = entry.weights || [{ key: 'cs', weight: DEFAULT_WEIGHTS.cs }, { key: 'konzept', weight: DEFAULT_WEIGHTS.konzept }, { key: 'pitch', weight: DEFAULT_WEIGHTS.pitch }];
  const m = Object.fromEntries(weights.map(w => [w.key, w.weight]));
  editFwW_cs.value = m.cs ?? DEFAULT_WEIGHTS.cs;
  editFwW_konzept.value = m.konzept ?? DEFAULT_WEIGHTS.konzept;
  editFwW_pitch.value = m.pitch ?? DEFAULT_WEIGHTS.pitch;

  editFwTbody.innerHTML = '';
  (entry.rows || []).forEach(r => addEditRow(r, '#editFwTbody'));
  editFrameworkContractDlg.showModal();
}

document.getElementById('btnSaveFrameworkContract').addEventListener('click', async () => {
  const entry = entries.find(e => e.id === getCurrentFrameworkEntryId());
  if (!entry) return;

  const rows = readRows('#editFwTbody');
  const weights = [
    { key: 'cs', weight: toInt0(editFwW_cs.value) },
    { key: 'konzept', weight: toInt0(editFwW_konzept.value) },
    { key: 'pitch', weight: toInt0(editFwW_pitch.value) }
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
  entry.list = resultData.list.map(({ key, name, pct }) => ({ key, name, pct })); // Save only pct, not money
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
      if (document.getElementById('viewRahmenDetails').classList.contains('hide') === false) {
        renderRahmenDetails(getCurrentFrameworkEntryId()); // Update details if visible
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
          kvIndex.set(kvNummer, { type: 'fix', entry: newFixEntry }); // Füge zum Index hinzu
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
        if (method === 'PUT' && !entry.id) {
          throw new Error(`Versuch, Eintrag ohne ID zu aktualisieren (KV: ${entry.kv_nummer || 'unbekannt'})`);
        }

        console.log(`Sending ${method} request to ${url} for KV ${entry.kv_nummer}`); // Debugging-Ausgabe

        const r = await fetchWithRetry(url, {
          method: method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(entry)
        });
        if (!r.ok) throw new Error(`Fehler (${method} ${url}) für Eintrag ${entry.id || ('(neu mit KV ' + entry.kv_nummer + ')')}: ${await r.text()}`);
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
  const legacyWeights = [{ key: 'cs', weight: 100 }, { key: 'konzept', weight: 0 }, { key: 'pitch', weight: 0 }];

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
          entryToUpdate.totals = { cs: 100, konzept: 0, pitch: 0 };
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
const anaTogglePersonWeighting = document.getElementById('anaTogglePersonWeighting');
const anaToggleTeamWeighting = document.getElementById('anaToggleTeamWeighting');
const anaMarketTeamFilter = document.getElementById('anaMarketTeamFilter');
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

let anaPersonWeightingEnabled = false;
let anaTeamWeightingEnabled = false;
let anaMarketTeamOptions = [];

const closeMarketTeamPanel = () => {
  const panel = anaMarketTeamFilter?.querySelector('.multi-select-panel');
  const trigger = anaMarketTeamFilter?.querySelector('.multi-select-trigger');
  panel?.classList.remove('is-open');
  trigger?.classList.remove('is-open');
};

function updateMarketTeamLabel() {
  if (!anaMarketTeamFilter) return;
  const labelEl = anaMarketTeamFilter.querySelector('.multi-select-chip');
  if (!labelEl) return;
  const selected = getSelectedMarketTeams();
  if (!selected.length || selected.length === anaMarketTeamOptions.length) {
    labelEl.textContent = 'Alle Market Teams';
    return;
  }
  if (selected.length <= 2) {
    labelEl.textContent = selected.join(', ');
    return;
  }
  const head = selected.slice(0, 2).join(', ');
  labelEl.textContent = `${head} +${selected.length - 2}`;
}

function populateMarketTeamFilter() {
  if (!anaMarketTeamFilter) return;
  const teams = Array.isArray(TEAMS) ? TEAMS.filter(Boolean) : [];
  anaMarketTeamOptions = teams;
  anaMarketTeamFilter.innerHTML = '';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'multi-select-trigger';
  const label = document.createElement('span');
  label.className = 'multi-select-chip';
  label.textContent = 'Alle Market Teams';
  const caret = document.createElement('span');
  caret.className = 'multi-select-caret';
  trigger.append(label, caret);

  const panel = document.createElement('div');
  panel.className = 'multi-select-panel';

  teams.forEach((team) => {
    const opt = document.createElement('label');
    opt.className = 'multi-select-option';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = team;
    cb.checked = true;
    const text = document.createElement('span');
    text.textContent = team;
    opt.append(cb, text);
    panel.appendChild(opt);
  });

  trigger.addEventListener('click', () => {
    const isOpen = panel.classList.toggle('is-open');
    trigger.classList.toggle('is-open', isOpen);
  });

  panel.addEventListener('change', (ev) => {
    if (ev.target && ev.target.matches('input[type="checkbox"]')) {
      updateMarketTeamLabel();
      renderContributionCharts();
    }
  });

  anaMarketTeamFilter.append(trigger, panel);
  updateMarketTeamLabel();
}

function getSelectedMarketTeams() {
  if (!anaMarketTeamFilter) return [];
  return Array.from(anaMarketTeamFilter.querySelectorAll('input[type="checkbox"]:checked') || [])
    .map((input) => input.value)
    .filter(Boolean);
}

function initAnalytics() {
  // Fülle Jahres-Dropdown (für Top-Listen)
  const currentYear = new Date().getFullYear();
  anaYear.innerHTML = '';
  for (let y = 2022; y <= currentYear + 1; y++) {
    const o = document.createElement('option'); o.value = String(y); o.textContent = String(y); anaYear.appendChild(o);
  }
  anaYear.value = String(currentYear);

  populateMarketTeamFilter();
  anaPersonWeightingEnabled = Boolean(anaTogglePersonWeighting?.checked);
  anaTeamWeightingEnabled = Boolean(anaToggleTeamWeighting?.checked);

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

if (anaTogglePersonWeighting) {
  anaTogglePersonWeighting.addEventListener('change', () => {
    anaPersonWeightingEnabled = anaTogglePersonWeighting.checked;
    renderContributionCharts();
  });
}

if (anaToggleTeamWeighting) {
  anaToggleTeamWeighting.addEventListener('change', () => {
    anaTeamWeightingEnabled = anaToggleTeamWeighting.checked;
    renderContributionCharts();
  });
}

document.addEventListener('click', (ev) => {
  if (!anaMarketTeamFilter) return;
  if (anaMarketTeamFilter.contains(ev.target)) return;
  closeMarketTeamPanel();
});

document.getElementById('anaRefresh').addEventListener('click', renderAnalytics); // Jährliche Auswertung
const btnAnaXlsx = document.getElementById('btnAnaXlsx');

function capturePositions(host) {
  const map = new Map();
  if (!host) return map;
  host.querySelectorAll('[data-key]').forEach((el) => {
    const rect = el.getBoundingClientRect();
    map.set(el.dataset.key, rect);
  });
  return map;
}

function captureSegmentWidths(host) {
  const map = new Map();
  if (!host) return map;
  host.querySelectorAll('.weighted-row').forEach((row) => {
    const key = row.dataset.key;
    if (!key) return;
    const actual = row.querySelector('.weighted-actual');
    const delta = row.querySelector('.weighted-delta');
    const prev = {};
    if (actual && actual.style.width) prev.actual = parseFloat(actual.style.width) || 0;
    if (delta && delta.style.width) prev.delta = parseFloat(delta.style.width) || 0;
    if (delta && delta.style.left) prev.left = parseFloat(delta.style.left) || 0;
    if (Object.keys(prev).length) {
      map.set(key, prev);
    }
  });
  return map;
}

function animatePositionChanges(host, previousRects) {
  if (!host || !previousRects || previousRects.size === 0) return;
  requestAnimationFrame(() => {
    host.querySelectorAll('[data-key]').forEach((el) => {
      const key = el.dataset.key;
      const prev = previousRects.get(key);
      if (!prev) return;
      const next = el.getBoundingClientRect();
      const dx = prev.left - next.left;
      const dy = prev.top - next.top;
      if (dx || dy) {
        el.animate(
          [
            { transform: `translate(${dx}px, ${dy}px)` },
            { transform: 'translate(0, 0)' },
          ],
          { duration: 350, easing: 'ease-out' }
        );
      }
    });
  });
}

function renderWeightedBars(hostOrId, items = [], options = {}) {
  const host = typeof hostOrId === 'string' ? document.getElementById(hostOrId) : hostOrId;
  if (!host) return;
  const showWeighting = Boolean(options.showWeighting);
  const list = Array.isArray(items) ? items : [];
  const filtered = typeof options.filterFn === 'function' ? list.filter(options.filterFn) : list;
  const ranked = filtered
    .map((item, idx) => ({ ...item, __idx: idx }))
    .filter((item) => (item.actual || 0) > 0 || (item.weighted || 0) > 0)
    .sort((a, b) => (showWeighting ? (b.weighted || 0) - (a.weighted || 0) : (b.actual || 0) - (a.actual || 0)));

  const maxValue = ranked.reduce(
    (max, item) => Math.max(max, Number(item.actual) || 0, Number(item.weighted) || 0),
    0
  ) || 1;

  const prevRects = capturePositions(host);
  const prevWidths = captureSegmentWidths(host);
  host.innerHTML = '';
  if (!ranked.length) {
    const empty = document.createElement('div');
    empty.className = 'log-metrics-empty';
    empty.textContent = options.emptyMessage || 'Keine Daten verfügbar.';
    host.appendChild(empty);
    return;
  }

  ranked.forEach((item, index) => {
    const actual = Math.max(0, Number(item.actual) || 0);
    const weighted = Math.max(0, Number(item.weighted) || 0);
    const delta = weighted - actual;
    const baseValue = showWeighting && weighted < actual ? weighted : actual;
    const baseWidth = Math.max(6, (baseValue / maxValue) * 100);
    const deltaWidth = showWeighting ? Math.max(0, Math.min(100, (Math.abs(delta) / maxValue) * 100)) : 0;
    const totalValue = showWeighting ? weighted : actual;
    const targetBaseWidth = Math.min(baseWidth, 100);
    const targetDeltaLeft = Math.max(0, Math.min(baseWidth, 100));
    const targetDeltaWidth = showWeighting ? deltaWidth : 0;

    const prev = prevWidths.get(options.getKey ? options.getKey(item) : item.name || String(item.__idx));
    const initialBaseWidth = typeof prev?.actual === 'number' ? prev.actual : targetBaseWidth;
    const initialDeltaWidth = typeof prev?.delta === 'number' ? prev.delta : 0;
    const initialDeltaLeft = typeof prev?.left === 'number' ? prev.left : targetDeltaLeft;

    const row = document.createElement('div');
    row.className = 'weighted-row';
    row.dataset.key = options.getKey ? options.getKey(item) : item.name || String(item.__idx);

    const meta = document.createElement('div');
    meta.className = 'weighted-meta';
    const rank = document.createElement('span');
    rank.className = 'weighted-rank';
    rank.textContent = String(index + 1);
    const name = document.createElement('span');
    name.className = 'weighted-name';
    const label = options.getLabel ? options.getLabel(item) : item.name || '–';
    name.textContent = label;
    name.title = label;
    meta.append(rank, name);

    if (options.getBadge) {
      const badgeText = options.getBadge(item);
      if (badgeText) {
        const badge = document.createElement('span');
        badge.className = 'weighted-team';
        badge.textContent = badgeText;
        meta.appendChild(badge);
      }
    }

    const track = document.createElement('div');
    track.className = 'weighted-track';

    const actualFill = document.createElement('div');
    actualFill.className = 'weighted-segment weighted-actual';
    actualFill.style.width = `${initialBaseWidth}%`;
    const actualLabel = document.createElement('span');
    actualLabel.className = 'weighted-segment-label';
    actualLabel.textContent = fmtCurr0.format(actual);
    actualFill.appendChild(actualLabel);

    const deltaFill = document.createElement('div');
    deltaFill.className = `weighted-segment weighted-delta${delta < 0 ? ' negative' : ''}`;
    deltaFill.style.width = `${initialDeltaWidth}%`;
    deltaFill.style.left = `${initialDeltaLeft}%`;
    deltaFill.classList.toggle('collapsed', !showWeighting || targetDeltaWidth === 0);
    const deltaLabel = document.createElement('span');
    deltaLabel.className = 'weighted-segment-label';
    deltaFill.appendChild(deltaLabel);

    track.append(actualFill, deltaFill);

    const total = document.createElement('div');
    total.className = 'weighted-total';
    total.textContent = fmtCurr0.format(totalValue);

    row.append(meta, track, total);
    host.appendChild(row);

    const syncDeltaLabel = () => {
      const labelText = showWeighting && targetDeltaWidth > 0
        ? `${delta >= 0 ? '+' : '-'}${fmtCurr0.format(Math.abs(delta))}`
        : '';
      deltaLabel.textContent = labelText;
      deltaLabel.style.display = labelText ? 'inline-flex' : 'none';
      deltaFill.classList.remove('label-outside');
      deltaLabel.classList.remove('outside-left', 'outside-right');
      if (!labelText) return;

      const trackWidth = track.getBoundingClientRect().width;
      const targetDeltaPx = (targetDeltaWidth / 100) * trackWidth;
      const currentDeltaPx = deltaFill.getBoundingClientRect().width;
      const available = Math.max(currentDeltaPx, targetDeltaPx);
      const needed = deltaLabel.getBoundingClientRect().width + 10;
      const useOutside = available < needed;
      deltaFill.classList.toggle('label-outside', useOutside);
      if (useOutside) {
        if (delta >= 0) {
          deltaLabel.classList.add('outside-right');
        } else {
          deltaLabel.classList.add('outside-left');
        }
      }
    };

    requestAnimationFrame(() => {
      actualFill.style.width = `${targetBaseWidth}%`;
      const deltaLeft = Math.max(0, Math.min(targetDeltaLeft, 100));
      deltaFill.style.left = `${deltaLeft}%`;
      deltaFill.style.width = `${targetDeltaWidth}%`;
      deltaFill.classList.toggle('collapsed', !showWeighting || targetDeltaWidth === 0);
      syncDeltaLabel();
      requestAnimationFrame(syncDeltaLabel);
    });
  });

  animatePositionChanges(host, prevRects);
}

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
  const endOfYear = getTimestamp(`${year}-12-31T23:59:59.999`);

  const byNameTeam = new Map((Array.isArray(people) ? people : []).map((p) => [p.name, p.team || '']));
  const personStats = new Map();
  const teamStats = new Map();
  const entryBreakdown = [];
  let fixTotal = 0;
  let fixWeightedTotal = 0;
  let rahmenTotal = 0;
  let rahmenWeightedTotal = 0;

  const addPersonStat = (rawName, amount, factor) => {
    const money = Number(amount) || 0;
    if (money <= 0) return;
    const ratio = clampDockRewardFactor(factor);
    const name = rawName || 'Unbekannt';
    const weighted = money * ratio;
    const teamName = byNameTeam.get(name) || 'Ohne Team';
    const person = personStats.get(name) || { name, team: teamName, actual: 0, weighted: 0 };
    person.actual += money;
    person.weighted += weighted;
    person.team = person.team || teamName;
    personStats.set(name, person);
    const team = teamStats.get(teamName) || { name: teamName, actual: 0, weighted: 0 };
    team.actual += money;
    team.weighted += weighted;
    teamStats.set(teamName, team);
  };

  const eligibleEntries = getEntries().filter((entry) => {
    const finalAssignment = String(entry?.dockFinalAssignment || '').toLowerCase();
    const hasDockProcess = entry?.dockPhase != null || Boolean(finalAssignment);
    if (!hasDockProcess) return true;

    const phase = getDockPhase(entry);
    const isFinal = ['fix', 'rahmen', 'abruf'].includes(finalAssignment);
    return phase === 3 && isFinal;
  });

  eligibleEntries.forEach((entry) => {
    const datum = entry.freigabedatum || entry.ts || 0;
    const factor = getEntryRewardFactor(entry);
    if (entry.projectType === 'fix') {
      if (!(datum >= startOfYear && datum <= endOfYear)) return;
      const actualAmount = Number(entry.amount) || 0;
      if (actualAmount <= 0) return;
      const weightedAmount = actualAmount * factor;
      fixTotal += actualAmount;
      fixWeightedTotal += weightedAmount;
      entryBreakdown.push({
        id: entry.id,
        type: 'fix',
        title: entry.title || '–',
        actual: actualAmount,
        weighted: weightedAmount,
      });
      if (Array.isArray(entry.list)) {
        entry.list.forEach((contributor) => {
          addPersonStat(contributor?.name || 'Unbekannt', contributor?.money || 0, factor);
        });
      }
    } else if (entry.projectType === 'rahmen') {
      const transactions = (entry.transactions || []).filter((trans) => {
        const d = trans.freigabedatum || trans.ts || 0;
        return d >= startOfYear && d <= endOfYear;
      });

      transactions.forEach((trans) => {
        const amount = Number(trans.amount) || 0;
        if (amount <= 0) return;
        const transactionFactor = clampDockRewardFactor(
          trans?.dockRewardFactor ?? entry?.dockRewardFactor ?? DOCK_WEIGHTING_DEFAULT
        );
        const weightedAmount = amount * transactionFactor;

        rahmenTotal += amount;
        rahmenWeightedTotal += weightedAmount;
        entryBreakdown.push({
          id: trans.id,
          parentId: entry.id,
          type: 'abruf',
          title: trans.title || entry.title || '–',
          actual: amount,
          weighted: weightedAmount,
        });

        if (trans.type === 'founder') {
          (entry.list || []).forEach((founder) => {
            const pct = Number(founder?.pct) || 0;
            const money = amount * (pct / 100);
            addPersonStat(founder?.name || 'Unbekannt', money, transactionFactor);
          });
        } else if (trans.type === 'hunter') {
          const founderShareAmount = amount * (FOUNDER_SHARE_PCT / 100);
          (entry.list || []).forEach((founder) => {
            const pct = Number(founder?.pct) || 0;
            const money = founderShareAmount * (pct / 100);
            addPersonStat(founder?.name || 'Unbekannt', money, transactionFactor);
          });
          (trans.list || []).forEach((hunter) => {
            addPersonStat(hunter?.name || 'Unbekannt', hunter?.money || 0, transactionFactor);
          });
        }
      });
    }
  });

  const personList = Array.from(personStats.values())
    .map((item) => ({
      ...item,
      factor: item.actual > 0 ? item.weighted / item.actual : 0,
    }))
    .filter((item) => item.actual > 0)
    .sort((a, b) => b.weighted - a.weighted);

  const teamList = Array.from(teamStats.values())
    .filter((item) => item.actual > 0)
    .map((item) => ({
      ...item,
      factor: item.actual > 0 ? item.weighted / item.actual : 0,
    }))
    .sort((a, b) => b.weighted - a.weighted);

  const totalArr = [
    { name: 'Fixaufträge', actual: fixTotal, weighted: fixWeightedTotal },
    { name: 'Rahmenverträge', actual: rahmenTotal, weighted: rahmenWeightedTotal },
    { name: 'Gesamt', actual: fixTotal + rahmenTotal, weighted: fixWeightedTotal + rahmenWeightedTotal },
  ].filter((item) => item.actual > 0 || item.weighted > 0);
  setAnalyticsData({
    persons: personList,
    teams: teamList,
    totals: totalArr,
    salesSummary: {
      persons: personList,
      totals: {
        actual: fixTotal + rahmenTotal,
        weighted: fixWeightedTotal + rahmenWeightedTotal,
      },
    },
    entryBreakdown,
  });

  renderContributionCharts();
}

function renderContributionCharts() {
  const analytics = getAnalyticsData();
  const selectedTeams = getSelectedMarketTeams();

  renderWeightedBars('salesContributionSummary', analytics.persons, {
    showWeighting: anaPersonWeightingEnabled,
    filterFn: (p) => !selectedTeams.length || selectedTeams.includes(p.team || ''),
  });

  renderWeightedBars('chartTeams', analytics.teams, {
    showWeighting: anaTeamWeightingEnabled,
    getLabel: (item) => item.name,
    getKey: (item) => item.name,
    emptyMessage: 'Keine Team-Daten verfügbar.',
  });

  renderTotalsActual(analytics.totals);
}

function renderTotalsActual(totals = []) {
  const list = Array.isArray(totals)
    ? totals
        .map((t) => ({ name: t.name, val: Math.max(0, Number(t.actual) || 0) }))
        .filter((t) => t.val > 0)
    : [];
  drawBars('chartTotals', list, false, { formatter: fmtCurr0, emptyMessage: 'Keine Daten verfügbar.' });
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

function drawComparisonBars(hostOrId, items, options = {}) {
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
  const max = list.reduce(
    (m, item) => Math.max(m, Number(item.actual) || 0, Number(item.weighted) || 0),
    0
  );
  const barH = 30;
  const gap = 8;
  const w = 1060;
  const h = list.length > 0 ? list.length * (barH + gap) + 10 : 50;
  const textWidth = 240;
  const barStartX = textWidth;
  const valueOffset = 120;
  const availableWidth = w - barStartX - valueOffset;

  const legend = document.createElement('div');
  legend.className = 'compare-bar-legend';
  legend.innerHTML = `
    <span><span class="legend-dot legend-actual"></span>Ist</span>
    <span><span class="legend-dot legend-weighted"></span>Gewichtet</span>
  `;
  host.appendChild(legend);

  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('preserveAspectRatio', 'xMinYMin meet');

  let y = 10;
  list.forEach((item) => {
    const actual = Math.max(0, Number(item.actual) || 0);
    const weighted = Math.max(0, Number(item.weighted) || 0);
    const actualLen = max > 0 ? Math.round((actual / max) * availableWidth) : 0;
    const weightedLen = max > 0 ? Math.round((weighted / max) * availableWidth) : 0;
    const g = document.createElementNS(svgNS, 'g');

    const title = document.createElementNS(svgNS, 'title');
    const delta = weighted - actual;
    const deltaText = delta ? ` (${delta > 0 ? '+' : ''}${formatter.format(delta)})` : '';
    title.textContent = `${item.name}: ${formatter.format(actual)} → ${formatter.format(weighted)}${deltaText}`;
    g.appendChild(title);

    if (actualLen > 0) {
      const actualRect = document.createElementNS(svgNS, 'rect');
      actualRect.setAttribute('x', String(barStartX));
      actualRect.setAttribute('y', String(y));
      actualRect.setAttribute('rx', '6');
      actualRect.setAttribute('ry', '6');
      actualRect.setAttribute('width', String(actualLen));
      actualRect.setAttribute('height', String(barH));
      actualRect.setAttribute('fill', '#1f2937');
      actualRect.setAttribute('opacity', '0.65');
      g.appendChild(actualRect);
    }

    if (weightedLen > 0) {
      const weightedRect = document.createElementNS(svgNS, 'rect');
      weightedRect.setAttribute('x', String(barStartX));
      weightedRect.setAttribute('y', String(y));
      weightedRect.setAttribute('rx', '6');
      weightedRect.setAttribute('ry', '6');
      weightedRect.setAttribute('width', String(Math.max(weightedLen, 4)));
      weightedRect.setAttribute('height', String(barH));
      weightedRect.setAttribute('fill', '#3b82f6');
      g.appendChild(weightedRect);
    }

    const labelL = document.createElementNS(svgNS, 'text');
    labelL.setAttribute('x', '10');
    labelL.setAttribute('y', String(y + barH * 0.68));
    labelL.setAttribute('fill', '#cbd5e1');
    labelL.setAttribute('font-size', '14');
    labelL.textContent =
      item.name && item.name.length > 30 ? `${item.name.substring(0, 28)}.` : item.name || '-';
    g.appendChild(labelL);

    const valueText = `${formatter.format(actual)} → ${formatter.format(weighted)}`;
    const labelV = document.createElementNS(svgNS, 'text');
    labelV.setAttribute('y', String(y + barH * 0.68));
    labelV.setAttribute('font-weight', '700');
    labelV.setAttribute('font-size', '14');
    labelV.textContent = valueText;
    const textWidthEstimate = valueText.length * 8;
    if (weightedLen < textWidthEstimate + 10) {
      labelV.setAttribute('x', String(barStartX + weightedLen + 8));
      labelV.setAttribute('fill', '#cbd5e1');
    } else {
      labelV.setAttribute('x', String(barStartX + 10));
      labelV.setAttribute('fill', '#0a0f16');
    }
    g.appendChild(labelV);

    y += barH + gap;
    svg.appendChild(g);
  });

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

  const computedTrend = computeTrendData(from, to);
  setTrendData(computedTrend);
  renderTrendSummary(computedTrend);

  const revenueSeries = computedTrend.series?.revenue || [];
  const cumulativeSeries = computedTrend.series?.cumulative || [];

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
  const trendData = getTrendData();
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
  const trendData = getTrendData();
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
  const trendData = getTrendData();
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
  const analyticsData = getAnalyticsData();

  // Ensure data exists before creating sheets
  if (analyticsData.persons && analyticsData.persons.length > 0) {
    const ws1Arr = analyticsData.persons.map(p => ({
      Name: p.name,
      Team: p.team,
      Beitrag_Ist_EUR: Number((p.actual || 0).toFixed(2)),
      Beitrag_Gewichtet_EUR: Number((p.weighted || 0).toFixed(2)),
      Faktor: p.actual > 0 ? Number((p.weighted / p.actual).toFixed(2)) : '',
      Delta_EUR: Number(((p.weighted || 0) - (p.actual || 0)).toFixed(2)),
    }));
    const ws1 = XLSX.utils.json_to_sheet(ws1Arr);
    XLSX.utils.book_append_sheet(wb, ws1, "Salesbeiträge Personen");
  }
  if (analyticsData.teams && analyticsData.teams.length > 0) {
    const ws2Arr = analyticsData.teams.map(t => ({
      Team: t.name,
      Beitrag_Ist_EUR: Number((t.actual || 0).toFixed(2)),
      Beitrag_Gewichtet_EUR: Number((t.weighted || 0).toFixed(2)),
      Faktor: t.actual > 0 ? Number((t.weighted / t.actual).toFixed(2)) : '',
      Delta_EUR: Number(((t.weighted || 0) - (t.actual || 0)).toFixed(2)),
    }));
    const ws2 = XLSX.utils.json_to_sheet(ws2Arr);
    XLSX.utils.book_append_sheet(wb, ws2, "Salesbeiträge Teams");
  }
  if (analyticsData.totals && analyticsData.totals.length > 0) {
    const ws3Arr = analyticsData.totals.map(t => ({
      Typ: t.name,
      Betrag_Ist_EUR: Number((t.actual || 0).toFixed(2)),
      Betrag_Gewichtet_EUR: Number((t.weighted || 0).toFixed(2)),
      Delta_EUR: Number(((t.weighted || 0) - (t.actual || 0)).toFixed(2)),
    }));
    const ws3 = XLSX.utils.json_to_sheet(ws3Arr);
    XLSX.utils.book_append_sheet(wb, ws3, "Gesamt");
  }

  // Add activity data if available (simple export of the current view)
  const activityChart = document.getElementById('chartActivity');
  if (activityChart && activityChart.innerHTML !== '') {
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
    if (activityItems.length > 0) {
      const ws4 = XLSX.utils.json_to_sheet(activityItems);
      XLSX.utils.book_append_sheet(wb, ws4, `Aktivität ${start}-${end}`);
    }
  }

  if (wb.SheetNames.length > 0) {
    XLSX.writeFile(wb, `auswertung_${year}_export.xlsx`);
  } else {
    showToast('Keine Daten zum Exportieren vorhanden.', 'warn');
  }
});

const erfassungDeps = {
  clampDockRewardFactor,
  dockWeightingDefault: DOCK_WEIGHTING_DEFAULT,
  findDockKvConflict,
  queueDockAutoCheck,
  loadHistory,
  renderHistory,
  renderDockBoard,
  renderFrameworkContracts,
  finalizeDockAbruf,
  hideManualPanel,
  showView,
  getPendingDockAbrufAssignment,
};

initDockBoard({ renderFrameworkContracts, renderRahmenDetails, onEditEntry: editEntry });

initErfassung(erfassungDeps);
initPortfolio({ 
  openEditTransactionModal, 
  openFrameworkVolumeDialog,
  onUpdateFrameworkVolume: async (entry, vol) => {
    try {
      showLoader();
      const res = await fetchWithRetry(`${WORKER_BASE}/entries/${encodeURIComponent(entry.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ frameworkVolume: vol })
      });
      if (!res.ok) throw new Error(await res.text());
      showToast('Volumen aktualisiert', 'ok');
      await loadHistory(true);
    } catch(e) {
      console.error(e);
      showToast('Fehler beim Speichern: ' + e.message, 'bad');
    } finally {
      hideLoader();
    }
  }
});

export function initializeCommonEvents() {
  initCommonEvents({
    dockEntryDialog,
    onDockDialogCloseRequest: requestDockEntryDialogClose,
    onDockDialogClosed: () => clearInputFields(),
  });
}

/* ---------- Init & Window Events ---------- */
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


export async function initializeApp() {
  try {
    await loadSession();
    await loadPeople();
  } catch (err) {
    console.error('Initialisierung von Session/Personen fehlgeschlagen:', err);
    showToast('Cloudflare-Session oder Personenliste konnten nicht geladen werden.', 'bad');
  }

  initAdminModule();
  initFromState();

  try {
    await initHistory({ renderDockBoard, renderPortfolio, onEditEntry: editEntry });
  } catch (err) {
    console.error('Initiales Laden der Historie fehlgeschlagen:', err);
  }
  showView('erfassung');

  const btnLegacySalesImport = document.getElementById('btnLegacySalesImport');
  if (btnLegacySalesImport) {
    btnLegacySalesImport.addEventListener('click', handleLegacySalesImport);
  } else {
    console.error('Button #btnLegacySalesImport nicht gefunden!');
  }
}
