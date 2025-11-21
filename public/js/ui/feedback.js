import { setIsBatchRunning } from '../state.js';

const loader = document.getElementById('loader');
const toast = document.getElementById('toast');
const batchProgress = document.getElementById('batchProgress');
const batchTitle = document.getElementById('batchTitle');
const batchStatusLabel = document.getElementById('batchStatusLabel');
const batchProgressBar = document.getElementById('batchProgressBar');

function ensureToastHost() {
  if (!toast) return;
  const openDialog = document.querySelector('dialog[open]');
  const targetHost = openDialog ?? document.body;

  if (toast.parentElement !== targetHost) {
    targetHost.appendChild(toast);
  }
}

export function showLoader() {
  loader?.classList.remove('hide');
}

export function hideLoader() {
  loader?.classList.add('hide');
}

export function showToast(msg, type = 'ok', duration = 3000) {
  if (!toast) return;
  ensureToastHost();
  toast.textContent = msg;
  toast.className = `toast show ${type}`;
  setTimeout(() => {
    toast.className = 'toast';
  }, duration);
}

export function showBatchProgress(title, totalItems) {
  setIsBatchRunning(true);
  if (!batchProgress || !batchTitle || !batchProgressBar || !batchStatusLabel) return;
  batchTitle.textContent = title;
  batchProgressBar.max = totalItems;
  batchProgressBar.value = 0;
  batchStatusLabel.textContent = `Starte... (0 / ${totalItems})`;
  batchProgress.classList.remove('hide');
  window.scrollTo(0, 0);
}

export function updateBatchProgress(currentItem, totalItems) {
  if (!batchProgressBar || !batchStatusLabel) return;
  batchProgressBar.value = currentItem;
  batchStatusLabel.textContent = `Verarbeite ${currentItem} / ${totalItems}...`;
}

export function hideBatchProgress() {
  setIsBatchRunning(false);
  batchProgress?.classList.add('hide');
}
