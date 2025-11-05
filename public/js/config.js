const DEFAULT_WORKER = 'https://imap-sales-worker.tekin-6af.workers.dev';
if (typeof window !== 'undefined' && !window.WORKER_BASE) {
  window.WORKER_BASE = DEFAULT_WORKER;
}

export const WORKER_BASE = window.WORKER_BASE || DEFAULT_WORKER;

export const TEAMS = [
  'Vielfalt+','Evaluation und Beteiligung','Nachhaltigkeit','Sozial- und Krankenversicherungen',
  'ChangePartner','Bundes- und Landesbehörden','Kommunalverwaltungen',
  'Internationale Zusammenarbeit','Head of Organisational Excellence','Head of Public Impact'
];

export const DEFAULT_WEIGHTS = { cs: 50, konzept: 30, pitch: 20 };
export const CATEGORY_NAMES = { cs: 'Consultative Selling', konzept: 'Konzepterstellung', pitch: 'Pitch' };
export const FOUNDER_SHARE_PCT = 20;
export const THROTTLE_MS = 1100; // Latenz für Batch-Prozesse
export const RETRY_LIMIT = 2;
export const RETRY_BACKOFF_MS = 3000;
