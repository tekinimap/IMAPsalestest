export async function onRequest(context) {
  // 1. Zugriff auf die Umgebungsvariablen (hier ist unsere DB "Brücke")
  const { env } = context;

  try {
    // 2. SQL-Abfrage an die Datenbank senden
    // Wir fragen alles aus der Tabelle 'projects' ab
    const { results } = await env.DB.prepare("SELECT * FROM projects").all();

    // 3. Ergebnis als JSON zurückgeben
    return new Response(JSON.stringify(results), {
      headers: { "Content-Type": "application/json" },
    });

  } catch (e) {
    // Falls was schief geht (z.B. Tabelle nicht gefunden), Fehler zeigen
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
}
