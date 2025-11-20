import {
  WORKER_BASE,
  DEFAULT_WEIGHTS,
  CATEGORY_NAMES,
  FOUNDER_SHARE_PCT,
} from '../config.js';
import {
  saveState,
  loadState,
  setHasUnsavedChanges,
} from '../state.js';
import { getEntries } from '../entries-state.js';
import { fetchWithRetry } from '../api.js';
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
} from '../utils/format.js';
import {
  showLoader,
  hideLoader,
  showToast,
} from '../ui/feedback.js';
import {
  appendRow as appendFormRow,
  readRows,
  createRowTemplate,
  setupRow,
} from '../ui/forms.js';
import { findPersonByName } from './people.js';

let deps = {
  clampDockRewardFactor: (value) => value,
  dockWeightingDefault: 1,
  findDockKvConflict: () => null,
  queueDockAutoCheck: () => {},
  loadHistory: async () => {},
  renderHistory: () => {},
  renderFrameworkContracts: () => {},
  finalizeDockAbruf: async () => {},
  hideManualPanel: () => {},
  showView: () => {},
  getPendingDockAbrufAssignment: () => null,
};

const tbody = document.getElementById('tbody');
const sumchips = document.getElementById('sumchips');
const auftraggeber = document.getElementById('auftraggeber');
const projekttitel = document.getElementById('projekttitel');
const auftragswert = document.getElementById('auftragswert');
const auftragswertBekannt = document.getElementById('auftragswertBekannt');
const submittedBy = document.getElementById('submittedBy');
const projectNumber = document.getElementById('projectNumber');
const kvNummer = document.getElementById('kvNummer');
const freigabedatum = document.getElementById('freigabedatum');
const kvValidationHint = document.createElement('div');
kvValidationHint.className = 'inline-hint';
kvValidationHint.dataset.state = 'idle';
const pnValidationHint = document.createElement('div');
pnValidationHint.className = 'inline-hint';
pnValidationHint.dataset.state = 'idle';
if (kvNummer && kvNummer.parentNode) {
  kvNummer.parentNode.insertBefore(kvValidationHint, kvNummer.nextSibling);
}
if (projectNumber && projectNumber.parentNode) {
  projectNumber.parentNode.insertBefore(pnValidationHint, projectNumber.nextSibling);
}
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
const weightingFactorInputs = document.querySelectorAll('input[name="weightingFactor"]');

function debounce(fn, wait = 300) {
  let timeoutId;
  return (...args) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), wait);
  };
}

function getSelectedWeightingFactor() {
  const selected = document.querySelector('input[name="weightingFactor"]:checked');
  const numeric = selected ? parseFloat(selected.value) : NaN;
  return Number.isFinite(numeric) ? deps.clampDockRewardFactor(numeric) : deps.dockWeightingDefault;
}

function setSelectedWeightingFactor(value) {
  const targetValue = deps.clampDockRewardFactor(value);
  let applied = false;
  weightingFactorInputs.forEach((input) => {
    const numeric = parseFloat(input.value);
    if (!applied && Math.abs(numeric - targetValue) < 0.001) {
      input.checked = true;
      applied = true;
    }
  });
  if (!applied) {
    const fallback = document.querySelector('input[name="weightingFactor"][value="1.0"]') || weightingFactorInputs[0];
    if (fallback) fallback.checked = true;
  }
}

function renderInlineHint(el, message, severity = 'info') {
  if (!el) return;
  el.textContent = message || '';
  el.dataset.state = message ? severity : 'idle';
  el.style.color = severity === 'bad' ? '#b00020' : severity === 'warn' ? '#b26a00' : '#444';
  el.style.fontSize = '0.85rem';
  el.style.marginTop = '4px';
}

function addRow(focus = false) {
  appendFormRow({
    tbody,
    focus,
    saveCurrentInputState,
    recalc,
    findPersonByName,
  });
}

function totals(rows) { return rows.reduce((a, r) => { a.cs += r.cs; a.konzept += r.konzept; a.pitch += r.pitch; return a; }, { cs: 0, konzept: 0, pitch: 0 }); }
function renderChips(t) {
  sumchips.innerHTML = '';
  [["cs", "Consultative Selling"], ["konzept", "Konzepterstellung"], ["pitch", "Pitch"]].forEach(([k, label]) => {
    const x = t[k]; const div = document.createElement('div'); div.className = 'chip';
    const dot = document.createElement('span'); dot.className = 'dot';
    const txt = document.createElement('span'); txt.innerHTML = `<strong>${label}</strong> &nbsp; ${fmtInt.format(x)} / 100`;
    if (x === 0 || x === 100) div.classList.add('ok'); else if (x > 100) div.classList.add('bad'); else div.classList.add('warn');
    div.appendChild(dot); div.appendChild(txt); sumchips.appendChild(div);
  });
}
function currentWeights() { return [{ key: 'cs', weight: clamp01(toInt0(w_cs.value)) }, { key: 'konzept', weight: clamp01(toInt0(w_konzept.value)) }, { key: 'pitch', weight: clamp01(toInt0(w_pitch.value)) }] }
function updateWeightNote() { const ws = currentWeights(); const sum = ws.reduce((a, c) => a + Number(c.weight || 0), 0); w_note.textContent = `Summe Gewichte: ${sum} %`; }

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
      if (t[w.key] !== 100) categoryErrors.push(`${CATEGORY_NAMES[w.key]} = 100`);
    }
  });
  if (categoryErrors.length) errors.weights = categoryErrors.join(', ');
  const sumW = weights.reduce((a, w) => a + Number(w.weight || 0), 0);
  if (!forLive && sumW !== 100) errors.weights = 'Gewichte müssen 100% ergeben.';
  if (forLive && sumW === 0) errors.weights = 'Gewichte dürfen nicht 0 sein für Live-Berechnung.';

  return errors;
}

function clearValidation() {
  document.querySelectorAll('.field-error').forEach(el => el.textContent = '');
  document.querySelectorAll('.invalid-field').forEach(el => el.classList.remove('invalid-field'));
}

function displayValidation(errors) {
  clearValidation();
  Object.keys(errors).forEach(key => {
    const el = document.querySelector(`[data-validation-for="${key}"]`);
    if (el) el.textContent = errors[key];

    const input = document.getElementById(key);
    if (input) input.classList.add('invalid-field');
  });
}

export function compute(rows, weights, amount, forLive = false) {
  const t = totals(rows);
  const usedKeys = Object.entries(t).filter(([k, v]) => v > 0).map(([k]) => k);
  const effWeights = (weights && weights.length ? weights : [{ key: 'cs', weight: DEFAULT_WEIGHTS.cs }, { key: 'konzept', weight: DEFAULT_WEIGHTS.konzept }, { key: 'pitch', weight: DEFAULT_WEIGHTS.pitch }]);

  const calcWeights = forLive ? effWeights : normalizeWeightsForUsed(effWeights, usedKeys);

  const map = new Map();
  rows.forEach((r, index) => {
    const act = r.cs + r.konzept + r.pitch > 0;
    const key = r.name.trim() || `_temp_${index}`;
    if (!r.name.trim() && !act) return;

    const cur = map.get(key) || { name: r.name, cs: 0, konzept: 0, pitch: 0 };
    cur.cs += r.cs; cur.konzept += r.konzept; cur.pitch += r.pitch;
    map.set(key, cur);
  });

  const wIdx = Object.fromEntries(calcWeights.map(w => [w.key, w.weight / 100]));
  const list = [];

  for (const [key, p] of map.entries()) {
    let pct = 0;
    const divCS = forLive ? 100 : (t.cs || 1);
    const divKonzept = forLive ? 100 : (t.konzept || 1);
    const divPitch = forLive ? 100 : (t.pitch || 1);

    if (usedKeys.includes('cs') && t.cs > 0) pct += wIdx.cs * (p.cs / divCS);
    if (usedKeys.includes('konzept') && t.konzept > 0) pct += wIdx.konzept * (p.konzept / divKonzept);
    if (usedKeys.includes('pitch') && t.pitch > 0) pct += wIdx.pitch * (p.pitch / divPitch);
    list.push({ key, name: p.name, pct: pct * 100 });
  }

  list.sort((a, b) => b.pct - a.pct);
  if (!forLive) {
    const sum = list.reduce((a, x) => a + x.pct, 0), resid = 100 - sum;
    if (list.length && Math.abs(resid) > 1e-9) list[0].pct += resid;
  }

  list.forEach(x => { if (x.pct < 0) x.pct = 0; });
  const withMoney = list.map(x => ({ ...x, money: Math.round((amount > 0 ? amount : 0) * x.pct / 100) }));
  return { totals: t, usedKeys, effectiveWeights: calcWeights, list: withMoney };
}

function normalizeWeightsForUsed(allWeights, usedKeys) { const used = allWeights.filter(w => usedKeys.includes(w.key)); const sum = used.reduce((a, w) => a + w.weight, 0); if (sum <= 0) return allWeights.map(w => ({ key: w.key, weight: w.weight })); const factor = 100 / sum; const out = allWeights.map(w => usedKeys.includes(w.key) ? { key: w.key, weight: w.weight * factor } : { key: w.key, weight: 0 }); const rem = 100 - out.reduce((a, w) => a + Math.round(w.weight), 0); if (rem !== 0) { const ix = out.findIndex(x => usedKeys.includes(x.key)); if (ix >= 0) out[ix].weight += rem; } return out.map(w => ({ key: w.key, weight: Math.round(w.weight) })); }

function recalc() {
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
    freigabedatum: freigabedatum.value || '',
    dockRewardFactor: getSelectedWeightingFactor(),
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

function wireInlineValidation() {
  [auftraggeber, projekttitel, auftragswert, submittedBy, projectNumber, kvNummer, freigabedatum].forEach(el => { el.addEventListener('input', () => { setHasUnsavedChanges(true); saveCurrentInputState(); recalc(); }); });
  if (projectNumber) {
    projectNumber.addEventListener('input', updateMetaSummary);
    projectNumber.addEventListener('change', updateMetaSummary);
    const runPnValidation = debounce(async () => {
      const value = projectNumber.value.trim();
      if (!value) {
        renderInlineHint(pnValidationHint, '');
        return;
      }
      try {
        const body = { projectNumber: value };
        const currentState = loadState();
        if (currentState?.editingId) body.id = currentState.editingId;
        const response = await fetch(`${WORKER_BASE}/api/validation/check_projektnummer`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!response.ok) return;
        const payload = await response.json();
        if (payload?.warning?.message) {
          const severity = payload.warning.reason === 'RAHMENVERTRAG_FOUND' ? 'warn' : 'info';
          renderInlineHint(pnValidationHint, payload.warning.message, severity);
        } else {
          renderInlineHint(pnValidationHint, '');
        }
      } catch (err) {
        console.warn('Projekt-Validierung fehlgeschlagen', err);
      }
    }, 350);
    projectNumber.addEventListener('input', runPnValidation);
    projectNumber.addEventListener('blur', runPnValidation);
  }
  if (kvNummer) {
    kvNummer.addEventListener('input', updateMetaSummary);
    kvNummer.addEventListener('change', updateMetaSummary);
    const runKvValidation = debounce(async () => {
      const value = kvNummer.value.trim();
      if (!value) {
        renderInlineHint(kvValidationHint, '');
        return;
      }
      try {
        const body = { kvNummern: [value] };
        const currentState = loadState();
        if (currentState?.editingId) body.id = currentState.editingId;
        const response = await fetch(`${WORKER_BASE}/api/validation/check_kv`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!response.ok) return;
        const payload = await response.json();
        if (payload.valid === false && payload.message) {
          renderInlineHint(kvValidationHint, payload.message, 'bad');
        } else if (payload.warning?.message) {
          renderInlineHint(kvValidationHint, payload.warning.message, 'warn');
        } else {
          renderInlineHint(kvValidationHint, '');
        }
      } catch (err) {
        console.warn('KV-Validierung fehlgeschlagen', err);
      }
    }, 350);
    kvNummer.addEventListener('input', runKvValidation);
    kvNummer.addEventListener('blur', runKvValidation);
  }
  if (freigabedatum) {
    freigabedatum.addEventListener('input', updateMetaSummary);
    freigabedatum.addEventListener('change', updateMetaSummary);
  }
  document.querySelectorAll('input[name="projectType"]').forEach(radio => radio.addEventListener('change', () => { setHasUnsavedChanges(true); saveCurrentInputState(); recalc(); }));
  if (weightingFactorInputs.length) {
    weightingFactorInputs.forEach((input) => {
      input.addEventListener('change', () => {
        setHasUnsavedChanges(true);
        saveCurrentInputState();
      });
    });
  }
  auftragswertBekannt.addEventListener('change', () => {
    auftragswert.disabled = !auftragswertBekannt.checked;
    if (!auftragswertBekannt.checked) auftragswert.value = '';
    setHasUnsavedChanges(true);
    saveCurrentInputState();
    recalc();
  });

  auftragswert.addEventListener('blur', () => {
    const raw = parseAmountInput(auftragswert.value);
    auftragswert.value = raw > 0 ? formatAmountInput(raw) : '';
    saveCurrentInputState(); recalc();
  });
  [w_cs, w_konzept, w_pitch].forEach(el => el.addEventListener('input', () => {
    el.value = String(clamp01(toInt0(el.value)));
    setHasUnsavedChanges(true); updateWeightNote(); saveCurrentInputState(); recalc();
  }));
  btnAddRow.addEventListener('click', () => addRow(true));
}

async function saveNewEntry(st) {
  const finalAmount = auftragswertBekannt.checked ? st.input.amount : 0;
  const resultData = compute(st.input.rows, st.input.weights, finalAmount);
  const isComplete = !!(st.input.client && st.input.title && finalAmount > 0 && st.input.rows.some(r => r.cs + r.konzept + r.pitch > 0));
  const date = st.input.freigabedatum ? Date.parse(st.input.freigabedatum) : null;
  const ts = st.editingId ? (st.input.ts || Date.now()) : Date.now();

  const payload = {
    source: st.source || 'manuell', complete: isComplete, client: st.input.client || '',
    title: st.input.title || '', amount: finalAmount,
    projectType: st.input.projectType || 'fix',
    rows: st.input.rows || [],
    list: resultData.list || [],
    totals: resultData.totals || {}, weights: resultData.effectiveWeights || [], submittedBy: st.input.submittedBy || '',
    projectNumber: st.input.projectNumber || '', kv_nummer: st.input.kvNummer,
    freigabedatum: Number.isFinite(date) ? date : null,
    ts: ts,
    modified: st.editingId ? Date.now() : undefined,
    id: st.editingId || undefined,
    transactions: st.input.projectType === 'rahmen' ? [] : undefined
  };
  if (!st.editingId && payload.kv_nummer) {
    const conflict = deps.findDockKvConflict(payload.kv_nummer, null);
    if (conflict) {
      showToast('Zu dieser KV-Nummer existiert im Dock bereits ein Deal. Bitte prüfen.', 'bad');
      return;
    }
  }
  showLoader();
  try {
    const method = st.editingId ? 'PUT' : 'POST';
    const url = st.editingId ? `${WORKER_BASE}/entries/${encodeURIComponent(st.editingId)}` : `${WORKER_BASE}/entries`;
    const r = await fetchWithRetry(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!r.ok) throw new Error(await r.text());
    let savedEntry = null;
    try {
      savedEntry = await r.json();
    } catch (err) {
      console.warn('Antwort konnte nicht gelesen werden:', err);
    }
    showToast(`Eintrag ${st.editingId ? 'aktualisiert' : 'gespeichert'}.`, 'ok');
    deps.hideManualPanel();
    if (savedEntry && savedEntry.id) {
      deps.queueDockAutoCheck(savedEntry.id, {
        entry: savedEntry,
        projectNumber: savedEntry.projectNumber || '',
        kvNummer: savedEntry.kv_nummer || '',
      });
    }
    await deps.loadHistory(true);
    if (payload.projectType === 'rahmen') {
      deps.renderFrameworkContracts();
    }
  } catch (e) { showToast('Speichern fehlgeschlagen.', 'bad'); console.error(e); }
  finally { hideLoader(); }
}

async function saveHunterAbruf(st) {
  const parentEntry = getEntries().find(e => e.id === st.parentEntry.id);
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
    await deps.loadHistory();
    deps.renderFrameworkContracts();
    const pendingAssignment = deps.getPendingDockAbrufAssignment?.();
    const assignmentId = st.dockAssignmentId || pendingAssignment?.entry?.id;
    if (assignmentId) {
      await deps.finalizeDockAbruf(assignmentId);
    }
    deps.showView('rahmen');
  } catch (e) {
    showToast('Speichern des Abrufs fehlgeschlagen.', 'bad');
    console.error(e);
  } finally {
    hideLoader();
  }
}

export function loadInputForm(inputData, isEditing = false) {
  const st = loadState() || {};
  const abrufInfo = document.getElementById('abrufInfo');
  const projectTypeWrapper = document.getElementById('projectTypeWrapper');

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
    if (abrufInfo) {
      const safeTitle = escapeHtml(st.parentEntry?.title || '');
      const safeClient = escapeHtml(st.parentEntry?.client || '');
      const safeProjectNumber = escapeHtml(st.parentEntry?.projectNumber || '–');
      const hint = st.parentEntry?.kv_list && st.parentEntry.kv_list.length
        ? `KV-Nummern: ${st.parentEntry.kv_list.join(', ')}`
        : '';
      abrufInfo.innerHTML = `
        <div class="abruf-context">
          <strong>Abruf aus Rahmenvertrag</strong>
          <div>${safeTitle} – ${safeClient} (${safeProjectNumber})</div>
          ${hint ? `<div class="abruf-kv-hint">${escapeHtml(hint)}</div>` : ''}
        </div>
      `;
    }

    if (projectNumber) {
      projectNumber.value = st.parentEntry.projectNumber || '';
      projectNumber.disabled = true;
    }
    if (kvNummer) {
      kvNummer.value = '';
      kvNummer.placeholder = 'KV-Nummer des Abrufs';
      kvNummer.disabled = false;
    }
    if (projectTypeWrapper) projectTypeWrapper.classList.add('hide');
    auftraggeber.value = st.parentEntry.client;
    auftraggeber.disabled = true;
    projekttitel.value = inputData.title || '';
    freigabedatum.value = freigabedatum.value || getTodayDate();
    baseDisabled.projectNumber = true;
    baseDisabled.kvNummer = false;
    baseDisabled.freigabedatum = false;
    configureMetaQuickEdit(false, baseDisabled);
  } else {
    if (abrufInfo) abrufInfo.innerHTML = '';
    if (projectTypeWrapper) projectTypeWrapper.classList.remove('hide');
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

  const weights = inputData.weights || [{ key: 'cs', weight: DEFAULT_WEIGHTS.cs }, { key: 'konzept', weight: DEFAULT_WEIGHTS.konzept }, { key: 'pitch', weight: DEFAULT_WEIGHTS.pitch }];
  const m = Object.fromEntries(weights.map(w => [w.key, w.weight]));
  w_cs.value = String(clamp01(toInt0(m.cs ?? DEFAULT_WEIGHTS.cs)));
  w_konzept.value = String(clamp01(toInt0(m.konzept ?? DEFAULT_WEIGHTS.konzept)));
  w_pitch.value = String(clamp01(toInt0(m.pitch ?? DEFAULT_WEIGHTS.pitch)));
  tbody.innerHTML = '';
  const rows = Array.isArray(inputData.rows) ? inputData.rows : [];
  if (rows.length > 0) {
    rows.forEach(r => {
      const tr = createRowTemplate();
      tbody.appendChild(tr);
      setupRow(tr, { saveCurrentInputState, recalc, findPersonByName });
      const nm = r.name || ''; tr.querySelector('.name').value = nm;
      const person = findPersonByName(nm); if (person) tr.querySelector('.name').dataset.personId = person.id;
      tr.querySelector('.cs').value = String(clamp01(toInt0(r.cs || 0)));
      tr.querySelector('.konzept').value = String(clamp01(toInt0(r.konzept || 0)));
      tr.querySelector('.pitch').value = String(clamp01(toInt0(r.pitch || 0)));
    });
  } else { addRow(true); addRow(false); }

  const factor = inputData.dockRewardFactor || 1.0;
  setSelectedWeightingFactor(factor);

  setHasUnsavedChanges(false);
  recalc();
  updateMetaSummary();
}

export function clearInputFields() {
  saveState({ source: 'manuell' });
  loadInputForm({}, false);
}

export function initFromState(isEditing = false) {
  const st = loadState();
  if (st?.input) {
    const isEditFromHistory = !!st.editingId;
    loadInputForm(st.input, isEditFromHistory);
  } else {
    loadInputForm({}, false);
  }
  updateWeightNote();
}

export function initErfassung(options = {}) {
  deps = { ...deps, ...options };
  wireInlineValidation();

  btnSave.addEventListener('click', async () => {
    const errors = validateInput();
    if (Object.keys(errors).length > 0) {
      displayValidation(errors);
      return;
    }
    setHasUnsavedChanges(false);

    const st = loadState(); if (!st?.input) return;

    if (st.isAbrufMode) {
      await saveHunterAbruf(st);
    } else {
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

      const conflict = deps.findDockKvConflict(kvNummer.value, entryId);
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
        deps.queueDockAutoCheck(entryId, { projectNumber: payload.projectNumber, kvNummer: payload.kv_nummer });
        await deps.loadHistory();
        deps.renderHistory();
        deps.renderFrameworkContracts();
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
}
