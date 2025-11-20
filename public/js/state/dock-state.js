const dockState = {
  filter: { bu: '', marketTeam: '', assessment: '', search: '' },
  selection: new Set(),
  boardInitialized: false,
  autoAdvanceQueue: [],
  autoAdvanceProcessed: new Set(),
  autoAdvanceRunning: false,
  autoCheckQueue: new Map(),
  autoCheckHistory: new Map(),
  conflictHints: new Map(),
  boardRerenderScheduled: false,
  pendingAbrufAssignment: null,
};

export function getDockFilterState() {
  return dockState.filter;
}

export function updateDockFilterState(patch = {}) {
  Object.assign(dockState.filter, patch);
  return dockState.filter;
}

export function getDockSelection() {
  return dockState.selection;
}

export function toggleDockSelection(id, selected) {
  if (!id) return dockState.selection;
  if (selected) {
    dockState.selection.add(id);
  } else {
    dockState.selection.delete(id);
  }
  return dockState.selection;
}

export function clearDockSelection() {
  dockState.selection.clear();
  return dockState.selection;
}

export function isDockBoardInitialized() {
  return dockState.boardInitialized;
}

export function markDockBoardInitialized() {
  dockState.boardInitialized = true;
}

export function getDockAutoAdvanceQueue() {
  return dockState.autoAdvanceQueue;
}

export function addDockAutoAdvanceEntry(entry) {
  dockState.autoAdvanceQueue.push(entry);
  return dockState.autoAdvanceQueue;
}

export function shiftDockAutoAdvanceEntry() {
  return dockState.autoAdvanceQueue.shift();
}

export function getDockAutoAdvanceProcessed() {
  return dockState.autoAdvanceProcessed;
}

export function isDockAutoAdvanceRunning() {
  return dockState.autoAdvanceRunning;
}

export function setDockAutoAdvanceRunning(value) {
  dockState.autoAdvanceRunning = Boolean(value);
}

export function getDockAutoCheckQueue() {
  return dockState.autoCheckQueue;
}

export function getDockAutoCheckHistory() {
  return dockState.autoCheckHistory;
}

export function getDockConflictHints() {
  return dockState.conflictHints;
}

export function isDockBoardRerenderScheduled() {
  return dockState.boardRerenderScheduled;
}

export function setDockBoardRerenderScheduled(value) {
  dockState.boardRerenderScheduled = Boolean(value);
}

export function getPendingDockAbrufAssignment() {
  return dockState.pendingAbrufAssignment;
}

export function setPendingDockAbrufAssignment(value) {
  dockState.pendingAbrufAssignment = value;
  return dockState.pendingAbrufAssignment;
}
