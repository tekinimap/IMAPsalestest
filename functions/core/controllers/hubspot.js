export function registerHubspotRoutes(
  router,
  {
    verifyHubSpotSignatureV3,
    hsFetchDeal,
    hsFetchCompany,
    hsFetchOwner,
    collectHubspotSyncPayload,
    upsertByHubSpotId,
    ghGetFile,
    ghPutFile,
    canonicalizeEntries,
    logJSONL,
  },
) {
  router.post('/hubspot', async ({ request, env, respond, ghPath, branch }) => {
    const raw = await request.text();
    const okSig = await verifyHubSpotSignatureV3(request, env, raw).catch(() => false);
    if (!okSig) return respond({ error: 'invalid signature' }, 401);

    let events = [];
    try {
      events = JSON.parse(raw);
    } catch {
      return respond({ error: 'bad payload' }, 400);
    }
    if (!Array.isArray(events) || events.length === 0) return respond({ ok: true, processed: 0 });

    const wonIds = new Set(String(env.HUBSPOT_CLOSED_WON_STAGE_IDS || '').split(',').map((s) => s.trim()).filter(Boolean));
    if (wonIds.size === 0) return respond({ ok: true, processed: 0, warning: 'No WON stage IDs.' });

    let ghData = await ghGetFile(env, ghPath, branch);
    let itemsChanged = false;
    let lastDeal = null;
    const hubspotLogs = [];

    for (const ev of events) {
      if (ev.subscriptionType === 'object.propertyChange' && ev.propertyName === 'dealstage') {
        const newStage = String(ev.propertyValue || '');
        const dealId = ev.objectId;

        if (!wonIds.has(newStage)) continue;

        try {
          console.log(`VERARBEITE \"WON\" DEAL: ${dealId}`);

          const deal = await hsFetchDeal(dealId, env);

          let companyName = '';
          const companyAssoc = deal?.associations?.companies?.results?.[0];
          if (companyAssoc && companyAssoc.id) {
            companyName = await hsFetchCompany(companyAssoc.id, env);
            deal.properties.fetched_company_name = companyName;
          }

          const ownerId = deal?.properties?.hubspot_owner_id;
          let ownerName = '';
          if (ownerId) {
            ownerName = await hsFetchOwner(ownerId, env);
            deal.properties.fetched_owner_name = ownerName;
          }

          const collaboratorIds = (deal?.properties?.hs_all_collaborator_owner_ids || '')
            .split(';')
            .filter(Boolean);

          const collaboratorPromises = collaboratorIds.map((id) => hsFetchOwner(id, env));
          const collaboratorNames = (await Promise.all(collaboratorPromises)).filter(Boolean);
          deal.properties.fetched_collaborator_names = collaboratorNames;

          lastDeal = deal;
          const upsertResult = upsertByHubSpotId(ghData.items, deal);
          if (upsertResult?.action === 'create' || upsertResult?.action === 'update') {
            ghData.items = canonicalizeEntries(ghData.items);
            itemsChanged = true;
          } else if (upsertResult?.action === 'skip' && upsertResult?.reason === 'duplicate_project_kv') {
            hubspotLogs.push({
              event: 'skip',
              source: 'hubspot',
              reason: upsertResult.reason,
              message: 'Deal aus Hubspot wurde abgeblockt, weil Eintrag mit Projektnummer und KV-Nummer bereits vorhanden ist.',
              hubspotId: upsertResult.hubspotId || String(dealId),
              dealId: String(dealId),
              projectNumber: upsertResult.projectNumber,
              kvList: upsertResult.kvList,
              kv: upsertResult.kvList?.[0] || '',
              existingEntryId: upsertResult.conflictingEntryId,
            });
          }
        } catch (hsErr) {
          console.error(`HubSpot API-Fehler (hsFetchDeal/hsFetchCompany/hsFetchOwner) bei Deal ${dealId}:`, hsErr);
        }
      }
    }

    if (hubspotLogs.length) {
      await logJSONL(env, hubspotLogs);
    }
    if (itemsChanged) {
      try {
        await ghPutFile(env, ghPath, canonicalizeEntries(ghData.items), ghData.sha, 'hubspot webhook upsert', branch);
        console.log(`Änderungen für ${events.length} Events erfolgreich auf GitHub gespeichert.`);
      } catch (e) {
        console.error('GitHub PUT (ghPutFile) FEHLER:', e);
      }
    }
    return respond({ ok: true, changed: itemsChanged, lastDeal });
  });
}
