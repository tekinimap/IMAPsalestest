// erp-preview-override.js  v4.11
// Feat: applyErpImport sendet jetzt EINE Anfrage an den neuen Worker-Endpunkt /entries/bulk-v2
//       um CPU-Limits und Rate-Limits zu umgehen.
// Behält alle Fixes aus v4.9 bei (Datum, Index-Logik etc.).

(function(){
  const hasXLSX = typeof XLSX !== 'undefined';
  const WORKER = ()=> (window.WORKER_BASE || '').replace(/\/+$/,'');
  const fmtEUR = (n)=> new Intl.NumberFormat('de-DE',{style:'currency',currency:'EUR',maximumFractionDigits:2}).format(n||0);
  const fmtEUR0 = (n)=> new Intl.NumberFormat('de-DE',{style:'currency',currency:'EUR',maximumFractionDigits:0}).format(n||0);

  const showToast   = window.showToast   || ((m,t)=>console.log('[toast]',t||'info',m));
  const showLoader  = window.showLoader  || (()=>{});
  const hideLoader  = window.hideLoader  || (()=>{});
  const fetchRetry  = window.fetchWithRetry || fetch; // fetchRetry wird für den Bulk-Call verwendet
  const loadHistory = window.loadHistory || (async()=>{ console.warn('loadHistory shim used'); });
  // throttle wird nicht mehr direkt für applyErpImport benötigt, bleibt aber als Helper
  const throttle    = window.throttle || (async(ms=80)=>{ await new Promise(r=>setTimeout(r, ms)); });

  // ---------- Helpers ----------
  function parseAmountInput(v){ /* unverändert */ if (v==null || v==='') return 0; if (typeof v === 'number' && Number.isFinite(v)) return v; if (typeof v === 'string'){ let t = v.trim().replace(/\s/g,''); if (t.includes(',') && (!t.includes('.') || /\.\d{3},\d{1,2}$/.test(t))) { t = t.replace(/\./g,'').replace(',', '.'); } else { t = t.replace(/,/g,''); } const n = Number(t); return Number.isFinite(n) ? n : 0; } return 0; }
  // *** getVal v4.10 (strenger) ***
  function getVal(row, keyName) { if (!row || typeof row !== 'object') return undefined; const normalizedKeyName = String(keyName || '').toLowerCase().replace(/[^a-z0-9]/g, ''); if (!normalizedKeyName) return undefined; const foundKey = Object.keys(row).find(k => String(k || '').toLowerCase().replace(/[^a-z0-9]/g, '') === normalizedKeyName ); return foundKey ? row[foundKey] : undefined; }
  // *** parseExcelDate v4.9 ***
  function parseExcelDate(excelDate) { if (typeof excelDate === 'number' && excelDate > 25569) { try { const jsTimestamp = (excelDate - 25569) * 86400 * 1000; const d = new Date(jsTimestamp); if (d.getFullYear() > 2000) { return new Date(d.getTime() + d.getTimezoneOffset() * 60000); } } catch (e) { console.warn("Excel date number parsing failed:", e); } } if (typeof excelDate === 'string') { const dateString = excelDate.trim(); const europeanMatch = dateString.match(/^(\d{1,2})\s*\.\s*(\d{1,2})\s*\.\s*(\d{4})$/); if (europeanMatch) { const day = parseInt(europeanMatch[1], 10); const month = parseInt(europeanMatch[2], 10); const year = parseInt(europeanMatch[3], 10); if (day >= 1 && day <= 31 && month >= 1 && month <= 12 && year > 1900) { const d = new Date(Date.UTC(year, month - 1, day)); if (d && d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day) { console.log(`[parseExcelDate v4.9] Parsed TT.MM.JJJJ: ${dateString} -> ${d.toISOString()}`); return d; } else { console.warn(`[parseExcelDate v4.9] Invalid day/month combination: ${dateString}`); } } else { console.warn(`[parseExcelDate v4.9] Invalid day/month/year range: ${dateString}`); } } const isoMatch = dateString.match(/^(\d{4})-(\d{2})-(\d{2})/); if (isoMatch) { try { const year = parseInt(isoMatch[1], 10); const month = parseInt(isoMatch[2], 10); const day = parseInt(isoMatch[3], 10); if (month >= 1 && month <= 12 && day >= 1 && day <= 31 && year > 1900) { const d = new Date(Date.UTC(year, month - 1, day)); if (d && d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day) { console.log(`[parseExcelDate v4.9] Parsed YYYY-MM-DD: ${dateString} -> ${d.toISOString()}`); return d; } } } catch(e) { console.warn(`[parseExcelDate v4.9] Error parsing YYYY-MM-DD ${dateString}:`, e); } } } console.warn(`[parseExcelDate v4.9] Could not parse date:`, excelDate); return null; }
  // *** MINIMAL: KV-Schlüssel v4.3 ***
  const normKV = (v) => { if (!v) return ''; return String(v).trim(); };
  // *** MINIMAL: Projektnummer-Schlüssel v4.3 ***
  const normProjectNumber = (v) => { if (!v) return ''; return String(v).trim(); };

  // ---------- Dialog (Preview) ----------
  function ensureDialog(){ /* unverändert */ } // Platzhalter
  function setKpis(preview){ /* unverändert */ } // Platzhalter
  function renderPreview(preview){ /* unverändert */ } // Platzhalter

  // *** NEU: applyErpImport v4.11 - Nutzt /entries/bulk-v2 ***
  async function applyErpImport(){
    const dlg = document.getElementById('erpPreviewDlg');
    const preview = window.__erpPreview;
    if (!preview) { showToast('Keine Importdaten vorhanden.', 'bad'); return; }

    const changedEntriesMap = preview._modifiedEntriesMap; // Map von Änderungen
    const finalChanges = []; // Array der zu sendenden Objekte

    // 1. Sammle alle ausgewählten Änderungen
    // Updates bestehender Einträge (die direkt in der Kopie modifiziert wurden)
    preview.updatedRows.forEach(x=>{
      if (x._keep===false) return;
      const modifiedEntry = changedEntriesMap.get(x.entry.id);
      // Füge nur hinzu, wenn noch nicht in finalChanges (sollte nicht passieren, aber sicher ist sicher)
      if (modifiedEntry && !finalChanges.some(e=> e.id === modifiedEntry.id)) {
          finalChanges.push(modifiedEntry);
      }
    });

    // Neue Abrufe (füge den modifizierten Rahmenvertrag hinzu)
    preview.newCalloffs.forEach(x=>{
      if (x._keep===false) return;
      const modifiedParent = changedEntriesMap.get(x.parentEntry.id);
       // Füge nur hinzu, wenn noch nicht in finalChanges
       if (modifiedParent && !finalChanges.some(e=> e.id === modifiedParent.id)) {
           finalChanges.push(modifiedParent);
       }
    });

    // Neue Fixaufträge
    preview.newFixes.forEach(x=>{
      if (x._keep===false) return;
      // Füge das vorbereitete newFixEntry Objekt hinzu
      finalChanges.push(x.newFixEntry);
    });

    if (finalChanges.length===0){ showToast('Nichts ausgewählt.', 'bad'); return; }

    // 2. Bereite EINE Anfrage für den Bulk-Endpunkt vor
    const bulkPayload = {
        rows: finalChanges // Das Array enthält die vollen Objekte (neu oder geändert)
    };

    console.log(`[applyErpImport] Sending ${finalChanges.length} changes to /entries/bulk-v2`); // DEBUG
    showLoader();
    if (typeof window.showBatchProgress === 'function') window.showBatchProgress('Speichere Import-Änderungen…', 1); // Nur 1 Schritt (die Bulk-Anfrage)

    try {
        const url = `${WORKER()}/entries/bulk-v2`; // Der neue Endpunkt
        const method = 'POST';

        // Sende die Bulk-Anfrage (mit Retry für Netzwerk-/Serverfehler)
        const r = await fetchRetry(url, {
            method: method,
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify(bulkPayload)
        });

        // Verarbeite die Antwort vom Worker
        const result = await r.json(); // Erwarte { ok: true/false, created, updated, skipped, errors, saved, message?, details? }

        if (!r.ok || !result.ok){
          console.error('Bulk save error response:', result);
          const errorMsg = result.message || result.error || `Server responded with status ${r.status}`;
          throw new Error(`Bulk save failed: ${errorMsg} (Details: ${result.details || 'N/A'})`);
        }

        // Erfolg
        showToast(`Import übernommen (${result.created} neu, ${result.updated} aktualisiert, ${result.skipped} übersprungen, ${result.errors} Fehler).`, 'ok');
        if (result.errors > 0) {
            showToast(`Es gab ${result.errors} Fehler beim Verarbeiten. Details siehe Worker-Logs.`, 'warn', 5000);
        }
        dlg.close();
        await loadHistory(); // Lade Daten neu

    } catch (e) {
        console.error('Fehler in applyErpImport:', e);
        showToast(`Fehler beim Übernehmen der Änderungen: ${e.message}`, 'bad');
        // Spezieller Hinweis bei Konflikt
        if (String(e.message).includes('conflict')) {
             showToast('Konflikt beim Speichern. Bitte lade die Seite neu und versuche den Import erneut.', 'bad', 7000);
        }
    } finally {
        hideLoader();
        if (typeof window.hideBatchProgress === 'function') window.hideBatchProgress();
    }
  }


  // ---------- Kernlogik (Analyse/Preview) ----------

  // *** VEREINFACHT: buildKvIndex v4.7 ***
  function buildKvIndex(entries){
    const map = new Map();
    console.log('[buildKvIndex v4.7] Starting. Processing entries:', entries?.length); // DEBUG
    (entries||[]).forEach((entry, idx)=>{ /* ... unverändert ... */ }); // Platzhalter
    console.log('[buildKvIndex v4.7] Finished. Map size:', map.size); // DEBUG
    return map;
  }
   // *** VEREINFACHT: buildFrameworkIndex v4.7 ***
  function buildFrameworkIndex(entries){
    const map = new Map();
    console.log('[buildFrameworkIndex v4.7] Starting. Processing entries:', entries?.length); // DEBUG
    (entries||[]).forEach(entry=>{ /* ... unverändert ... */ }); // Platzhalter
    console.log('[buildFrameworkIndex v4.7] Finished. Map size:', map.size); // DEBUG
    return map;
  }

  function renderAndOpen(preview){ /* unverändert */ } // Platzhalter

  // *** Hauptfunktion handleErpImportPreview (v4.9 - mit korrigiertem Datum) ***
  async function handleErpImportPreview(e){
    e?.preventDefault?.();
    e?.stopPropagation?.();

    if (!hasXLSX){ /*...*/ return; }
    const fileInput = document.getElementById('erpFile');
    if (!fileInput || fileInput.files.length===0) { /*...*/ return; }
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

      const data = await file.arrayBuffer();
      const workbook = XLSX.read(data);
      const sheetName = workbook.SheetNames[0];
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);

      const preview = { /*...*/ }; // Initialisierung

      for (const row of rows) {
        const kvRaw   = getVal(row,'KV-Nummer'); // Uses v4.10
        const pNumRaw = getVal(row,'Projekt Projektnummer'); // Uses v4.10
        const amount  = parseAmountInput(getVal(row,'Agenturleistung netto')); // Uses v4.10
        const client  = getVal(row,'Projekt Etat Kunde Name') || ''; // Uses v4.10
        const title   = getVal(row,'Titel') || ''; // Uses v4.10
        preview._excelSum += amount||0;

        let freeTS = Date.now();
        const excelDate = getVal(row,'Freigabedatum'); // Uses v4.10
        let parsedDateObject = null;
        if (excelDate) {
            parsedDateObject = parseExcelDate(excelDate); // Uses v4.9
            if (parsedDateObject) { freeTS = parsedDateObject.getTime(); }
            else { console.warn(`[handleErpImportPreview] Invalid date for KV ${kvRaw}: ${excelDate}.`); freeTS = Date.now(); }
        } else { console.warn(`[handleErpImportPreview] No date for KV ${kvRaw}.`); freeTS = Date.now(); }

        const kvNorm = normKV(kvRaw); // Minimal norm
        const pNumNorm = normProjectNumber(pNumRaw); // Minimal norm

        if (!kvNorm){ /* Skip logic */ continue; }

        const existing = kvIndex.get(kvNorm);
        let matchReason = '';

        if (existing){ /* Update/Skip logic (mit fmtEUR Korrektur) */ continue; }

        const parentFramework = pNumNorm ? frameworkIndex.get(pNumNorm) : null;
        if (parentFramework){ /* New Calloff logic */ continue; }

        // New Fix logic (mit korrekter Reason msg)
        matchReason = `KV '${kvRaw}' nicht im Index gefunden (Schlüssel: '${kvNorm}').`;
        if (pNumRaw) { matchReason += ` Rahmenvertrag '${pNumRaw}' nicht im Index gefunden (Schlüssel: '${pNumNorm}').`; }
        else { matchReason += ` Keine Projektnummer in Excel angegeben.`; }

        const newFixEntry = { id: `entry_${Date.now()}_${kvNorm.replace(/[^A-Z0-9]/g,'')}`, /*...*/ freigabedatum: freeTS /*...*/ };
        preview.newFixes.push({ /*...*/ newFixEntry, _matchReason: matchReason, _keep:true });

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
    if (!btn) { /*...*/ return; }
    if (btn.hasAttribute('onclick')) { /*...*/ btn.removeAttribute('onclick'); }
    const newBtn = btn.cloneNode(true); btn.parentNode.replaceChild(newBtn, btn);
    newBtn.addEventListener('click', handleErpImportPreview, true);
    console.log('Neuer ERP Preview Handler (v4.11) an #btnErpImport angehängt.'); // Version erhöht
  }

  if (document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded', hookButton, { once:true });
  } else {
    hookButton();
  }

  // *** Platzhalter für eingeklappte Funktionen ***
  function ensureDialog(){ if (document.getElementById('erpPreviewDlg')) return; const css = document.createElement('style'); css.textContent = ` dialog#erpPreviewDlg{border:1px solid #213044;background:#0f1724;color:#e6ebf3;border-radius:14px;min-width:1100px; max-width: 95vw; padding:16px;z-index:10000} #erpPrev .kpis{display:flex;gap:14px;flex-wrap:wrap;margin:8px 0 12px} #erpPrev .card{background:#111a2b;border:1px solid #213044;border-radius:12px;padding:10px 12px;min-width:190px} #erpPrev .label{font-size:12px;opacity:.7} #erpPrev .value{font-size:16px;font-weight:600} #erpPrev h3{margin:14px 0 6px;font-size:14px} #erpPrev table{width:100%;border-collapse:collapse} #erpPrev th,#erpPrev td{border-bottom:1px dashed #213044;padding:6px 8px;font-size:12px;text-align:left; vertical-align: top;} #erpPrev th{position:sticky;top:0;background:#0b1220;z-index:1} .mono{font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;} .btnx{background:#3b82f6;color:#fff;border:none;border-radius:10px;padding:8px 12px;cursor:pointer} .btnx:hover{filter:brightness(1.05)} .small{font-size:12px} .reason-detail { color: #94a3b8; font-size: 11px; } `; document.head.appendChild(css); const dlg = document.createElement('dialog'); dlg.id = 'erpPreviewDlg'; dlg.innerHTML = ` <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;"> <div> <h1 style="margin:0;font-size:18px;">Import-Vorschau (ERP)</h1> <div id="erpPreviewSummary" class="small" style="opacity:.8"></div> </div> <div style="display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap;"> <button class="btnx small" id="btnApplyImport">Änderungen übernehmen</button> <button class="btnx small" id="btnClosePreview">Schließen</button> </div> </div> <div id="erpPrev"> <div class="kpis"> <div class="card"><div class="label">Excel Summe</div><div class="value mono" id="kpiExcel">–</div></div> <div class="card"><div class="label">Tool Summe (aktuell)</div><div class="value mono" id="kpiTool">–</div></div> <div class="card"><div class="label">Ausgewählt (Excel)</div><div class="value mono" id="kpiSel">–</div></div> <div class="card"><div class="label">Prognose Tool nach Übernahme</div><div class="value mono" id="kpiProj">–</div></div> </div> <h3>1. Aktualisierte bestehende KVs</h3> <table><thead><tr> <th>✔</th><th>KV</th><th>Projektnr</th><th>Titel</th><th>Kunde</th><th>Alt Betrag</th><th>Neu Betrag</th><th>Δ</th> </tr></thead><tbody id="tblUpdatedRows"></tbody></table> <h3>2. Neue Abrufe in Rahmenverträgen</h3> <table><thead><tr> <th>✔</th><th>KV (Abruf)</th><th>Rahmenvertrag Projektnummer</th><th>Titel</th><th>Kunde</th><th>Wert</th> </tr></thead><tbody id="tblNewCalloffs"></tbody></table> <h3>3. Neue Fixaufträge</h3> <table><thead><tr> <th>✔</th><th>KV</th><th>Projektnummer</th><th>Titel</th><th>Kunde</th><th>Wert</th><th>Grund</th> </tr></thead><tbody id="tblNewFixes"></tbody></table> <h3>4. Übersprungen</h3> <table><thead><tr> <th>KV</th><th>Projektnummer</th><th>Titel</th><th>Kunde</th><th>Wert</th><th>Grund</th> </tr></thead><tbody id="tblSkipped"></tbody></table> </div> `; document.body.appendChild(dlg); document.getElementById('btnClosePreview').onclick = ()=> dlg.close(); document.getElementById('btnApplyImport').onclick = applyErpImport; }
  function setKpis(preview){ const excelSum = preview._excelSum || 0; const toolSum = (preview._initialEntries || []).reduce((s,e)=> s + (Number(e.amount)||0) + (Array.isArray(e.transactions)? e.transactions.reduce((a,t)=>a+(Number(t.amount)||0),0):0), 0); const selExcelUpdates = preview.updatedRows.filter(x=>x._keep!==false).reduce((s,x)=> s + (x.newAmount||0), 0); const selExcelCalloffs = preview.newCalloffs.filter(x=>x._keep!==false).reduce((s,x)=> s + (x.amount||0), 0); const selExcelFixes = preview.newFixes.filter(x=>x._keep!==false).reduce((s,x)=> s + (x.amount||0), 0); const selExcel = selExcelUpdates + selExcelCalloffs + selExcelFixes; const replacedToolAmount = preview.updatedRows.filter(x=>x._keep!==false).reduce((s,x)=> s + (x.oldAmount||0), 0); const projected = (toolSum - replacedToolAmount) + selExcel; document.getElementById('kpiExcel').textContent = fmtEUR(excelSum); document.getElementById('kpiTool').textContent = fmtEUR(toolSum); document.getElementById('kpiSel').textContent = fmtEUR(selExcel); document.getElementById('kpiProj').textContent = fmtEUR(projected); }
  function renderPreview(preview){ ensureDialog(); const f = fmtEUR; const esc = (s) => String(s||'').replace(/</g, '&lt;'); document.getElementById('erpPreviewSummary').textContent = `${preview.updatedRows.length} Updates, ${preview.newCalloffs.length} neue Abrufe, ${preview.newFixes.length} neue Fixaufträge, ${preview.skipped.length} übersprungen.`; document.getElementById('tblUpdatedRows').innerHTML = preview.updatedRows.map((row,i)=>{ const diff = (row.newAmount||0) - (row.oldAmount||0); return `<tr> <td><input type="checkbox" data-scope="upd" data-idx="${i}" ${row._keep!==false?'checked':''}></td> <td class="mono">${esc(row.kv)}</td> <td class="mono">${esc(row.projectNumber)}</td> <td>${esc(row.title)}</td> <td>${esc(row.client)}</td> <td class="mono">${f(row.oldAmount)}</td> <td class="mono">${f(row.newAmount)}</td> <td class="mono" style="color:${diff > 0 ? '#22c55e' : (diff < 0 ? '#ef4444' : '')}">${diff===0?'±0': (diff>0?'+':'')+f(diff)}</td> </tr>`; }).join(''); document.getElementById('tblNewCalloffs').innerHTML = preview.newCalloffs.map((row,i)=>` <tr> <td><input type="checkbox" data-scope="call" data-idx="${i}" ${row._keep!==false?'checked':''}></td> <td class="mono">${esc(row.kv)}</td> <td class="mono">${esc(row.parentProjectNumber)}</td> <td>${esc(row.title)}</td> <td>${esc(row.client)}</td> <td class="mono">${f(row.amount)}</td> </tr> `).join(''); document.getElementById('tblNewFixes').innerHTML = preview.newFixes.map((row,i)=>` <tr> <td><input type="checkbox" data-scope="fix" data-idx="${i}" ${row._keep!==false?'checked':''}></td> <td class="mono">${esc(row.kv)}</td> <td class="mono">${esc(row.projectNumber)}</td> <td>${esc(row.title)}</td> <td>${esc(row.client)}</td> <td class="mono">${f(row.amount)}</td> <td><span class="small">${esc(row._matchReason || 'Unbekannt')}</span></td> </tr> `).join(''); document.getElementById('tblSkipped').innerHTML = preview.skipped.map((row)=>` <tr> <td class="mono">${esc(row.kv)}</td> <td class="mono">${esc(row.projectNumber)}</td> <td>${esc(row.title)}</td> <td>${esc(row.client)}</td> <td class="mono">${f(row.amount||0)}</td> <td><strong>${esc(row.reason)}</strong> <br><span class="reason-detail">${esc(row.detail)}</span></td> </tr> `).join(''); const dlg = document.getElementById('erpPreviewDlg'); dlg.querySelectorAll('input[type="checkbox"][data-scope]').forEach(cb=>{ cb.onchange = ()=>{ const scope = cb.getAttribute('data-scope'); const idx = Number(cb.getAttribute('data-idx')); const keep = cb.checked; if (scope==='upd') preview.updatedRows[idx]._keep = keep; if (scope==='call') preview.newCalloffs[idx]._keep = keep; if (scope==='fix') preview.newFixes[idx]._keep = keep; setKpis(preview); }; }); setKpis(preview); dlg.showModal(); window.__erpPreview = preview; }
  function buildKvIndex(entries){ const map = new Map(); console.log('[buildKvIndex v4.7] Starting. Processing entries:', entries?.length); (entries||[]).forEach((entry, idx)=>{ const entryKvRaw = entry.kv_nummer || entry.kv; const key = normKV(entryKvRaw); if (key && entry.projectType !== 'rahmen') { if (!map.has(key)) { console.log(`[buildKvIndex v4.7] Adding FIX: Key='${key}' from entry ID ${entry.id}`); map.set(key, { type:'fix', entry }); } } if (entry.projectType==='rahmen' && Array.isArray(entry.transactions)) { entry.transactions.forEach(t=>{ const transKvRaw = t.kv_nummer || t.kv; const tkey = normKV(transKvRaw); if (tkey) { if (!map.has(tkey)) { console.log(`[buildKvIndex v4.7] Adding TRANSACTION: Key='${tkey}' from parent ID ${entry.id}, trans ID ${t.id}`); map.set(tkey, { type:'transaction', entry, transaction:t }); } } }); } }); console.log('[buildKvIndex v4.7] Finished. Map size:', map.size); return map; }
  function buildFrameworkIndex(entries){ const map = new Map(); console.log('[buildFrameworkIndex v4.7] Starting. Processing entries:', entries?.length); (entries||[]).forEach(entry=>{ if (entry.projectType==='rahmen' && entry.projectNumber) { const key = normProjectNumber(entry.projectNumber); if (key) { if (!map.has(key)) { console.log(`[buildFrameworkIndex v4.7] Adding FRAMEWORK: Key='${key}' from entry ID ${entry.id}`); map.set(key, entry); } } } }); console.log('[buildFrameworkIndex v4.7] Finished. Map size:', map.size); return map; }
  function renderAndOpen(preview){ hideLoader(); renderPreview(preview); }

})(); // Ende IIFE
