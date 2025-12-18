export function registerValidationRoutes(
  router,
  {
    ghGetFile,
    kvListFrom,
    validateKvNumberUsage,
    validateProjectNumberUsage,
    readValidationCache,
    writeValidationCache,
    findDuplicateKv,
    isDockEntryActive,
    isAdminRequest,
    normalizeString,
  },
) {
  router.post('/api/validation/check_kv', async ({ request, env, respond, ghPath, branch }) => {
    let body;
    try {
      body = await request.json();
    } catch {
      return respond({ error: 'Invalid JSON' }, 400);
    }

    const kvList = kvListFrom(body);
    const cacheKey = `kv:${kvList.join('|')}:id:${body.id || ''}`;
    const cached = readValidationCache(cacheKey);
    if (cached) return respond(cached);

    const { items } = await ghGetFile(env, ghPath, branch);
    const active = items.filter(isDockEntryActive);
    const result = validateKvNumberUsage(active, kvList, body.id ? String(body.id) : undefined);
    writeValidationCache(cacheKey, result);
    return respond(result);
  });

  router.post('/api/validation/check_projektnummer', async ({ request, env, respond, ghPath, branch }) => {
    let body;
    try {
      body = await request.json();
    } catch {
      return respond({ error: 'Invalid JSON' }, 400);
    }

    const projectNumber = body.projectNumber || body.projektnummer || body.project_no || '';
    const cacheKey = `pn:${normalizeString(projectNumber).toLowerCase()}:id:${body.id || ''}`;
    const cached = readValidationCache(cacheKey);
    if (cached) return respond(cached);

    const { items } = await ghGetFile(env, ghPath, branch);
    const active = items.filter(isDockEntryActive);
    const result = validateProjectNumberUsage(active, projectNumber, body.id ? String(body.id) : undefined);
    writeValidationCache(cacheKey, result);
    return respond(result);
  });

  router.get('/api/admin/validation/legacy_report', async ({ request, env, respond, ghPath, branch }) => {
    if (!isAdminRequest(request, env)) {
      return respond({ error: 'forbidden' }, 403);
    }

    const { items } = await ghGetFile(env, ghPath, branch);
    const active = items.filter(isDockEntryActive);
    const offenders = [];
    const seen = new Set();

    for (const entry of active) {
      const kvList = kvListFrom(entry);
      const conflict = findDuplicateKv(active, kvList, entry.id);
      if (conflict && conflict.entry) {
        const key = [entry.id, conflict.entry.id].sort().join('::');
        if (seen.has(key)) continue;
        seen.add(key);
        offenders.push({
          cardId: entry.id,
          title: entry.title || '',
          kvNummer: conflict.conflict,
          conflictingCardId: conflict.entry.id,
        });
      }
    }

    return respond(offenders, 200, { 'Content-Type': 'application/json; charset=utf-8' });
  });
}
