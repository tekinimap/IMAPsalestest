// --- Kompletter Inhalt für public/js/app.js ---

import { WORKER_BASE, DEFAULT_WEIGHTS, CONFIG_WARNINGS, CONFIG_ERRORS } from './config.js';
import {
  saveState,
  loadState,
  getHasUnsavedChanges,
  setHasUnsavedChanges,
  getIsBatchRunning,
} from './state.js';
import { getEntries, setEntries, upsertEntry, findEntryById, removeEntryById } from './entries-state.js';
import { throttle, fetchWithRetry } from './api.js';
import { formatDateForInput, parseAmountInput } from './utils/format.js';
import {
  showLoader,
  hideLoader,
  showToast,
  showBatchProgress,
  updateBatchProgress,
  hideBatchProgress,
} from './ui/feedback.js';
import { people, loadSession, loadPeople, findPersonByName, findPersonByEmail } from './features/people.js';
import { initFromState } from './features/erfassung.js';
import { compute } from './features/compute.js';
import { initAdminModule, handleAdminClick as handleAdminDataLoad, populateAdminTeamOptions } from './features/admin.js';
import { clampDockRewardFactor, DOCK_WEIGHTING_DEFAULT } from './features/calculations.js';
import { initNavigation, isViewVisible, showView } from './features/navigation.js';
import { initCommonEvents } from './features/common-events.js';
import { renderPortfolio } from './features/portfolio.js';
import {
  autoComplete,
  filtered,
  getSelectedFixIds,
  handleDeleteClick,
  initHistory,
  loadHistory,
  renderHistory,
} from './features/history.js';
import {
  renderDockBoard,
  hideManualPanel,
  requestDockEntryDialogClose,
  showManualPanel,
  clearInputFields,
  dockEntryDialog,
} from './features/dock-board.js';
import { renderFrameworkContracts, renderRahmenDetails } from './features/frameworks.js';
import {
  getPendingDelete,
  setPendingDelete,
  resetPendingDelete,
} from './state/history-state.js';
import { clearDockSelection } from './state/dock-state.js';
import {
  getCurrentFrameworkEntryId,
  setCurrentFrameworkEntryId,
  getEditingTransactionId,
  setEditingTransactionId,
} from './state/framework-state.js';
import { initAnalytics } from './features/analytics.js';

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
const btnXlsx = document.getElementById('btnXlsx');
const btnBatchDelete = document.getElementById('btnBatchDelete');
const entries = getEntries();

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
