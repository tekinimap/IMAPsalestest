(() => {
  'use strict';

  const TEAMS = [
    'Vielfalt+','Evaluation und Beteiligung','Nachhaltigkeit','Sozial- und Krankenversicherungen',
    'ChangePartner','Bundes- und Landesbehörden','Kommunalverwaltungen',
    'Internationale Zusammenarbeit','Head of Organisational Excellence','Head of Public Impact'
  ];
  const DEFAULT_WEIGHTS = { cs: 50, konzept: 30, pitch: 20 };
  const CATEGORY_NAMES = { cs: 'Consultative Selling', konzept: 'Konzepterstellung', pitch: 'Pitch' };
  const FOUNDER_SHARE_PCT = 20;

  const loader = document.getElementById('loader');
  const toast = document.getElementById('toast');
  let hasUnsavedChanges = false;

  function showLoader() { if (loader) loader.classList.remove('hide'); }
  function hideLoader() { if (loader) loader.classList.add('hide'); }
  function showToast(message, type = 'ok', duration = 3000) {
    if (!toast) return;
    toast.textContent = message;
    toast.className = `toast show ${type}`;
    window.setTimeout(() => { toast.className = 'toast'; }, duration);
  }

  const fmtPct = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtInt = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });
  const fmtCurr2 = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtCurr0 = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const fmtAmount = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  function clamp01(v) { return Math.max(0, Math.min(100, v)); }
  function toInt0(v) {
    const num = Math.round(Number(String(v ?? '0').replace(',', '.')));
    return Number.isFinite(num) ? num : 0;
  }
  function parseAmountInput(str) {
    if (!str) return 0;
    const clean = String(str).replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.');
    const num = Number(clean);
    return Number.isFinite(num) ? num : 0;
  }
  function formatAmountInput(value) { return fmtAmount.format(value || 0); }
  function createId(prefix) {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    const rand = Math.floor(Math.random() * 1e6);
    return `${prefix}_${Date.now()}_${rand}`;
  }

  const LS_KEY = 'sales_state_v1';
  function saveState(state) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(state)); }
    catch { /* ignore */ }
  }
  function loadState() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  const STORAGE_KEYS = { entries: 'sales_entries_data_v2', people: 'sales_people_data_v2' };
  const memoryCache = {};
  const storage = (() => {
    try {
      const probe = '__sales_probe__';
      localStorage.setItem(probe, '1');
      localStorage.removeItem(probe);
      return localStorage;
    } catch {
      return null;
    }
  })();

  function deepClone(data) {
    return data == null ? data : JSON.parse(JSON.stringify(data));
  }

  function readStored(key) {
    if (storage) {
      try {
        const raw = storage.getItem(key);
        if (raw) return JSON.parse(raw);
      } catch (err) {
        console.warn('Konnte LocalStorage nicht lesen', err);
      }
    }
    return memoryCache[key] ? deepClone(memoryCache[key]) : null;
  }

  function writeStored(key, value) {
    if (storage) {
      try {
        storage.setItem(key, JSON.stringify(value));
        memoryCache[key] = null;
        return;
      } catch (err) {
        console.warn('Konnte LocalStorage nicht schreiben', err);
      }
    }
    memoryCache[key] = deepClone(value);
  }

  async function fetchJson(url) {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status} für ${url}`);
    return res.json();
  }

  async function loadInitial(key, url) {
    const stored = readStored(key);
    if (stored) return deepClone(stored);
    if (!url) return [];
    try {
      const data = await fetchJson(url);
      writeStored(key, data);
      return deepClone(data);
    } catch (err) {
      console.warn(`Falle auf leere Daten für ${url} zurück`, err);
      writeStored(key, []);
      return [];
    }
  }

  const dataStore = {
    async getPeople() { return loadInitial(STORAGE_KEYS.people, 'data/people.json'); },
    async setPeople(arr) { writeStored(STORAGE_KEYS.people, arr); },
    async getEntries() { return loadInitial(STORAGE_KEYS.entries, 'data/entries.json'); },
    async setEntries(arr) { writeStored(STORAGE_KEYS.entries, arr); }
  };

  const views = {
    erfassung: document.getElementById('viewErfassung'),
    fixauftraege: document.getElementById('viewFixauftraege'),
    rahmen: document.getElementById('viewRahmen'),
    rahmenDetails: document.getElementById('viewRahmenDetails'),
    admin: document.getElementById('viewAdmin'),
    analytics: document.getElementById('viewAnalytics')
  };
  const navLinks = document.querySelectorAll('.nav-link');

  function showView(name) {
    Object.values(views).forEach(v => v.classList.add('hide'));
    navLinks.forEach(l => l.classList.remove('active'));
    if (views[name]) {
      views[name].classList.remove('hide');
      const active = document.querySelector(`.nav-link[data-view="${name}"]`);
      if (active) active.classList.add('active');
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  navLinks.forEach(link => {
    link.addEventListener('click', (ev) => {
      ev.preventDefault();
      const viewName = link.getAttribute('data-view');
      if (viewName === 'fixauftraege') {
        loadHistory().then(() => showView('fixauftraege'));
      } else if (viewName === 'rahmen') {
        loadHistory().then(() => { renderFrameworkContracts(); showView('rahmen'); });
      } else if (viewName === 'analytics') {
        loadHistory().then(() => { renderAnalytics(); showView('analytics'); });
      } else if (viewName === 'admin') {
        handleAdminClick();
      } else if (viewName === 'erfassung') {
        if (hasUnsavedChanges && !views.erfassung.classList.contains('hide')) {
          const ok = window.confirm('Möchten Sie eine neue Erfassung starten? Ungespeicherte Änderungen gehen verloren.');
          if (!ok) return;
        }
        clearInputFields();
        initFromState();
        showView('erfassung');
      }
    });
  });

  async function handleAdminClick() {
    const pw = window.prompt('Bitte Passwort für Admin eingeben:');
    const ok = (pw || '').trim().toLowerCase() === 'imapadmin';
    if (!ok) { showToast('Falsches Passwort.', 'bad'); return; }
    try {
      showLoader();
      await loadPeople();
      renderPeopleAdmin();
      showView('admin');
    } catch (err) {
      console.error('Admin init fehlgeschlagen', err);
      showToast('Konnte Admin-Daten nicht laden.', 'bad');
    } finally {
      hideLoader();
    }
  }

  let people = [];
  const peopleList = document.getElementById('peopleList');
  function sortPeople() {
    people.sort((a, b) => {
      const lastA = a.name.split(' ').pop();
      const lastB = b.name.split(' ').pop();
      return lastA.localeCompare(lastB, 'de');
    });
  }

  async function loadPeople() {
    showLoader();
    try {
      const raw = await dataStore.getPeople();
      people = Array.isArray(raw) ? deepClone(raw) : [];
      sortPeople();
      if (peopleList) {
        peopleList.innerHTML = '';
        people.forEach(person => {
          const opt = document.createElement('option');
          opt.value = person.name;
          peopleList.appendChild(opt);
        });
      }
    } catch (err) {
      console.error('Personen konnten nicht geladen werden', err);
      people = [];
      showToast('Personenliste konnte nicht geladen werden.', 'bad');
    } finally {
      hideLoader();
    }
  }

  function findPersonByName(name) {
    const needle = String(name || '').toLowerCase();
    return people.find(p => p.name.toLowerCase() === needle) || null;
  }

  const tbody = document.getElementById('tbody');
  const sumchips = document.getElementById('sumchips');
  const auftraggeber = document.getElementById('auftraggeber');
  const projekttitel = document.getElementById('projekttitel');
  const auftragswert = document.getElementById('auftragswert');
  const auftragswertBekannt = document.getElementById('auftragswertBekannt');
  const submittedBy = document.getElementById('submittedBy');
  const projectNumber = document.getElementById('projectNumber');
  const w_cs = document.getElementById('w_cs');
  const w_konzept = document.getElementById('w_konzept');
  const w_pitch = document.getElementById('w_pitch');
  const w_note = document.getElementById('w_note');
  const btnAddRow = document.getElementById('btnAddRow');
  const btnSave = document.getElementById('btnSave');

  function rowTemplate() {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="text" class="name" placeholder="Namen eintippen oder auswählen..." list="peopleList"></td>
      <td><input type="number" class="cs" min="0" max="100" step="1" value="0"></td>
      <td><input type="number" class="konzept" min="0" max="100" step="1" value="0"></td>
      <td><input type="number" class="pitch" min="0" max="100" step="1" value="0"></td>
      <td><div class="live-result"><span class="pct">- %</span><span class="money">- €</span></div></td>
      <td><button type="button" class="delrow">Entfernen</button></td>`;
    return tr;
  }

  function bindRow(tr) {
    tr.addEventListener('input', (ev) => {
      hasUnsavedChanges = true;
      const target = ev.target;
      if (target.matches('input[type="number"]')) {
        target.value = String(clamp01(toInt0(target.value)));
      }
      if (target.classList.contains('name')) {
        const p = findPersonByName(target.value);
        if (p) target.dataset.personId = p.id; else delete target.dataset.personId;
      }
      saveCurrentInputState();
      recalc();
    });
    const delBtn = tr.querySelector('.delrow');
    if (delBtn) {
      delBtn.addEventListener('click', () => {
        tr.remove();
        hasUnsavedChanges = true;
        saveCurrentInputState();
        recalc();
      });
    }
  }

  function addRow(focus = false) {
    const tr = rowTemplate();
    tbody.appendChild(tr);
    bindRow(tr);
    if (focus) tr.querySelector('.name').focus();
    saveCurrentInputState();
    recalc();
  }

  function readRows() {
    const rows = [];
    tbody.querySelectorAll('tr').forEach(tr => {
      rows.push({
        personId: tr.querySelector('.name').dataset.personId || null,
        name: (tr.querySelector('.name').value || '').trim(),
        cs: toInt0(tr.querySelector('.cs').value),
        konzept: toInt0(tr.querySelector('.konzept').value),
        pitch: toInt0(tr.querySelector('.pitch').value)
      });
    });
    return rows;
  }

  function totals(rows) {
    return rows.reduce((acc, row) => {
      acc.cs += row.cs;
      acc.konzept += row.konzept;
      acc.pitch += row.pitch;
      return acc;
    }, { cs: 0, konzept: 0, pitch: 0 });
  }

  function renderChips(total) {
    sumchips.innerHTML = '';
    [['cs', 'Consultative Selling'], ['konzept', 'Konzepterstellung'], ['pitch', 'Pitch']].forEach(([key, label]) => {
      const val = total[key];
      const div = document.createElement('div');
      div.className = 'chip';
      const dot = document.createElement('span');
      dot.className = 'dot';
      const txt = document.createElement('span');
      txt.innerHTML = `<strong>${label}</strong> &nbsp; ${fmtInt.format(val)} / 100`;
      if (val === 0 || val === 100) div.classList.add('ok');
      else if (val > 100) div.classList.add('bad');
      else div.classList.add('warn');
      div.appendChild(dot);
      div.appendChild(txt);
      sumchips.appendChild(div);
    });
  }

  function currentWeights() {
    return [
      { key: 'cs', weight: clamp01(toInt0(w_cs.value)) },
      { key: 'konzept', weight: clamp01(toInt0(w_konzept.value)) },
      { key: 'pitch', weight: clamp01(toInt0(w_pitch.value)) }
    ];
  }

  function updateWeightNote() {
    const sum = currentWeights().reduce((acc, item) => acc + Number(item.weight || 0), 0);
    if (w_note) w_note.textContent = `Summe Gewichte: ${sum} %`;
  }

  function validateInput(forLive = false) {
    const errors = {};
    const st = loadState() || {};
    if (!forLive) {
      if (!auftraggeber.value.trim() && !st.isAbrufMode) errors.auftraggeber = 'Auftraggeber ist erforderlich.';
      if (!projekttitel.value.trim()) errors.projekttitel = st.isAbrufMode ? 'Titel des Abrufs ist erforderlich.' : 'Projekttitel ist erforderlich.';
      if (!submittedBy.value) errors.submittedBy = 'Einschätzung von ist erforderlich.';
      if (!readRows().some(r => r.cs + r.konzept + r.pitch > 0)) errors.rows = 'Mindestens eine Person mit Punkten erfassen.';
      if (auftragswertBekannt.checked && parseAmountInput(auftragswert.value) <= 0) errors.auftragswert = 'Ein Auftragswert > 0 ist erforderlich.';
    }

    const t = totals(readRows());
    const weights = currentWeights();
    const categoryErrors = [];
    weights.forEach(w => {
      if (forLive) {
        if (t[w.key] > 100) categoryErrors.push(`${CATEGORY_NAMES[w.key]} > 100`);
      } else {
        if (w.weight > 0 && t[w.key] !== 100) {
          categoryErrors.push(`Für ${CATEGORY_NAMES[w.key]} (${w.weight}%) müssen 100 Punkte vergeben werden (aktuell ${t[w.key]}).`);
        }
        if (w.weight === 0 && t[w.key] > 0 && t[w.key] < 100) {
          categoryErrors.push(`Für ${CATEGORY_NAMES[w.key]} (0%) müssen die Punkte 0 oder 100 sein.`);
        }
      }
    });
    if (categoryErrors.length > 0) errors.categories = categoryErrors.join(' | ');

    const sumW = weights.reduce((acc, item) => acc + Number(item.weight || 0), 0);
    if (!forLive && sumW !== 100) errors.weights = `Gewichtungs-Summe muss 100 sein (aktuell ${sumW}).`;
    if (forLive && sumW === 0) errors.weights = 'Gewichte dürfen nicht 0 sein für Live-Berechnung.';

    return errors;
  }

  function clearValidation() {
    document.querySelectorAll('.field-error').forEach(el => { el.textContent = ''; });
    document.querySelectorAll('.invalid-field').forEach(el => el.classList.remove('invalid-field'));
  }

  function displayValidation(errors) {
    clearValidation();
    Object.keys(errors).forEach(key => {
      const field = document.querySelector(`[data-validation-for="${key}"]`);
      if (field) field.textContent = errors[key];
      const input = document.getElementById(key);
      if (input) input.classList.add('invalid-field');
    });
  }

  function updateLiveResults(resultList) {
    const map = new Map(resultList.map(item => [item.key, item]));
    document.querySelectorAll('#tbody tr').forEach((tr, idx) => {
      const name = tr.querySelector('.name').value.trim();
      const resultEl = tr.querySelector('.live-result');
      const key = name || `_temp_${idx}`;
      const info = map.get(key);
      if (info && auftragswertBekannt.checked) {
        resultEl.querySelector('.pct').textContent = `${fmtPct.format(info.pct)} %`;
        resultEl.querySelector('.money').textContent = fmtCurr0.format(info.money);
      } else if (info) {
        resultEl.querySelector('.pct').textContent = `${fmtPct.format(info.pct)} %`;
        resultEl.querySelector('.money').textContent = '- €';
      } else {
        resultEl.querySelector('.pct').textContent = '- %';
        resultEl.querySelector('.money').textContent = '- €';
      }
    });
  }

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

  function saveCurrentInputState() {
    const prev = loadState() || {};
    const current = {
      client: auftraggeber.value.trim(),
      title: projekttitel.value.trim(),
      amount: parseAmountInput(auftragswert.value),
      amountKnown: auftragswertBekannt.checked,
      projectType: document.querySelector('input[name="projectType"]:checked').value,
      rows: readRows(),
      weights: currentWeights(),
      submittedBy: submittedBy.value,
      projectNumber: projectNumber.disabled ? (prev?.input?.projectNumber || '') : projectNumber.value.trim()
    };
    saveState({ ...prev, input: current });
  }

  [auftraggeber, projekttitel, auftragswert, submittedBy].forEach(el => {
    el.addEventListener('input', () => {
      hasUnsavedChanges = true;
      saveCurrentInputState();
      recalc();
    });
  });
  document.querySelectorAll('input[name="projectType"]').forEach(radio => {
    radio.addEventListener('change', () => {
      hasUnsavedChanges = true;
      saveCurrentInputState();
      recalc();
    });
  });
  projectNumber.addEventListener('input', () => {
    if (!projectNumber.disabled) {
      hasUnsavedChanges = true;
      saveCurrentInputState();
      recalc();
    }
  });
  auftragswertBekannt.addEventListener('change', () => {
    auftragswert.disabled = !auftragswertBekannt.checked;
    if (!auftragswertBekannt.checked) auftragswert.value = '';
    hasUnsavedChanges = true;
    saveCurrentInputState();
    recalc();
  });
  auftragswert.addEventListener('blur', () => {
    const raw = parseAmountInput(auftragswert.value);
    auftragswert.value = raw > 0 ? formatAmountInput(raw) : '';
    saveCurrentInputState();
    recalc();
  });
  [w_cs, w_konzept, w_pitch].forEach(el => el.addEventListener('input', () => {
    el.value = String(clamp01(toInt0(el.value)));
    hasUnsavedChanges = true;
    updateWeightNote();
    saveCurrentInputState();
    recalc();
  }));
  btnAddRow.addEventListener('click', () => addRow(true));

  btnSave.addEventListener('click', async () => {
    const errors = validateInput();
    if (Object.keys(errors).length > 0) {
      displayValidation(errors);
      return;
    }
    hasUnsavedChanges = false;
    const st = loadState();
    if (!st?.input) return;
    if (st.isAbrufMode) {
      await saveHunterAbruf(st);
    } else {
      await saveNewEntry(st);
    }
  });

  function loadInputForm(inputData, isEditing = false) {
    const st = loadState() || {};
    const abrufInfo = document.getElementById('abrufInfo');
    const erfassungSub = document.getElementById('erfassungSub');
    const projectTypeWrapper = document.getElementById('projectTypeWrapper');

    if (st.isAbrufMode && st.parentEntry) {
      abrufInfo.classList.remove('hide');
      abrufInfo.innerHTML = `Sie erfassen einen <b>aktiven Abruf</b> für den Rahmenvertrag: <b>${st.parentEntry.title}</b>. <br> ${100 - FOUNDER_SHARE_PCT}% des Werts werden auf die hier erfassten Personen verteilt.`;
      erfassungSub.textContent = 'Neuen aktiven Abruf erfassen.';
      projectTypeWrapper.classList.add('hide');
      auftraggeber.value = st.parentEntry.client;
      auftraggeber.disabled = true;
      projekttitel.value = inputData.title || '';
    } else {
      abrufInfo.classList.add('hide');
      erfassungSub.textContent = 'Neuen Auftrag oder Rahmenvertrag anlegen.';
      projectTypeWrapper.classList.remove('hide');
      auftraggeber.value = inputData.client || '';
      auftraggeber.disabled = false;
      projekttitel.value = inputData.title || '';
    }

    auftragswertBekannt.checked = inputData.amountKnown !== false;
    auftragswert.disabled = !auftragswertBekannt.checked;
    auftragswert.value = inputData.amount > 0 ? formatAmountInput(inputData.amount) : '';
    submittedBy.value = inputData.submittedBy || '';
    const projectType = inputData.projectType || 'fix';
    const radio = document.querySelector(`input[name="projectType"][value="${projectType}"]`);
    if (radio) radio.checked = true;
    projectNumber.value = inputData.projectNumber || '';
    if (isEditing) {
      projectNumber.removeAttribute('disabled');
      projectNumber.placeholder = 'Projektnummer eintragen';
    } else {
      projectNumber.setAttribute('disabled', 'true');
      projectNumber.placeholder = 'Wird später eingetragen';
    }

    const weights = inputData.weights || [
      { key: 'cs', weight: DEFAULT_WEIGHTS.cs },
      { key: 'konzept', weight: DEFAULT_WEIGHTS.konzept },
      { key: 'pitch', weight: DEFAULT_WEIGHTS.pitch }
    ];
    const map = Object.fromEntries(weights.map(w => [w.key, w.weight]));
    w_cs.value = String(clamp01(toInt0(map.cs ?? DEFAULT_WEIGHTS.cs)));
    w_konzept.value = String(clamp01(toInt0(map.konzept ?? DEFAULT_WEIGHTS.konzept)));
    w_pitch.value = String(clamp01(toInt0(map.pitch ?? DEFAULT_WEIGHTS.pitch)));

    tbody.innerHTML = '';
    const rows = Array.isArray(inputData.rows) ? inputData.rows : [];
    if (rows.length > 0) {
      rows.forEach(row => {
        const tr = rowTemplate();
        tbody.appendChild(tr);
        bindRow(tr);
        const name = row.name || '';
        tr.querySelector('.name').value = name;
        const person = findPersonByName(name);
        if (person) tr.querySelector('.name').dataset.personId = person.id;
        tr.querySelector('.cs').value = String(clamp01(toInt0(row.cs || 0)));
        tr.querySelector('.konzept').value = String(clamp01(toInt0(row.konzept || 0)));
        tr.querySelector('.pitch').value = String(clamp01(toInt0(row.pitch || 0)));
      });
    } else {
      addRow(true);
      addRow(false);
    }
    hasUnsavedChanges = false;
    updateWeightNote();
    recalc();
  }

  function clearInputFields() {
    saveState({ source: 'manuell' });
    loadInputForm({}, false);
  }

  function compute(rows, weights, amount, forLive = false) {
    const total = totals(rows);
    const usedKeys = Object.entries(total).filter(([, val]) => val > 0).map(([key]) => key);
    const effectiveWeights = (weights && weights.length ? weights : [
      { key: 'cs', weight: DEFAULT_WEIGHTS.cs },
      { key: 'konzept', weight: DEFAULT_WEIGHTS.konzept },
      { key: 'pitch', weight: DEFAULT_WEIGHTS.pitch }
    ]);
    const calcWeights = forLive ? effectiveWeights : normalizeWeightsForUsed(effectiveWeights, usedKeys);

    const map = new Map();
    rows.forEach((row, idx) => {
      const active = row.cs + row.konzept + row.pitch > 0;
      const key = row.name.trim() || `_temp_${idx}`;
      if (!row.name.trim() && !active) return;
      const cur = map.get(key) || { name: row.name, cs: 0, konzept: 0, pitch: 0 };
      cur.cs += row.cs;
      cur.konzept += row.konzept;
      cur.pitch += row.pitch;
      map.set(key, cur);
    });

    const weightMap = Object.fromEntries(calcWeights.map(w => [w.key, (w.weight || 0) / 100]));
    const list = [];
    for (const [key, val] of map.entries()) {
      let pct = 0;
      const divCS = forLive ? 100 : (total.cs || 1);
      const divKonzept = forLive ? 100 : (total.konzept || 1);
      const divPitch = forLive ? 100 : (total.pitch || 1);
      if (usedKeys.includes('cs') && total.cs > 0) pct += weightMap.cs * (val.cs / divCS);
      if (usedKeys.includes('konzept') && total.konzept > 0) pct += weightMap.konzept * (val.konzept / divKonzept);
      if (usedKeys.includes('pitch') && total.pitch > 0) pct += weightMap.pitch * (val.pitch / divPitch);
      list.push({ key, name: val.name, pct: pct * 100 });
    }
    list.sort((a, b) => b.pct - a.pct);
    if (!forLive) {
      const sum = list.reduce((acc, item) => acc + item.pct, 0);
      const resid = 100 - sum;
      if (list.length && Math.abs(resid) > 1e-9) list[0].pct += resid;
    }
    list.forEach(item => { if (item.pct < 0) item.pct = 0; });
    const withMoney = list.map(item => ({ ...item, money: Math.round((amount > 0 ? amount : 0) * item.pct / 100) }));
    return { totals: total, usedKeys, effectiveWeights: calcWeights, list: withMoney };
  }

  function normalizeWeightsForUsed(allWeights, usedKeys) {
    const used = allWeights.filter(w => usedKeys.includes(w.key));
    const sum = used.reduce((acc, w) => acc + w.weight, 0);
    if (sum <= 0) return allWeights.map(w => ({ key: w.key, weight: w.weight }));
    const factor = 100 / sum;
    const out = allWeights.map(w => usedKeys.includes(w.key) ? { key: w.key, weight: w.weight * factor } : { key: w.key, weight: 0 });
    const rem = 100 - out.reduce((acc, w) => acc + Math.round(w.weight), 0);
    if (rem !== 0) {
      const idx = out.findIndex(x => usedKeys.includes(x.key));
      if (idx >= 0) out[idx].weight += rem;
    }
    return out.map(w => ({ key: w.key, weight: Math.round(w.weight) }));
  }

  const historyBody = document.getElementById('historyBody');
  const omniSearch = document.getElementById('omniSearch');
  const btnXlsx = document.getElementById('btnXlsx');
  const confirmDlg = document.getElementById('confirmDlg');
  const confirmTitle = document.getElementById('confirmTitle');
  const confirmText = document.getElementById('confirmText');
  let entries = [];
  let pendingDeleteId = null;
  let currentSort = { key: 'ts', direction: 'desc' };

  async function loadHistory() {
    showLoader();
    try {
      const raw = await dataStore.getEntries();
      entries = Array.isArray(raw) ? deepClone(raw) : [];
      renderHistory();
      return entries;
    } catch (err) {
      console.error('Daten konnten nicht geladen werden', err);
      entries = [];
      showToast('Daten konnten nicht geladen werden.', 'bad');
      return [];
    } finally {
      hideLoader();
    }
  }

  function autoComplete(entry) {
    return !!(entry.client && entry.title && (entry.amount > 0) && Array.isArray(entry.list) && entry.list.length > 0);
  }

  function filtered(type = 'fix') {
    let arr = entries.filter(e => (e.projectType || 'fix') === type);
    const query = omniSearch.value.trim().toLowerCase();
    const terms = query.split(/\s+/).filter(Boolean);
    const filters = [];
    const searchTerms = [];
    terms.forEach(term => {
      if (term.includes(':')) {
        const [key, ...rest] = term.split(':');
        if (rest.length > 0) filters.push({ key, value: rest.join(':') });
      } else {
        searchTerms.push(term);
      }
    });
    const searchText = searchTerms.join(' ');
    if (searchText) {
      arr = arr.filter(e =>
        String(e.title || '').toLowerCase().includes(searchText) ||
        String(e.client || '').toLowerCase().includes(searchText)
      );
    }
    filters.forEach(({ key, value }) => {
      if (key === 'status') {
        const wantOk = value.startsWith('v') || value.startsWith('o');
        arr = arr.filter(e => wantOk ? autoComplete(e) : !autoComplete(e));
      }
      if (key === 'quelle' || key === 'source') {
        arr = arr.filter(e => (e.source || '').toLowerCase().startsWith(value));
      }
      if ((key === 'wert' || key === 'amount') && (value.startsWith('>') || value.startsWith('<'))) {
        const num = parseFloat(value.substring(1));
        if (!Number.isNaN(num)) {
          if (value.startsWith('>')) arr = arr.filter(e => (e.amount || 0) > num);
          if (value.startsWith('<')) arr = arr.filter(e => (e.amount || 0) < num);
        }
      }
    });
    arr.sort((a, b) => {
      let valA = a[currentSort.key] || '';
      let valB = b[currentSort.key] || '';
      if (currentSort.key === 'ts') {
        valA = a.modified || a.ts || 0;
        valB = b.modified || b.ts || 0;
      }
      let cmp = 0;
      if (typeof valA === 'string' && typeof valB === 'string') cmp = valA.localeCompare(valB, 'de');
      else cmp = Number(valA) - Number(valB);
      return currentSort.direction === 'asc' ? cmp : -cmp;
    });
    return arr;
  }

  function renderHistory() {
    if (!historyBody) return;
    historyBody.innerHTML = '';
    updateSortIcons();
    const arr = filtered('fix');
    arr.forEach(e => {
      const status = `<span class="status ${autoComplete(e) ? 'ok' : 'bad'}">${autoComplete(e) ? 'vollständig' : 'unvollständig'}</span>`;
      const modified = e.modified ? new Date(e.modified).toLocaleString('de-DE') : (e.ts ? new Date(e.ts).toLocaleString('de-DE') : '–');
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${e.title || '–'}</td>
        <td>${e.client || '–'}</td>
        <td>${e.source || '–'}</td>
        <td>${status}</td>
        <td>${e.amount ? fmtCurr2.format(e.amount) : '–'}</td>
        <td>${modified}</td>
        <td style="display:flex;gap:8px;align-items:center">
          <button class="iconbtn" data-act="edit" data-id="${e.id}" title="Bearbeiten">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" stroke="currentColor" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="iconbtn" data-act="del" data-id="${e.id}" title="Löschen">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" stroke="currentColor" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </td>`;
      historyBody.appendChild(tr);
    });
  }

  omniSearch.addEventListener('input', renderHistory);
  document.querySelectorAll('#viewFixauftraege th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (currentSort.key === key) {
        currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
      } else {
        currentSort.key = key;
        currentSort.direction = (key === 'title' || key === 'client' || key === 'source') ? 'asc' : 'desc';
      }
      renderHistory();
    });
  });

  function updateSortIcons() {
    document.querySelectorAll('#viewFixauftraege th.sortable .sort-icon').forEach(icon => {
      icon.textContent = '';
      icon.style.opacity = 0.5;
    });
    const active = document.querySelector(`#viewFixauftraege th[data-sort="${currentSort.key}"] .sort-icon`);
    if (active) {
      active.textContent = currentSort.direction === 'asc' ? '▲' : '▼';
      active.style.opacity = 1;
    }
  }

  function handleDeleteClick(id) {
    const pw = window.prompt('Zum Löschen bitte Admin-Passwort eingeben:');
    if (pw !== 'imapadmin') {
      if (pw !== null) showToast('Falsches Passwort.', 'bad');
      return;
    }
    pendingDeleteId = id;
    if (confirmTitle) confirmTitle.textContent = 'Eintrag löschen';
    if (confirmText) confirmText.textContent = 'Wollen Sie den Eintrag wirklich löschen?';
    confirmDlg.showModal();
  }

  historyBody.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.getAttribute('data-id');
    const act = btn.getAttribute('data-act');
    if (act === 'edit') {
      editEntry(id);
    } else if (act === 'del') {
      handleDeleteClick(id);
    }
  });

  function editEntry(id) {
    const entry = entries.find(e => e.id === id);
    if (!entry) return;
    const state = {
      source: entry.source || 'manuell',
      editingId: entry.id,
      input: {
        client: entry.client || '',
        title: entry.title || '',
        amount: entry.amount || 0,
        amountKnown: entry.amount > 0,
        projectType: entry.projectType || 'fix',
        submittedBy: entry.submittedBy || '',
        projectNumber: entry.projectNumber || '',
        rows: Array.isArray(entry.rows) && entry.rows.length ? entry.rows : (Array.isArray(entry.list) ? entry.list.map(x => ({ name: x.name, cs: 0, konzept: 0, pitch: 0 })) : []),
        weights: Array.isArray(entry.weights) ? entry.weights : [
          { key: 'cs', weight: DEFAULT_WEIGHTS.cs },
          { key: 'konzept', weight: DEFAULT_WEIGHTS.konzept },
          { key: 'pitch', weight: DEFAULT_WEIGHTS.pitch }
        ]
      }
    };
    saveState(state);
    initFromState(true);
    showView('erfassung');
  }

  document.getElementById('btnNo').addEventListener('click', () => confirmDlg.close());
  document.getElementById('btnYes').addEventListener('click', async () => {
    const id = pendingDeleteId;
    pendingDeleteId = null;
    confirmDlg.close();
    if (!id) return;
    showLoader();
    try {
      entries = entries.filter(e => e.id !== id);
      await dataStore.setEntries(entries);
      showToast('Eintrag gelöscht.', 'ok');
      renderHistory();
      renderFrameworkContracts();
      if (!views.analytics.classList.contains('hide')) renderAnalytics();
    } catch (err) {
      console.error('Löschen fehlgeschlagen', err);
      showToast('Löschen fehlgeschlagen.', 'bad');
    } finally {
      hideLoader();
    }
  });

  btnXlsx.addEventListener('click', () => {
    const arr = filtered('fix').map(e => ({
      Projektnummer: e.projectNumber || '',
      Titel: e.title || '',
      Auftraggeber: e.client || '',
      Quelle: e.source || '',
      Status: autoComplete(e) ? 'vollständig' : 'unvollständig',
      Wert_EUR: e.amount || 0,
      Zuletzt_bearbeitet: e.modified ? new Date(e.modified).toISOString() : (e.ts ? new Date(e.ts).toISOString() : '')
    }));
    const ws = XLSX.utils.json_to_sheet(arr);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Fixaufträge');
    XLSX.writeFile(wb, 'fixauftraege_export.xlsx');
  });

  const rahmenBody = document.getElementById('rahmenBody');
  const addFounderValueDlg = document.getElementById('addFounderValueDlg');
  const founderValueInput = document.getElementById('founderValueInput');
  let currentFrameworkEntryId = null;

  function renderFrameworkContracts() {
    if (!rahmenBody) return;
    rahmenBody.innerHTML = '';
    const rahmenEntries = entries
      .filter(e => e.projectType === 'rahmen')
      .sort((a, b) => (b.modified || b.ts || 0) - (a.modified || a.ts || 0));
    rahmenEntries.forEach(entry => {
      const tr = document.createElement('tr');
      const totalValue = (entry.transactions || []).reduce((sum, t) => sum + (t.amount || 0), entry.amount || 0);
      tr.innerHTML = `
        <td>${entry.projectNumber || '–'}</td>
        <td>${entry.title || '–'}</td>
        <td>${entry.client || '–'}</td>
        <td>${fmtCurr2.format(totalValue)}</td>
        <td style="display:flex;gap:8px;align-items:center">
          <button class="btn ok" data-act="founder-plus" data-id="${entry.id}" title="Passiver Abruf">+ Founder</button>
          <button class="btn primary" data-act="hunter-plus" data-id="${entry.id}" title="Aktiver Abruf">+ Hunter</button>
          <button class="iconbtn" data-act="details" data-id="${entry.id}" title="Details/Bearbeiten">
            <svg xmlns="http://www.w3.org/2000/svg" height="24" viewBox="0 -960 960 960" width="24"><path fill="currentColor" d="M380-240q-25 0-42.5-17.5T320-300q0-25 17.5-42.5T380-360q25 0 42.5 17.5T440-300q0 25-17.5 42.5T380-240Zm200 0q-25 0-42.5-17.5T520-300q0-25 17.5-42.5T580-360q25 0 42.5 17.5T640-300q0 25-17.5 42.5T580-240ZM120-120v-80h720v80H120Zm60-200v-360q0-25 17.5-42.5T240-740h480q25 0 42.5 17.5T800-680v360L700-420H260L180-320Z"/></svg>
          </button>
        </td>`;
      rahmenBody.appendChild(tr);
    });
  }

  rahmenBody.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    const id = btn.dataset.id;
    currentFrameworkEntryId = id;
    const entry = entries.find(e => e.id === id);
    if (!entry) return;
    if (act === 'founder-plus') {
      founderValueInput.value = '';
      addFounderValueDlg.showModal();
    } else if (act === 'hunter-plus') {
      saveState({ source: 'manuell', isAbrufMode: true, parentEntry: entry, input: {} });
      initFromState();
      showView('erfassung');
    } else if (act === 'details') {
      renderRahmenDetails(id);
      showView('rahmenDetails');
    }
  });

  document.getElementById('btnFounderCancel').addEventListener('click', () => addFounderValueDlg.close());
  document.getElementById('btnFounderSave').addEventListener('click', async () => {
    const addedAmount = parseAmountInput(founderValueInput.value);
    if (addedAmount <= 0) {
      showToast('Bitte einen Wert > 0 eingeben.', 'bad');
      return;
    }
    const entry = entries.find(e => e.id === currentFrameworkEntryId);
    if (!entry) return;
    if (!Array.isArray(entry.transactions)) entry.transactions = [];
    const transaction = {
      id: createId('trans'),
      type: 'founder',
      amount: addedAmount,
      ts: Date.now()
    };
    entry.transactions.push(transaction);
    entry.modified = Date.now();
    try {
      showLoader();
      await dataStore.setEntries(entries);
      showToast('Passiver Abruf hinzugefügt', 'ok');
      addFounderValueDlg.close();
      renderFrameworkContracts();
      if (!views.analytics.classList.contains('hide')) renderAnalytics();
      if (!views.rahmenDetails.classList.contains('hide')) renderRahmenDetails(entry.id);
    } catch (err) {
      console.error('Update fehlgeschlagen', err);
      showToast('Update fehlgeschlagen.', 'bad');
      entry.transactions.pop();
    } finally {
      hideLoader();
    }
  });

  async function saveHunterAbruf(state) {
    const parent = entries.find(e => e.id === state.parentEntry.id);
    if (!parent) {
      showToast('Rahmenvertrag nicht gefunden.', 'bad');
      return;
    }
    const abrufAmount = state.input.amountKnown ? state.input.amount : 0;
    const hunterShareAmount = abrufAmount * (1 - (FOUNDER_SHARE_PCT / 100));
    const resultData = compute(state.input.rows, state.input.weights, hunterShareAmount);
    if (!Array.isArray(parent.transactions)) parent.transactions = [];
    parent.transactions.push({
      id: createId('trans'),
      type: 'hunter',
      title: state.input.title,
      amount: abrufAmount,
      ts: Date.now(),
      submittedBy: state.input.submittedBy,
      rows: state.input.rows,
      list: resultData.list,
      weights: resultData.effectiveWeights
    });
    parent.modified = Date.now();
    try {
      showLoader();
      await dataStore.setEntries(entries);
      showToast('Aktiver Abruf hinzugefügt', 'ok');
      clearInputFields();
      renderFrameworkContracts();
      showView('rahmen');
      if (!views.analytics.classList.contains('hide')) renderAnalytics();
    } catch (err) {
      console.error('Speichern des Abrufs fehlgeschlagen', err);
      showToast('Speichern des Abrufs fehlgeschlagen.', 'bad');
      parent.transactions.pop();
    } finally {
      hideLoader();
    }
  }

  document.getElementById('backToRahmen').addEventListener('click', () => showView('rahmen'));

  function renderRahmenDetails(id) {
    const entry = entries.find(e => e.id === id);
    if (!entry) return;
    document.getElementById('rahmenDetailsTitle').textContent = entry.title;
    document.getElementById('rahmenDetailsSub').textContent = `${entry.client || ''} | ${entry.projectNumber || ''}`;
    const foundersBody = document.getElementById('rahmenFoundersBody');
    foundersBody.innerHTML = '';
    (entry.list || []).forEach(founder => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${founder.name}</td><td>${fmtPct.format(founder.pct)} %</td>`;
      foundersBody.appendChild(tr);
    });
    const transBody = document.getElementById('rahmenTransaktionenBody');
    transBody.innerHTML = '';
    (entry.transactions || []).forEach(trans => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${new Date(trans.ts).toLocaleDateString('de-DE')}</td>
        <td>${trans.type === 'founder' ? 'Passiv' : 'Aktiv'}</td>
        <td>${trans.title || '-'}</td>
        <td>${fmtCurr2.format(trans.amount || 0)}</td>
        <td>-</td>`;
      transBody.appendChild(tr);
    });
  }

  const admName = document.getElementById('adm_name');
  const admTeam = document.getElementById('adm_team');
  const admBody = document.getElementById('adm_body');
  const adminSearch = document.getElementById('adminSearch');

  document.getElementById('adm_add').addEventListener('click', () => adminCreate());
  admName.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') adminCreate(); });
  adminSearch.addEventListener('input', renderPeopleAdmin);

  function renderPeopleAdmin() {
    if (!admBody) return;
    admBody.innerHTML = '';
    const query = adminSearch.value.toLowerCase();
    const filteredPeople = people.filter(p =>
      p.name.toLowerCase().includes(query) ||
      String(p.team || '').toLowerCase().includes(query)
    );
    filteredPeople.forEach(p => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><input type="text" value="${p.name}"></td>
        <td><select>
          <option value="">— bitte wählen —</option>
          ${TEAMS.map(team => `<option value="${team}" ${p.team === team ? 'selected' : ''}>${team}</option>`).join('')}
        </select></td>
        <td style="display:flex;gap:8px">
          <button class="iconbtn" data-act="save" data-id="${p.id}" title="Speichern">
            <svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7" stroke-width="3" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <button class="iconbtn" data-act="del" data-id="${p.id}" title="Löschen">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </td>`;
      admBody.appendChild(tr);
    });
  }

  admBody.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.getAttribute('data-id');
    const act = btn.getAttribute('data-act');
    const row = btn.closest('tr');
    const name = row.querySelector('td:nth-child(1) input').value.trim();
    const team = row.querySelector('td:nth-child(2) select').value;
    if (act === 'save') {
      if (!name) {
        showToast('Name darf nicht leer sein.', 'bad');
        return;
      }
      try {
        showLoader();
        const idx = people.findIndex(p => p.id === id);
        if (idx >= 0) {
          people[idx] = { ...people[idx], name, team };
          await dataStore.setPeople(people);
          await loadPeople();
          renderPeopleAdmin();
          showToast('Person gespeichert.', 'ok');
        }
      } catch (err) {
        console.error('Speichern fehlgeschlagen', err);
        showToast('Aktion fehlgeschlagen.', 'bad');
      } finally {
        hideLoader();
      }
    } else if (act === 'del') {
      if (!window.confirm('Person wirklich löschen?')) return;
      try {
        showLoader();
        people = people.filter(p => p.id !== id);
        await dataStore.setPeople(people);
        await loadPeople();
        renderPeopleAdmin();
        showToast('Person gelöscht.', 'ok');
      } catch (err) {
        console.error('Löschen fehlgeschlagen', err);
        showToast('Aktion fehlgeschlagen.', 'bad');
      } finally {
        hideLoader();
      }
    }
  });

  async function adminCreate() {
    const name = admName.value.trim();
    const team = admTeam.value;
    if (!name || !team) {
      showToast('Bitte Name und Team ausfüllen.', 'bad');
      return;
    }
    try {
      showLoader();
      const newPerson = { id: createId('p'), name, team };
      people.push(newPerson);
      sortPeople();
      await dataStore.setPeople(people);
      await loadPeople();
      renderPeopleAdmin();
      admName.value = '';
      admTeam.value = '';
      showToast('Person angelegt.', 'ok');
    } catch (err) {
      console.error('Anlegen fehlgeschlagen', err);
      showToast('Anlegen fehlgeschlagen.', 'bad');
    } finally {
      hideLoader();
    }
  }

  const anaYear = document.getElementById('anaYear');
  for (let year = 2022; year <= new Date().getFullYear() + 1; year++) {
    const opt = document.createElement('option');
    opt.value = String(year);
    opt.textContent = String(year);
    anaYear.appendChild(opt);
  }
  anaYear.value = String(new Date().getFullYear());
  document.getElementById('anaRefresh').addEventListener('click', renderAnalytics);
  const btnAnaXlsx = document.getElementById('btnAnaXlsx');

  let analyticsData = { persons: [], teams: [] };

  function renderAnalytics() {
    const year = Number(anaYear.value);
    const start = new Date(Date.UTC(year, 0, 1)).getTime();
    const end = new Date(Date.UTC(year + 1, 0, 1)).getTime();
    const per = new Map();
    entries.forEach(entry => {
      if ((entry.projectType || 'fix') === 'fix') {
        const when = entry.ts || 0;
        if (!(when >= start && when < end)) return;
        const amount = entry.amount || 0;
        if (amount <= 0) return;
        if (Array.isArray(entry.list)) {
          entry.list.forEach(x => {
            const key = x.name || 'Unbekannt';
            const money = Math.round(amount * (x.pct || 0) / 100);
            per.set(key, (per.get(key) || 0) + money);
          });
        }
      } else if (entry.projectType === 'rahmen') {
        const initialWhen = entry.ts || 0;
        if (initialWhen >= start && initialWhen < end && entry.amount > 0) {
          (entry.list || []).forEach(x => {
            const key = x.name;
            const money = Math.round(entry.amount * ((x.pct || 0) / 100));
            per.set(key, (per.get(key) || 0) + money);
          });
        }
        (entry.transactions || []).forEach(trans => {
          const transWhen = trans.ts || 0;
          if (!(transWhen >= start && transWhen < end)) return;
          if (trans.type === 'founder') {
            (entry.list || []).forEach(x => {
              const key = x.name;
              const money = Math.round((trans.amount || 0) * ((x.pct || 0) / 100));
              per.set(key, (per.get(key) || 0) + money);
            });
          } else if (trans.type === 'hunter') {
            const founderShare = (trans.amount || 0) * (FOUNDER_SHARE_PCT / 100);
            const hunterShare = (trans.amount || 0) - founderShare;
            (entry.list || []).forEach(x => {
              const key = x.name;
              const money = Math.round(founderShare * ((x.pct || 0) / 100));
              per.set(key, (per.get(key) || 0) + money);
            });
            (trans.list || []).forEach(x => {
              const key = x.name;
              const money = Math.round(hunterShare * ((x.pct || 0) / 100));
              per.set(key, (per.get(key) || 0) + money);
            });
          }
        });
      }
    });

    const perArr = Array.from(per, ([name, val]) => ({ name, val }))
      .sort((a, b) => b.val - a.val)
      .slice(0, 20);
    drawBars('chartPersons', perArr);
    analyticsData.persons = perArr;

    const teamMap = new Map();
    const byNameTeam = new Map(people.map(p => [p.name, p.team || 'Ohne Team']));
    per.forEach((val, name) => {
      const team = byNameTeam.get(name) || 'Ohne Team';
      teamMap.set(team, (teamMap.get(team) || 0) + val);
    });
    const teamArr = Array.from(teamMap, ([name, val]) => ({ name, val }))
      .sort((a, b) => b.val - a.val);
    drawBars('chartTeams', teamArr);
    analyticsData.teams = teamArr;
  }

  function drawBars(hostId, items) {
    const host = document.getElementById(hostId);
    host.innerHTML = '';
    const max = items.reduce((m, x) => Math.max(m, x.val), 0) || 1;
    const barH = 30;
    const gap = 8;
    const width = 1060;
    const height = items.length ? (items.length * (barH + gap) + 10) : 50;
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    let y = 10;
    const textWidth = 240;
    const barStartX = textWidth;
    items.forEach(item => {
      const len = Math.max(4, Math.round((item.val / max) * (width - barStartX - 100)));
      const g = document.createElementNS(svgNS, 'g');
      const title = document.createElementNS(svgNS, 'title');
      title.textContent = `${item.name}: ${fmtCurr0.format(item.val)}`;
      g.appendChild(title);
      const rect = document.createElementNS(svgNS, 'rect');
      rect.setAttribute('x', String(barStartX));
      rect.setAttribute('y', String(y));
      rect.setAttribute('rx', '6');
      rect.setAttribute('ry', '6');
      rect.setAttribute('width', String(len));
      rect.setAttribute('height', String(barH));
      rect.setAttribute('fill', '#3b82f6');
      const labelName = document.createElementNS(svgNS, 'text');
      labelName.setAttribute('x', '10');
      labelName.setAttribute('y', String(y + barH * 0.68));
      labelName.setAttribute('fill', '#cbd5e1');
      labelName.setAttribute('font-size', '14');
      labelName.textContent = item.name.length > 30 ? `${item.name.substring(0, 28)}…` : item.name;
      const labelVal = document.createElementNS(svgNS, 'text');
      labelVal.setAttribute('y', String(y + barH * 0.68));
      labelVal.setAttribute('font-weight', '700');
      labelVal.setAttribute('font-size', '14');
      labelVal.textContent = fmtCurr0.format(item.val);
      if (len < 120) {
        labelVal.setAttribute('x', String(barStartX + len + 8));
        labelVal.setAttribute('fill', '#cbd5e1');
      } else {
        labelVal.setAttribute('x', String(barStartX + 10));
        labelVal.setAttribute('fill', '#0a0f16');
      }
      g.appendChild(rect);
      g.appendChild(labelName);
      g.appendChild(labelVal);
      svg.appendChild(g);
      y += barH + gap;
    });
    host.appendChild(svg);
  }

  btnAnaXlsx.addEventListener('click', () => {
    const year = anaYear.value;
    const wb = XLSX.utils.book_new();
    const wsPersons = XLSX.utils.json_to_sheet(analyticsData.persons.map(p => ({ Name: p.name, Betrag_EUR: p.val })));
    XLSX.utils.book_append_sheet(wb, wsPersons, 'Top Personen');
    const wsTeams = XLSX.utils.json_to_sheet(analyticsData.teams.map(t => ({ Team: t.name, Betrag_EUR: t.val })));
    XLSX.utils.book_append_sheet(wb, wsTeams, 'Teams Aggregiert');
    XLSX.writeFile(wb, `auswertung_${year}_export.xlsx`);
  });

  async function saveNewEntry(state) {
    const finalAmount = state.input.amountKnown ? state.input.amount : 0;
    const resultData = compute(state.input.rows, state.input.weights, finalAmount);
    const isComplete = !!(state.input.client && state.input.title && finalAmount > 0 && state.input.rows.some(r => r.cs + r.konzept + r.pitch > 0));
    const now = Date.now();
    const baseEntry = {
      source: state.source || 'manuell',
      complete: isComplete,
      client: state.input.client || '',
      title: state.input.title || '',
      amount: finalAmount,
      projectType: state.input.projectType || 'fix',
      rows: state.input.rows || [],
      list: resultData.list || [],
      totals: resultData.totals || {},
      weights: resultData.effectiveWeights || [],
      submittedBy: state.input.submittedBy || '',
      projectNumber: state.input.projectNumber || ''
    };

    try {
      showLoader();
      if (state.editingId) {
        const idx = entries.findIndex(e => e.id === state.editingId);
        const existing = idx >= 0 ? entries[idx] : null;
        const updated = {
          ...(existing || {}),
          ...baseEntry,
          id: state.editingId,
          ts: existing?.ts || now,
          modified: now
        };
        if ((existing?.projectType || baseEntry.projectType) === 'rahmen') {
          updated.transactions = Array.isArray(existing?.transactions) ? existing.transactions : [];
        }
        if (idx >= 0) entries[idx] = updated; else entries.push(updated);
      } else {
        const newEntry = {
          ...baseEntry,
          id: createId('entry'),
          ts: now,
          modified: now
        };
        if (baseEntry.projectType === 'rahmen') newEntry.transactions = [];
        entries.push(newEntry);
      }
      await dataStore.setEntries(entries);
      showToast(`Eintrag ${state.editingId ? 'aktualisiert' : 'gespeichert'}.`, 'ok');
      clearInputFields();
      if (baseEntry.projectType === 'rahmen') {
        renderFrameworkContracts();
        showView('rahmen');
      } else {
        renderHistory();
        showView('fixauftraege');
      }
      if (!views.analytics.classList.contains('hide')) renderAnalytics();
    } catch (err) {
      console.error('Speichern fehlgeschlagen', err);
      showToast('Speichern fehlgeschlagen.', 'bad');
    } finally {
      hideLoader();
    }
  }

  function initFromState(isEditing = false) {
    const st = loadState();
    if (st?.input) {
      loadInputForm(st.input, isEditing || !!st.editingId);
    } else {
      loadInputForm({}, false);
    }
  }

  window.addEventListener('beforeunload', (ev) => {
    if (hasUnsavedChanges) {
      ev.preventDefault();
      ev.returnValue = '';
    }
  });

  loadPeople().then(() => {
    initFromState();
    showView('erfassung');
  });
  if (location.hash === '#admin') {
    handleAdminClick();
  }
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && ev.target?.tagName === 'INPUT' && !ev.target.closest('#viewAdmin')) {
      ev.preventDefault();
    }
  });
})();
