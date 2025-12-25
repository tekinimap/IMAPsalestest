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
} from '../log-analytics-core.js';
import {
  applyKvList,
  findDuplicateKv,
  firstNonEmpty,
  kvListFrom,
  normalizeString,
  normalizeTransactionKv,
  toNumberMaybe,
  uniqueNormalizedKvList,
  validateKvNumberUsage,
  validateProjectNumberUsage,
} from '../utils/validation.js';
import { sleep, throttle } from '../utils/time.js';
import {
  ghGetContent,
  ghGetFile,
  ghGraphql,
  ghPutContent,
  ghPutFile,
  parseGitHubRepo,
} from '../services/github.js';
import {
  collectHubspotSyncPayload,
  DEFAULT_HUBSPOT_RETRY_BACKOFF_MS,
  DEFAULT_HUBSPOT_THROTTLE_MS,
  hsCreateCalloffDeal,
  hsFetchCompany,
  hsFetchDeal,
  hsFetchOwner,
  hsUpdateDealProperties,
  HUBSPOT_UPDATE_MAX_ATTEMPTS,
} from '../services/hubspot.js';
export { normalizeTransactionKv } from '../utils/validation.js';
export { hsFetchDeal } from '../services/hubspot.js';
import { createRouter, normalizePathname } from './router.js';
import { registerSessionRoutes } from './controllers/session.js';
import { registerValidationRoutes } from './controllers/validation.js';
import { registerEntryRoutes } from './controllers/entries.js';
import { registerPeopleRoutes } from './controllers/people.js';
import { registerLogRoutes } from './controllers/logs.js';
import { registerHubspotRoutes } from './controllers/hubspot.js';

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

function rndId(prefix = 'item_') { const a = new Uint8Array(16); crypto.getRandomValues(a); return `${prefix}${[...a].map(b => b.toString(16).padStart(2, '0')).join('')}`; }
function todayStr() { return new Date().toISOString().slice(0, 10); }
const LOG_DIR = (env) => (env.GH_LOG_DIR || "data/logs");

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
  const normalizedSource = normalizeString(updatedEntry.source).toLowerCase();
  if (normalizedSource !== 'hubspot') return;

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
  let skippedNonHubspotSource = 0;
  let failureCount = 0;

  const filteredUpdates = [];
  for (const update of updates) {
    const normalizedSource = normalizeString(update?.source).toLowerCase();
    if (normalizedSource !== 'hubspot') {
      const properties = update?.properties && typeof update.properties === 'object' ? { ...update.properties } : {};
      skippedNonHubspotSource++;
      logs.push({
        event: 'hubspot_update',
        mode,
        reason,
        status: 'skipped',
        skipReason: 'non_hubspot_source',
        entryId: update?.entryId,
        source: update?.source || 'worker',
        properties,
        previous: update?.previous,
        next: update?.next,
      });
      continue;
    }
    filteredUpdates.push(update);
  }

  if (!filteredUpdates.length) {
    logs.push({
      event: 'hubspot_update_summary',
      mode,
      reason,
      total: updates.length,
      successCount,
      skippedMissingId,
      skippedNonHubspotSource,
      failureCount,
    });
    await logJSONL(env, logs);
    return;
  }

  if (mode === 'batch') {
    const token = normalizeString(env.HUBSPOT_ACCESS_TOKEN);
    if (!token) {
      failureCount += filteredUpdates.length;
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
        skippedNonHubspotSource,
        failureCount,
      });
      await logJSONL(env, logs);
      return;
    }

    const aggregated = new Map();
    for (const update of filteredUpdates) {
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
    for (const update of filteredUpdates) {
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
    skippedNonHubspotSource,
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

const router = createRouter();

registerSessionRoutes(router, { resolveAccessIdentity });
registerValidationRoutes(router, {
  ghGetFile,
  kvListFrom,
  validateKvNumberUsage,
  validateProjectNumberUsage,
  readValidationCache,
  writeValidationCache,
  findDuplicateKv,
  isDockEntryActive,
  isAdminRequest,
  normalizeString,
});
registerEntryRoutes(router, {
  ghGetFile,
  ghPutFile,
  kvListFrom,
  canonicalizeEntries,
  ensureKvStructure,
  ensureDockMetadata,
  isFullEntry,
  validateRow,
  entriesShareKv,
  mergeKvLists,
  rndId,
  logJSONL,
  fieldsOf,
  applyKvList,
  collectHubspotSyncPayload,
  processHubspotSyncQueue,
  mergeEntryWithKvOverride,
  mergeContributionLists,
  indexTransactionKvs,
  syncCalloffDealsForEntry,
});
registerPeopleRoutes(router, { ghGetFile, ghPutFile, normalizePersonRecord, normalizeString, rndId });
registerLogRoutes(router, {
  appendFile,
  todayStr,
  LOG_DIR,
  readLogEntries,
  ghGetContent,
  ghPutContent,
  ghGetFile,
  ghPutFile,
  computeLogMetrics,
  MAX_LOG_ENTRIES,
  dateRange,
});
registerHubspotRoutes(router, {
  verifyHubSpotSignatureV3,
  hsFetchDeal,
  hsFetchCompany,
  hsFetchOwner,
  collectHubspotSyncPayload,
  upsertByHubSpotId,
  ghGetFile,
  ghPutFile,
  canonicalizeEntries,
  logJSONL,
  deriveBusinessUnitFromTeamName,
  ensureDockMetadata,
  ensureKvStructure,
  fieldsOf,
  parseHubspotCheckbox,
  rndId,
});

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

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: getCorsHeaders(env, request) });
    }

    const respond = (data, status = 200, headers = {}) => (
      addCorsToResponse(jsonResponse(data, status, env, request, headers))
    );

    try {
      const url = new URL(request.url);
      const pathname = normalizePathname(url.pathname);
      const ghPath = env.GH_PATH || 'data/entries.json';
      const peoplePath = env.GH_PEOPLE_PATH || 'data/people.json';
      const branch = env.GH_BRANCH;
      const saveEntries = async (items, sha, message) => {
        const payload = canonicalizeEntries(items);
        return ghPutFile(env, ghPath, payload, sha, message, branch);
      };

      const routeResponse = await router.handle(request, {
        env,
        ctx,
        url,
        pathname,
        respond,
        addCorsToResponse,
        ghPath,
        peoplePath,
        branch,
        saveEntries,
      });

      if (routeResponse) return routeResponse;

      console.log(`Route not found: ${request.method} ${pathname}`);
      return respond({
        error: 'not_found',
        path: pathname,
        method: request.method,
        originalUrl: request.url
      }, 404);
    } catch (err) {
      console.error('Worker Error:', err, err.stack);
      return respond({ error: err.message || String(err) }, 500);
    }
  },
}; // Ende export default
