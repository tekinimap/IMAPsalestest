(() => {
  // --- Admin-only button mount ---
  function mountLogbookAdminButton() {
    const adminCard = document.getElementById('viewAdmin');
    if (!adminCard) return;
    const hd = adminCard.querySelector('.hd');
    if (!hd || hd.querySelector('#btnLogbookAdminV2')) return;
    const btn = document.createElement('button');
    btn.id = 'btnLogbookAdminV2';
    btn.className = 'btn iconbtn small';
    btn.textContent = '📜 Logbuch';
    btn.title = 'Logbuch öffnen';
    btn.addEventListener('click', () => {
      document.getElementById('logbookDlgV2').showModal();
      LOGBOOK2.render(); // initial render from cache
    });
    // place to the right of the header
    const right = document.createElement('div');
    right.style.display = 'flex';
    right.style.gap = '8px';
    right.appendChild(btn);
    hd.appendChild(right);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountLogbookAdminButton);
  } else {
    mountLogbookAdminButton();
  }

  // --- Shims if missing ---
  if (typeof window.WORKER_BASE === 'undefined') window.WORKER_BASE = '';
  if (typeof window.showToast === 'undefined') window.showToast = (m,t)=>console.log('[toast]', t||'info', m);
  function resolveCredentials(targetUrl, options){
    if (options && 'credentials' in options) {
      return options.credentials;
    }
    if (typeof window === 'undefined' || typeof window.location === 'undefined') {
      return 'include';
    }
    try {
      const resolved = typeof targetUrl === 'string'
        ? new URL(targetUrl, window.location.href)
        : targetUrl && typeof targetUrl.url === 'string'
          ? new URL(targetUrl.url, window.location.href)
          : null;
      if (!resolved) return 'omit';
      return resolved.origin === window.location.origin ? 'include' : 'omit';
    } catch {
      return 'omit';
    }
  }

  if (typeof window.fetchWithRetry === 'undefined') {
    window.fetchWithRetry = async function(url, options={}, retryCount=0){
      const limit=3;
      try{
        const merged = { ...options };
        if (options && options.headers) merged.headers = { ...options.headers };
        if (!('credentials' in merged)) {
          merged.credentials = resolveCredentials(url, options);
        }
        const res = await fetch(url, merged);
        if(!res.ok && retryCount<limit && res.status>=500){
          await new Promise(r=>setTimeout(r, 300*(retryCount+1)));
          return window.fetchWithRetry(url, options, retryCount+1);
        } return res;
      } catch(e){
        if(retryCount<limit){ await new Promise(r=>setTimeout(r, 300*(retryCount+1))); return window.fetchWithRetry(url, options, retryCount+1); }
        throw e;
      }
    }
  }

  // --- LOGBOOK v2 (optimiert) ---
  const LOG_LS = 'logbook_cache_v2';
  const state = { cache: [], queue: [], requestId: (crypto?.randomUUID?.() || (Date.now()+'-'+Math.random())) };
  try{ const raw = localStorage.getItem(LOG_LS); if(raw) state.cache = JSON.parse(raw); }catch{}
  const fmtDate = (ts)=> new Date(ts).toISOString().replace('T',' ').slice(0,16);
  const todayStr = ()=> new Date().toISOString().slice(0,10);
  function persist(){ try{ localStorage.setItem(LOG_LS, JSON.stringify(state.cache.slice(-1500))); }catch{} }

  function pick(v, ...keys){
    for(const k of keys){
      if (v && typeof v==='object' && k in v && v[k]!=null && v[k]!=='' ) return v[k];
    }
    return '';
  }
  function extractFields(obj){
    if(!obj || typeof obj!=='object') return {};
    return {
      kv: pick(obj,'kv','kv_nummer','kvNummer','KV','kvnummer'),
      projectNumber: pick(obj,'projectNumber','projektnummer','project_no','projectId'),
      title: pick(obj,'title','titel','projectTitle','dealname','name'),
      client: pick(obj,'client','kunde','customer','account'),
      amount: Number(pick(obj,'amount','wert','value','sum','betrag')) || undefined,
      source: pick(obj,'source') || ''
    };
  }
  function moneyDelta(after, before){
    const a = Number(after?.amount); const b = Number(before?.amount);
    if(!Number.isFinite(a) || !Number.isFinite(b)) return '';
    const diff = Math.round(a-b);
    const fmt = new Intl.NumberFormat('de-DE',{style:'currency',currency:'EUR',maximumFractionDigits:0});
    return diff===0 ? '±0 €' : (diff>0?'+':'')+fmt.format(diff);
  }

  // public API
  window.LOGBOOK2 = {
    add(ev){
      const e = Object.assign({
        ts: Date.now(), requestId: state.requestId,
        event: '', source:'', kv:'', projectNumber:'', entryId:'',
        title:'', client:'', before:null, after:null, reason:'', detail:''
      }, ev||{});
      // Fill metadata from after/before if missing
      const fromAfter = extractFields(e.after||{});
      const fromBefore = extractFields(e.before||{});
      e.kv = e.kv || fromAfter.kv || fromBefore.kv || e.kv || '';
      e.projectNumber = e.projectNumber || fromAfter.projectNumber || fromBefore.projectNumber || '';
      e.title = e.title || fromAfter.title || fromBefore.title || '';
      e.client = e.client || fromAfter.client || fromBefore.client || '';
      e.source = e.source || fromAfter.source || fromBefore.source || '';
      state.queue.push(e);
      state.cache.push(e);
      persist();
      this.render();
    },
    importSkip({kv, projectNumber, title, client, source='erp', reason, detail}){
      this.add({ event:'skip', kv, projectNumber, title, client, source, reason, detail });
    },
    async flush(){
      if(state.queue.length===0) return;
      try{
        const lines = state.queue.map(x=>JSON.stringify(x));
        const body = { lines, date: todayStr() };
        const r = await fetchWithRetry(`${WORKER_BASE}/log`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
        if(!r.ok) throw new Error(await r.text());
        state.queue.length = 0;
        showToast(`Logbuch gespeichert (${lines.length}).`,'ok');
      }catch(e){
        console.error('Log flush failed', e);
        showToast('Logbuch-Speicherung fehlgeschlagen.','bad');
      }
    },
    async loadRange(from,to){
      try{
        const p = new URLSearchParams();
        if(from) p.set('from', from); if(to) p.set('to', to);
        const r = await fetchWithRetry(`${WORKER_BASE}/log/list?${p}`, {method:'GET'});
        if(!r.ok) throw new Error(await r.text());
        state.cache = await r.json();
        persist();
        this.render();
      }catch(e){
        console.error('Load range failed', e);
        showToast('Logbuch-Laden fehlgeschlagen.','bad');
      }
    },
    render(){
      const tbody = document.getElementById('logbookBodyV2'); if(!tbody) return;
      const q = (document.getElementById('logSearchV2')?.value||'').toLowerCase();
      const evf = document.getElementById('logEventFilterV2')?.value||'';
      const sf = document.getElementById('logSourceFilterV2')?.value||'';
      const list = state.cache.slice().sort((a,b)=> (b.ts||0)-(a.ts||0)).filter(x=>{
        const inQ = !q || [x.kv,x.projectNumber,x.title,x.client,x.reason,x.detail,x.entryId].some(v=> String(v||'').toLowerCase().includes(q));
        const inEv = !evf || x.event===evf;
        const inSrc = !sf || x.source===sf;
        return inQ && inEv && inSrc;
      });
      tbody.innerHTML = list.map(x=>{
        const badge = x.event==='skip' ? 'status ev-skip' : (x.event==='delete' ? 'status ev-err' : 'status ev-ok');
        const d = moneyDelta(x.after, x.before);
        return `<tr>
          <td class="mono small">${fmtDate(x.ts)}</td>
          <td><span class="${badge}">${x.event}</span> <span class="small mono">${x.source||''}</span></td>
          <td class="mono small">${(x.kv||'')}</td>
          <td class="mono small">${(x.projectNumber||'')}</td>
          <td class="small">${(x.title||'').replace(/</g,'&lt;')}</td>
          <td class="small mono">${(x.client||'').replace(/</g,'&lt;')}</td>
          <td class="mono small">${d}</td>
          <td class="small">${(x.reason?`<strong>${x.reason}</strong> – `:'')}${(x.detail||'').replace(/</g,'&lt;')}</td>
        </tr>`;
      }).join('');
    }
  };

  // Wire UI controls
  const dlg = document.getElementById('logbookDlgV2');
  ['logSearchV2','logEventFilterV2','logSourceFilterV2'].forEach(id=>{
    const el = document.getElementById(id); el && el.addEventListener('input', ()=>LOGBOOK2.render());
  });
  const fromEl = document.getElementById('logFromV2');
  const toEl = document.getElementById('logToV2');
  document.getElementById('btnLogRefreshV2')?.addEventListener('click', ()=> LOGBOOK2.loadRange(fromEl.value, toEl.value));
  document.getElementById('btnLogExportTxtV2')?.addEventListener('click', ()=>{
    const rows = (state.cache||[]).slice().sort((a,b)=>(b.ts||0)-(a.ts||0)).map(x=>[
      fmtDate(x.ts), x.event, x.source||'', x.kv||'', x.projectNumber||'', (x.title||'').replace(/\t/g,' '),
      (x.client||'').replace(/\t/g,' '), (x.after?.amount??''), (x.before?.amount??''), (x.reason||''), (x.detail||''),
      (x.entryId||'')
    ].join('\\t'));
    const header = ['Zeit','Event','Quelle','KV','Projektnummer','Titel','Kunde','Amount_after','Amount_before','Grund','Detail','EntryID'].join('\\t');
    const blob = new Blob([header + '\\n' + rows.join('\\n')], {type:'text/plain'});
    const url = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = url; a.download = `logbuch_${todayStr()}.txt`; a.click(); URL.revokeObjectURL(url);
  });
  try{
    const now = new Date(); const from = new Date(now.getTime()-13*24*3600*1000);
    if (toEl) toEl.value = now.toISOString().slice(0,10);
    if (fromEl) fromEl.value = from.toISOString().slice(0,10);
  }catch{}

  // --- Interceptor (optimized: no extra GET; uses window.entries snapshot) ---
  const _origFetchWithRetry = window.fetchWithRetry;
  window.fetchWithRetry = async function(url, options={}, retryCount=0){
    const method = (options.method||'GET').toUpperCase();
    const isEntries = typeof url === 'string' && url.includes('/entries');
    const isTrans   = typeof url === 'string' && url.includes('/transactions');

    // Find id from URL when present
    let id = null;
    if (isEntries) {
      const m = String(url).match(/\/entries\/([^\/?#]+)/);
      if (m) try { id = decodeURIComponent(m[1]); } catch {}
    }

    // Snapshot BEFORE from window.entries for PUT/DELETE (zero extra requests)
    let before = null;
    if ((method==='PUT' || method==='DELETE') && isEntries && id && Array.isArray(window.entries)) {
      before = window.entries.find(e => String(e.id) === String(id)) || null;
    }

    const res = await _origFetchWithRetry(url, options, retryCount);

    try {
      if (isEntries || isTrans) {
        const body = options.body ? (typeof options.body==='string' ? JSON.parse(options.body||'{}') : options.body) : {};
        const after = (res && res.ok) ? await (async ()=>{ try{return await res.clone().json();}catch{return null;}})() : null;

        // Compose common fields (prefer after > before > body)
        const fields = (obj)=> (obj? extractFields(obj): {});
        const fAfter = fields(after), fBefore = fields(before), fBody = fields(body);
        const common = {
          source: fAfter.source || fBefore.source || fBody.source || (body?.projectType?'manuell': (body?.hubspotId?'hubspot':'')),
          kv: fAfter.kv || fBefore.kv || fBody.kv || '',
          projectNumber: fAfter.projectNumber || fBefore.projectNumber || fBody.projectNumber || '',
          title: fAfter.title || fBefore.title || fBody.title || '',
          client: fAfter.client || fBefore.client || fBody.client || '',
          entryId: id || after?.id || body?.id || ''
        };

        if (res && res.ok) {
          if (method==='POST' && isEntries) {
            LOGBOOK2.add({ event:'create', after, ...common });
          } else if (method==='PUT' && isEntries) {
            LOGBOOK2.add({ event:'update', before, after, ...common });
          } else if (method==='DELETE') {
            LOGBOOK2.add({ event:'delete', before, ...common, reason: isTrans?'delete.transaction':'delete.entry' });
          }
        } else if (method!=='GET') {
          LOGBOOK2.add({ event:'skip', before, ...common, reason:'http_error', detail:`HTTP ${res?.status||'?'}` });
        }
      }
    } catch(e) {
      console.warn('LOGBOOK2 interceptor warn', e);
    }

    return res;
  };

  // expose flush for importer batches
  window.flushLogbook = ()=> LOGBOOK2.flush();
})();