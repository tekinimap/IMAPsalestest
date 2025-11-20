import { FOUNDER_SHARE_PCT } from '../config.js';

export const DOCK_WEIGHTING_STEPS = [
  { value: 0.5, short: '0,5×', label: 'Kalte Ausschreibung' },
  { value: 1, short: '1,0×', label: 'Standard' },
  { value: 1.5, short: '1,5×', label: '' },
  { value: 2, short: '2,0×', label: 'KI Projekte, Privatwirtschaft' },
];

export const DOCK_WEIGHTING_DEFAULT = 1;
export const DOCK_WEIGHTING_COMMENT_LIMIT = 280;

export function clampDockRewardFactor(value) {
  const min = DOCK_WEIGHTING_STEPS[0].value;
  const max = DOCK_WEIGHTING_STEPS[DOCK_WEIGHTING_STEPS.length - 1].value;
  const numeric = Number(value);
  const base = Number.isFinite(numeric) ? numeric : DOCK_WEIGHTING_DEFAULT;
  const clamped = Math.min(max, Math.max(min, base));
  let nearest = DOCK_WEIGHTING_STEPS[0].value;
  let smallestDiff = Math.abs(clamped - nearest);
  DOCK_WEIGHTING_STEPS.forEach((step) => {
    const diff = Math.abs(step.value - clamped);
    if (diff < smallestDiff) {
      nearest = step.value;
      smallestDiff = diff;
    }
  });
  return Number(nearest);
}

export function getEntryRewardFactor(entry) {
  if (!entry || typeof entry !== 'object') return DOCK_WEIGHTING_DEFAULT;
  return clampDockRewardFactor(entry.dockRewardFactor);
}

export function calculateActualDistribution(entry, startDate = 0, endDate = Infinity) {
  const personTotals = new Map();
  const transactions = (entry.transactions || []).filter((t) => {
    const d = t.freigabedatum || t.ts || 0;
    const validStart = Number.isFinite(startDate) ? startDate : 0;
    const validEnd = Number.isFinite(endDate) ? endDate : Infinity;
    return d >= validStart && d <= validEnd;
  });
  let totalVolume = 0;

  transactions.forEach((trans) => {
    totalVolume += trans.amount;
    if (trans.type === 'founder') {
      (entry.list || []).forEach((founder) => {
        const money = trans.amount * (founder.pct / 100);
        personTotals.set(founder.name, (personTotals.get(founder.name) || 0) + money);
      });
    } else if (trans.type === 'hunter') {
      const founderShareAmount = trans.amount * (FOUNDER_SHARE_PCT / 100);
      (entry.list || []).forEach((founder) => {
        const money = founderShareAmount * (founder.pct / 100);
        personTotals.set(founder.name, (personTotals.get(founder.name) || 0) + money);
      });
      (trans.list || []).forEach((hunter) => {
        personTotals.set(hunter.name, (personTotals.get(hunter.name) || 0) + hunter.money);
      });
    }
  });

  if (totalVolume === 0) return { list: [], total: 0 };

  const list = Array.from(personTotals, ([name, money]) => ({
    name,
    money,
    pct: (money / totalVolume) * 100,
  })).sort((a, b) => b.money - a.money);

  return { list, total: totalVolume };
}
