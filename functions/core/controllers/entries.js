// functions/core/controllers/entries.js
/**
 * Entries API (Projects + Transactions) backed by Cloudflare D1 (env.DB).
 *
 * ✅ Speichert NUR in D1 (env.DB) – entries.json wird hier nicht verwendet.
 * ✅ Unterstützt /entries/* UND legacy /api/entries/* (falls Frontend noch alte Pfade nutzt).
 */

const PORTFOLIO_PHASE = 4;

function toLowerSafe(v) {
  return (v ?? '').toString().trim().toLowerCase();
}

function isDockPhase123(v) {
  const n = Number(v);
  return n === 1 || n === 2 || n === 3;
}

function jsonParseSafe(str, fallback = {}) {
  try {
    if (str == null || str === '') return fallback;
    const obj = JSON.parse(str);
    return obj && typeof obj === 'object' ? obj : fallback;
  } catch {
    return fallback;
  }
}

function makeFallbackId(prefix = 'entry') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function numOr(value, fallback) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function packProject(entry) {
  const {
    id,
    projectType,
    client,
    title,
    projectNumber,
    amount,
    dockPhase,
    dockFinalAssignment,
    ts,
    freigabedatum,
    transactions,
    ...rest
  } = entry || {};

  const packed = {
    id: (id ?? '').toString(),
    projectType: (projectType ?? 'fix').toString() || 'fix',
    client: (client ?? '').toString(),
    title: (title ?? '').toString(),
    projectNumber: (projectNumber ?? '').toString(),
    amount: numOr(amount, 0),
    dockPhase: dockPhase == null || dockPhase === '' ? null : numOr(dockPhase, null),
    dockFinalAssignment:
      dockFinalAssignment == null || dockFinalAssignment === '' ? null : dockFinalAssignment.toString(),
    ts: numOr(ts, Date.now()),
    freigabedatum: numOr(freigabedatum, 0),
    data: JSON.stringify(rest || {}),
  };

  const tx = Array.isArray(transactions) ? transactions : null;

  return { project: packed, transactions: tx };
}

function unpackTransaction(row) {
  if (!row) return null;
  const data = jsonParseSafe(row.data, {});
  return {
    id: row.id,
    parentId: row.project_id,
    kv_nummer: row.kv_nummer ?? '',
    type: row.type ?? '',
    amount: row.amount ?? 0,
    title: row.title ?? '',
    client: row.client ?? '',
    ts: row.ts ?? 0,
    freigabedatum: row.freigabedatum ?? 0,
    ...data,
  };
}

function packTransaction(tx, fallbackProjectId) {
  const {
    id,
    parentId,
    project_id,
    projectId,
    kv_nummer,
    type,
    amount,
    title,
    client,
    ts,
    freigabedatum,
    ...rest
  } = tx || {};

  const resolvedProjectId = parentId ?? project_id ?? projectId ?? fallbackProjectId;

  return {
    id: (id ?? '').toString(),
    project_id: (resolvedProjectId ?? '').toString(),
    kv_nummer: (kv_nummer ?? '').toString(),
    type: (type ?? '').toString(),
    amount: numOr(amount, 0),
    title: (title ?? '').toString(),
    client: (client ?? '').toString(),
    ts: numOr(ts, Date.now()),
    freigabedatum: numOr(freigabedatum, 0),
    data: JSON.stringify(rest || {}),
  };
}

function unpackProject(projectRow, txRows) {
  if (!projectRow) return null;
  const data = jsonParseSafe(projectRow.data, {});
  const tx = Array.isArray(txRows) ? txRows.map(unpackTransaction).filter(Boolean) : [];
  return {
    id: projectRow.id,
    projectType: projectRow.projectType ?? 'fix',
    client: projectRow.client ?? '',
    title: projectRow.title ?? '',
    projectNumber: projectRow.projectNumber ?? '',
    amount: projectRow.amount ?? 0,
    dockPhase: projectRow.dockPhase ?? null,
    dockFinalAssignment: projectRow.dockFinalAssignment ?? null,
    ts: projectRow.ts ?? 0,
    freigabedatum: projectRow.freigabedatum ?? 0,
    transactions: tx,
    ...data,
  };
}

async function runBatched(env, statements, chunkSize = 50) {
  for (let i = 0; i < statements.length; i += chunkSize) {
    const slice = statements.slice(i, i + chunkSize);
    await env.DB.batch(slice);
  }
}

async function readBodyJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function fetchProjectRow(env, id) {
  return await env.DB.prepare('SELECT * FROM projects WHERE id = ?').bind(id).first();
}

async function fetchTransactionsRows(env, projectId) {
  const res = await env.DB.prepare('SELECT * FROM transactions WHERE project_id = ? ORDER BY ts ASC')
    .bind(projectId)
    .all();
  return res?.results || [];
}

async function fetchFullEntry(env, id) {
  const p = await fetchProjectRow(env, id);
  if (!p) return null;
  const tx = await fetchTransactionsRows(env, id);
  return unpackProject(p, tx);
}

function applyImportPortfolioRules(entry, { force = false } = {}) {
  const source = toLowerSafe(entry?.source);
  if (!force && source !== 'erp-import' && source !== 'excel-import') return entry;

  const next = { ...entry };

  // Immer ins Portfolio (Phase 4)
  next.dockPhase = PORTFOLIO_PHASE;

  // Sicherstellen, dass das Frontend den Deal NICHT mehr als "Dock" behandelt.
  if (!next.dockFinalAssignment) {
    const pt = toLowerSafe(next.projectType);
    next.dockFinalAssignment = pt === 'rahmen' ? 'rahmen' : pt === 'abruf' ? 'abruf' : 'fix';
    if (!next.dockFinalAssignmentAt) next.dockFinalAssignmentAt = Date.now();
  }

  return next;
}

function shouldSyncToHubspot(entry) {
  // Nur HubSpot Deals syncen – und niemals solange sie in Dock (Phase 1-3) sind.
  const isHubspot = toLowerSafe(entry?.source) === 'hubspot';
  if (!isHubspot) return false;

  if (isDockPhase123(entry?.dockPhase)) return false;

  return true;
}

export function registerEntryRoutes(
  router,
  { processHubspotSyncQueue, collectHubspotSyncPayload, logJSONL, rndId } = {}
) {
  const idFactory = (prefix) => (typeof rndId === 'function' ? rndId(prefix) : makeFallbackId(prefix));

  function mount(prefix = '') {
    const p = prefix ? prefix.replace(/\/+$/, '') : '';
    const path = (suffix) => `${p}${suffix}`;

    // 1) GET all entries
    router.get(path('/entries'), async ({ env, respond }) => {
      if (!env.DB) return respond({ error: 'DB binding missing' }, 500);

      try {
        const projectsRes = await env.DB.prepare('SELECT * FROM projects ORDER BY ts DESC').all();
        const txRes = await env.DB.prepare('SELECT * FROM transactions ORDER BY ts ASC').all();

        const txByProject = new Map();
        for (const tx of txRes?.results || []) {
          const pid = tx.project_id;
          if (!txByProject.has(pid)) txByProject.set(pid, []);
          txByProject.get(pid).push(tx);
        }

        const entries = (projectsRes?.results || []).map((pRow) =>
          unpackProject(pRow, txByProject.get(pRow.id) || [])
        );

        return respond(entries);
      } catch (err) {
        return respond({ error: 'Failed to load entries', details: err?.message || String(err) }, 500);
      }
    });

    // 2) GET single entry
    router.get(path('/entries/:id'), async ({ env, respond, params }) => {
      if (!env.DB) return respond({ error: 'DB binding missing' }, 500);

      const id = params?.id;
      if (!id) return respond({ error: 'Missing id' }, 400);

      try {
        const entry = await fetchFullEntry(env, id);
        if (!entry) return respond({ error: 'Not found' }, 404);
        return respond(entry);
      } catch (err) {
        return respond({ error: 'Failed to load entry', details: err?.message || String(err) }, 500);
      }
    });

    // 3) POST create entry (manual deals)
    router.post(path('/entries'), async ({ env, request, respond }) => {
      if (!env.DB) return respond({ error: 'DB binding missing' }, 500);

      const body = await readBodyJson(request);
      if (!body || typeof body !== 'object') return respond({ error: 'Invalid JSON body' }, 400);

      const id = body.id ? body.id.toString() : idFactory('entry');

      // Falls ein Import doch über POST kommt: Import-Regeln anwenden
      const entryToStore = applyImportPortfolioRules({ ...body, id });

      const { project, transactions } = packProject(entryToStore);

      const stmts = [];

      // Upsert project
      stmts.push(
        env.DB.prepare(
          `INSERT OR REPLACE INTO projects
           (id, projectType, client, title, projectNumber, amount, dockPhase, dockFinalAssignment, ts, freigabedatum, data)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          project.id,
          project.projectType,
          project.client,
          project.title,
          project.projectNumber,
          project.amount,
          project.dockPhase,
          project.dockFinalAssignment,
          project.ts,
          project.freigabedatum,
          project.data
        )
      );

      // Replace transactions
      stmts.push(env.DB.prepare('DELETE FROM transactions WHERE project_id = ?').bind(project.id));

      const txList = Array.isArray(transactions) ? transactions : [];
      for (const tx of txList) {
        const packedTx = packTransaction(
          { ...tx, parentId: tx.parentId ?? project.id, id: tx.id ?? idFactory('tx') },
          project.id
        );
        stmts.push(
          env.DB.prepare(
            `INSERT OR REPLACE INTO transactions
             (id, project_id, kv_nummer, type, amount, title, client, ts, freigabedatum, data)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            packedTx.id,
            packedTx.project_id,
            packedTx.kv_nummer,
            packedTx.type,
            packedTx.amount,
            packedTx.title,
            packedTx.client,
            packedTx.ts,
            packedTx.freigabedatum,
            packedTx.data
          )
        );
      }

      try {
        await runBatched(env, stmts);

        // Logging darf NIE den Request kaputt machen
        if (typeof logJSONL === 'function') {
          try {
            await logJSONL(env, {
              kind: 'entry_create',
              id: project.id,
              ts: Date.now(),
              source: entryToStore.source ?? null,
            });
          } catch {}
        }

        const stored = await fetchFullEntry(env, project.id);
        return respond(stored || { ok: true, id: project.id }, 201);
      } catch (err) {
        return respond({ error: 'Failed to create entry', details: err?.message || String(err) }, 500);
      }
    });

    // 4) PUT upsert entry (updates + "create if missing")
    router.put(path('/entries/:id'), async ({ env, request, respond, params }) => {
      if (!env.DB) return respond({ error: 'DB binding missing' }, 500);

      const id = params?.id;
      if (!id) return respond({ error: 'Missing id' }, 400);

      const body = await readBodyJson(request);
      if (!body || typeof body !== 'object') return respond({ error: 'Invalid JSON body' }, 400);

      try {
        const before = await fetchFullEntry(env, id);

        // Merge: Partial updates dürfen keine Felder "leer machen"
        const mergedRaw = {
          ...(before || {}),
          ...body,
          id,
          transactions: Object.prototype.hasOwnProperty.call(body, 'transactions')
            ? Array.isArray(body.transactions)
              ? body.transactions
              : []
            : before?.transactions || [],
        };

        // Falls ein Import über PUT kommt: Import-Regeln anwenden
        const merged = applyImportPortfolioRules(mergedRaw);

        const { project, transactions } = packProject(merged);

        const stmts = [];

        // Upsert project
        stmts.push(
          env.DB.prepare(
            `INSERT OR REPLACE INTO projects
             (id, projectType, client, title, projectNumber, amount, dockPhase, dockFinalAssignment, ts, freigabedatum, data)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            project.id,
            project.projectType,
            project.client,
            project.title,
            project.projectNumber,
            project.amount,
            project.dockPhase,
            project.dockFinalAssignment,
            project.ts,
            project.freigabedatum,
            project.data
          )
        );

        // Replace transactions (weil wir sie gemerged haben)
        stmts.push(env.DB.prepare('DELETE FROM transactions WHERE project_id = ?').bind(project.id));

        const txList = Array.isArray(transactions) ? transactions : [];
        for (const tx of txList) {
          const packedTx = packTransaction(
            { ...tx, parentId: tx.parentId ?? project.id, id: tx.id ?? idFactory('tx') },
            project.id
          );
          stmts.push(
            env.DB.prepare(
              `INSERT OR REPLACE INTO transactions
               (id, project_id, kv_nummer, type, amount, title, client, ts, freigabedatum, data)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).bind(
              packedTx.id,
              packedTx.project_id,
              packedTx.kv_nummer,
              packedTx.type,
              packedTx.amount,
              packedTx.title,
              packedTx.client,
              packedTx.ts,
              packedTx.freigabedatum,
              packedTx.data
            )
          );
        }

        await runBatched(env, stmts);

        const after = await fetchFullEntry(env, id);

        // HubSpot Sync darf NIE die Speicherung blockieren – und wird stark eingeschränkt
        if (
          after &&
          shouldSyncToHubspot(after) &&
          typeof collectHubspotSyncPayload === 'function' &&
          typeof processHubspotSyncQueue === 'function'
        ) {
          try {
            const payload = collectHubspotSyncPayload(before, after);
            if (payload) {
              await processHubspotSyncQueue(env, [payload], { reason: 'entry_update' });
            }
          } catch {}
        }

        if (typeof logJSONL === 'function') {
          try {
            await logJSONL(env, {
              kind: before ? 'entry_update' : 'entry_upsert_create',
              id,
              ts: Date.now(),
              source: after?.source ?? merged?.source ?? null,
            });
          } catch {}
        }

        return respond(after || { ok: true, id }, before ? 200 : 201);
      } catch (err) {
        return respond({ error: 'Failed to upsert entry', details: err?.message || String(err) }, 500);
      }
    });

    // 5) DELETE entry
    router.delete(path('/entries/:id'), async ({ env, respond, params }) => {
      if (!env.DB) return respond({ error: 'DB binding missing' }, 500);

      const id = params?.id;
      if (!id) return respond({ error: 'Missing id' }, 400);

      try {
        await env.DB.batch([
          env.DB.prepare('DELETE FROM transactions WHERE project_id = ?').bind(id),
          env.DB.prepare('DELETE FROM projects WHERE id = ?').bind(id),
        ]);

        if (typeof logJSONL === 'function') {
          try {
            await logJSONL(env, { kind: 'entry_delete', id, ts: Date.now() });
          } catch {}
        }

        return respond({ ok: true, id });
      } catch (err) {
        return respond({ error: 'Failed to delete entry', details: err?.message || String(err) }, 500);
      }
    });

    // 6) Bulk delete
    router.post(path('/entries/bulk-delete'), async ({ env, request, respond }) => {
      if (!env.DB) return respond({ error: 'DB binding missing' }, 500);

      const body = await readBodyJson(request);
      const ids = Array.isArray(body?.ids) ? body.ids.map((v) => v?.toString()).filter(Boolean) : null;
      if (!ids || ids.length === 0) return respond({ error: 'Missing ids[]' }, 400);

      const stmts = [];
      for (const id of ids) {
        stmts.push(env.DB.prepare('DELETE FROM transactions WHERE project_id = ?').bind(id));
        stmts.push(env.DB.prepare('DELETE FROM projects WHERE id = ?').bind(id));
      }

      try {
        await runBatched(env, stmts);
        return respond({ ok: true, deleted: ids.length });
      } catch (err) {
        return respond({ error: 'Bulk delete failed', details: err?.message || String(err) }, 500);
      }
    });

    // 7) Bulk upsert (Excel / ERP import)
    router.post(path('/entries/bulk-v2'), async ({ env, request, respond }) => {
      if (!env.DB) return respond({ error: 'DB binding missing' }, 500);

      const body = await readBodyJson(request);
      if (!body || typeof body !== 'object') return respond({ error: 'Invalid JSON body' }, 400);

      const rows = Array.isArray(body.rows) ? body.rows : Array.isArray(body.items) ? body.items : [];
      const dryRun = body.dryRun === true;

      if (!Array.isArray(rows) || rows.length === 0) {
        return respond({ ok: true, rows: 0, dryRun, upserted: 0 });
      }

      let upserted = 0;
      const stmts = [];

      for (const raw of rows) {
        if (!raw || typeof raw !== 'object') continue;

        const id = raw.id ? raw.id.toString() : idFactory('entry');

        // Bulk-V2 ist Import: Regeln IMMER erzwingen (Phase 4 + Portfolio)
        const row = applyImportPortfolioRules({ ...raw, id }, { force: true });

        const { project, transactions } = packProject(row);

        if (!dryRun) {
          stmts.push(
            env.DB.prepare(
              `INSERT OR REPLACE INTO projects
               (id, projectType, client, title, projectNumber, amount, dockPhase, dockFinalAssignment, ts, freigabedatum, data)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).bind(
              project.id,
              project.projectType,
              project.client,
              project.title,
              project.projectNumber,
              project.amount,
              project.dockPhase,
              project.dockFinalAssignment,
              project.ts,
              project.freigabedatum,
              project.data
            )
          );

          // Transactions nur anfassen, wenn mitgeliefert.
          if (Array.isArray(transactions)) {
            stmts.push(env.DB.prepare('DELETE FROM transactions WHERE project_id = ?').bind(project.id));
            for (const tx of transactions) {
              const packedTx = packTransaction(
                { ...tx, parentId: tx.parentId ?? project.id, id: tx.id ?? idFactory('tx') },
                project.id
              );
              stmts.push(
                env.DB.prepare(
                  `INSERT OR REPLACE INTO transactions
                   (id, project_id, kv_nummer, type, amount, title, client, ts, freigabedatum, data)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                ).bind(
                  packedTx.id,
                  packedTx.project_id,
                  packedTx.kv_nummer,
                  packedTx.type,
                  packedTx.amount,
                  packedTx.title,
                  packedTx.client,
                  packedTx.ts,
                  packedTx.freigabedatum,
                  packedTx.data
                )
              );
            }
          }
        }

        upserted += 1;
      }

      try {
        if (!dryRun && stmts.length) await runBatched(env, stmts);
        return respond({ ok: true, dryRun, rows: rows.length, upserted });
      } catch (err) {
        return respond({ error: 'Bulk upsert failed', details: err?.message || String(err) }, 500);
      }
    });

    // 8) Archive (D1: bewusst ein No-Op – bleibt für Admin-UI kompatibel)
    router.post(path('/entries/archive'), async ({ env, request, respond }) => {
      if (!env.DB) return respond({ error: 'DB binding missing' }, 500);

      const body = await readBodyJson(request);
      const year = Number(body?.year) || new Date().getFullYear();

      // In D1-Mode wird nicht in eine entries.json "archiviert".
      return respond({ ok: true, year, archived: 0, message: 'D1 mode: archive is a no-op.' });
    });

    // 9) Merge (move transactions from fromId -> toId, then delete fromId)
    router.post(path('/entries/merge'), async ({ env, request, respond }) => {
      if (!env.DB) return respond({ error: 'DB binding missing' }, 500);

      const body = await readBodyJson(request);
      const fromId = body?.fromId?.toString();
      const toId = body?.toId?.toString();

      if (!fromId || !toId) return respond({ error: 'fromId/toId required' }, 400);
      if (fromId === toId) return respond({ error: 'fromId must differ from toId' }, 400);

      try {
        await env.DB.batch([
          env.DB.prepare('UPDATE transactions SET project_id = ? WHERE project_id = ?').bind(toId, fromId),
          env.DB.prepare('DELETE FROM projects WHERE id = ?').bind(fromId),
        ]);
        return respond({ ok: true, fromId, toId });
      } catch (err) {
        return respond({ error: 'Merge failed', details: err?.message || String(err) }, 500);
      }
    });
  }

  // Main routes
  mount('');
  // Legacy alias
  mount('/api');
}