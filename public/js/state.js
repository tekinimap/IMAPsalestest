const LS_KEY = 'sales_state_v1';

const appState = {
  hasUnsavedChanges: false,
  isBatchRunning: false,
};

export function saveState(st) {
  localStorage.setItem(LS_KEY, JSON.stringify(st));
}

export function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function getHasUnsavedChanges() {
  return appState.hasUnsavedChanges;
}

export function setHasUnsavedChanges(value) {
  appState.hasUnsavedChanges = Boolean(value);
}

export function getIsBatchRunning() {
  return appState.isBatchRunning;
}

export function setIsBatchRunning(value) {
  appState.isBatchRunning = Boolean(value);
}

export function resetFlags() {
  setHasUnsavedChanges(false);
  setIsBatchRunning(false);
}
