import { WORKER_BASE } from '../config.js';
import { fetchWithRetry, throttle } from '../api.js';
import { showLoader, hideLoader, showToast, showBatchProgress, updateBatchProgress, hideBatchProgress } from '../ui/feedback.js';
import { loadHistory } from './history.js';
import { getEntries } from '../entries-state.js';

// --- Hilfsfunktionen ---

function normKey(str) {
  return String(str || '').toLowerCase().trim();
}

function parseAmountInput(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    let t = v.trim().replace(/\s/g, '');
    if (t.includes(',') && (!t.includes('.') || /\.\d{3},\d{1,2}$/.test(t))) {
      t = t.replace(/\./g, '').replace(',', '.');
    } else {
      t = t.replace(/,/g, '');
    }
    const n = Number(t);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function parseExcelDate(excelDate) {
  if (typeof excelDate === 'number' && excelDate > 25569) {
    try {
      const jsTimestamp = (excelDate - 25569) * 86400 * 1000;
      const d = new Date(jsTimestamp);
      if (d.getFullYear() > 2000) {
        return new Date(d.getTime() + (d.getTimezoneOffset() * 60000));
      }
    } catch (e) { console.warn("Date parse error (num)", e); }
  }
  if (typeof excelDate === 'string') {
    const dateString = excelDate.trim();
    const deMatch = dateString.match(/^(\d{1,2})\s*\.\s*(\d{1,2})\s*\.\s*(\d{4})$/);
    if (deMatch) return new Date(deMatch[3], deMatch[2] - 1, deMatch[1]);
    const isoMatch = dateString.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (isoMatch) return new Date(isoMatch[1], isoMatch[2] - 1, isoMatch[3]);
  }
  return new Date();
}

function getVal(row, possibleKeys) {
  if (!row || typeof row !== 'object') return undefined;
  if (!Array.isArray(possibleKeys)) possibleKeys = [possibleKeys];
  const keys = Object.keys(row);
  for (const searchKey of possibleKeys) {
    const nKey = searchKey.toLowerCase().replace(/[^a-z0-9]/g, '');
    const found = keys.find(k => k.toLowerCase().replace(/[^a-z0-9]/g, '') === nKey);
    if (found) return row[found];
  }
  return undefined;
}

function extractClientFromProjectNumber(pNr) {
  if (!pNr || typeof pNr !== 'string') return '';
  const parts = pNr.split('-');
  if (parts.length > 1) return parts[0].trim();
  return '';
}

const fmtEUR = (n) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(n);

// --- Hauptlogik Analyse ---

let _importBuckets = null;

async function analyzeErpFile(file) {
  await loadHistory();
  const entries = getEntries();
  
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer);
  const sheetName = workbook.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);

  const kvIndex = new Map();
  const frameworkIndex = new Map();

  entries.forEach(e => {
    // KV Index
    if (e.kv_nummer && e.projectType !== 'rahmen') {
      kvIndex.set(normKey(e.kv_nummer), { type: 'fix', entry: e });
    }
    if (e.projectType === 'rahmen' && Array.isArray(e.transactions)) {
      e.transactions.forEach(t => {
        if (t.kv_nummer) kvIndex.set(normKey(t.kv_nummer), { type: 'trans', entry: e, transaction: t });
      });
      // Framework Index (Nur echte Rahmenverträge!)
      if (e.projectNumber) {
        frameworkIndex.set(normKey(e.projectNumber), e);
      }
    }
  });

  const buckets = {
    updates: [],
    calloffs: [],
    newFix: [],
    skipped: [],
    frameworksToUpdate: new Map()
  };

  for (const row of rows) {
    const kvRaw = getVal(row, ['Kostenvoranschlagsnummer', 'KV-Nummer', 'KV']);
    const pNrRaw = getVal(row, ['Projekt Projektnummer', 'Projektnummer']);
    const amount = parseAmountInput(getVal(row, ['Agenturleistung netto', 'Betrag', 'Wert', 'Summe']));
    const title = getVal(row, ['Titel', 'Bezeichnung', 'Thema']) || '';
    let client = getVal(row, ['Projekt Etat Kunde Name', 'Kunde', 'Auftraggeber']);
    if (!client && pNrRaw) client = extractClientFromProjectNumber(pNrRaw);
    client = client || '';
    const dateVal = getVal(row, ['Freigabedatum', 'Abschlussdatum', 'Datum']);
    
    if (!kvRaw) continue;

    const kvNorm = normKey(kvRaw);
    const pNrNorm = normKey(pNrRaw);
    const dateObj = parseExcelDate(dateVal);
    const ts = dateObj.getTime();

    const existingKV = kvIndex.get(kvNorm);

    // --- FALL 1: KV Existiert -> Update ---
    if (existingKV) {
      let currentAmount = 0;
      let isTrans = (existingKV.type === 'trans');
      if (isTrans) currentAmount = Number(existingKV.transaction.amount || 0);
      else currentAmount = Number(existingKV.entry.amount || 0);

      if (Math.abs(currentAmount - amount) > 0.01) {
        buckets.updates.push({
          kv: kvRaw,
          title: isTrans ? (existingKV.transaction.title || title) : (existingKV.entry.title || title),
          client: existingKV.entry.client || client,
          oldAmount: currentAmount,
          newAmount: amount,
          type: isTrans ? 'Abruf Korrektur' : 'Fixauftrag Korrektur',
          targetId: existingKV.entry.id,
          transId: isTrans ? existingKV.transaction.id : null,
          originalEntry: existingKV.entry
        });
      } else {
        buckets.skipped.push({ kv: kvRaw, reason: 'Identisch', amount });
      }
      continue;
    }

    // --- FALL 2: KV Neu -> Rahmenvertrag prüfen ---
    const framework = frameworkIndex.get(pNrNorm);

    if (framework) {
      // Prüfen ob wir diesen Rahmenvertrag schon im Batch haben
      let fwEntry = buckets.frameworksToUpdate.get(framework.id);
      if (!fwEntry) {
        // Klonen für Modifikation
        fwEntry = JSON.parse(JSON.stringify(framework));
        if (!Array.isArray(fwEntry.transactions)) fwEntry.transactions = [];
        buckets.frameworksToUpdate.set(framework.id, fwEntry);
      }

      // Neuen Abruf hinzufügen
      const newTrans = {
        id: `trans_${Date.now()}_${Math.random().toString(36).substr(2,9)}`,
        kv_nummer: kvRaw,
        type: 'founder', // oder hunter, je nach Logik
        parentId: fwEntry.id,
        amount: amount,
        ts: Date.now(),
        freigabedatum: ts,
        title: title,
        client: client || fwEntry.client
      };
      
      fwEntry.transactions.push(newTrans);
      fwEntry.modified = Date.now();

      buckets.calloffs.push({
        kv: kvRaw,
        projectNumber: pNrRaw,
        title,
        amount,
        parentTitle: framework.title
      });
      continue;
    }

    // --- FALL 3: Ganz neu -> Fixauftrag ---
    const newEntry = {
      id: `entry_${Date.now()}_${kvNorm.replace(/[^a-z0-9]/g,'')}`,
      source: 'erp-import',
      projectType: 'fix',
      client,
      title,
      projectNumber: pNrRaw,
      kv_nummer: kvRaw,
      amount,
      list: [], rows: [], weights: [],
      ts: Date.now(),
      freigabedatum: ts,
      dockFinalAssignment: 'fix',
      dockFinalAssignmentAt: Date.now(),
      dockPhase: 4,
      complete: true,
      modified: Date.now()
    };
    buckets.newFix.push(newEntry);
  }

  return buckets;
}

// --- UI Rendering ---

function renderPreviewModal(buckets) {
  const old = document.getElementById('erp-importer-modal');
  if (old) old.remove();

  const backdrop = document.createElement('div');
  backdrop.id = 'erp-importer-modal';
  backdrop.style.cssText = `
    position: fixed; top:0; left:0; width:100%; height:100%;
    background: rgba(0,0,0,0.85); z-index: 9999;
    display: flex; justify-content: center; align-items: center;
    font-family: 'Inter', sans-serif; color: #e2e8f0;
  `;

  const content = document.createElement('div');
  content.style.cssText = `
    background: #0f172a; border: 1px solid #1e293b; border-radius: 12px;
    width: 90%; max-width: 1200px; max-height: 90vh; display: flex; flex-direction: column;
    box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
  `;

  // Header
  const header = document.createElement('div');
  header.innerHTML = `
    <div style="padding: 20px; border-bottom: 1px solid #1e293b; display: flex; justify-content: space-between; align-items: center;">
      <h2 style="margin:0; font-size: 1.25rem; font-weight: 600;">ERP Import Analyse (Safe Batch)</h2>
      <button id="close-erp-modal" style="background:transparent; border:none; color: #94a3b8; font-size: 1.5rem; cursor: pointer;">&times;</button>
    </div>
  `;
  content.appendChild(header);

  // Body
  const body = document.createElement('div');
  body.style.cssText = `padding: 20px; overflow-y: auto; flex: 1;`;

  // --- Sektion 1: UPDATES ---
  if (buckets.updates.length > 0) {
    body.innerHTML += `
      <div style="margin-bottom: 30px; background: #1e293b50; padding: 15px; border-radius: 8px; border: 1px solid #334155;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 10px;">
          <h3 style="margin:0; color: #f59e0b;">⚠️ Abweichungen in bestehenden Aufträgen (${buckets.updates.length})</h3>
          <button id="btn-exec-updates" class="action-btn" style="background: #f59e0b; color: #000;">Aktualisieren</button>
        </div>
         <div style="max-height: 200px; overflow: auto;">
          <table style="width:100%; border-collapse: collapse; font-size: 0.9rem;">
            <thead style="text-align:left; color:#94a3b8;"><tr><th>KV</th><th>Titel</th><th>Alt</th><th>Neu</th><th>Diff</th></tr></thead>
            <tbody>
              ${buckets.updates.map(u => `
                <tr style="border-bottom: 1px solid #334155;">
                  <td style="padding: 6px;">${u.kv}</td>
                  <td style="padding: 6px;">${u.title}</td>
                  <td style="padding: 6px;">${fmtEUR(u.oldAmount)}</td>
                  <td style="padding: 6px;">${fmtEUR(u.newAmount)}</td>
                  <td style="padding: 6px; color:${u.newAmount!=u.oldAmount?'#f59e0b':'inherit'}">${fmtEUR(u.newAmount-u.oldAmount)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  // --- Sektion 2: CALL-OFFS ---
  if (buckets.calloffs.length > 0) {
    body.innerHTML += `
      <div style="margin-bottom: 30px; background: #1e293b50; padding: 15px; border-radius: 8px; border: 1px solid #334155;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 10px;">
          <h3 style="margin:0; color: #38bdf8;">🏗 Neue Abrufe zu Rahmenverträgen (${buckets.calloffs.length})</h3>
          <button id="btn-exec-calloffs" class="action-btn" style="background: #38bdf8; color: #000;">Zuordnen</button>
        </div>
        <div style="max-height: 200px; overflow: auto;">
          <table style="width:100%; border-collapse: collapse; font-size: 0.9rem;">
            <thead style="text-align:left; color:#94a3b8;"><tr><th>KV (Neu)</th><th>Projekt Nr.</th><th>Titel</th><th>Rahmenvertrag</th></tr></thead>
            <tbody>
              ${buckets.calloffs.map(c => `
                <tr style="border-bottom: 1px solid #334155;">
                  <td style="padding: 6px;">${c.kv}</td>
                  <td style="padding: 6px;">${c.projectNumber}</td>
                  <td style="padding: 6px;">${c.title}</td>
                  <td style="padding: 6px; font-style: italic;">${c.parentTitle}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  // --- Sektion 3: NEUE FIXAUFTRÄGE ---
  if (buckets.newFix.length > 0) {
    body.innerHTML += `
      <div style="margin-bottom: 30px; background: #1e293b50; padding: 15px; border-radius: 8px; border: 1px solid #334155;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 10px;">
          <h3 style="margin:0; color: #4ade80;">✨ Neue Fixaufträge (${buckets.newFix.length})</h3>
          <button id="btn-exec-fix" class="action-btn" style="background: #4ade80; color: #000;">Anlegen</button>
        </div>
        <div style="max-height: 200px; overflow: auto;">
           <table style="width:100%; border-collapse: collapse; font-size: 0.9rem;">
            <thead style="text-align:left; color:#94a3b8;"><tr><th>KV</th><th>Projekt Nr.</th><th>Titel</th><th>Kunde</th><th>Betrag</th></tr></thead>
            <tbody>
              ${buckets.newFix.map(f => `
                <tr style="border-bottom: 1px solid #334155;">
                  <td style="padding: 6px;">${f.kv_nummer}</td>
                  <td style="padding: 6px;">${f.projectNumber}</td>
                  <td style="padding: 6px;">${f.title}</td>
                  <td style="padding: 6px;">${f.client}</td>
                  <td style="padding: 6px;">${fmtEUR(f.amount)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  if (buckets.skipped.length > 0) {
     body.innerHTML += `<div style="opacity:0.6; margin-top:10px;">👻 ${buckets.skipped.length} ohne Änderung übersprungen</div>`;
  }

  content.appendChild(body);
  backdrop.appendChild(content);
  document.body.appendChild(backdrop);

  // Styles
  const style = document.createElement('style');
  style.innerHTML = `.action-btn { border: none; padding: 8px 16px; border-radius: 6px; font-weight: 600; cursor: pointer; transition: filter 0.2s; } .action-btn:hover { filter: brightness(1.1); } .action-btn:disabled { filter: grayscale(1); cursor: not-allowed; opacity: 0.7; }`;
  document.head.appendChild(style);

  document.getElementById('close-erp-modal').onclick = () => { backdrop.remove(); _importBuckets = null; document.getElementById('erpFile').value = ''; };

  // Handlers
  const btnUpd = document.getElementById('btn-exec-updates');
  if (btnUpd) btnUpd.onclick = async () => {
    if(!confirm('Updates speichern?')) return;
    btnUpd.disabled = true;
    const payload = buckets.updates.map(u => {
        const c = JSON.parse(JSON.stringify(u.originalEntry));
        if(u.transId) { const t = c.transactions.find(x=>x.id===u.transId); if(t) { t.amount=u.newAmount; t.modified=Date.now(); } }
        else { c.amount=u.newAmount; c.modified=Date.now(); }
        return c;
    });
    await sendBatch(payload, 'Updates');
    btnUpd.textContent = 'Erledigt ✔';
  };

  const btnCall = document.getElementById('btn-exec-calloffs');
  if (btnCall) btnCall.onclick = async () => {
    if(!confirm('Abrufe speichern?')) return;
    btnCall.disabled = true;
    const payload = Array.from(buckets.frameworksToUpdate.values());
    await sendBatch(payload, 'Call-offs');
    btnCall.textContent = 'Erledigt ✔';
  };

  const btnFix = document.getElementById('btn-exec-fix');
  if (btnFix) btnFix.onclick = async () => {
    if(!confirm('Neue Fixaufträge anlegen?')) return;
    btnFix.disabled = true;
    await sendBatch(buckets.newFix, 'Neue Fixaufträge');
    btnFix.textContent = 'Erledigt ✔';
  };
}

// --- Batch Sending Helper (EXTREM SICHER: CHUNK=1, DELAY=1500ms) ---

async function sendBatch(rows, label) {
  if (!rows || rows.length === 0) return;

  // WICHTIG: Cloudflare Free Tier Schutz
  const CHUNK_SIZE = 1; // Immer nur EINEN Eintrag gleichzeitig senden
  const DELAY_MS = 1500; // 1,5 Sekunden Pause zwischen Anfragen

  const total = rows.length;
  let processed = 0;

  showLoader();
  showBatchProgress(`Speichere ${label}...`, 0);

  try {
    for (let i = 0; i < total; i += CHUNK_SIZE) {
      const chunk = rows.slice(i, i + CHUNK_SIZE);
      const currentEnd = Math.min(processed + chunk.length, total);
      const percent = processed / total;
      updateBatchProgress(percent, `${label}: ${processed + 1} von ${total}`);

      const response = await fetchWithRetry(`${WORKER_BASE}/entries/bulk-v2`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: chunk }),
      });
      
      const result = await response.json();
      if (!response.ok || (result && !result.ok)) {
        throw new Error(result.message || 'Server Error');
      }
      processed += chunk.length;
      
      // PAUSE einlegen, wenn noch nicht fertig
      if(processed < total) {
          await new Promise(r => setTimeout(r, DELAY_MS));
      }
    }
    updateBatchProgress(1, 'Fertig!');
    showToast(`${label} erfolgreich!`, 'ok');
    await loadHistory();
  } catch (err) {
    console.error(err);
    showToast(`Fehler: ${err.message}`, 'bad');
  } finally {
    setTimeout(() => { hideBatchProgress(); hideLoader(); }, 1000);
  }
}

// --- Entry Point ---

async function handleErpImport() {
  const fileInput = document.getElementById('erpFile');
  if (!fileInput || fileInput.files.length === 0) {
    showToast('Bitte Datei wählen.', 'bad');
    return;
  }
  showLoader();
  try {
    const buckets = await analyzeErpFile(fileInput.files[0]);
    _importBuckets = buckets;
    renderPreviewModal(buckets);
  } catch (error) {
    console.error(error);
    showToast('Fehler bei Analyse.', 'bad');
  } finally {
    hideLoader();
  }
}

export function initImporter() {
  const btn = document.getElementById('btnErpImport');
  if (btn) {
    const newBtn = btn.cloneNode(true);
    btn.parentNode.replaceChild(newBtn, btn);
    newBtn.addEventListener('click', handleErpImport);
  }
}
