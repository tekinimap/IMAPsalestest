// erp-preview-override.js  v3.0
// Fix: KV-Matching robuster (kv_nummer & kv, Normalisierung), korrekte Skip/Update-Erkennung.
// Fix: Projektnummer-Matching für Rahmenverträge robuster.
// Feature: Grund für "Neuer Fixauftrag" in Vorschau hinzugefügt.

(function(){
  const hasXLSX = typeof XLSX !== 'undefined';
  const WORKER = ()=> (window.WORKER_BASE || '').replace(/\/+$/,'');
  const fmtEUR = (n)=> new Intl.NumberFormat('de-DE',{style:'currency',currency:'EUR',maximumFractionDigits:2}).format(n||0);
  const fmtEUR0 = (n)=> new Intl.NumberFormat('de-DE',{style:'currency',currency:'EUR',maximumFractionDigits:0}).format(n||0); // Für Vergleiche ohne Cent

  const showToast   = window.showToast   || ((m,t)=>console.log('[toast]',t||'info',m));
  const showLoader  = window.showLoader  || (()=>{});
  const hideLoader  = window.hideLoader  || (()=>{});
  const fetchRetry  = window.fetchWithRetry || fetch;
  const loadHistory = window.loadHistory || (async()=>{ console.warn('loadHistory shim used'); }); // Warnung, falls Original fehlt
  const throttle    = window.throttle || (async(ms=80)=>{ await new Promise(r=>setTimeout(r, ms)); }); // Standard-Throttle hinzugefügt

  // ---------- Helpers ----------
  function parseAmountInput(v){
    if (v==null || v==='') return 0;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string'){
      let t = v.trim().replace(/\s/g,'');
      // Deutsches Format: 1.234,56 -> 1234.56
      if (t.includes(',') && (!t.includes('.') || /\.\d{3},\d{1,2}$/.test(t))) {
        t = t.replace(/\./g,'').replace(',', '.');
      } else {
        // Englisches Format: 1,234.56 -> 1234.56 (oder keine Tausendertrenner)
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

  // *** NEU: Robuste KV-Normalisierung ***
  const normKV = (v) => {
    if (!v) return '';
    let str = String(v).trim();
    str = str.replace(/^(kv-|kv\s+)/i, '');
    str = str.replace(/[^a-zA-Z0-9]/g, '');
    const match = str.match(/^(\d{4})(0+)(.*)$/);
    if (match) {
      str = match[1] + match[3];
    }
    return str.toUpperCase();
  };

  // *** NEU: Robuste Projektnummer-Normalisierung ***
  const normProjectNumber = (v) => {
    if (!v) return '';
    let str = String(v).trim();
    str = str.replace(/\.0$/, ''); // Entferne .0 am Ende
    str = str.replace(/^rv-/i, ''); // Entferne RV- am Anfang
    return str; // Behalte Groß/Kleinschreibung bei, falls relevant
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
          <th>✔</th><th>KV</th><th>Projektnummer</th><th>Titel</th><th>Kunde</th><th>Wert</th><th>Grund</th> {/* NEU: Spalte Grund */}
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
    // Berechne Tool-Summe aus der *Kopie* der Einträge, die die Vorschau verwendet hat
    const toolSum = (preview._initialEntries || []).reduce((s,e)=> s + (Number(e.amount)||0) + (Array.isArray(e.transactions)? e.transactions.reduce((a,t)=>a+(Number(t.amount)||0),0):0), 0);

    const selExcelUpdates = preview.updatedRows.filter(x=>x._keep!==false).reduce((s,x)=> s + (x.newAmount||0), 0);
    const selExcelCalloffs = preview.newCalloffs.filter(x=>x._keep!==false).reduce((s,x)=> s + (x.amount||0), 0);
    const selExcelFixes = preview.newFixes.filter(x=>x._keep!==false).reduce((s,x)=> s + (x.amount||0), 0);
    const selExcel = selExcelUpdates + selExcelCalloffs + selExcelFixes;

    // Nur der Teil der Tool-Summe, der durch ausgewählte Updates *ersetzt* wird
    const replacedToolAmount = preview.updatedRows.filter(x=>x._keep!==false).reduce((s,x)=> s + (x.oldAmount||0), 0);
    // Prognose: Alte Summe - Ersetzter Teil + Hinzugefügter Teil (Updates+Neue)
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

    // *** NEU: Grund anzeigen ***
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
    window.__erpPreview = preview; // expose
  }

  async function applyErpImport(){
    const dlg = document.getElementById('erpPreviewDlg');
    const preview = window.__erpPreview;
    if (!preview) { showToast('Keine Importdaten vorhanden.', 'bad'); return; }

    // Verwende die *Kopie* der Einträge, die während der Vorschau modifiziert wurde
    const changedEntries = preview._modifiedEntriesMap;
    const finalChanges = [];

    // Updates (bestehende) -> Eintrag wurde in der Kopie direkt modifiziert
    preview.updatedRows.forEach(x=>{
      if (x._keep===false) return;
      const modifiedEntry = changedEntries.get(x.entry.id);
      if (modifiedEntry && !finalChanges.some(e=> e.id === modifiedEntry.id)) {
          finalChanges.push(modifiedEntry);
      }
    });

    // Abrufe -> Parent wurde in der Kopie modifiziert
    preview.newCalloffs.forEach(x=>{
      if (x._keep===false) return;
      const modifiedParent = changedEntries.get(x.parentEntry.id);
       if (modifiedParent && !finalChanges.some(e=> e.id === modifiedParent.id)) {
           finalChanges.push(modifiedParent);
       }
    });

    // Neue Fixaufträge
    preview.newFixes.forEach(x=>{
      if (x._keep===false) return;
      // Hier keine weitere Prüfung nötig, da die Vorschau-Logik bereits geprüft hat
      finalChanges.push(x.newFixEntry);
    });

    if (finalChanges.length===0){ showToast('Nichts ausgewählt.', 'bad'); return; }

    showLoader(); // Zeige Loader während des Speicherns

    // *** Wichtig: Verwende /entries/bulk für Batch-Updates/-Creates ***
    const bulkPayload = { rows: [] };
    for (const entry of finalChanges) {
        // Für Bulk-Upsert nur KV, Amount und Metadaten schicken, wenn es KEIN full object ist
        // Wenn es ein full object ist (z.B. ein Rahmenvertrag mit neuen Abrufen), schicke das ganze Objekt
        if (isFullEntry(entry)) {
            bulkPayload.rows.push(entry); // Schicke das volle Objekt
        } else {
            // Schicke nur die relevanten Felder für ein einfaches Upsert
            bulkPayload.rows.push({
                kv: entry.kv_nummer || entry.kv,
                amount: entry.amount,
                projectNumber: entry.projectNumber,
                title: entry.title,
                client: entry.client,
                source: entry.source || 'erp', // Stelle sicher, dass Source gesetzt ist
                // Wichtig: ID nur mitschicken, wenn sie existiert, sonst wird es als Create behandelt
                id: entry.id.startsWith('entry_') ? entry.id : undefined
            });
        }
    }

    try {
        const url = `${WORKER()}/entries/bulk`;
        const method = 'POST';
        const r = await fetchRetry(url, { method, headers:{'Content-Type':'application/json'}, body: JSON.stringify(bulkPayload) });
        if (!r.ok){
          const errText = await r.text();
          console.error('Bulk save error:', errText);
          throw new Error(`Bulk save failed: ${errText}`);
        }
        const result = await r.json();
        showToast(`Import übernommen (${result.created} neu, ${result.updated} aktualisiert, ${result.skipped} überspr., ${result.errors} Fehler).`, 'ok');
        dlg.close();
        await loadHistory(); // Lade Daten neu nach erfolgreichem Import

    } catch (e) {
        console.error(e);
        showToast(`Fehler beim Übernehmen der Änderungen: ${e.message}`, 'bad');
    } finally {
        hideLoader(); // Verstecke Loader immer
        if (typeof window.hideBatchProgress === 'function') window.hideBatchProgress(); // Alte Batch-Anzeige verstecken, falls vorhanden
    }
  }


  // ---------- Kernlogik (Analyse/Preview) ----------

  // *** NEU: Verwendet normKV ***
  function buildKvIndex(entries){
    const map = new Map();
    (entries||[]).forEach(entry=>{
      // KV auf Eintragsebene (Fixauftrag)
      // Wichtig: Prüfe beide Felder kv und kv_nummer
      const entryKv = entry.kv_nummer || entry.kv;
      const key = normKV(entryKv);
      if (key && entry.projectType !== 'rahmen') { // Nur Fixaufträge hier indexieren
         // Falls Key schon existiert (Duplikat?), bevorzuge den aktuelleren Eintrag
         if (!map.has(key) || (entry.modified || entry.ts || 0) > (map.get(key).entry.modified || map.get(key).entry.ts || 0)) {
             map.set(key, { type:'fix', entry });
         }
      }

      // KV in Abrufen (transactions) von Rahmenverträgen
      if (entry.projectType==='rahmen' && Array.isArray(entry.transactions)) {
        entry.transactions.forEach(t=>{
          const transKv = t.kv_nummer || t.kv;
          const tkey = normKV(transKv);
          if (tkey) {
             // Falls Key schon existiert, bevorzuge den aktuelleren Abruf
             if (!map.has(tkey) || (t.ts || 0) > (map.get(tkey).transaction?.ts || 0)) {
                 map.set(tkey, { type:'transaction', entry, transaction:t });
             }
          }
        });
      }
    });
    return map;
  }

  // *** NEU: Verwendet normProjectNumber ***
  function buildFrameworkIndex(entries){
    const map = new Map();
    (entries||[]).forEach(entry=>{
      if (entry.projectType==='rahmen' && entry.projectNumber) {
        const key = normProjectNumber(entry.projectNumber); // Normalisierte Nummer als Key
        if (key) {
          // Falls Key schon existiert, bevorzuge den aktuelleren Eintrag
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

  // *** Hauptfunktion, jetzt mit robusterem Matching und Reason-Tracking ***
  async function handleErpImportPreview(e){
    e?.preventDefault?.(); // Verhindert Standardverhalten des Buttons
    e?.stopPropagation?.(); // Verhindert, dass andere Listener auf dem Button feuern

    if (!hasXLSX){ showToast('SheetJS (XLSX) nicht geladen.', 'bad'); return; }

    const fileInput = document.getElementById('erpFile');
    if (!fileInput || fileInput.files.length===0) { showToast('Bitte eine ERP-Excel-Datei auswählen.', 'bad'); return; }
    const file = fileInput.files[0];

    showLoader();
    try {
      // *** Wichtig: Lade IMMER die aktuellen Einträge direkt vom Worker ***
      await loadHistory();

      // Tiefe Kopie für die Simulation von Änderungen erstellen
      const entriesCopy = JSON.parse(JSON.stringify(window.entries || []));
      const modifiedEntriesMap = new Map(); // Trackt modifizierte Einträge für applyErpImport

      // Indizes aus der Kopie erstellen
      const kvIndex        = buildKvIndex(entriesCopy);
      const frameworkIndex = buildFrameworkIndex(entriesCopy);

      const data = await file.arrayBuffer();
      const workbook = XLSX.read(data);
      const sheetName = workbook.SheetNames[0];
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);

      // Preview-Objekt initialisieren
      const preview = {
          updatedRows: [], newCalloffs: [], newFixes: [], skipped: [],
          _excelSum: 0,
          _initialEntries: JSON.parse(JSON.stringify(entriesCopy)), // Ursprungszustand für KPI-Berechnung sichern
          _modifiedEntriesMap: modifiedEntriesMap // Referenz auf die Map übergeben
      };

      for (const row of rows) {
        const kvRaw   = getVal(row,'KV-Nummer');
        const pNumRaw = getVal(row,'Projekt Projektnummer');
        const amount  = parseAmountInput(getVal(row,'Agenturleistung netto'));
        const client  = getVal(row,'Projekt Etat Kunde Name') || '';
        const title   = getVal(row,'Titel') || '';
        preview._excelSum += amount||0;

        let freeTS = Date.now(); // Fallback
        const excelDate = getVal(row,'Freigabedatum');
        if (excelDate) { const d = parseExcelDate(excelDate); if (d) freeTS = d.getTime(); }

        const kvNorm = normKV(kvRaw);
        const pNumNorm = normProjectNumber(pNumRaw);

        // --- Skip-Logik (frühe Prüfung) ---
        if (!kvNorm){
          preview.skipped.push({ kv: kvRaw, projectNumber: pNumRaw, title, client, amount, reason:'Keine KV-Nummer', detail:'Zeile ohne gültige KV' });
          if (window.LOGBOOK2) LOGBOOK2.importSkip({ kv: kvRaw, projectNumber: pNumRaw, title, client, source:'erp', reason:'missing_kv', detail:'Zeile ohne gültige KV-Nummer im ERP-Import' });
          continue;
        }
        // Skip, wenn Betrag ungültig (wird von parseAmountInput zu 0) -> Optional, je nach Anforderung
        /* if (amount === 0 && getVal(row, 'Agenturleistung netto')) { // Prüfen, ob original was anderes als 0 war
             preview.skipped.push({ kv: kvRaw, projectNumber: pNumRaw, title, client, amount: 0, reason:'Ungültiger Betrag', detail:'Betrag konnte nicht gelesen werden' });
             if (window.LOGBOOK2) LOGBOOK2.importSkip({ kv: kvRaw, projectNumber: pNumRaw, title, client, source:'erp', reason:'invalid_amount', detail:'Betrag ungültig' });
             continue;
        } */


        // --- Matching-Logik ---
        const existing = kvIndex.get(kvNorm);
        let matchReason = ''; // Für neue Fixaufträge

        if (existing){
          // Fall 1: KV existiert bereits (entweder Fix oder Transaction)
          const isTransaction = existing.type === 'transaction';
          const currentEntry = existing.entry; // Der Eintrag (Fix oder Rahmen)
          const currentItem = isTransaction ? existing.transaction : currentEntry; // Der spezifische Eintrag oder Abruf
          const currentAmount = Number(currentItem.amount)||0;

          // Vergleich mit Toleranz (optional, hier exakt)
          // const tolerance = 0.01; // 1 Cent Toleranz
          // if (Math.abs(currentAmount - amount) > tolerance) {
          if (fmtEUR0(currentAmount) !== fmtEUR0(amount)) { // Vergleiche gerundet auf Euro
            // Betrag hat sich geändert -> Update
            currentItem.amount = amount; // Ändere Betrag direkt in der Kopie
            if (isTransaction && excelDate) currentItem.freigabedatum = freeTS; // Freigabedatum für Abruf aktualisieren
            if (!isTransaction && excelDate) currentEntry.freigabedatum = freeTS; // Freigabedatum für Fixauftrag aktualisieren
            currentEntry.modified = Date.now(); // Zeitstempel am Haupteintrag setzen
            modifiedEntriesMap.set(currentEntry.id, currentEntry); // Geänderten Eintrag tracken

            preview.updatedRows.push({
              kv: kvRaw, projectNumber: pNumRaw, title: title || currentItem.title || '', client: client || currentItem.client || '',
              oldAmount: currentAmount, newAmount: amount,
              entry: currentEntry, // Referenz auf den modifizierten Eintrag in der Kopie
              _keep: true
            });
          } else {
            // Betrag ist identisch -> Skip
            preview.skipped.push({ kv: kvRaw, projectNumber: pNumRaw, title, client, amount, reason:'Keine Änderung', detail:`Betrag (${f(amount)}) identisch.` });
            if (window.LOGBOOK2) LOGBOOK2.importSkip({ kv: kvRaw, projectNumber: pNumRaw, title, client, source:'erp', reason:'no_change', detail:`Betrag ${f(amount)} identisch` });
          }
          continue; // Nächste Excel-Zeile
        }

        // Fall 2: KV ist neu, aber gehört vielleicht zu einem Rahmenvertrag?
        const parentFramework = pNumNorm ? frameworkIndex.get(pNumNorm) : null;
        if (parentFramework){
          // Ja, Projektnummer gehört zu einem Rahmenvertrag -> Neuer Abruf
          parentFramework.transactions = Array.isArray(parentFramework.transactions) ? parentFramework.transactions : [];
          // Doppelte Prüfung, ob KV im Abruf nicht doch schon existiert (sollte durch Index oben abgedeckt sein)
          const existsTrans = parentFramework.transactions.some(t => normKV(t.kv_nummer || t.kv) === kvNorm);
          if (!existsTrans){
            const newTrans = {
                id:`trans_${Date.now()}_${kvNorm}`,
                kv_nummer: kvRaw, // Original KV speichern
                type:'founder', // Standardmäßig passiv
                amount,
                ts:Date.now(),
                freigabedatum: freeTS // Freigabedatum aus Excel
            };
            parentFramework.transactions.push(newTrans); // Füge zur Kopie hinzu
            parentFramework.modified = Date.now(); // Zeitstempel am Rahmenvertrag setzen
            modifiedEntriesMap.set(parentFramework.id, parentFramework); // Geänderten Eintrag tracken

            preview.newCalloffs.push({
                kv: kvRaw,
                parentProjectNumber: pNumRaw, // Original-Projektnummer anzeigen
                title, client, amount,
                parentEntry: parentFramework, // Referenz auf modifizierten Rahmenvertrag
                 _keep:true
             });
          } else {
            // Sollte nicht passieren, da kvIndex das abfangen müsste
            preview.skipped.push({ kv: kvRaw, projectNumber: pNumRaw, title, client, amount, reason:'Abruf doppelt?', detail:`KV ${kvNorm} bereits in Rahmenvertrag ${pNumNorm}, aber Index hat nicht gematcht?` });
            if (window.LOGBOOK2) LOGBOOK2.importSkip({ kv: kvRaw, projectNumber: pNumRaw, title, client, source:'erp', reason:'duplicate_calloff', detail:'KV bereits in transactions[] gefunden' });
          }
          continue; // Nächste Excel-Zeile
        }

        // Fall 3: KV ist neu UND gehört zu keinem bekannten Rahmenvertrag -> Neuer Fixauftrag
        matchReason = `KV '${kvNorm}' nicht gefunden.`;
        if (pNumNorm) {
            matchReason += ` Rahmenvertrag '${pNumNorm}' nicht gefunden.`;
        } else {
            matchReason += ` Keine Projektnummer angegeben.`;
        }

        const newFixEntry = {
          id: `entry_${Date.now()}_${kvNorm}`, // Eindeutige ID generieren
          source: 'erp-import',
          projectType: 'fix',
          client, title, projectNumber: pNumRaw, // Original speichern
          kv_nummer: kvRaw, // Original speichern
          amount,
          // Leere Felder für spätere manuelle Befüllung
          list: [], rows: [], weights: [],
          ts: Date.now(), // Erstellungszeitpunkt
          freigabedatum: freeTS, // Freigabedatum aus Excel
          complete: false // Noch nicht vollständig, da Verteilung fehlt
        };
        // Wichtig: Neue Einträge nicht zur Kopie hinzufügen, sie werden nur im Preview-Objekt gehalten
        preview.newFixes.push({
            kv: kvRaw, projectNumber: pNumRaw, title, client, amount,
            newFixEntry, // Das Objekt, das gespeichert würde
            _matchReason: matchReason, // Grund für die Klassifizierung
            _keep:true
        });
      } // Ende der for-Schleife über Excel-Zeilen

      // Vorschau rendern und öffnen
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
    if (!btn) {
      console.warn('ERP Import Button #btnErpImport nicht gefunden.');
      return;
    }
    // Entferne potenzielle alte Inline-Handler (Sicherheitsmaßnahme)
    if (btn.hasAttribute('onclick')) {
        console.log('Entferne alten onclick Handler von #btnErpImport');
        btn.removeAttribute('onclick');
    }
    // Entferne evtl. andere vorherige Listener, um sicherzustellen, dass nur unser Handler aktiv ist.
    // Dazu müssen wir den Button klonen.
    const newBtn = btn.cloneNode(true);
    btn.parentNode.replaceChild(newBtn, btn);

    // Hänge NUR unseren neuen Handler an (in der Bubbling-Phase, nicht Capture)
    newBtn.addEventListener('click', handleErpImportPreview);
    console.log('Neuer ERP Preview Handler an #btnErpImport angehängt.');
  }

  // Warte auf DOMContentLoaded, falls Skript früh geladen wird
  if (document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded', hookButton, { once:true });
  } else {
    // DOM ist bereits geladen
    hookButton();
  }

})(); // Ende IIFE
