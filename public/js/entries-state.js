const entriesState = {
  entries: [],
};

function sanitizeEntries(list) {
  return Array.isArray(list) ? list.filter((item) => item && typeof item === 'object') : [];
}

function assignEntries(list) {
  const sanitized = sanitizeEntries(list);
  entriesState.entries.length = 0;
  entriesState.entries.push(...sanitized);
  return entriesState.entries;
}

export function initializeEntries(initialEntries = []) {
  return assignEntries(initialEntries);
}

export function getEntries() {
  return entriesState.entries;
}

export function setEntries(nextEntries = []) {
  return assignEntries(nextEntries);
}

export function getEntriesSnapshot() {
  return entriesState.entries.slice();
}

export function findEntryById(id) {
  if (!id) return null;
  const idStr = String(id);
  return entriesState.entries.find((item) => item && String(item.id) === idStr) || null;
}

export function upsertEntry(updatedEntry) {
  if (!updatedEntry || typeof updatedEntry !== 'object') {
    return null;
  }
  const idx = entriesState.entries.findIndex((item) => item && item.id === updatedEntry.id);
  if (idx > -1) {
    entriesState.entries[idx] = updatedEntry;
  } else {
    entriesState.entries.push(updatedEntry);
  }
  return updatedEntry;
}

export function removeEntryById(id) {
  if (!id) return entriesState.entries;
  const next = entriesState.entries.filter((item) => item && item.id !== id);
  return assignEntries(next);
}

if (typeof window !== 'undefined') {
  const initialEntries = Array.isArray(window.entries) ? window.entries : [];
  Object.defineProperty(window, 'entries', {
    configurable: true,
    enumerable: true,
    get() {
      return entriesState.entries;
    },
    set(value) {
      assignEntries(value);
    },
  });
  if (initialEntries.length) {
    assignEntries(initialEntries);
  }
}
