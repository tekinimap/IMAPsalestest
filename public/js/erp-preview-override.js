// erp-preview-override.js  v4.5
// Fix: ReferenceError: f is not defined in handleErpImportPreview behoben (fmtEUR verwenden).
// Behält alle Fixes aus v4.4 bei.

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
  function parseExcelDate(excelDate) {
    if (typeof excelDate === 'number' && excelDate > 0) return new Date((excelDate - 25569) * 86400 * 1000);
    if (typeof excelDate === 'string') {
      const d = new Date(excelDate);
      if (!isNaN(d.getTime())) return d;
      const m = excelDate.match(/(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})/);
      if (m) {
        let d = new Date(m[3], m[2]-1, m[1]); if(!isNaN(d.getTime())) return d;
        d = new Date(m[3], m[1]-1, m[2]); if(!isNaN(d.getTime())) return d;
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
    const f = fmtEUR; // Definiere f hier lokal für renderPreview
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

  // *** VEREINFACHT: buildKvIndex v4.4 ***
  function buildKvIndex(entries){
    const map = new Map();
    console.log('[buildKvIndex] Starting. Processing entries:', entries?.length);
    (entries||[]).forEach((entry, idx)=>{
      // Fixaufträge
      const entryKvRaw = entry.kv_nummer || entry.kv;
      const key = normKV(entryKvRaw);
      if (key && entry.projectType !== 'rahmen') {
         if (!map.has(key)) {
             console.log(`[buildKvIndex] Adding FIX: Key='${key}' from entry ID ${entry.id}`);
             map.set(key, { type:'fix', entry });
         } else {
             console.warn(`[buildKvIndex] FIX Key collision ignored: Key='${key}', Existing type=${map.get(key).type}, New entry ID ${entry.id}`);
         }
      }
      // Transaktionen
      if (entry.projectType==='rahmen' && Array.isArray(entry.transactions)) {
        entry.transactions.forEach(t=>{
          const transKvRaw = t.kv_nummer || t.kv;
          const tkey = normKV(transKvRaw);
          if (tkey) {
             if (!map.has(tkey)) {
                 console.log(`[buildKvIndex] Adding TRANSACTION: Key='${tkey}' from parent ID ${entry.id}, trans ID ${t.id}`);
                 map.set(tkey, { type:'transaction', entry, transaction:t });
             } else {
                 console.warn(`[buildKvIndex] TRANSACTION Key collision ignored: Key='${tkey}', Existing type=${map.get(tkey).type}, New parent ID ${entry.id}, trans ID ${t.id}`);
             }
          }
        });
      }
    });
    console.log('[buildKvIndex] Finished. Map size:', map.size);
    return map;
  }

  // *** VEREINFACHT: buildFrameworkIndex v4.4 ***
  function buildFrameworkIndex(entries){
    const map = new Map();
    console.log('[buildFrameworkIndex] Starting. Processing entries:', entries?.length);
    (entries||[]).forEach(entry=>{
      if (entry.projectType==='rahmen' && entry.projectNumber) {
        const key = normProjectNumber(entry.projectNumber);
        if (key) {
          if (!map.has(key)) {
            console.log(`[buildFrameworkIndex] Adding FRAMEWORK: Key='${key}' from entry ID ${entry.id}`);
            map.set(key, entry);
          } else {
             console.warn(`[buildFrameworkIndex] FRAMEWORK Key collision ignored: Key='${key}', Existing ID ${map.get(key).id}, New entry ID ${entry.id}`);
          }
        }
      }
    });
    console.log('[buildFrameworkIndex] Finished. Map size:', map.size);
    return map;
  }

  function renderAndOpen(preview){
    hideLoader();
    renderPreview(preview);
  }

  // *** Hauptfunktion, mit stopPropagation ***
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
      const kvIndex        = buildKvIndex(entriesCopy); // Uses v4.4
      const frameworkIndex = buildFrameworkIndex(entriesCopy); // Uses v4.4

      console.log('kvIndex size after build:', kvIndex.size);
      console.log('frameworkIndex size after build:', frameworkIndex.size);

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
            if (isTransaction && excelDate) currentItem.freigabedatum = freeTS;
            if (!isTransaction && excelDate) currentEntry.freigabedatum = freeTS;
            currentEntry.modified = Date.now();
            modifiedEntriesMap.set(currentEntry.id, currentEntry);

            preview.updatedRows.push({
              kv: kvRaw, projectNumber: pNumRaw, title: title || currentItem.title || '', client: client || currentItem.client || '',
              oldAmount: currentAmount, newAmount: amount,
              entry: currentEntry, _keep: true
            });
          } else {
             // *** KORRIGIERT: f -> fmtEUR ***
            preview.skipped.push({ kv: kvRaw, projectNumber: pNumRaw, title, client, amount, reason:'Keine Änderung', detail:`Betrag (${fmtEUR(amount)}) identisch (Schlüssel: ${kvNorm}).` });
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
          id: `entry_${Date.now()}_${kvNorm.replace(/[^A-Z0-9]/g,'')}`, // Sicherere ID
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
    console.log('Neuer ERP Preview Handler (v4.5) an #btnErpImport angehängt.');
  }

  if (document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded', hookButton, { once:true });
  } else {
    hookButton();
  }

})();
