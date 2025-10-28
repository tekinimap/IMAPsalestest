// erp-preview-override.js  v4.7
// Fix: buildKvIndex und buildFrameworkIndex vereinfacht ("first wins").
// Add: Logging beim Index-Aufbau.
// Behält minimale norm*/stopPropagation/Fehlermeldungs-Fixes aus v4.5 bei.

(function(){
  const hasXLSX = typeof XLSX !== 'undefined';
  const WORKER = ()=> (window.WORKER_BASE || '').replace(/\/+$/,'');
  const fmtEUR = (n)=> new Intl.NumberFormat('de-DE',{style:'currency',currency:'EUR',maximumFractionDigits:2}).format(n||0);
  const fmtEUR0 = (n)=> new Intl.NumberFormat('de-DE',{style:'currency',currency:'EUR',maximumFractionDigits:0}).format(n||0); // Für Vergleiche ohne Cent

  const showToast   = window.showToast   || ((m,t)=>console.log('[toast]',t||'info',m));
  const showLoader  = window.showLoader  || (()=>{});
  const hideLoader  = window.hideLoader  || (()=>{});
  const fetchRetry  = window.fetchWithRetry || fetch;
  const loadHistory = window.loadHistory || (async()=>{ console.warn('loadHistory shim used'); });
  const throttle    = window.throttle || (async(ms=80)=>{ await new Promise(r=>setTimeout(r, ms)); });

  // ---------- Helpers ----------
  function parseAmountInput(v){
    if (v==null || v==='') return 0;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string'){
      let t = v.trim().replace(/\s/g,'');
      if (t.includes(',') && (!t.includes('.') || /\.\d{3},\d{1,2}$/.test(t))) {
        t = t.replace(/\./g,'').replace(',', '.');
      } else {
        t = t.replace(/,/g,'');
      }
      const n = Number(t);
      return Number.isFinite(n) ? n : 0;
    }
    return 0;
  }
  function getVal(row, keyName) {
    const norm = keyName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const k = Object.keys(row).find(k => k.toLowerCase().replace(/[^a-z0-9]/g, '').includes(norm));
    return k ? row[k] : undefined;
  }
  // *** NEU: parseExcelDate v4.8 - Priorisiert TT.MM.JJJJ ***
  function parseExcelDate(excelDate) {
    // 1. Excel-Zahl (höchste Prio)
    if (typeof excelDate === 'number' && excelDate > 25569) { // 25569 = 01.01.1970
      try {
        // Korrekte Umrechnung Excel-Datum (Tage seit 01.01.1900, Achtung Schaltjahr-Bug 1900) zu JS-Timestamp
        const jsTimestamp = (excelDate - 25569) * 86400 * 1000;
        const d = new Date(jsTimestamp);
        // Zusätzliche Prüfung: Ist das Jahr plausibel? (z.B. > 2000)
        if (d.getFullYear() > 2000) {
           // UTC-Datumskorrektur: Excel-Zahlen haben keine Zeitzone, JS Date nimmt lokale an.
           // Um Mitternacht UTC zu bekommen, addiere den Zeitzonen-Offset.
           return new Date(d.getTime() + d.getTimezoneOffset() * 60000);
        }
      } catch (e) {
         console.warn("Excel date number parsing failed:", e);
      }
    }

    // 2. String-Verarbeitung
    if (typeof excelDate === 'string') {
      const dateString = excelDate.trim();

      // Versuch 2a: Strenges TT.MM.JJJJ Format
      const europeanMatch = dateString.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
      if (europeanMatch) {
        const day = parseInt(europeanMatch[1], 10);
        const month = parseInt(europeanMatch[2], 10); // Monat ist 1-basiert
        const year = parseInt(europeanMatch[3], 10);
        // Validierung: Sind Tag, Monat, Jahr gültig?
        if (day >= 1 && day <= 31 && month >= 1 && month <= 12 && year > 1900) {
          // Erstelle Datum als UTC Mitternacht, um Zeitzonenprobleme zu vermeiden
          const d = new Date(Date.UTC(year, month - 1, day)); // Monat ist 0-basiert in JS Date
          // Prüfe, ob das erstellte Datum den Eingabewerten entspricht (verhindert ungültige Tage wie 31. Feb)
          if (d.getUTCDate() === day && d.getUTCMonth() === month - 1 && d.getUTCFullYear() === year) {
             console.log(`[parseExcelDate] Parsed TT.MM.JJJJ: ${dateString} -> ${d.toISOString()}`); // DEBUG
             return d;
          }
        }
      }

      // Versuch 2b: ISO Format (YYYY-MM-DD) oder andere von new Date() unterstützte Formate
      // Wichtig: Kann MM/DD/YYYY interpretieren, wenn kein TT.MM.JJJJ passt!
      try {
          const d = new Date(dateString);
          // Validierung: Ist das Datum gültig und Jahr plausibel?
          if (!isNaN(d.getTime()) && d.getFullYear() > 1900) {
              console.log(`[parseExcelDate] Parsed via new Date(): ${dateString} -> ${d.toISOString()}`); // DEBUG
              // Hier nehmen wir an, dass die Interpretation korrekt war, falls TT.MM.JJJJ nicht passte.
              // Ggf. müsste man hier noch spezifischer prüfen, wenn MM/DD ausgeschlossen werden soll.
             // Rückgabe als Mitternacht UTC könnte sinnvoll sein:
             return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
             // return d; // Oder lokale Zeit? Hängt vom Zielsystem ab. UTC ist oft sicherer.
          }
      } catch(e) { /* Ignoriere Fehler von new Date() */ }
    }

    // 3. Fallback
    console.warn(`[parseExcelDate] Could not parse date:`, excelDate); // DEBUG
    return null; // Ungültiges Format oder Wert
  }
    }
    return null;
  }

  // *** MINIMAL: KV-Schlüssel v4.3 ***
  const normKV = (v) => {
    if (!v) return '';
    return String(v).trim();
  };

  // *** MINIMAL: Projektnummer-Schlüssel v4.3 ***
  const normProjectNumber = (v) => {
    if (!v) return '';
    return String(v).trim();
  };


  // ---------- Dialog (Preview) ----------
  function ensureDialog(){
    if (document.getElementById('erpPreviewDlg')) return;
    const css = document.createElement('style');
    css.textContent = `
      dialog#erpPreviewDlg{border:1px solid #213044;background:#0f1724;color:#e6ebf3;border-radius:14px;min-width:1100px; max-width: 95vw; padding:16px;z-index:10000}
      #erpPrev .kpis{display:flex;gap:14px;flex-wrap:wrap;margin:8px 0 12px}
      #erpPrev .card{background:#111a2b;border:1px solid #213044;border-radius:12px;padding:10px 12px;min-width:190px}
      #erpPrev .label{font-size:12px;opacity:.7}
      #erpPrev .value{font-size:16px;font-weight:600}
      #erpPrev h3{margin:14px 0 6px;font-size:14px}
      #erpPrev table{width:100%;border-collapse:collapse}
      #erpPrev th,#erpPrev td{border-bottom:1px dashed #213044;padding:6px 8px;font-size:12px;text-align:left; vertical-align: top;}
      #erpPrev th{position:sticky;top:0;background:#0b1220;z-index:1}
      .mono{font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;}
      .btnx{background:#3b82f6;color:#fff;border:none;border-radius:10px;padding:8px 12px;cursor:pointer}
      .btnx:hover{filter:brightness(1.05)}
      .small{font-size:12px}
      .reason-detail { color: #94a3b8; font-size: 11px; }
    `;
    document.head.appendChild(css);

    const dlg = document.createElement('dialog');
    dlg.id = 'erpPreviewDlg';
    dlg.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;">
        <div>
          <h1 style="margin:0;font-size:18px;">Import-Vorschau (ERP)</h1>
          <div id="erpPreviewSummary" class="small" style="opacity:.8"></div>
        </div>
        <div style="display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap;">
          <button class="btnx small" id="btnApplyImport">Änderungen übernehmen</button>
          <button class="btnx small" id="btnClosePreview">Schließen</button>
        </div>
      </div>
      <div id="erpPrev">
        <div class="kpis">
          <div class="card"><div class="label">Excel Summe</div><div class="value mono" id="kpiExcel">–</div></div>
          <div class="card"><div class="label">Tool Summe (aktuell)</div><div class="value mono" id="kpiTool">–</div></div>
          <div class="card"><div class="label">Ausgewählt (Excel)</div><div class="value mono" id="kpiSel">–</div></div>
          <div class="card"><div class="label">Prognose Tool nach Übernahme</div><div class="value mono" id="kpiProj">–</div></div>
        </div>

        <h3>1. Aktualisierte bestehende KVs</h3>
        <table><thead><tr>
          <th>✔</th><th>KV</th><th>Projektnr</th><th>Titel</th><th>Kunde</th><th>Alt Betrag</th><th>Neu Betrag</th><th>Δ</th>
        </tr></thead><tbody id="tblUpdatedRows"></tbody></table>

        <h3>2. Neue Abrufe in Rahmenverträgen</h3>
        <table><thead><tr>
          <th>✔</th><th>KV (Abruf)</th><th>Rahmenvertrag Projektnummer</th><th>Titel</th><th>Kunde</th><th>Wert</th>
        </tr></thead><tbody id="tblNewCalloffs"></tbody></table>

        <h3>3. Neue Fixaufträge</h3>
        <table><thead><tr>
          <th>✔</th><th>KV</th><th>Projektnummer</th><th>Titel</th><th>Kunde</th><th>Wert</th><th>Grund</th>
        </tr></thead><tbody id="tblNewFixes"></tbody></table>

        <h3>4. Übersprungen</h3>
        <table><thead><tr>
          <th>KV</th><th>Projektnummer</th><th>Titel</th><th>Kunde</th><th>Wert</th><th>Grund</th>
        </tr></thead><tbody id="tblSkipped"></tbody></table>
      </div>
    `;
    document.body.appendChild(dlg);

    document.getElementById('btnClosePreview').onclick = ()=> dlg.close();
    document.getElementById('btnApplyImport').onclick  = applyErpImport;
  }

  function setKpis(preview){
    const excelSum = preview._excelSum || 0;
    const toolSum = (preview._initialEntries || []).reduce((s,e)=> s + (Number(e.amount)||0) + (Array.isArray(e.transactions)? e.transactions.reduce((a,t)=>a+(Number(t.amount)||0),0):0), 0);
    const selExcelUpdates = preview.updatedRows.filter(x=>x._keep!==false).reduce((s,x)=> s + (x.newAmount||0), 0);
    const selExcelCalloffs = preview.newCalloffs.filter(x=>x._keep!==false).reduce((s,x)=> s + (x.amount||0), 0);
    const selExcelFixes = preview.newFixes.filter(x=>x._keep!==false).reduce((s,x)=> s + (x.amount||0), 0);
    const selExcel = selExcelUpdates + selExcelCalloffs + selExcelFixes;
    const replacedToolAmount = preview.updatedRows.filter(x=>x._keep!==false).reduce((s,x)=> s + (x.oldAmount||0), 0);
    const projected = (toolSum - replacedToolAmount) + selExcel;
    document.getElementById('kpiExcel').textContent = fmtEUR(excelSum);
    document.getElementById('kpiTool').textContent  = fmtEUR(toolSum);
    document.getElementById('kpiSel').textContent   = fmtEUR(selExcel);
    document.getElementById('kpiProj').textContent  = fmtEUR(projected);
  }

  function renderPreview(preview){
    ensureDialog();
    const f = fmtEUR;
    const esc = (s) => String(s||'').replace(/</g, '&lt;');
    document.getElementById('erpPreviewSummary').textContent =
      `${preview.updatedRows.length} Updates, ${preview.newCalloffs.length} neue Abrufe, ${preview.newFixes.length} neue Fixaufträge, ${preview.skipped.length} übersprungen.`;

    document.getElementById('tblUpdatedRows').innerHTML = preview.updatedRows.map((row,i)=>{
      const diff = (row.newAmount||0) - (row.oldAmount||0);
      return `<tr>
        <td><input type="checkbox" data-scope="upd" data-idx="${i}" ${row._keep!==false?'checked':''}></td>
        <td class="mono">${esc(row.kv)}</td>
        <td class="mono">${esc(row.projectNumber)}</td>
        <td>${esc(row.title)}</td>
        <td>${esc(row.client)}</td>
        <td class="mono">${f(row.oldAmount)}</td>
        <td class="mono">${f(row.newAmount)}</td>
        <td class="mono" style="color:${diff > 0 ? '#22c55e' : (diff < 0 ? '#ef4444' : '')}">${diff===0?'±0': (diff>0?'+':'')+f(diff)}</td>
      </tr>`;
    }).join('');

    document.getElementById('tblNewCalloffs').innerHTML = preview.newCalloffs.map((row,i)=>`
      <tr>
        <td><input type="checkbox" data-scope="call" data-idx="${i}" ${row._keep!==false?'checked':''}></td>
        <td class="mono">${esc(row.kv)}</td>
        <td class="mono">${esc(row.parentProjectNumber)}</td>
        <td>${esc(row.title)}</td>
        <td>${esc(row.client)}</td>
        <td class="mono">${f(row.amount)}</td>
      </tr>
    `).join('');

    document.getElementById('tblNewFixes').innerHTML = preview.newFixes.map((row,i)=>`
      <tr>
        <td><input type="checkbox" data-scope="fix" data-idx="${i}" ${row._keep!==false?'checked':''}></td>
        <td class="mono">${esc(row.kv)}</td>
        <td class="mono">${esc(row.projectNumber)}</td>
        <td>${esc(row.title)}</td>
        <td>${esc(row.client)}</td>
        <td class="mono">${f(row.amount)}</td>
        <td><span class="small">${esc(row._matchReason || 'Unbekannt')}</span></td>
      </tr>
    `).join('');

    document.getElementById('tblSkipped').innerHTML = preview.skipped.map((row)=>`
      <tr>
        <td class="mono">${esc(row.kv)}</td>
        <td class="mono">${esc(row.projectNumber)}</td>
        <td>${esc(row.title)}</td>
        <td>${esc(row.client)}</td>
        <td class="mono">${f(row.amount||0)}</td>
        <td><strong>${esc(row.reason)}</strong> <br><span class="reason-detail">${esc(row.detail)}</span></td>
      </tr>
    `).join('');

    const dlg = document.getElementById('erpPreviewDlg');
    dlg.querySelectorAll('input[type="checkbox"][data-scope]').forEach(cb=>{
      cb.onchange = ()=>{
        const scope = cb.getAttribute('data-scope');
        const idx = Number(cb.getAttribute('data-idx'));
        const keep = cb.checked;
        if (scope==='upd')  preview.updatedRows[idx]._keep = keep;
        if (scope==='call') preview.newCalloffs[idx]._keep = keep;
        if (scope==='fix')  preview.newFixes[idx]._keep = keep;
        setKpis(preview);
      };
    });
    setKpis(preview);
    dlg.showModal();
    window.__erpPreview = preview;
  }

  const isFullEntry = (obj)=> !!(obj && (obj.projectType || obj.transactions || Array.isArray(obj.rows) || Array.isArray(obj.list) || Array.isArray(obj.weights)));

  async function applyErpImport(){
    const dlg = document.getElementById('erpPreviewDlg');
    const preview = window.__erpPreview;
    if (!preview) { showToast('Keine Importdaten vorhanden.', 'bad'); return; }

    const changedEntries = preview._modifiedEntriesMap;
    const finalChanges = [];

    preview.updatedRows.forEach(x=>{
      if (x._keep===false) return;
      const modifiedEntry = changedEntries.get(x.entry.id);
      if (modifiedEntry && !finalChanges.some(e=> e.id === modifiedEntry.id)) { finalChanges.push(modifiedEntry); }
    });
    preview.newCalloffs.forEach(x=>{
      if (x._keep===false) return;
      const modifiedParent = changedEntries.get(x.parentEntry.id);
       if (modifiedParent && !finalChanges.some(e=> e.id === modifiedParent.id)) { finalChanges.push(modifiedParent); }
    });
    preview.newFixes.forEach(x=>{
      if (x._keep===false) return;
      finalChanges.push(x.newFixEntry);
    });

    if (finalChanges.length===0){ showToast('Nichts ausgewählt.', 'bad'); return; }

    showLoader();

    try {
        // *** EINZELN SENDEN ***
        if (typeof window.showBatchProgress === 'function') window.showBatchProgress('Speichere Import-Änderungen…', finalChanges.length);

        let done = 0;
        let errors = 0;
        for (const entry of finalChanges) {
          done++;
          if (typeof window.updateBatchProgress === 'function') window.updateBatchProgress(done, finalChanges.length);

          const isNew = entry.id && entry.id.startsWith('entry_');

          const url = isNew ? `${WORKER()}/entries` : `${WORKER()}/entries/${encodeURIComponent(entry.id)}`;
          const method = isNew ? 'POST' : 'PUT';

          const r = await fetchRetry(url, { method, headers:{'Content-Type':'application/json'}, body: JSON.stringify(entry) });
          if (!r.ok){
            errors++;
            const errText = await r.text();
            console.error(`Fehler (${method} ${url}) bei ${entry.kv_nummer||entry.kv||entry.id}:`, errText);
            showToast(`Fehler bei ${entry.kv_nummer||entry.kv||entry.id}: ${r.status}`, 'bad', 5000);
          }
          await throttle(250);
        }

        if (typeof window.hideBatchProgress === 'function') window.hideBatchProgress();
        showToast(`Import übernommen (${done - errors} gespeichert, ${errors} Fehler).`, errors > 0 ? 'bad' : 'ok');
        dlg.close();
        await loadHistory();

    } catch (e) {
        console.error('Fehler in applyErpImport:', e);
        showToast(`Genereller Fehler beim Übernehmen: ${e.message}`, 'bad');
        if (typeof window.hideBatchProgress === 'function') window.hideBatchProgress();
    } finally {
        hideLoader();
    }
  }


  // ---------- Kernlogik (Analyse/Preview) ----------

  // *** VEREINFACHT: buildKvIndex v4.7 - "First Wins" + Logging ***
  function buildKvIndex(entries){
    const map = new Map();
    console.log('[buildKvIndex v4.7] Starting. Processing entries:', entries?.length); // DEBUG
    (entries||[]).forEach((entry, idx)=>{
      // Fixaufträge
      const entryKvRaw = entry.kv_nummer || entry.kv;
      const key = normKV(entryKvRaw); // Minimal norm (trim)
      if (key && entry.projectType !== 'rahmen') {
         if (!map.has(key)) {
             console.log(`[buildKvIndex v4.7] Adding FIX: Key='${key}' from entry ID ${entry.id}`); // DEBUG
             map.set(key, { type:'fix', entry });
         } else {
             // Ignoriere einfach, wenn der Schlüssel schon existiert.
             // console.warn(`[buildKvIndex v4.7] FIX Key collision ignored: Key='${key}'`); // DEBUG (Optional)
         }
      }
      // Transaktionen
      if (entry.projectType==='rahmen' && Array.isArray(entry.transactions)) {
        entry.transactions.forEach(t=>{
          const transKvRaw = t.kv_nummer || t.kv;
          const tkey = normKV(transKvRaw); // Minimal norm (trim)
          if (tkey) {
             if (!map.has(tkey)) {
                 console.log(`[buildKvIndex v4.7] Adding TRANSACTION: Key='${tkey}' from parent ID ${entry.id}, trans ID ${t.id}`); // DEBUG
                 map.set(tkey, { type:'transaction', entry, transaction:t });
             } else {
                 // Ignoriere einfach, wenn der Schlüssel schon existiert.
                 // console.warn(`[buildKvIndex v4.7] TRANSACTION Key collision ignored: Key='${tkey}'`); // DEBUG (Optional)
             }
          }
        });
      }
    });
    console.log('[buildKvIndex v4.7] Finished. Map size:', map.size); // DEBUG
    return map;
  }

  // *** VEREINFACHT: buildFrameworkIndex v4.7 - "First Wins" + Logging ***
  function buildFrameworkIndex(entries){
    const map = new Map();
    console.log('[buildFrameworkIndex v4.7] Starting. Processing entries:', entries?.length); // DEBUG
    (entries||[]).forEach(entry=>{
      if (entry.projectType==='rahmen' && entry.projectNumber) {
        const key = normProjectNumber(entry.projectNumber); // Minimal norm (trim)
        if (key) {
          if (!map.has(key)) {
            console.log(`[buildFrameworkIndex v4.7] Adding FRAMEWORK: Key='${key}' from entry ID ${entry.id}`); // DEBUG
            map.set(key, entry);
          } else {
             // Ignoriere einfach, wenn der Schlüssel schon existiert.
             // console.warn(`[buildFrameworkIndex v4.7] FRAMEWORK Key collision ignored: Key='${key}'`); // DEBUG (Optional)
          }
        }
      }
    });
    console.log('[buildFrameworkIndex v4.7] Finished. Map size:', map.size); // DEBUG
    return map;
  }


  function renderAndOpen(preview){
    hideLoader();
    renderPreview(preview);
  }

  // *** Hauptfunktion, mit stopPropagation und fmtEUR Korrektur ***
  async function handleErpImportPreview(e){
    e?.preventDefault?.();
    e?.stopPropagation?.();

    if (!hasXLSX){ showToast('SheetJS (XLSX) nicht geladen.', 'bad'); return; }

    const fileInput = document.getElementById('erpFile');
    if (!fileInput || fileInput.files.length===0) { showToast('Bitte eine ERP-Excel-Datei auswählen.', 'bad'); return; }
    const file = fileInput.files[0];

    showLoader();
    try {
      await loadHistory();
      console.log('Entries loaded:', window.entries?.length);

      const entriesCopy = JSON.parse(JSON.stringify(window.entries || []));
      const modifiedEntriesMap = new Map();
      const kvIndex        = buildKvIndex(entriesCopy); // Uses v4.7
      const frameworkIndex = buildFrameworkIndex(entriesCopy); // Uses v4.7

      console.log('kvIndex size after build:', kvIndex.size);
      console.log('frameworkIndex size after build:', frameworkIndex.size);
      // console.log('Checking KV-2025-0007 in kvIndex:', kvIndex.get('KV-2025-0007')); // DEBUG

      const data = await file.arrayBuffer();
      const workbook = XLSX.read(data);
      const sheetName = workbook.SheetNames[0];
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);

      const preview = {
          updatedRows: [], newCalloffs: [], newFixes: [], skipped: [],
          _excelSum: 0,
          _initialEntries: JSON.parse(JSON.stringify(entriesCopy)),
          _modifiedEntriesMap: modifiedEntriesMap
      };

      for (const row of rows) {
        const kvRaw   = getVal(row,'KV-Nummer');
        const pNumRaw = getVal(row,'Projekt Projektnummer');
        const amount  = parseAmountInput(getVal(row,'Agenturleistung netto'));
        const client  = getVal(row,'Projekt Etat Kunde Name') || '';
        const title   = getVal(row,'Titel') || '';
        preview._excelSum += amount||0;

        let freeTS = Date.now();
        const excelDate = getVal(row,'Freigabedatum');
        if (excelDate) { const d = parseExcelDate(excelDate); if (d) freeTS = d.getTime(); }

        const kvNorm = normKV(kvRaw);
        const pNumNorm = normProjectNumber(pNumRaw);

        if (!kvNorm){
          preview.skipped.push({ kv: kvRaw, projectNumber: pNumRaw, title, client, amount, reason:'Keine KV-Nummer', detail:`Zeile ohne gültige KV (Roh: ${kvRaw})` });
          if (window.LOGBOOK2) LOGBOOK2.importSkip({ kv: kvRaw, projectNumber: pNumRaw, title, client, source:'erp', reason:'missing_kv', detail:`Zeile ohne gültige KV-Nummer (Roh: ${kvRaw})` });
          continue;
        }

        const existing = kvIndex.get(kvNorm);
        let matchReason = '';

        if (existing){
          const isTransaction = existing.type === 'transaction';
          const currentEntry = existing.entry;
          const currentItem = isTransaction ? existing.transaction : currentEntry;
          const currentAmount = Number(currentItem.amount)||0;

          if (fmtEUR0(currentAmount) !== fmtEUR0(amount)) {
            currentItem.amount = amount;
            // Update timestamp only if relevant field exists
            if (isTransaction && 'ts' in currentItem) currentItem.ts = Date.now(); // Assuming transactions only have ts
            if (!isTransaction) currentEntry.modified = Date.now(); // Update modified on parent entry

             // Only update freigabedatum if it was actually parsed from Excel
            if (excelDate && parseExcelDate(excelDate)) {
                 if (isTransaction) currentItem.freigabedatum = freeTS;
                 if (!isTransaction) currentEntry.freigabedatum = freeTS;
            }

            modifiedEntriesMap.set(currentEntry.id, currentEntry);

            preview.updatedRows.push({
              kv: kvRaw, projectNumber: pNumRaw, title: title || currentItem.title || '', client: client || currentItem.client || '',
              oldAmount: currentAmount, newAmount: amount,
              entry: currentEntry, _keep: true
            });
          } else {
            // Betrag ist identisch (auf Euro gerundet)
            preview.skipped.push({ kv: kvRaw, projectNumber: pNumRaw, title, client, amount, reason:'Keine Änderung', detail:`Betrag (${fmtEUR(amount)}) identisch (Schlüssel: ${kvNorm}).` }); // KORRIGIERT: f -> fmtEUR
            if (window.LOGBOOK2) LOGBOOK2.importSkip({ kv: kvRaw, projectNumber: pNumRaw, title, client, source:'erp', reason:'no_change', detail:`Betrag ${fmtEUR(amount)} identisch (Schlüssel: ${kvNorm})` });
          }
          continue;
        }

        const parentFramework = pNumNorm ? frameworkIndex.get(pNumNorm) : null;
        if (parentFramework){
          parentFramework.transactions = Array.isArray(parentFramework.transactions) ? parentFramework.transactions : [];
          const existsTrans = parentFramework.transactions.some(t => normKV(t.kv_nummer || t.kv) === kvNorm);
          if (!existsTrans){
            const newTrans = { id:`trans_${Date.now()}_${kvNorm.replace(/[^A-Z0-9]/g,'')}`, kv_nummer: kvRaw, type:'founder', amount, ts:Date.now(), freigabedatum: freeTS };
            parentFramework.transactions.push(newTrans);
            parentFramework.modified = Date.now();
            modifiedEntriesMap.set(parentFramework.id, parentFramework);
            preview.newCalloffs.push({ kv: kvRaw, parentProjectNumber: pNumRaw, title, client, amount, parentEntry: parentFramework, _keep:true });
          } else {
            preview.skipped.push({ kv: kvRaw, projectNumber: pNumRaw, title, client, amount, reason:'Abruf doppelt?', detail:`KV ${kvNorm} bereits in Rahmenvertrag ${pNumNorm}, aber Index hat nicht gematcht?` });
            if (window.LOGBOOK2) LOGBOOK2.importSkip({ kv: kvRaw, projectNumber: pNumRaw, title, client, source:'erp', reason:'duplicate_calloff', detail:'KV bereits in transactions[] gefunden' });
          }
          continue;
        }

        matchReason = `KV '${kvRaw}' nicht im Index gefunden (Schlüssel: '${kvNorm}').`;
        if (pNumRaw) {
            matchReason += ` Rahmenvertrag '${pNumRaw}' nicht im Index gefunden (Schlüssel: '${pNumNorm}').`;
        } else {
            matchReason += ` Keine Projektnummer in Excel angegeben.`;
        }

        const newFixEntry = {
          id: `entry_${Date.now()}_${kvNorm.replace(/[^A-Z0-9]/g,'')}`,
          source: 'erp-import', projectType: 'fix',
          client, title, projectNumber: pNumRaw, kv_nummer: kvRaw, amount,
          list: [], rows: [], weights: [],
          ts: Date.now(), freigabedatum: freeTS, complete: false
        };
        preview.newFixes.push({ kv: kvRaw, projectNumber: pNumRaw, title, client, amount, newFixEntry, _matchReason: matchReason, _keep:true });

      } // Ende for-Schleife

      renderAndOpen(preview);

    } catch(e){
      hideLoader();
      console.error('Fehler bei der ERP-Import-Vorschau:', e);
      showToast(`Fehler beim Analysieren der Datei: ${e.message}`, 'bad');
    }
  }

  // ---------- Button hook ----------
  function hookButton(){
    const btn = document.getElementById('btnErpImport');
    if (!btn) { console.warn('ERP Import Button #btnErpImport nicht gefunden.'); return; }
    if (btn.hasAttribute('onclick')) { console.log('Entferne alten onclick Handler von #btnErpImport'); btn.removeAttribute('onclick'); }
    const newBtn = btn.cloneNode(true); btn.parentNode.replaceChild(newBtn, btn);
    newBtn.addEventListener('click', handleErpImportPreview, true); // Use Capture Phase
    console.log('Neuer ERP Preview Handler (v4.7) an #btnErpImport angehängt.');
  }

  if (document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded', hookButton, { once:true });
  } else {
    hookButton();
  }

})();
