// Wir importieren den alten Worker.
// Falls dieser Pfad falsch ist, würde es hier normalerweise crashen.
import worker from '../core/index.js';

export async function onRequest(context) {
  try {
    // Prüfen ob der Worker korrekt geladen wurde
    if (!worker || typeof worker.fetch !== 'function') {
      throw new Error(
        'Old Worker (core/index.js) not loaded correctly. Check export default!',
      );
    }

    const url = new URL(context.request.url);

    // "/api" aus dem Pfad entfernen
    const newPathname = url.pathname.replace(/^\/api/, '') || '/';
    const newUrl = new URL(newPathname, url.origin).toString();

    // Request klonen und anpassen
    const newRequest = new Request(newUrl, context.request);

    // Alten Worker aufrufen
    return await worker.fetch(newRequest, context.env, context);
  } catch (err) {
    return new Response(`API ADAPTER ERROR: ${err.message}\nStack: ${err.stack}`, {
      status: 500,
    });
  }
}
