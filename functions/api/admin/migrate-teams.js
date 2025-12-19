import { ghGetFile, ghPutFile } from '../../core/services/github.js';

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

  // --- SICHERHEITS-CHECK & FORMAT-ERKENNUNG ---
  let entries = [];
  if (entriesFile && Array.isArray(entriesFile.items)) {
    entries = entriesFile.items; 
  } else if (Array.isArray(entriesFile)) {
    entries = entriesFile; 
    console.log("Warnung: Altes Array-Format erkannt. Wird korrigiert.");
  }

  if (!entries || entries.length === 0) {
    return new Response('ABORT: Keine Einträge gefunden! Speicherung verhindert.', { status: 400 });
  }
  // ---------------------------------------------

  const peopleItems = Array.isArray(peopleFile.items) ? peopleFile.items : [];
  const teamByName = new Map(
    peopleItems.map((person) => [normalizeName(person?.name), person?.team || '']),
  );

  let updatedTotal = 0;
  entries.forEach((entry) => {
    // 1. Fixaufträge sichtbar machen
    if (entry.projectType === 'fix' || entry.source === 'erp') {
       if (!entry.dockPhase) entry.dockPhase = 4;
       if (!entry.phase) entry.phase = 4;
       if (!entry.dockFinalAssignment) {
         entry.dockFinalAssignment = 'fix';
         updatedTotal++; 
       }
    }
    // 2. Rahmenverträge sichtbar machen
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

  // Speichern - IMMER als Objekt verpackt { items: ... }
  await ghPutFile(
    env,
    entriesPath,
    { items: entries },
    entriesFile.sha,
    `MIGRATION: Saved teams & visibility (${updatedTotal} updates)`,
    branch,
  );
  
  return new Response(`ERFOLG: ${entries.length} Einträge geprüft, ${updatedTotal} Zuweisungen/Reparaturen durchgeführt.`, { status: 200 });
}
