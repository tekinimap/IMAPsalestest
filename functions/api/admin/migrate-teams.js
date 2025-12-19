import { ghGetFile, ghPutFile } from '../../services/github.js';
function normalizeName(value) { return String(value || '').trim().toLowerCase(); }

function applySavedTeam(list, teamByName) { if (!Array.isArray(list)) return 0; let updated = 0; list.forEach((item) => { if (!item || typeof item !== 'object') return; // Nur setzen, wenn noch nicht vorhanden (History Baking) if (item.savedTeam) return;

const name = item.name || item.person || item.personName || '';
const team = teamByName.get(normalizeName(name));
if (!team) return;
item.savedTeam = team; updated += 1;


});
return updated;
}
// WICHTIG: onRequestGet erlaubt den Aufruf im Browser export async function onRequestGet({ request, env }) { // 1. Auth Check via URL Parameter (?secret=...) const url = new URL(request.url); const secretParam = url.searchParams.get('secret'); const envSecret = env.ADMIN_SECRET || env.ADMIN_TOKEN;

if (!secretParam || secretParam !== envSecret) { return new Response('Forbidden: Falsches Secret', { status: 403 }); }

// 2. Daten laden const entriesPath = env.GH_PATH || 'data/entries.json'; const peoplePath = env.GH_PEOPLE_PATH || 'data/people.json'; const branch = env.GH_BRANCH || 'main';

const [entriesFile, peopleFile] = await Promise.all([ ghGetFile(env, entriesPath, branch), ghGetFile(env, peoplePath, branch), ]);

// 3. Mapping bauen (Person -> Aktuelles Team) const peopleItems = Array.isArray(peopleFile.items) ? peopleFile.items : []; const teamByName = new Map( peopleItems.map((person) => [normalizeName(person?.name), person?.team || '']), );

// 4. Einträge aktualisieren ("Baken") const entries = Array.isArray(entriesFile.items) ? entriesFile.items : []; let updatedTotal = 0; let entriesModified = 0;

entries.forEach((entry) => { const startCount = updatedTotal; updatedTotal += applySavedTeam(entry?.list, teamByName); updatedTotal += applySavedTeam(entry?.rows, teamByName); // Falls rows existieren (Fixaufträge)

if (Array.isArray(entry?.transactions)) {
  entry.transactions.forEach((transaction) => {
    updatedTotal += applySavedTeam(transaction?.list, teamByName);
  });
}
if (updatedTotal > startCount) entriesModified++;


});
// 5. Speichern (nur wenn nötig) if (updatedTotal > 0) { await ghPutFile( env, entriesPath, { items: entries }, // Wichtig: Struktur behalten entriesFile.sha, `MIGRATION: Saved teams baked into history (${updatedTotal} changes)`, branch, ); return new Response(`ERFOLG: ${updatedTotal} Zuweisungen in ${entriesModified} Einträgen festgeschrieben.`, { status: 200 }); } else { return new Response('INFO: Keine Änderungen nötig. Alle Einträge haben bereits ein savedTeam.', { status: 200 }); } }
