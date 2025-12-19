import { ghGetFile, ghPutFile } from '../../services/github.js';

function normalizeName(value) {
  return String(value || '').trim().toLowerCase();
}

function applySavedTeam(list, teamByName) {
  if (!Array.isArray(list)) return 0;
  let updated = 0;
  list.forEach((item) => {
    if (!item || typeof item !== 'object') return;
    if (item.savedTeam) return; 
    const name = item.name || item.person || item.personName || '';
    const team = teamByName.get(normalizeName(name));
    if (!team) return;
    item.savedTeam = team;
    updated += 1;
  });
  return updated;
}

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const secretParam = url.searchParams.get('secret');
  const envSecret = env.ADMIN_SECRET || env.ADMIN_TOKEN;
  
  if (!secretParam || secretParam !== envSecret) {
    return new Response('Forbidden: Falsches Secret', { status: 403 });
  }

  const entriesPath = env.GH_PATH || 'data/entries.json';
  const peoplePath = env.GH_PEOPLE_PATH || 'data/people.json';
  const branch = env.GH_BRANCH || 'main';

  const [entriesFile, peopleFile] = await Promise.all([
    ghGetFile(env, entriesPath, branch),
    ghGetFile(env, peoplePath, branch),
  ]);

  // --- SICHERHEITS-CHECK & FORMAT-TOLERANZ ---
  let entries = [];
  if (entriesFile && Array.isArray(entriesFile.items)) {
    entries = entriesFile.items; // Korrektes Format { items: [...] }
  } else if (Array.isArray(entriesFile)) {
    entries = entriesFile; // Altes Array-Format [...]
    console.log("MIGRATION: Array-Format erkannt, werde es korrigieren.");
  }

  if (!entries || entries.length === 0) {
    // Wenn wirklich leer, lieber abbrechen statt leere Datei zu speichern
    return new Response('ABORT: Keine Einträge gefunden! Speicherung verhindert.', { status: 400 });
  }

  const peopleItems = Array.isArray(peopleFile.items) ? peopleFile.items : [];
  const teamByName = new Map(
    peopleItems.map((person) => [normalizeName(person?.name), person?.team || '']),
  );

  let updatedTotal = 0;
  entries.forEach((entry) => {
    // 1. Fixaufträge sichtbar machen (Dock & Portfolio)
    if (entry.projectType === 'fix' || entry.source === 'erp') {
       if (!entry.dockPhase) entry.dockPhase = 4;
       if (!entry.phase) entry.phase = 4;
       if (!entry.dockFinalAssignment) {
         entry.dockFinalAssignment = 'fix';
         updatedTotal++; 
       }
    }
    // 2. Rahmenverträge sichtbar machen (Start Dock)
    if (entry.projectType === 'rahmen' && !entry.dockPhase) {
       entry.dockPhase = 1;
       entry.phase = 1;
       updatedTotal++;
    }

    // 3. Teams zuweisen
    updatedTotal += applySavedTeam(entry?.list, teamByName);
    updatedTotal += applySavedTeam(entry?.rows, teamByName);
    if (Array.isArray(entry?.transactions)) {
      entry.transactions.forEach((transaction) => {
        updatedTotal += applySavedTeam(transaction?.list, teamByName);
      });
    }
  });

  // --- FIX START: Robuste Reparatur für ALLE Einträge ---
  if (entries && entries.length > 0) {
    console.log('Starte Reparatur der Team-Zuordnungen...');
    let fixedCount = 0;

    entries.forEach((entry) => {
      let teamFound = null;

      // 1. Versuchen, das Team aus der Liste zu retten (wie zuvor)
      if (entry.list && entry.list.length > 0) {
        const dominantItem = [...entry.list].sort((a, b) => (b.pct || 0) - (a.pct || 0))[0];
        if (dominantItem && dominantItem.savedTeam) {
          teamFound = dominantItem.savedTeam;
        }
      }

      // 2. Sicherheits-Check: Eigenschaften MÜSSEN existieren
      let changed = false;

      // Wenn wir ein Team gefunden haben, setzen wir es.
      // WICHTIG: Wenn KEINS gefunden wurde, aber die Eigenschaft komplett fehlt,
      // setzen wir sie auf einen leeren String "", damit das Frontend nicht crasht.
      if (teamFound) {
        if (entry.marketTeam !== teamFound) {
          entry.marketTeam = teamFound;
          changed = true;
        }
        if (entry.team !== teamFound) {
          entry.team = teamFound;
          changed = true;
        }
      } else {
        // Fallback für manuelle Einträge ohne Liste:
        // Existiert der Key gar nicht? Dann setze ihn auf ""
        if (typeof entry.marketTeam === 'undefined') {
          entry.marketTeam = '';
          changed = true;
        }
        if (typeof entry.team === 'undefined') {
          entry.team = '';
          changed = true;
        }
      }

      if (changed) {
        fixedCount += 1;
      }
    });

    console.log(`Reparatur abgeschlossen: ${fixedCount} Einträge wurden (neu) initialisiert.`);
  }
  // --- FIX END ---

  // WICHTIG: Speichern als OBJEKT { items: ... }
  // Das verhindert, dass die Datei beim nächsten Mal kaputt geht.
  await ghPutFile(
    env,
    entriesPath,
    { items: entries }, 
    entriesFile.sha,
    `MIGRATION: Saved teams & visibility (${updatedTotal} updates)`,
    branch,
  );
  
  return new Response(`ERFOLG: ${entries.length} Einträge geprüft/korrigiert.`, { status: 200 });
}
