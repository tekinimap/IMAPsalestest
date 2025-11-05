export const fmtPct = new Intl.NumberFormat('de-DE', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export const fmtInt = new Intl.NumberFormat('de-DE', {
  maximumFractionDigits: 0,
});

export const fmtCurr2 = new Intl.NumberFormat('de-DE', {
  style: 'currency',
  currency: 'EUR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export const fmtCurr0 = new Intl.NumberFormat('de-DE', {
  style: 'currency',
  currency: 'EUR',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

export function formatAmountInput(value) {
  return new Intl.NumberFormat('de-DE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format((+value) || 0);
}

export function getTodayDate() {
  return new Date().toISOString().split('T')[0];
}

export function formatDateForInput(ts) {
  if (!ts) return '';
  try {
    return new Date(ts).toISOString().split('T')[0];
  } catch (e) {
    return '';
  }
}

export function clamp01(x) {
  return Math.max(0, Math.min(100, x));
}

export function toInt0(value) {
  const n = Math.round(Number(String(value ?? '0').replace(',', '.')));
  return Number.isFinite(n) ? n : 0;
}

export function parseAmountInput(str) {
  if (!str) return 0;
  str = String(str).trim();

  // 1. Entferne Währungs- und Leerzeichen
  str = str.replace(/[€\s]/g, '');

  // 2. Prüfe, welches Trennzeichen zuletzt vorkommt (Dezimaltrennzeichen)
  const lastComma = str.lastIndexOf(',');
  const lastDot = str.lastIndexOf('.');

  let normalized;
  if (lastComma > lastDot) {
    // deutsches Format: 212.532,57 -> 212532.57
    normalized = str.replace(/\./g, '').replace(',', '.');
  } else {
    // englisches Format: 212,532.57 -> 212532.57
    normalized = str.replace(/,/g, '');
  }

  const n = Number(normalized);
  return Number.isFinite(n) ? n : 0;
}

export function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
