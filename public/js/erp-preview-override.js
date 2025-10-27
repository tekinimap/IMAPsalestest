// public/js/erp-preview-override.js
// Fügt ERP-Import-Vorschau hinzu und verhindert Direkt-Speichern.
// Nutzt bestehende Hilfsfunktionen aus deiner index.html, sofern vorhanden.

(function(){
  const hasXLSX = typeof XLSX !== 'undefined';
  const WORKER = ()=> (window.WORKER_BASE || '').replace(/\/+$/,'');
  const fmtEUR = (n)=> new Intl.NumberFormat('de-DE',{style:'currency',currency:'EUR',maximumFractionDigits:2}).format(n||0);

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

  // Fallbacks auf deine vorhandenen Funktionen
  const showToast = window.showToast || ((m,t)=>console.log('[toast]',t||'info',m));
  const showLoader = window.showLoader || (()=>{});
  const hideLoader = window.hideLoader || (()=>{});
  const fetchWithRetry = window.fetchWithRetry || fetch;
  const loadHistory = window.loadHistory || (async()=>{});
  const throttle = window.throttle || (async()=>{ await new Promise(r=>setTimeout(r, 120)); });

  function getVal(row, keyName) {
    const normalizedKeyName = keyName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const keys = Object.keys(row);
    const foundKey = keys.find(k => k.toLowerCase().replace(/[^a-z0-9]/g, '').includes(normalizedKeyName));
    return foundKey ? row[foundKey] : undefined;
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

  // Dialog + Styles injizieren (kein Edit an index.html nötig)
  function ensureDialog(){
    if (document.getElementById('erpPreviewDlg')) return;
    const css = document.createElement('style');
    css.textContent = `
      dialog#erpPreviewDlg{border:1px solid #213044;background:#0f1724;color:#e6ebf3;border-radius:14px;min-width:1100px;padding:16px;z-index:10000}
      #erpPrev .kpis{display:flex;gap:14px;flex-wrap:wrap;margin:8px 0 12px}
      #erpPrev .card{background:#111a2b;border:1px solid #213044;border-radius:12px;padding:10px 12px;min-width:190px}
      #erpPrev .label{font-size:12px;opacity:.7}
      #erpPrev .value{font-size:16px;font-weight:600}
      #erpPrev h3{margin:14px 0 6px;font-size:14px}
      #erpPrev table{width:100%;border-collapse:collapse}
      #erpPrev th,#erpPrev td{border-bottom:1px dashed #213044;padding:6px 8px;font-size:12px;text-align:left}
      #erpPrev th{position:sticky;top:0;background:#0b1220;z-index:1}
      .mono{font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;}
      .btnx{background:#3b82f6;color:#fff;border:none;border-radius:10px;padding:8px 12px;cursor:pointer}
      .btnx:hover{filter:brightness(1.05)}
      .small{font-size:12px}
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
          <th>✔</th><th>KV</th><th>Projektnummer</th><th>Titel</th><th>Kunde</th><th>Wert</th>
        </tr></thead><tbody id="tblNewFixes"></tbody></table>

        <h3>4. Übersprungen</h3>
        <table><thead><tr>
          <th>KV</th><th>Projektnummer</th><th>Titel</th><th>Kunde</th><th>Wert</th><th>Grund</th>
        </tr></thead><tbody id="tblSkipped"></tbody></table>
      </div>
    `;
    document.body.appendChild(dlg);

    document.getElementById('btnClosePreview').onclick = ()=> dlg.close();
    document.getElementById('btnApplyImport').onclick = applyErpImport;
  }

  function setKpis(preview){
    const excelSum = preview._excelSum || 0;
    const toolSum  = Array.isArray(window.entries) ? window.entries.reduce((s,e)=> s + (Number(e.amount)||0) + (Array.isArray(e.transactions)? e.transactions.reduce((a,t)=>a+(Number(t.amount)||0),0):0), 0) : 0;
    const selExcel = (
      preview.updatedRows.filter(x=>x._keep!==false).reduce((s,x)=> s + (x.newAmount||0), 0) +
      preview.newCalloffs.filter(x=>x._keep!==false).reduce((s,x)=> s + (x.amount||0), 0) +
      preview.newFixes.filter(x=>x._keep!==false).reduce((s,x)=> s + (x.amount||0), 0)
    );
    const selTool = preview.updatedRows.filter(x=>x._keep!==false).reduce((s,x)=> s + (x.oldAmount||0), 0);
    const projected = (toolSum - selTool) + selExcel;

    document.getElementById('kpiExcel').textContent = fmtEUR(excelSum);
    document.getElementById('kpiTool').textContent  = fmtEUR(toolSum);
    document.getElementById('kpiSel').textContent   = fmtEUR(selExcel);
    document.getElementById('kpiProj').textContent  = fmtEUR(projected);
  }

  function renderPreview(preview){
    ensureDialog();

    const f = (n)=> fmtEUR(n||0);

    document.getElementById('erpPreviewSummary').textContent =
      `${preview.updatedRows.length} bestehende angepasst, ${preview.newCalloffs.length} neue Abrufe, ${preview.newFixes.length} neue Fixaufträge, ${preview.skipped.length} übersprungen.`;

    document.getElementById('tblUpdatedRows').innerHTML = preview.updatedRows.map((row,i)=>{
      const diff = (row.newAmount||0) - (row.oldAmount||0);
      return `<tr>
        <td><input type="checkbox" data-scope="upd" data-idx="${i}" ${row._keep!==false?'checked':''}></td>
        <td class="mono">${row.kv||''}</td>
        <td class="mono">${row.projectNumber||''}</td>
        <td>${(row.title||'').replace(/</g,'&lt;')}</td>
        <td>${(row.client||'').replace(/</g,'&lt;')}</td>
        <td class="mono">${f(row.oldAmount)}</td>
        <td class="mono">${f(row.newAmount)}</td>
        <td class="mono">${diff===0?'±0 €': (diff>0?'+':'')+f(Math.abs(diff))}</td>
      </tr>`;
    }).join('');

    document.getElementById('tblNewCalloffs').innerHTML = preview.newCalloffs.map((row,i)=>`
      <tr>
        <td><input type="checkbox" data-scope="call" data-idx="${i}" ${row._keep!==false?'checked':''}></td>
        <td class="mono">${row.kv||''}</td>
        <td class="mono">${row.parentProjectNumber||''}</td>
        <td>${(row.title||'').replace(/</g,'&lt;')}</td>
        <td>${(row.client||'').replace(/</g,'&lt;')}</td>
        <td class="mono">${f(row.amount)}</td>
      </tr>
    `).join('');

    document.getElementById('tblNewFixes').innerHTML = preview.newFixes.map((row,i)=>`
      <tr>
        <td><input type="checkbox" data-scope="fix" data-idx="${i}" ${row._keep!==false?'checked':''}></td>
        <td class="mono">${row.kv||''}</td>
        <td class="mono">${row.projectNumber||''}</td>
        <td>${(row.title||'').replace(/</g,'&lt;')}</td>
        <td>${(row.client||'').replace(/</g,'&lt;')}</td>
        <td class="mono">${f(row.amount)}</td>
      </tr>
    `).join('');

    document.getElementById('tblSkipped').innerHTML = preview.skipped.map((row)=>`
      <tr>
        <td class="mono">${row.kv||''}</td>
        <td class="mono">${row.projectNumber||''}</td>
        <td>${(row.title||'').replace(/</g,'&lt;')}</td>
        <td>${(row.client||'').replace(/</g,'&lt;')}</td>
        <td class="mono">${f(row.amount||0)}</td>
        <td><strong>${row.reason||''}</strong> – ${row.detail||''}</td>
      </tr>
    `).join('');

    // Checkbox-Events
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
    window.__erpPreview = preview; // expose for apply
  }

  async function applyErpImport(){
    const dlg = document.getElementById('erpPreviewDlg');
    const preview = window.__erpPreview;
    if (!preview) { showToast('Keine Importdaten vorhanden.', 'bad'); return; }

    // Finale Liste: nur ausgewählte Änderungen
    const finalChanges = [];
    preview.updatedRows.forEach(x=>{ if (x._keep!==false) if(!finalChanges.some(e=>e.id===x.entry.id)) finalChanges.push(x.entry); });
    preview.newCalloffs.forEach(x=>{ if (x._keep!==false) if(!finalChanges.some(e=>e.id===x.parentEntry.id)) finalChanges.push(x.parentEntry); });
    preview.newFixes.forEach(x=>{ if (x._keep!==false) finalChanges.push(x.newFixEntry); });

    if (finalChanges.length===0){ showToast('Nichts ausgewählt.', 'bad'); return; }

    if (typeof window.showBatchProgress === 'function') window.showBatchProgress('Speichere Import-Änderungen…', finalChanges.length);

    let done = 0;
    for (const entry of finalChanges) {
      done++;
      if (typeof window.updateBatchProgress === 'function') window.updateBatchProgress(done, finalChanges.length);

      const exists = Array.isArray(window.entries) && window.entries.some(e => String(e.id)===String(entry.id));
      const url = exists ? `${WORKER()}/entries/${encodeURIComponent(entry.id)}` : `${WORKER()}/entries`;
      const method = exists ? 'PUT' : 'POST';

      const r = await fetchWithRetry(url, { method, headers:{'Content-Type':'application/json'}, body: JSON.stringify(entry) });
      if (!r.ok){
        console.error(await r.text());
        showToast(`Fehler beim Speichern von ${entry.kv_nummer||entry.id}`, 'bad');
      }
      await throttle();
    }

    dlg.close();
    if (typeof window.hideBatchProgress === 'function') window.hideBatchProgress();
    showToast('Import übernommen.', 'ok');
    await loadHistory();
  }

  async function handleErpImportPreview(e){
    e?.preventDefault?.();
    if (!hasXLSX){ showToast('SheetJS (XLSX) nicht geladen.', 'bad'); return; }

    const fileInput = document.getElementById('erpFile');
    if (!fileInput || fileInput.files.length===0) { showToast('Bitte eine ERP-Excel-Datei auswählen.', 'bad'); return; }
    const file = fileInput.files[0];

    showLoader();
    try {
      await loadHistory(); // entries aktualisieren
      const data = await file.arrayBuffer();
      const workbook = XLSX.read(data);
      const sheetName = workbook.SheetNames[0];
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);

      // Kopie von entries für Indexe
      const allEntriesCopy = JSON.parse(JSON.stringify(window.entries || []));
      const kvIndex = new Map();
      allEntriesCopy.forEach(entry=>{
        if (entry.kv_nummer) kvIndex.set(entry.kv_nummer, { type:'fix', entry });
        if (entry.projectType==='rahmen' && Array.isArray(entry.transactions)) {
          entry.transactions.forEach(t=>{ if (t.kv_nummer) kvIndex.set(t.kv_nummer, { type:'transaction', entry, transaction:t }); });
        }
      });
      const frameworkProjectIndex = new Map();
      allEntriesCopy.forEach(entry=>{
        if (entry.projectType==='rahmen' && entry.projectNumber) frameworkProjectIndex.set(entry.projectNumber, entry);
      });

      const preview = { updatedRows:[], newCalloffs:[], newFixes:[], skipped:[], _excelSum:0 };

      for (const row of rows) {
        const kvNummer = String(getVal(row,'KV-Nummer')||'').trim();
        const projektNummer = String(getVal(row,'Projekt Projektnummer')||'').trim();
        const amount = parseAmountInput(getVal(row,'Agenturleistung netto'));
        const clientName = getVal(row,'Projekt Etat Kunde Name') || '';
        const title = getVal(row,'Titel') || '';
        preview._excelSum += amount||0;

        let freigabeTimestamp = Date.now();
        const excelDate = getVal(row,'Freigabedatum');
        if (excelDate) { const d = parseExcelDate(excelDate); if (d) freigabeTimestamp = d.getTime(); }

        if (!kvNummer){
          preview.skipped.push({ kv:'', projectNumber: projektNummer, title, client: clientName, amount, reason:'Keine KV-Nummer', detail:'Zeile ohne KV' });
          if (window.LOGBOOK2) LOGBOOK2.importSkip({ kv:'', projectNumber: projektNummer, title, client: clientName, source:'erp', reason:'Keine KV-Nummer', detail:'Zeile ohne KV-Nummer im ERP-Import' });
          continue;
        }

        const existing = kvIndex.get(kvNummer);
        if (existing){
          const currentAmount = (existing.type==='transaction') ? (Number(existing.transaction.amount)||0) : (Number(existing.entry.amount)||0);
          if (Math.abs(currentAmount - amount) > 0.001) {
            if (existing.type==='transaction'){
              existing.transaction.amount = amount;
            } else {
              existing.entry.amount = amount;
            }
            existing.entry.modified = Date.now();

            preview.updatedRows.push({
              kv: kvNummer,
              projectNumber: projektNummer,
              title, client: clientName,
              oldAmount: currentAmount,
              newAmount: amount,
              entry: existing.entry,
              _keep: true
            });
          } else {
            preview.skipped.push({ kv: kvNummer, projectNumber: projektNummer, title, client: clientName, amount, reason:'Keine Änderung', detail:'Betrag identisch' });
            if (window.LOGBOOK2) LOGBOOK2.importSkip({ kv: kvNummer, projectNumber: projektNummer, title, client: clientName, source:'erp', reason:'Keine Änderung', detail:'Betrag identisch, nicht übernommen' });
          }
        } else {
          // Neuer Abruf in RV?
          const parentFramework = frameworkProjectIndex.get(projektNummer);
          if (parentFramework){
            parentFramework.transactions = Array.isArray(parentFramework.transactions) ? parentFramework.transactions : [];
            if (!parentFramework.transactions.some(t=> t.kv_nummer===kvNummer)){
              const newTrans = { id:`trans_${Date.now()}_${kvNummer.replace(/\W/g,'')}`, kv_nummer: kvNummer, type:'founder', amount, ts:Date.now(), freigabedatum: freigabeTimestamp };
              parentFramework.transactions.push(newTrans);
              parentFramework.modified = Date.now();
              preview.newCalloffs.push({
                kv: kvNummer, parentProjectNumber: projektNummer,
                title, client: clientName, amount,
                parentEntry: parentFramework,
                _keep: true
              });
            } else {
              preview.skipped.push({ kv: kvNummer, projectNumber: projektNummer, title, client: clientName, amount, reason:'Abruf schon vorhanden', detail:'Bereits in Rahmenvertrag' });
              if (window.LOGBOOK2) LOGBOOK2.importSkip({ kv: kvNummer, projectNumber: projektNummer, title, client: clientName, source:'erp', reason:'Abruf schon vorhanden', detail:'Bereits in transactions[]' });
            }
          } else {
            // Neuer Fixauftrag
            const newFixEntry = {
              id: `entry_${Date.now()}_${kvNummer.replace(/\W/g,'')}`,
              source: 'erp-import',
              projectType: 'fix',
              client: clientName,
              title,
              projectNumber: projektNummer,
              kv_nummer: kvNummer,
              amount,
              list: [], rows: [], weights: [],
              ts: Date.now(), freigabedatum: freigabeTimestamp,
              complete: false
            };
            preview.newFixes.push({
              kv: kvNummer, projectNumber: projektNummer, title, client: clientName, amount, newFixEntry, _keep: true
            });
          }
        }
      }

      hideLoader();
      renderPreview(preview);

    } catch(e){
      hideLoader();
      console.error(e);
      showToast('Fehler beim Analysieren der Datei.', 'bad');
    }
  }

  // Button-Click des vorhandenen Imports abfangen (Capture-Phase)
  function hookButton(){
    const btn = document.getElementById('btnErpImport');
    if (!btn) return;
    // Capture-Listener verhindert, dass der alte Listener feuert:
    btn.addEventListener('click', handleErpImportPreview, true);
  }

  if (document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded', hookButton, { once:true });
  } else {
    hookButton();
  }
})();
