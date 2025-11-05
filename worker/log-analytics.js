const EPSILON = 1e-6;

function normalizeNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

export function extractPersonAmounts(entry) {
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

    let amount = normalizeNumber(item.money);
    if (!Number.isFinite(amount) || Math.abs(amount) < EPSILON) {
      const pct = normalizeNumber(item.pct);
      if (Number.isFinite(pct) && Math.abs(pct) > EPSILON && baseAmount) {
        amount = (baseAmount * pct) / 100;
      }
    }

    if (!Number.isFinite(amount) || Math.abs(amount) < EPSILON) continue;
    map.set(name, (map.get(name) || 0) + amount);
  }

  return map;
}

export function computeEntryTotal(entry) {
  if (!entry || typeof entry !== 'object') {
    return 0;
  }

  const byPerson = extractPersonAmounts(entry);
  if (byPerson.size > 0) {
    let sum = 0;
    byPerson.forEach((value) => {
      sum += normalizeNumber(value);
    });
    if (Math.abs(sum) > EPSILON) {
      return sum;
    }
  }

  if (Array.isArray(entry.transactions)) {
    let total = 0;
    for (const tx of entry.transactions) {
      total += normalizeNumber(tx?.amount);
    }
    if (Math.abs(total) > EPSILON) {
      return total;
    }
  }

  return normalizeNumber(entry.amount || entry.totalAmount);
}

function sumPersonAmountsForTeam(entry, teamName, personTeamMap) {
  if (!teamName) {
    return computeEntryTotal(entry);
  }
  const persons = extractPersonAmounts(entry);
  if (persons.size === 0) {
    return 0;
  }
  let sum = 0;
  persons.forEach((value, person) => {
    const team = personTeamMap.get(person) || 'Ohne Team';
    if (team === teamName) {
      sum += normalizeNumber(value);
    }
  });
  return sum;
}

function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
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
  bucket.amount += delta;
  bucket.count += 1;
  if (delta > EPSILON) {
    bucket.positiveCount += 1;
    bucket.positiveAmount += delta;
  } else if (delta < -EPSILON) {
    bucket.negativeCount += 1;
    bucket.negativeAmount += delta;
  } else {
    bucket.neutralCount += 1;
  }
}

function updateBucket(map, key, delta) {
  if (!map.has(key)) {
    map.set(key, createEmptyBucket());
  }
  const bucket = map.get(key);
  applyDelta(bucket, delta);
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

export function computeLogMetrics(logEntries = [], options = {}, personTeamMap = new Map()) {
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

export { sumPersonAmountsForTeam as __sumPersonAmountsForTeam, round2 as __round2 };
