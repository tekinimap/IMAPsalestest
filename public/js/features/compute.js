import { DEFAULT_WEIGHTS } from '../config.js';

function totals(rows) {
  return rows.reduce(
    (acc, row) => {
      acc.cs += row.cs;
      acc.konzept += row.konzept;
      acc.pitch += row.pitch;
      return acc;
    },
    { cs: 0, konzept: 0, pitch: 0 }
  );
}

function normalizeWeightsForUsed(allWeights, usedKeys) {
  const used = allWeights.filter((w) => usedKeys.includes(w.key));
  const sum = used.reduce((a, w) => a + w.weight, 0);
  if (sum <= 0) return allWeights.map((w) => ({ key: w.key, weight: w.weight }));

  const factor = 100 / sum;
  const out = allWeights.map((w) =>
    usedKeys.includes(w.key)
      ? { key: w.key, weight: w.weight * factor }
      : { key: w.key, weight: 0 }
  );

  const remainder = 100 - out.reduce((a, w) => a + Math.round(w.weight), 0);
  if (remainder !== 0) {
    const ix = out.findIndex((x) => usedKeys.includes(x.key));
    if (ix >= 0) out[ix].weight += remainder;
  }

  return out.map((w) => ({ key: w.key, weight: Math.round(w.weight) }));
}

export function compute(rows, weights, amount, forLive = false) {
  const t = totals(rows);
  const usedKeys = Object.entries(t)
    .filter(([, v]) => v > 0)
    .map(([k]) => k);

  const effWeights =
    weights && weights.length
      ? weights
      : [
          { key: 'cs', weight: DEFAULT_WEIGHTS.cs },
          { key: 'konzept', weight: DEFAULT_WEIGHTS.konzept },
          { key: 'pitch', weight: DEFAULT_WEIGHTS.pitch },
        ];

  const calcWeights = forLive ? effWeights : normalizeWeightsForUsed(effWeights, usedKeys);

  const map = new Map();
  rows.forEach((r, index) => {
    const hasValue = r.cs + r.konzept + r.pitch > 0;
    const key = r.name.trim() || `_temp_${index}`;
    if (!r.name.trim() && !hasValue) return;

    const cur = map.get(key) || { name: r.name, cs: 0, konzept: 0, pitch: 0 };
    cur.cs += r.cs;
    cur.konzept += r.konzept;
    cur.pitch += r.pitch;
    map.set(key, cur);
  });

  const weightIndex = Object.fromEntries(calcWeights.map((w) => [w.key, w.weight / 100]));
  const list = [];

  for (const [key, p] of map.entries()) {
    let pct = 0;
    const divCS = forLive ? 100 : t.cs || 1;
    const divKonzept = forLive ? 100 : t.konzept || 1;
    const divPitch = forLive ? 100 : t.pitch || 1;

    if (usedKeys.includes('cs') && t.cs > 0) pct += weightIndex.cs * (p.cs / divCS);
    if (usedKeys.includes('konzept') && t.konzept > 0) pct += weightIndex.konzept * (p.konzept / divKonzept);
    if (usedKeys.includes('pitch') && t.pitch > 0) pct += weightIndex.pitch * (p.pitch / divPitch);
    list.push({ key, name: p.name, pct: pct * 100 });
  }

  list.sort((a, b) => b.pct - a.pct);
  if (!forLive) {
    const sum = list.reduce((a, x) => a + x.pct, 0);
    const resid = 100 - sum;
    if (list.length && Math.abs(resid) > 1e-9) list[0].pct += resid;
  }

  list.forEach((x) => {
    if (x.pct < 0) x.pct = 0;
  });

  const withMoney = list.map((x) => ({ ...x, money: Math.round((amount > 0 ? amount : 0) * x.pct / 100) }));
  return { totals: t, usedKeys, effectiveWeights: calcWeights, list: withMoney };
}

