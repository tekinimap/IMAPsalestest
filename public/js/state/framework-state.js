const frameworkState = {
  currentFrameworkEntryId: null,
  editingTransactionId: null,
};

export function getCurrentFrameworkEntryId() {
  return frameworkState.currentFrameworkEntryId;
}

export function setCurrentFrameworkEntryId(value) {
  frameworkState.currentFrameworkEntryId = value;
  return frameworkState.currentFrameworkEntryId;
}

export function getEditingTransactionId() {
  return frameworkState.editingTransactionId;
}

export function setEditingTransactionId(value) {
  frameworkState.editingTransactionId = value;
  return frameworkState.editingTransactionId;
}
