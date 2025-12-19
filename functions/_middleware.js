export async function onRequest(context) {
  try {
    // 1. Initialisierung prüfen
    if (!context) throw new Error("Context ist undefined");
    const request = context.request;
    const next = context.next;

    // 2. Daten-Objekt vorbereiten (falls nicht vorhanden)
    if (!context.data) context.data = {};

    // 3. User-Daten sicher auslesen (mit ?. Operator um Abstürze zu verhindern)
    const email = request.headers?.get("CF-Access-Authenticated-User-Email");
    const name = request.headers?.get("CF-Access-Authenticated-User-Name");

    // 4. In Context speichern
    context.data.user = { email, name };

    // 5. Weiter zur nächsten Funktion
    return await next();
  } catch (err) {
    // WICHTIG: Statt abzustürzen (1101), geben wir den Fehlertext zurück!
    return new Response(`CRITICAL MIDDLEWARE ERROR: ${err.message}\nStack: ${err.stack}`);
  }
}
