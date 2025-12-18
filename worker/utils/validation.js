export function normalizeString(value) {
  return String(value ?? '').trim();
}

export function normKV(v) {
  return normalizeString(v);
}

export function splitKvString(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return [];
  if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* ignore */
    }
  }
  return trimmed.split(/[,;|]+/);
}

export function uniqueNormalizedKvList(list) {
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

export function kvListFrom(obj) {
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

export function applyKvList(entry, kvList) {
  const normalized = uniqueNormalizedKvList(kvList || []);
  entry.kvNummern = normalized;
  entry.kv_nummer = normalized[0] || '';
  entry.kv = entry.kv_nummer || '';
  return entry;
}

export function firstNonEmpty(...values) {
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

export function toNumberMaybe(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    let t = v.trim().replace(/\s/g, '');
    if (t.includes(',') && (!t.includes('.') || /\.\d{3},\d{1,2}$/.test(t))) {
      t = t.replace(/\./g, '').replace(',', '.');
    } else {
      t = t.replace(/,/g, '');
    }
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
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

export function findDuplicateKv(entries, kvList, selfId) {
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

export function validateProjectNumberUsage(entries, projectNumber, selfId) {
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

export function validateKvNumberUsage(entries, kvList, selfId) {
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
