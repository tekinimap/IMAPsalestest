import { THROTTLE_MS, RETRY_LIMIT, RETRY_BACKOFF_MS } from './config.js';
import { showToast } from './ui/feedback.js';

export async function throttle() {
  await new Promise(resolve => setTimeout(resolve, THROTTLE_MS));
}

    return resolved.origin === window.location.origin;
  } catch (err) {
    console.warn('Konnte Ziel-URL für fetchWithRetry nicht bestimmen, Credentials werden ausgelassen.', err);
    return false;
  }
}

export async function fetchWithRetry(url, options = {}, retryCount = 0) {
  try {
    const mergedOptions = {
      ...options,
    };
    if (options && options.headers) {
      mergedOptions.headers = { ...options.headers };
    }
    if (!('credentials' in mergedOptions)) {
      // IMMER Cookies mitschicken, da wir jetzt Cross-Origin mit Access-Auth arbeiten
      mergedOptions.credentials = 'include';
    }
    const response = await fetch(url, mergedOptions);
    if (response.ok) {
      return response;
    }

    if ((response.status === 429 || response.status >= 500) && retryCount < RETRY_LIMIT) {
      showToast(`Serverfehler ${response.status}. Versuche erneut in ${RETRY_BACKOFF_MS / 1000}s...`, 'warn', RETRY_BACKOFF_MS);
      await new Promise(resolve => setTimeout(resolve, RETRY_BACKOFF_MS));
      return fetchWithRetry(url, options, retryCount + 1);
    }

    throw new Error(`HTTP-Fehler ${response.status}: ${await response.text()}`);
  } catch (error) {
    if (retryCount < RETRY_LIMIT) {
      showToast(`Netzwerkfehler. Versuche erneut in ${RETRY_BACKOFF_MS / 1000}s...`, 'warn', RETRY_BACKOFF_MS);
      await new Promise(resolve => setTimeout(resolve, RETRY_BACKOFF_MS));
      return fetchWithRetry(url, options, retryCount + 1);
    }

    throw error;
  }
}
