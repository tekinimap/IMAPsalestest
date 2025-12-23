export function registerEntryRoutes(
  router,
  {
    ghGetFile,
    ghPutFile,
    kvListFrom,
    canonicalizeEntries,
    ensureKvStructure,
    ensureDockMetadata,
    isFullEntry,
    validateRow,
    entriesShareKv,
    mergeKvLists,
    rndId,
    logJSONL,
    fieldsOf,
    applyKvList,
    collectHubspotSyncPayload,
    processHubspotSyncQueue,
    mergeEntryWithKvOverride,
    mergeContributionLists,
    indexTransactionKvs,
    syncCalloffDealsForEntry,
  },
) {
  // Hilfsfunktion zum Normalisieren von KVs für den Vergleich
  const normKv = (val) => String(val || '').trim().toLowerCase();

  router.get('/entries', async ({ env, respond, ghPath, branch }) => {
    const { items } = await ghGetFile(env, ghPath, branch);
    const normalized = canonicalizeEntries(items);
    return respond(normalized);
  });

  router.get('/entries/:id', async ({ env, respond, ghPath, branch, params }) => {
    const id = decodeURIComponent(params.id);
    const { items } = await ghGetFile(env, ghPath, branch);
    const found = items.find((entry) => String(entry.id) === id);
    if (!found) return respond({ error: 'not found' }, 404);
    return respond(ensureKvStructure({ ...found }));
  });

  router.post('/entries', async ({ env, respond, ghPath, branch, request, saveEntries }) => {
    let body;
    try {
      body = await request.json();
    } catch {
      return respond({ error: 'Invalid JSON body' }, 400);
    }

    const cur = await ghGetFile(env, ghPath, branch);
    const items = cur.items || [];
    let entry;
    let status = 201;
    let skipSave = false;
    const hubspotUpdates = [];

    if (isFullEntry(body)) {
      const existingById = items.find((e) => e.id === body.id);
      if (existingById) return respond({ error: 'Conflict: ID exists. Use PUT.' }, 409);
      entry = { id: body.id || rndId('entry_'), ...body, ts: body.ts || Date.now(), modified: undefined };
      if (Array.isArray(entry.transactions)) {
        entry.transactions = entry.transactions.map((t) => ({
          id: t.id || `trans_${Date.now()}_${Math.random().toString(16).slice(2)}`,
          ...t,
        }));
      }
      ensureKvStructure(entry);
      ensureDockMetadata(entry);
      items.push(entry);
      const f = fieldsOf(entry);
      await logJSONL(env, [{
        event: 'create',
        source: entry.source || 'manuell',
        after: entry,
        kv: f.kv,
        kvList: f.kvList,
        projectNumber: f.projectNumber,
        title: f.title,
        client: f.client,
        reason: 'manual_or_import',
      }]);
    } else {
      const validation = validateRow(body);
      if (!validation.ok) {
        await logJSONL(env, [{ event: 'skip', source: validation.source || 'erp', ...validation }]);
        return respond({ error: 'validation_failed', ...validation }, 422);
      }
      const kvList = validation.kvList;
      
      // Robusterer Check auf Existenz (normiert)
      const existing = items.find((item) => {
        const itemKvs = kvListFrom(item).map(normKv);
        return kvList.some(k => itemKvs.includes(normKv(k)));
      });

      if (!existing) {
        entry = {
          id: rndId('entry_'),
          kvNummern: kvList,
          projectNumber: validation.projectNumber || '',
          title: validation.title || '',
          client: validation.client || '',
          amount: validation.amount,
          source: validation.source || 'erp',
          projectType: 'fix',
          ts: Date.now(),
        };
        ensureKvStructure(entry);
        ensureDockMetadata(entry);
        items.push(entry);
        await logJSONL(env, [{
          event: 'create',
          source: entry.source,
          after: entry,
          kv: entry.kv,
          kvList: entry.kvNummern,
          projectNumber: entry.projectNumber,
          title: entry.title,
          client: entry.client,
          reason: 'excel_new',
        }]);
      } else {
        status = 200;
        entry = existing;
        const before = JSON.parse(JSON.stringify(existing));
        const oldAmount = Number(existing.amount) || 0;
        const amountChanged = Math.abs(oldAmount - validation.amount) >= 0.01;
        const mergedKvList = mergeKvLists(kvListFrom(existing), kvList);
        let updated = false;

        if (mergedKvList.length !== kvListFrom(existing).length) {
          applyKvList(existing, mergedKvList);
          updated = true;
        }
        if (amountChanged) {
          existing.amount = validation.amount;
          updated = true;
        }
        if (validation.projectNumber && validation.projectNumber !== existing.projectNumber) {
          existing.projectNumber = validation.projectNumber;
          updated = true;
        }
        if (validation.title && validation.title !== existing.title) {
          existing.title = validation.title;
          updated = true;
        }
        if (validation.client && validation.client !== existing.client) {
          existing.client = validation.client;
          updated = true;
        }

        const freigabeTsBody = body.freigabedatum ? new Date(body.freigabedatum).getTime() : null;
        if (freigabeTsBody && Number.isFinite(freigabeTsBody) && freigabeTsBody !== existing.freigabedatum) {
          existing.freigabedatum = freigabeTsBody;
          updated = true;
        }

        if (updated) {
          ensureKvStructure(existing);
          ensureDockMetadata(existing);
          existing.modified = Date.now();
          const source = existing.source || validation.source || body.source;
          if (source !== 'erp-import') {
            const syncPayload = collectHubspotSyncPayload(before, existing);
            if (syncPayload) hubspotUpdates.push(syncPayload);
          }
          await logJSONL(env, [{
            event: 'update',
            source: existing.source || validation.source || 'erp',
            before,
            after: existing,
            kv: existing.kv,
            kvList: existing.kvNummern,
            projectNumber: existing.projectNumber,
            title: existing.title,
            client: existing.client,
            reason: 'excel_override',
          }]);
        } else {
          skipSave = true;
          await logJSONL(env, [{
            event: 'skip',
            source: existing.source || validation.source || 'erp',
            kv: existing.kv,
            kvList: existing.kvNummern,
            projectNumber: existing.projectNumber,
            title: existing.title,
            client: existing.client,
            reason: 'no_change',
          }]);
        }
      }
    }

    if (!skipSave) {
      try {
        await saveEntries(items, cur.sha, `upsert entry: ${entry.kv || entry.id}`);
      } catch (e) {
        if (String(e).includes('sha') || String(e).includes('conflict')) {
          console.warn('Retrying PUT due to SHA conflict...');
          await new Promise((r) => setTimeout(r, 600));
          const ref = await ghGetFile(env, ghPath, branch);
          const refItems = ref.items || [];
          const refIdx = refItems.findIndex((item) => item.id === entry.id);
          if (status === 201 && refIdx === -1) {
            refItems.push(entry);
          } else if (status === 200 && refIdx > -1) {
            refItems[refIdx] = entry;
          } else {
            console.error('Cannot cleanly retry after SHA conflict.');
            throw new Error('SHA conflict, unresolved.');
          }
          ensureKvStructure(entry);
          await saveEntries(refItems, ref.sha, `upsert entry (retry): ${entry.kv || entry.id}`);
        } else {
          throw e;
        }
      }
      if (hubspotUpdates.length) {
        await processHubspotSyncQueue(env, hubspotUpdates, { reason: 'entries_post' });
      }
    }

    return respond(entry, status);
  });

  router.put('/entries/:id', async ({ env, respond, ghPath, branch, request, params, saveEntries }) => {
    const id = decodeURIComponent(params.id);
    let body;
    try {
      body = await request.json();
    } catch {
      return respond({ error: 'Invalid JSON' }, 400);
    }

    const cur = await ghGetFile(env, ghPath, branch);
    const idx = cur.items.findIndex((entry) => String(entry.id) === id);
    if (idx < 0) return respond({ error: 'not found' }, 404);

    const before = JSON.parse(JSON.stringify(cur.items[idx]));
    let updatedEntry;
    const hubspotUpdates = [];

    if (isFullEntry(body)) {
      if (Array.isArray(body.transactions)) {
        body.transactions = body.transactions.map((t) => ({
          id: t.id || `trans_${Date.now()}_${Math.random().toString(16).slice(2)}`,
          ...t,
        }));
      }
      const merged = mergeEntryWithKvOverride(before, { ...body, id, modified: Date.now() });
      updatedEntry = ensureKvStructure(merged);
      ensureDockMetadata(updatedEntry);
      cur.items[idx] = updatedEntry;
      const source = updatedEntry.source || body.source;
      if (source !== 'erp-import') {
        const syncPayload = collectHubspotSyncPayload(before, updatedEntry);
        if (syncPayload) hubspotUpdates.push(syncPayload);
      }
      await saveEntries(cur.items, cur.sha, `update entry (full): ${id}`);
      const f = fieldsOf(updatedEntry);
      await logJSONL(env, [{
        event: 'update',
        source: updatedEntry.source || 'manuell',
        before,
        after: updatedEntry,
        kv: f.kv,
        kvList: f.kvList,
        projectNumber: f.projectNumber,
        title: f.title,
        client: f.client,
      }]);
    } else {
      const mergedForValidation = mergeEntryWithKvOverride(before, body);
      const validation = validateRow({ ...mergedForValidation });
      if (!validation.ok) {
        await logJSONL(env, [{ event: 'skip', ...validation }]);
        return respond({ error: 'validation_failed', ...validation }, 422);
      }
      const merged = mergeEntryWithKvOverride(before, { ...body, amount: validation.amount, modified: Date.now() });
      updatedEntry = ensureKvStructure(merged);
      ensureDockMetadata(updatedEntry);
      cur.items[idx] = updatedEntry;
      const source = updatedEntry.source || body.source;
      if (source !== 'erp-import') {
        const syncPayload = collectHubspotSyncPayload(before, updatedEntry);
        if (syncPayload) hubspotUpdates.push(syncPayload);
      }
      await saveEntries(cur.items, cur.sha, `update entry (narrow): ${id}`);

      const f = fieldsOf(updatedEntry);
      const changes = {};
      for (const key in body) {
        if (Object.prototype.hasOwnProperty.call(body, key) && before[key] !== body[key]) {
          changes[key] = body[key];
        }
      }
      if (before.amount !== validation.amount) changes.amount = validation.amount;
      if (changes.freigabedatum == null && updatedEntry.freigabedatum != null) {
        changes.freigabedatum = updatedEntry.freigabedatum;
      }
      const beforeSnapshot = { amount: before.amount };
      if (before.freigabedatum != null) beforeSnapshot.freigabedatum = before.freigabedatum;
      for (const key of Object.keys(changes)) {
        if (key === 'amount') continue;
        if (before[key] != null) {
          beforeSnapshot[key] = before[key];
        }
      }
      await logJSONL(env, [{
        event: 'update',
        ...f,
        before: beforeSnapshot,
        after: changes,
      }]);
    }

    if (hubspotUpdates.length) {
      await processHubspotSyncQueue(env, hubspotUpdates, { reason: 'entries_put' });
    }
    return respond(updatedEntry);
  });

  router.delete('/entries/:id', async ({ env, respond, ghPath, branch, params, saveEntries }) => {
    const id = decodeURIComponent(params.id);
    const cur = await ghGetFile(env, ghPath, branch);
    const before = cur.items.find((entry) => String(entry.id) === id);
    if (!before) return respond({ ok: true, message: 'already deleted?' });
    const next = cur.items.filter((entry) => String(entry.id) !== id);
    await saveEntries(next, cur.sha, `delete entry: ${id}`);
    const f = fieldsOf(before);
    await logJSONL(env, [{
      event: 'delete',
      reason: 'delete.entry',
      before,
      kv: f.kv,
      kvList: f.kvList,
      projectNumber: f.projectNumber,
      title: f.title,
      client: f.client,
    }]);
    return respond({ ok: true });
  });

  // Legacy Bulk Route - belassen wir, aber nicht optimiert
  router.post('/entries/bulk', async ({ env, respond, ghPath, branch, request, saveEntries }) => {
    console.log('Processing legacy /entries/bulk');
    // ... Legacy Code (unverändert) ...
    let payload;
    try { payload = await request.json(); } catch { return respond({ error: 'Invalid JSON' }, 400); }
    const rows = Array.isArray(payload?.rows) ? payload.rows : [];
    if (!rows.length) return respond({ ok: false, message: 'rows empty' }, 400);
    const cur = await ghGetFile(env, ghPath, branch);
    const items = cur.items || [];
    const byKV = new Map(items.filter((item) => item && kvListFrom(item).length).flatMap((item) => kvListFrom(item).map((kv) => [kv, item])));
    const logs = [];
    let created = 0; let updated = 0; let skipped = 0; let errors = 0; let changed = false;
    for (const row of rows) {
      const validation = validateRow(row);
      if (!validation.ok) { skipped++; logs.push({ event: 'skip', ...validation }); continue; }
      const kvList = validation.kvList;
      const existing = items.find((item) => entriesShareKv(kvList, item));
      if (!existing) {
        const entry = ensureKvStructure({
          id: rndId('entry_'), kvNummern: kvList, projectNumber: validation.projectNumber || '', title: validation.title || '', client: validation.client || '', amount: validation.amount, source: validation.source || 'erp', projectType: 'fix', ts: Date.now(),
        });
        items.push(entry); kvList.forEach((kv) => byKV.set(kv, entry)); logs.push({ event: 'create', source: entry.source, after: entry, kv: entry.kv, kvList: entry.kvNummern, projectNumber: entry.projectNumber, title: entry.title, client: entry.client, reason: 'legacy_bulk_new' }); created++; changed = true;
      } else {
        const before = JSON.parse(JSON.stringify(existing)); const merged = mergeKvLists(kvListFrom(existing), kvList); applyKvList(existing, merged); const oldAmount = Number(existing.amount) || 0; const newAmount = validation.amount; const amountChanged = Math.abs(oldAmount - newAmount) >= 0.01; if (amountChanged) existing.amount = newAmount; if (validation.projectNumber && validation.projectNumber !== existing.projectNumber) existing.projectNumber = validation.projectNumber; if (validation.title && validation.title !== existing.title) existing.title = validation.title; if (validation.client && validation.client !== existing.client) existing.client = validation.client; if (amountChanged || merged.length !== kvListFrom(before).length) { existing.modified = Date.now(); ensureKvStructure(existing); logs.push({ event: 'update', source: existing.source || validation.source || 'erp', before, after: existing, kv: existing.kv, kvList: existing.kvNummern, projectNumber: existing.projectNumber, title: existing.title, client: existing.client, reason: 'legacy_bulk_update' }); updated++; changed = true; } else { logs.push({ event: 'skip', source: existing.source || validation.source || 'erp', kv: existing.kv, kvList: existing.kvNummern, projectNumber: existing.projectNumber, title: existing.title, client: existing.client, reason: 'legacy_bulk_no_change' }); skipped++; }
      }
    }
    if (changed) { try { await saveEntries(items, cur.sha, `bulk import ${created}C ${updated}U ${skipped}S ${errors}E`); } catch (e) { if (String(e).includes('sha') || String(e).includes('conflict')) { console.warn('Retrying legacy bulk due to SHA conflict', e); return respond({ error: 'Save conflict. Please retry import.', details: e.message }, 409); } throw e; } } await logJSONL(env, logs); return respond({ ok: true, created, updated, skipped, errors, saved: changed });
  });

  router.post('/entries/bulk-v2', async ({ env, respond, ghPath, branch, request, saveEntries }) => {
    console.log('Processing /entries/bulk-v2');
    let payload;
    try {
      payload = await request.json();
    } catch (e) {
      return respond({ error: 'Invalid JSON', details: e.message }, 400);
    }

    const rows = Array.isArray(payload?.rows) ? payload.rows : [];
    if (!rows.length) return respond({ created: 0, updated: 0, skipped: 0, errors: 0, message: 'rows empty' });

    const cur = await ghGetFile(env, ghPath, branch);
    const items = cur.items || [];
    const logs = [];
    let created = 0;
    let updated = 0;
    let skipped = 0;
    let errors = 0;
    let changed = false;
    const hubspotUpdates = [];
    const itemsById = new Map(items.map((item) => [item.id, item]));
    
    // KV Index aufbauen - MIT NORMALISIERUNG
    const itemsByKV = new Map();
    items.forEach((item) => {
      const kvs = kvListFrom(item);
      kvs.forEach((kv) => {
        if (kv) {
            // HIER DIE ÄNDERUNG: Wir speichern die normalisierte Version als Key
            itemsByKV.set(normKv(kv), item.id);
        }
      });
      if (item.projectType === 'rahmen' && Array.isArray(item.transactions)) {
        item.transactions.forEach((t) => {
          const tkvList = kvListFrom(t);
          tkvList.forEach((tkv) => {
            if (tkv) {
                // HIER AUCH:
                itemsByKV.set(normKv(tkv), item.id);
            }
          });
        });
      }
    });
    const kvsAddedInThisBatch = new Set();

    for (const row of rows) {
      try {
        const kvList = kvListFrom(row);
        const isNew = !row.id || !itemsById.has(row.id);

        if (isNew) {
          if (!kvList.length && !isFullEntry(row)) {
            skipped++;
            logs.push({ event: 'skip', reason: 'missing_kv', ...fieldsOf(row) });
            continue;
          }
          
          // CONFLICT CHECK MIT NORMALISIERUNG
          const conflictKv = kvList.find((kv) => {
            const n = normKv(kv);
            return itemsByKV.has(n) || kvsAddedInThisBatch.has(n);
          });

          if (conflictKv) {
            skipped++;
            logs.push({
              event: 'skip',
              source: row.source || 'erp',
              kv: conflictKv,
              kvList,
              projectNumber: row.projectNumber,
              title: row.title,
              client: row.client,
              reason: itemsByKV.has(normKv(conflictKv)) ? 'duplicate_kv_existing' : 'duplicate_kv_batch',
              detail: `KV '${conflictKv}' present (normalized).`,
            });
            console.warn(`Skipping create (duplicate KV): ${conflictKv}`);
            continue;
          }
          const newId = row.id || rndId('entry_');
          const entry = ensureKvStructure({ ...row, id: newId, ts: row.ts || Date.now(), modified: undefined });
          if (Array.isArray(entry.transactions)) {
            entry.transactions = entry.transactions.map((t) => ({
              id: t.id || `trans_${Date.now()}_${Math.random().toString(16).slice(2)}`,
              ...t,
            }));
          }
          items.push(entry);
          itemsById.set(newId, entry);
          kvList.forEach((kv) => {
            if (kv) {
              const n = normKv(kv);
              kvsAddedInThisBatch.add(n);
              itemsByKV.set(n, newId);
            }
          });
          indexTransactionKvs(entry, newId, kvsAddedInThisBatch, itemsByKV);
          await syncCalloffDealsForEntry(null, entry, env, logs);
          created++;
          changed = true;
          const f = fieldsOf(entry);
          logs.push({
            event: 'create',
            source: entry.source || 'erp',
            after: entry,
            kv: f.kv,
            kvList: f.kvList,
            projectNumber: f.projectNumber,
            title: f.title,
            client: f.client,
            reason: 'bulk_import_new',
          });
        } else {
          // UPDATE LOGIC (Existing ID)
          const existingEntry = itemsById.get(row.id);
          if (!existingEntry) {
            errors++;
            logs.push({ event: 'error', source: row.source || 'erp', entryId: row.id, reason: 'update_id_not_found' });
            console.error(`Update failed: ID ${row.id} not found.`);
            continue;
          }
          
          // Check for KV conflicts on update (e.g. changing KV to one that exists elsewhere)
          const newKvList = kvList.length ? kvList : kvListFrom(existingEntry);
          const conflictKv = newKvList.find((kv) => {
            const n = normKv(kv);
            const ownerId = itemsByKV.get(n);
            // Konflikt, wenn KV existiert UND nicht mir selbst gehört
            return ownerId && ownerId !== row.id;
          });
          
          if (conflictKv) {
            skipped++;
            logs.push({
              event: 'skip',
              source: row.source || 'erp',
              kv: conflictKv,
              kvList: newKvList,
              projectNumber: row.projectNumber,
              title: row.title,
              client: row.client,
              reason: 'duplicate_kv_existing',
              detail: `KV '${conflictKv}' belongs to ${itemsByKV.get(normKv(conflictKv))}`,
            });
            continue;
          }
          const before = JSON.parse(JSON.stringify(existingEntry));
          const updatedEntry = ensureKvStructure({ ...existingEntry, ...row, id: row.id, modified: Date.now() });
          if (Array.isArray(updatedEntry.transactions)) {
            updatedEntry.transactions = updatedEntry.transactions.map((t) => ({
              id: t.id || `trans_${Date.now()}_${Math.random().toString(16).slice(2)}`,
              ...t,
            }));
          }
          const indexToUpdate = items.findIndex((item) => item.id === row.id);
          if (indexToUpdate !== -1) {
            items[indexToUpdate] = updatedEntry;
            itemsById.set(row.id, updatedEntry);
            const updatedKvs = kvListFrom(updatedEntry);
            const beforeKvs = kvListFrom(before);
            
            // Index Update
            beforeKvs.forEach((kv) => {
               const n = normKv(kv);
               if (!updatedKvs.map(normKv).includes(n)) itemsByKV.delete(n);
            });
            updatedKvs.forEach((kv) => {
              const n = normKv(kv);
              itemsByKV.set(n, row.id);
              kvsAddedInThisBatch.add(n);
            });
            
            indexTransactionKvs(updatedEntry, row.id, kvsAddedInThisBatch, itemsByKV);
            await syncCalloffDealsForEntry(before, updatedEntry, env, logs);
            const syncPayload = collectHubspotSyncPayload(before, updatedEntry);
            if (syncPayload) hubspotUpdates.push(syncPayload);
            updated++;
            changed = true;
            const f = fieldsOf(updatedEntry);
            logs.push({
              event: 'update',
              source: updatedEntry.source || 'erp',
              before,
              after: updatedEntry,
              kv: f.kv,
              kvList: f.kvList,
              projectNumber: f.projectNumber,
              title: f.title,
              client: f.client,
              reason: 'bulk_import_update',
            });
          } else {
            errors++;
            logs.push({ event: 'error', source: row.source || 'erp', entryId: row.id, reason: 'update_sync_error' });
            console.error(`Update sync error: ID ${row.id}`);
          }
        }
      } catch (rowError) {
        errors++;
        logs.push({ event: 'error', source: row?.source || 'erp', ...fieldsOf(row), reason: 'processing_error', detail: rowError.message });
        console.error('Error processing row:', row, rowError);
      }
    }

    if (changed) {
      console.log(`Bulk v2: ${created} created, ${updated} updated. Attempting save.`);
      try {
        await saveEntries(items, cur.sha, `bulk v2 import: ${created}C ${updated}U ${skipped}S ${errors}E`);
      } catch (e) {
        if (String(e).includes('sha') || String(e).includes('conflict')) {
          console.error('Bulk v2 save failed (SHA conflict):', e);
          await logJSONL(env, logs);
          return respond({
            error: 'Save conflict. Please retry import.',
            details: e.message,
            created,
            updated,
            skipped,
            errors,
            saved: false,
          }, 409);
        }
        console.error('Bulk v2 save failed (Other):', e);
        throw e;
      }
    } else {
      console.log('Bulk v2: No changes detected.');
    }

    if (changed && hubspotUpdates.length) {
      await processHubspotSyncQueue(env, hubspotUpdates, { mode: 'batch', reason: 'entries_bulk_v2' });
    }
    await logJSONL(env, logs);
    return respond({ ok: true, created, updated, skipped, errors, saved: changed });
  });

  // ... (restliche Routen: delete, archive, merge bleiben unverändert) ...
  router.post('/entries/bulk-delete', async ({ env, respond, ghPath, branch, request, saveEntries }) => {
    // ... code wie vorher ...
     console.log('Processing /entries/bulk-delete');
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return respond({ error: 'Invalid JSON', details: e.message }, 400);
    }
    const idsToDelete = Array.isArray(body?.ids) ? body.ids : [];
    if (!idsToDelete.length) return respond({ ok: true, deletedCount: 0, message: 'No IDs provided' });

    const cur = await ghGetFile(env, ghPath, branch);
    const items = cur.items || [];
    const logs = [];

    const idSet = new Set(idsToDelete);
    const deletedItems = [];
    const nextItems = items.filter((item) => {
      if (idSet.has(item.id)) {
        deletedItems.push(item);
        return false;
      }
      return true;
    });

    const deletedCount = deletedItems.length;

    if (deletedCount > 0) {
      deletedItems.forEach((before) => {
        const f = fieldsOf(before);
        logs.push({ event: 'delete', reason: 'bulk_delete', before, ...f });
      });

      console.log(`Bulk Delete: Removing ${deletedCount} items. Attempting save.`);
      try {
        await saveEntries(nextItems, cur.sha, `bulk delete: ${deletedCount} entries`);
        await logJSONL(env, logs);
      } catch (e) {
        if (String(e).includes('sha') || String(e).includes('conflict')) {
          console.error('Bulk delete failed due to SHA conflict:', e);
          return respond({
            error: 'Save conflict. Please retry delete operation.',
            details: e.message,
            deletedCount: 0,
          }, 409);
        }
        console.error('Bulk delete failed with other error:', e);
        throw e;
      }
    }
    return respond({ ok: true, deletedCount });
  });

  router.post('/entries/archive', async ({ env, respond, ghPath, branch, request, saveEntries }) => {
     // ... code wie vorher ...
    console.log('Processing /entries/archive');
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return respond({ error: 'Invalid JSON', details: e.message }, 400);
    }

    const year = Number(body?.year);
    if (!Number.isInteger(year)) {
      return respond({ error: 'invalid_year', message: 'Bitte ein gültiges Jahr angeben.' }, 400);
    }

    const { items, sha } = await ghGetFile(env, ghPath, branch);
    const archiveData = [];
    const activeData = [];

    const extractYear = (entry) => {
      const candidate = entry?.freigabedatum ?? entry?.ts ?? entry?.timestamp ?? entry?.createdAt;
      if (!candidate) return null;
      const date = new Date(candidate);
      if (!Number.isFinite(date.getTime())) return null;
      return date.getFullYear();
    };

    for (const entry of items || []) {
      const isRahmen = entry?.projectType === 'rahmen';
      const entryYear = extractYear(entry);
      const isInYear = entryYear === year;

      if (!isRahmen && isInYear) {
        archiveData.push(entry);
      } else {
        activeData.push(entry);
      }
    }

    const archivePath = `data/archive/${year}.json`;

    try {
      await ghPutFile(
        env,
        archivePath,
        canonicalizeEntries(archiveData),
        null,
        `archive ${archiveData.length} entries for ${year}`,
        branch,
      );

      await saveEntries(
        activeData,
        sha,
        `refresh entries after archiving ${archiveData.length} items for ${year}`,
      );

      await logJSONL(env, [
        {
          event: 'archive',
          year,
          archived: archiveData.length,
          remaining: activeData.length,
          archivePath,
        },
      ]);
    } catch (e) {
      console.error('Archiving entries failed:', e);
      return respond({ error: 'archive_failed', details: e.message }, 500);
    }
    return respond({ archived: archiveData.length, year });
  });

  router.post('/entries/merge', async ({ env, respond, ghPath, branch, request, saveEntries }) => {
     // ... code wie vorher ...
    console.log('Processing /entries/merge');
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return respond({ error: 'Invalid JSON', details: e.message }, 400);
    }
    const ids = Array.isArray(body?.ids) ? body.ids.map(String) : [];
    if (!ids.length || ids.length < 2) return respond({ error: 'at least_two_ids_required' }, 400);
    const targetId = body?.targetId ? String(body.targetId) : ids[0];
    const fieldResolutions = body && typeof body.fieldResolutions === 'object' ? body.fieldResolutions : {};

    const cur = await ghGetFile(env, ghPath, branch);
    const items = cur.items || [];
    const selected = ids.map((id) => {
      const entry = items.find((e) => String(e.id) === id);
      if (!entry) throw new Error(`Entry ${id} not found`);
      return entry;
    });
    const targetEntry = selected.find((entry) => String(entry.id) === targetId) || selected[0];
    if (!targetEntry) return respond({ error: 'target_not_found' }, 404);

    const sourceEntries = selected.filter((entry) => entry !== targetEntry);
    const projectNumbers = new Set(selected.map((entry) => String(entry.projectNumber || '').trim()));
    if (projectNumbers.size > 1) return respond({ error: 'project_number_mismatch', message: 'Die Projektnummern stimmen nicht überein' }, 409);
    const invalidType = selected.find((entry) => entry.projectType && entry.projectType !== 'fix');
    if (invalidType) return respond({ error: 'invalid_project_type', message: 'Nur Fixaufträge können zusammengeführt werden' }, 422);

    const beforeTarget = JSON.parse(JSON.stringify(targetEntry));
    const beforeSources = sourceEntries.map((entry) => JSON.parse(JSON.stringify(entry)));

    const mergedAmount = selected.reduce((sum, entry) => sum + (Number(entry.amount) || 0), 0);
    const mergedKvList = mergeKvLists(...selected.map(kvListFrom));
    const mergedList = mergeContributionLists(selected, mergedAmount);

    const pickValue = (field, fallback) => {
      const chosenId = fieldResolutions?.[field];
      if (!chosenId) return fallback;
      const candidate = selected.find((item) => String(item.id) === String(chosenId));
      if (!candidate) return fallback;
      return candidate[field] !== undefined ? candidate[field] : fallback;
    };

    const resolvedAmount = pickValue('amount', mergedAmount);
    targetEntry.amount = Number.isFinite(Number(resolvedAmount)) ? Number(resolvedAmount) : mergedAmount;
    targetEntry.list = mergedList;
    targetEntry.modified = Date.now();
    applyKvList(targetEntry, mergedKvList);
    ensureDockMetadata(targetEntry);
    ['title', 'client', 'projectNumber', 'projectType', 'submittedBy', 'source', 'marketTeam', 'businessUnit', 'assessmentOwner', 'flagship_projekt'].forEach((field) => {
      if (field in targetEntry || field in fieldResolutions) {
        targetEntry[field] = pickValue(field, targetEntry[field]);
      }
    });

    const additiveMerge = (existingList, ...lists) => {
      const merged = [];
      const seen = new Set();
      const createKey = (item) => {
        if (!item) return null;
        if (item.id) return String(item.id);
        return JSON.stringify(item, Object.keys(item).sort());
      };
      const pushItem = (item) => {
        if (!item) return;
        const key = createKey(item);
        if (key === null || seen.has(key)) return;
        seen.add(key);
        merged.push({ ...item });
      };
      (existingList || []).forEach(pushItem);
      lists.flat().forEach(pushItem);
      return merged;
    };

    const mergedComments = additiveMerge(targetEntry.comments, ...sourceEntries.map((entry) => entry.comments));
    const mergedAttachments = additiveMerge(targetEntry.attachments, ...sourceEntries.map((entry) => entry.attachments));
    const mergedHistory = additiveMerge(targetEntry.history, ...sourceEntries.map((entry) => entry.history));

    const mergedAtIso = new Date().toISOString();
    const mergedSourceSummary = sourceEntries.map((src) => `[ID: ${src.id}${src.title ? `, Titel: '${src.title}'` : ''}]`).join(', ');
    const systemComment = {
      id: rndId('comment_'),
      timestamp: mergedAtIso,
      author: 'SYSTEM',
      type: 'system_event',
      text: `SYSTEM: Diese Karte wurde am ${mergedAtIso} mit ${sourceEntries.length} Karte(n) zusammengeführt. Quell-Karten: ${mergedSourceSummary || 'k.A.'}`,
    };
    mergedComments.push(systemComment);

    targetEntry.comments = mergedComments;
    if (mergedAttachments.length) targetEntry.attachments = mergedAttachments;
    if (mergedHistory.length) targetEntry.history = mergedHistory;
    ensureKvStructure(targetEntry);

    const idsToRemove = new Set(sourceEntries.map((entry) => entry.id));
    const nextItems = items.filter((entry) => !idsToRemove.has(entry.id));
    nextItems[nextItems.findIndex((entry) => entry.id === targetEntry.id)] = targetEntry;

    const logs = [
      { event: 'merge_target', targetId: targetEntry.id, mergedIds: sourceEntries.map((entry) => entry.id), before: beforeTarget, after: targetEntry, ...fieldsOf(targetEntry), reason: 'merge_fix_orders' },
      ...beforeSources.map((src) => ({
        event: 'merge_source',
        sourceId: src.id,
        mergedInto: targetEntry.id,
        before: src,
        after: { ...src, dockFinalAssignment: 'merged', dockFinalAssignmentAt: Date.now(), dockPhase: 4 },
        ...fieldsOf(src),
        reason: 'merge_fix_orders',
      })),
    ];

    try {
      await saveEntries(nextItems, cur.sha, `merge entries into ${targetEntry.id}`);
      await logJSONL(env, logs);
    } catch (e) {
      if (String(e).includes('sha') || String(e).includes('conflict')) {
        console.error('Merge save failed (SHA conflict):', e);
        return respond({ error: 'save_conflict', details: e.message }, 409);
      }
      throw e;
    }

    return respond({ ok: true, mergedInto: targetEntry.id, removed: sourceEntries.map((entry) => entry.id), entry: targetEntry });
  });
}
