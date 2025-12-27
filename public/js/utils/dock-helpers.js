export function normalizeDockString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

export function getDockPhase(entry) {
  if (!entry || typeof entry !== 'object') return 1;
  const raw = Number(entry.dockPhase);
  if (Number.isFinite(raw) && raw >= 1) {
    return Math.min(4, Math.max(1, raw));
  }
  if (normalizeDockString(entry.source).toLowerCase() === 'hubspot') {
    return 1;
  }
  return 3;
}
