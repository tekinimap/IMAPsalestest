import {
  WORKER_BASE,
  DEFAULT_WEIGHTS,
  CATEGORY_NAMES,
  FOUNDER_SHARE_PCT,
} from '../config.js';
import { saveState } from '../state.js';
import { getEntries } from '../entries-state.js';
import { throttle, fetchWithRetry } from '../api.js';
import {
  fmtCurr2,
  fmtCurr0,
  fmtPct,
  formatAmountInput,
  getTodayDate,
  formatDateForInput,
  toInt0,
  parseAmountInput,
} from '../utils/format.js';
import {
  showLoader,
  hideLoader,
  showToast,
  showBatchProgress,
  updateBatchProgress,
  hideBatchProgress,
} from '../ui/feedback.js';
import { compute } from './compute.js';
import {
  autoComplete,
  getSelectedFixIds,
  handleDeleteClick,
  loadHistory,
  renderHistory,
} from './history.js';
import { showView } from './navigation.js';
import { initFromState } from './erfassung.js';
import {
  getPendingDockAbrufAssignment,
} from '../state/dock-state.js';
import {
  finalizeDockAbruf,
  clearInputFields,
} from './dock-board.js';
import {
  getCurrentFrameworkEntryId,
  setCurrentFrameworkEntryId,
  getEditingTransactionId,
  setEditingTransactionId,
} from '../state/framework-state.js';
import { calculateActualDistribution } from './calculations.js';
import { readRows } from '../ui/forms.js';

const rahmenSearch = document.getElementById('rahmenSearch');
const btnMoveToFramework = document.getElementById('btnMoveToFramework');
const rahmenBody = document.getElementById('rahmenBody');
const rahmenTransaktionenBody = document.getElementById('rahmenTransaktionenBody');
const moveToFrameworkDlg = document.getElementById('moveToFrameworkDlg');
const moveValidationSummary = document.getElementById('moveValidationSummary');
const moveTargetFramework = document.getElementById('moveTargetFramework');

const entries = getEntries();

function totals(rows) {
  return rows.reduce(
    (acc, row) => {
      acc.cs += row.cs;
      acc.konzept += row.konzept;
      acc.pitch += row.pitch;
      return acc;
    },
    { cs: 0, konzept: 0, pitch: 0 }
  );
}

if (rahmenSearch) {
  rahmenSearch.addEventListener('input', renderFrameworkContracts);
}

export function filteredFrameworks() {
  let arr = entries.filter((e) => e.projectType === 'rahmen');
  const query = rahmenSearch ? rahmenSearch.value.trim().toLowerCase() : '';
  if (!rahmenSearch) return arr.sort((a, b) => (b.modified || b.ts) - (a.modified || a.ts));
  if (!query) return arr.sort((a, b) => (b.modified || b.ts) - (a.modified || a.ts));

  return arr
    .filter((e) => {
      if (String(e.projectNumber || '').toLowerCase().includes(query)) return true;
      if (String(e.title || '').toLowerCase().includes(query)) return true;
      if (String(e.client || '').toLowerCase().includes(query)) return true;
      if ((e.list || []).some((p) => String(p.name || '').toLowerCase().includes(query))) return true;

      if (Array.isArray(e.transactions)) {
        for (const trans of e.transactions) {
          if (trans.type === 'hunter') {
            if (String(trans.title || '').toLowerCase().includes(query)) return true;
            if ((trans.list || []).some((p) => String(p.name || '').toLowerCase().includes(query))) return true;
          }
        }
      }
      return false;
    })
    .sort((a, b) => (b.modified || b.ts) - (a.modified || a.ts));
}

export function renderFrameworkContracts() {
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
      e.stopPropagation();
      const act = btn.dataset.act;
      const id = btn.dataset.id;
      const entry = entries.find((en) => en.id === id);
      if (!entry) return;

      if (act === 'founder-plus') {
        openEditTransactionModal({ type: 'founder' }, entry);
      } else if (act === 'hunter-plus') {
        saveState({
          source: 'manuell',
          isAbrufMode: true,
          parentEntry: entry,
          input: { projectNumber: entry.projectNumber || '', freigabedatum: getTodayDate() },
        });
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
      const entry = entries.find((en) => en.id === id);
      if (entry) openEditFrameworkContractModal(entry);
    }
  });
}

export async function saveHunterAbruf(st) {
  const parentEntry = entries.find((e) => e.id === st.parentEntry.id);
  if (!parentEntry) {
    return showToast('Rahmenvertrag nicht gefunden.', 'bad');
  }

  const abrufAmount = typeof auftragswertBekannt !== 'undefined' && auftragswertBekannt?.checked ? st.input.amount : 0;
  const resultData = compute(st.input.rows, st.input.weights, abrufAmount * (1 - FOUNDER_SHARE_PCT / 100));

  if (!Array.isArray(parentEntry.transactions)) {
    parentEntry.transactions = [];
  }
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
    weights: resultData.effectiveWeights,
  };

  parentEntry.transactions.push(newTransaction);
  parentEntry.modified = Date.now();

  showLoader();
  try {
    const r = await fetchWithRetry(`${WORKER_BASE}/entries/${encodeURIComponent(parentEntry.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(parentEntry),
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

document.getElementById('backToRahmen')?.addEventListener('click', () => showView('rahmen'));

export function renderRahmenDetails(id) {
  const entry = entries.find((e) => e.id === id);
  if (!entry) return;
  setCurrentFrameworkEntryId(id);

  document.getElementById('rahmenDetailsTitle').textContent = entry.title;

  const { list: actualDistribution, total: totalValue } = calculateActualDistribution(entry);
  document.getElementById('rahmenDetailsSub').textContent = `${entry.client} | ${entry.projectNumber || ''} | Gesamtwert: ${fmtCurr0.format(totalValue)}`;

  const foundersBody = document.getElementById('rahmenFoundersBody');
  foundersBody.innerHTML = '';
  (entry.list || []).forEach((founder) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${founder.name}</td><td>${fmtPct.format(founder.pct)} %</td>`;
    foundersBody.appendChild(tr);
  });

  const rahmenActualBody = document.getElementById('rahmenActualBody');
  rahmenActualBody.innerHTML = '';
  actualDistribution.forEach((person) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${person.name}</td><td>${fmtPct.format(person.pct)} %</td><td>${fmtCurr0.format(person.money)}</td>`;
    rahmenActualBody.appendChild(tr);
  });

  rahmenTransaktionenBody.innerHTML = '';
  (entry.transactions || [])
    .sort((a, b) => (b.freigabedatum || b.ts) - (a.freigabedatum || a.ts))
    .forEach((trans) => {
      const tr = document.createElement('tr');
      tr.classList.add('clickable');
      tr.dataset.transId = trans.id;
      const datum = trans.freigabedatum
        ? new Date(trans.freigabedatum).toLocaleDateString('de-DE')
        : trans.ts
          ? new Date(trans.ts).toLocaleDateString('de-DE')
          : '–';
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

rahmenTransaktionenBody?.addEventListener('click', (ev) => {
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
    const parentEntry = entries.find((e) => e.id === getCurrentFrameworkEntryId());
    if (!parentEntry) return;
    const transaction = (parentEntry.transactions || []).find((t) => t.id === transId);
    if (!transaction) return;
    openEditTransactionModal(transaction, parentEntry);
  }
});

if (btnMoveToFramework) {
  btnMoveToFramework.addEventListener('click', () => {
    const selectedIds = getSelectedFixIds();
    if (selectedIds.length === 0) return;

    moveValidationSummary.textContent = '';
    document.getElementById('moveDlgCountLabel').textContent = `Sie sind dabei, ${selectedIds.length} Auftrag/Aufträge zuzuweisen.`;

    const rahmenEntries = entries.filter((e) => e.projectType === 'rahmen').sort((a, b) => a.title.localeCompare(b.title));
    moveTargetFramework.innerHTML = '<option value="">-- Bitte Rahmenvertrag wählen --</option>';
    rahmenEntries.forEach((e) => {
      const opt = document.createElement('option');
      opt.value = e.id;
      opt.textContent = `${e.title} (${e.client})`;
      moveTargetFramework.appendChild(opt);
    });

    moveToFrameworkDlg.showModal();
  });
}

document.getElementById('btnConfirmMove')?.addEventListener('click', async () => {
  const selectedIds = getSelectedFixIds();
  const targetFrameworkId = moveTargetFramework.value;
  const moveType = document.querySelector('input[name="moveType"]:checked')?.value;

  moveValidationSummary.textContent = '';
  if (!targetFrameworkId) {
    moveValidationSummary.textContent = 'Bitte einen Ziel-Rahmenvertrag auswählen.';
    return;
  }

  const targetFramework = entries.find((e) => e.id === targetFrameworkId);
  if (!targetFramework) {
    moveValidationSummary.textContent = 'Ziel-Rahmenvertrag nicht gefunden.';
    return;
  }

  const fixEntriesToMove = entries.filter((e) => selectedIds.includes(e.id));

  if (moveType === 'hunter') {
    const incompleteEntries = fixEntriesToMove.filter((e) => !autoComplete(e));
    if (incompleteEntries.length > 0) {
      moveValidationSummary.innerHTML = `<b>Fehler:</b> Für "Aktive Abrufe" müssen alle Einträge vollständig sein (Status "ok").<br>Folgende Einträge sind unvollständig: ${incompleteEntries
        .map((e) => e.title)
        .join(', ')}. <br>Bitte bearbeiten Sie diese Einträge zuerst.`;
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

      let newTransaction;
      if (moveType === 'founder') {
        newTransaction = {
          id: `trans_${Date.now()}_${entry.kv_nummer.replace(/\W/g, '')}`,
          kv_nummer: entry.kv_nummer,
          type: 'founder',
          amount: entry.amount,
          ts: Date.now(),
          freigabedatum: entry.freigabedatum || entry.ts,
        };
      } else {
        const { id, projectType, transactions, ...restOfEntry } = entry;
        newTransaction = {
          ...restOfEntry,
          id: `trans_${Date.now()}_${entry.kv_nummer.replace(/\W/g, '')}`,
          type: 'hunter',
          ts: Date.now(),
        };
      }

      if (!Array.isArray(targetFramework.transactions)) {
        targetFramework.transactions = [];
      }
      targetFramework.transactions.push(newTransaction);
      targetFramework.modified = Date.now();

      const rPut = await fetchWithRetry(`${WORKER_BASE}/entries/${encodeURIComponent(targetFramework.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(targetFramework),
      });
      if (!rPut.ok) throw new Error(`Fehler beim Speichern von Rahmenvertrag ${targetFramework.id}: ${await rPut.text()}`);

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
    await loadHistory();
    renderHistory();
    renderFrameworkContracts();
  }
});

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
const editFwClient = document.getElementById('editFwClient');
const editFwTitle = document.getElementById('editFwTitle');
const editFwProjectNumber = document.getElementById('editFwProjectNumber');
const editFwTbody = document.getElementById('editFwTbody');
const editFwW_cs = document.getElementById('editFwW_cs');
const editFwW_konzept = document.getElementById('editFwW_konzept');
const editFwW_pitch = document.getElementById('editFwW_pitch');

document.getElementById('editBtnAddRow')?.addEventListener('click', () => addEditRow({}, '#editTbody'));
document.getElementById('editFwBtnAddRow')?.addEventListener('click', () => addEditRow({}, '#editFwTbody'));

export function openEditTransactionModal(transaction, parentEntry) {
  setCurrentFrameworkEntryId(parentEntry.id);
  setEditingTransactionId(transaction.id || null);
  const editingTransactionId = getEditingTransactionId();

  document.getElementById('editTransValidationSummary').textContent = '';

  if (transaction.type === 'founder') {
    editTransDlgTitle.textContent = editingTransactionId ? 'Passiven Abruf bearbeiten' : 'Passiven Abruf hinzufügen';
    editFounderValueInput.value = editingTransactionId ? formatAmountInput(transaction.amount) : '';
    editFounderKvNummer.value = editingTransactionId ? transaction.kv_nummer : '';
    const founderDateSource = transaction.freigabedatum ?? (editingTransactionId ? null : transaction.ts || Date.now());
    editFounderFreigabedatum.value = founderDateSource ? formatDateForInput(founderDateSource) : '';
    editFounderTransView.classList.remove('hide');
    editHunterTransView.classList.add('hide');
  } else {
    editTransDlgTitle.textContent = 'Aktiven Abruf bearbeiten';
    editHunterTitle.value = transaction.title || '';
    editHunterAmount.value = formatAmountInput(transaction.amount);
    editHunterKvNummer.value = transaction.kv_nummer || '';
    const hunterDateSource = transaction.freigabedatum ?? (editingTransactionId ? null : transaction.ts || Date.now());
    editHunterFreigabedatum.value = hunterDateSource ? formatDateForInput(hunterDateSource) : '';

    const weights = transaction.weights || [
      { key: 'cs', weight: DEFAULT_WEIGHTS.cs },
      { key: 'konzept', weight: DEFAULT_WEIGHTS.konzept },
      { key: 'pitch', weight: DEFAULT_WEIGHTS.pitch },
    ];
    const m = Object.fromEntries(weights.map((w) => [w.key, w.weight]));
    editW_cs.value = m.cs ?? DEFAULT_WEIGHTS.cs;
    editW_konzept.value = m.konzept ?? DEFAULT_WEIGHTS.konzept;
    editW_pitch.value = m.pitch ?? DEFAULT_WEIGHTS.pitch;

    editTbody.innerHTML = '';
    (transaction.rows || []).forEach((r) => addEditRow(r, '#editTbody'));

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

document.getElementById('btnSaveTransaction')?.addEventListener('click', async () => {
  const parentEntry = entries.find((e) => e.id === getCurrentFrameworkEntryId());
  if (!parentEntry) return;

  const editingTransactionId = getEditingTransactionId();
  const transIndex = editingTransactionId ? parentEntry.transactions.findIndex((t) => t.id === editingTransactionId) : -1;

  let transaction = transIndex > -1 ? JSON.parse(JSON.stringify(parentEntry.transactions[transIndex])) : {};
  let validationError = '';

  if (!editHunterTransView.classList.contains('hide')) {
    const rows = readRows('#editTbody');
    const weights = [
      { key: 'cs', weight: toInt0(editW_cs.value) },
      { key: 'konzept', weight: toInt0(editW_konzept.value) },
      { key: 'pitch', weight: toInt0(editW_pitch.value) },
    ];

    const errors = validateModalInput(rows, weights);
    if (Object.keys(errors).length > 0) {
      document.getElementById('editTransValidationSummary').innerHTML = Object.values(errors).join('<br>');
      return;
    }
    const amount = parseAmountInput(editHunterAmount.value);
    const hunterShareAmount = amount * (1 - FOUNDER_SHARE_PCT / 100);
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
      freigabedatum: Number.isFinite(hunterDate) ? hunterDate : null,
    };
  } else {
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

  if (transIndex === -1) {
    transaction.id = `trans_${Date.now()}_${transaction.kv_nummer.replace(/\s/g, '')}`;
    transaction.ts = Date.now();
    transaction.type = 'founder';
    if (!Array.isArray(parentEntry.transactions)) parentEntry.transactions = [];
    parentEntry.transactions.push(transaction);
  } else {
    parentEntry.transactions[transIndex] = transaction;
  }

  parentEntry.modified = Date.now();
  showLoader();
  try {
    const r = await fetchWithRetry(`${WORKER_BASE}/entries/${encodeURIComponent(parentEntry.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(parentEntry),
    });
    if (!r.ok) throw new Error(await r.text());
    showToast('Abruf aktualisiert', 'ok');
    editTransactionDlg.close();
    await loadHistory();
    renderRahmenDetails(getCurrentFrameworkEntryId());
    renderFrameworkContracts();
    const pendingAssignment = getPendingDockAbrufAssignment();
    if (pendingAssignment?.mode === 'founder' && pendingAssignment.entry?.id) {
      await finalizeDockAbruf(pendingAssignment.entry.id);
    }
  } catch (e) {
    showToast('Update fehlgeschlagen', 'bad');
    console.error(e);
  } finally {
    hideLoader();
  }
});

export function openEditFrameworkContractModal(entry) {
  setCurrentFrameworkEntryId(entry.id);
  document.getElementById('editFwValidationSummary').textContent = '';
  editFwClient.value = entry.client || '';
  editFwTitle.value = entry.title || '';
  editFwProjectNumber.value = entry.projectNumber || '';

  const weights = entry.weights || [
    { key: 'cs', weight: DEFAULT_WEIGHTS.cs },
    { key: 'konzept', weight: DEFAULT_WEIGHTS.konzept },
    { key: 'pitch', weight: DEFAULT_WEIGHTS.pitch },
  ];
  const m = Object.fromEntries(weights.map((w) => [w.key, w.weight]));
  editFwW_cs.value = m.cs ?? DEFAULT_WEIGHTS.cs;
  editFwW_konzept.value = m.konzept ?? DEFAULT_WEIGHTS.konzept;
  editFwW_pitch.value = m.pitch ?? DEFAULT_WEIGHTS.pitch;

  editFwTbody.innerHTML = '';
  (entry.rows || []).forEach((r) => addEditRow(r, '#editFwTbody'));
  editFrameworkContractDlg.showModal();
}

document.getElementById('btnSaveFrameworkContract')?.addEventListener('click', async () => {
  const entry = entries.find((e) => e.id === getCurrentFrameworkEntryId());
  if (!entry) return;

  const rows = readRows('#editFwTbody');
  const weights = [
    { key: 'cs', weight: toInt0(editFwW_cs.value) },
    { key: 'konzept', weight: toInt0(editFwW_konzept.value) },
    { key: 'pitch', weight: toInt0(editFwW_pitch.value) },
  ];

  const errors = validateModalInput(rows, weights);
  if (rows.length === 0 || rows.every((r) => r.name === '' && r.cs === 0 && r.konzept === 0 && r.pitch === 0)) {
    errors.rows = 'Mindestens eine Person muss dem Gründer-Team zugewiesen sein.';
  }
  if (Object.keys(errors).length > 0) {
    document.getElementById('editFwValidationSummary').innerHTML = Object.values(errors).join('<br>');
    return;
  }

  const resultData = compute(rows, weights, 100);

  entry.client = editFwClient.value.trim();
  entry.title = editFwTitle.value.trim();
  entry.projectNumber = editFwProjectNumber.value.trim();
  entry.rows = rows;
  entry.weights = resultData.effectiveWeights;
  entry.list = resultData.list.map(({ key, name, pct }) => ({ key, name, pct }));
  entry.modified = Date.now();

  showLoader();
  try {
    const r = await fetchWithRetry(`${WORKER_BASE}/entries/${encodeURIComponent(entry.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
    });
    if (!r.ok) throw new Error(await r.text());
    showToast('Rahmenvertrag aktualisiert', 'ok');
    editFrameworkContractDlg.close();
    loadHistory().then(() => {
      renderFrameworkContracts();
      if (document.getElementById('viewRahmenDetails').classList.contains('hide') === false) {
        renderRahmenDetails(getCurrentFrameworkEntryId());
      }
    });
  } catch (e) {
    showToast('Update fehlgeschlagen', 'bad');
    console.error(e);
  } finally {
    hideLoader();
  }
});

function validateModalInput(rows, weights) {
  const errors = {};
  const t = totals(rows);
  const categoryErrors = [];
  weights.forEach((w) => {
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
