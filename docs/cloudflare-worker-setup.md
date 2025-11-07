# Cloudflare Worker manuell aktualisieren

Diese Anleitung erklärt Schritt für Schritt, wie du den bestehenden IMAP-Sales-Worker bei Cloudflare aktualisierst, damit die neue Analyse-Funktion `/analytics/metrics` funktioniert. Du brauchst dafür **keine** Programmierkenntnisse – folge einfach den einzelnen Schritten in Ruhe der Reihe nach.

---

## 1. Überblick

* In diesem GitHub-Ordner liegt die aktuelle Version des Workers: [`worker/index.js`](../worker/index.js).
* Es gibt **keinen automatischen Abgleich** zwischen GitHub und deinem Cloudflare-Konto. Du musst den Code deshalb per Kopieren & Einfügen im Cloudflare-Dashboard aktualisieren.
* Der Worker spricht mit GitHub, um Daten zu lesen und zu speichern. Ohne die richtigen Zugangsdaten kann er nicht funktionieren.

---

## 2. Vorbereitung

1. **Cloudflare-Zugang**: Melde dich auf [dash.cloudflare.com](https://dash.cloudflare.com) mit deinem Account an.
2. **GitHub-Personal-Access-Token (PAT)**: Falls noch nicht vorhanden, erstelle auf [github.com/settings/tokens](https://github.com/settings/tokens) ein Token mit mindestens den Rechten `repo` (lesen & schreiben). Bewahre den Token sicher auf – du brauchst ihn gleich.
3. **Merke dir folgende Angaben**:
   * GitHub-Organisation oder Benutzername, z. B. `mein-team`.
   * Repository-Name, z. B. `imap-sales`.
   * Git-Branch, z. B. `main`.

Diese drei Angaben brauchst du später für die Umgebungsvariablen.

---

## 3. Worker-Code aktualisieren

1. Öffne im Cloudflare-Dashboard den Bereich **Workers & Pages**.
2. Wähle deinen bestehenden Worker aus (z. B. `imap-sales-worker`).
3. Klicke auf **Quick Edit** oder **Open Editor** (je nach Ansicht).
4. Öffne in einem zweiten Browser-Tab diese GitHub-Datei: [`worker/index.js`](../worker/index.js).
5. Markiere dort den gesamten Inhalt (`Strg + A` / `Cmd + A`) und kopiere ihn (`Strg + C` / `Cmd + C`).
6. Gehe zurück zum Cloudflare-Editor, markiere dort den kompletten vorhandenen Code und füge den neuen Inhalt ein (`Strg + V` / `Cmd + V`).
7. Speichere die Änderung über **Save and deploy** bzw. **Deploy**.

Damit läuft jetzt genau der gleiche Worker-Code wie in diesem Repository. Ein separater "Log-Analytics-Worker" ist nicht nötig – die neue Funktion steckt bereits in `worker/index.js`.

---

## 4. Umgebungsvariablen setzen

Der Worker braucht verschiedene Einstellungen. Du findest sie im Cloudflare-Dashboard unter **Settings → Variables** (früher: **Settings → Environment Variables**). Lege dort folgende Werte an oder prüfe, ob sie bereits korrekt eingetragen sind:

| Name | Beispielwert | Erklärung |
| ---- | ------------- | --------- |
| `GH_TOKEN` | `ghp_xxxxxxxxxxxxxxxxx` | Dein GitHub-Personal-Access-Token. Alternativ kannst du `GITHUB_TOKEN` verwenden. |
| `GH_REPO` | `mein-team/imap-sales` | Kombination aus Organisation/Benutzer und Repository. |
| `GH_BRANCH` | `main` | Branch, aus dem Daten gelesen und in den geschrieben wird. |
| `GH_PATH` | `data/entries.json` | Hauptdatei für Deals & Projekte. |
| `GH_LOG_DIR` | `data/logs` | Ordner für Tages-Logdateien (JSONL). |
| `GH_PEOPLE_PATH` | `data/people.json` | Datei mit Team-Mitgliedern. |
| `ALLOWED_ORIGIN` | `https://deine-app-domain.de` | Erlaubt dem Browser den Zugriff (CORS). Bei Tests kannst du `*` setzen. |
| `WORKER_BASE` | `https://imap-sales-worker.deine-zone.workers.dev` | Basis-URL, die du später im Frontend einträgst. |

Optional – nur falls du HubSpot oder andere Funktionen nutzt:

| Name | Wofür? |
| ---- | ------ |
| `HUBSPOT_ACCESS_TOKEN` | Für automatische Updates aus HubSpot. |
| `HUBSPOT_APP_SECRET` & `HUBSPOT_CLOSED_WON_STAGE_IDS` | Für Webhooks aus HubSpot. |
| `HUBSPOT_UPDATE_BACKOFF_MS` | Optional: Basiswartezeit (in Millisekunden) für wiederholte HubSpot-Updates bei Rate-Limits/Fehlern. |

> **Wichtig:** Wenn du HubSpot-Deals synchronisierst, müssen im HubSpot-Portal die benutzerdefinierten Deal-Felder `projektnummer` und `kvnummer` existieren. Die Worker-Updates schlagen sonst fehl.

Speichere jede Variable nach dem Eintragen. Cloudflare schützt geheime Werte (z. B. Tokens), du siehst sie danach nicht mehr – das ist normal.

---

## 5. Frontend mit dem Worker verbinden

1. Öffne in deinem Hosting (z. B. Cloudflare Pages, Netlify oder einen eigenen Server) die Datei `public/config.json` oder die dort hinterlegte Konfiguration.
2. Trage bei `workerBase` die URL deines Workers ein, zum Beispiel:
   ```json
   {
     "workerBase": "https://imap-sales-worker.deine-zone.workers.dev"
   }
   ```
3. Veröffentliche die Konfigurationsänderung.

Das Frontend ruft jetzt alle APIs über diese Basis-URL auf. Die neue Analyseanzeige nutzt automatisch `/analytics/metrics`.

---

## 6. Funktion testen

1. Öffne die Anwendung im Browser und melde dich wie gewohnt an.
2. Gehe zur Rubrik **Auswertung / Log Insights**.
3. Stelle einen kurzen Zeitraum ein (z. B. aktueller Monat) und klicke auf **Aktualisieren**.
4. Wenn alles richtig konfiguriert ist, erscheinen die Diagramme sowie CSV/XLSX-Downloads.

Sollte eine Fehlermeldung erscheinen:

* Prüfe, ob der Worker veröffentlicht wurde (Datum/Uhrzeit im Cloudflare-Dashboard).
* Kontrolliere, ob `GH_TOKEN`, `GH_REPO` und `GH_BRANCH` korrekt sind.
* Öffne im Cloudflare-Worker die **Logs** (linke Seitenleiste → **Logs**) und wiederhole den Aufruf im Browser. Fehlermeldungen werden dort angezeigt.

---

## 7. Zusammenfassung

* Worker-Code in Cloudflare manuell mit `worker/index.js` abgleichen.
* GitHub-Zugangsdaten als Umgebungsvariablen hinterlegen.
* Frontend-Konfiguration (`workerBase`) auf deine Worker-URL setzen.
* Danach steht die neue Route `/analytics/metrics` bereit und die Auswertungen laden ohne Ad-Blocker-Probleme.

Falls du unsicher bist oder etwas nicht funktioniert, kannst du diese Schritte jederzeit erneut durchgehen. Jede Änderung lässt sich rückgängig machen, indem du den vorherigen Worker-Code wieder einfügst oder eine ältere Version im Cloudflare-Dashboard auswählst.
