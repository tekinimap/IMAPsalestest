/**
 * Cloudflare Worker – GitHub JSON/JSONL Proxy + HubSpot Webhook + Logbuch (v8.0 - Mehrfach-KV & Merge)
 * - NEU: Mehrfach-KV-Unterstützung, Merge-Endpunkt und aktualisierte Persistenzlogik.
 * - v8.8 (Gemini): Finale Version. Kombiniert Owner + Collaborators in 'list' mit 0% Zuweisung, um "Unvollständig" zu erzwingen.
 */

// Import für suggestEmailForName wurde hier entfernt.
import {
  toEpochMillis,
  extractFreigabedatumFromEntry,
  resolveFreigabedatum,
  computeLogMetrics,
} from './log-analytics-core.js';

const GH_API = "https://api.github.com";
const MAX_LOG_ENTRIES = 300; // Für Legacy Logs
const VALIDATION_CACHE_TTL_MS = 5 * 60 * 1000; // 5 Minuten

/* ------------------------ Utilities ------------------------ */

export const getCorsHeaders = (env, request) => {
  const configuredOriginRaw = typeof env?.ALLOWED_ORIGIN === 'string'
    ? env.ALLOWED_ORIGIN.trim()
    : '';
  const configuredOrigin = configuredOriginRaw === '*'
    ? ''
    : configuredOriginRaw;
  const requestOrigin = request && typeof request.headers?.get === 'function'
    ? String(request.headers.get('Origin') || '').trim()
    : '';

  let allowOrigin = configuredOrigin || requestOrigin;

  if (!allowOrigin && request && typeof request.headers?.get === 'function') {
    const referer = String(request.headers.get('Referer') || '').trim();
    if (referer) {
      try {
        const refererOrigin = new URL(referer).origin;
        if (refererOrigin) {
          allowOrigin = refererOrigin;
        }
      } catch (err) {
        console.warn('Unable to derive origin from referer for CORS handling:', err);
      }
    }
  }

  if (!allowOrigin) {
    allowOrigin = '*';
  }

  if (allowOrigin === '*' && requestOrigin) {
    allowOrigin = requestOrigin;
  }

  const headers = {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-HubSpot-Signature-V3, X-HubSpot-Request-Timestamp",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };

  if (allowOrigin !== "*") {
    headers["Access-Control-Allow-Credentials"] = "true";
  }

  return headers;
};

const jsonResponse = (data, status = 200, env, request, additionalHeaders = {}) => {
  const corsHeaders = getCorsHeaders(env, request);
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
function b64decodeUtf8(b64) { try { return decodeURIComponent(escape(atob(b64))); } catch { return atob(b64); } }
function base64ToUint8Array(value) {
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
function ghHeaders(env) {
  return {
    "Authorization": `Bearer ${env.GH_TOKEN || env.GITHUB_TOKEN}`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "imap-sales-worker/1.8",
  };
}

function rndId(prefix = 'item_') { const a = new Uint8Array(16); crypto.getRandomValues(a); return `${prefix}${[...a].map(b => b.toString(16).padStart(2, '0')).join('')}`; }
function todayStr() { return new Date().toISOString().slice(0, 10); }
const LOG_DIR = (env) => (env.GH_LOG_DIR || "data/logs");
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
async function throttle(delayMs) {
  const ms = Number(delayMs);
  if (Number.isFinite(ms) && ms > 0) {
    await sleep(ms);
  }
}

function normKV(v) { return String(v ?? '').trim(); }
function normalizeString(value) { return String(value ?? '').trim(); }

function normalizePersonRecord(person) {
  if (!person || typeof person !== 'object') return person;
  const normalized = { ...person };
  if (normalized.name != null) {
    normalized.name = String(normalized.name).trim();
  }
  if (normalized.team != null) {
    normalized.team = String(normalized.team).trim();
  }
  if (normalized.email != null) {
    const trimmedEmail = String(normalized.email).trim().toLowerCase();
    if (trimmedEmail) {
      normalized.email = trimmedEmail;
    } else {
      delete normalized.email;
    }
  }
  return normalized;
}

/**
 * Sehr leichte Cache-Implementierung für Validierungsendpunkte.
 * Die Worker-Laufzeit hält globale Variablen typischerweise warm,
 * sodass wir hier einen simplen Map-basierten Cache verwenden können.
 */
const validationCache = new Map();

function readValidationCache(key) {
  const entry = validationCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > VALIDATION_CACHE_TTL_MS) {
    validationCache.delete(key);
    return null;
  }
  return entry.value;
}

function writeValidationCache(key, value) {
  validationCache.set(key, { value, ts: Date.now() });
}

const EMAIL_HEADER_KEYS = [
  'cf-access-authenticated-user-email',
  'cf-access-user-email',
  'cf-access-email',
  'x-authenticated-user-email',
];

const NAME_HEADER_KEYS = [
  'cf-access-authenticated-user-name',
  'cf-access-user',
  'cf-access-authenticated-user',
  'x-authenticated-user',
];

function readFirstHeader(headers, keys) {
  for (const key of keys) {
    const value = headers.get(key);
    if (value && String(value).trim()) {
      return String(value).trim();
    }
  }
  return '';
}

function isAdminRequest(request, env) {
  const secret = normalizeString(env.ADMIN_SECRET || env.ADMIN_TOKEN);
  if (!secret) return false; // Fallback: if no secret is set, block access.

  const authHeader = normalizeString(request.headers.get('authorization'));
  const token = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7)
    : '';
  const headerSecret = normalizeString(request.headers.get('x-admin-secret'));

  return token === secret || headerSecret === secret;
}

async function resolveAccessIdentity(request, env, branch, peoplePath, cachedPeople) {
  const emailRaw = readFirstHeader(request.headers, EMAIL_HEADER_KEYS);
  const nameRaw = readFirstHeader(request.headers, NAME_HEADER_KEYS);
  let peopleItems = Array.isArray(cachedPeople) ? cachedPeople : null;
  if (!peopleItems) {
    try {
      const peopleFile = await ghGetFile(env, peoplePath, branch);
      if (peopleFile && Array.isArray(peopleFile.items)) {
        peopleItems = peopleFile.items;
      } else {
        peopleItems = [];
      }
    } catch (err) {
      const message = String(err || '');
      if (!message.includes('404')) {
        console.error('Failed to load people for identity resolution:', err);
      }
      peopleItems = [];
    }
  }

  const email = emailRaw.trim();
  const name = nameRaw.trim();
  const emailLower = email.toLowerCase();
  let matchedPerson = null;
  if (peopleItems && emailLower) {
    matchedPerson = peopleItems.find((person) => String(person?.email || '').trim().toLowerCase() === emailLower) || null;
  }
  if (!matchedPerson && peopleItems && name) {
    const nameLower = name.toLowerCase();
    matchedPerson = peopleItems.find((person) => String(person?.name || '').trim().toLowerCase() === nameLower) || null;
  }

  const displayName = matchedPerson?.name || name || '';
  return {
    email,
    rawName: name,
    name: displayName,
    person: matchedPerson,
    people: peopleItems || [],
  };
}
const MARKET_TEAM_TO_BU = new Map([
  ['vielfalt+', 'Public Impact'],
  ['evaluation und beteiligung', 'Public Impact'],
  ['nachhaltigkeit', 'Public Impact'],
  ['bundes- und landesbehörden', 'Organisational Excellence'],
  ['sozial- und krankenversicherungen', 'Organisational Excellence'],
  ['kommunalverwaltungen', 'Organisational Excellence'],
  ['internationale zusammenarbeit', 'Organisational Excellence'],
  ['changepartner', 'Organisational Excellence'],
]);

const DOCK_REWARD_STEPS = [0.5, 1, 1.5, 2];
const DOCK_REWARD_DEFAULT = 1;
const DOCK_REWARD_COMMENT_LIMIT = 280;

function normalizeDockRewardFactor(value) {
  const min = DOCK_REWARD_STEPS[0];
  const max = DOCK_REWARD_STEPS[DOCK_REWARD_STEPS.length - 1];
  const numeric = Number(value);
  const base = Number.isFinite(numeric) ? numeric : DOCK_REWARD_DEFAULT;
  const clamped = Math.min(max, Math.max(min, base));
  let nearest = DOCK_REWARD_STEPS[0];
  let diff = Math.abs(clamped - nearest);
  for (const step of DOCK_REWARD_STEPS) {
    const currentDiff = Math.abs(step - clamped);
    if (currentDiff < diff) {
      nearest = step;
      diff = currentDiff;
    }
  }
  return nearest;
}

function normalizeDockRewardComment(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.length > DOCK_REWARD_COMMENT_LIMIT) {
    return trimmed.slice(0, DOCK_REWARD_COMMENT_LIMIT);
  }
  return trimmed;
}

function deriveBusinessUnitFromTeamName(team) {
  const normalized = normalizeString(team).toLowerCase();
  if (!normalized) return '';
  if (MARKET_TEAM_TO_BU.has(normalized)) {
    return MARKET_TEAM_TO_BU.get(normalized);
  }
  return '';
}

function ensureDockMetadata(entry, options = {}) {
  if (!entry || typeof entry !== 'object') return entry;
  const source = normalizeString(entry.source).toLowerCase();
  const hasPhase = entry.dockPhase != null;
  const defaultPhase = options.defaultPhase;
  entry.dockRewardFactor = normalizeDockRewardFactor(entry.dockRewardFactor);
  entry.dockRewardComment = normalizeDockRewardComment(entry.dockRewardComment);
  if (!hasPhase && defaultPhase == null && source !== 'hubspot') {
    return entry;
  }

  let phase = Number(entry.dockPhase);
  if (!Number.isFinite(phase) || phase < 1) {
    if (defaultPhase != null) {
      phase = defaultPhase;
    } else if (source === 'hubspot') {
      phase = 1;
    } else {
      return entry;
    }
  }
  phase = Math.max(1, Math.min(4, phase));
  entry.dockPhase = phase;

  const history = entry.dockPhaseHistory && typeof entry.dockPhaseHistory === 'object'
    ? { ...entry.dockPhaseHistory }
    : {};
  const phaseKey = String(phase);
  if (!history[phaseKey]) {
    history[phaseKey] = Date.now();
  }
  entry.dockPhaseHistory = history;

  if (entry.dockBuApproved == null) {
    entry.dockBuApproved = false;
  }
  if (entry.dockBuApprovedAt == null && entry.dockBuApproved === false) {
    entry.dockBuApprovedAt = null;
  }
  if (entry.dockFinalAssignment == null) {
    entry.dockFinalAssignment = '';
  }
  if (entry.dockFinalAssignmentAt == null && !entry.dockFinalAssignment) {
    entry.dockFinalAssignmentAt = null;
  }
  if (entry.dockFinalAssignment === 'rahmen' && entry.projectType !== 'rahmen') {
    entry.projectType = 'rahmen';
  }
  return entry;
}

function isDockEntryActive(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const phase = Number(entry.dockPhase);
  if (Number.isFinite(phase) && phase >= 4) return false;
  const assignment = normalizeString(entry.dockFinalAssignment).toLowerCase();
  if (assignment === 'archived' || assignment === 'merged') return false;
  return true;
}

function findDuplicateKv(entries, kvList, selfId) {
  const normalized = uniqueNormalizedKvList(kvList || []);
  if (!normalized.length) return null;
  for (const entry of entries || []) {
    if (!entry || entry.id === selfId) continue;
    const current = kvListFrom(entry);
    if (!current.length) continue;
    const conflict = normalized.find((kv) => current.includes(kv));
    if (conflict) {
      return { conflict, entry };
    }
  }
  return null;
}

function validateProjectNumberUsage(entries, projectNumber, selfId) {
  const normalized = normalizeString(projectNumber);
  if (!normalized) return { valid: true };

  const matches = (entries || []).filter((entry) => {
    if (!entry || entry.id === selfId) return false;
    const pn = normalizeString(entry.projectNumber);
    if (!pn) return false;
    return pn.toLowerCase() === normalized.toLowerCase();
  });

  if (!matches.length) return { valid: true };

  const framework = matches.find((item) => normalizeString(item.projectType) === 'rahmen');
  if (framework) {
    return {
      valid: true,
      warning: {
        reason: 'RAHMENVERTRAG_FOUND',
        message: 'Es existiert ein Rahmenvertrag mit der gleichen Projektnummer.',
        relatedCardId: framework.id,
      },
    };
  }

  const fix = matches.find((item) => normalizeString(item.projectType) !== 'rahmen');
  if (fix) {
    return {
      valid: true,
      warning: {
        reason: 'PROJECT_EXISTS',
        message: 'Es existiert ein Auftrag mit der Projektnummer.',
        relatedCardId: fix.id,
      },
    };
  }

  return { valid: true };
}

function validateKvNumberUsage(entries, kvList, selfId) {
  const normalized = uniqueNormalizedKvList(kvList || []);
  if (!normalized.length) return { valid: true };

  const result = findDuplicateKv(entries, normalized, selfId);
  if (!result) return { valid: true };

  return {
    valid: false,
    reason: 'DUPLICATE_KV',
    message: 'Es existiert bereits ein Auftrag mit dieser KV-Nummer.',
    relatedCardId: result.entry?.id,
    conflictKv: result.conflict,
  };
}
function splitKvString(value) {
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
function uniqueNormalizedKvList(list) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const kv = normKV(raw);
    if (!kv) continue;
    if (!seen.has(kv)) {
      seen.add(kv);
      out.push(kv);
    }
  }
  return out;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      const candidate = value.map(v => normalizeString(v)).find(Boolean);
      if (candidate) return candidate;
      continue;
    }
    const normalized = normalizeString(value);
    if (normalized) return normalized;
  }
  return "";
}

function parseHubspotCheckbox(value, fallback = false) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return Boolean(fallback);
    if (['1', 'true', 'yes', 'ja', 'y', 'on', 'wahr'].includes(normalized)) {
      return true;
    }
    if (['0', 'false', 'no', 'nein', 'n', 'off'].includes(normalized)) {
      return false;
    }
  }
  return Boolean(fallback);
}
function kvListFrom(obj) {
  if (!obj || typeof obj !== 'object') return [];
  const arrayFields = ['kvNummern', 'kv_nummern', 'kvNumbers', 'kv_numbers', 'kvList', 'kv_list'];
  for (const field of arrayFields) {
    const value = obj[field];
    if (Array.isArray(value)) {
      const normalized = uniqueNormalizedKvList(value);
      if (normalized.length) return normalized;
    } else if (typeof value === 'string' && value.trim()) {
      const normalized = uniqueNormalizedKvList(splitKvString(value));
      if (normalized.length) return normalized;
    }
  }
  const singleFields = ['kv', 'kv_nummer', 'kvNummer', 'KV', 'kvnummer'];
  for (const field of singleFields) {
    const value = obj[field];
    if (Array.isArray(value)) {
      const normalized = uniqueNormalizedKvList(value);
      if (normalized.length) return normalized;
    } else if (value != null && String(value).trim()) {
      const normalized = uniqueNormalizedKvList(splitKvString(String(value)));
      if (normalized.length) return normalized;
    }
  }
  return [];
}
function applyKvList(entry, kvList) {
  const normalized = uniqueNormalizedKvList(kvList || []);
  entry.kvNummern = normalized;
  entry.kv_nummer = normalized[0] || '';
  entry.kv = entry.kv_nummer || '';
  return entry;
}
function ensureKvStructure(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  return applyKvList(entry, kvListFrom(entry));
}

function mergeEntryWithKvOverride(base, patch = {}) {
  const merged = { ...(base || {}), ...(patch || {}) };
  const kvList = kvListFrom(patch);
  const kvFields = [
    'kv',
    'kv_nummer',
    'kvNummer',
    'kvNummern',
    'kvNumbers',
    'kv_numbers',
    'kvList',
    'kv_list',
  ];
  const hasKvIntent = kvList.length > 0 || kvFields.some((key) => Object.prototype.hasOwnProperty.call(patch, key));

  if (kvList.length > 0) {
    applyKvList(merged, kvList);
  } else if (hasKvIntent) {
    merged.kvNummern = [];
    merged.kv_nummer = '';
    merged.kv = '';
  }

  return merged;
}

function indexTransactionKvs(entry, entryId, kvsAddedInThisBatch, itemsByKV) {
  if (!entry || typeof entry !== 'object') return;
  if (entry.projectType !== 'rahmen' || !Array.isArray(entry.transactions)) return;
  const ownerId = entryId || entry.id;
  entry.transactions.forEach(transaction => {
    const txKvs = kvListFrom(transaction);
    txKvs.forEach(txKv => {
      if (!txKv) return;
      if (kvsAddedInThisBatch) {
        kvsAddedInThisBatch.add(txKv);
      }
      if (itemsByKV && ownerId) {
        itemsByKV.set(txKv, ownerId);
      }
    });
  });
}

function logCalloffDealEvent(logs, entry, transaction, kv, reason, status, extra = {}) {
  if (!Array.isArray(logs)) return;
  logs.push({
    event: 'hubspot_calloff_deal',
    status,
    entryId: entry?.id,
    transactionId: transaction?.id,
    kv,
    reason,
    projectNumber: entry?.projectNumber || '',
    amount: toNumberMaybe(transaction?.amount),
    source: entry?.source || 'erp',
    ...extra,
  });
}


export function normalizeTransactionKv(transaction) {
  if (!transaction || typeof transaction !== 'object') return "";

  const list = kvListFrom(transaction);
  if (list.length) {
    return list[0];
  }

  return firstNonEmpty(
    transaction.kv_nummer,
    transaction.kvNummer,
    transaction.kv,
    transaction.kvnummer
  );
}

function findTransactionsNeedingCalloffDeal(beforeEntry, afterEntry) {
  const results = [];
  if (!afterEntry || typeof afterEntry !== 'object') return results;

  const afterList = Array.isArray(afterEntry.transactions) ? afterEntry.transactions : [];
  if (!afterList.length) return results;

  const beforeList = Array.isArray(beforeEntry?.transactions) ? beforeEntry.transactions : [];
  const beforeByKv = new Map();
  for (const tx of beforeList) {
    const kv = normalizeTransactionKv(tx);
    if (!kv) continue;
    beforeByKv.set(kv, tx);
  }

  for (const transaction of afterList) {
    if (!transaction || typeof transaction !== 'object') continue;
    const type = normalizeString(transaction.type || '').toLowerCase();
    if (type && type !== 'founder') continue;
    const kv = normalizeTransactionKv(transaction);
    if (!kv) continue;
    const hubspotId = firstNonEmpty(transaction.hubspotId, transaction.hs_object_id);
    if (!beforeByKv.has(kv)) {
      if (!hubspotId) {
        results.push({ transaction, kv, reason: 'new_kv' });
      }
      continue;
    }
    if (!hubspotId) {
      results.push({ transaction, kv, reason: 'missing_hubspot_id' });
    }
  }

  return results;
}

async function syncCalloffDealsForEntry(beforeEntry, updatedEntry, env, logs) {
  if (!updatedEntry || typeof updatedEntry !== 'object') return;
  if (normalizeString(updatedEntry.projectType || '') !== 'rahmen') return;

  const candidates = findTransactionsNeedingCalloffDeal(beforeEntry, updatedEntry);
  if (!candidates.length) return;

  const accessToken = normalizeString(env.HUBSPOT_ACCESS_TOKEN);
  if (!accessToken) {
    for (const { transaction, kv, reason } of candidates) {
      logCalloffDealEvent(logs, updatedEntry, transaction, kv, reason, 'skipped', {
        skipReason: 'missing_hubspot_access_token',
      });
    }
    return;
  }

  for (const { transaction, kv, reason } of candidates) {
    try {
      const result = await hsCreateCalloffDeal(transaction, updatedEntry, env);
      const hubspotId = normalizeString(result?.id);
      if (hubspotId) {
        transaction.hubspotId = hubspotId;
        transaction.hs_object_id = hubspotId;
      }
      logCalloffDealEvent(logs, updatedEntry, transaction, kv, reason, 'success', { hubspotId });
    } catch (err) {
      logCalloffDealEvent(logs, updatedEntry, transaction, kv, reason, 'failure', {
        error: String(err?.message || err || 'unknown_error'),
      });
    }
  }
}

function canonicalizeEntries(items) {
  return (items || []).map(entry => {
    const clone = { ...entry };
    if (Array.isArray(entry.kvNummern)) clone.kvNummern = [...entry.kvNummern];
    if (Array.isArray(entry.list)) clone.list = entry.list.map(item => ({ ...item }));
    if (Array.isArray(entry.rows)) clone.rows = entry.rows.map(row => ({ ...row }));
    if (Array.isArray(entry.weights)) clone.weights = entry.weights.map(w => ({ ...w }));
    if (Array.isArray(entry.transactions)) clone.transactions = entry.transactions.map(t => ({ ...t }));
    if (Array.isArray(entry.comments)) clone.comments = entry.comments.map(c => ({ ...c }));
    if (Array.isArray(entry.attachments)) clone.attachments = entry.attachments.map(a => ({ ...a }));
    if (Array.isArray(entry.history)) clone.history = entry.history.map(h => ({ ...h }));
    if (entry.dockPhaseHistory && typeof entry.dockPhaseHistory === 'object') {
      clone.dockPhaseHistory = { ...entry.dockPhaseHistory };
    }
    ensureDockMetadata(clone);
    return ensureKvStructure(clone);
  });
}
function mergeKvLists(...lists) {
  const combined = [];
  for (const list of lists) {
    if (!list) continue;
    if (Array.isArray(list)) combined.push(...list);
  }
  return uniqueNormalizedKvList(combined);
}
function entriesShareKv(kvList, entry) {
  if (!kvList || !kvList.length) return false;
  const existingList = kvListFrom(entry);
  if (!existingList.length) return false;
  return kvList.some(kv => existingList.includes(kv));
}
function mergeContributionLists(entries, totalAmount) {
  const total = Number(totalAmount) || 0;
  const map = new Map();
  for (const entry of entries) {
    const list = Array.isArray(entry?.list) ? entry.list : [];
    for (const item of list) {
      if (!item) continue;
      const keyBase = item.key || item.name || item.id || `contrib_${map.size + 1}`;
      const key = String(keyBase);
      const money = toNumberMaybe(item.money ?? item.amount ?? item.value) || 0;
      const name = item.name || item.key || key;
      if (!map.has(key)) {
        map.set(key, { ...item, key, name, money });
      } else {
        const existing = map.get(key);
        existing.money += money;
      }
    }
  }
  const result = [];
  for (const value of map.values()) {
    const normalized = { ...value };
    normalized.money = Math.round((normalized.money + Number.EPSILON) * 100) / 100;
    normalized.pct = total > 0 ? Math.round((normalized.money / total) * 10000) / 100 : 0;
    result.push(normalized);
  }
  return result;
}

/* ------------------------ Log Analytics ------------------------ */


// Hilfsfunktionen
function toNumberMaybe(v) { if (v == null || v === '') return null; if (typeof v === 'number' && Number.isFinite(v)) return v; if (typeof v === 'string') { let t = v.trim().replace(/\s/g, ''); if (t.includes(',') && (!t.includes('.') || /\.\d{3},\d{1,2}$/.test(t))) { t = t.replace(/\./g, '').replace(',', '.'); } else { t = t.replace(/,/g, ''); } const n = Number(t); return Number.isFinite(n) ? n : null; } return null; }
function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') {
    return '';
  }

  for (const key of keys) {
    if (!(key in obj)) continue;
    const value = obj[key];
    if (value == null) continue;

    if (typeof value === 'number') {
      if (Number.isFinite(value)) {
        return String(value);
      }
      continue;
    }

    if (typeof value === 'string') {
      const normalized = value.trim();
      if (normalized) {
        return normalized;
      }
      continue;
    }

    if (typeof value === 'boolean') {
      return value ? 'true' : 'false';
    }

    if (typeof value === 'object') {
      continue;
    }

    const normalized = normalizeString(value);
    if (normalized) {
      return normalized;
    }
  }

  return '';
}
function fieldsOf(obj) {
  const kvList = kvListFrom(obj);
  const freigabeTs = extractFreigabedatumFromEntry(obj);
  return {
    kv: kvList[0] || '',
    kvList,
    projectNumber: pick(obj, ['projectNumber', 'projektnummer', 'project_no', 'projectId', 'Projektnummer']),
    title: pick(obj, ['title', 'titel', 'projectTitle', 'dealname', 'name', 'Titel']),
    client: pick(obj, ['client', 'kunde', 'customer', 'account', 'Kunde']),
    amount: toNumberMaybe(pick(obj, ['amount', 'wert', 'value', 'sum', 'betrag', 'Betrag'])),
    source: pick(obj, ['source']),
    ...(freigabeTs != null ? { freigabedatum: freigabeTs } : {}),
  };
}
function validateRow(row) {
  const f = fieldsOf(row || {});
  if (!f.kvList.length && !isFullEntry(row)) return { ok: false, reason: 'missing_kv', message: 'KV-Nummer fehlt', ...f };
  if (f.amount === null && !isFullEntry(row)) return { ok: false, reason: 'missing_amount', message: 'Betrag fehlt oder ist ungültig', ...f };
  return { ok: true, ...f };
}
const isFullEntry = (obj) => !!(obj && (obj.projectType || obj.transactions || Array.isArray(obj.rows) || Array.isArray(obj.list) || Array.isArray(obj.weights)));

/* ------------------------ GitHub I/O ------------------------ */
async function ghGetFile(env, path, branch) { const url = `${GH_API}/repos/${env.GH_REPO}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch || env.GH_BRANCH)}`; const r = await fetch(url, { headers: ghHeaders(env) }); if (r.status === 404) return { items: [], sha: null }; if (!r.ok) throw new Error(`GitHub GET ${path} failed: ${r.status} ${await r.text()}`); const data = await r.json(); const raw = (data.content || "").replace(/\n/g, ""); const content = raw ? b64decodeUtf8(raw) : "[]"; let items = []; try { items = content.trim() ? JSON.parse(content) : []; if (!Array.isArray(items)) items = []; } catch (e) { console.error("Failed to parse JSON from GitHub:", content); throw new Error(`Failed to parse JSON from ${path}: ${e.message}`); } return { items, sha: data.sha }; }
async function ghPutFile(env, path, items, sha, message, branch) { const url = `${GH_API}/repos/${env.GH_REPO}/contents/${encodeURIComponent(path)}`; const body = { message: message || `update ${path}`, content: b64encodeUtf8(JSON.stringify(items, null, 2)), branch: branch || env.GH_BRANCH, ...(sha ? { sha } : {}), }; const r = await fetch(url, { method: "PUT", headers: { ...ghHeaders(env), "Content-Type": "application/json" }, body: JSON.stringify(body), }); if (!r.ok) throw new Error(`GitHub PUT ${path} failed (${r.status}): ${await r.text()}`); return r.json(); }
async function ghGetContent(env, path) { const url = `${GH_API}/repos/${env.GH_REPO}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(env.GH_BRANCH)}`; const r = await fetch(url, { headers: ghHeaders(env) }); if (r.status === 404) return { content: "", sha: null }; if (!r.ok) throw new Error(`GitHub GET ${path} failed: ${r.status} ${await r.text()}`); const data = await r.json(); const raw = (data.content || "").replace(/\n/g, ""); return { content: raw ? b64decodeUtf8(raw) : "", sha: data.sha }; }
async function ghPutContent(env, path, content, sha, message) { const url = `${GH_API}/repos/${env.GH_REPO}/contents/${encodeURIComponent(path)}`; const body = { message: message || `update ${path}`, content: b64encodeUtf8(content), branch: env.GH_BRANCH, ...(sha ? { sha } : {}), }; const r = await fetch(url, { method: "PUT", headers: { ...ghHeaders(env), "Content-Type": "application/json" }, body: JSON.stringify(body), }); if (!r.ok) throw new Error(`GitHub PUT ${path} failed (${r.status}): ${await r.text()}`); return r.json(); }

function parseGitHubRepo(repo) {
  if (!repo || typeof repo !== 'string') return null;
  const parts = repo.trim().split('/').filter(Boolean);
  if (parts.length !== 2) return null;
  return { owner: parts[0], name: parts[1] };
}

async function ghGraphql(env, query, variables) {
  const token = env.GH_TOKEN || env.GITHUB_TOKEN;
  if (!token) throw new Error('GitHub token missing for GraphQL request');
  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      ...ghHeaders(env),
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    const message = json?.errors?.map(err => err?.message).filter(Boolean).join('; ') || `${response.status}`;
    throw new Error(`GitHub GraphQL error (${message})`);
  }
  if (json?.errors?.length) {
    const message = json.errors.map(err => err?.message).filter(Boolean).join('; ');
    throw new Error(`GitHub GraphQL error (${message || 'unknown'})`);
  }
  return json?.data;
}

const LOG_MONTH_QUERY = `
  query($owner: String!, $name: String!, $expression: String!) {
    repository(owner: $owner, name: $name) {
      object(expression: $expression) {
        ... on Tree {
          entries {
            name
            object {
              ... on Blob {
                text
                byteSize
                isBinary
              }
            }
          }
        }
      }
    }
  }
`;

function parseLogLinesInto(target, content, path) {
  if (!content) return;
  const lines = String(content).split(/\n+/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      target.push(JSON.parse(trimmed));
    } catch (parseErr) {
      console.warn(`Failed to parse log entry in ${path}:`, parseErr, trimmed);
    }
  }
}

async function readLogEntriesViaRest(env, rootDir, dates) {
  const entries = [];
  for (const day of dates) {
    const y = day.slice(0, 4);
    const m = day.slice(5, 7);
    const path = `${rootDir}/${y}-${m}/${day}.jsonl`;
    try {
      const file = await ghGetContent(env, path);
      parseLogLinesInto(entries, file?.content || '', path);
    } catch (err) {
      const msg = String(err || '');
      if (!msg.includes('404')) {
        console.error(`Error reading log file ${path}:`, err);
      }
    }
  }
  return entries;
}

async function readLogEntriesViaGraphql(env, rootDir, dates, options = {}) {
  const { totalBudget = LOG_SUBREQUEST_BUDGET, reserve = LOG_SUBREQUEST_RESERVE } = options;
  const repo = parseGitHubRepo(env.GH_REPO);
  if (!repo) {
    throw new Error('GH_REPO must be in "owner/name" format for GraphQL log fetch');
  }
  const branch = env.GH_BRANCH || 'main';
  const grouped = new Map();
  for (const day of dates) {
    const monthKey = day.slice(0, 7);
    if (!grouped.has(monthKey)) {
      grouped.set(monthKey, new Set());
    }
    grouped.get(monthKey).add(day);
  }

  const monthCount = grouped.size;
  let fallbackBudget = Math.max(0, Math.trunc(totalBudget) - monthCount - Math.max(0, Math.trunc(reserve)));
  const entries = [];
  const satisfiedDays = new Set();
  const fallbackQueue = [];
  for (const [monthKey, daySet] of grouped) {
    const directory = [rootDir, monthKey].filter(Boolean).join('/');
    const expression = `${branch}:${directory}`;
    let data;
    try {
      data = await ghGraphql(env, LOG_MONTH_QUERY, {
        owner: repo.owner,
        name: repo.name,
        expression,
      });
    } catch (err) {
      console.error(`GraphQL log fetch failed for ${directory}:`, err);
      throw err;
    }

    const tree = data?.repository?.object;
    const entriesInTree = Array.isArray(tree?.entries) ? tree.entries : [];
    if (!entriesInTree.length) {
      continue;
    }

    for (const entry of entriesInTree) {
      if (!entry || typeof entry.name !== 'string') continue;
      if (!entry.name.endsWith('.jsonl')) continue;
      const fullDay = entry.name.replace(/\.jsonl$/i, '');
      if (!daySet.has(fullDay)) continue;
      const blob = entry.object;
      const path = `${directory}/${entry.name}`;
      if (blob && blob.isBinary === false && typeof blob.text === 'string') {
        parseLogLinesInto(entries, blob.text, path);
        satisfiedDays.add(fullDay);
        continue;
      }
      // Fallback für große Dateien oder fehlende Inhalte.
      fallbackQueue.push({ path, day: fullDay });
    }
  }

  let limited = false;
  if (fallbackQueue.length) {
    fallbackQueue.sort((a, b) => a.day.localeCompare(b.day));
    let toFetch = fallbackQueue;
    if (fallbackBudget < fallbackQueue.length) {
      const safeBudget = Math.max(0, fallbackBudget);
      const skipCount = fallbackQueue.length - safeBudget;
      if (skipCount > 0) {
        limited = true;
        toFetch = safeBudget > 0 ? fallbackQueue.slice(-safeBudget) : [];
        console.warn(`GraphQL fallback limited to ${toFetch.length} files due to subrequest budget (${skipCount} skipped).`);
      }
    }

    for (const item of toFetch) {
      if (fallbackBudget <= 0) break;
      fallbackBudget -= 1;
      try {
        const file = await ghGetContent(env, item.path);
        parseLogLinesInto(entries, file?.content || '', item.path);
        satisfiedDays.add(item.day);
      } catch (err) {
        const msg = String(err || '');
        if (!msg.includes('404')) {
          console.error(`Error reading log file ${item.path}:`, err);
        }
        if (msg.includes('Too many subrequests')) {
          limited = true;
          break;
        }
      }
    }

    if (fallbackBudget <= 0 && satisfiedDays.size < dates.length) {
      limited = true;
    }
  }

  return { entries, limited };
}
async function appendFile(env, path, text, message) { let tries = 0; const maxTries = 3; while (true) { tries++; const cur = await ghGetContent(env, path); const next = (cur.content || "") + text; try { const r = await ghPutContent(env, path, next, cur.sha, message); return { sha: r.content?.sha, path: r.content?.path }; } catch (e) { const s = String(e || ""); if (s.includes("sha") && tries < maxTries) { await new Promise(r => setTimeout(r, 300 * tries)); continue; } throw e; } } }

/* ------------------------ Logging (JSONL pro Tag) ------------------------ */
async function logJSONL(env, events) {
  if (!events || !events.length) return;
  const dateStr = todayStr();
  const y = dateStr.slice(0, 4), m = dateStr.slice(5, 7);
  const root = LOG_DIR(env);
  const path = `${root.replace(/\/+$/, '')}/${y}-${m}/${dateStr}.jsonl`;
  const text = events.map(event => {
    const logTs = Date.now();
    const payload = { ...event };
    const freigabeTs = resolveFreigabedatum(payload, logTs);
    if (freigabeTs != null) payload.freigabedatum = freigabeTs;
    // Falls kein Freigabedatum gefunden wird, fällt resolveFreigabedatum auf den Log-Zeitstempel zurück.
    const serialized = { ts: logTs, ...payload };
    if (freigabeTs != null) serialized.freigabedatum = freigabeTs;
    return JSON.stringify(serialized);
  }).join("\n") + "\n";
  try {
    await appendFile(env, path, text, `log ${events.length} events`);
  } catch (logErr) {
    console.error(`Failed to write to log file ${path}:`, logErr);
  }
}

const MAX_FALLBACK_LOG_DAYS = 45;
const LOG_SUBREQUEST_BUDGET = 47;
const LOG_SUBREQUEST_RESERVE = 3;

async function readLogEntries(env, rootDir, from, to) {
  const trimmedRoot = (rootDir || '').replace(/\/+$/, '');
  const dates = Array.from(dateRange(from, to));
  if (!dates.length) {
    return { entries: [], limited: false };
  }

  try {
    const graphqlResult = await readLogEntriesViaGraphql(env, trimmedRoot, dates, {
      totalBudget: LOG_SUBREQUEST_BUDGET,
      reserve: LOG_SUBREQUEST_RESERVE,
    });
    return graphqlResult;
  } catch (err) {
    console.error('GraphQL log fetch failed, falling back to REST:', err);
  }

  const limitedDates = dates.slice(-MAX_FALLBACK_LOG_DAYS);
  if (limitedDates.length < dates.length) {
    console.warn(`Log metrics fallback limited to the most recent ${limitedDates.length} days to avoid subrequest limits.`);
  }
  const entries = await readLogEntriesViaRest(env, trimmedRoot, limitedDates);
  return { entries, limited: limitedDates.length < dates.length };
}

/* ------------------------ HubSpot ------------------------ */
const HUBSPOT_UPDATE_MAX_ATTEMPTS = 5;

function formatHubspotAmount(value) {
  const numeric = toNumberMaybe(value);
  if (numeric == null) return null;
  const rounded = Math.round((numeric + Number.EPSILON) * 100) / 100;
  return rounded.toFixed(2);
}

async function hsCreateCalloffDeal(transaction, parentEntry, env) {
  const token = normalizeString(env.HUBSPOT_ACCESS_TOKEN);
  if (!token) throw new Error('HUBSPOT_ACCESS_TOKEN missing');

  if (!transaction || typeof transaction !== 'object') {
    throw new Error('transaction missing');
  }

  const kv = normalizeTransactionKv(transaction);
  if (!kv) {
    throw new Error('transaction kv_nummer missing');
  }

  const amountFormatted = formatHubspotAmount(transaction.amount);
  const projectNumber = firstNonEmpty(
    transaction.projectNumber,
    transaction.projektnummer,
    parentEntry?.projectNumber,
    parentEntry?.projektnummer
  );

  const freigabeTs = extractFreigabedatumFromEntry(transaction) ?? extractFreigabedatumFromEntry(parentEntry) ?? Date.now();
  const closedate = Number.isFinite(Number(freigabeTs)) ? Math.trunc(Number(freigabeTs)) : Date.now();

  const parentTitle = firstNonEmpty(
    transaction.title,
    parentEntry?.title,
    parentEntry?.dealname
  );
  const clientName = firstNonEmpty(transaction.client, parentEntry?.client);
  const dealname = firstNonEmpty(
    parentTitle && kv ? `${parentTitle} – ${kv}` : '',
    clientName && kv ? `${clientName} – ${kv}` : '',
    kv
  );

  const dealstage = firstNonEmpty(
    env.HUBSPOT_CALL_OFF_STAGE_ID,
    env.HUBSPOT_CALL_OFF_DEALSTAGE,
    String(env.HUBSPOT_CLOSED_WON_STAGE_IDS || '').split(',').map(part => part.trim())
  );

  const pipeline = firstNonEmpty(
    env.HUBSPOT_CALL_OFF_PIPELINE,
    env.HUBSPOT_PIPELINE_ID,
    env.HUBSPOT_DEFAULT_PIPELINE
  );

  const ownerId = firstNonEmpty(
    transaction.hubspotOwnerId,
    transaction.hubspot_owner_id,
    parentEntry?.hubspotOwnerId,
    parentEntry?.hubspot_owner_id,
    parentEntry?.ownerId,
    parentEntry?.owner_id
  );

  const companyId = firstNonEmpty(
    transaction.hubspotCompanyId,
    transaction.hubspot_company_id,
    parentEntry?.hubspotCompanyId,
    parentEntry?.hubspot_company_id,
    parentEntry?.companyId,
    parentEntry?.company_id
  );

  const properties = {
    dealname,
    kvnummer: kv,
    closedate: String(closedate),
  };

  if (amountFormatted != null) {
    properties.amount = amountFormatted;
  }
  if (projectNumber) {
    properties.projektnummer = projectNumber;
  }
  if (dealstage) {
    properties.dealstage = dealstage;
  }
  if (pipeline) {
    properties.pipeline = pipeline;
  }
  if (ownerId) {
    properties.hubspot_owner_id = ownerId;
  }

  const associations = [];
  if (companyId) {
    associations.push({
      to: { id: companyId },
      types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }],
    });
  }

  const payload = { properties };
  if (associations.length) {
    payload.associations = associations;
  }

  const delayCandidates = [env.HUBSPOT_CALL_DELAY_MS, env.HUBSPOT_THROTTLE_MS, env.THROTTLE_MS];
  const delayMs = delayCandidates
    .map(value => Number(value))
    .find(value => Number.isFinite(value) && value >= 0) ?? 200;
  await throttle(delayMs);

  const response = await fetch('https://api.hubapi.com/crm/v3/objects/deals', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HubSpot create deal failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  const newId = firstNonEmpty(data.id, data.properties?.hs_object_id);
  if (!newId) {
    throw new Error('HubSpot create deal response missing id');
  }

  return { id: String(newId), raw: data };
}

function collectHubspotSyncPayload(before, after) {
  if (!after || typeof after !== 'object') return null;

  const dealId = normalizeString(after.hubspotId || after.hs_object_id);
  const beforeFields = fieldsOf(before || {});
  const afterFields = fieldsOf(after || {});

  const previousProjectNumber = normalizeString(beforeFields.projectNumber);
  const nextProjectNumber = normalizeString(afterFields.projectNumber);
  const previousKvNummer = normalizeString(beforeFields.kv);
  const nextKvNummer = normalizeString(afterFields.kv);
  const previousFreigabeTs = extractFreigabedatumFromEntry(before);
  const nextFreigabeTs = extractFreigabedatumFromEntry(after);
  const previousClosedate = previousFreigabeTs != null ? Math.trunc(Number(previousFreigabeTs)) : null;
  const nextClosedate = nextFreigabeTs != null ? Math.trunc(Number(nextFreigabeTs)) : null;

  const previousAmount = toNumberMaybe(before?.amount ?? beforeFields.amount);
  const nextAmount = toNumberMaybe(after?.amount ?? afterFields.amount);
  let amountChanged = false;
  if (previousAmount == null && nextAmount != null) {
    amountChanged = true;
  } else if (previousAmount != null && nextAmount == null) {
    amountChanged = true;
  } else if (Number.isFinite(previousAmount) && Number.isFinite(nextAmount)) {
    amountChanged = Math.abs(previousAmount - nextAmount) >= 0.01;
  }

  const properties = {};
  if (previousProjectNumber !== nextProjectNumber) {
    properties.projektnummer = nextProjectNumber;
  }
  if (previousKvNummer !== nextKvNummer) {
    properties.kvnummer = nextKvNummer;
  }
  if (previousClosedate !== nextClosedate) {
    properties.closedate = nextClosedate;
  }
  if (amountChanged && nextAmount != null) {
    properties.amount = nextAmount;
    if (!('projektnummer' in properties)) {
      properties.projektnummer = nextProjectNumber;
    }
    if (!('kvnummer' in properties)) {
      properties.kvnummer = nextKvNummer;
    }
  }

  if (!Object.keys(properties).length) {
    return null;
  }

  return {
    dealId,
    entryId: after.id,
    source: after.source,
    previous: {
      projektnummer: previousProjectNumber,
      kvnummer: previousKvNummer,
      amount: previousAmount,
      closedate: previousClosedate,
    },
    next: {
      projektnummer: nextProjectNumber,
      kvnummer: nextKvNummer,
      amount: nextAmount,
      closedate: nextClosedate,
    },
    properties,
  };
}

async function hsUpdateDealProperties(dealId, properties, env) {
  const normalizedDealId = normalizeString(dealId);
  if (!normalizedDealId) {
    return { ok: false, error: 'missing_deal_id', attempts: 0, status: null };
  }
  const token = normalizeString(env.HUBSPOT_ACCESS_TOKEN);
  if (!token) {
    return { ok: false, error: 'missing_hubspot_access_token', attempts: 0, status: null };
  }

  const payload = {};
  if (properties && typeof properties === 'object') {
    if (properties.projektnummer != null) payload.projektnummer = normalizeString(properties.projektnummer);
    if (properties.kvnummer != null) payload.kvnummer = normalizeString(properties.kvnummer);
    if ('closedate' in properties) {
      const ts = toEpochMillis(properties.closedate);
      payload.closedate = ts != null ? String(Math.trunc(ts)) : null;
    }
    if (properties.amount != null) {
      const formattedAmount = formatHubspotAmount(properties.amount);
      if (formattedAmount != null) {
        payload.amount = formattedAmount;
      }
    }
  }

  if (!Object.keys(payload).length) {
    return { ok: true, skipped: true, attempts: 0, status: null };
  }

  const backoffRaw = Number(env.HUBSPOT_RETRY_BACKOFF_MS ?? env.RETRY_BACKOFF_MS);
  const backoffMs = Number.isFinite(backoffRaw) && backoffRaw > 0 ? backoffRaw : DEFAULT_HUBSPOT_RETRY_BACKOFF_MS;
  let attempt = 0;
  let lastStatus = null;
  let lastError = '';

  while (attempt < HUBSPOT_UPDATE_MAX_ATTEMPTS) {
    attempt++;
    if (attempt > 1) {
      const delay = backoffMs * Math.pow(2, attempt - 2);
      await sleep(delay);
    }
    try {
      const response = await fetch(`https://api.hubapi.com/crm/v3/objects/deals/${encodeURIComponent(normalizedDealId)}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ properties: payload }),
      });

      lastStatus = response.status;
      const responseText = await response.text();

      if (response.ok) {
        return { ok: true, status: response.status, attempts: attempt };
      }

      lastError = responseText || `HTTP ${response.status}`;
      if ((response.status === 429 || response.status >= 500) && attempt < HUBSPOT_UPDATE_MAX_ATTEMPTS) {
        continue;
      }

      return { ok: false, status: response.status, attempts: attempt, error: lastError };
    } catch (err) {
      lastError = String(err);
      if (attempt >= HUBSPOT_UPDATE_MAX_ATTEMPTS) {
        return { ok: false, status: lastStatus, attempts: attempt, error: lastError };
      }
    }
  }

  return { ok: false, status: lastStatus, attempts: HUBSPOT_UPDATE_MAX_ATTEMPTS, error: lastError || 'unknown_error' };
}

const DEFAULT_HUBSPOT_THROTTLE_MS = 1100;
const DEFAULT_HUBSPOT_RETRY_BACKOFF_MS = 3000;

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function processHubspotSyncQueue(env, updates, options = {}) {
  if (!updates || !updates.length) return;
  const { mode = 'single', reason = 'hubspot_sync_after_persist' } = options;

  const logs = [];
  let successCount = 0;
  let skippedMissingId = 0;
  let failureCount = 0;

  if (mode === 'batch') {
    const token = normalizeString(env.HUBSPOT_ACCESS_TOKEN);
    if (!token) {
      failureCount += updates.length;
      logs.push({
        event: 'hubspot_update',
        mode,
        reason,
        status: 'failure',
        error: 'missing_hubspot_access_token',
      });
      logs.push({
        event: 'hubspot_update_summary',
        mode,
        reason,
        total: updates.length,
        successCount,
        skippedMissingId,
        failureCount,
      });
      await logJSONL(env, logs);
      return;
    }

    const aggregated = new Map();
    for (const update of updates) {
      if (!update || typeof update !== 'object') continue;
      const properties = update.properties && typeof update.properties === 'object' ? { ...update.properties } : {};
      if (!Object.keys(properties).length) continue;
      const normalizedDealId = normalizeString(update.dealId);
      if (!normalizedDealId) {
        skippedMissingId++;
        logs.push({
          event: 'hubspot_update',
          mode,
          reason,
          status: 'skipped',
          skipReason: 'missing_hubspot_id',
          entryId: update.entryId,
          source: update.source || 'worker',
          properties,
          previous: update.previous,
          next: update.next,
        });
        continue;
      }

      if (!aggregated.has(normalizedDealId)) {
        aggregated.set(normalizedDealId, {
          dealId: normalizedDealId,
          properties: {},
          entryIds: new Set(),
          sources: new Set(),
          previous: {},
          next: {},
        });
      }
      const record = aggregated.get(normalizedDealId);
      if (update.entryId) record.entryIds.add(update.entryId);
      if (update.source) record.sources.add(update.source);
      if (update.previous && typeof update.previous === 'object') {
        record.previous = { ...record.previous, ...update.previous };
      }
      if (update.next && typeof update.next === 'object') {
        record.next = { ...record.next, ...update.next };
      }

      for (const [key, value] of Object.entries(properties)) {
        if (key === 'amount') {
          const formatted = formatHubspotAmount(value ?? update.next?.amount);
          if (formatted != null) {
            record.properties.amount = formatted;
          }
        } else if (key === 'projektnummer' || key === 'kvnummer') {
          record.properties[key] = normalizeString(value ?? (update.next ? update.next[key] : ''));
        } else if (key === 'closedate') {
          const ts = toEpochMillis(value ?? (update.next ? update.next.closedate : null));
          record.properties.closedate = ts != null ? String(Math.trunc(ts)) : null;
        } else {
          record.properties[key] = value;
        }
      }
    }

    const aggregatedUpdates = [...aggregated.values()].filter(item => Object.keys(item.properties).length);
    if (!aggregatedUpdates.length) {
      if (logs.length) {
        logs.push({
          event: 'hubspot_update_summary',
          mode,
          reason,
          total: updates.length,
          successCount,
          skippedMissingId,
          failureCount,
        });
        await logJSONL(env, logs);
      }
      return;
    }

    const throttleMsRaw = Number(env.HUBSPOT_THROTTLE_MS ?? env.THROTTLE_MS);
    const throttleMs = Number.isFinite(throttleMsRaw) && throttleMsRaw >= 0 ? throttleMsRaw : DEFAULT_HUBSPOT_THROTTLE_MS;
    const backoffRaw = Number(env.HUBSPOT_RETRY_BACKOFF_MS ?? env.RETRY_BACKOFF_MS);
    const baseBackoff = Number.isFinite(backoffRaw) && backoffRaw > 0 ? backoffRaw : DEFAULT_HUBSPOT_RETRY_BACKOFF_MS;

    const batches = chunkArray(aggregatedUpdates, 100);

    for (const batch of batches) {
      if (throttleMs) {
        await sleep(throttleMs);
      }
      const payload = {
        inputs: batch.map(item => ({
          id: item.dealId,
          properties: item.properties,
        })),
      };

      let attempt = 0;
      let lastError = '';
      let lastStatus = null;
      let success = false;

      while (attempt < HUBSPOT_UPDATE_MAX_ATTEMPTS) {
        attempt++;
        if (attempt > 1) {
          const delay = baseBackoff * Math.pow(2, attempt - 2);
          await sleep(delay);
        }
        try {
          const response = await fetch('https://api.hubapi.com/crm/v3/objects/deals/batch/update', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
          });
          lastStatus = response.status;
          const responseText = await response.text();
          if (response.ok) {
            success = true;
            successCount += batch.length;
            for (const record of batch) {
              logs.push({
                event: 'hubspot_update',
                mode,
                reason,
                status: 'success',
                entryIds: Array.from(record.entryIds).filter(Boolean),
                sources: Array.from(record.sources).filter(Boolean),
                dealId: record.dealId,
                properties: record.properties,
                previous: record.previous,
                next: record.next,
                attempts: attempt,
                httpStatus: response.status,
              });
            }
            break;
          }

          lastError = responseText || `HTTP ${response.status}`;
          if ((response.status === 429 || response.status >= 500) && attempt < HUBSPOT_UPDATE_MAX_ATTEMPTS) {
            continue;
          }
          failureCount += batch.length;
          for (const record of batch) {
            logs.push({
              event: 'hubspot_update',
              mode,
              reason,
              status: 'failure',
              entryIds: Array.from(record.entryIds).filter(Boolean),
              sources: Array.from(record.sources).filter(Boolean),
              dealId: record.dealId,
              properties: record.properties,
              previous: record.previous,
              next: record.next,
              attempts: attempt,
              httpStatus: response.status,
              error: lastError,
            });
          }
          break;
        } catch (err) {
          lastError = String(err || 'unknown_error');
          if (attempt >= HUBSPOT_UPDATE_MAX_ATTEMPTS) {
            failureCount += batch.length;
            for (const record of batch) {
              logs.push({
                event: 'hubspot_update',
                mode,
                reason,
                status: 'exception',
                entryIds: Array.from(record.entryIds).filter(Boolean),
                sources: Array.from(record.sources).filter(Boolean),
                dealId: record.dealId,
                properties: record.properties,
                previous: record.previous,
                next: record.next,
                attempts: attempt,
                error: lastError,
              });
            }
          }
        }
      }

    }
  } else {
    for (const update of updates) {
      if (!update || typeof update !== 'object') continue;
      const properties = update.properties && typeof update.properties === 'object' ? { ...update.properties } : {};
      if (!Object.keys(properties).length) continue;
      const normalizedDealId = normalizeString(update.dealId);
      if (!normalizedDealId) {
        skippedMissingId++;
        logs.push({
          event: 'hubspot_update',
          mode,
          reason,
          status: 'skipped',
          skipReason: 'missing_hubspot_id',
          entryId: update.entryId,
          source: update.source || 'worker',
          properties,
          previous: update.previous,
          next: update.next,
        });
        continue;
      }

      try {
        const result = await hsUpdateDealProperties(normalizedDealId, properties, env);
        if (result.ok && !result.skipped) {
          successCount++;
        } else if (!result.ok) {
          failureCount++;
        }

        const logEntry = {
          event: 'hubspot_update',
          mode,
          reason,
          entryId: update.entryId,
          dealId: normalizedDealId,
          source: update.source || 'worker',
          properties,
          previous: update.previous,
          next: update.next,
          attempts: result.attempts,
          status: result.ok ? (result.skipped ? 'skipped' : 'success') : 'failure',
        };

        if (result.status != null) logEntry.httpStatus = result.status;
        if (result.error) logEntry.error = result.error;

        logs.push(logEntry);
      } catch (err) {
        failureCount++;
        logs.push({
          event: 'hubspot_update',
          mode,
          reason,
          entryId: update.entryId,
          dealId: normalizedDealId,
          source: update.source || 'worker',
          properties,
          previous: update.previous,
          next: update.next,
          status: 'exception',
          error: String(err || 'unknown_error'),
        });
      }
    }
  }

  logs.push({
    event: 'hubspot_update_summary',
    mode,
    reason,
    total: updates.length,
    successCount,
    skippedMissingId,
    failureCount,
  });

  await logJSONL(env, logs);
}

function enqueueHubspotSync(ctx, env, updates) {
  if (!updates || !updates.length) {
    return;
  }

  const pending = processHubspotSyncQueue(env, updates.map(update => ({ ...update })));

  const handleError = (err) => {
    console.error('HubSpot sync task failed', err);
  };

  if (ctx && typeof ctx.waitUntil === 'function') {
    try {
      ctx.waitUntil(pending.catch(handleError));
    } catch (err) {
      console.error('Unable to queue HubSpot sync task', err);
      pending.catch(handleError);
    }
  } else {
    pending.catch(handleError);
  }
}

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
export async function hsFetchDeal(dealId, env) {
  if (!env.HUBSPOT_ACCESS_TOKEN) throw new Error("HUBSPOT_ACCESS_TOKEN missing");

  const properties = [
    "dealname", "amount", "dealstage", "closedate", "hs_object_id", "pipeline",
    "hubspot_owner_id",
    "hs_all_collaborator_owner_ids",
    "flagship_projekt",
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

export function upsertByHubSpotId(entries, deal) {
  const id = String(deal?.id || deal?.properties?.hs_object_id || "");
  if (!id) {
    return { action: 'skip', reason: 'missing_hubspot_id' };
  }

  const name = deal?.properties?.dealname || `Deal ${id}`;
  const amount = Number(deal?.properties?.amount || 0);

  const companyName = deal?.properties?.fetched_company_name || "";
  const ownerName = deal?.properties?.fetched_owner_name || "";
  const collaboratorNames = deal?.properties?.fetched_collaborator_names || [];
  const closeDate = toEpochMillis(deal?.properties?.closedate);

  const kvList = kvListFrom(deal?.properties);
  const projectNumber = normalizeString(firstNonEmpty(
    deal?.properties?.projektnummer,
    deal?.properties?.projectNumber,
    deal?.properties?.project_no,
    deal?.properties?.projectId,
    deal?.properties?.Projektnummer
  ));

  const idx = entries.findIndex(e => String(e.hubspotId || "") === id);

  if (idx < 0 && projectNumber && kvList.length) {
    const conflict = entries.find(entry => {
      if (!entry) return false;
      if (String(entry.hubspotId || "") === id) return false;
      const entryProjectNumber = normalizeString(fieldsOf(entry).projectNumber);
      if (!entryProjectNumber || entryProjectNumber !== projectNumber) return false;
      const entryKvs = kvListFrom(entry);
      return entryKvs.some(kv => kvList.includes(kv));
    });
    if (conflict) {
      return {
        action: 'skip',
        reason: 'duplicate_project_kv',
        hubspotId: id,
        projectNumber,
        kvList,
        conflictingEntryId: conflict.id,
      };
    }
  }

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

  const previousKv = idx >= 0 ? kvListFrom(entries[idx]) : [];

  const previousEntry = idx >= 0 ? entries[idx] : null;
  const marketTeamRaw = firstNonEmpty(
    deal?.properties?.market_team,
    deal?.properties?.marketTeam,
    deal?.properties?.market_team__c,
    deal?.properties?.marketteam
  );
  const previousMarketTeam = normalizeString(previousEntry?.marketTeam || previousEntry?.market_team);
  const marketTeam = normalizeString(marketTeamRaw) || previousMarketTeam;
  const businessUnit = normalizeString(previousEntry?.businessUnit) || deriveBusinessUnitFromTeamName(marketTeam);
  const assessmentOwner = normalizeString(firstNonEmpty(
    deal?.properties?.einschaetzung_abzugeben_von,
    deal?.properties?.einschätzung_abzugeben_von,
    deal?.properties?.einschaetzungAbzugebenVon,
    deal?.properties?.einschaetzung_abzugeben_von,
    previousEntry?.assessmentOwner,
    previousEntry?.assessment_owner,
    ownerName
  ));
  const flagshipProjekt = parseHubspotCheckbox(
    deal?.properties?.flagship_projekt,
    previousEntry?.flagship_projekt === true
  );

  const base = {
    id: previousEntry?.id || rndId('hubspot_'),
    hubspotId: id,
    title: name,
    amount,
    source: "hubspot",
    projectType: "fix",
    projectNumber: previousEntry?.projectNumber || "",
    client: companyName,
    submittedBy: ownerName,
    list: salesList,
    updatedAt: Date.now(),
    marketTeam,
    market_team: marketTeam,
    businessUnit,
    assessmentOwner,
    dockBuApproved: previousEntry?.dockBuApproved === true,
    dockBuApprovedAt: previousEntry?.dockBuApprovedAt || null,
    dockFinalAssignment: previousEntry?.dockFinalAssignment || '',
    dockFinalAssignmentAt: previousEntry?.dockFinalAssignmentAt || null,
    dockPhase: previousEntry?.dockPhase,
    flagship_projekt: flagshipProjekt,
    freigabedatum: closeDate != null ? closeDate : previousEntry?.freigabedatum || null,
  };

  if (projectNumber) {
    base.projectNumber = projectNumber;
  }

  if (previousEntry?.dockPhaseHistory && typeof previousEntry.dockPhaseHistory === 'object') {
    base.dockPhaseHistory = { ...previousEntry.dockPhaseHistory };
  }

  const nextKvList = previousKv.length ? previousKv : kvList;
  if (nextKvList.length) {
    applyKvList(base, nextKvList);
  }

  const normalized = ensureDockMetadata(ensureKvStructure(base), { defaultPhase: previousEntry?.dockPhase ?? 1 });
  if (idx >= 0) {
    entries[idx] = ensureDockMetadata({ ...entries[idx], ...normalized });
    return { action: 'update', hubspotId: id, entry: entries[idx] };
  }

  const createdEntry = normalized;
  entries.push(createdEntry);
  return { action: 'create', hubspotId: id, entry: createdEntry };
}

/* ------------------------ Router ------------------------ */
export default {
  async fetch(request, env, ctx) {
    const addCorsToResponse = (response) => {
      const corsHeaders = getCorsHeaders(env, request);

      if (!response) {
        return new Response(null, { status: 500, headers: corsHeaders });
      }

      const headers = new Headers(response.headers || {});
      for (const [key, value] of Object.entries(corsHeaders)) {
        if (!headers.has(key)) {
          headers.set(key, value);
        }
      }

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: getCorsHeaders(env, request) });
    }

    const respond = (data, status = 200, arg3, arg4) => {
      let headers = {};
      if (arg3 === env) {
        headers = arg4 || {};
      } else if (arg3 && typeof arg3 === 'object' && arg4 === undefined) {
        headers = arg3;
      } else if (arg3 && typeof arg3 === 'object') {
        headers = arg3;
      }
      return addCorsToResponse(jsonResponse(data, status, env, request, headers));
    };

    try {
      const url = new URL(request.url);
      const pathname = url.pathname.replace(/\/+$/, '') || '/';
      const ghPath = env.GH_PATH || "data/entries.json";
      const peoplePath = env.GH_PEOPLE_PATH || "data/people.json";
      const branch = env.GH_BRANCH;
      const saveEntries = async (items, sha, message) => {
        const payload = canonicalizeEntries(items);
        return ghPutFile(env, ghPath, payload, sha, message, branch);
      };

      if (pathname === "/session" && request.method === "GET") {
        const identity = await resolveAccessIdentity(request, env, branch, peoplePath);
        const person = identity.person
          ? {
            id: identity.person.id,
            name: identity.person.name,
            team: identity.person.team || '',
            email: identity.person.email || '',
          }
          : null;
        return respond({
          email: identity.email,
          name: identity.name,
          rawName: identity.rawName,
          person,
        }, 200, env);
      }

      /* ===== Validation Endpoints ===== */
      if (pathname === "/api/validation/check_kv" && request.method === "POST") {
        let body; try { body = await request.json(); } catch { return respond({ error: "Invalid JSON" }, 400, env); }
        const kvList = kvListFrom(body);
        const cacheKey = `kv:${kvList.join('|')}:id:${body.id || ''}`;
        const cached = readValidationCache(cacheKey);
        if (cached) return respond(cached, 200, env);

        const { items } = await ghGetFile(env, ghPath, branch);
        const active = items.filter(isDockEntryActive);
        const result = validateKvNumberUsage(active, kvList, body.id ? String(body.id) : undefined);
        writeValidationCache(cacheKey, result);
        return respond(result, 200, env);
      }

      if (pathname === "/api/validation/check_projektnummer" && request.method === "POST") {
        let body; try { body = await request.json(); } catch { return respond({ error: "Invalid JSON" }, 400, env); }
        const projectNumber = body.projectNumber || body.projektnummer || body.project_no || '';
        const cacheKey = `pn:${normalizeString(projectNumber).toLowerCase()}:id:${body.id || ''}`;
        const cached = readValidationCache(cacheKey);
        if (cached) return respond(cached, 200, env);

        const { items } = await ghGetFile(env, ghPath, branch);
        const active = items.filter(isDockEntryActive);
        const result = validateProjectNumberUsage(active, projectNumber, body.id ? String(body.id) : undefined);
        writeValidationCache(cacheKey, result);
        return respond(result, 200, env);
      }

      if (pathname === "/api/admin/validation/legacy_report" && request.method === "GET") {
        if (!isAdminRequest(request, env)) {
          return respond({ error: 'forbidden' }, 403, env);
        }
        const { items } = await ghGetFile(env, ghPath, branch);
        const active = items.filter(isDockEntryActive);
        const offenders = [];
        const seen = new Set();

        for (const entry of active) {
          const kvList = kvListFrom(entry);
          const conflict = findDuplicateKv(active, kvList, entry.id);
          if (conflict && conflict.entry) {
            const key = [entry.id, conflict.entry.id].sort().join('::');
            if (seen.has(key)) continue;
            seen.add(key);
            offenders.push({
              cardId: entry.id,
              title: entry.title || '',
              kvNummer: conflict.conflict,
              conflictingCardId: conflict.entry.id,
            });
          }
        }

        return respond(offenders, 200, env, { 'Content-Type': 'application/json; charset=utf-8' });
      }

      /* ===== Entries GET ===== */
      if (pathname === "/entries" && request.method === "GET") {
        const { items } = await ghGetFile(env, ghPath, branch);
        const normalized = canonicalizeEntries(items);
        return respond(normalized, 200, env);
      }
      if (pathname.startsWith("/entries/") && request.method === "GET") {
        const id = decodeURIComponent(pathname.split("/").pop());
        const { items } = await ghGetFile(env, ghPath, branch);
        const found = items.find(x => String(x.id) === id);
        if (!found) return respond({ error: "not found" }, 404, env);
        return respond(ensureKvStructure({ ...found }), 200, env);
      }

      /* ===== Entries POST (Single Create/Upsert) ===== */
      if (pathname === "/entries" && request.method === "POST") {
        let body; try { body = await request.json(); } catch { return respond({ error: "Invalid JSON body" }, 400, env); }
        const cur = await ghGetFile(env, ghPath, branch);
        const items = cur.items || [];
        let entry; let status = 201; let skipSave = false;
        const hubspotUpdates = [];

        if (isFullEntry(body)) { /* Create Full Entry Logic */
          const existingById = items.find(e => e.id === body.id);
          if (existingById) return respond({ error: "Conflict: ID exists. Use PUT." }, 409, env);
          entry = { id: body.id || rndId('entry_'), ...body, ts: body.ts || Date.now(), modified: undefined };
          if (Array.isArray(entry.transactions)) { entry.transactions = entry.transactions.map(t => ({ id: t.id || `trans_${Date.now()}_${Math.random().toString(16).slice(2)}`, ...t })); }
          ensureKvStructure(entry);
          ensureDockMetadata(entry);
          items.push(entry);
          const f = fieldsOf(entry); await logJSONL(env, [{ event: 'create', source: entry.source || 'manuell', after: entry, kv: f.kv, kvList: f.kvList, projectNumber: f.projectNumber, title: f.title, client: f.client, reason: 'manual_or_import' }]);
        } else { /* Upsert-by-KV Logic */
          const v = validateRow(body);
          if (!v.ok) { await logJSONL(env, [{ event: 'skip', source: v.source || 'erp', ...v }]); return respond({ error: 'validation_failed', ...v }, 422, env); }
          const kvList = v.kvList;
          const existing = items.find(e => entriesShareKv(kvList, e));
          if (!existing) {
            entry = { id: rndId('entry_'), kvNummern: kvList, projectNumber: v.projectNumber || '', title: v.title || '', client: v.client || '', amount: v.amount, source: v.source || 'erp', projectType: 'fix', ts: Date.now() };
            ensureKvStructure(entry);
            items.push(entry);
            await logJSONL(env, [{ event: 'create', source: entry.source, after: entry, kv: entry.kv, kvList: entry.kvNummern, projectNumber: entry.projectNumber, title: entry.title, client: entry.client, reason: 'excel_new' }]);
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
              ensureDockMetadata(existing);
              existing.modified = Date.now();
              const syncPayload = collectHubspotSyncPayload(before, existing);
              if (syncPayload) hubspotUpdates.push(syncPayload);
              await logJSONL(env, [{ event: 'update', source: existing.source || v.source || 'erp', before, after: existing, kv: existing.kv, kvList: existing.kvNummern, projectNumber: existing.projectNumber, title: existing.title, client: existing.client, reason: 'excel_override' }]);
            } else {
              skipSave = true; await logJSONL(env, [{ event: 'skip', source: existing.source || v.source || 'erp', kv: existing.kv, kvList: existing.kvNummern, projectNumber: existing.projectNumber, title: existing.title, client: existing.client, reason: 'no_change' }]);
            }
          }
        }
        if (!skipSave) {
          try { await saveEntries(items, cur.sha, `upsert entry: ${entry.kv || entry.id}`); }
          catch (e) {
            if (String(e).includes('sha') || String(e).includes('conflict')) {
              console.warn("Retrying PUT due to SHA conflict..."); await new Promise(r => setTimeout(r, 600));
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
          if (hubspotUpdates.length) {
            await processHubspotSyncQueue(env, hubspotUpdates, { reason: 'entries_post' });
          }
        }
        return respond(entry, status, env);
      }

      /* ===== Entries PUT (Single Update) ===== */
      if (pathname.startsWith("/entries/") && request.method === "PUT") {
        const id = decodeURIComponent(pathname.split("/").pop());
        let body; try { body = await request.json(); } catch { return respond({ error: "Invalid JSON" }, 400, env); }
        const cur = await ghGetFile(env, ghPath, branch);
        const idx = cur.items.findIndex(x => String(x.id) === id);
        if (idx < 0) return respond({ error: "not found" }, 404, env);
        const before = JSON.parse(JSON.stringify(cur.items[idx])); let updatedEntry;
        const hubspotUpdates = [];

        if (isFullEntry(body)) {
          if (Array.isArray(body.transactions)) { body.transactions = body.transactions.map(t => ({ id: t.id || `trans_${Date.now()}_${Math.random().toString(16).slice(2)}`, ...t })); }
          const merged = mergeEntryWithKvOverride(before, { ...body, id, modified: Date.now() });
          updatedEntry = ensureKvStructure(merged);
          ensureDockMetadata(updatedEntry);
          cur.items[idx] = updatedEntry;
          const syncPayload = collectHubspotSyncPayload(before, updatedEntry);
          if (syncPayload) hubspotUpdates.push(syncPayload);
          await saveEntries(cur.items, cur.sha, `update entry (full): ${id}`);
          const f = fieldsOf(updatedEntry); await logJSONL(env, [{ event: 'update', source: updatedEntry.source || 'manuell', before, after: updatedEntry, kv: f.kv, kvList: f.kvList, projectNumber: f.projectNumber, title: f.title, client: f.client }]);
        } else {
          const mergedForValidation = mergeEntryWithKvOverride(before, body);
          const v = validateRow({ ...mergedForValidation });
          if (!v.ok) { await logJSONL(env, [{ event: 'skip', ...v }]); return respond({ error: 'validation_failed', ...v }, 422, env); }
          const merged = mergeEntryWithKvOverride(before, { ...body, amount: v.amount, modified: Date.now() });
          updatedEntry = ensureKvStructure(merged);
          ensureDockMetadata(updatedEntry);
          cur.items[idx] = updatedEntry;
          const syncPayload = collectHubspotSyncPayload(before, updatedEntry);
          if (syncPayload) hubspotUpdates.push(syncPayload);
          await saveEntries(cur.items, cur.sha, `update entry (narrow): ${id}`);
          const f = fieldsOf(updatedEntry); const changes = {}; for (const k in body) { if (before[k] !== body[k]) changes[k] = body[k]; } if (before.amount !== v.amount) changes.amount = v.amount;
          if (changes.freigabedatum == null && updatedEntry.freigabedatum != null) { changes.freigabedatum = updatedEntry.freigabedatum; }
          const beforeSnapshot = { amount: before.amount };
          if (before.freigabedatum != null) beforeSnapshot.freigabedatum = before.freigabedatum;
          for (const key of Object.keys(changes)) {
            if (key === 'amount') continue;
            if (before[key] != null) {
              beforeSnapshot[key] = before[key];
            }
          }
          await logJSONL(env, [{ event: 'update', ...f, before: beforeSnapshot, after: changes }]);
        }
        if (hubspotUpdates.length) {
          await processHubspotSyncQueue(env, hubspotUpdates, { reason: 'entries_put' });
        }
        return respond(updatedEntry, 200, env);
      }

      /* ===== Entries DELETE (Single) ===== */
      if (pathname.startsWith("/entries/") && request.method === "DELETE") {
        const id = decodeURIComponent(pathname.split("/").pop());
        const cur = await ghGetFile(env, ghPath, branch);
        const before = cur.items.find(x => String(x.id) === id);
        if (!before) return respond({ ok: true, message: "already deleted?" }, 200, env);
        const next = cur.items.filter(x => String(x.id) !== id);
        await saveEntries(next, cur.sha, `delete entry: ${id}`);
        const f = fieldsOf(before); await logJSONL(env, [{ event: 'delete', reason: 'delete.entry', before, kv: f.kv, kvList: f.kvList, projectNumber: f.projectNumber, title: f.title, client: f.client }]);
        return respond({ ok: true }, 200, env);
      }

      /* ===== Entries POST /entries/bulk (Legacy - Nur schlanker KV-Upsert) ===== */
      if (pathname === "/entries/bulk" && request.method === "POST") {
        console.log("Processing legacy /entries/bulk");
        let payload; try { payload = await request.json(); } catch { return respond({ error: "Invalid JSON" }, 400, env); }
        const rows = Array.isArray(payload?.rows) ? payload.rows : [];
        if (!rows.length) return respond({ ok: false, message: 'rows empty' }, 400, env);
        const cur = await ghGetFile(env, ghPath, branch); const items = cur.items || [];
        const byKV = new Map(items.filter(x => x && kvListFrom(x).length).flatMap(x => kvListFrom(x).map(kv => [kv, x])));
        const logs = []; let created = 0, updated = 0, skipped = 0, errors = 0; let changed = false;
        for (const r of rows) {
          const validation = validateRow(r);
          if (!validation.ok) { skipped++; logs.push({ event: 'skip', ...validation }); continue; }
          const kvList = validation.kvList;
          const existing = items.find(item => entriesShareKv(kvList, item));
          if (!existing) {
            const entry = ensureKvStructure({ id: rndId('entry_'), kvNummern: kvList, projectNumber: validation.projectNumber || '', title: validation.title || '', client: validation.client || '', amount: validation.amount, source: validation.source || 'erp', projectType: 'fix', ts: Date.now() });
            items.push(entry); kvList.forEach(kv => byKV.set(kv, entry));
            logs.push({ event: 'create', source: entry.source, after: entry, kv: entry.kv, kvList: entry.kvNummern, projectNumber: entry.projectNumber, title: entry.title, client: entry.client, reason: 'legacy_bulk_new' });
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
              logs.push({ event: 'update', source: existing.source || validation.source || 'erp', before, after: existing, kv: existing.kv, kvList: existing.kvNummern, projectNumber: existing.projectNumber, title: existing.title, client: existing.client, reason: 'legacy_bulk_update' });
              updated++; changed = true;
            } else {
              logs.push({ event: 'skip', source: existing.source || validation.source || 'erp', kv: existing.kv, kvList: existing.kvNummern, projectNumber: existing.projectNumber, title: existing.title, client: existing.client, reason: 'legacy_bulk_no_change' });
              skipped++;
            }
          }
        }
        if (changed) {
          try { await saveEntries(items, cur.sha, `bulk import ${created}C ${updated}U ${skipped}S ${errors}E`); }
          catch (e) { if (String(e).includes('sha') || String(e).includes('conflict')) { console.warn("Retrying legacy bulk due to SHA conflict", e); return respond({ error: "Save conflict. Please retry import.", details: e.message }, 409, env); } else { throw e; } }
        }
        await logJSONL(env, logs);
        return respond({ ok: true, created, updated, skipped, errors, saved: changed }, 200, env);
      }

      /* ===== NEU: Entries POST /entries/bulk-v2 (Full Object Bulk) ===== */
      if (pathname === "/entries/bulk-v2" && request.method === "POST") {
        console.log("Processing /entries/bulk-v2");
        let payload; try { payload = await request.json(); } catch (e) { return respond({ error: "Invalid JSON", details: e.message }, 400, env); }
        const rows = Array.isArray(payload?.rows) ? payload.rows : [];
        if (!rows.length) return respond({ created: 0, updated: 0, skipped: 0, errors: 0, message: 'rows empty' }, 200, env);
        const cur = await ghGetFile(env, ghPath, branch);
        const items = cur.items || []; const logs = []; let created = 0, updated = 0, skipped = 0, errors = 0; let changed = false;
        const hubspotUpdates = [];
        const itemsById = new Map(items.map(item => [item.id, item]));
        const itemsByKV = new Map(); items.forEach(item => { const kvs = kvListFrom(item); kvs.forEach(kv => { if (kv && !itemsByKV.has(kv)) { itemsByKV.set(kv, item.id); } }); if (item.projectType === 'rahmen' && Array.isArray(item.transactions)) { item.transactions.forEach(t => { const tkvList = kvListFrom(t); tkvList.forEach(tkv => { if (tkv && !itemsByKV.has(tkv)) { itemsByKV.set(tkv, item.id); } }); }); } });
        const kvsAddedInThisBatch = new Set();

        for (const row of rows) {
          try {
            const kvList = kvListFrom(row);
            const isNew = !row.id || !itemsById.has(row.id);
            if (isNew) {
              if (!kvList.length && !isFullEntry(row)) { skipped++; logs.push({ event: 'skip', reason: 'missing_kv', ...fieldsOf(row) }); continue; }
              const conflictKv = kvList.find(kv => itemsByKV.has(kv) || kvsAddedInThisBatch.has(kv));
              if (conflictKv) { skipped++; logs.push({ event: 'skip', source: row.source || 'erp', kv: conflictKv, kvList, projectNumber: row.projectNumber, title: row.title, client: row.client, reason: itemsByKV.has(conflictKv) ? 'duplicate_kv_existing' : 'duplicate_kv_batch', detail: `KV '${conflictKv}' present.` }); console.warn(`Skipping create (duplicate KV): ${conflictKv}`); continue; }
              const newId = row.id || rndId('entry_');
              const entry = ensureKvStructure({ ...row, id: newId, ts: row.ts || Date.now(), modified: undefined });
              if (Array.isArray(entry.transactions)) { entry.transactions = entry.transactions.map(t => ({ id: t.id || `trans_${Date.now()}_${Math.random().toString(16).slice(2)}`, ...t })); }
              items.push(entry); itemsById.set(newId, entry); kvList.forEach(kv => { if (kv) { kvsAddedInThisBatch.add(kv); itemsByKV.set(kv, newId); } });
              indexTransactionKvs(entry, newId, kvsAddedInThisBatch, itemsByKV);
              await syncCalloffDealsForEntry(null, entry, env, logs);
              created++; changed = true; const f = fieldsOf(entry); logs.push({ event: 'create', source: entry.source || 'erp', after: entry, kv: f.kv, kvList: f.kvList, projectNumber: f.projectNumber, title: f.title, client: f.client, reason: 'bulk_import_new' });
            } else {
              const existingEntry = itemsById.get(row.id); if (!existingEntry) { errors++; logs.push({ event: 'error', source: row.source || 'erp', entryId: row.id, reason: 'update_id_not_found' }); console.error(`Update failed: ID ${row.id} not found.`); continue; }
              const newKvList = kvList.length ? kvList : kvListFrom(existingEntry);
              const conflictKv = newKvList.find(kv => { const owner = itemsByKV.get(kv); return owner && owner !== row.id; });
              if (conflictKv) { skipped++; logs.push({ event: 'skip', source: row.source || 'erp', kv: conflictKv, kvList: newKvList, projectNumber: row.projectNumber, title: row.title, client: row.client, reason: 'duplicate_kv_existing', detail: `KV '${conflictKv}' belongs to ${itemsByKV.get(conflictKv)}` }); continue; }
              const before = JSON.parse(JSON.stringify(existingEntry));
              const updatedEntry = ensureKvStructure({ ...existingEntry, ...row, id: row.id, modified: Date.now() });
              if (Array.isArray(updatedEntry.transactions)) { updatedEntry.transactions = updatedEntry.transactions.map(t => ({ id: t.id || `trans_${Date.now()}_${Math.random().toString(16).slice(2)}`, ...t })); }
              const indexToUpdate = items.findIndex(item => item.id === row.id);
              if (indexToUpdate !== -1) {
                items[indexToUpdate] = updatedEntry; itemsById.set(row.id, updatedEntry);
                const updatedKvs = kvListFrom(updatedEntry);
                const beforeKvs = kvListFrom(before);
                beforeKvs.forEach(kv => { if (!updatedKvs.includes(kv)) itemsByKV.delete(kv); });
                updatedKvs.forEach(kv => { itemsByKV.set(kv, row.id); kvsAddedInThisBatch.add(kv); });
                indexTransactionKvs(updatedEntry, row.id, kvsAddedInThisBatch, itemsByKV);
                await syncCalloffDealsForEntry(before, updatedEntry, env, logs);
                const syncPayload = collectHubspotSyncPayload(before, updatedEntry);
                if (syncPayload) hubspotUpdates.push(syncPayload);
                updated++; changed = true; const f = fieldsOf(updatedEntry); logs.push({ event: 'update', source: updatedEntry.source || 'erp', before, after: updatedEntry, kv: f.kv, kvList: f.kvList, projectNumber: f.projectNumber, title: f.title, client: f.client, reason: 'bulk_import_update' });
              } else { errors++; logs.push({ event: 'error', source: row.source || 'erp', entryId: row.id, reason: 'update_sync_error' }); console.error(`Update sync error: ID ${row.id}`); }
            }
          } catch (rowError) { errors++; logs.push({ event: 'error', source: row?.source || 'erp', ...fieldsOf(row), reason: 'processing_error', detail: rowError.message }); console.error("Error processing row:", row, rowError); }
        } // Ende for

        if (changed) {
          console.log(`Bulk v2: ${created} created, ${updated} updated. Attempting save.`);
          try { await saveEntries(items, cur.sha, `bulk v2 import: ${created}C ${updated}U ${skipped}S ${errors}E`); }
          catch (e) {
            if (String(e).includes('sha') || String(e).includes('conflict')) {
              console.error("Bulk v2 save failed (SHA conflict):", e); await logJSONL(env, logs); return respond({ error: "Save conflict. Please retry import.", details: e.message, created, updated, skipped, errors, saved: false }, 409, env);
            } else { console.error("Bulk v2 save failed (Other):", e); throw e; }
          }
        } else { console.log("Bulk v2: No changes detected."); }
        if (changed && hubspotUpdates.length) {
          await processHubspotSyncQueue(env, hubspotUpdates, { mode: 'batch', reason: 'entries_bulk_v2' });
        }
        await logJSONL(env, logs);
        return respond({ ok: true, created, updated, skipped, errors, saved: changed }, 200, env);
      } // Ende /entries/bulk-v2

      /* ===== NEU: Entries POST /entries/bulk-delete ===== */
      if (pathname === "/entries/bulk-delete" && request.method === "POST") {
        console.log("Processing /entries/bulk-delete");
        let body; try { body = await request.json(); } catch (e) { return respond({ error: "Invalid JSON", details: e.message }, 400, env); }
        const idsToDelete = Array.isArray(body?.ids) ? body.ids : [];
        if (!idsToDelete.length) return respond({ ok: true, deletedCount: 0, message: 'No IDs provided' }, 200, env);

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
            logs.push({ event: 'delete', reason: 'bulk_delete', before, ...f });
          });

          console.log(`Bulk Delete: Removing ${deletedCount} items. Attempting save.`);
          try {
            await saveEntries(nextItems, cur.sha, `bulk delete: ${deletedCount} entries`);
            await logJSONL(env, logs);
          } catch (e) {
            if (String(e).includes('sha') || String(e).includes('conflict')) {
              console.error("Bulk delete failed due to SHA conflict:", e);
              return respond({ error: "Save conflict. Please retry delete operation.", details: e.message, deletedCount: 0 }, 409, env);
            } else {
              console.error("Bulk delete failed with other error:", e);
              throw e;
            }
          }
        } else {
          console.log("Bulk Delete: No matching items found to delete.");
        }

        return respond({ ok: true, deletedCount: deletedCount }, 200, env);
      } // Ende /entries/bulk-delete

      /* ===== Entries POST /entries/merge ===== */
      if (pathname === "/entries/merge" && request.method === "POST") {
        console.log("Processing /entries/merge");
        let body; try { body = await request.json(); } catch (e) { return respond({ error: "Invalid JSON", details: e.message }, 400, env); }
        const ids = Array.isArray(body?.ids) ? body.ids.map(String) : [];
        if (!ids.length || ids.length < 2) return respond({ error: "at least_two_ids_required" }, 400, env);
        const targetId = body?.targetId ? String(body.targetId) : ids[0];
        const fieldResolutions = (body && typeof body.fieldResolutions === 'object') ? body.fieldResolutions : {};

        const cur = await ghGetFile(env, ghPath, branch);
        const items = cur.items || [];
        const selected = ids.map(id => {
          const entry = items.find(e => String(e.id) === id);
          if (!entry) throw new Error(`Entry ${id} not found`);
          return entry;
        });
        const targetEntry = selected.find(e => String(e.id) === targetId) || selected[0];
        if (!targetEntry) return respond({ error: "target_not_found" }, 404, env);

        const sourceEntries = selected.filter(e => e !== targetEntry);
        const projectNumbers = new Set(selected.map(e => String(e.projectNumber || '').trim()));
        if (projectNumbers.size > 1) return respond({ error: "project_number_mismatch", message: "Die Projektnummern stimmen nicht überein" }, 409, env);
        const invalidType = selected.find(e => (e.projectType && e.projectType !== 'fix'));
        if (invalidType) return respond({ error: "invalid_project_type", message: "Nur Fixaufträge können zusammengeführt werden" }, 422, env);

        const beforeTarget = JSON.parse(JSON.stringify(targetEntry));
        const beforeSources = sourceEntries.map(e => JSON.parse(JSON.stringify(e)));

        const mergedAmount = selected.reduce((sum, entry) => sum + (Number(entry.amount) || 0), 0);
        const mergedKvList = mergeKvLists(...selected.map(kvListFrom));
        const mergedList = mergeContributionLists(selected, mergedAmount);

        const pickValue = (field, fallback) => {
          const chosenId = fieldResolutions?.[field];
          if (!chosenId) return fallback;
          const candidate = selected.find((item) => String(item.id) === String(chosenId));
          if (!candidate) return fallback;
          return candidate[field] !== undefined ? candidate[field] : fallback;
        };

        const resolvedAmount = pickValue('amount', mergedAmount);
        targetEntry.amount = Number.isFinite(Number(resolvedAmount)) ? Number(resolvedAmount) : mergedAmount;
        targetEntry.list = mergedList;
        targetEntry.modified = Date.now();
        applyKvList(targetEntry, mergedKvList);
        ensureDockMetadata(targetEntry);
        ['title', 'client', 'projectNumber', 'projectType', 'submittedBy', 'source', 'marketTeam', 'businessUnit', 'assessmentOwner', 'flagship_projekt']
          .forEach((field) => {
            if (field in targetEntry || field in fieldResolutions) {
              targetEntry[field] = pickValue(field, targetEntry[field]);
            }
          });

        const additiveMerge = (existingList, ...lists) => {
          const merged = [];
          const seen = new Set();
          const createKey = (item) => {
            if (!item) return null;
            if (item.id) return String(item.id);
            // Create a canonical key for objects without an ID by sorting keys.
            return JSON.stringify(item, Object.keys(item).sort());
          };
          const pushItem = (item) => {
            if (!item) return;
            const key = createKey(item);
            if (key === null || seen.has(key)) return;
            seen.add(key);
            merged.push({ ...item });
          };
          (existingList || []).forEach(pushItem);
          lists.flat().forEach(pushItem);
          return merged;
        };

        const mergedComments = additiveMerge(targetEntry.comments, ...sourceEntries.map((e) => e.comments));
        const mergedAttachments = additiveMerge(targetEntry.attachments, ...sourceEntries.map((e) => e.attachments));
        const mergedHistory = additiveMerge(targetEntry.history, ...sourceEntries.map((e) => e.history));

        const mergedAtIso = new Date().toISOString();
        const mergedSourceSummary = sourceEntries.map((src) => `[ID: ${src.id}${src.title ? `, Titel: '${src.title}'` : ''}]`).join(', ');
        const systemComment = {
          id: rndId('comment_'),
          timestamp: mergedAtIso,
          author: 'SYSTEM',
          type: 'system_event',
          text: `SYSTEM: Diese Karte wurde am ${mergedAtIso} mit ${sourceEntries.length} Karte(n) zusammengeführt. Quell-Karten: ${mergedSourceSummary || 'k.A.'}`,
        };
        mergedComments.push(systemComment);

        targetEntry.comments = mergedComments;
        if (mergedAttachments.length) targetEntry.attachments = mergedAttachments;
        if (mergedHistory.length) targetEntry.history = mergedHistory;
        ensureKvStructure(targetEntry);

        const idsToRemove = new Set(sourceEntries.map(e => e.id));
        const nextItems = items.filter(entry => !idsToRemove.has(entry.id));
        nextItems[nextItems.findIndex(e => e.id === targetEntry.id)] = targetEntry;

        const logs = [
          { event: 'merge_target', targetId: targetEntry.id, mergedIds: sourceEntries.map(e => e.id), before: beforeTarget, after: targetEntry, ...fieldsOf(targetEntry), reason: 'merge_fix_orders' },
          ...beforeSources.map(src => ({
            event: 'merge_source',
            sourceId: src.id,
            mergedInto: targetEntry.id,
            before: src,
            after: { ...src, dockFinalAssignment: 'merged', dockFinalAssignmentAt: Date.now(), dockPhase: 4 },
            ...fieldsOf(src),
            reason: 'merge_fix_orders',
          }))
        ];

        try {
          await saveEntries(nextItems, cur.sha, `merge entries into ${targetEntry.id}`);
          await logJSONL(env, logs);
        } catch (e) {
          if (String(e).includes('sha') || String(e).includes('conflict')) {
            console.error("Merge save failed (SHA conflict):", e);
            return respond({ error: "save_conflict", details: e.message }, 409, env);
          }
          throw e;
        }

        return respond({ ok: true, mergedInto: targetEntry.id, removed: sourceEntries.map(e => e.id), entry: targetEntry }, 200, env);
      }


      /* ===== People Routes (Wiederhergestellt) ===== */
      if (pathname === "/people" && request.method === "GET") {
        try {
          const { items } = await ghGetFile(env, peoplePath, branch);
          const normalized = Array.isArray(items) ? items.map(normalizePersonRecord) : [];
          return respond(normalized, 200, env);
        } catch (err) {
          const message = String(err || '');
          if (message.includes('404')) {
            return respond([], 200, env);
          }
          throw err;
        }
      }

      // ##### KORRIGIERTER BLOCK START #####
      if (pathname === "/people" && request.method === "POST") {
        let body; try { body = await request.json(); } catch { return respond({ error: "Invalid JSON" }, 400, env); }
        const name = normalizeString(body.name);
        const team = normalizeString(body.team);
        if (!name || !team) return respond({ error: "Name and Team required" }, 400, env);

        // E-Mail-Logik (suggestEmailForName) ist hier entfernt.
        let email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';

        const cur = await ghGetFile(env, peoplePath, branch);
        const newPersonRaw = {
          ...body,
          id: body.id || rndId('person_'),
          name,
          team,
          createdAt: Date.now(),
        };
        if (email) {
          newPersonRaw.email = email;
        } else {
          delete newPersonRaw.email;
        }
        const newPerson = normalizePersonRecord(newPersonRaw);
        const currentItems = Array.isArray(cur.items) ? cur.items.slice() : [];
        currentItems.push(newPerson);
        await ghPutFile(env, peoplePath, currentItems.map(normalizePersonRecord), cur.sha, `add person ${name}`);
        return respond(newPerson, 201, env);
      }
      // ##### KORRIGIERTER BLOCK ENDE #####

      if (pathname === "/people" && request.method === "PUT") {
        let body; try { body = await request.json(); } catch { return respond({ error: "Invalid JSON" }, 400, env); }
        if (!body.id) return respond({ error: "ID missing" }, 400, env);
        const cur = await ghGetFile(env, peoplePath, branch);
        const idx = cur.items.findIndex(x => String(x.id) === String(body.id));
        if (idx < 0) return respond({ error: "not found" }, 404, env);
        const current = cur.items[idx] || {};
        const updated = { ...current };
        if (body.name !== undefined) {
          updated.name = normalizeString(body.name);
        }
        if (body.team !== undefined) {
          updated.team = normalizeString(body.team);
        }
        if (body.email !== undefined) {
          const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
          if (email) {
            updated.email = email;
          } else {
            delete updated.email;
          }
        }
        updated.updatedAt = Date.now();
        const normalizedPerson = normalizePersonRecord(updated);
        const nextItems = Array.isArray(cur.items) ? cur.items.slice() : [];
        nextItems[idx] = normalizedPerson;
        await ghPutFile(env, peoplePath, nextItems.map(normalizePersonRecord), cur.sha, `update person ${body.id}`);
        return respond(normalizedPerson, 200, env);
      }
      if (pathname === "/people" && request.method === "DELETE") {
        let body; try { body = await request.json(); } catch { return respond({ error: "Invalid JSON" }, 400, env); }
        const idToDelete = body?.id;
        if (!idToDelete) return respond({ error: "ID missing in request body" }, 400, env);
        const cur = await ghGetFile(env, peoplePath, branch);
        const initialLength = cur.items.length;
        const next = cur.items.filter(x => String(x.id) !== String(idToDelete));
        if (next.length === initialLength) return respond({ error: "not found" }, 404, env);
        await ghPutFile(env, peoplePath, next.map(normalizePersonRecord), cur.sha, `delete person ${idToDelete}`);
        return respond({ ok: true }, 200, env);
      }

      /* ===== Logs Routes ===== */
      if (pathname === "/log" && request.method === "POST") {
        let payload; try { payload = await request.json(); } catch { return respond({ error: "Invalid JSON" }, 400, env); }
        const dateStr = (payload.date || todayStr()); const y = dateStr.slice(0, 4), m = dateStr.slice(5, 7); const root = LOG_DIR(env);
        const path = `${root.replace(/\/+$/, '')}/${y}-${m}/${dateStr}.jsonl`; const text = (payload.lines || []).map(String).join("\n") + "\n";
        const result = await appendFile(env, path, text, `log: ${dateStr} (+${(payload.lines || []).length})`);
        return respond({ ok: true, path, committed: result }, 200, env);
      }
      const isMetricsRequest =
        request.method === "GET" && (pathname === "/log/metrics" || pathname === "/analytics/metrics");
      if (isMetricsRequest) {
        const from = url.searchParams.get("from") || undefined;
        const to = url.searchParams.get("to") || undefined;
        const team = (url.searchParams.get("team") || "").trim();
        const root = LOG_DIR(env);
        const logResult = await readLogEntries(env, root, from, to);
        const rawLogs = logResult.entries || [];
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
        const metrics = computeLogMetrics(rawLogs, { team, from, to }, teamMap);
        if (logResult.limited) {
          metrics.meta = { ...(metrics.meta || {}), rangeLimited: true };
        }
        const headers = {
          ...(
            pathname === "/log/metrics" ? { "X-Endpoint-Deprecated": "true" } : {}
          )
        };
        if (logResult.limited) {
          headers['X-Log-Range-Limited'] = 'true';
        }
        return respond(metrics, 200, env, headers);
      }
      if (pathname === "/log/list" && request.method === "GET") {
        const from = url.searchParams.get("from"); const to = url.searchParams.get("to"); const out = []; const root = LOG_DIR(env);
        for (const day of dateRange(from, to)) {
          const y = day.slice(0, 4), m = day.slice(5, 7); const path = `${root.replace(/\/+$/, '')}/${y}-${m}/${day}.jsonl`;
          try {
            const file = await ghGetContent(env, path);
            if (file && file.content) { for (const line of file.content.split(/\n+/)) { if (!line.trim()) continue; try { out.push(JSON.parse(line)); } catch (parseErr) { console.warn(`Invalid JSON in log ${path}: ${line}`, parseErr); } } }
          } catch (getFileErr) { if (!String(getFileErr).includes('404')) console.error(`Error reading log file ${path}:`, getFileErr); }
        }
        out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
        return respond(out.slice(0, 5000), 200, env);
      }
      const logPath = env.GH_LOG_PATH || "data/logs.json";
      if (pathname === "/logs") {
        if (request.method === "GET") { let logData = { items: [], sha: null }; try { logData = await ghGetFile(env, logPath, branch); } catch (e) { console.error("Error legacy logs:", e); } return respond((logData.items || []).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)), 200, env); }
        if (request.method === "POST") { let newLogEntries; try { newLogEntries = await request.json(); } catch { return respond({ error: "Invalid JSON" }, 400, env); } const logsToAdd = Array.isArray(newLogEntries) ? newLogEntries : [newLogEntries]; if (logsToAdd.length === 0) return respond({ success: true, added: 0 }, 200, env); let currentLogs = [], currentSha = null; try { const logData = await ghGetFile(env, logPath, branch); currentLogs = logData.items || []; currentSha = logData.sha; } catch (e) { if (!String(e).includes('404')) console.error("Error legacy logs POST:", e); } let updatedLogs = logsToAdd.concat(currentLogs); if (updatedLogs.length > MAX_LOG_ENTRIES) updatedLogs = updatedLogs.slice(0, MAX_LOG_ENTRIES); try { await ghPutFile(env, logPath, updatedLogs, currentSha, `add ${logsToAdd.length} log entries`); } catch (e) { /* Retry Logic */ } return respond({ success: true, added: logsToAdd.length }, 201, env); }
        if (request.method === "DELETE") { let logData = { items: [], sha: null }; try { logData = await ghGetFile(env, logPath, branch); } catch (e) { if (String(e).includes('404')) return respond({ success: true, message: "Logs already empty." }, 200, env); else throw e; } await ghPutFile(env, logPath, [], logData.sha, "clear logs"); return respond({ success: true, message: "Logs gelöscht." }, 200, env); }
      }

      /* ===== HubSpot Webhook ===== */
      if (pathname === "/hubspot" && request.method === "POST") {
        const raw = await request.text();
        const okSig = await verifyHubSpotSignatureV3(request, env, raw).catch(() => false);
        if (!okSig) return respond({ error: "invalid signature" }, 401, env);
        let events = [];
        try { events = JSON.parse(raw); }
        catch { return respond({ error: "bad payload" }, 400, env); }
        if (!Array.isArray(events) || events.length === 0) return respond({ ok: true, processed: 0 }, 200, env);
        const wonIds = new Set(String(env.HUBSPOT_CLOSED_WON_STAGE_IDS || "").split(",").map(s => s.trim()).filter(Boolean));
        if (wonIds.size === 0) return respond({ ok: true, processed: 0, warning: "No WON stage IDs." }, 200, env);
        let ghData = await ghGetFile(env, ghPath, branch);
        let itemsChanged = false;
        let lastDeal = null;
        const hubspotLogs = [];

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
              const upsertResult = upsertByHubSpotId(ghData.items, deal);
              if (upsertResult?.action === 'create' || upsertResult?.action === 'update') {
                ghData.items = canonicalizeEntries(ghData.items);
                itemsChanged = true;
              } else if (upsertResult?.action === 'skip' && upsertResult.reason === 'duplicate_project_kv') {
                hubspotLogs.push({
                  event: 'skip',
                  source: 'hubspot',
                  reason: upsertResult.reason,
                  message: 'Deal aus Hubspot wurde abgeblockt, weil Eintrag mit Projektnummer und KV-Nummer bereits vorhanden ist.',
                  hubspotId: upsertResult.hubspotId || String(dealId),
                  dealId: String(dealId),
                  projectNumber: upsertResult.projectNumber,
                  kvList: upsertResult.kvList,
                  kv: upsertResult.kvList?.[0] || '',
                  existingEntryId: upsertResult.conflictingEntryId,
                });
              }
            } catch (hsErr) {
              console.error(`HubSpot API-Fehler (hsFetchDeal/hsFetchCompany/hsFetchOwner) bei Deal ${dealId}:`, hsErr);
            }
          }
        }
        if (hubspotLogs.length) {
          await logJSONL(env, hubspotLogs);
        }
        if (itemsChanged) {
          try {
            await ghPutFile(env, ghPath, canonicalizeEntries(ghData.items), ghData.sha, "hubspot webhook upsert", branch);
            console.log(`Änderungen für ${events.length} Events erfolgreich auf GitHub gespeichert.`);
          } catch (e) {
            console.error("GitHub PUT (ghPutFile) FEHLER:", e);
          }
        }
        return respond({ ok: true, changed: itemsChanged, lastDeal }, 200, env);
      }

      // Static Asset Fallback (Pages Advanced Mode)
      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }

      console.log(`Route not found: ${request.method} ${pathname}`);
      return addCorsToResponse(jsonResponse({ error: "not_found" }, 404, env, request));

    } catch (err) {
      console.error("Worker Error:", err, err.stack);
      return addCorsToResponse(respond({ error: err.message || String(err) }, 500, env));
    }
  }
}; // Ende export default

// Hilfsfunktion dateRange
function* dateRange(from, to) {
  const d1 = to ? new Date(to + 'T00:00:00Z') : new Date();
  const d0 = from ? new Date(from + 'T00:00:00Z') : new Date(d1.getTime() - 13 * 24 * 3600 * 1000);
  if (d0 > d1) return;
  const maxRange = 90 * 24 * 3600 * 1000;
  if (d1.getTime() - d0.getTime() > maxRange) {
    const limitedStart = new Date(d1.getTime() - (maxRange - 24 * 3600 * 1000));
    for (let d = new Date(limitedStart); d <= d1; d = new Date(d.getTime() + 24 * 3600 * 1000)) {
      yield d.toISOString().slice(0, 10);
    }
  } else {
    for (let d = new Date(d0); d <= d1; d = new Date(d.getTime() + 24 * 3600 * 1000)) {
      yield d.toISOString().slice(0, 10);
    }
  }
}
