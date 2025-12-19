export function registerPeopleRoutes(router, { ghGetFile, ghPutFile, normalizePersonRecord, normalizeString, rndId }) {
  router.get('/people', async ({ env, respond, peoplePath, branch }) => {
    try {
      const { items } = await ghGetFile(env, peoplePath, branch);
      const normalized = Array.isArray(items) ? items.map(normalizePersonRecord) : [];
      return respond(normalized);
    } catch (err) {
      const message = String(err || '');
      if (message.includes('404')) {
        return respond([]);
      }
      throw err;
    }
  });

  router.post('/people', async ({ env, respond, request, peoplePath, branch }) => {
    let body;
    try {
      body = await request.json();
    } catch {
      return respond({ error: 'Invalid JSON' }, 400);
    }
    const name = normalizeString(body.name);
    const team = normalizeString(body.team);
    if (!name || !team) return respond({ error: 'Name and Team required' }, 400);

    let email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';

    const cur = await ghGetFile(env, peoplePath, branch);
    const newPersonRaw = {
      ...body,
      id: body.id || rndId('person_'),
      name,
      team,
      createdAt: Date.now(),
    };
    if (email) {
      newPersonRaw.email = email;
    } else {
      delete newPersonRaw.email;
    }
    const newPerson = normalizePersonRecord(newPersonRaw);
    const currentItems = Array.isArray(cur.items) ? cur.items.slice() : [];
    currentItems.push(newPerson);
    await ghPutFile(env, peoplePath, currentItems.map(normalizePersonRecord), cur.sha, `add person ${name}`);
    return respond(newPerson, 201);
  });

  router.put('/people', async ({ env, respond, request, peoplePath, branch }) => {
    let body;
    try {
      body = await request.json();
    } catch {
      return respond({ error: 'Invalid JSON' }, 400);
    }
    if (!body.id) return respond({ error: 'ID missing' }, 400);
    const cur = await ghGetFile(env, peoplePath, branch);
    const idx = cur.items.findIndex((item) => String(item.id) === String(body.id));
    if (idx < 0) return respond({ error: 'not found' }, 404);
    const current = cur.items[idx] || {};
    const updated = { ...current };
    if (body.name !== undefined) {
      updated.name = normalizeString(body.name);
    }
    if (body.team !== undefined) {
      updated.team = normalizeString(body.team);
    }
    if (body.team !== undefined) {
      const currentTeam = normalizeString(current.team);
      const incomingTeam = normalizeString(updated.team);
      if (currentTeam && incomingTeam && currentTeam !== incomingTeam) {
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayString = yesterday.toISOString().slice(0, 10);
        const existingHistory = Array.isArray(body.teamHistory)
          ? body.teamHistory.slice()
          : Array.isArray(current.teamHistory)
            ? current.teamHistory.slice()
            : [];
        existingHistory.push({ team: currentTeam, until: yesterdayString });
        updated.teamHistory = existingHistory;
      }
    }
    if (body.email !== undefined) {
      let email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      if (email) {
        updated.email = email;
      } else {
        delete updated.email;
      }
    }
    updated.updatedAt = Date.now();
    const normalizedPerson = normalizePersonRecord(updated);
    const nextItems = Array.isArray(cur.items) ? cur.items.slice() : [];
    nextItems[idx] = normalizedPerson;
    await ghPutFile(env, peoplePath, nextItems.map(normalizePersonRecord), cur.sha, `update person ${body.id}`);
    return respond(normalizedPerson);
  });

  router.delete('/people', async ({ env, respond, request, peoplePath, branch }) => {
    let body;
    try {
      body = await request.json();
    } catch {
      return respond({ error: 'Invalid JSON' }, 400);
    }
    const idToDelete = body?.id;
    if (!idToDelete) return respond({ error: 'ID missing in request body' }, 400);
    const cur = await ghGetFile(env, peoplePath, branch);
    const initialLength = cur.items.length;
    const next = cur.items.filter((item) => String(item.id) !== String(idToDelete));
    if (next.length === initialLength) return respond({ error: 'not found' }, 404);
    await ghPutFile(env, peoplePath, next.map(normalizePersonRecord), cur.sha, `delete person ${idToDelete}`);
    return respond({ ok: true });
  });
}
