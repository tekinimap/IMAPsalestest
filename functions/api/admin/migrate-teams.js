import { ghGetFile, ghPutFile } from '../../services/github.js';

function normalizeName(value) {
  return String(value || '').trim().toLowerCase();
}

function isAdminRequest(request, env) {
  const secret = String(env.ADMIN_SECRET || env.ADMIN_TOKEN || '').trim();
  if (!secret) return false;
  const authHeader = String(request.headers.get('authorization') || '').trim();
  const token = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7) : '';
  const headerSecret = String(request.headers.get('x-admin-secret') || '').trim();
  return token === secret || headerSecret === secret;
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
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }
  if (!isAdminRequest(request, env)) {
    return new Response('forbidden', { status: 403 });
  }

  const entriesPath = env.GH_PATH || 'data/entries.json';
  const peoplePath = env.GH_PEOPLE_PATH || 'data/people.json';
  const branch = env.GH_BRANCH;

  const [entriesFile, peopleFile] = await Promise.all([
    ghGetFile(env, entriesPath, branch),
    ghGetFile(env, peoplePath, branch),
  ]);

  const peopleItems = Array.isArray(peopleFile.items) ? peopleFile.items : [];
  const teamByName = new Map(
    peopleItems.map((person) => [normalizeName(person?.name), person?.team || '']),
  );

  const entries = Array.isArray(entriesFile.items) ? entriesFile.items : [];
  let updatedEntries = 0;
  let updatedPeople = 0;

  entries.forEach((entry) => {
    const before = updatedPeople;
    updatedPeople += applySavedTeam(entry?.list, teamByName);
    updatedPeople += applySavedTeam(entry?.rows, teamByName);
    if (Array.isArray(entry?.transactions)) {
      entry.transactions.forEach((transaction) => {
        updatedPeople += applySavedTeam(transaction?.list, teamByName);
      });
    }
    if (updatedPeople > before) updatedEntries += 1;
  });

  if (updatedPeople > 0) {
    await ghPutFile(
      env,
      entriesPath,
      entries,
      entriesFile.sha,
      `migrate savedTeam (${updatedPeople})`,
      branch,
    );
  }

  const message = `${updatedEntries} Einträge aktualisiert`;
  return new Response(JSON.stringify({ message }), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
