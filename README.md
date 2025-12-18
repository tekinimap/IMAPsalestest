# dock

Interne Anwendung zur Verwaltung von Sales-Beteiligungen.

## Konfiguration

Die Anwendung lädt alle relevanten Einstellungen zur Laufzeit aus der Datei [`public/config.json`](public/config.json). Diese Datei kann beim Build oder während des Deployments überschrieben werden, ohne dass der Anwendungscode angepasst werden muss. Das Modul [`public/js/config.js`](public/js/config.js) sorgt dafür, dass die Konfiguration geladen, validiert und mit sicheren Standardwerten versehen wird.

### Standardverhalten & Fallbacks

* Wird `config.json` nicht gefunden oder ist ungültig, greift die Anwendung automatisch auf die in `config.js` hinterlegten Standardwerte zurück.
* Alle Werte werden validiert. Ungültige Einträge werden verworfen, begrenzt oder auf Defaults zurückgesetzt. Die Details erscheinen in der Browser-Konsole.
* Fehler und Warnungen werden zusätzlich im UI signalisiert (`Toast`-Benachrichtigungen). Über `window.__APP_CONFIG_ERRORS__` und `window.__APP_CONFIG_WARNINGS__` stehen sie auch programmatisch zur Verfügung.
* Optionale Runtime-Overrides sind über `window.__APP_CONFIG__ = { ... }` möglich (z. B. via Inline-Script, das vom Deployment-Target injiziert wird). Diese Werte überschreiben die geladenen JSON-Werte.

### Unterstützte Schlüssel

| Schlüssel | Typ | Beschreibung |
| --- | --- | --- |
| `workerBase` | `string` | Basis-URL des Cloudflare Workers / API-Backends. Whitespace und überflüssige Slashes werden entfernt. |
| `teams` | `string[]` | Liste der auswählbaren Teams. Leere Einträge werden ignoriert. |
| `defaultWeights` | `{ cs, konzept, pitch }` | Standard-Gewichte in Prozent. Werte außerhalb 0–100 werden gekappt. |
| `categoryNames` | `{ cs, konzept, pitch }` | Lokalisierte Anzeigenamen. Müssen nicht-leere Strings sein. |
| `founderSharePct` | `number` | Anteil (0–100) für Gründer:innen. |
| `throttleMs` | `number` | Verzögerung für batch-orientierte Prozesse in Millisekunden. |
| `retryLimit` | `number` | Maximale Anzahl automatischer Wiederholungen bei Netzwerk-/Serverfehlern. |
| `retryBackoffMs` | `number` | Pause zwischen Wiederholungsversuchen in Millisekunden. |

### Konfiguration überschreiben

**Build-Pipeline / CI:**

1. Hinterlegen Sie eine Kopie von `public/config.json` als Template (z. B. `public/config.template.json`).
2. Ersetzen Sie Platzhalter beim Build, etwa mit `envsubst` oder eigenen Skripten, und schreiben Sie das Ergebnis nach `public/config.json`.

Beispiel (Linux/MacOS):

```bash
export WORKER_BASE="https://example.workers.dev"
envsubst < public/config.template.json > public/config.json
```

**Runtime-Injection (z. B. Cloudflare Worker, Nginx, Vercel Edge Middleware):**

```html
<script>
  window.__APP_CONFIG__ = {
    workerBase: "${env.WORKER_BASE}",
    throttleMs: Number("${env.THROTTLE_MS}") || undefined
  };
</script>
<script type="module" src="public/js/main.js"></script>
```

Der Inline-Block muss _vor_ dem Laden der Anwendungsskripte injiziert werden.

### Arbeiten mit `.env` und `dotenv` / Vite

Für lokale Builds mit Vite oder Node-Skripten kann `dotenv` genutzt werden, um eine Konfiguration aus Umgebungsvariablen zu erzeugen:

```bash
npm install --save-dev dotenv
```

```js
// scripts/generate-config.mjs
import { config as loadEnv } from 'dotenv';
import { writeFileSync } from 'node:fs';

loadEnv();

const appConfig = {
  workerBase: process.env.VITE_WORKER_BASE ?? 'https://imap-sales-worker.tekin-6af.workers.dev',
  throttleMs: Number(process.env.VITE_THROTTLE_MS ?? 1100),
  retryLimit: Number(process.env.VITE_RETRY_LIMIT ?? 2),
  retryBackoffMs: Number(process.env.VITE_RETRY_BACKOFF_MS ?? 3000)
};

writeFileSync('public/config.json', JSON.stringify(appConfig, null, 2));
```

Fügen Sie den Schritt z. B. in `package.json` ein:

```json
{
  "scripts": {
    "build:config": "node scripts/generate-config.mjs",
    "build": "npm run build:config && vite build"
  }
}
```

Vite ersetzt automatisch alle `VITE_*`-Variablen aus `.env`-Dateien. Für andere Bundler kann ein vergleichbarer Ansatz gewählt werden.

### Worker-/Server-Settings

Wenn die Anwendung hinter einem Cloudflare Worker betrieben wird, können Sie z. B. im Worker-`fetch`-Handler eine Antwort für `/public/config.json` erzeugen:

```js
if (new URL(request.url).pathname === '/public/config.json') {
  const cfg = {
    workerBase: env.WORKER_BASE,
    retryLimit: Number(env.RETRY_LIMIT ?? 2)
  };
  return new Response(JSON.stringify(cfg), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}
```

Dadurch lassen sich Worker-Settings direkt in die Anwendung spiegeln, ohne statische Assets erneut auszuliefern.

### Cloudflare Access / Single Sign-On

Die Anwendung wertet – sofern vorhanden – die von Cloudflare Access gesetzten HTTP-Header aus, um eingeloggte Personen automatisch zu erkennen. Der Worker liest die Header `CF-Access-Authenticated-User-Email` und `CF-Access-Authenticated-User-Name` (sowie einige Fallback-Namen) und gleicht sie mit den Einträgen in [`data/people.json`](data/people.json) ab. So können Eingaben im Tool direkt einer bekannten Person zugeordnet werden.

* **Session-Endpoint:** Das Frontend ruft beim Start `GET /session` auf. Die Route wird nur beantwortet, wenn `ALLOWED_ORIGIN` auf einen konkreten Origin gesetzt ist, damit CORS mit Cookies funktioniert. Ohne Access-Header antwortet der Worker mit einem leeren Session-Objekt.
* **Admin-Bereich:** Beim Anlegen neuer Personen schlägt das UI anhand des Nachnamens automatisch eine IMAP-Adresse vor (z. B. `vandenhoevel@imap-institut.de`). Die Adresse kann vor dem Speichern angepasst werden.

### Cloudflare-Worker aktualisieren (Schritt-für-Schritt)

Dein Cloudflare-Worker synchronisiert sich nicht automatisch mit diesem GitHub-Repository. Eine leicht verständliche Anleitung, wie du den Code manuell kopierst, die benötigten Zugangsdaten einträgst und das Frontend verbindest, findest du unter [`docs/cloudflare-worker-setup.md`](docs/cloudflare-worker-setup.md).

Wenn beim Mergen neue Worker-Versionen Konflikte erzeugen, hilft dir der Leitfaden [`docs/worker-merge-guide.md`](docs/worker-merge-guide.md) Schritt für Schritt weiter.
