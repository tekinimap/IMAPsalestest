import { THROTTLE_MS, RETRY_LIMIT, RETRY_BACKOFF_MS } from './config.js';
import { showToast } from './ui/feedback.js';

const SERVER_ERROR_BACKOFF_MS = 60_000;
let serverErrorBackoffUntil = 0;

export async function throttle() {
  await new Promise(resolve => setTimeout(resolve, THROTTLE_MS));
}

// Die 'shouldIncludeCredentials' Funktion wurde komplett entfernt, da sie den Fehler verursacht hat.

export async function fetchWithRetry(url, options = {}, retryCount = 0) {
  try {
    if (serverErrorBackoffUntil && Date.now() < serverErrorBackoffUntil) {
      const waitSeconds = Math.ceil((serverErrorBackoffUntil - Date.now()) / 1000);
      throw new Error(`Server nicht erreichbar. Bitte in ${waitSeconds}s erneut versuchen.`);
    }

    const mergedOptions = {
      ...options,
    };
    if (options && options.headers) {
      mergedOptions.headers = { ...options.headers };
    }
    
    // --- KORREKTUR ---
    // Wir erzwingen 'include', damit das Access-Cookie (CF_Authorization)
    // immer mitgesendet wird, auch bei Cross-Origin-Anfragen.
    if (!('credentials' in mergedOptions)) {
      mergedOptions.credentials = 'include';
    }
    // --- ENDE KORREKTUR ---

    const response = await fetch(url, mergedOptions);
    if (response.ok) {
      serverErrorBackoffUntil = 0;
      return response;
    }

    if ((response.status === 429 || response.status >= 500) && retryCount < RETRY_LIMIT) {
      serverErrorBackoffUntil = Date.now() + SERVER_ERROR_BACKOFF_MS;
      showToast(`Serverfehler ${response.status}. Versuche erneut in ${RETRY_BACKOFF_MS / 1000}s...`, 'warn', RETRY_BACKOFF_MS);
      await new Promise(resolve => setTimeout(resolve, RETRY_BACKOFF_MS));
      return fetchWithRetry(url, options, retryCount + 1);
    }

    throw new Error(`HTTP-Fehler ${response.status}: ${await response.text()}`);
  } catch (error) {
    const isInBackoffWindow = serverErrorBackoffUntil && Date.now() < serverErrorBackoffUntil;
    if (!isInBackoffWindow && retryCount < RETRY_LIMIT) {
      showToast(`Netzwerkfehler. Versuche erneut in ${RETRY_BACKOFF_MS / 1000}s...`, 'warn', RETRY_BACKOFF_MS);
      await new Promise(resolve => setTimeout(resolve, RETRY_BACKOFF_MS));
      return fetchWithRetry(url, options, retryCount + 1);
    }

    throw error;
  }
}
