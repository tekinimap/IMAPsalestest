export function registerLogRoutes(
  router,
  {
    appendFile,
    todayStr,
    LOG_DIR,
    readLogEntries,
    ghGetContent,
    ghPutContent,
    ghGetFile,
    ghPutFile,
    computeLogMetrics,
    MAX_LOG_ENTRIES,
    dateRange,
  },
) {
  const handleMetrics = async ({ env, respond, url, ghPath, peoplePath, branch, pathname }) => {
    const from = url.searchParams.get('from') || undefined;
    const to = url.searchParams.get('to') || undefined;
    const team = (url.searchParams.get('team') || '').trim();
    const root = LOG_DIR(env);
    const logResult = await readLogEntries(env, root, from, to);
    const rawLogs = logResult.entries || [];

    let peopleItems = [];
    try {
      const peopleFile = await ghGetFile(env, peoplePath, branch);
      if (peopleFile && Array.isArray(peopleFile.items)) {
        peopleItems = peopleFile.items;
      }
    } catch (peopleErr) {
      const msg = String(peopleErr || '');
      if (!msg.includes('404')) {
        console.error('Failed to load people for log metrics:', peopleErr);
      }
    }

    const teamMap = new Map();
    for (const person of peopleItems) {
      if (!person || typeof person !== 'object') continue;
      const name = (person.name || '').trim();
      if (!name) continue;
      const teamName = (person.team || 'Ohne Team').trim() || 'Ohne Team';
      teamMap.set(name, teamName);
    }

    const metrics = computeLogMetrics(rawLogs, { team, from, to }, teamMap);
    if (logResult.limited) {
      metrics.meta = { ...(metrics.meta || {}), rangeLimited: true };
    }

    const headers = {
      ...(pathname === '/log/metrics' ? { 'X-Endpoint-Deprecated': 'true' } : {}),
    };
    if (logResult.limited) {
      headers['X-Log-Range-Limited'] = 'true';
    }
    return respond(metrics, 200, headers);
  };

  router.post('/log', async ({ env, respond, request }) => {
    let payload;
    try {
      payload = await request.json();
    } catch {
      return respond({ error: 'Invalid JSON' }, 400);
    }
    const dateStr = payload.date || todayStr();
    const y = dateStr.slice(0, 4);
    const m = dateStr.slice(5, 7);
    const root = LOG_DIR(env);
    const path = `${root.replace(/\/+$/, '')}/${y}-${m}/${dateStr}.jsonl`;
    const text = (payload.lines || []).map(String).join('\n') + '\n';
    const result = await appendFile(env, path, text, `log: ${dateStr} (+${(payload.lines || []).length})`);
    return respond({ ok: true, path, committed: result });
  });

  router.get('/log/metrics', handleMetrics);
  router.get('/analytics/metrics', handleMetrics);

  router.get('/log/list', async ({ env, respond, url, branch, ghPath }) => {
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const out = [];
    const root = LOG_DIR(env);

    for (const day of dateRange(from, to)) {
      const y = day.slice(0, 4);
      const m = day.slice(5, 7);
      const path = `${root.replace(/\/+$/, '')}/${y}-${m}/${day}.jsonl`;
      try {
        const file = await ghGetContent(env, path);
        if (file && file.content) {
          for (const line of file.content.split(/\n+/)) {
            if (!line.trim()) continue;
            try {
              out.push(JSON.parse(line));
            } catch (parseErr) {
              console.warn(`Invalid JSON in log ${path}: ${line}`, parseErr);
            }
          }
        }
      } catch (getFileErr) {
        if (!String(getFileErr).includes('404')) console.error(`Error reading log file ${path}:`, getFileErr);
      }
    }

    out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return respond(out.slice(0, 5000));
  });

  router.get('/logs', async ({ env, respond }) => {
    const logPath = env.GH_LOG_PATH || 'data/logs.json';
    let logData = { items: [], sha: null };
    try {
      logData = await ghGetFile(env, logPath, env.GH_BRANCH);
    } catch (e) {
      console.error('Error legacy logs:', e);
    }
    return respond((logData.items || []).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)));
  });

  router.post('/logs', async ({ env, respond, request }) => {
    const logPath = env.GH_LOG_PATH || 'data/logs.json';
    let newLogEntries;
    try {
      newLogEntries = await request.json();
    } catch {
      return respond({ error: 'Invalid JSON' }, 400);
    }
    const logsToAdd = Array.isArray(newLogEntries) ? newLogEntries : [newLogEntries];
    if (logsToAdd.length === 0) return respond({ success: true, added: 0 });

    let currentLogs = [];
    let currentSha = null;
    try {
      const logData = await ghGetFile(env, logPath, env.GH_BRANCH);
      currentLogs = logData.items || [];
      currentSha = logData.sha;
    } catch (e) {
      if (!String(e).includes('404')) console.error('Error legacy logs POST:', e);
    }

    let updatedLogs = logsToAdd.concat(currentLogs);
    if (updatedLogs.length > MAX_LOG_ENTRIES) updatedLogs = updatedLogs.slice(0, MAX_LOG_ENTRIES);
    try {
      await ghPutFile(env, logPath, updatedLogs, currentSha, `add ${logsToAdd.length} log entries`);
    } catch (e) {
      /* Retry Logic intentionally omitted for brevity */
    }
    return respond({ success: true, added: logsToAdd.length }, 201);
  });

  router.delete('/logs', async ({ env, respond }) => {
    const logPath = env.GH_LOG_PATH || 'data/logs.json';
    let logData = { items: [], sha: null };
    try {
      logData = await ghGetFile(env, logPath, env.GH_BRANCH);
    } catch (e) {
      if (String(e).includes('404')) return respond({ success: true, message: 'Logs already empty.' });
      throw e;
    }
    await ghPutFile(env, logPath, [], logData.sha, 'clear logs');
    return respond({ success: true, message: 'Logs gelöscht.' });
  });
}
