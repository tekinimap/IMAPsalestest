/* Sales Logbook + Import Preview Add-on (admin-only, non-invasive)
 * - Adds Logbuch button in Admin area
 * - JSONL-backed log view (reads via /log/list, writes via /log)
 * - Import preview modal: matches (update/new), invalid (reasons), only-in-tool
 * - Apply uses /entries/bulk (Excel overrides amount on KV match)
 * - Works with German number formats
 */

(() => {
  // ---------- Tiny utils ----------
  const WORKER = () => (window.WORKER_BASE || '').replace(/\/+$/,'');
  const fmtEUR = (n)=> new Intl.NumberFormat('de-DE',{style:'currency',currency:'EUR',maximumFractionDigits:2}).format(n||0);
  function showToast(msg,type){ console.log('[toast]', type||'info', msg); }
  async function fetchWithRetry(url, options={}, retryCount=0){
    const limit=2;
    try{
      const r = await fetch(url, options);
      if(!r.ok && retryCount<limit && r.status>=500){
        await new Promise(res=>setTimeout(res, 250*(retryCount+1)));
        return fetchWithRetry(url, options, retryCount+1);
      }
      return r;
    }catch(e){
      if(retryCount<limit){ await new Promise(res=>setTimeout(res, 250*(retryCount+1))); return fetchWithRetry(url, options, retryCount+1); }
      throw e;
    }
  }
  function toNumberMaybe(v){
    if (v==null || v==='') return null;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string'){
      let t = v.trim().replace(/\s/g,'');
      // 12.345,67 -> 12345.67
      if (t.includes(',') && (!t.includes('.') || /\.\d{3},\d{1,2}$/.test(t))) t = t.replace(/\./g,'').replace(',', '.');
      else t = t.replace(/,/g,'');
      const n = Number(t);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }
  function pick(o, arr){ if(!o||typeof o!=='object') return ''; for(const k of arr){ if(k in o && o[k]!=null && o[k]!=='' ) return o[k]; } return ''; }
  function fFields(obj){
    return {
      kv: pick(obj, ['kv','kv_nummer','kvNummer','KV','kvnummer']),
      projectNumber: pick(obj, ['projectNumber','projektnummer','project_no','projectId','Projektnummer']),
      title: pick(obj, ['title','titel','projectTitle','dealname','name','Titel']),
      client: pick(obj, ['client','kunde','customer','account','Kunde']),
      amount: toNumberMaybe(pick(obj, ['amount','wert','value','sum','betrag','Betrag'])),
      source: pick(obj, ['source']) || 'erp'
    };
  }

  // ---------- Inject styles & dialogs once ----------
  function injectOnce(id, html, into='body'){
    if (document.getElementById(id)) return;
    const tpl = document.createElement('template'); tpl.innerHTML = html.trim();
    const node = tpl.content.firstElementChild; node.id = id;
    document.querySelector(into).appendChild(node);
  }

  // Styles
  injectOnce('slpm-styles', `
    <style>
      /* Logbook */
      dialog#slpm-logbook { border:1px solid #213044; background:#0f1724; color:#e6ebf3; border-radius:14px; padding:16px; min-width:980px; z-index: 10000; }
      #slpm-lb .controls { display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-bottom: 10px; }
      #slpm-lb table { width:100%; border-collapse:collapse; min-width:960px; }
      #slpm-lb th { text-align:left; border-bottom:1px solid #213044; padding:8px; }
      #slpm-lb td { padding:6px 8px; font-size:12px; border-bottom:1px dashed #213044; vertical-align:top; }
      .slpm-status.ok { background: rgba(34,197,94,.18); border:1px solid rgba(34,197,94,.4); color:#86efac; padding:2px 6px; border-radius:8px;}
      .slpm-status.skip { background: rgba(245,158,11,.18); border:1px solid rgba(245,158,11,.4); color:#fde68a; padding:2px 6px; border-radius:8px;}
      .slpm-status.err { background: rgba(239,68,68,.18); border:1px solid rgba(239,68,68,.4); color:#fecaca; padding:2px 6px; border-radius:8px;}
      .slpm-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono","Courier New", monospace; }
      .slpm-sm { font-size:12px; }
      .slpm-btn { background:#3b82f6; color:white; border:none; border-radius:10px; padding:8px 12px; cursor:pointer; }
      .slpm-btn:hover { filter:brightness(1.05); }

      /* Import Preview */
      dialog#slpm-import { border:1px solid #213044; background:#0f1724; color:#e6ebf3; border-radius:14px; padding:16px; min-width:1024px; z-index: 10000; }
      #slpm-ip .topbar { display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin-bottom:10px; }
      #slpm-ip .kpis { display:flex; gap:14px; flex-wrap:wrap; }
      #slpm-ip .card { background:#111a2b; border:1px solid #213044; border-radius:12px; padding:10px 12px; min-width:180px; }
      #slpm-ip .label { font-size:12px; opacity:.7; }
      #slpm-ip .value { font-size:16px; font-weight:600; }
      #slpm-ip .panel { background:#0b1220; border:1px solid #213044; border-radius:12px; margin-top:12px; }
      #slpm-ip .panel h3 { margin:0; padding:10px 12px; border-bottom:1px solid #213044; font-size:14px; }
      #slpm-ip .panel .body { padding:6px 12px 12px; max-height:360px; overflow:auto; }
      #slpm-ip table { width:100%; border-collapse:collapse; }
      #slpm-ip th, #slpm-ip td { text-align:left; padding:6px 8px; border-bottom:1px dashed #213044; font-size:12px; }
      #slpm-ip th { position: sticky; top: 0; background:#0b1220; z-index:1; }
      .slpm-badge { padding:2px 6px; border-radius:8px; font-size:11px; border:1px solid transparent; }
      .slpm-badge.new { background: rgba(59,130,246,.18); border-color: rgba(59,130,246,.4); color:#bfdbfe; }
      .slpm-badge.update { background: rgba(34,197,94,.18); border-color: rgba(34,197,94,.4); color:#86efac; }
      .slpm-badge.same { background: rgba(148,163,184,.18); border-color: rgba(148,163,184,.4); color:#e2e8f0; }
      .slpm-badge.invalid { background: rgba(239,68,68,.18); border-color: rgba(239,68,68,.4); color:#fecaca; }
    </style>
  `, 'head');

  // Logbook dialog
  injectOnce('slpm-logbook', `
    <dialog id="slpm-logbook">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <h1 style="margin:0;font-size:18px;">Logbuch</h1>
        <button class="slpm-btn slpm-sm" id="slpm-lb-close">Schließen</button>
      </div>
      <div id="slpm-lb">
        <div class="controls">
          <input type="text" id="slpm-lb-q" placeholder="Suchen (KV, Projektnr, Titel, Kunde, Grund, ID)…" style="flex:1;padding:8px 10px;">
          <label>Von <input type="date" id="slpm-lb-from"></label>
          <label>Bis <input type="date" id="slpm-lb-to"></label>
          <select id="slpm-lb-ev">
            <option value="">Alle</option><option value="create">Neu</option><option value="update">Aktualisiert</option><option value="delete">Gelöscht</option><option value="skip">Übersprungen</option>
          </select>
          <select id="slpm-lb-src">
            <option value="">Alle Quellen</option><option value="erp">ERP</option><option value="legacy_sales">Legacy</option><option value="manuell">Manuell</option><option value="hubspot">HubSpot</option>
          </select>
          <button class="slpm-btn" id="slpm-lb-refresh">Aktualisieren</button>
          <button class="slpm-btn" id="slpm-lb-export">Export .txt</button>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th style="width:140px;">Zeit</th><th style="width:110px;">Ereignis</th><th style="width:120px;">KV</th><th style="width:150px;">Projektnummer</th><th style="width:260px;">Titel</th><th style="width:200px;">Kunde</th><th style="width:110px;">Δ Betrag</th><th>Grund / Details</th>
            </tr></thead>
            <tbody id="slpm-lb-body"></tbody>
          </table>
        </div>
      </div>
    </dialog>
  `);

  // Import preview dialog
  injectOnce('slpm-import', `
    <dialog id="slpm-import">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <h1 style="margin:0;font-size:18px;">Import-Vorschau (ERP)</h1>
        <button class="slpm-btn slpm-sm" id="slpm-ip-close">Schließen</button>
      </div>
      <div id="slpm-ip">
        <div class="topbar">
          <div class="kpis">
            <div class="card"><div class="label">Excel Summe</div><div class="value slpm-mono" id="slpm-ip-excel">–</div></div>
            <div class="card"><div class="label">Tool Summe (aktuell)</div><div class="value slpm-mono" id="slpm-ip-tool">–</div></div>
            <div class="card"><div class="label">Ausgewählt (Excel)</div><div class="value slpm-mono" id="slpm-ip-sel">–</div></div>
            <div class="card"><div class="label">Prognose Tool nach Übernahme</div><div class="value slpm-mono" id="slpm-ip-proj">–</div></div>
          </div>
          <div style="margin-left:auto;display:flex;gap:10px;align-items:center;">
            <label class="slpm-sm"><input type="checkbox" id="slpm-ip-all" checked> alle auswählen</label>
            <button class="slpm-btn" id="slpm-ip-apply">Änderungen übernehmen</button>
          </div>
        </div>

        <div class="panel">
          <h3>Treffer & Neue Einträge</h3>
          <div class="body">
            <table>
              <thead><tr>
                <th style="width:24px;"></th><th style="width:110px;">KV</th><th style="width:140px;">Projektnr</th><th style="width:220px;">Titel</th><th style="width:160px;">Kunde</th><th style="width:120px;">Tool Betrag</th><th style="width:120px;">Excel Betrag</th><th style="width:90px;">Δ</th><th style="width:100px;">Aktion</th>
              </tr></thead>
              <tbody id="slpm-ip-match"></tbody>
            </table>
          </div>
        </div>

        <div class="panel">
          <h3>Nur in Excel (ungültig / übersprungen)</h3>
          <div class="body">
            <table>
              <thead><tr><th style="width:110px;">KV</th><th style="width:140px;">Projektnr</th><th style="width:220px;">Titel</th><th style="width:160px;">Kunde</th><th style="width:120px;">Excel Betrag</th><th style="width:200px;">Grund</th></tr></thead>
              <tbody id="slpm-ip-invalid"></tbody>
            </table>
          </div>
        </div>

        <div class="panel">
          <h3>Nur im Tool (nicht in Excel)</h3>
          <div class="body">
            <table>
              <thead><tr><th style="width:110px;">KV</th><th style="width:140px;">Projektnr</th><th style="width:220px;">Titel</th><th style="width:160px;">Kunde</th><th style="width:120px;">Tool Betrag</th></tr></thead>
              <tbody id="slpm-ip-onlytool"></tbody>
            </table>
          </div>
        </div>
      </div>
    </dialog>
  `);

  // ---------- Mount Admin button (admin-only) ----------
  function mountAdminBtn(){
    // find an admin header container
    const adminRoot = document.querySelector('#viewAdmin, [data-admin], .admin-card, .admin-header, header, main') || document.body;
    const where = adminRoot.querySelector('.hd, .header, .admin-header') || adminRoot;
    if (document.getElementById('slpm-btn-log')) return;
    const btn = document.createElement('button');
    btn.id = 'slpm-btn-log';
    btn.className = 'slpm-btn slpm-sm';
    btn.textContent = '📜 Logbuch';
    btn.addEventListener('click', ()=> { document.dispatchEvent(new Event('slpm:log:open')); document.getElementById('slpm-logbook').showModal(); LOGBOOK3.render(); });
    where.appendChild(btn);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountAdminBtn); else mountAdminBtn();

  // ---------- LOGBOOK (client) ----------
  const LB = { cache: [], queue: [], open:false };
  const LB_LS = 'slpm-lb-cache';
  try{ const raw = localStorage.getItem(LB_LS); if(raw) LB.cache = JSON.parse(raw); }catch{}
  function lbPersist(){ try{ localStorage.setItem(LB_LS, JSON.stringify(LB.cache.slice(-2000))); }catch{} }
  function lbDelta(a,b){ const A=Number(a?.amount), B=Number(b?.amount); if(!Number.isFinite(A)||!Number.isFinite(B)) return ''; const d=Math.round((A-B)*100)/100; return d===0?'±0 €':(d>0?'+':'')+fmtEUR(Math.abs(d)); }
  window.LOGBOOK3 = {
    add(ev){
      const e = Object.assign({ ts: Date.now(), event:'', source:'', kv:'', projectNumber:'', entryId:'', title:'', client:'', before:null, after:null, reason:'', detail:'' }, ev||{});
      const fA = fFields(e.after||{}), fB = fFields(e.before||{}), fE = fFields(e);
      e.kv = e.kv || fA.kv || fB.kv || fE.kv || '';
      e.projectNumber = e.projectNumber || fA.projectNumber || fB.projectNumber || fE.projectNumber || '';
      e.title = e.title || fA.title || fB.title || fE.title || '';
      e.client = e.client || fA.client || fB.client || fE.client || '';
      e.source = e.source || fA.source || fB.source || fE.source || '';
      LB.queue.push(e); LB.cache.push(e); lbPersist(); if (LB.open) renderLB();
    },
    importSkip(ctx){ const f=fFields(ctx||{}); this.add({ event:'skip', kv:f.kv, projectNumber:f.projectNumber, title:f.title, client:f.client, source:f.source, reason:ctx?.reason||'unknown', detail:ctx?.detail||'' }); },
    async flush(){
      if(!LB.queue.length) return;
      const lines = LB.queue.map(x=>JSON.stringify(x));
      const r = await fetchWithRetry(`${WORKER()}/log`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({lines, date:new Date().toISOString().slice(0,10)}) });
      if (r.ok){ LB.queue.length=0; showToast('Log gespeichert','ok'); } else { showToast('Log-Speichern fehlgeschlagen','bad'); }
    },
    async load(from,to){
      const p = new URLSearchParams(); if(from) p.set('from',from); if(to) p.set('to',to);
      const r = await fetchWithRetry(`${WORKER()}/log/list?`+p.toString(), {method:'GET'});
      if (r.ok){ LB.cache = await r.json(); lbPersist(); if (LB.open) renderLB(); } else showToast('Log-Laden fehlgeschlagen','bad');
    },
    render: ()=> renderLB()
  };
  function renderLB(){
    const q = (document.getElementById('slpm-lb-q')?.value||'').toLowerCase();
    const evf = document.getElementById('slpm-lb-ev')?.value||'';
    const sf  = document.getElementById('slpm-lb-src')?.value||'';
    const arr = LB.cache.slice().sort((a,b)=>(b.ts||0)-(a.ts||0)).filter(x=>{
      const inQ = !q || [x.kv,x.projectNumber,x.title,x.client,x.reason,x.detail,x.entryId].some(v=> String(v||'').toLowerCase().includes(q));
      const inEv = !evf || x.event===evf; const inSrc = !sf || x.source===sf; return inQ && inEv && inSrc;
    });
    const tbody = document.getElementById('slpm-lb-body'); if (!tbody) return;
    tbody.innerHTML = arr.map(x=>{
      const cls = x.event==='skip'?'skip':(x.event==='delete'?'err':'ok'); const d = lbDelta(x.after,x.before);
      return `<tr>
        <td class="slpm-mono slpm-sm">${new Date(x.ts).toLocaleString('de-DE')}</td>
        <td><span class="slpm-status ${cls}">${x.event}</span> <span class="slpm-sm slpm-mono">${x.source||''}</span></td>
        <td class="slpm-mono slpm-sm">${x.kv||''}</td><td class="slpm-mono slpm-sm">${x.projectNumber||''}</td>
        <td class="slpm-sm">${(x.title||'').replace(/</g,'&lt;')}</td><td class="slpm-sm slpm-mono">${(x.client||'').replace(/</g,'&lt;')}</td>
        <td class="slpm-mono slpm-sm">${d}</td><td class="slpm-sm">${(x.reason?`<strong>${x.reason}</strong> – `:'')}${(x.detail||'').replace(/</g,'&lt;')}</td>
      </tr>`;
    }).join('');
  }
  (function wireLB(){
    const dlg = document.getElementById('slpm-logbook');
    document.getElementById('slpm-lb-close').onclick = ()=> { dlg.close(); LB.open=false; };
    document.getElementById('slpm-lb-refresh').onclick = ()=> {
      const f = document.getElementById('slpm-lb-from').value, t=document.getElementById('slpm-lb-to').value;
      LOGBOOK3.load(f,t);
    };
    document.getElementById('slpm-lb-export').onclick = ()=>{
      const rows = LB.cache.slice().sort((a,b)=>(b.ts||0)-(a.ts||0)).map(x=>[
        new Date(x.ts).toISOString().replace('T',' ').slice(0,16), x.event, x.source||'', x.kv||'', x.projectNumber||'', (x.title||'').replace(/\t/g,' '),
        (x.client||'').replace(/\t/g,' '), (x.after?.amount??''), (x.before?.amount??''), (x.reason||''), (x.detail||''), (x.entryId||'')
      ].join('\t'));
      const header = ['Zeit','Event','Quelle','KV','Projektnr','Titel','Kunde','Amount_after','Amount_before','Grund','Detail','EntryID'].join('\t');
      const blob = new Blob([header+'\n'+rows.join('\n')], {type:'text/plain'}); const url=URL.createObjectURL(blob);
      const a=document.createElement('a'); a.href=url; a.download='logbuch_'+new Date().toISOString().slice(0,10)+'.txt'; a.click(); URL.revokeObjectURL(url);
    };
    // Defaults for date range
    try{ const now=new Date(); const from = new Date(now.getTime()-13*24*3600*1000);
      document.getElementById('slpm-lb-to').value = now.toISOString().slice(0,10);
      document.getElementById('slpm-lb-from').value = from.toISOString().slice(0,10);
    }catch{}
    // First open
    document.addEventListener('slpm:log:open', ()=>{ LB.open=true; LOGBOOK3.load(document.getElementById('slpm-lb-from').value, document.getElementById('slpm-lb-to').value); });
  })();

  // ---------- Import Preview ----------
  async function getEntries(){
    const r = await fetchWithRetry(`${WORKER()}/entries`, {method:'GET'}); if(!r.ok) throw new Error(await r.text()); return r.json();
  }
  function sum(list, key){ let s=0; for(const el of list){ const v = key? el[key] : el; const n = toNumberMaybe(v); if(n!=null) s+=n; } return s; }

  function buildModel(rows, tool){
    const mapTool = new Map(tool.filter(e=>e&&e.kv).map(e=>[String(e.kv), e]));
    const seen = new Set();
    const matched=[]; const news=[]; const invalid=[];

    for(const r of rows){
      const f = fFields(r);
      if (!f.kv){ invalid.push({...f, reason:'missing_kv', detail:'KV-Nummer fehlt'}); continue; }
      if (f.amount===null){ invalid.push({...f, reason:'missing_amount', detail:'Betrag fehlt oder ungültig'}); continue; }
      seen.add(String(f.kv));
      const te = mapTool.get(String(f.kv));
      if (te){
        const delta = (f.amount??0) - (toNumberMaybe(te.amount)??0);
        matched.push({
          kv:f.kv, projectNumber: f.projectNumber || te.projectNumber || '', title: f.title || te.title || '', client: f.client || te.client || '',
          excelAmount:f.amount, toolAmount: toNumberMaybe(te.amount)??null, delta, action: (delta===0?'same':'update'), selected:true, source:f.source
        });
      } else {
        news.push({ kv:f.kv, projectNumber:f.projectNumber||'', title:f.title||'', client:f.client||'', excelAmount:f.amount, delta:f.amount, action:'new', selected:true, source:f.source });
      }
    }

    const onlyTool = [];
    for(const e of tool){
      if (e && e.kv && !seen.has(String(e.kv))){
        onlyTool.push({ kv:e.kv, projectNumber:e.projectNumber||'', title:e.title||'', client:e.client||'', toolAmount: toNumberMaybe(e.amount)??null });
      }
    }
    return { matched, news, invalid, onlyTool };
  }

  function renderPreview(model){
    const $ = sel => document.querySelector(sel);
    const $$ = sel => Array.from(document.querySelectorAll(sel));
    // Fill tables
    $('#slpm-ip-match').innerHTML = model.matched.concat(model.news).map(x=>{
      const badge = x.action==='new'?'slpm-badge new':(x.action==='update'?'slpm-badge update':'slpm-badge same');
      return `<tr>
        <td><input type="checkbox" class="slpm-ip-chk" ${x.selected?'checked':''}></td>
        <td class="slpm-mono">${x.kv||''}</td><td class="slpm-mono">${x.projectNumber||''}</td>
        <td>${(x.title||'').replace(/</g,'&lt;')}</td><td class="slpm-mono">${(x.client||'').replace(/</g,'&lt;')}</td>
        <td class="slpm-mono">${x.toolAmount!=null?fmtEUR(x.toolAmount):'—'}</td>
        <td class="slpm-mono">${x.excelAmount!=null?fmtEUR(x.excelAmount):'—'}</td>
        <td class="slpm-mono">${x.delta!=null?fmtEUR(x.delta):'—'}</td>
        <td><span class="${badge}">${x.action==='new'?'Neu':(x.action==='update'?'Änderung':'gleich')}</span></td>
      </tr>`;
    }).join('');

    $('#slpm-ip-invalid').innerHTML = model.invalid.map(x=>`
      <tr>
        <td class="slpm-mono">${x.kv||''}</td><td class="slpm-mono">${x.projectNumber||''}</td>
        <td>${(x.title||'').replace(/</g,'&lt;')}</td><td class="slpm-mono">${(x.client||'').replace(/</g,'&lt;')}</td>
        <td class="slpm-mono">${x.amount!=null?fmtEUR(x.amount):'—'}</td>
        <td><span class="slpm-badge invalid">${x.reason}</span> ${x.detail||''}</td>
      </tr>
    `).join('');

    $('#slpm-ip-onlytool').innerHTML = model.onlyTool.map(x=>`
      <tr>
        <td class="slpm-mono">${x.kv||''}</td><td class="slpm-mono">${x.projectNumber||''}</td>
        <td>${(x.title||'').replace(/</g,'&lt;')}</td><td class="slpm-mono">${(x.client||'').replace(/</g,'&lt;')}</td>
        <td class="slpm-mono">${x.toolAmount!=null?fmtEUR(x.toolAmount):'—'}</td>
      </tr>
    `).join('');

    // Checkbox hooks
    $$('#slpm-ip-match .slpm-ip-chk').forEach((chk, idx)=>{
      chk.addEventListener('change', ()=>{ const all=model.matched.concat(model.news); all[idx].selected = chk.checked; updateKpis(model); });
    });

    // Select all
    document.getElementById('slpm-ip-all').onchange = (e)=>{
      const all=model.matched.concat(model.news);
      all.forEach((x,i)=>{ x.selected = e.target.checked; const rowChk = $$('#slpm-ip-match .slpm-ip-chk')[i]; if(rowChk) rowChk.checked = e.target.checked; });
      updateKpis(model);
    };

    // Apply
    document.getElementById('slpm-ip-apply').onclick = ()=> applySelected(model);

    updateKpis(model);
  }

  function updateKpis(model){
    const excelSum = sum(model.matched.map(x=>x.excelAmount).concat(model.news.map(x=>x.excelAmount)));
    const toolSum  = sum((window.entries||[]),'amount');
    const selected = model.matched.concat(model.news).filter(x=>x.selected);
    const sumSelectedExcel = sum(selected.map(x=>x.excelAmount));
    const sumSelectedTool  = sum(selected.filter(x=>x.toolAmount!=null).map(x=>x.toolAmount));
    const projected = (toolSum - sumSelectedTool) + sumSelectedExcel;
    document.getElementById('slpm-ip-excel').textContent = fmtEUR(excelSum);
    document.getElementById('slpm-ip-tool').textContent  = fmtEUR(toolSum);
    document.getElementById('slpm-ip-sel').textContent   = fmtEUR(sumSelectedExcel);
    document.getElementById('slpm-ip-proj').textContent  = fmtEUR(projected);
  }

  async function applySelected(model){
    const selected = model.matched.concat(model.news).filter(x=>x.selected);
    if (!selected.length){ showToast('Nichts ausgewählt.','bad'); return; }
    const rows = selected.map(x=> ({ kv:x.kv, projectNumber:x.projectNumber, title:x.title, client:x.client, amount:x.excelAmount, source:x.source||'erp' }));
    const r = await fetchWithRetry(`${WORKER()}/entries/bulk`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ rows }) });
    if (!r.ok){ console.error(await r.text()); showToast('Übernahme fehlgeschlagen.','bad'); return; }
    const res = await r.json();
    showToast(`Übernommen: ${res.updated} aktualisiert, ${res.created} neu, ${res.errors} Fehler, ${res.skipped} ohne Änderung.`,'ok');
    document.getElementById('slpm-import').close();
    try{ const re = await fetchWithRetry(`${WORKER()}/entries`, {method:'GET'}); if (re.ok) window.entries = await re.json(); }catch{}
  }

  // Public API for your importer:
  window.previewAndImportExcel = async function(rows){
    if (!WORKER()){ showToast('WORKER_BASE ist leer.','bad'); return; }
    try{
      // ensure window.entries present for sums/deltas
      if (!Array.isArray(window.entries) || !window.entries.length){
        const r = await fetchWithRetry(`${WORKER()}/entries`, {method:'GET'}); if (r.ok) window.entries = await r.json();
      }
      const model = buildModel(rows||[], window.entries||[]);
      renderPreview(model);
      document.getElementById('slpm-import').showModal();
    }catch(e){ console.error(e); showToast('Vorschau fehlgeschlagen.','bad'); }
  };

  // Wire dialog close
  document.getElementById('slpm-ip-close').onclick = ()=> document.getElementById('slpm-import').close();

})();
