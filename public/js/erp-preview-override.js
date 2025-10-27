// erp-preview-override.js  v4.1
// Fix: buildKvIndex überarbeitet, um Kollisionen/Timestamps besser zu handhaben.
// Behält normKV/normProjectNumber v4.0 bei.
// Behält stopPropagation Fix bei.

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
    // Finde den Schlüssel, der den normalisierten Namen *enthält*
    const k = Object.keys(row).find(k => k.toLowerCase().replace(/[^a-z0-9]/g, '').includes(norm));
    return k ? row[k] : undefined;
  }
  function parseExcelDate(excelDate) {
    if (typeof excelDate === 'number' && excelDate > 0) return new Date((excelDate - 25569) * 86400 * 1000);
    if (typeof excelDate === 'string') {
      const d = new Date(excelDate); // Versucht Standard-Formate
      if (!isNaN(d.getTime())) return d;
      // Versuch: DD.MM.YYYY oder MM/DD/YYYY
      const m = excelDate.match(/(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})/);
      if (m) {
        let d = new Date(m[3], m[2]-1, m[1]); if(!isNaN(d.getTime())) return d; // DD.MM
        d = new Date(m[3], m[1]-1, m[2]); if(!isNaN(d.getTime())) return d; // MM/DD
      }
    }
    return null;
  }

  // *** Robuste KV-Normalisierung v4.0 ***
  const normKV = (v) => {
    if (!v) return '';
    let str = String(v).trim();
    const numbers = str.match(/\d+/g);
    if (!numbers) return str.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (numbers.length >= 2) {
      const year = numbers[0]; let num = numbers[1];
      num = String(parseInt(num, 10));
      return `${year}-${num}`;
    }
    if (numbers.length === 1) return numbers[0];
    return str.toUpperCase().replace(/[^A-Z0-9]/g, '');
  };

  // *** Robuste Projektnummer-Normalisierung v4.0 ***
  const normProjectNumber = (v) => {
    if (!v) return '';
    let str = String(v).trim();
    str = str.replace(/^(rv-|projekt\s*)/i, '');
    const match = str.match(/\d{4,}/);
    if (match) return match[0];
    str = str.replace(/\.0$/, '').trim();
    return str;
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
    const f = (n)=> fmtEUR(n||0);
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
        // *** EINZELN SENDEN *** (da Worker v6 /entries/bulk nicht für volle Objekte kann)
        if (typeof window.showBatchProgress === 'function') window.showBatchProgress('Speichere Import-Änderungen…', finalChanges.length);

        let done = 0;
        let errors = 0;
        for (const entry of finalChanges) {
          done++;
          if (typeof window.updateBatchProgress === 'function') window.updateBatchProgress(done, finalChanges.length);
          
          // ID check: Neue Einträge haben oft temporäre IDs (z.B. beginnend mit 'entry_')
          // Existierende Einträge haben IDs vom Server (beginnen NICHT mit 'entry_')
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
          await throttle(250); // Beibehalten oder anpassen
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

  // *** NEU: buildKvIndex v4.1 - Handles key collisions better ***
  function buildKvIndex(entries){
    const map = new Map();
    (entries||[]).forEach(entry=>{
      // Index Fix Orders first
      const entryKv = entry.kv_nummer || entry.kv;
      const key = normKV(entryKv);
      // Index only if it's NOT explicitly a framework contract
      if (key && entry.projectType !== 'rahmen') {
         const existing = map.get(key);
         // Use modification timestamp primarily, fallback to creation timestamp
         const entryTs = entry.modified || entry.ts || 0;
         let existingTs = 0;
         if(existing) {
            existingTs = existing.type === 'transaction' 
                ? (existing.transaction?.ts || 0) // Transaction timestamp
                : (existing.entry?.modified || existing.entry?.ts || 0); // Fix order timestamp
         }

         // Add or replace if no existing entry, or if this entry is newer than the existing one
         if (!existing || entryTs > existingTs) {
             map.set(key, { type:'fix', entry });
         }
      }
    }); // End Fix Order loop
    
    // Index Transactions, potentially overwriting Fix Orders if transaction is newer
    (entries||[]).forEach(entry=>{
       if (entry.projectType==='rahmen' && Array.isArray(entry.transactions)) {
        entry.transactions.forEach(t=>{
          const transKv = t.kv_nummer || t.kv;
          const tkey = normKV(transKv);
          if (tkey) {
             const existing = map.get(tkey);
             const transactionTs = t.ts || 0; // Transaction timestamp
             let existingTs = 0;
             if (existing) {
                 // Get timestamp regardless of type ('fix' or 'transaction')
                 existingTs = existing.type === 'transaction' 
                     ? (existing.transaction?.ts || 0)
                     : (existing.entry?.modified || existing.entry?.ts || 0);
             }
             
             // Add or replace if no existing entry, or if this transaction is newer
             // AND ensure we don't overwrite a FIX entry with an OLDER transaction
             if (!existing || transactionTs > existingTs) {
                 map.set(tkey, { type:'transaction', entry, transaction:t });
             }
          }
        });
      }
    }); // End Transaction loop
    return map;
  }


  // *** Verwendet normProjectNumber v4.0 ***
  function buildFrameworkIndex(entries){
    const map = new Map();
    (entries||[]).forEach(entry=>{
      if (entry.projectType==='rahmen' && entry.projectNumber) {
        const key = normProjectNumber(entry.projectNumber); 
        if (key) {
          if (!map.has(key) || (entry.modified || entry.ts || 0) > (map.get(key).modified || map.get(key).ts || 0)) {
            map.set(key, entry);
          }
        }
      }
    });
    return map;
  }

  function renderAndOpen(preview){
    hideLoader();
    renderPreview(preview);
  }

  // *** Hauptfunktion, jetzt mit stopPropagation ***
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
      // *** DEBUGGING: Log entries count ***
      console.log('Entries loaded in handleErpImportPreview:', window.entries?.length);

      const entriesCopy = JSON.parse(JSON.stringify(window.entries || []));
      const modifiedEntriesMap = new Map();

      // *** DEBUGGING: Log normKV function result ***
      console.log('NormKV Test (handleErpImportPreview):', normKV('KV-2025/00041')); // Sollte '2025-41' ausgeben

      const kvIndex        = buildKvIndex(entriesCopy);
      const frameworkIndex = buildFrameworkIndex(entriesCopy);

      // *** DEBUGGING: Log index sizes ***
      console.log('kvIndex size:', kvIndex.size);
      console.log('frameworkIndex size:', frameworkIndex.size);


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

        // *** DEBUGGING: Log specific KV processing (Example: KV-2025-0007) ***
        // if (kvRaw === 'KV-2025-0007') {
        //     console.log(`--- Processing ${kvRaw} ---`);
        //     console.log(`kvNorm: ${kvNorm}`);
        //     console.log(`pNumRaw: ${pNumRaw}, pNumNorm: ${pNumNorm}`);
        //     console.log(`kvIndex has ${kvNorm}?`, kvIndex.has(kvNorm));
        //     if(kvIndex.has(kvNorm)) console.log('Found in kvIndex:', kvIndex.get(kvNorm));
        //     console.log(`frameworkIndex has ${pNumNorm}?`, frameworkIndex.has(pNumNorm));
        //     if(frameworkIndex.has(pNumNorm)) console.log('Found in frameworkIndex:', frameworkIndex.get(pNumNorm));
        // }


        if (!kvNorm){
          // *** DEBUGGING: Log skip reason ***
          // if (kvRaw === 'KV-2025-0007') console.log('-> SKIPPING (no kvNorm)');
          preview.skipped.push({ kv: kvRaw, projectNumber: pNumRaw, title, client, amount, reason:'Keine KV-Nummer', detail:`Zeile ohne gültige KV (Roh: ${kvRaw}, Norm: ${kvNorm})` });
          if (window.LOGBOOK2) LOGBOOK2.importSkip({ kv: kvRaw, projectNumber: pNumRaw, title, client, source:'erp', reason:'missing_kv', detail:`Zeile ohne gültige KV-Nummer (Roh: ${kvRaw}, Norm: ${kvNorm})` });
          continue;
        }

        const existing = kvIndex.get(kvNorm);
        let matchReason = '';

        if (existing){
          // *** DEBUGGING: Log match found ***
          // if (kvRaw === 'KV-2025-0007') console.log(`-> MATCH FOUND: Type ${existing.type}`);
          
          const isTransaction = existing.type === 'transaction';
          const currentEntry = existing.entry;
          const currentItem = isTransaction ? existing.transaction : currentEntry;
          const currentAmount = Number(currentItem.amount)||0;

          if (fmtEUR0(currentAmount) !== fmtEUR0(amount)) {
            // *** DEBUGGING: Log update classification ***
            // if (kvRaw === 'KV-2025-0007') console.log(`-> Classifying as UPDATE (Amount differs: ${currentAmount} vs ${amount})`);
            currentItem.amount = amount;
            if (isTransaction && excelDate) currentItem.freigabedatum = freeTS;
            if (!isTransaction && excelDate) currentEntry.freigabedatum = freeTS;
            currentEntry.modified = Date.now();
            modifiedEntriesMap.set(currentEntry.id, currentEntry);

            preview.updatedRows.push({
              kv: kvRaw, projectNumber: pNumRaw, title: title || currentItem.title || '', client: client || currentItem.client || '',
              oldAmount: currentAmount, newAmount: amount,
              entry: currentEntry,
              _keep: true
            });
          } else {
             // *** DEBUGGING: Log skip classification ***
             // if (kvRaw === 'KV-2025-0007') console.log(`-> Classifying as SKIP (Amount same: ${currentAmount})`);
            preview.skipped.push({ kv: kvRaw, projectNumber: pNumRaw, title, client, amount, reason:'Keine Änderung', detail:`Betrag (${f(amount)}) identisch (Norm-KV: ${kvNorm}).` });
            if (window.LOGBOOK2) LOGBOOK2.importSkip({ kv: kvRaw, projectNumber: pNumRaw, title, client, source:'erp', reason:'no_change', detail:`Betrag ${f(amount)} identisch (Norm-KV: ${kvNorm})` });
          }
          continue;
        }

        const parentFramework = pNumNorm ? frameworkIndex.get(pNumNorm) : null;
        if (parentFramework){
           // *** DEBUGGING: Log new calloff classification ***
           // if (kvRaw === 'KV-2025-0007') console.log('-> Classifying as NEW CALLOFF');
          parentFramework.transactions = Array.isArray(parentFramework.transactions) ? parentFramework.transactions : [];
          const existsTrans = parentFramework.transactions.some(t => normKV(t.kv_nummer || t.kv) === kvNorm);
          if (!existsTrans){
            const newTrans = { id:`trans_${Date.now()}_${kvNorm}`, kv_nummer: kvRaw, type:'founder', amount, ts:Date.now(), freigabedatum: freeTS };
            parentFramework.transactions.push(newTrans);
            parentFramework.modified = Date.now();
            modifiedEntriesMap.set(parentFramework.id, parentFramework);
            preview.newCalloffs.push({ kv: kvRaw, parentProjectNumber: pNumRaw, title, client, amount, parentEntry: parentFramework, _keep:true });
          } else {
            // *** DEBUGGING: Log duplicate calloff skip ***
            // if (kvRaw === 'KV-2025-0007') console.log('-> Classifying as SKIP (Duplicate Calloff?)');
            preview.skipped.push({ kv: kvRaw, projectNumber: pNumRaw, title, client, amount, reason:'Abruf doppelt?', detail:`KV ${kvNorm} bereits in Rahmenvertrag ${pNumNorm}, aber Index hat nicht gematcht?` });
            if (window.LOGBOOK2) LOGBOOK2.importSkip({ kv: kvRaw, projectNumber: pNumRaw, title, client, source:'erp', reason:'duplicate_calloff', detail:'KV bereits in transactions[] gefunden' });
          }
          continue;
        }

        // *** DEBUGGING: Log new fix classification ***
        // if (kvRaw === 'KV-2025-0007') console.log('-> Classifying as NEW FIX ORDER');
        matchReason = `KV '${kvNorm}' nicht gefunden.`;
        if (pNumNorm) { matchReason += ` Rahmenvertrag '${pNumNorm}' nicht gefunden.`; }
        else { matchReason += ` Keine Projektnummer (Roh: ${pNumRaw}).`; }

        const newFixEntry = {
          id: `entry_${Date.now()}_${kvNorm.replace(/[^a-zA-Z0-9]/g,'')}`, // Sicherere ID Generierung
          source: 'erp-import', projectType: 'fix',
          client, title, projectNumber: pNumRaw, kv_nummer: kvRaw, amount,
          list: [], rows: [], weights: [],
          ts: Date.now(), freigabedatum: freeTS, complete: false
        };
        preview.newFixes.push({ kv: kvRaw, projectNumber: pNumRaw, title, client, amount, newFixEntry, _matchReason: matchReason, _keep:true });
        
        // *** DEBUGGING: End specific KV processing ***
        // if (kvRaw === 'KV-2025-0007') console.log(`--- Finished ${kvRaw} ---`);

      } // Ende for-Schleife

      renderAndOpen(preview);

    } catch(e){
      hideLoader();
      console.error('Fehler bei der ERP-Import-Vorschau:', e);
      showToast(`Fehler beim Analysieren der Datei: ${e.message}`, 'bad');
    }
  }

  // ---------- Button hook (v4.0 - mit stopPropagation) ----------
  function hookButton(){
    const btn = document.getElementById('btnErpImport');
    if (!btn) { console.warn('ERP Import Button #btnErpImport nicht gefunden.'); return; }
    if (btn.hasAttribute('onclick')) { console.log('Entferne alten onclick Handler von #btnErpImport'); btn.removeAttribute('onclick'); }
    const newBtn = btn.cloneNode(true); btn.parentNode.replaceChild(newBtn, btn);
    newBtn.addEventListener('click', handleErpImportPreview, true); // Use Capture Phase
    console.log('Neuer ERP Preview Handler (v4.1) an #btnErpImport angehängt.');
  }


  if (document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded', hookButton, { once:true });
  } else {
    hookButton();
  }

})();
