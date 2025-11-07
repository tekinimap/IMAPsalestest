# Konflikte in `worker/index.js` lösen

Wenn beim Aktualisieren des Workers Merge-Konflikte auftauchen, befolge diese Schritte, um die Analytics-Helfer nur einmal zu definieren und dadurch Cloudflare-Build-Fehler zu vermeiden:

1. **Editor öffnen.** Öffne `worker/index.js` in VS Code oder einem anderen Editor, der Konfliktmarker (`<<<<<<<`, `=======`, `>>>>>>>`) anzeigt.
2. **Hilfsfunktionen ohne `export` behalten.**
   - Bei Funktionen wie `extractPersonAmounts`, `computeEntryTotal` und `computeLogMetrics` wähle immer die Variante **ohne** das Schlüsselwort `export`.
   - Beispiel: Lasse `function computeLogMetrics(...) { ... }` stehen und lösche die Version mit `export function ...`.
3. **Nur einen Export-Block am Ende behalten.**
   - Entferne alle doppelten `export`-Zeilen und lasse lediglich den Block am Datei-Ende bestehen:
     ```js
     export {
       computeLogMetrics,
       extractPersonAmounts,
       computeEntryTotal,
       sumPersonAmountsForTeam as __sumPersonAmountsForTeam,
       round2 as __round2,
     };
     ```
4. **Konfliktmarker entfernen.** Lösche alle Zeilen mit `<<<<<<<`, `=======` und `>>>>>>>`.
5. **Datei speichern und Konflikt als gelöst markieren.**
   ```bash
   git add worker/index.js
   ```
6. **Tests laufen lassen.**
   ```bash
   npm test
   ```
   So stellst du sicher, dass keine Syntaxfehler übrig sind.
7. **Deploy vorbereiten.** Führe den üblichen Build/Upload für den Worker aus (z. B. `wrangler deploy`). Jetzt sollte der Fehler „Identifier 'computeLogMetrics' has already been declared“ verschwinden.

> Tipp: Der Fehler tritt auf, wenn Funktionen gleichzeitig als `export function …` und zusätzlich im `export { … }`-Block aufgeführt werden. Halte dich daher strikt an die obigen Schritte, damit jede Funktion nur einmal exportiert wird.
