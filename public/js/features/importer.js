import { WORKER_BASE } from '../config.js';
import { fetchWithRetry, throttle } from '../api.js';
import { showLoader, hideLoader, showToast, showBatchProgress, updateBatchProgress, hideBatchProgress } from '../ui/feedback.js';
import { loadHistory } from './history.js';
import { getEntries } from '../entries-state.js';

// --- Hilfsfunktionen für Normalisierung und Parsing ---

function normKey(str) {
  return String(str || '').toLowerCase().trim();
}

function parseAmountInput(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    let t = v.trim().replace(/\s/g, '');
    // Erkennt deutsches Format (1.000,00) vs englisches Format (1000.00)
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
  // Nummerisches Excel-Datum
  if (typeof excelDate === 'number' && excelDate > 25569) {
    try {
      const jsTimestamp = (excelDate - 25569) * 86400 * 1000;
      const d = new Date(jsTimestamp);
      // Grobe Zeitzonen-Korrektur
      if (d.getFullYear() > 2000) {
        return new Date(d.getTime() + (d.getTimezoneOffset() * 60000));
      }
    } catch (e) { console.warn("Date parse error (num)", e); }
  }
  // String Datum
  if (typeof excelDate === 'string') {
    const dateString = excelDate.trim();
    // Format: 12.12.2025
    const deMatch = dateString.match(/^(\d{1,2})\s*\.\s*(\d{1,2})\s*\.\s*(\d{4})$/);
    if (deMatch) {
      return new Date(deMatch[3], deMatch[2] - 1, deMatch[1]);
    }
    // Format: 2025-12-12
    const isoMatch = dateString.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (isoMatch) {
      return new Date(isoMatch[1], isoMatch[2] - 1, isoMatch[3]);
    }
  }
  return new Date(); // Fallback: Heute
}

// Sucht flexibel nach Spaltennamen (ignoriert Groß/Kleinschreibung und Sonderzeichen)
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

// Extrahiert Kunde aus Projektnummer (alles vor dem ersten Bindestrich) als Fallback
function extractClientFromProjectNumber(pNr) {
  if (!pNr || typeof pNr !== 'string') return '';
  const parts = pNr.split('-');
  if (parts.length > 1) {
    return parts[0].trim();
  }
  return '';
}

const fmtEUR = (n) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(n);


// --- Hauptlogik Analyse ---

let _importBuckets = null; // Globaler Zwischenspeicher für den Modal-Zustand

async function analyzeErpFile(file) {
  await loadHistory();
  const entries = getEntries(); // Aktueller Stand aus dem State
  
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer);
  const sheetName = workbook.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);

  // Indizes aufbauen für schnellen Zugriff
  const kvIndex = new Map();
  const frameworkIndex = new Map();

  entries.forEach(e => {
    // KV Index für Fixaufträge
    if (e.kv_nummer && e.projectType !== 'rahmen') {
      kvIndex.set(normKey(e.kv_nummer), { type: 'fix', entry: e });
    }
    // KV Index für Transactions in Rahmenverträgen
    if (e.projectType === 'rahmen' && Array.isArray(e.transactions)) {
      e.transactions.forEach(t => {
        if (t.kv_nummer) kvIndex.set(normKey(t.kv_nummer), { type: 'trans', entry: e, transaction: t });
      });
      // Framework Index (nach Projektnummer)
      if (e.projectNumber) {
        frameworkIndex.set(normKey(e.projectNumber), e);
      }
    }
  });

  const buckets = {
    updates: [],     // Bestehende KVs mit neuem Betrag
    calloffs: [],    // Neue KVs zu bestehendem Rahmenvertrag
    newFix: [],      // Ganz neue Fixaufträge
    skipped: [],     // Keine Änderung oder Fehler
    frameworksToUpdate: new Map() // Hilfsstruktur um Calloffs zu bündeln
  };

  for (const row of rows) {
    // 1. Daten auslesen (mit Fehlertoleranz bei Spaltennamen)
    const kvRaw = getVal(row, ['Kostenvoranschlagsnummer', 'KV-Nummer', 'KV']);
    const pNrRaw = getVal(row, ['Projekt Projektnummer', 'Projektnummer']);
    const amount = parseAmountInput(getVal(row, ['Agenturleistung netto', 'Betrag', 'Wert', 'Summe']));
    const title = getVal(row, ['Titel', 'Bezeichnung', 'Thema']) || '';
    
    // Kunde: Erst Spalte prüfen, dann Fallback auf Projektnummer
    let client = getVal(row, ['Projekt Etat Kunde Name', 'Kunde', 'Auftraggeber']);
    if (!client && pNrRaw) {
      client = extractClientFromProjectNumber(pNrRaw);
    }
    client = client || '';

    const dateVal = getVal(row, ['Freigabedatum', 'Abschlussdatum', 'Datum']);
    
    if (!kvRaw) continue; // Zeilen ohne KV ignorieren

    const kvNorm = normKey(kvRaw);
    const pNrNorm = normKey(pNrRaw);
    const dateObj = parseExcelDate(dateVal);
    const ts = dateObj.getTime();

    const existing = kvIndex.get(kvNorm);

    // --- FALL 1: KV Existiert -> Prüfen ob Update nötig ---
    if (existing) {
      let currentAmount = 0;
      let isTrans = (existing.type === 'trans');
      if (isTrans) currentAmount = Number(existing.transaction.amount || 0);
      else currentAmount = Number(existing.entry.amount || 0);

      // Vergleich mit Toleranz (1 Cent)
      if (Math.abs(currentAmount - amount) > 0.01) {
        buckets.updates.push({
          kv: kvRaw,
          title: isTrans ? (existing.transaction.title || title) : (existing.entry.title || title),
          client: existing.entry.client || client,
          oldAmount: currentAmount,
          newAmount: amount,
          type: isTrans ? 'Abruf Korrektur' : 'Fixauftrag Korrektur',
          // Referenz für späteres Speichern
          targetId: existing.entry.id,
          transId: isTrans ? existing.transaction.id : null,
          originalEntry: existing.entry
        });
      } else {
        buckets.skipped.push({ kv: kvRaw, reason: 'Betrag identisch', amount });
      }
      continue;
    }

    // --- FALL 2: KV Neu -> Prüfen ob Rahmenvertrag existiert ---
    const framework = frameworkIndex.get(pNrNorm);
    if (framework) {
      // Prüfen ob wir diesen Rahmenvertrag in diesem Batch schon bearbeitet haben
      let fwEntry = buckets.frameworksToUpdate.get(framework.id);
      if (!fwEntry) {
        // Tiefe Kopie erstellen, damit wir im Speicher arbeiten können
        fwEntry = JSON.parse(JSON.stringify(framework));
        if (!Array.isArray(fwEntry.transactions)) fwEntry.transactions = [];
        buckets.frameworksToUpdate.set(framework.id, fwEntry);
      }

      // Neuen Abruf (Transaction) hinzufügen
      const newTrans = {
        id: `trans_${Date.now()}_${Math.random().toString(36).substr(2,9)}`,
        kv_nummer: kvRaw,
        type: 'founder',
        parentId: fwEntry.id,
        amount: amount,
        ts: Date.now(),
        freigabedatum: ts,
        title: title,
        client: client || fwEntry.client // Fallback auf Framework Kunde
      };
      
      fwEntry.transactions.push(newTrans);
      fwEntry.modified = Date.now();

      buckets.calloffs.push({
        kv: kvRaw,
        projectNumber: pNrRaw,
        title,
        amount,
        parentTitle: fwEntry.title
      });
      continue;
    }

    // --- FALL 3: Ganz neu -> Fixauftrag (Direkt ins Portfolio) ---
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
      // WICHTIG: Flags um Dock zu überspringen
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

// --- UI Rendering (Das Modal) ---

function renderPreviewModal(buckets) {
  // Alten Modal entfernen falls vorhanden
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
      <h2 style="margin:0; font-size: 1.25rem; font-weight: 600;">ERP Import Analyse (v2.0)</h2>
      <button id="close-erp-modal" style="background:transparent; border:none; color: #94a3b8; font-size: 1.5rem; cursor: pointer;">&times;</button>
    </div>
  `;
  content.appendChild(header);

  // Body (Scrollable)
  const body = document.createElement('div');
  body.style.cssText = `padding: 20px; overflow-y: auto; flex: 1;`;

  // --- Sektion 1: UPDATES ---
  if (buckets.updates.length > 0) {
    body.innerHTML += `
      <div style="margin-bottom: 30px; background: #1e293b50; padding: 15px; border-radius: 8px; border: 1px solid #334155;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 10px;">
          <h3 style="margin:0; color: #f59e0b;">⚠️ Abweichungen in bestehenden Aufträgen (${buckets.updates.length})</h3>
          <button id="btn-exec-updates" class="action-btn" style="background: #f59e0b; color: #000;">
            Alle Beträge aktualisieren
          </button>
        </div>
        <div style="max-height: 200px; overflow: auto;">
          <table style="width:100%; border-collapse: collapse; font-size: 0.9rem;">
            <thead style="text-align:left; color:#94a3b8;"><tr><th>KV</th><th>Titel</th><th>Alt</th><th>Neu</th><th>Differenz</th></tr></thead>
            <tbody>
              ${buckets.updates.map(u => `
                <tr style="border-bottom: 1px solid #334155;">
                  <td style="padding: 6px;">${u.kv}</td>
                  <td style="padding: 6px;">${u.title}</td>
                  <td style="padding: 6px;">${fmtEUR(u.oldAmount)}</td>
                  <td style="padding: 6px; font-weight:bold;">${fmtEUR(u.newAmount)}</td>
                  <td style="padding: 6px; color: ${u.newAmount > u.oldAmount ? '#4ade80' : '#f87171'}">
                    ${fmtEUR(u.newAmount - u.oldAmount)}
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  // --- Sektion 2: CALL-OFFS (Rahmenverträge) ---
  if (buckets.calloffs.length > 0) {
    body.innerHTML += `
      <div style="margin-bottom: 30px; background: #1e293b50; padding: 15px; border-radius: 8px; border: 1px solid #334155;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 10px;">
          <h3 style="margin:0; color: #38bdf8;">🏗 Neue Abrufe zu Rahmenverträgen (${buckets.calloffs.length})</h3>
          <button id="btn-exec-calloffs" class="action-btn" style="background: #38bdf8; color: #000;">
            Abrufe zuordnen
          </button>
        </div>
        <div style="max-height: 200px; overflow: auto;">
          <table style="width:100%; border-collapse: collapse; font-size: 0.9rem;">
            <thead style="text-align:left; color:#94a3b8;"><tr><th>KV (Neu)</th><th>Projekt Nr.</th><th>Titel</th><th>Betrag</th><th>Zu Rahmenvertrag</th></tr></thead>
            <tbody>
              ${buckets.calloffs.map(c => `
                <tr style="border-bottom: 1px solid #334155;">
                  <td style="padding: 6px;">${c.kv}</td>
                  <td style="padding: 6px;">${c.projectNumber}</td>
                  <td style="padding: 6px;">${c.title}</td>
                  <td style="padding: 6px;">${fmtEUR(c.amount)}</td>
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
          <button id="btn-exec-fix" class="action-btn" style="background: #4ade80; color: #000;">
            Im Portfolio anlegen
          </button>
        </div>
        <p style="font-size: 0.8rem; color: #94a3b8; margin-top:-5px;">Diese Aufträge landen direkt im Portfolio (Dock übersprungen).</p>
        <div style="max-height: 200px; overflow: auto;">
          <table style="width:100%; border-collapse: collapse; font-size: 0.9rem;">
            <thead style="text-align:left; color:#94a3b8;"><tr><th>KV</th><th>Projekt Nr.</th><th>Titel</th><th>Kunde</th><th>Betrag</th></tr></thead>
            <tbody>
              ${buckets.newFix.map(f => `
                <tr style="border-bottom: 1px solid #334155;">
                  <td style="padding: 6px;">${f.kv_nummer}</td>
                  <td style="padding: 6px;">${f.projectNumber}</td>
                  <td style="padding: 6px;">${f.title}</td>
                  <td style="padding: 6px; color: ${f.client ? 'inherit' : '#f87171'}">${f.client || '(fehlt)'}</td>
                  <td style="padding: 6px;">${fmtEUR(f.amount)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  // --- Sektion 4: SKIPPED ---
  if (buckets.skipped.length > 0) {
    body.innerHTML += `
      <div style="margin-bottom: 10px; opacity: 0.6;">
        <h4 style="margin:0; font-size: 0.9rem;">👻 ${buckets.skipped.length} Einträge ohne Änderung übersprungen (Betrag identisch)</h4>
      </div>
    `;
  }

  if (buckets.updates.length === 0 && buckets.calloffs.length === 0 && buckets.newFix.length === 0) {
    body.innerHTML += `<div style="text-align:center; padding: 40px;">Alles auf dem neuesten Stand! Keine Aktionen erforderlich.</div>`;
  }

  content.appendChild(body);
  backdrop.appendChild(content);
  document.body.appendChild(backdrop);

  // Styles für Buttons
  const style = document.createElement('style');
  style.innerHTML = `
    .action-btn { border: none; padding: 8px 16px; border-radius: 6px; font-weight: 600; cursor: pointer; transition: filter 0.2s; }
    .action-btn:hover { filter: brightness(1.1); }
    .action-btn:disabled { filter: grayscale(1); cursor: not-allowed; opacity: 0.7; }
  `;
  document.head.appendChild(style);

  // --- Event Listeners für Buttons ---

  document.getElementById('close-erp-modal').onclick = () => {
    backdrop.remove();
    _importBuckets = null; 
    document.getElementById('erpFile').value = ''; 
  };

  // 1. UPDATES AUSFÜHREN
  const btnUpd = document.getElementById('btn-exec-updates');
  if (btnUpd) {
    btnUpd.onclick = async () => {
      if (!confirm(`Sicher ${buckets.updates.length} Beträge aktualisieren?`)) return;
      btnUpd.disabled = true;
      btnUpd.textContent = 'Speichere...';
      
      const payload = buckets.updates.map(u => {
        // Wir senden den kompletten Eintrag mit aktualisiertem Betrag
        const entryCopy = JSON.parse(JSON.stringify(u.originalEntry));
        if (u.transId) {
          // Es ist eine Transaction
          const t = entryCopy.transactions.find(tx => tx.id === u.transId);
          if (t) {
            t.amount = u.newAmount;
            t.modified = Date.now();
          }
          entryCopy.modified = Date.now();
        } else {
          // Es ist ein Fixauftrag
          entryCopy.amount = u.newAmount;
          entryCopy.modified = Date.now();
        }
        return entryCopy;
      });

      await sendBatch(payload, 'Updates');
      btnUpd.textContent = 'Erledigt ✔';
    };
  }

  // 2. CALL-OFFS AUSFÜHREN
  const btnCall = document.getElementById('btn-exec-calloffs');
  if (btnCall) {
    btnCall.onclick = async () => {
      if (!confirm(`Sicher ${buckets.calloffs.length} neue Abrufe zu Rahmenverträgen hinzufügen?`)) return;
      btnCall.disabled = true;
      btnCall.textContent = 'Speichere...';

      // Wir senden die modifizierten Rahmenvertrags-Objekte (die jetzt mehr Transactions haben)
      const payload = Array.from(buckets.frameworksToUpdate.values());
      
      await sendBatch(payload, 'Call-offs');
      btnCall.textContent = 'Erledigt ✔';
    };
  }

  // 3. FIXAUFTRÄGE AUSFÜHREN
  const btnFix = document.getElementById('btn-exec-fix');
  if (btnFix) {
    btnFix.onclick = async () => {
      if (!confirm(`Sicher ${buckets.newFix.length} neue Fixaufträge im Portfolio anlegen?`)) return;
      btnFix.disabled = true;
      btnFix.textContent = 'Speichere...';

      await sendBatch(buckets.newFix, 'Neue Fixaufträge');
      btnFix.textContent = 'Erledigt ✔';
    };
  }
}

// --- Batch Sending Helper ---

async function sendBatch(rows, label) {
  showLoader();
  try {
    const response = await fetchWithRetry(`${WORKER_BASE}/entries/bulk-v2`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows }),
    });
    
    const result = await response.json();
    if (!response.ok || !result.ok) {
      throw new Error(result.message || 'Server Error');
    }
    
    showToast(`${label} erfolgreich gespeichert!`, 'ok');
    await loadHistory(); // Reload local state
  } catch (err) {
    console.error(err);
    showToast(`Fehler beim Speichern von ${label}: ${err.message}`, 'bad');
  } finally {
    hideLoader();
  }
}

// --- Entry Point ---

async function handleErpImport() {
  const fileInput = document.getElementById('erpFile');
  if (!fileInput || fileInput.files.length === 0) {
    showToast('Bitte eine Datei auswählen.', 'bad');
    return;
  }
  
  showLoader();
  try {
    const buckets = await analyzeErpFile(fileInput.files[0]);
    _importBuckets = buckets; // Store for access
    renderPreviewModal(buckets);
  } catch (error) {
    console.error(error);
    showToast('Fehler beim Analysieren der Datei.', 'bad');
  } finally {
    hideLoader();
  }
}

// --- Init ---

export function initImporter() {
  const btn = document.getElementById('btnErpImport');
  if (btn) {
    // Alten Listener sicher entfernen durch Klonen
    const newBtn = btn.cloneNode(true);
    btn.parentNode.replaceChild(newBtn, btn);
    newBtn.addEventListener('click', handleErpImport);
  }
  
  // Legacy Import Listener, falls noch benötigt (kannst du auch auskommentieren)
  const btnLegacy = document.getElementById('btnLegacySalesImport');
  if (btnLegacy) {
    // btnLegacy.addEventListener('click', ...); 
  }
}
