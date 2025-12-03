import { people } from './people.js';
import { findEntryById, upsertEntry } from '../entries-state.js';
import { showToast, showLoader, hideLoader } from '../ui/feedback.js';
import { getTodayDate } from '../utils/format.js';

// --- STATE ---
let currentEntryId = null;
let wizardTeam = [];
let wizardBuckets = { cs: [], konzept: [], pitch: [] };
let wizardPhases = {
  cs: { label: 'Consultative Selling', color: '#a855f7', bg: 'bg-purple-600', val: 50, active: true },
  konzept: { label: 'Konzeption', color: '#f59e0b', bg: 'bg-amber-500', val: 30, active: true },
  pitch: { label: 'Pitch', color: '#10b981', bg: 'bg-emerald-500', val: 20, active: true }
};

// Instanzen für SplitBars
let mainBarInstance = null;
let personBarInstances = {};

// --- SPLIT BAR KLASSE ---
class SplitBar {
  constructor(containerId, items, onUpdate) {
    this.container = typeof containerId === 'string' ? document.getElementById(containerId) : containerId;
    this.items = items;
    this.onUpdate = onUpdate;
    this.domElements = { segments: [], handles: [], pills: [] };
    this.renderStructure();
    this.updateVisuals();
  }

  renderStructure() {
    this.container.innerHTML = '';
    const wrapper = document.createElement('div'); wrapper.className = 'split-bar-wrapper';
    const bar = document.createElement('div'); bar.className = 'split-bar-container';

    if (this.items.length === 0) {
      bar.innerHTML = '<div class="w-full h-full flex items-center justify-center text-xs text-slate-500">Keine Daten</div>';
      wrapper.appendChild(bar); this.container.appendChild(wrapper); return;
    }

    this.items.forEach((item, idx) => {
      const seg = document.createElement('div');
      seg.className = 'split-segment';
      seg.style.backgroundColor = item.color;
      const pill = document.createElement('div');
      pill.className = 'segment-pill';
      seg.appendChild(pill);
      bar.appendChild(seg);
      
      this.domElements.segments.push(seg);
      this.domElements.pills.push(pill);

      if (idx < this.items.length - 1) {
        const handle = document.createElement('div');
        handle.className = 'split-handle';
        handle.addEventListener('mousedown', (e) => this.startDrag(e, idx));
        bar.appendChild(handle);
        this.domElements.handles.push(handle);
      }
    });
    wrapper.appendChild(bar);
    this.container.appendChild(wrapper);
  }

  updateVisuals() {
    if (this.items.length === 0) return;
    let total = this.items.reduce((acc, it) => acc + it.val, 0);
    
    if (Math.abs(total - 100) > 0.1 && total > 0) {
      this.items.forEach((it) => (it.val = (it.val / total) * 100));
    } else if (total === 0 && this.items.length > 0) {
      const eq = 100 / this.items.length;
      this.items.forEach((it) => (it.val = eq));
    }

    let cumPct = 0;
    this.items.forEach((item, idx) => {
      const seg = this.domElements.segments[idx];
      const pill = this.domElements.pills[idx];

      if (seg) {
        seg.style.width = item.val + '%';
        if (item.val < 15) pill.classList.add('popped-out');
        else pill.classList.remove('popped-out');
        
        // Clean up staggered class on update
        pill.classList.remove('stagger-up');
      }
      if (pill) pill.innerHTML = `<span>${item.label}</span><span>${Math.round(item.val)}%</span>`;

      if (idx < this.items.length - 1) {
        cumPct += item.val;
        const handle = this.domElements.handles[idx];
        if (handle) handle.style.left = cumPct + '%';
      }
    });
    
    // Second pass for Staggering logic to prevent overlap
    let prevPopped = false;
    this.items.forEach((item, idx) => {
        if(item.val < 15) {
            const pill = this.domElements.pills[idx];
            if(prevPopped) {
                pill.classList.add('stagger-up');
                prevPopped = false;
            } else {
                prevPopped = true;
            }
        } else {
            prevPopped = false;
        }
    });
  }

  startDrag(e, leftIdx) {
    e.preventDefault();
    const bar = this.container.querySelector('.split-bar-container');
    const rect = bar.getBoundingClientRect();
    const onMove = (evt) => {
      let x = evt.clientX - rect.left;
      let pct = (x / rect.width) * 100;
      pct = Math.max(0, Math.min(100, pct));
      
      let startBound = 0;
      for (let i = 0; i < leftIdx; i++) startBound += this.items[i].val;
      
      let endBound = startBound + this.items[leftIdx].val + this.items[leftIdx + 1].val;
      
      if (pct < startBound) pct = startBound;
      if (pct > endBound) pct = endBound;
      
      this.items[leftIdx].val = pct - startBound;
      this.items[leftIdx + 1].val = endBound - pct;
      
      this.updateVisuals();
      if (this.onUpdate) this.onUpdate(this.items);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  distributeEqual() {
    const count = this.items.length;
    if (count === 0) return;
    const base = Math.floor(100 / count);
    const remainder = 100 - base * count;
    this.items.forEach((item, i) => (item.val = base + (i < remainder ? 1 : 0)));
    this.updateVisuals();
    if (this.onUpdate) this.onUpdate(this.items);
  }

  setValues(values = []) {
    if (!Array.isArray(values)) return;
    values.slice(0, this.items.length).forEach((val, idx) => {
      const num = Number(val);
      if (Number.isFinite(num)) this.items[idx].val = num;
    });
    this.updateVisuals();
    if (this.onUpdate) this.onUpdate(this.items);
  }
}

// --- EXPORTS ---

export function initErfassung(deps) {
  // Check dependencies
  if (typeof Sortable === 'undefined') {
    console.warn('SortableJS nicht geladen.');
  }
}

// Platzhalter für Legacy-Aufrufe aus app.js/portfolio.js
export function initFromState() {
  // Der neue Wizard initialisiert sich selbst; kein Pre-Render nötig.
}

export function openWizard(entryOrId = null) {
  bindWizardEvents();
  const preloadedEntry = typeof entryOrId === 'object' && entryOrId !== null ? entryOrId : null;
  const entryId = preloadedEntry?.id || entryOrId || null;
  currentEntryId = entryId;
  
  // Reset State
  wizardTeam = [];
  wizardBuckets = { cs: [], konzept: [], pitch: [] };
  wizardPhases = {
      cs: { label: 'Consultative Selling', color: '#a855f7', bg: 'bg-purple-600', val: 50, active: true },
      konzept: { label: 'Konzeption', color: '#f59e0b', bg: 'bg-amber-500', val: 30, active: true },
      pitch: { label: 'Pitch', color: '#10b981', bg: 'bg-emerald-500', val: 20, active: true }
  };

  if (preloadedEntry || entryId) {
    loadEntryData(preloadedEntry || findEntryById(entryId));
  } else {
    // Neuer Deal Defaults
    ensureTeamPoolFilled();
    document.getElementById('inp-title').value = '';
    document.getElementById('inp-client').value = '';
    document.getElementById('inp-amount').value = '';
    document.getElementById('input-date').value = getTodayDate();
    document.getElementById('input-weight').value = "1.0";
    document.getElementById('input-kv').value = '';
    document.getElementById('input-proj').value = '';
    document.getElementById('status-owner').innerText = 'Maria Musterfrau';

    renderBucketsFromState();
    renderTeamList();
    initBucketSortables();
    syncPhasesWithBuckets();
    updateFooterStatus();
  }

  const dialog = document.getElementById('app-modal');
  if (dialog) dialog.showModal();
  
  window.goToStep(1);
}

function loadEntryData(entry) {
  if (!entry) return;

  document.getElementById('inp-title').value = entry.title || '';
  document.getElementById('inp-client').value = entry.client || '';
  document.getElementById('inp-amount').value = entry.amount || '';
  document.getElementById('input-kv').value = entry.kv_nummer || entry.kvNummer || entry.kv || '';
  document.getElementById('input-proj').value = entry.projectNumber || '';
  document.getElementById('input-date').value = entry.freigabedatum ? new Date(entry.freigabedatum).toISOString().split('T')[0] : getTodayDate();
  
  const weight = entry.dockRewardFactor || 1.0;
  const wSelect = document.getElementById('input-weight');
  wSelect.value = weight.toString();
  if(wSelect.value === '') wSelect.value = "1.0";

  const owner = entry.submittedBy || entry.owner || 'Unbekannt';
  document.getElementById('status-owner').innerText = owner;

  // Weights
  if (entry.weights && Array.isArray(entry.weights)) {
    entry.weights.forEach(w => {
       if(wizardPhases[w.key]) wizardPhases[w.key].val = w.weight;
    });
  }

  const rawRows = Array.isArray(entry?.rows) && entry.rows.length
    ? entry.rows
    : Array.isArray(entry?.list) && entry.list.length
      ? entry.list.map(item => ({
          name: item.name || item.person || '',
          cs: Number(item.cs) || 0,
          konzept: Number(item.konzept ?? item.cz) || 0,
          pitch: Number(item.pitch) || 0,
        }))
      : [];

  const fallbackPeople = Array.isArray(entry?.people)
    ? entry.people
    : Array.isArray(entry?.persons)
      ? entry.persons
      : Array.isArray(entry?.team)
        ? entry.team
        : [];

  const normalizedFallbackRows = rawRows.length
    ? rawRows
    : fallbackPeople.map((p) => ({
        name: typeof p === 'string' ? p : p?.name || '',
        cs: 0,
        konzept: 0,
        pitch: 0,
      }));

  if (normalizedFallbackRows.length) {
    const existingNames = new Set();
    normalizedFallbackRows.forEach(row => {
        if(!row.name) return;
        if(!existingNames.has(row.name)) {
            const dbPerson = people.find(p => p.name === row.name);
            const color = dbPerson?.color || '#64748b';
            wizardTeam.push({
                id: "p_" + row.name.replace(/\s/g, ''),
                name: row.name,
                role: dbPerson?.team || 'Extern',
                color: color
            });
            existingNames.add(row.name);
        }
        const pId = "p_" + row.name.replace(/\s/g, '');
        const pObj = wizardTeam.find(p => p.id === pId);
        if(row.cs > 0) wizardBuckets.cs.push({ ...pObj, share: row.cs });
        if(row.konzept > 0) wizardBuckets.konzept.push({ ...pObj, share: row.konzept });
        if(row.pitch > 0) wizardBuckets.pitch.push({ ...pObj, share: row.pitch });
    });
  }
  ensureTeamPoolFilled();
  renderBucketsFromState();
  renderTeamList();
  initBucketSortables();
  syncPhasesWithBuckets();
  updateFooterStatus();
}

// --- GLOBAL BINDINGS ---
// Diese Funktionen müssen global sein, da sie im HTML onclick aufgerufen werden

window.goToStep = function(step) {
    document.getElementById('view-step-1').classList.add('hidden');
    document.getElementById('view-step-2').classList.add('hidden');
    document.getElementById(`view-step-${step}`).classList.remove('hidden');
    
    const btn1 = document.getElementById('nav-btn-1');
    const btn2 = document.getElementById('nav-btn-2');
    
    if (step === 1) {
        btn1.className = "px-5 py-1.5 rounded-md text-xs font-bold bg-blue-600 text-white shadow-md transition-all";
        btn2.className = "px-5 py-1.5 rounded-md text-xs font-bold text-slate-500 hover:text-white transition-all cursor-pointer";
        btn2.onclick = () => window.goToStep(2);
    } else {
        btn1.className = "px-5 py-1.5 rounded-md text-xs font-bold text-slate-500 hover:text-white transition-all cursor-pointer";
        btn1.onclick = () => window.goToStep(1);
        btn2.className = "px-5 py-1.5 rounded-md text-xs font-bold bg-blue-600 text-white shadow-md transition-all";
        btn2.onclick = null;
        initPhase3(); // Init/Refresh Charts
    }
};

window.toggleDealLock = function() {
    const card = document.getElementById('deal-info-card');
    const inputs = card.querySelectorAll('input');
    const icon = document.getElementById('lock-icon');
    card.classList.toggle('is-unlocked');
    const isUnlocked = card.classList.contains('is-unlocked');
    inputs.forEach(inp => {
        if (isUnlocked) {
            inp.classList.remove('locked-input'); inp.classList.add('unlocked-input'); inp.readOnly = false;
        } else {
            inp.classList.remove('unlocked-input'); inp.classList.add('locked-input'); inp.readOnly = true;
        }
    });
    icon.className = isUnlocked ? "fa-solid fa-lock-open" : "fa-solid fa-lock";
};

window.togglePopup = function(id) {
    const el = document.getElementById(id);
    ['admin-panel', 'owner-panel'].forEach(pid => { if(pid!==id) document.getElementById(pid).classList.remove('open'); });
    el.classList.toggle('open');
};

window.updateFooterStatus = function() {
    const sel = document.getElementById('input-weight');
    if(!sel) return;
    const txt = sel.options[sel.selectedIndex].text.split(' - ')[0] + "x";
    const kv = document.getElementById('input-kv').value || '-';
    const proj = document.getElementById('input-proj').value || '-';
    const dateVal = document.getElementById('input-date').value;
    let dateStr = "-";
    if (dateVal) {
        const d = new Date(dateVal);
        dateStr = d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
    }
    document.getElementById('status-stammdaten').innerText = `${txt} • ${proj} • ${kv} • ${dateStr}`;
};

window.handleSearch = function(val) {
    const dropdown = document.getElementById('search-dropdown');
    if (!val) { dropdown.style.display = 'none'; dropdown.classList.remove('open'); return; }

    const hits = people.filter(p => p.name.toLowerCase().includes(val.toLowerCase()));
    dropdown.innerHTML = '';
    dropdown.style.display = 'block';
    dropdown.classList.add('open');

    if (hits.length === 0) {
        dropdown.innerHTML = '<div class="p-2 text-xs text-slate-500">Keine Treffer</div>';
    } else {
        hits.forEach(p => {
            const exists = wizardTeam.some(t => t.name === p.name);
            const div = document.createElement('div');
            div.className = "p-2 hover:bg-slate-700 cursor-pointer text-sm text-white flex gap-2 items-center justify-between " + (exists ? "opacity-50 cursor-not-allowed" : "");
            const color = p.color || '#3b82f6'; 
            div.innerHTML = `<div class="flex items-center gap-2"><div class="w-3 h-3 rounded-full" style="background:${color}"></div> ${p.name}</div>` + (exists ? '<i class="fa-solid fa-check text-xs"></i>' : '');
            if (!exists) {
                div.onclick = () => selectPerson(p);
            }
            dropdown.appendChild(div);
        });
    }
};

window.handleSearchKey = function(e) {
    if (e.key === 'Enter') {
        e.preventDefault();
        const val = e.target.value;
        const hits = people.filter(p => p.name.toLowerCase().includes(val.toLowerCase()));
        const first = hits.find((h) => !wizardTeam.some((t) => t.name === h.name));
        if (first) {
            selectPerson(first);
        }
    }
};

function selectPerson(p) {
    wizardTeam.push({
        id: "p_" + Date.now(),
        name: p.name,
        role: p.team || 'Team',
        color: p.color || '#3b82f6'
    });
    renderTeamList();
    document.getElementById('person-search').value = '';
    const dropdown = document.getElementById('search-dropdown');
    dropdown.style.display = 'none';
    dropdown.classList.remove('open');
}

window.removePerson = function(id) {
    wizardTeam = wizardTeam.filter(p => p.id !== id);
    document.querySelectorAll(`.person-chip[data-id="${id}"]`).forEach(el => {
        const bucketId = el.parentElement.getAttribute('data-phase');
        el.remove();
        if(bucketId) { checkEmpty(bucketId); updateBucketsState(); }
    });
    renderTeamList();
};

function renderTeamList() {
    const pool = document.getElementById('source-pool');
    if(pool) {
        pool.innerHTML = wizardTeam.map(p => 
            `<div class="person-chip p-2 rounded bg-slate-700 border border-slate-600 mb-2 text-sm text-white flex justify-between items-center shadow-sm hover:bg-slate-600 relative group" 
                 data-id="${p.id}" data-name="${p.name}" data-color="${p.color}">
                <div class="flex items-center gap-2">
                    <div class="w-3 h-3 rounded-full" style="background:${p.color}"></div>
                    <span>${p.name}</span>
                </div>
                <button onclick="window.removePerson('${p.id}')" class="text-slate-500 hover:text-red-400 px-1 opacity-0 group-hover:opacity-100 transition"><i class="fa-solid fa-minus-circle"></i></button>
            </div>`
        ).join('');
    }
}

function initBucketSortables() {
    const pool = document.getElementById('source-pool');
    if (pool && !pool._sortable) {
        pool._sortable = Sortable.create(pool, { group: { name: 'shared', pull: 'clone', put: false }, sort: false, animation: 150, ghostClass: 'sortable-ghost' });
    }
    
    ['cs', 'konzept', 'pitch'].forEach(key => {
        const el = document.getElementById(`bucket-${key}`);
        if (el && !el._sortable) {
            el._sortable = Sortable.create(el, {
                group: 'shared', animation: 150, ghostClass: 'sortable-ghost',
                onAdd: (evt) => {
                    const item = evt.item;
                    const others = Array.from(el.querySelectorAll('.person-chip')).filter(i => i !== item);
                    if (others.some(s => s.getAttribute('data-id') === item.getAttribute('data-id'))) { item.remove(); return; }
                    
                    item.className = "person-chip bg-slate-800 p-2 rounded border border-slate-600 text-xs text-white flex justify-between items-center mb-1 shadow-sm";
                    item.innerHTML = `<span class="truncate pr-2">${item.getAttribute('data-name')}</span><button onclick="window.removeBucketItem(this, '${key}')" class="text-slate-500 hover:text-red-400"><i class="fa-solid fa-times"></i></button>`;
                    checkEmpty(key); updateBucketsState();
                },
                onRemove: () => { checkEmpty(key); updateBucketsState(); }
            });
        }
    });
}

window.removeBucketItem = function(btn, key) {
    btn.parentElement.remove();
    checkEmpty(key);
    updateBucketsState();
};

function checkEmpty(key) {
    const el = document.getElementById(`bucket-${key}`);
    const msg = el.querySelector('.empty-msg');
    if(msg) msg.style.display = el.querySelectorAll('.person-chip').length > 0 ? 'none' : 'block';
}

function updateBucketsState() {
    ['cs', 'konzept', 'pitch'].forEach(key => {
        wizardBuckets[key] = Array.from(document.querySelectorAll(`#bucket-${key} .person-chip`)).map(c => ({
            id: c.getAttribute('data-id'),
            name: c.getAttribute('data-name'),
            color: c.getAttribute('data-color'),
            share: Number(c.getAttribute('data-share')) || undefined
        }));
    });
    syncPhasesWithBuckets();
}

window.handleOwnerSearch = function(val) {
    const list = document.getElementById('owner-dropdown');
    list.innerHTML = '';
    if(!val) return;
    const hits = people.filter(p => p.name.toLowerCase().includes(val.toLowerCase()));
    hits.forEach(p => {
        const div = document.createElement('div');
        div.className = "text-xs text-white p-2 hover:bg-slate-700 cursor-pointer rounded flex items-center gap-2";
        div.innerHTML = `<div class="w-2 h-2 rounded-full" style="background:${p.color || '#333'}"></div> ${p.name}`;
        div.onclick = () => {
            document.getElementById('status-owner').innerText = p.name;
            window.togglePopup('owner-panel');
        };
        list.appendChild(div);
    });
};

// --- PHASE 3 ---

function initPhase3() {
    initMainPhaseBar();
    initPersonBarsStructure();
    updatePersonBarsValues();
}

function initMainPhaseBar() {
    const container = document.getElementById('main-split-bar-container');
    const items = ['cs', 'konzept', 'pitch'].filter(k => wizardPhases[k].active).map(k => ({ id: k, label: wizardPhases[k].label, val: wizardPhases[k].val, color: wizardPhases[k].color }));
    mainBarInstance = new SplitBar(container, items, (updatedItems) => {
        updatedItems.forEach(u => { wizardPhases[u.id].val = u.val; });
        updatePersonBarsValues();
    });
}

window.setMainPhaseEqual = function() { if(mainBarInstance) mainBarInstance.distributeEqual(); };
window.setMainPhaseDefault = function() { 
    if(wizardPhases.cs.active && wizardPhases.konzept.active && wizardPhases.pitch.active) mainBarInstance.setValues([50, 30, 20]);
    else mainBarInstance.distributeEqual();
};

window.togglePhase = function(key) {
    const isChecked = document.getElementById(`chk-${key}`).checked;
    wizardPhases[key].active = isChecked;
    if (isChecked && wizardPhases[key].val === 0) wizardPhases[key].val = 10; 
    else if (!isChecked) wizardPhases[key].val = 0;
    initPhase3();
};

function initPersonBarsStructure() {
    const container = document.getElementById('person-split-list');
    container.innerHTML = '';
    personBarInstances = {};

    ['cs', 'konzept', 'pitch'].forEach((key, idx) => {
        const phase = wizardPhases[key];
        const people = wizardBuckets[key];
        
        const card = document.createElement('div');
        card.id = `card-${key}`;
        card.className = `bg-slate-800 rounded-lg border border-slate-700 p-4 shadow-sm transition-all duration-300`;
        
        card.innerHTML = `
            <div class="flex justify-between items-center mb-2">
                <div class="flex items-center gap-3">
                    <span class="text-xs font-bold text-slate-600 bg-slate-900 rounded px-1.5 py-0.5 border border-slate-700">SCHRITT B${idx+1}</span>
                    <h4 class="font-bold text-sm uppercase tracking-wider" style="color:${phase.color}">${phase.label}</h4>
                    <div class="flex gap-1 ml-2">
                        <button class="action-btn" title="Gleichverteilung" onclick="setPersonEqual('${key}')"><i class="fa-solid fa-scale-balanced"></i></button>
                    </div>
                </div>
                <span class="text-xs text-slate-500 font-mono bg-slate-900/50 px-2 py-0.5 rounded">Deal-Anteil: <span class="text-white font-bold" id="val-display-${key}">0%</span></span>
            </div>
        `;

        if (people.length === 0) {
            card.innerHTML += `<div class="text-xs text-slate-500 text-center py-3 bg-slate-900/30 rounded border border-slate-700/50 border-dashed">Keine Personen</div>`;
        } else {
            const barDiv = document.createElement('div');
            card.appendChild(barDiv);
            
            // Smart Init (34/33/33)
            const count = people.length;
            const base = Math.floor(100 / count);
            const remainder = 100 - (base * count);
            
            const items = people.map((p, i) => ({ 
                id: p.id, label: p.name, 
                val: p.share || (base + (i < remainder ? 1 : 0)), 
                color: p.color 
            }));
            
            setTimeout(() => {
                const sb = new SplitBar(barDiv, items, (updated) => {
                    updated.forEach((u, i) => wizardBuckets[key][i].share = u.val);
                });
                personBarInstances[key] = sb;
            }, 0);
        }
        container.appendChild(card);
    });
}

window.setPersonEqual = function(key) { if(personBarInstances[key]) personBarInstances[key].distributeEqual(); };

function updatePersonBarsValues() {
    ['cs', 'konzept', 'pitch'].forEach(key => {
        const phase = wizardPhases[key];
        const card = document.getElementById(`card-${key}`);
        const valDisplay = document.getElementById(`val-display-${key}`);
        if(valDisplay) valDisplay.innerText = Math.round(phase.val) + '%';
        if(card) {
            const isDisabled = !phase.active || Math.round(phase.val) === 0;
            if(isDisabled) card.classList.add('phase-disabled', 'phase-card-disabled');
            else card.classList.remove('phase-disabled', 'phase-card-disabled');
        }
    });
}

window.saveWizardData = async function() {
    showLoader();
    try {
        const title = document.getElementById('inp-title').value;
        const client = document.getElementById('inp-client').value;
        const amount = document.getElementById('inp-amount').value;
        const kv = document.getElementById('input-kv').value.trim();
        const proj = document.getElementById('input-proj').value.trim();
        const date = document.getElementById('input-date').value;
        const weightFactor = parseFloat(document.getElementById('input-weight').value);
        const owner = document.getElementById('status-owner').innerText;

        const entryRows = wizardTeam.map(p => {
            const pCS = wizardBuckets.cs.find(x => x.name === p.name);
            const pKonz = wizardBuckets.konzept.find(x => x.name === p.name);
            const pPitch = wizardBuckets.pitch.find(x => x.name === p.name);
            
            // Absolute shares calculated back to % of phase
            // Actually rows expect pure percentages of total deal if I recall correctly?
            // Or does it expect the raw input values per category?
            // Based on app.js "compute", it takes category weights and row points.
            // Here we have visual shares (e.g. 50% of CS).
            // The backend likely expects: name, cs: 50, konzept: 0...
            // And global weights: cs: 50, konzept: 30...
            
            return {
                name: p.name,
                cs: pCS ? pCS.share : 0,
                konzept: pKonz ? pKonz.share : 0,
                pitch: pPitch ? pPitch.share : 0
            };
        });

        const weights = [
            { key: 'cs', weight: wizardPhases.cs.val },
            { key: 'konzept', weight: wizardPhases.konzept.val },
            { key: 'pitch', weight: wizardPhases.pitch.val }
        ];

        const entryData = {
            id: currentEntryId || `entry_${Date.now()}_${Math.random().toString(36).substr(2,9)}`,
            title: title,
            client: client,
            amount: parseFloat(amount),
            kv_nummer: kv,
            kvNummer: kv,
            kv: kv,
            projectNumber: proj,
            freigabedatum: date ? new Date(date).getTime() : Date.now(),
            dockRewardFactor: weightFactor,
            submittedBy: owner,
            rows: entryRows,
            weights: weights,
            source: 'wizard',
            ts: Date.now()
        };
        
        await upsertEntry(entryData);
        showToast('Deal erfolgreich gespeichert.', 'ok');
        document.getElementById('app-modal').close();
        
        if(window.loadHistory) await window.loadHistory(); 

    } catch (err) {
        console.error(err);
        showToast('Fehler beim Speichern: ' + err.message, 'bad');
    } finally {
        hideLoader();
    }
};

// --- EVENT LISTENERS ---
let wizardEventsBound = false;
function bindWizardEvents() {
    if (wizardEventsBound) return;
    wizardEventsBound = true;

    const btnFinish = document.getElementById('btn-finish');
    if(btnFinish) btnFinish.onclick = window.saveWizardData;

    const btnClose = document.getElementById('btn-close-modal');
    if(btnClose) btnClose.onclick = () => document.getElementById('app-modal').close();

    const btnCloseAdmin = document.getElementById('btn-close-admin');
    if(btnCloseAdmin) btnCloseAdmin.onclick = () => window.togglePopup('admin-panel');

    const btnSaveAdmin = document.getElementById('btn-save-admin');
    if(btnSaveAdmin) btnSaveAdmin.onclick = () => { window.togglePopup('admin-panel'); showToast('Stammdaten übernommen (lokal)', 'ok'); };

    const btnNext = document.getElementById('btn-next-step');
    if(btnNext) btnNext.onclick = () => window.goToStep(2);

    const btnBack = document.getElementById('btn-back-step');
    if(btnBack) btnBack.onclick = () => window.goToStep(1);

    const btnToggleLock = document.getElementById('btn-toggle-lock');
    if(btnToggleLock) btnToggleLock.onclick = window.toggleDealLock;

    const btnStammdaten = document.getElementById('btn-stammdaten');
    if(btnStammdaten) btnStammdaten.onclick = () => window.togglePopup('admin-panel');

    const btnOwner = document.getElementById('btn-owner');
    if(btnOwner) btnOwner.onclick = () => window.togglePopup('owner-panel');

    const searchInput = document.getElementById('person-search');
    if(searchInput) {
        searchInput.addEventListener('input', (e) => window.handleSearch(e.target.value));
        searchInput.addEventListener('keydown', window.handleSearchKey);
    }

    const ownerSearchInput = document.getElementById('owner-search-input');
    if(ownerSearchInput) ownerSearchInput.addEventListener('input', (e) => window.handleOwnerSearch(e.target.value));

    const equalPhasesBtn = document.getElementById('btn-equal-phases');
    if(equalPhasesBtn) equalPhasesBtn.onclick = window.setMainPhaseEqual;

    const resetPhasesBtn = document.getElementById('btn-reset-phases');
    if(resetPhasesBtn) resetPhasesBtn.onclick = window.setMainPhaseDefault;

    ['cs', 'konzept', 'pitch'].forEach(key => {
        const chk = document.getElementById(`chk-${key}`);
        if(chk) chk.onchange = () => window.togglePhase(key);
    });

    ['input-weight', 'input-kv', 'input-proj', 'input-date'].forEach(id => {
        const el = document.getElementById(id);
        if(el) el.addEventListener('change', window.updateFooterStatus);
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindWizardEvents);
} else {
    bindWizardEvents();
}

function ensureTeamPoolFilled() {
    if (wizardTeam.length) return;
    wizardTeam = people.map((p, idx) => ({
        id: p.id || `p_${idx}_${(p.name || 'person').replace(/\s/g, '')}`,
        name: p.name,
        role: p.team || 'Team',
        color: p.color || '#3b82f6'
    }));
}

function renderBucketsFromState() {
    ['cs', 'konzept', 'pitch'].forEach((key) => {
        const el = document.getElementById(`bucket-${key}`);
        if (!el) return;
        let msg = el.querySelector('.empty-msg');
        el.innerHTML = '';
        if (!msg) {
            msg = document.createElement('div');
            msg.className = 'empty-msg text-center text-slate-600 text-sm mt-10 pointer-events-none italic';
            msg.textContent = 'Hier ablegen';
        }
        el.appendChild(msg);
        (wizardBuckets[key] || []).forEach((p) => {
            const chip = document.createElement('div');
            chip.className = 'person-chip bg-slate-800 p-2 rounded border border-slate-600 text-xs text-white flex justify-between items-center mb-1 shadow-sm';
            chip.setAttribute('data-id', p.id);
            chip.setAttribute('data-name', p.name);
            chip.setAttribute('data-color', p.color);
            if (typeof p.share === 'number') chip.setAttribute('data-share', p.share);
            chip.innerHTML = `<span class="truncate pr-2">${p.name}</span><button onclick="window.removeBucketItem(this, '${key}')" class="text-slate-500 hover:text-red-400"><i class="fa-solid fa-times"></i></button>`;
            el.appendChild(chip);
        });
        checkEmpty(key);
    });
    syncPhasesWithBuckets();
}

function syncPhasesWithBuckets() {
    let phaseChanged = false;
    ['cs', 'konzept', 'pitch'].forEach((key) => {
        const hasPeople = wizardBuckets[key]?.length > 0;
        const chk = document.getElementById(`chk-${key}`);
        if (chk) chk.checked = hasPeople;
        if (wizardPhases[key].active !== hasPeople) {
            wizardPhases[key].active = hasPeople;
            phaseChanged = true;
        }
    });

    if (phaseChanged && !document.getElementById('view-step-2').classList.contains('hidden')) {
        initPhase3();
    } else if (phaseChanged && mainBarInstance) {
        updatePersonBarsValues();
    }
}
