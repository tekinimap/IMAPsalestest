const historyState = {
  pendingDelete: { id: null, type: 'entry' },
  currentSort: { key: 'freigabedatum', direction: 'desc' },
  fixCurrentPage: 1,
  fixPageSize: 25,
};

export function getPendingDelete() {
  return historyState.pendingDelete;
}

export function setPendingDelete(value) {
  historyState.pendingDelete = value;
  return historyState.pendingDelete;
}

export function resetPendingDelete() {
  historyState.pendingDelete = { id: null, type: 'entry' };
  return historyState.pendingDelete;
}

export function getCurrentSort() {
  return historyState.currentSort;
}

export function setCurrentSort(value) {
  historyState.currentSort = value;
  return historyState.currentSort;
}

export function getFixPagination() {
  return { page: historyState.fixCurrentPage, pageSize: historyState.fixPageSize };
}

export function setFixPagination({ page, pageSize }) {
  if (typeof page === 'number') {
    historyState.fixCurrentPage = page;
  }
  if (typeof pageSize === 'number') {
    historyState.fixPageSize = pageSize;
  }
  return getFixPagination();
}

export function initializeFixPageSize(value) {
  if (typeof value === 'number' && value > 0) {
    historyState.fixPageSize = value;
  }
}
