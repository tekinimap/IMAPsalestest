import { WORKER_BASE, DEFAULT_WEIGHTS } from '../config.js';
import { fetchWithRetry, throttle } from '../api.js';
import { parseAmountInput } from '../utils/format.js';
import { showLoader, hideLoader, showToast, showBatchProgress, updateBatchProgress, hideBatchProgress } from '../ui/feedback.js';
import { filtered, autoComplete, loadHistory } from './history.js';
import { compute } from './compute.js';
import { getEntries } from '../entries-state.js';

function getVal(row, keyName) {
  const normalizedKeyName = keyName.toLowerCase().replace(/[^a-z0-9]/g, '');
  const keys = Object.keys(row);
  const foundKey = keys.find((key) => key.toLowerCase().replace(/[^a-z0-9]/g, '').includes(normalizedKeyName));
  return foundKey ? row[foundKey] : undefined;
}

function parseExcelDate(excelDate) {
  if (typeof excelDate === 'number') {
    if (excelDate > 0) {
      return new Date((excelDate - 25569) * 86400 * 1000);
    }
  }
  if (typeof excelDate === 'string') {
    const parsed = new Date(excelDate);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
    const parts = excelDate.match(/(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})/);
    if (parts) {
      let date = new Date(parts[3], parts[2] - 1, parts[1]);
      if (!Number.isNaN(date.getTime())) return date;
      date = new Date(parts[3], parts[1] - 1, parts[2]);
      if (!Number.isNaN(date.getTime())) return date;
    }
  }
  return null;
}

async function handleErpImport() {
  const fileInput = document.getElementById('erpFile');
  const importResult = document.getElementById('importResult');
  if (!fileInput || fileInput.files.length === 0) {
    showToast('Bitte eine Datei auswählen.', 'bad');
    return;
  }

  const file = fileInput.files[0];
  showLoader();
  importResult?.classList.add('hide');

  try {
    await loadHistory();
    const entries = getEntries();
    const data = await file.arrayBuffer();
    const workbook = XLSX.read(data);
    const sheetName = workbook.SheetNames[0];
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);

    let updatedCount = 0;
    let addedToFrameworkCount = 0;
    let newFixCount = 0;
    let skippedCount = 0;

    const allEntriesCopy = JSON.parse(JSON.stringify(entries));
    const changesToPush = [];

    const kvIndex = new Map();
    allEntriesCopy.forEach((entry) => {
      if (entry.kv_nummer) {
        kvIndex.set(entry.kv_nummer, { type: 'fix', entry });
      }
      if (entry.projectType === 'rahmen' && Array.isArray(entry.transactions)) {
        entry.transactions.forEach((trans) => {
          if (trans.kv_nummer) {
            kvIndex.set(trans.kv_nummer, { type: 'transaction', entry, transaction: trans });
          }
        });
      }
    });

    const frameworkProjectIndex = new Map();
    allEntriesCopy.forEach((entry) => {
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
      const amountRaw = getVal(row, 'Agenturleistung netto');
      const amount = parseAmountInput(amountRaw);

      const clientName = getVal(row, 'Projekt Etat Kunde Name') || '';
      const title = getVal(row, 'Titel') || '';

      let freigabeTimestamp = Date.now();
      const excelDate = getVal(row, 'Abschlussdatum') || getVal(row, 'Freigabedatum');
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

      if (existing) {
        let currentAmount;
        if (existing.type === 'transaction') {
          currentAmount = existing.transaction.amount;
        } else {
          currentAmount = existing.entry.amount;
        }

        if (Math.abs(currentAmount - amount) > 0.001) {
          if (existing.type === 'transaction') {
            existing.transaction.amount = amount;
          } else {
            existing.entry.amount = amount;
          }
          existing.entry.modified = Date.now();
          if (!changesToPush.some((item) => item.id === existing.entry.id)) {
            changesToPush.push(existing.entry);
          }
          updatedCount++;
        } else {
          skippedCount++;
        }
      } else {
        const parentFramework = frameworkProjectIndex.get(projektNummer);

        if (parentFramework) {
          if (!Array.isArray(parentFramework.transactions)) {
            parentFramework.transactions = [];
          }
          if (!parentFramework.transactions.some((transaction) => transaction.kv_nummer === kvNummer)) {
            parentFramework.transactions.push({
              id: `trans_${Date.now()}_${kvNummer.replace(/\W/g, '')}`,
              kv_nummer: kvNummer,
              type: 'founder',
              amount,
              ts: Date.now(),
              freigabedatum: freigabeTimestamp,
            });
            parentFramework.modified = Date.now();
            if (!changesToPush.some((item) => item.id === parentFramework.id)) {
              changesToPush.push(parentFramework);
            }
            addedToFrameworkCount++;
          } else {
            skippedCount++;
            console.warn(`KV ${kvNummer} bereits in Rahmenvertrag ${parentFramework.id} gefunden, obwohl nicht im Index.`);
          }
        } else {
          const newFixEntry = {
            id: `entry_${Date.now()}_${kvNummer.replace(/\W/g, '')}`,
            source: 'erp-import',
            projectType: 'fix',
            client: clientName,
            title,
            projectNumber: projektNummer,
            kv_nummer: kvNummer,
            amount,
            list: [],
            rows: [],
            weights: [],
            ts: Date.now(),
            freigabedatum: freigabeTimestamp,
            complete: false,
          };
          allEntriesCopy.push(newFixEntry);
          kvIndex.set(kvNummer, { type: 'fix', entry: newFixEntry });
          changesToPush.push(newFixEntry);
          newFixCount++;
        }
      }
    }

    hideLoader();
    if (changesToPush.length > 0) {
      showBatchProgress('Speichere Import-Änderungen...', changesToPush.length);
      let count = 0;
      for (const entry of changesToPush) {
        count++;
        updateBatchProgress(count, changesToPush.length);

        const originalEntryExists = entries.some((originalEntry) => originalEntry.id === entry.id);
        const url = !originalEntryExists
          ? `${WORKER_BASE}/entries`
          : `${WORKER_BASE}/entries/${encodeURIComponent(entry.id)}`;
        const method = !originalEntryExists ? 'POST' : 'PUT';

        if (method === 'PUT' && !entry.id) {
          throw new Error(`Versuch, Eintrag ohne ID zu aktualisieren (KV: ${entry.kv_nummer || 'unbekannt'})`);
        }

        console.log(`Sending ${method} request to ${url} for KV ${entry.kv_nummer}`);

        const response = await fetchWithRetry(url, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(entry),
        });
        if (!response.ok) {
          throw new Error(
            `Fehler (${method} ${url}) für Eintrag ${entry.id || `(neu mit KV ${entry.kv_nummer})`}: ${await response.text()}`
          );
        }
        await throttle();
      }
    }

    const resultMsg = `Import abgeschlossen: ${updatedCount} Einträge aktualisiert, ${addedToFrameworkCount} neue Abrufe zu Rahmenverträgen hinzugefügt, ${newFixCount} neue Fixaufträge erstellt. ${skippedCount} Zeilen übersprungen (keine Änderungen oder fehlende KV-Nummer).`;
    if (importResult) {
      importResult.innerHTML = resultMsg;
      importResult.classList.remove('hide');
    }
    showToast('ERP-Daten erfolgreich importiert', 'ok');
    await loadHistory();
  } catch (error) {
    showToast('Fehler beim Importieren der Datei.', 'bad');
    console.error(error);
    if (importResult) {
      importResult.textContent = `Fehler: ${error.message}`;
      importResult.classList.remove('hide');
    }
  } finally {
    hideLoader();
    hideBatchProgress();
  }
}

async function handleLegacySalesImport() {
  const fileInput = document.getElementById('legacySalesFile');
  const importResult = document.getElementById('legacyImportResult');
  if (!fileInput || fileInput.files.length === 0) {
    showToast('Bitte eine Datei für den Legacy-Import auswählen.', 'bad');
    return;
  }
  const file = fileInput.files[0];
  showLoader();
  importResult?.classList.add('hide');

  const columnToPersonMap = {
    '% Evaluation und Beteiligung': 'Evaluation und Beteiligung Mitarbeiter:in',
    '% Vielfalt+': 'Vielfalt+ Mitarbeiter:in',
    '% Nachhaltigkeit': 'Nachhaltigkeit Mitarbeiter:in',
    '% Sozial- und Krankenversicherungen': 'Sozial- und Krankenversicherungen Mitarbeiter:in',
    '% ChangePartner': 'ChangePartner Mitarbeiter:in',
    '% Bundes- & Landesbehörden': 'Bundes- und Landesbehörden Mitarbeiter:in',
    '% Kommunalverwaltungen': 'Kommunalverwaltungen Mitarbeiter:in',
    '% Internationale Zusammenarbeit': 'Internationale Zusammenarbeit Mitarbeiter:in',
    '% BU OE': 'BU Lead OE',
    '% BU PI': 'BU Lead PI',
  };
  const percentageColumns = Object.keys(columnToPersonMap);
  const legacyWeights = [
    { key: 'cs', weight: 100 },
    { key: 'konzept', weight: 0 },
    { key: 'pitch', weight: 0 },
  ];

  try {
    await loadHistory();
    const data = await file.arrayBuffer();
    const workbook = XLSX.read(data);
    const sheetName = workbook.SheetNames[0];
    const excelRows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);

    let skippedCount = 0;

    const allEntriesCopy = JSON.parse(JSON.stringify(getEntries()));
    const changesToPush = [];

    const kvIndex = new Map();
    allEntriesCopy.forEach((entry) => {
      if (entry.kv_nummer && entry.projectType !== 'rahmen') {
        kvIndex.set(entry.kv_nummer.trim(), { type: 'fix', entry });
      }
      if (entry.kv && entry.projectType !== 'rahmen') {
        kvIndex.set(entry.kv.trim(), { type: 'fix', entry });
      }
    });

    for (const row of excelRows) {
      const newSalesRows = [];
      let totalPoints = 0;
      for (const colName of percentageColumns) {
        const percentageValue = parseFloat(getVal(row, colName) || 0);
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

      const kvList = kvString
        .split(',')
        .map((kv) => kv.trim())
        .filter((kv) => kv.length > 0);

      const firstFullKv = kvList.find((kv) => kv.toLowerCase().startsWith('kv-')) || kvList[0];
      let kvPrefix = '';
      if (firstFullKv && firstFullKv.includes('-')) {
        kvPrefix = firstFullKv.substring(0, firstFullKv.lastIndexOf('-') + 1);
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

        const existing = kvIndex.get(kvToUpdate);

        if (existing && existing.type === 'fix') {
          const entryToUpdate = existing.entry;

          if (changesToPush.some((item) => item.id === entryToUpdate.id)) {
            console.log(`Eintrag ${entryToUpdate.id} bereits für Update vorgemerkt.`);
            continue;
          }

          entryToUpdate.rows = newSalesRows;
          entryToUpdate.weights = legacyWeights;
          entryToUpdate.totals = { cs: 100, konzept: 0, pitch: 0 };
          const resultData = compute(newSalesRows, legacyWeights, entryToUpdate.amount || 0);
          entryToUpdate.list = resultData.list;
          entryToUpdate.complete = autoComplete(entryToUpdate);
          entryToUpdate.modified = Date.now();

          changesToPush.push(entryToUpdate);
        } else if (!existing) {
          console.warn(`Übersprungen (Vorb.): KV ${kvToUpdate} nicht gefunden.`);
          skippedCount++;
        } else {
          console.warn(`Übersprungen (Vorb.): KV ${kvToUpdate} ist Transaktion, kein Fixauftrag.`);
          skippedCount++;
        }
      }
    }

    hideLoader();

    if (changesToPush.length === 0) {
      if (importResult) {
        importResult.innerHTML = `Legacy-Import: Keine Einträge gefunden oder alle übersprungen. ${skippedCount} Zeilen/KVs übersprungen.`;
        importResult.classList.remove('hide');
      }
      showToast('Legacy-Import: Nichts zu aktualisieren.', 'warn');
      fileInput.value = '';
      return;
    }

    showBatchProgress(`Speichere ${changesToPush.length} Legacy-Änderungen...`, 1);

    try {
      const bulkPayload = { rows: changesToPush };
      const response = await fetchWithRetry(`${WORKER_BASE}/entries/bulk-v2`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bulkPayload),
      });

      updateBatchProgress(1, 1);
      const result = await response.json();

      if (!response.ok || !result.ok) {
        const errorMsg = result.message || result.error || `Serverfehler ${response.status}`;
        throw new Error(`Bulk save failed: ${errorMsg} (Details: ${result.details || 'N/A'})`);
      }

      const resultMsg = `Legacy-Import abgeschlossen: ${result.updated} Einträge erfolgreich aktualisiert. ${skippedCount} Zeilen/KVs in Vorbereitung übersprungen, ${result.skipped} beim Speichern übersprungen. ${result.errors} Fehler beim Speichern.`;
      if (importResult) {
        importResult.innerHTML = resultMsg;
        importResult.classList.remove('hide');
      }
      showToast('Sales-Daten (Altdaten) Import beendet.', result.errors > 0 ? 'warn' : 'ok');
      await loadHistory();
    } catch (error) {
      hideLoader();
      hideBatchProgress();
      showToast('Fehler beim Speichern der Legacy-Daten.', 'bad');
      console.error(error);
      if (importResult) {
        importResult.textContent = `Fehler beim Speichern: ${error.message}`;
        importResult.classList.remove('hide');
      }
    } finally {
      hideLoader();
      hideBatchProgress();
      fileInput.value = '';
    }
  } catch (error) {
    hideLoader();
    hideBatchProgress();
    showToast('Fehler beim Verarbeiten der Datei.', 'bad');
    console.error(error);
    if (importResult) {
      importResult.textContent = `Fehler bei Dateiverarbeitung: ${error.message}`;
      importResult.classList.remove('hide');
    }
  } finally {
    hideLoader();
    hideBatchProgress();
    if (fileInput) {
      fileInput.value = '';
    }
  }
}

function setupErpImportListener() {
  const btnErpImport = document.getElementById('btnErpImport');
  if (btnErpImport) {
    btnErpImport.addEventListener('click', handleErpImport);
  }
}

function setupLegacyImportListener() {
  const btnLegacySalesImport = document.getElementById('btnLegacySalesImport');
  if (btnLegacySalesImport) {
    btnLegacySalesImport.addEventListener('click', handleLegacySalesImport);
  }
}

export function initImporter() {
  setupErpImportListener();
  setupLegacyImportListener();
}
