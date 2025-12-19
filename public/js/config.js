const DEFAULT_CONFIG = Object.freeze({
  workerBase: '/api',
  teams: [
    'Vielfalt+',
    'Evaluation und Beteiligung',
    'Nachhaltigkeit',
    'Sozial- und Krankenversicherungen',
    'ChangePartner',
    'Bundes- und Landesbehörden',
    'Kommunalverwaltungen',
    'Internationale Zusammenarbeit',
    'Head of Organisational Excellence',
    'Head of Public Impact'
  ],
  defaultWeights: { cs: 50, konzept: 30, pitch: 20 },
  categoryNames: {
    cs: 'Consultative Selling',
    konzept: 'Konzepterstellung',
    pitch: 'Pitch'
  },
  founderSharePct: 20,
  throttleMs: 1100,
  retryLimit: 2,
  retryBackoffMs: 3000
});

const KNOWN_KEYS = new Set([
  'workerBase',
  'teams',
  'defaultWeights',
  'categoryNames',
  'founderSharePct',
  'throttleMs',
  'retryLimit',
  'retryBackoffMs'
]);

const issues = { warnings: [], errors: [] };

function cloneDefaults() {
  return {
    workerBase: DEFAULT_CONFIG.workerBase,
    teams: [...DEFAULT_CONFIG.teams],
    defaultWeights: { ...DEFAULT_CONFIG.defaultWeights },
    categoryNames: { ...DEFAULT_CONFIG.categoryNames },
    founderSharePct: DEFAULT_CONFIG.founderSharePct,
    throttleMs: DEFAULT_CONFIG.throttleMs,
    retryLimit: DEFAULT_CONFIG.retryLimit,
    retryBackoffMs: DEFAULT_CONFIG.retryBackoffMs
  };
}

function recordIssue(type, message) {
  issues[type].push(message);
  if (typeof console !== 'undefined') {
    const logger = type === 'errors' ? console.error : console.warn;
    logger(`[Konfiguration] ${message}`);
  }
}

function sanitizeUrl(value) {
  const withoutWhitespace = value.replace(/\s+/g, '');
  const hadTrailingWildcard = /\/?\*+$/.test(withoutWhitespace);
  const sanitized = withoutWhitespace
    .replace(/\/+\*+$/, '')
    .replace(/\*+$/, '')
    .replace(/\/+$/, '');
  return { sanitized, hadTrailingWildcard };
}

function applyWorkerBase(target, value, sourceLabel) {
  if (typeof value !== 'string' || !value.trim()) {
    recordIssue('errors', `${sourceLabel}: "workerBase" muss eine nicht-leere URL sein.`);
    return;
  }
  const { sanitized, hadTrailingWildcard } = sanitizeUrl(value.trim());
  if (!sanitized) {
    recordIssue('errors', `${sourceLabel}: "workerBase" muss eine gültige URL ohne Platzhalter sein.`);
    return;
  }
  if (sanitized.includes('*')) {
    recordIssue('errors', `${sourceLabel}: "workerBase" darf kein "*" enthalten.`);
    return;
  }
  if (hadTrailingWildcard) {
    recordIssue('warnings', `${sourceLabel}: "workerBase" enthielt am Ende ein "*" und wurde automatisch bereinigt. Bitte nutze die Basis-URL ohne Platzhalter.`);
  }
  target.workerBase = sanitized;
}

function applyTeams(target, value, sourceLabel) {
  if (!Array.isArray(value)) {
    recordIssue('errors', `${sourceLabel}: "teams" muss ein Array aus Strings sein.`);
    return;
  }
  const sanitized = value
    .map((team) => (typeof team === 'string' ? team.trim() : ''))
    .filter(Boolean);
  if (!sanitized.length) {
    recordIssue('warnings', `${sourceLabel}: "teams" ist leer. Standardwerte werden verwendet.`);
    return;
  }
  target.teams = sanitized;
}

function applyWeights(target, value, sourceLabel) {
  if (typeof value !== 'object' || value === null) {
    recordIssue('errors', `${sourceLabel}: "defaultWeights" muss ein Objekt sein.`);
    return;
  }
  ['cs', 'konzept', 'pitch'].forEach((key) => {
    if (!(key in value)) return;
    const num = Number(value[key]);
    if (!Number.isFinite(num)) {
      recordIssue('errors', `${sourceLabel}: Gewicht "${key}" ist keine Zahl.`);
      return;
    }
    if (num < 0 || num > 100) {
      recordIssue('warnings', `${sourceLabel}: Gewicht "${key}" liegt außerhalb des Bereichs 0-100. Wert wurde auf Grenzen gekürzt.`);
    }
    const clamped = Math.max(0, Math.min(100, Math.round(num)));
    target.defaultWeights[key] = clamped;
  });
}

function applyCategoryNames(target, value, sourceLabel) {
  if (typeof value !== 'object' || value === null) {
    recordIssue('errors', `${sourceLabel}: "categoryNames" muss ein Objekt sein.`);
    return;
  }
  ['cs', 'konzept', 'pitch'].forEach((key) => {
    if (!(key in value)) return;
    const str = value[key];
    if (typeof str !== 'string' || !str.trim()) {
      recordIssue('errors', `${sourceLabel}: Bezeichnung "${key}" muss eine nicht-leere Zeichenkette sein.`);
      return;
    }
    target.categoryNames[key] = str.trim();
  });
}

function applyNumber(target, key, value, sourceLabel, { min = 0, max = Infinity, integer = false }) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    recordIssue('errors', `${sourceLabel}: "${key}" muss eine Zahl sein.`);
    return;
  }
  const normalized = integer ? Math.round(num) : num;
  if (normalized < min || normalized > max) {
    recordIssue('warnings', `${sourceLabel}: "${key}" liegt außerhalb des erlaubten Bereichs (${min}-${max}). Wert wurde begrenzt.`);
  }
  target[key] = Math.min(max, Math.max(min, normalized));
}

function applyOverrides(target, overrides, sourceLabel) {
  if (!overrides || typeof overrides !== 'object') {
    if (overrides !== undefined) {
      recordIssue('errors', `${sourceLabel}: Ungültiges Format. Erwartet wird ein Objekt.`);
    }
    return;
  }

  Object.keys(overrides).forEach((key) => {
    if (!KNOWN_KEYS.has(key)) {
      recordIssue('warnings', `${sourceLabel}: Unbekannter Schlüssel "${key}" wird ignoriert.`);
      return;
    }
    const value = overrides[key];
    switch (key) {
      case 'workerBase':
        applyWorkerBase(target, value, sourceLabel);
        break;
      case 'teams':
        applyTeams(target, value, sourceLabel);
        break;
      case 'defaultWeights':
        applyWeights(target, value, sourceLabel);
        break;
      case 'categoryNames':
        applyCategoryNames(target, value, sourceLabel);
        break;
      case 'founderSharePct':
        applyNumber(target, 'founderSharePct', value, sourceLabel, { min: 0, max: 100, integer: true });
        break;
      case 'throttleMs':
        applyNumber(target, 'throttleMs', value, sourceLabel, { min: 0, integer: true });
        break;
      case 'retryLimit':
        applyNumber(target, 'retryLimit', value, sourceLabel, { min: 0, integer: true });
        break;
      case 'retryBackoffMs':
        applyNumber(target, 'retryBackoffMs', value, sourceLabel, { min: 0, integer: true });
        break;
      default:
        break;
    }
  });
}

async function loadConfigFile() {
  try {
    const url = new URL('../config.json', import.meta.url);
    const response = await fetch(url, { cache: 'no-store' });
    if (response.status === 404) {
      recordIssue('warnings', 'Konfigurationsdatei "config.json" wurde nicht gefunden. Standardwerte werden verwendet.');
      return null;
    }
    if (!response.ok) {
      recordIssue('errors', `Konfigurationsdatei konnte nicht geladen werden (Status ${response.status}). Standardwerte werden verwendet.`);
      return null;
    }
    const text = await response.text();
    if (!text.trim()) {
      recordIssue('warnings', 'Konfigurationsdatei ist leer. Standardwerte werden verwendet.');
      return null;
    }
    try {
      return JSON.parse(text);
    } catch (error) {
      recordIssue('errors', `Konfigurationsdatei enthält ungültiges JSON: ${error.message}`);
      return null;
    }
  } catch (error) {
    recordIssue('errors', `Konfiguration konnte nicht geladen werden: ${error.message}`);
    return null;
  }
}

const resolvedConfig = cloneDefaults();

const fileOverrides = await loadConfigFile();
applyOverrides(resolvedConfig, fileOverrides, 'config.json');

if (typeof window !== 'undefined' && window.__APP_CONFIG__) {
  applyOverrides(resolvedConfig, window.__APP_CONFIG__, 'window.__APP_CONFIG__');
}

if (typeof window !== 'undefined') {
  window.WORKER_BASE = resolvedConfig.workerBase;
  window.__APP_CONFIG_WARNINGS__ = issues.warnings.slice();
  window.__APP_CONFIG_ERRORS__ = issues.errors.slice();
}

const CONFIG = Object.freeze({
  workerBase: resolvedConfig.workerBase,
  teams: Object.freeze([...resolvedConfig.teams]),
  defaultWeights: Object.freeze({ ...resolvedConfig.defaultWeights }),
  categoryNames: Object.freeze({ ...resolvedConfig.categoryNames }),
  founderSharePct: resolvedConfig.founderSharePct,
  throttleMs: resolvedConfig.throttleMs,
  retryLimit: resolvedConfig.retryLimit,
  retryBackoffMs: resolvedConfig.retryBackoffMs
});

export const CONFIG_WARNINGS = Object.freeze([...issues.warnings]);
export const CONFIG_ERRORS = Object.freeze([...issues.errors]);

export const WORKER_BASE = CONFIG.workerBase;
export const TEAMS = CONFIG.teams;
export const DEFAULT_WEIGHTS = CONFIG.defaultWeights;
export const CATEGORY_NAMES = CONFIG.categoryNames;
export const FOUNDER_SHARE_PCT = CONFIG.founderSharePct;
export const THROTTLE_MS = CONFIG.throttleMs;
export const RETRY_LIMIT = CONFIG.retryLimit;
export const RETRY_BACKOFF_MS = CONFIG.retryBackoffMs;

export default CONFIG;
