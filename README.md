# IMAPsalestest

Salesbeiträge Test

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
<script type="module" src="public/js/app.js"></script>
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
