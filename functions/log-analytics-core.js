const existingAnalytics =
  typeof globalThis !== 'undefined' && globalThis.__LOG_ANALYTICS__
    ? globalThis.__LOG_ANALYTICS__
    : undefined;

function toEpochMillis(value) {
  if (value == null) return null;
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function extractFreigabedatumFromEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const direct = toEpochMillis(
    entry.freigabedatum ??
      entry.freigabeDatum ??
      entry.releaseDate ??
      entry.freigabe_datum
  );
  return direct != null ? direct : null;
}

function resolveFreigabedatum(logEntry, fallbackTs) {
  const fallback = Number.isFinite(Number(fallbackTs))
    ? Number(fallbackTs)
    : Date.now();
  if (!logEntry || typeof logEntry !== 'object') {
    return fallback;
  }

  const rootFreigabe = extractFreigabedatumFromEntry(logEntry);
  if (rootFreigabe != null) return rootFreigabe;

  const transaction = logEntry.transaction;
  if (transaction && typeof transaction === 'object') {
    const txDirect = extractFreigabedatumFromEntry(transaction);
    if (txDirect != null) return txDirect;
    const txAfter = extractFreigabedatumFromEntry(transaction.after);
    if (txAfter != null) return txAfter;
    const txBefore = extractFreigabedatumFromEntry(transaction.before);
    if (txBefore != null) return txBefore;
  }

  const afterFreigabe = extractFreigabedatumFromEntry(logEntry.after);
  if (afterFreigabe != null) return afterFreigabe;

  const beforeFreigabe = extractFreigabedatumFromEntry(logEntry.before);
  if (beforeFreigabe != null) return beforeFreigabe;

  return fallback;
}

function createLogAnalytics() {
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
        if (
          Number.isFinite(pct) &&
          Math.abs(pct) > LOG_ANALYTICS_EPSILON &&
          baseAmount
        ) {
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
      ? logEntries.filter(
          (entry) => entry && typeof entry === 'object' && Number.isFinite(Number(entry.ts))
        )
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

      const freigabeTs = resolveFreigabedatum(log, ts);
      if (!Number.isFinite(freigabeTs)) continue;

      const dateIso = new Date(freigabeTs).toISOString();
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

  return {
    computeLogMetrics,
    extractPersonAmounts,
    computeEntryTotal,
    sumPersonAmountsForTeam,
    round2,
  };
}

const LOG_ANALYTICS_API =
  existingAnalytics && typeof existingAnalytics === 'object'
    ? existingAnalytics
    : createLogAnalytics();

if (
  (!existingAnalytics || existingAnalytics !== LOG_ANALYTICS_API) &&
  typeof globalThis !== 'undefined'
) {
  globalThis.__LOG_ANALYTICS__ = LOG_ANALYTICS_API;
}

export { toEpochMillis, extractFreigabedatumFromEntry, resolveFreigabedatum };
export const computeLogMetrics = LOG_ANALYTICS_API.computeLogMetrics;
export const extractPersonAmounts = LOG_ANALYTICS_API.extractPersonAmounts;
export const computeEntryTotal = LOG_ANALYTICS_API.computeEntryTotal;
export const sumPersonAmountsForTeam = LOG_ANALYTICS_API.sumPersonAmountsForTeam;
export const round2 = LOG_ANALYTICS_API.round2;
export default LOG_ANALYTICS_API;
