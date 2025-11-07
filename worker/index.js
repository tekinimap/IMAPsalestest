/**
 * Cloudflare Worker – GitHub JSON/JSONL Proxy + HubSpot Webhook + Logbuch (v8.0 - Mehrfach-KV & Merge)
 * - NEU: Mehrfach-KV-Unterstützung, Merge-Endpunkt und aktualisierte Persistenzlogik.
 * - v8.8 (Gemini): Finale Version. Kombiniert Owner + Collaborators in 'list' mit 0% Zuweisung, um "Unvollständig" zu erzwingen.
 */


const GH_API = "https://api.github.com";
const MAX_LOG_ENTRIES = 300; // Für Legacy Logs

/* ------------------------ Utilities ------------------------ */

const getCorsHeaders = (env) => ({
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-HubSpot-Signature-V3, X-HubSpot-Request-Timestamp",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
});

const jsonResponse = (data, status = 200, env, additionalHeaders = {}) => {
  const corsHeaders = getCorsHeaders(env);
  const headers = { ...corsHeaders, "Content-Type": "application/json", ...additionalHeaders };
  if (status >= 400) { console.error(`Responding with status ${status}:`, JSON.stringify(data)); }
  return new Response(JSON.stringify(data), { status, headers });
};

function b64encodeUtf8(str) {
  try {
    const latin1String = unescape(encodeURIComponent(str));
    return btoa(latin1String);
  } catch (e) {
      console.error("b64encodeUtf8 failed for part of string:", e);
      const safeStr = str.replace(/[^\x00-\xFF]/g, '?');
      try { return btoa(safeStr); }
      catch (e2) { console.error("btoa fallback failed:", e2); throw new Error("btoa failed even on fallback."); }
  }
}
function b64decodeUtf8(b64){ try { return decodeURIComponent(escape(atob(b64))); } catch { return atob(b64); } }
function base64ToUint8Array(value){
  if (!value) return null;
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(normalized + padding);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch (err) {
    console.error("Failed to decode base64 signature", err);
    return null;
  }
}
function ghHeaders(env){ return {
  "Authorization": `Bearer ${env.GH_TOKEN || env.GITHUB_TOKEN}`,
  "Accept": "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "imap-sales-worker/1.8",
}; }

function rndId(prefix = 'item_'){ const a=new Uint8Array(16); crypto.getRandomValues(a); return `${prefix}${[...a].map(b=>b.toString(16).padStart(2,'0')).join('')}`; }
function todayStr(){ return new Date().toISOString().slice(0,10); }
const LOG_DIR = (env)=> (env.GH_LOG_DIR || "data/logs");

function normKV(v){ return String(v ?? '').trim(); }
function splitKvString(value){
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return [];
  if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed;
    } catch (e) { /* ignore */ }
  }
  return trimmed.split(/[,;|]+/);
}
function uniqueNormalizedKvList(list){
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []){
    const kv = normKV(raw);
    if (!kv) continue;
    if (!seen.has(kv)){
      seen.add(kv);
      out.push(kv);
    }
  }
  return out;
}
function kvListFrom(obj){
  if (!obj || typeof obj !== 'object') return [];
  const arrayFields = ['kvNummern','kv_nummern','kvNumbers','kv_numbers','kvList','kv_list'];
  for (const field of arrayFields){
    const value = obj[field];
    if (Array.isArray(value)){
      const normalized = uniqueNormalizedKvList(value);
      if (normalized.length) return normalized;
    } else if (typeof value === 'string' && value.trim()){
      const normalized = uniqueNormalizedKvList(splitKvString(value));
      if (normalized.length) return normalized;
    }
  }
  const singleFields = ['kv','kv_nummer','kvNummer','KV','kvnummer'];
  for (const field of singleFields){
    const value = obj[field];
    if (Array.isArray(value)){
      const normalized = uniqueNormalizedKvList(value);
      if (normalized.length) return normalized;
    } else if (value != null && String(value).trim()){
      const normalized = uniqueNormalizedKvList(splitKvString(String(value)));
      if (normalized.length) return normalized;
    }
  }
  return [];
}
function applyKvList(entry, kvList){
  const normalized = uniqueNormalizedKvList(kvList || []);
  entry.kvNummern = normalized;
  entry.kv_nummer = normalized[0] || '';
  entry.kv = entry.kv_nummer || '';
  return entry;
}
function ensureKvStructure(entry){
  if (!entry || typeof entry !== 'object') return entry;
  return applyKvList(entry, kvListFrom(entry));
}
function canonicalizeEntries(items){
  return (items || []).map(entry => {
    const clone = { ...entry };
    if (Array.isArray(entry.kvNummern)) clone.kvNummern = [...entry.kvNummern];
    if (Array.isArray(entry.list)) clone.list = entry.list.map(item => ({ ...item }));
    if (Array.isArray(entry.rows)) clone.rows = entry.rows.map(row => ({ ...row }));
    if (Array.isArray(entry.weights)) clone.weights = entry.weights.map(w => ({ ...w }));
    if (Array.isArray(entry.transactions)) clone.transactions = entry.transactions.map(t => ({ ...t }));
    return ensureKvStructure(clone);
  });
}
function mergeKvLists(...lists){
  const combined = [];
  for (const list of lists){
    if (!list) continue;
    if (Array.isArray(list)) combined.push(...list);
  }
  return uniqueNormalizedKvList(combined);
}
function entriesShareKv(kvList, entry){
  if (!kvList || !kvList.length) return false;
  const existingList = kvListFrom(entry);
  if (!existingList.length) return false;
  return kvList.some(kv => existingList.includes(kv));
}
function mergeContributionLists(entries, totalAmount){
  const total = Number(totalAmount) || 0;
  const map = new Map();
  for (const entry of entries){
    const list = Array.isArray(entry?.list) ? entry.list : [];
    for (const item of list){
      if (!item) continue;
      const keyBase = item.key || item.name || item.id || `contrib_${map.size+1}`;
      const key = String(keyBase);
      const money = toNumberMaybe(item.money ?? item.amount ?? item.value) || 0;
      const name = item.name || item.key || key;
      if (!map.has(key)){
        map.set(key, { ...item, key, name, money });
      } else {
        const existing = map.get(key);
        existing.money += money;
      }
    }
  }
  const result = [];
  for (const value of map.values()){
    const normalized = { ...value };
    normalized.money = Math.round((normalized.money + Number.EPSILON) * 100) / 100;
    normalized.pct = total > 0 ? Math.round((normalized.money / total) * 10000) / 100 : 0;
    result.push(normalized);
  }
  return result;
}

/* ------------------------ Log Analytics ------------------------ */

var __LOG_ANALYTICS__ = ((existing) => {
  if (existing) {
    return existing;
  }

  const LOG_ANALYTICS_EPSILON = 1e-6;

  function normalizeNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : 0;
  }

  function extractPersonAmounts(entry) {
    const map = new Map();
    if (!entry || typeof entry !== 'object') {
      return map;
    }

    const list = Array.isArray(entry.list) ? entry.list : [];
    const baseAmount = normalizeNumber(entry.amount);

    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const name = (item.name || item.key || '').trim();
      if (!name) continue;

      const amount = normalizeNumber(item.money ?? item.amount ?? item.value);
      const pct = normalizeNumber(item.pct);

      if (!Number.isFinite(amount) || Math.abs(amount) < LOG_ANALYTICS_EPSILON) {
        if (Number.isFinite(pct) && Math.abs(pct) > LOG_ANALYTICS_EPSILON && baseAmount) {
          map.set(name, (map.get(name) || 0) + (pct / 100) * baseAmount);
        }
        continue;
      }

      map.set(name, (map.get(name) || 0) + amount);
    }

    if (map.size === 0 && baseAmount) {
      const submittedBy = (entry.submittedBy || '').trim();
      if (submittedBy) {
        map.set(submittedBy, baseAmount);
      }
    }

    return map;
  }

  function computeEntryTotal(entry) {
    if (!entry || typeof entry !== 'object') {
      return 0;
    }

    const byPerson = extractPersonAmounts(entry);
    if (byPerson.size > 0) {
      let sum = 0;
      for (const value of byPerson.values()) {
        const normalized = normalizeNumber(value);
        if (Math.abs(normalized) > LOG_ANALYTICS_EPSILON) {
          sum += normalized;
        }
      }
      if (Math.abs(sum) > LOG_ANALYTICS_EPSILON) {
        return sum;
      }
    }

    if (Array.isArray(entry.transactions) && entry.transactions.length) {
      let sum = 0;
      for (const tx of entry.transactions) {
        const txAmount = normalizeNumber(tx?.amount);
        if (Math.abs(txAmount) > LOG_ANALYTICS_EPSILON) {
          sum += txAmount;
        }
      }
      if (Math.abs(sum) > LOG_ANALYTICS_EPSILON) {
        return sum;
      }
    }

    const amount = normalizeNumber(entry.amount);
    if (Math.abs(amount) > LOG_ANALYTICS_EPSILON) {
      return amount;
    }

    return 0;
  }

  function sumPersonAmountsForTeam(entry, teamName, personTeamMap) {
    if (!entry || typeof entry !== 'object') {
      return 0;
    }

    const team = (teamName || '').trim();
    const teamsEnabled = team.length > 0;
    const amounts = extractPersonAmounts(entry);

    if (!teamsEnabled) {
      let sum = 0;
      for (const value of amounts.values()) {
        sum += value;
      }
      return sum;
    }

    if (!(personTeamMap instanceof Map) || personTeamMap.size === 0) {
      return 0;
    }

    let total = 0;
    for (const [person, amount] of amounts.entries()) {
      const teamForPerson = (personTeamMap.get(person) || '').trim();
      if (!teamForPerson) continue;
      if (teamForPerson.toLowerCase() === team.toLowerCase()) {
        total += amount;
      }
    }

    return total;
  }

  function round2(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) {
      return 0;
    }

    return Math.round((num + Number.EPSILON) * 100) / 100;
  }

  function createEmptyBucket() {
    return {
      amount: 0,
      count: 0,
      positiveCount: 0,
      positiveAmount: 0,
      negativeCount: 0,
      negativeAmount: 0,
      neutralCount: 0,
    };
  }

  function applyDelta(bucket, delta) {
    if (!bucket) return;

    bucket.amount += delta;
    bucket.count += 1;

    if (delta > LOG_ANALYTICS_EPSILON) {
      bucket.positiveCount += 1;
      bucket.positiveAmount += delta;
    } else if (delta < -LOG_ANALYTICS_EPSILON) {
      bucket.negativeCount += 1;
      bucket.negativeAmount += delta;
    } else {
      bucket.neutralCount += 1;
    }
  }

  function bucketToObject(key, bucket, keyName) {
    const successDenominator = bucket.count || 0;
    const successRate = successDenominator > 0 ? bucket.positiveCount / successDenominator : null;
    return {
      [keyName]: key,
      amount: round2(bucket.amount),
      count: bucket.count,
      positiveCount: bucket.positiveCount,
      positiveAmount: round2(bucket.positiveAmount),
      negativeCount: bucket.negativeCount,
      negativeAmount: round2(bucket.negativeAmount),
      neutralCount: bucket.neutralCount,
      successRate,
    };
  }

  function updateBucket(collection, key, delta) {
    if (!collection || !key) return;
    const bucket = collection.get(key) || createEmptyBucket();
    applyDelta(bucket, delta);
    collection.set(key, bucket);
  }

  function computeLogMetrics(logEntries = [], options = {}, personTeamMap = new Map()) {
    const teamFilter = (options.team || '').trim();
    const filteredLogs = Array.isArray(logEntries)
      ? logEntries.filter((entry) => entry && typeof entry === 'object' && Number.isFinite(Number(entry.ts)))
      : [];

    filteredLogs.sort((a, b) => Number(a.ts) - Number(b.ts));

    const totals = createEmptyBucket();
    let minDate = null;
    let maxDate = null;

    const monthlyBuckets = new Map();
    const dailyBuckets = new Map();
    const eventBuckets = new Map();

    for (const log of filteredLogs) {
      const ts = Number(log.ts);
      if (!Number.isFinite(ts)) continue;

      const dateIso = new Date(ts).toISOString();
      const day = dateIso.slice(0, 10);
      const month = dateIso.slice(0, 7);

      if (!minDate || day < minDate) minDate = day;
      if (!maxDate || day > maxDate) maxDate = day;

      const beforeVal = sumPersonAmountsForTeam(log.before, teamFilter, personTeamMap);
      const afterVal = sumPersonAmountsForTeam(log.after, teamFilter, personTeamMap);
      const delta = afterVal - beforeVal;

      updateBucket(monthlyBuckets, month, delta);
      updateBucket(dailyBuckets, day, delta);
      updateBucket(eventBuckets, log.event || 'unbekannt', delta);
      applyDelta(totals, delta);
    }

    const successDenominator = totals.count || 0;
    const successRate = successDenominator > 0 ? totals.positiveCount / successDenominator : null;

    const months = Array.from(monthlyBuckets.entries())
      .map(([key, bucket]) => bucketToObject(key, bucket, 'month'))
      .sort((a, b) => a.month.localeCompare(b.month));

    const daily = Array.from(dailyBuckets.entries())
      .map(([key, bucket]) => bucketToObject(key, bucket, 'date'))
      .sort((a, b) => a.date.localeCompare(b.date));

    const events = Array.from(eventBuckets.entries())
      .map(([key, bucket]) => bucketToObject(key, bucket, 'event'))
      .sort((a, b) => b.count - a.count || a.event.localeCompare(b.event));

    return {
      period: { from: options.from || minDate, to: options.to || maxDate },
      filters: { team: teamFilter || null },
      totals: {
        count: totals.count,
        amount: round2(totals.amount),
        positiveCount: totals.positiveCount,
        positiveAmount: round2(totals.positiveAmount),
        negativeCount: totals.negativeCount,
        negativeAmount: round2(totals.negativeAmount),
        neutralCount: totals.neutralCount,
        successRate,
      },
      months,
      daily,
      events,
    };
  }

  const api = {
    computeLogMetrics,
    extractPersonAmounts,
    computeEntryTotal,
    sumPersonAmountsForTeam,
    round2,
  };

  if (typeof globalThis !== 'undefined') {
    globalThis.__LOG_ANALYTICS__ = api;
  }

  return api;
})(typeof globalThis !== 'undefined' && globalThis.__LOG_ANALYTICS__
  ? globalThis.__LOG_ANALYTICS__
  : typeof __LOG_ANALYTICS__ !== 'undefined'
    ? __LOG_ANALYTICS__
    : undefined);

const {
  computeLogMetrics: __computeLogMetrics,
  extractPersonAmounts: __extractPersonAmounts,
  computeEntryTotal: __computeEntryTotal,
  sumPersonAmountsForTeam: __sumPersonAmountsForTeam,
  round2: __round2,
} = __LOG_ANALYTICS__;

export {
  __computeLogMetrics as computeLogMetrics,
  __extractPersonAmounts as extractPersonAmounts,
  __computeEntryTotal as computeEntryTotal,
  __sumPersonAmountsForTeam,
  __round2,
};

// Hilfsfunktionen
function toNumberMaybe(v){ if (v==null || v==='') return null; if (typeof v === 'number' && Number.isFinite(v)) return v; if (typeof v === 'string'){ let t = v.trim().replace(/\s/g,''); if (t.includes(',') && (!t.includes('.') || /\.\d{3},\d{1,2}$/.test(t))) { t = t.replace(/\./g,'').replace(',', '.'); } else { t = t.replace(/,/g,''); } const n = Number(t); return Number.isFinite(n) ? n : null; } return null; }
const pick = (o, keys)=> (o && typeof o==='object' ? (keys.find(k => o[k]!=null && o[k]!=='' ) ? o[keys.find(k => o[k]!=null && o[k]!=='' )] : '') : '');
function fieldsOf(obj){
  const kvList = kvListFrom(obj);
  return {
    kv: kvList[0] || '',
    kvList,
    projectNumber: pick(obj, ['projectNumber','projektnummer','project_no','projectId','Projektnummer']),
    title: pick(obj, ['title','titel','projectTitle','dealname','name','Titel']),
    client: pick(obj, ['client','kunde','customer','account','Kunde']),
    amount: toNumberMaybe(pick(obj, ['amount','wert','value','sum','betrag','Betrag'])),
    source: pick(obj, ['source'])
  };
}
function validateRow(row){
  const f = fieldsOf(row||{});
  if (!f.kvList.length && !isFullEntry(row)) return { ok:false, reason:'missing_kv', message:'KV-Nummer fehlt', ...f };
  if (f.amount===null && !isFullEntry(row)) return { ok:false, reason:'missing_amount', message:'Betrag fehlt oder ist ungültig', ...f };
  return { ok:true, ...f };
}
const isFullEntry = (obj)=> !!(obj && (obj.projectType || obj.transactions || Array.isArray(obj.rows) || Array.isArray(obj.list) || Array.isArray(obj.weights)));

/* ------------------------ GitHub I/O ------------------------ */
async function ghGetFile(env, path, branch) { const url = `${GH_API}/repos/${env.GH_REPO}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch || env.GH_BRANCH)}`; const r = await fetch(url, { headers: ghHeaders(env) }); if (r.status === 404) return { items: [], sha: null }; if (!r.ok) throw new Error(`GitHub GET ${path} failed: ${r.status} ${await r.text()}`); const data = await r.json(); const raw = (data.content || "").replace(/\n/g, ""); const content = raw ? b64decodeUtf8(raw) : "[]"; let items = []; try { items = content.trim() ? JSON.parse(content) : []; if (!Array.isArray(items)) items = []; } catch(e) { console.error("Failed to parse JSON from GitHub:", content); throw new Error(`Failed to parse JSON from ${path}: ${e.message}`); } return { items, sha: data.sha }; }
async function ghPutFile(env, path, items, sha, message, branch) { const url = `${GH_API}/repos/${env.GH_REPO}/contents/${encodeURIComponent(path)}`; const body = { message: message || `update ${path}`, content: b64encodeUtf8(JSON.stringify(items, null, 2)), branch: branch || env.GH_BRANCH, ...(sha ? { sha } : {}), }; const r = await fetch(url, { method: "PUT", headers: { ...ghHeaders(env), "Content-Type": "application/json" }, body: JSON.stringify(body), }); if (!r.ok) throw new Error(`GitHub PUT ${path} failed (${r.status}): ${await r.text()}`); return r.json(); }
async function ghGetContent(env, path) { const url = `${GH_API}/repos/${env.GH_REPO}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(env.GH_BRANCH)}`; const r = await fetch(url, { headers: ghHeaders(env) }); if (r.status === 404) return { content: "", sha: null }; if (!r.ok) throw new Error(`GitHub GET ${path} failed: ${r.status} ${await r.text()}`); const data = await r.json(); const raw = (data.content || "").replace(/\n/g, ""); return { content: raw ? b64decodeUtf8(raw) : "", sha: data.sha }; }
async function ghPutContent(env, path, content, sha, message) { const url = `${GH_API}/repos/${env.GH_REPO}/contents/${encodeURIComponent(path)}`; const body = { message: message || `update ${path}`, content: b64encodeUtf8(content), branch: env.GH_BRANCH, ...(sha ? { sha } : {}), }; const r = await fetch(url, { method: "PUT", headers: { ...ghHeaders(env), "Content-Type": "application/json" }, body: JSON.stringify(body), }); if (!r.ok) throw new Error(`GitHub PUT ${path} failed (${r.status}): ${await r.text()}`); return r.json(); }
async function appendFile(env, path, text, message) { let tries = 0; const maxTries = 3; while (true) { tries++; const cur = await ghGetContent(env, path); const next = (cur.content || "") + text; try { const r = await ghPutContent(env, path, next, cur.sha, message); return { sha: r.content?.sha, path: r.content?.path }; } catch (e) { const s = String(e || ""); if (s.includes("sha") && tries < maxTries) { await new Promise(r=>setTimeout(r, 300*tries)); continue; } throw e; } } }

/* ------------------------ Logging (JSONL pro Tag) ------------------------ */
async function logJSONL(env, events){ if (!events || !events.length) return; const dateStr = todayStr(); const y = dateStr.slice(0,4), m = dateStr.slice(5,7); const root = LOG_DIR(env); const path = `${root.replace(/\/+$/,'')}/${y}-${m}/${dateStr}.jsonl`; const text = events.map(e => JSON.stringify({ ts: Date.now(), ...e })).join("\n") + "\n"; try { await appendFile(env, path, text, `log ${events.length} events`); } catch (logErr) { console.error(`Failed to write to log file ${path}:`, logErr); } }

async function readLogEntries(env, rootDir, from, to){
  const trimmedRoot = (rootDir || '').replace(/\/+$/, '');
  const entries = [];
  for (const day of dateRange(from, to)){
    const y = day.slice(0,4);
    const m = day.slice(5,7);
    const path = `${trimmedRoot}/${y}-${m}/${day}.jsonl`;
    try {
      const file = await ghGetContent(env, path);
      const content = file?.content || '';
      if (!content) continue;
      const lines = content.split(/\n+/);
      for (const line of lines){
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          entries.push(JSON.parse(trimmed));
        } catch (parseErr){
          console.warn(`Failed to parse log entry in ${path}:`, parseErr, trimmed);
        }
      }
    } catch (err){
      const msg = String(err || '');
      if (!msg.includes('404')){
        console.error(`Error reading log file ${path}:`, err);
      }
    }
  }
  return entries;
}

/* ------------------------ HubSpot ------------------------ */
async function verifyHubSpotSignatureV3(request, env, rawBody) {
  const sigHeader = request.headers.get("X-HubSpot-Signature-V3") || "";
  const ts = request.headers.get("X-HubSpot-Request-Timestamp") || "";
  const secret = (env.HUBSPOT_APP_SECRET || "").trim();
  if (!secret) {
    console.error("HubSpot signature check failed: missing HUBSPOT_APP_SECRET");
    return false;
  }
  if (!sigHeader) {
    console.error("HubSpot signature check failed: missing X-HubSpot-Signature-V3 header");
    return false;
  }
  if (!ts) {
    console.error("HubSpot signature check failed: missing X-HubSpot-Request-Timestamp header");
    return false;
  }

  const provided = base64ToUint8Array(sigHeader);
  if (!provided) {
    console.error("HubSpot signature check failed: signature header is not valid base64");
    return false;
  }

  const u = new URL(request.url);
  const enc = new TextEncoder();
  const payload = (rawBody || "");
  const candidates = [
    request.method + u.pathname + (u.search || "") + payload + ts,
    request.method + u.origin + u.pathname + (u.search || "") + payload + ts,
  ];
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);

  const attempted = [];
  for (const data of candidates) {
    const expectedBuffer = await crypto.subtle.sign("HMAC", key, enc.encode(data));
    const expected = new Uint8Array(expectedBuffer);
    attempted.push(expected);

    if (expected.byteLength !== provided.byteLength) {
      continue;
    }

    let mismatch = 0;
    for (let i = 0; i < expected.length; i++) {
      mismatch |= expected[i] ^ provided[i];
    }
    if (mismatch === 0) {
      return true;
    }
  }

  const providedPreview = btoa(String.fromCharCode(...provided)).slice(0, 8);
  const expectedPreview = attempted.length ? btoa(String.fromCharCode(...attempted[0])).slice(0, 8) : "";
  console.error("HubSpot signature mismatch", { expectedPreview, providedPreview, triedCandidates: candidates.length });
  return false;
}
async function hsFetchDeal(dealId, env) {
  if (!env.HUBSPOT_ACCESS_TOKEN) throw new Error("HUBSPOT_ACCESS_TOKEN missing");

  const properties = [
    "dealname", "amount", "dealstage", "closedate", "hs_object_id", "pipeline",
    "hubspot_owner_id",
    "hs_all_collaborator_owner_ids"
  ];

  const associations = "company";

  const url = `https://api.hubapi.com/crm/v3/objects/deals/${dealId}?properties=${properties.join(",")}&associations=${associations}`;

  const r = await fetch(url, { headers: { "Authorization": `Bearer ${env.HUBSPOT_ACCESS_TOKEN}` } });
  if (!r.ok) throw new Error(`HubSpot GET deal ${dealId} failed: ${r.status} ${await r.text()}`);
  return r.json();
}

async function hsFetchCompany(companyId, env) {
  if (!env.HUBSPOT_ACCESS_TOKEN) throw new Error("HUBSPOT_ACCESS_TOKEN missing for company fetch");
  if (!companyId) return "";
  try {
    const url = `https://api.hubapi.com/crm/v3/objects/companies/${companyId}?properties=name`;
    const r = await fetch(url, { headers: { "Authorization": `Bearer ${env.HUBSPOT_ACCESS_TOKEN}` } });
    if (!r.ok) {
      console.error(`HubSpot GET company ${companyId} failed: ${r.status}`);
      return "";
    }
    const data = await r.json();
    return data?.properties?.name || "";
  } catch (e) {
    console.error(`Error fetching company ${companyId}:`, e);
    return "";
  }
}

async function hsFetchOwner(ownerId, env) {
  if (!env.HUBSPOT_ACCESS_TOKEN) throw new Error("HUBSPOT_ACCESS_TOKEN missing for owner fetch");
  if (!ownerId) return "";
  try {
    const url = `https://api.hubapi.com/crm/v3/owners/${ownerId}`;
    const r = await fetch(url, { headers: { "Authorization": `Bearer ${env.HUBSPOT_ACCESS_TOKEN}` } });
    if (!r.ok) {
      console.error(`HubSpot GET owner ${ownerId} failed: ${r.status}`);
      return "";
    }
    const data = await r.json();
    return `${data.firstName || ''} ${data.lastName || ''}`.trim();
  } catch (e) {
    console.error(`Error fetching owner ${ownerId}:`, e);
    return "";
  }
}

function upsertByHubSpotId(entries, deal) {
  const id = String(deal?.id || deal?.properties?.hs_object_id || "");
  if (!id) return;

  const name = deal?.properties?.dealname || `Deal ${id}`;
  const amount = Number(deal?.properties?.amount || 0);

  const companyName = deal?.properties?.fetched_company_name || "";
  const ownerName = deal?.properties?.fetched_owner_name || "";
  const collaboratorNames = deal?.properties?.fetched_collaborator_names || [];

  const allNames = new Set([ownerName, ...collaboratorNames]);
  const salesList = [];
  allNames.forEach((nameValue, index) => {
    if (nameValue) {
      salesList.push({
        key: `hubspot_user_${index}`,
        name: nameValue,
        money: 0,
        pct: 0,
      });
    }
  });

  const idx = entries.findIndex(e => String(e.hubspotId||"") === id);
  const previousKv = idx >= 0 ? kvListFrom(entries[idx]) : [];

  const base = {
    id: entries[idx]?.id || rndId('hubspot_'),
    hubspotId: id,
    title: name,
    amount,
    source: "hubspot",
    projectType: "fix",
    projectNumber: entries[idx]?.projectNumber || "",
    client: companyName,
    submittedBy: ownerName,
    list: salesList,
    updatedAt: Date.now(),
    kvNummern: previousKv,
    kv_nummer: previousKv[0] || '',
    kv: previousKv[0] || ''
  };

  const normalized = ensureKvStructure(base);
  if (idx >= 0) {
    entries[idx] = { ...entries[idx], ...normalized };
  } else {
    entries.push(normalized);
  }
}

/* ------------------------ Router ------------------------ */
export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: getCorsHeaders(env) });
    }

    try {
        const url = new URL(request.url);
        const ghPath = env.GH_PATH || "data/entries.json";
        const peoplePath = env.GH_PEOPLE_PATH || "data/people.json";
        const branch = env.GH_BRANCH;
        const saveEntries = async (items, sha, message) => {
          const payload = canonicalizeEntries(items);
          return ghPutFile(env, ghPath, payload, sha, message, branch);
        };

        /* ===== Entries GET ===== */
        if (url.pathname === "/entries" && request.method === "GET") {
            const { items } = await ghGetFile(env, ghPath, branch);
            const normalized = canonicalizeEntries(items);
            return jsonResponse(normalized, 200, env);
        }
        if (url.pathname.startsWith("/entries/") && request.method === "GET") {
            const id = decodeURIComponent(url.pathname.split("/").pop());
            const { items } = await ghGetFile(env, ghPath, branch);
            const found = items.find(x => String(x.id) === id);
            if (!found) return jsonResponse({ error: "not found" }, 404, env);
            return jsonResponse(ensureKvStructure({ ...found }), 200, env);
        }

        /* ===== Entries POST (Single Create/Upsert) ===== */
        if (url.pathname === "/entries" && request.method === "POST") {
            let body; try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON body" }, 400, env); }
            const cur = await ghGetFile(env, ghPath, branch);
            const items = cur.items || [];
            let entry; let status = 201; let skipSave = false;

            if (isFullEntry(body)) { /* Create Full Entry Logic */
                const existingById = items.find(e => e.id === body.id);
                if (existingById) return jsonResponse({ error: "Conflict: ID exists. Use PUT." }, 409, env);
                entry = { id: body.id || rndId('entry_'), ...body, ts: body.ts || Date.now(), modified: undefined };
                if(Array.isArray(entry.transactions)){ entry.transactions = entry.transactions.map(t => ({ id: t.id || `trans_${Date.now()}_${Math.random().toString(16).slice(2)}`, ...t })); }
                ensureKvStructure(entry);
                items.push(entry);
                const f = fieldsOf(entry); await logJSONL(env, [{ event:'create', source: entry.source||'manuell', after: entry, kv: f.kv, kvList: f.kvList, projectNumber: f.projectNumber, title: f.title, client: f.client, reason:'manual_or_import' }]);
            } else { /* Upsert-by-KV Logic */
                const v = validateRow(body);
                if (!v.ok) { await logJSONL(env, [{ event:'skip', source: v.source || 'erp', ...v}]); return jsonResponse({ error:'validation_failed', ...v }, 422, env); }
                const kvList = v.kvList;
                const existing = items.find(e => entriesShareKv(kvList, e));
                if (!existing) {
                    entry = { id: rndId('entry_'), kvNummern: kvList, projectNumber: v.projectNumber||'', title: v.title||'', client: v.client||'', amount: v.amount, source: v.source || 'erp', projectType: 'fix', ts: Date.now() };
                    ensureKvStructure(entry);
                    items.push(entry);
                    await logJSONL(env, [{ event:'create', source: entry.source, after: entry, kv: entry.kv, kvList: entry.kvNummern, projectNumber: entry.projectNumber, title: entry.title, client: entry.client, reason:'excel_new' }]);
                } else {
                     status = 200; entry = existing; const before = JSON.parse(JSON.stringify(existing));
                     const oldAmt = Number(existing.amount) || 0; const amountChanged = Math.abs(oldAmt - v.amount) >= 0.01;
                     const mergedKvList = mergeKvLists(kvListFrom(existing), kvList);
                     let updated = false;
                     if (mergedKvList.length !== kvListFrom(existing).length) { applyKvList(existing, mergedKvList); updated = true; }
                     if (amountChanged) { existing.amount = v.amount; updated = true; }
                     if (v.projectNumber && v.projectNumber !== existing.projectNumber) { existing.projectNumber = v.projectNumber; updated = true; }
                     if (v.title && v.title !== existing.title) { existing.title = v.title; updated = true; }
                     if (v.client && v.client !== existing.client) { existing.client = v.client; updated = true; }
                     const freigabeTsBody = body.freigabedatum ? new Date(body.freigabedatum).getTime() : null;
                     if (freigabeTsBody && Number.isFinite(freigabeTsBody) && freigabeTsBody !== existing.freigabedatum) { existing.freigabedatum = freigabeTsBody; updated = true; }
                     if (updated) {
                        ensureKvStructure(existing);
                        existing.modified = Date.now();
                        await logJSONL(env, [{ event:'update', source: existing.source || v.source || 'erp', before, after: existing, kv: existing.kv, kvList: existing.kvNummern, projectNumber: existing.projectNumber, title: existing.title, client: existing.client, reason:'excel_override' }]);
                     } else {
                        skipSave = true; await logJSONL(env, [{ event:'skip', source: existing.source || v.source || 'erp', kv: existing.kv, kvList: existing.kvNummern, projectNumber: existing.projectNumber, title: existing.title, client: existing.client, reason:'no_change' }]);
                     }
                }
            }
            if (!skipSave) {
                 try { await saveEntries(items, cur.sha, `upsert entry: ${entry.kv || entry.id}`); }
                 catch (e) {
                     if (String(e).includes('sha') || String(e).includes('conflict')) {
                         console.warn("Retrying PUT due to SHA conflict..."); await new Promise(r=>setTimeout(r, 600));
                         const ref = await ghGetFile(env, ghPath, branch);
                         let refIdx = ref.items.findIndex(i => i.id === entry.id);
                         const refItems = ref.items || [];
                         if (status === 201 && refIdx === -1) { refItems.push(entry); }
                         else if (status === 200 && refIdx > -1) { refItems[refIdx] = entry; }
                         else { console.error("Cannot cleanly retry after SHA conflict."); throw new Error("SHA conflict, unresolved."); }
                         ensureKvStructure(entry);
                         await saveEntries(refItems, ref.sha, `upsert entry (retry): ${entry.kv || entry.id}`);
                     } else { throw e; }
                 }
            }
            return jsonResponse(entry, status, env);
        }

        /* ===== Entries PUT (Single Update) ===== */
        if (url.pathname.startsWith("/entries/") && request.method === "PUT") {
            const id = decodeURIComponent(url.pathname.split("/").pop());
            let body; try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON" }, 400, env); }
            const cur = await ghGetFile(env, ghPath, branch);
            const idx = cur.items.findIndex(x => String(x.id) === id);
            if (idx < 0) return jsonResponse({ error: "not found" }, 404, env);
            const before = JSON.parse(JSON.stringify(cur.items[idx])); let updatedEntry;

            if (isFullEntry(body)) {
                 if(Array.isArray(body.transactions)){ body.transactions = body.transactions.map(t => ({ id: t.id || `trans_${Date.now()}_${Math.random().toString(16).slice(2)}`, ...t })); }
                 updatedEntry = ensureKvStructure({ ...before, ...body, id, modified: Date.now() }); cur.items[idx] = updatedEntry;
                 await saveEntries(cur.items, cur.sha, `update entry (full): ${id}`);
                 const f = fieldsOf(updatedEntry); await logJSONL(env, [{ event:'update', source: updatedEntry.source||'manuell', before, after: updatedEntry, kv: f.kv, kvList: f.kvList, projectNumber: f.projectNumber, title: f.title, client: f.client }]);
            } else {
                const v = validateRow({ ...before, ...body });
                if (!v.ok) { await logJSONL(env, [{ event:'skip', ...v }]); return jsonResponse({ error:'validation_failed', ...v }, 422, env); }
                updatedEntry = ensureKvStructure({ ...before, ...body, amount: v.amount, modified: Date.now() }); cur.items[idx] = updatedEntry;
                await saveEntries(cur.items, cur.sha, `update entry (narrow): ${id}`);
                const f = fieldsOf(updatedEntry); const changes = {}; for(const k in body){ if(before[k] !== body[k]) changes[k] = body[k]; } if (before.amount !== v.amount) changes.amount = v.amount;
                await logJSONL(env, [{ event:'update', ...fieldsOf(updatedEntry), before: { amount: before.amount, ...Object.fromEntries(Object.keys(changes).map(k=>[k,before[k]])) }, after: changes }]);
            }
            return jsonResponse(updatedEntry, 200, env);
        }

        /* ===== Entries DELETE (Single) ===== */
        if (url.pathname.startsWith("/entries/") && request.method === "DELETE") {
             const id = decodeURIComponent(url.pathname.split("/").pop());
             const cur = await ghGetFile(env, ghPath, branch);
             const before = cur.items.find(x => String(x.id) === id);
             if(!before) return jsonResponse({ ok: true, message:"already deleted?" }, 200, env);
             const next = cur.items.filter(x => String(x.id) !== id);
             await saveEntries(next, cur.sha, `delete entry: ${id}`);
             const f = fieldsOf(before); await logJSONL(env, [{ event:'delete', reason:'delete.entry', before, kv: f.kv, kvList: f.kvList, projectNumber: f.projectNumber, title: f.title, client: f.client }]);
             return jsonResponse({ ok: true }, 200, env);
        }

        /* ===== Entries POST /entries/bulk (Legacy - Nur schlanker KV-Upsert) ===== */
        if (url.pathname === "/entries/bulk" && request.method === "POST") {
             console.log("Processing legacy /entries/bulk");
             let payload; try { payload = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON" }, 400, env); }
             const rows = Array.isArray(payload?.rows) ? payload.rows : [];
             if (!rows.length) return jsonResponse({ ok:false, message:'rows empty' }, 400, env);
             const cur = await ghGetFile(env, ghPath, branch); const items = cur.items || [];
             const byKV = new Map(items.filter(x=>x && kvListFrom(x).length).flatMap(x=>kvListFrom(x).map(kv=>[kv,x])));
             const logs = []; let created=0, updated=0, skipped=0, errors=0; let changed = false;
             for (const r of rows) {
               const validation = validateRow(r);
               if (!validation.ok) { skipped++; logs.push({ event:'skip', ...validation }); continue; }
               const kvList = validation.kvList;
               const existing = items.find(item => entriesShareKv(kvList, item));
               if (!existing) {
                 const entry = ensureKvStructure({ id: rndId('entry_'), kvNummern: kvList, projectNumber: validation.projectNumber || '', title: validation.title || '', client: validation.client || '', amount: validation.amount, source: validation.source || 'erp', projectType:'fix', ts: Date.now() });
                 items.push(entry); kvList.forEach(kv => byKV.set(kv, entry));
                 logs.push({ event:'create', source: entry.source, after: entry, kv: entry.kv, kvList: entry.kvNummern, projectNumber: entry.projectNumber, title: entry.title, client: entry.client, reason:'legacy_bulk_new' });
                 created++; changed = true;
               } else {
                 const before = JSON.parse(JSON.stringify(existing));
                 const merged = mergeKvLists(kvListFrom(existing), kvList);
                 applyKvList(existing, merged);
                 const oldAmount = Number(existing.amount) || 0;
                 const newAmount = validation.amount;
                 const amountChanged = Math.abs(oldAmount - newAmount) >= 0.01;
                 if (amountChanged) existing.amount = newAmount;
                 if (validation.projectNumber && validation.projectNumber !== existing.projectNumber) existing.projectNumber = validation.projectNumber;
                 if (validation.title && validation.title !== existing.title) existing.title = validation.title;
                 if (validation.client && validation.client !== existing.client) existing.client = validation.client;
                 if (amountChanged || merged.length !== kvListFrom(before).length) {
                   existing.modified = Date.now(); ensureKvStructure(existing);
                   logs.push({ event:'update', source: existing.source || validation.source || 'erp', before, after: existing, kv: existing.kv, kvList: existing.kvNummern, projectNumber: existing.projectNumber, title: existing.title, client: existing.client, reason:'legacy_bulk_update' });
                   updated++; changed = true;
                 } else {
                   logs.push({ event:'skip', source: existing.source || validation.source || 'erp', kv: existing.kv, kvList: existing.kvNummern, projectNumber: existing.projectNumber, title: existing.title, client: existing.client, reason:'legacy_bulk_no_change' });
                   skipped++;
                 }
               }
             }
             if (changed) {
               try { await saveEntries(items, cur.sha, `bulk import ${created}C ${updated}U ${skipped}S ${errors}E`); }
               catch (e) { if (String(e).includes('sha') || String(e).includes('conflict')) { console.warn("Retrying legacy bulk due to SHA conflict", e); return jsonResponse({ error: "Save conflict. Please retry import.", details: e.message }, 409, env); } else { throw e; } }
             }
             await logJSONL(env, logs);
             return jsonResponse({ ok:true, created, updated, skipped, errors, saved: changed }, 200, env);
        }

        /* ===== NEU: Entries POST /entries/bulk-v2 (Full Object Bulk) ===== */
        if (url.pathname === "/entries/bulk-v2" && request.method === "POST") {
             console.log("Processing /entries/bulk-v2");
             let payload; try { payload = await request.json(); } catch (e) { return jsonResponse({ error: "Invalid JSON", details: e.message }, 400, env); }
             const rows = Array.isArray(payload?.rows) ? payload.rows : [];
             if (!rows.length) return jsonResponse({ created: 0, updated: 0, skipped: 0, errors: 0, message:'rows empty' }, 200, env);
             const cur = await ghGetFile(env, ghPath, branch);
             const items = cur.items || []; const logs = []; let created=0, updated=0, skipped=0, errors=0; let changed = false;
             const itemsById = new Map(items.map(item => [item.id, item]));
             const itemsByKV = new Map(); items.forEach(item => { const kvs = kvListFrom(item); kvs.forEach(kv => { if (kv && !itemsByKV.has(kv)) { itemsByKV.set(kv, item.id); } }); if(item.projectType === 'rahmen' && Array.isArray(item.transactions)){ item.transactions.forEach(t => { const tkvList = kvListFrom(t); tkvList.forEach(tkv => { if (tkv && !itemsByKV.has(tkv)) { itemsByKV.set(tkv, item.id); } }); }); } });
             const kvsAddedInThisBatch = new Set();

             for (const row of rows) {
                try {
                    const kvList = kvListFrom(row);
                    const isNew = !row.id || !itemsById.has(row.id);
                    if (isNew) {
                        if (!kvList.length && !isFullEntry(row)) { skipped++; logs.push({ event:'skip', reason:'missing_kv', ...fieldsOf(row) }); continue; }
                        const conflictKv = kvList.find(kv => itemsByKV.has(kv) || kvsAddedInThisBatch.has(kv));
                        if (conflictKv) { skipped++; logs.push({ event:'skip', source: row.source || 'erp', kv: conflictKv, kvList, projectNumber: row.projectNumber, title: row.title, client: row.client, reason: itemsByKV.has(conflictKv) ? 'duplicate_kv_existing' : 'duplicate_kv_batch', detail: `KV '${conflictKv}' present.`}); console.warn(`Skipping create (duplicate KV): ${conflictKv}`); continue; }
                        const newId = row.id || rndId('entry_');
                        const entry = ensureKvStructure({ ...row, id: newId, ts: row.ts || Date.now(), modified: undefined });
                        if(Array.isArray(entry.transactions)){ entry.transactions = entry.transactions.map(t => ({ id: t.id || `trans_${Date.now()}_${Math.random().toString(16).slice(2)}`, ...t })); }
                        items.push(entry); itemsById.set(newId, entry); kvList.forEach(kv => { if (kv) { kvsAddedInThisBatch.add(kv); itemsByKV.set(kv, newId); } });
                        created++; changed = true; const f = fieldsOf(entry); logs.push({ event:'create', source: entry.source || 'erp', after: entry, kv: f.kv, kvList: f.kvList, projectNumber: f.projectNumber, title: f.title, client: f.client, reason:'bulk_import_new' });
                    } else {
                        const existingEntry = itemsById.get(row.id); if (!existingEntry) { errors++; logs.push({ event:'error', source: row.source || 'erp', entryId: row.id, reason: 'update_id_not_found'}); console.error(`Update failed: ID ${row.id} not found.`); continue; }
                        const newKvList = kvList.length ? kvList : kvListFrom(existingEntry);
                        const conflictKv = newKvList.find(kv => { const owner = itemsByKV.get(kv); return owner && owner !== row.id; });
                        if (conflictKv) { skipped++; logs.push({ event:'skip', source: row.source || 'erp', kv: conflictKv, kvList: newKvList, projectNumber: row.projectNumber, title: row.title, client: row.client, reason:'duplicate_kv_existing', detail:`KV '${conflictKv}' belongs to ${itemsByKV.get(conflictKv)}` }); continue; }
                        const before = JSON.parse(JSON.stringify(existingEntry));
                        const updatedEntry = ensureKvStructure({ ...existingEntry, ...row, id: row.id, modified: Date.now() });
                        if(Array.isArray(updatedEntry.transactions)){ updatedEntry.transactions = updatedEntry.transactions.map(t => ({ id: t.id || `trans_${Date.now()}_${Math.random().toString(16).slice(2)}`, ...t })); }
                        const indexToUpdate = items.findIndex(item => item.id === row.id);
                        if (indexToUpdate !== -1) {
                            items[indexToUpdate] = updatedEntry; itemsById.set(row.id, updatedEntry);
                            const updatedKvs = kvListFrom(updatedEntry);
                            const beforeKvs = kvListFrom(before);
                            beforeKvs.forEach(kv => { if (!updatedKvs.includes(kv)) itemsByKV.delete(kv); });
                            updatedKvs.forEach(kv => { itemsByKV.set(kv, row.id); kvsAddedInThisBatch.add(kv); });
                            updated++; changed = true; const f = fieldsOf(updatedEntry); logs.push({ event:'update', source: updatedEntry.source || 'erp', before, after: updatedEntry, kv: f.kv, kvList: f.kvList, projectNumber: f.projectNumber, title: f.title, client: f.client, reason: 'bulk_import_update' });
                        } else { errors++; logs.push({ event:'error', source: row.source || 'erp', entryId: row.id, reason: 'update_sync_error'}); console.error(`Update sync error: ID ${row.id}`); }
                    }
                } catch (rowError) { errors++; logs.push({ event:'error', source: row?.source || 'erp', ...fieldsOf(row), reason: 'processing_error', detail: rowError.message }); console.error("Error processing row:", row, rowError); }
             } // Ende for

             if (changed) {
                console.log(`Bulk v2: ${created} created, ${updated} updated. Attempting save.`);
                try { await saveEntries(items, cur.sha, `bulk v2 import: ${created}C ${updated}U ${skipped}S ${errors}E`); }
                catch (e) {
                     if (String(e).includes('sha') || String(e).includes('conflict')) { console.error("Bulk v2 save failed (SHA conflict):", e); await logJSONL(env, logs); return jsonResponse({ error: "Save conflict. Please retry import.", details: e.message, created, updated, skipped, errors, saved: false }, 409, env);
                     } else { console.error("Bulk v2 save failed (Other):", e); throw e; }
                }
             } else { console.log("Bulk v2: No changes detected."); }
             await logJSONL(env, logs);
             return jsonResponse({ ok:true, created, updated, skipped, errors, saved: changed }, 200, env);
        } // Ende /entries/bulk-v2

        /* ===== NEU: Entries POST /entries/bulk-delete ===== */
        if (url.pathname === "/entries/bulk-delete" && request.method === "POST") {
            console.log("Processing /entries/bulk-delete");
            let body; try { body = await request.json(); } catch (e) { return jsonResponse({ error: "Invalid JSON", details: e.message }, 400, env); }
            const idsToDelete = Array.isArray(body?.ids) ? body.ids : [];
            if (!idsToDelete.length) return jsonResponse({ ok: true, deletedCount: 0, message: 'No IDs provided' }, 200, env);

            const cur = await ghGetFile(env, ghPath, branch);
            const items = cur.items || [];
            const logs = [];
            
            const idSet = new Set(idsToDelete);
            const deletedItems = [];
            const nextItems = items.filter(item => {
                if (idSet.has(item.id)) {
                    deletedItems.push(item);
                    return false;
                }
                return true;
            });

            const deletedCount = deletedItems.length;

            if (deletedCount > 0) {
                deletedItems.forEach(before => {
                    const f = fieldsOf(before);
                    logs.push({ event:'delete', reason:'bulk_delete', before, ...f });
                });

                console.log(`Bulk Delete: Removing ${deletedCount} items. Attempting save.`);
                try {
                    await saveEntries(nextItems, cur.sha, `bulk delete: ${deletedCount} entries`);
                    await logJSONL(env, logs);
                } catch (e) {
                    if (String(e).includes('sha') || String(e).includes('conflict')) {
                        console.error("Bulk delete failed due to SHA conflict:", e);
                        return jsonResponse({ error: "Save conflict. Please retry delete operation.", details: e.message, deletedCount: 0 }, 409, env);
                    } else {
                        console.error("Bulk delete failed with other error:", e);
                        throw e;
                    }
                }
            } else {
                console.log("Bulk Delete: No matching items found to delete.");
            }
            
            return jsonResponse({ ok: true, deletedCount: deletedCount }, 200, env);
        } // Ende /entries/bulk-delete

        /* ===== Entries POST /entries/merge ===== */
        if (url.pathname === "/entries/merge" && request.method === "POST") {
            console.log("Processing /entries/merge");
            let body; try { body = await request.json(); } catch (e) { return jsonResponse({ error: "Invalid JSON", details: e.message }, 400, env); }
            const ids = Array.isArray(body?.ids) ? body.ids.map(String) : [];
            if (!ids.length || ids.length < 2) return jsonResponse({ error: "at least_two_ids_required" }, 400, env);
            const targetId = body?.targetId ? String(body.targetId) : ids[0];

            const cur = await ghGetFile(env, ghPath, branch);
            const items = cur.items || [];
            const selected = ids.map(id => {
              const entry = items.find(e => String(e.id) === id);
              if (!entry) throw new Error(`Entry ${id} not found`);
              return entry;
            });
            const targetEntry = selected.find(e => String(e.id) === targetId) || selected[0];
            if (!targetEntry) return jsonResponse({ error: "target_not_found" }, 404, env);

            const sourceEntries = selected.filter(e => e !== targetEntry);
            const projectNumbers = new Set(selected.map(e => String(e.projectNumber || '').trim()));
            if (projectNumbers.size > 1) return jsonResponse({ error: "project_number_mismatch", message: "Die Projektnummern stimmen nicht überein" }, 409, env);
            const invalidType = selected.find(e => (e.projectType && e.projectType !== 'fix'));
            if (invalidType) return jsonResponse({ error: "invalid_project_type", message: "Nur Fixaufträge können zusammengeführt werden" }, 422, env);

            const beforeTarget = JSON.parse(JSON.stringify(targetEntry));
            const beforeSources = sourceEntries.map(e => JSON.parse(JSON.stringify(e)));

            const mergedAmount = selected.reduce((sum, entry) => sum + (Number(entry.amount) || 0), 0);
            const mergedKvList = mergeKvLists(...selected.map(kvListFrom));
            const mergedList = mergeContributionLists(selected, mergedAmount);

            targetEntry.amount = mergedAmount;
            targetEntry.list = mergedList;
            targetEntry.modified = Date.now();
            applyKvList(targetEntry, mergedKvList);
            ensureKvStructure(targetEntry);

            const idsToRemove = new Set(sourceEntries.map(e => e.id));
            const nextItems = items.filter(entry => !idsToRemove.has(entry.id));
            nextItems[nextItems.findIndex(e => e.id === targetEntry.id)] = targetEntry;

            const logs = [
              { event:'merge_target', targetId: targetEntry.id, mergedIds: sourceEntries.map(e=>e.id), before: beforeTarget, after: targetEntry, ...fieldsOf(targetEntry), reason:'merge_fix_orders' },
              ...beforeSources.map(src => ({ event:'merge_source', sourceId: src.id, mergedInto: targetEntry.id, before: src, ...fieldsOf(src), reason:'merge_fix_orders' }))
            ];

            try {
              await saveEntries(nextItems, cur.sha, `merge entries into ${targetEntry.id}`);
              await logJSONL(env, logs);
            } catch (e) {
              if (String(e).includes('sha') || String(e).includes('conflict')) {
                console.error("Merge save failed (SHA conflict):", e);
                return jsonResponse({ error: "save_conflict", details: e.message }, 409, env);
              }
              throw e;
            }

            return jsonResponse({ ok: true, mergedInto: targetEntry.id, removed: sourceEntries.map(e=>e.id), entry: targetEntry }, 200, env);
        }


        /* ===== People Routes (Wiederhergestellt) ===== */
        if (url.pathname === "/people" && request.method === "GET") {
            const { items } = await ghGetFile(env, peoplePath, branch);
            return jsonResponse(items, 200, env);
        }
        if (url.pathname === "/people" && request.method === "POST") {
            let body; try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON" }, 400, env); }
            if (!body.name || !body.team) return jsonResponse({ error: "Name and Team required"}, 400, env);
            const cur = await ghGetFile(env, peoplePath, branch);
            const newPerson = { ...body, id: body.id || rndId('person_'), createdAt: Date.now() };
            cur.items.push(newPerson);
            await ghPutFile(env, peoplePath, cur.items.map(person => ({ ...person })), cur.sha, `add person ${body.name}`);
            return jsonResponse(newPerson, 201, env);
        }
        if (url.pathname === "/people" && request.method === "PUT") {
            let body; try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON" }, 400, env); }
            if (!body.id) return jsonResponse({ error: "ID missing" }, 400, env);
            const cur = await ghGetFile(env, peoplePath, branch);
            const idx = cur.items.findIndex(x => String(x.id) === String(body.id));
            if (idx < 0) return jsonResponse({ error: "not found" }, 404, env);
            const updatedPerson = { ...cur.items[idx], ...body, updatedAt: Date.now() };
            cur.items[idx] = updatedPerson;
            await ghPutFile(env, peoplePath, cur.items.map(person => ({ ...person })), cur.sha, `update person ${body.id}`);
            return jsonResponse(updatedPerson, 200, env);
        }
        if (url.pathname === "/people" && request.method === "DELETE") {
             let body; try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON" }, 400, env); }
             const idToDelete = body?.id;
             if (!idToDelete) return jsonResponse({ error: "ID missing in request body" }, 400, env);
             const cur = await ghGetFile(env, peoplePath, branch);
             const initialLength = cur.items.length;
             const next = cur.items.filter(x => String(x.id) !== String(idToDelete));
             if (next.length === initialLength) return jsonResponse({ error: "not found" }, 404, env);
             await ghPutFile(env, peoplePath, next.map(person => ({ ...person })), cur.sha, `delete person ${idToDelete}`);
             return jsonResponse({ ok: true }, 200, env);
        }

      /* ===== Logs Routes ===== */
      if (url.pathname === "/log" && request.method === "POST") {
        let payload; try { payload = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON" }, 400, env); }
        const dateStr = (payload.date || todayStr()); const y = dateStr.slice(0,4), m = dateStr.slice(5,7); const root = LOG_DIR(env);
        const path = `${root.replace(/\/+$/,'')}/${y}-${m}/${dateStr}.jsonl`; const text = (payload.lines||[]).map(String).join("\n") + "\n";
        const result = await appendFile(env, path, text, `log: ${dateStr} (+${(payload.lines||[]).length})`);
        return jsonResponse({ ok: true, path, committed: result }, 200, env);
      }
      const isMetricsRequest =
        request.method === "GET" && (url.pathname === "/log/metrics" || url.pathname === "/analytics/metrics");
      if (isMetricsRequest) {
        const from = url.searchParams.get("from") || undefined;
        const to = url.searchParams.get("to") || undefined;
        const team = (url.searchParams.get("team") || "").trim();
        const root = LOG_DIR(env);
        const rawLogs = await readLogEntries(env, root, from, to);
        let peopleItems = [];
        try {
          const peopleFile = await ghGetFile(env, peoplePath, branch);
          if (peopleFile && Array.isArray(peopleFile.items)) {
            peopleItems = peopleFile.items;
          }
        } catch (peopleErr) {
          const msg = String(peopleErr || "");
          if (!msg.includes("404")) {
            console.error("Failed to load people for log metrics:", peopleErr);
          }
        }
        const teamMap = new Map();
        for (const person of peopleItems) {
          if (!person || typeof person !== 'object') continue;
          const name = (person.name || '').trim();
          if (!name) continue;
          const teamName = (person.team || 'Ohne Team').trim() || 'Ohne Team';
          teamMap.set(name, teamName);
        }
        const metrics = __computeLogMetrics(rawLogs, { team, from, to }, teamMap);
        const headers = url.pathname === "/log/metrics" ? { "X-Endpoint-Deprecated": "true" } : undefined;
        return jsonResponse(metrics, 200, env, headers);
      }
      if (url.pathname === "/log/list" && request.method === "GET") {
        const from = url.searchParams.get("from"); const to = url.searchParams.get("to"); const out = []; const root = LOG_DIR(env);
        for (const day of dateRange(from, to)) {
          const y = day.slice(0,4), m = day.slice(5,7); const path = `${root.replace(/\/+$/,'')}/${y}-${m}/${day}.jsonl`;
          try {
              const file = await ghGetContent(env, path);
              if (file && file.content) { for (const line of file.content.split(/\n+/)) { if (!line.trim()) continue; try { out.push(JSON.parse(line)); } catch (parseErr){ console.warn(`Invalid JSON in log ${path}: ${line}`, parseErr); } } }
          } catch (getFileErr) { if (!String(getFileErr).includes('404')) console.error(`Error reading log file ${path}:`, getFileErr); }
        }
        out.sort((a,b)=> (b.ts||0) - (a.ts||0));
        return jsonResponse(out.slice(0, 5000), 200, env);
      }
      const logPath = env.GH_LOG_PATH || "data/logs.json";
      if (url.pathname === "/logs") {
          if (request.method === "GET") { let logData = { items: [], sha: null }; try { logData = await ghGetFile(env, logPath, branch); } catch(e) { console.error("Error legacy logs:", e); } return jsonResponse((logData.items || []).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)), 200, env); }
          if (request.method === "POST") { let newLogEntries; try { newLogEntries = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON" }, 400, env); } const logsToAdd = Array.isArray(newLogEntries) ? newLogEntries : [newLogEntries]; if (logsToAdd.length === 0) return jsonResponse({ success: true, added: 0 }, 200, env); let currentLogs = [], currentSha = null; try { const logData = await ghGetFile(env, logPath, branch); currentLogs = logData.items || []; currentSha = logData.sha; } catch (e) { if (!String(e).includes('404')) console.error("Error legacy logs POST:", e); } let updatedLogs = logsToAdd.concat(currentLogs); if (updatedLogs.length > MAX_LOG_ENTRIES) updatedLogs = updatedLogs.slice(0, MAX_LOG_ENTRIES); try { await ghPutFile(env, logPath, updatedLogs, currentSha, `add ${logsToAdd.length} log entries`); } catch (e) { /* Retry Logic */ } return jsonResponse({ success: true, added: logsToAdd.length }, 201, env); }
          if (request.method === "DELETE") { let logData = { items: [], sha: null }; try { logData = await ghGetFile(env, logPath, branch); } catch (e) { if (String(e).includes('404')) return jsonResponse({ success: true, message: "Logs already empty." }, 200, env); else throw e; } await ghPutFile(env, logPath, [], logData.sha, "clear logs"); return jsonResponse({ success: true, message: "Logs gelöscht." }, 200, env); }
      }

      /* ===== HubSpot Webhook ===== */
      if (url.pathname === "/hubspot" && request.method === "POST") {
        const raw = await request.text();
        const okSig = await verifyHubSpotSignatureV3(request, env, raw).catch(()=>false);
        if (!okSig) return jsonResponse({ error: "invalid signature" }, 401, env);
        let events = [];
        try { events = JSON.parse(raw); }
        catch { return jsonResponse({ error: "bad payload" }, 400, env); }
        if (!Array.isArray(events) || events.length === 0) return jsonResponse({ ok: true, processed: 0 }, 200, env);
        const wonIds = new Set(String(env.HUBSPOT_CLOSED_WON_STAGE_IDS || "").split(",").map(s=>s.trim()).filter(Boolean));
        if (wonIds.size === 0) return jsonResponse({ ok: true, processed: 0, warning: "No WON stage IDs." }, 200, env);
        let ghData = await ghGetFile(env, ghPath, branch);
        let itemsChanged = false;
        let lastDeal = null;

        for (const ev of events) {
          if (ev.subscriptionType === "object.propertyChange" && ev.propertyName === "dealstage") {
            const newStage = String(ev.propertyValue || "");
            const dealId = ev.objectId;

            if (!wonIds.has(newStage)) continue;

            try {
              console.log(`VERARBEITE "WON" DEAL: ${dealId}`);

              const deal = await hsFetchDeal(dealId, env);

              let companyName = "";
              const companyAssoc = deal?.associations?.companies?.results?.[0];
              if (companyAssoc && companyAssoc.id) {
                companyName = await hsFetchCompany(companyAssoc.id, env);
                deal.properties.fetched_company_name = companyName;
              }

              const ownerId = deal?.properties?.hubspot_owner_id;
              let ownerName = "";
              if (ownerId) {
                ownerName = await hsFetchOwner(ownerId, env);
                deal.properties.fetched_owner_name = ownerName;
              }

              const collaboratorIds = (deal?.properties?.hs_all_collaborator_owner_ids || "")
                .split(';')
                .filter(Boolean);

              const collaboratorPromises = collaboratorIds.map(id => hsFetchOwner(id, env));
              const collaboratorNames = (await Promise.all(collaboratorPromises)).filter(Boolean);
              deal.properties.fetched_collaborator_names = collaboratorNames;

              lastDeal = deal;
              upsertByHubSpotId(ghData.items, deal);
              ghData.items = canonicalizeEntries(ghData.items);
              itemsChanged = true;
            } catch (hsErr){
              console.error(`HubSpot API-Fehler (hsFetchDeal/hsFetchCompany/hsFetchOwner) bei Deal ${dealId}:`, hsErr);
            }
          }
        }
        if (itemsChanged) {
          try {
            await ghPutFile(env, ghPath, canonicalizeEntries(ghData.items), ghData.sha, "hubspot webhook upsert", branch);
            console.log(`Änderungen für ${events.length} Events erfolgreich auf GitHub gespeichert.`);
          } catch (e) {
            console.error("GitHub PUT (ghPutFile) FEHLER:", e);
          }
        }
        return jsonResponse({ ok: true, changed: itemsChanged, lastDeal }, 200, env);
      }

      console.log(`Route not found: ${request.method} ${url.pathname}`);
      return new Response("Not Found", { status: 404, headers: getCorsHeaders(env) });

    } catch (err) {
      console.error("Worker Error:", err, err.stack);
      return jsonResponse({ error: err.message || String(err) }, 500, env);
    }
  }
}; // Ende export default

// Hilfsfunktion dateRange
function* dateRange(from, to){
  const d1 = to   ? new Date(to  +'T00:00:00Z') : new Date();
  const d0 = from ? new Date(from+'T00:00:00Z') : new Date(d1.getTime()-13*24*3600*1000);
  if (d0 > d1) return;
  const maxRange = 90 * 24 * 3600 * 1000;
  if (d1.getTime() - d0.getTime() > maxRange) {
      const limitedStart = new Date(d1.getTime() - (maxRange - 24*3600*1000) );
       for(let d=new Date(limitedStart); d<=d1; d=new Date(d.getTime()+24*3600*1000)){
         yield d.toISOString().slice(0,10);
       }
  } else {
      for(let d=new Date(d0); d<=d1; d=new Date(d.getTime()+24*3600*1000)){
        yield d.toISOString().slice(0,10);
      }
  }
}
