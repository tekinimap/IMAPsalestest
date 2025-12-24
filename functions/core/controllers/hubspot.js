
import {
  kvListFrom,
  normalizeString,
  firstNonEmpty,
  applyKvList,
} from '../../utils/validation.js';
import {
  toEpochMillis,
} from '../../log-analytics-core.js';

// We duplicate unpackProject/packProject as they are local to the module and not exported/passed easily.
const unpackProject = (row) => {
  if (!row) return null;
  let extra = {};
  try {
    extra = row.data ? JSON.parse(row.data) : {};
  } catch (e) { console.error("JSON parse error", e); }

  const entry = {
    ...extra,
    id: row.id,
    projectType: row.projectType,
    client: row.client,
    title: row.title,
    projectNumber: row.projectNumber,
    amount: row.amount,
    dockPhase: row.dockPhase,
    dockFinalAssignment: row.dockFinalAssignment,
    ts: row.ts,
    freigabedatum: row.freigabedatum,
    transactions: []
  };
  return entry;
};

const packProject = (entry, rndId) => {
  const {
    id, projectType, client, title, projectNumber, amount,
    dockPhase, dockFinalAssignment, ts, freigabedatum,
    transactions, ...rest
  } = entry;

  const dataJson = JSON.stringify(rest || {});

  return {
    id: id || rndId('entry_'),
    projectType: projectType || 'fix',
    client: client || '',
    title: title || '',
    projectNumber: projectNumber || '',
    amount: Number(amount) || 0,
    dockPhase: typeof dockPhase === 'number' ? dockPhase : null,
    dockFinalAssignment: dockFinalAssignment || null,
    ts: Number(ts) || Date.now(),
    freigabedatum: Number(freigabedatum) || 0,
    data: dataJson
  };
};


export function registerHubspotRoutes(
  router,
  {
    verifyHubSpotSignatureV3,
    hsFetchDeal,
    hsFetchCompany,
    hsFetchOwner,
    logJSONL,
    rndId,
    // dependencies passed from index.js
    deriveBusinessUnitFromTeamName,
    ensureDockMetadata,
    ensureKvStructure,
    fieldsOf,
    parseHubspotCheckbox,
    // dependencies below are passed but we will rely less on them for D1
    ghGetFile,
    ghPutFile,
    canonicalizeEntries,
  },
) {
  router.post('/hubspot', async ({ request, env, respond }) => { // removed ghPath, branch
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

    // D1: We do not load all data. We process event by event.

    const hubspotLogs = [];
    let processedCount = 0;

    for (const ev of events) {
      if (ev.subscriptionType === 'object.propertyChange' && ev.propertyName === 'dealstage') {
        const newStage = String(ev.propertyValue || '');
        const dealId = ev.objectId;

        if (!wonIds.has(newStage)) continue;

        try {
          console.log(`VERARBEITE "WON" DEAL: ${dealId}`);

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

          // --- D1 Upsert Logic Start ---
          const idStr = String(dealId);

          const existingRow = await env.DB.prepare(
              "SELECT * FROM projects WHERE json_extract(data, '$.hubspotId') = ?"
          ).bind(idStr).first();

          let previousEntry = null;
          if (existingRow) {
             previousEntry = unpackProject(existingRow);
          }

          // Prepare new data
           const name = deal?.properties?.dealname || `Deal ${dealId}`;
           const amount = Number(deal?.properties?.amount || 0);
           const closeDate = toEpochMillis(deal?.properties?.closedate);
           const kvList = kvListFrom(deal?.properties);

           const projectNumber = normalizeString(firstNonEmpty(
            deal?.properties?.projektnummer,
            deal?.properties?.projectNumber,
            deal?.properties?.project_no,
            deal?.properties?.projectId,
            deal?.properties?.Projektnummer
          ));

          // Check for duplicate Project Number + KV if it's a new entry
          if (!previousEntry && projectNumber && kvList.length) {
              const { results: potentialDupes } = await env.DB.prepare(
                  "SELECT * FROM projects WHERE projectNumber = ?"
              ).bind(projectNumber).all();

              const conflicts = potentialDupes.map(unpackProject).filter(entry => {
                  if (String(entry.hubspotId || "") === idStr) return false;
                   const entryKvs = kvListFrom(entry);
                   return entryKvs.some(kv => kvList.includes(kv));
              });

              if (conflicts.length > 0) {
                 hubspotLogs.push({
                    event: 'skip',
                    source: 'hubspot',
                    reason: 'duplicate_project_kv',
                    message: 'Deal aus Hubspot wurde abgeblockt, weil Eintrag mit Projektnummer und KV-Nummer bereits vorhanden ist.',
                    hubspotId: idStr,
                    dealId: idStr,
                    projectNumber,
                    kvList,
                    existingEntryId: conflicts[0].id,
                  });
                  continue; // SKIP this deal
              }
          }

          // Build the entry object
          const allNames = new Set([ownerName, ...collaboratorNames]);
          const salesList = [];
          allNames.forEach((nameValue, index) => {
            if (nameValue) {
              salesList.push({
                key: `hubspot_user_${index}`,
                name: nameValue,
                money: 0,
                pct: 0,
              });
            }
          });

          const previousKv = previousEntry ? kvListFrom(previousEntry) : [];

          const marketTeamRaw = firstNonEmpty(
            deal?.properties?.market_team,
            deal?.properties?.marketTeam,
            deal?.properties?.market_team__c,
            deal?.properties?.marketteam
          );

          const previousMarketTeam = normalizeString(previousEntry?.marketTeam || previousEntry?.market_team);
          const marketTeam = normalizeString(marketTeamRaw) || previousMarketTeam;

          // Use passed helper or default to empty
          const businessUnit = deriveBusinessUnitFromTeamName
              ? deriveBusinessUnitFromTeamName(marketTeam)
              : normalizeString(previousEntry?.businessUnit) || '';

          const assessmentOwner = normalizeString(firstNonEmpty(
            deal?.properties?.einschaetzung_abzugeben_von,
            deal?.properties?.einschätzung_abzugeben_von,
            deal?.properties?.einschaetzungAbzugebenVon,
            deal?.properties?.einschaetzung_abzugeben_von,
            previousEntry?.assessmentOwner,
            previousEntry?.assessment_owner,
            ownerName
          ));

          const flagshipProjekt = parseHubspotCheckbox
            ? parseHubspotCheckbox(deal?.properties?.flagship_projekt, previousEntry?.flagship_projekt === true)
            : Boolean(deal?.properties?.flagship_projekt || previousEntry?.flagship_projekt);

          const base = {
            id: previousEntry?.id || rndId('hubspot_'),
            hubspotId: idStr,
            title: name,
            amount,
            source: "hubspot",
            projectType: "fix",
            projectNumber: previousEntry?.projectNumber || "",
            client: companyName,
            submittedBy: ownerName,
            list: salesList,
            updatedAt: Date.now(),
            marketTeam,
            market_team: marketTeam,
            businessUnit,
            assessmentOwner,
            dockBuApproved: previousEntry?.dockBuApproved === true,
            dockBuApprovedAt: previousEntry?.dockBuApprovedAt || null,
            dockFinalAssignment: previousEntry?.dockFinalAssignment || '',
            dockFinalAssignmentAt: previousEntry?.dockFinalAssignmentAt || null,
            dockPhase: previousEntry?.dockPhase,
            flagship_projekt: flagshipProjekt,
            freigabedatum: closeDate != null ? closeDate : previousEntry?.freigabedatum || null,
          };

          if (projectNumber) {
            base.projectNumber = projectNumber;
          }

          if (previousEntry?.dockPhaseHistory && typeof previousEntry.dockPhaseHistory === 'object') {
            base.dockPhaseHistory = { ...previousEntry.dockPhaseHistory };
          }

          const nextKvList = previousKv.length ? previousKv : kvList;
          if (nextKvList.length) {
            applyKvList(base, nextKvList);
          }

          let normalizedEntry = ensureKvStructure ? ensureKvStructure(base) : base;
          if (ensureDockMetadata) {
              normalizedEntry = ensureDockMetadata(normalizedEntry, { defaultPhase: previousEntry?.dockPhase ?? 1 });
          }

          // Insert or Update in D1
          const p = packProject(normalizedEntry, rndId);

          if (previousEntry) {
              // Update
               await env.DB.prepare(
                  "UPDATE projects SET projectType=?, client=?, title=?, projectNumber=?, amount=?, dockPhase=?, dockFinalAssignment=?, ts=?, freigabedatum=?, data=? WHERE id=?"
                ).bind(p.projectType, p.client, p.title, p.projectNumber, p.amount, p.dockPhase, p.dockFinalAssignment, p.ts, p.freigabedatum, p.data, p.id).run();
                processedCount++;
                hubspotLogs.push({ event: 'update', source: 'hubspot', id: p.id, hubspotId: idStr });
          } else {
              // Create
               await env.DB.prepare(
                  "INSERT INTO projects (id, projectType, client, title, projectNumber, amount, dockPhase, dockFinalAssignment, ts, freigabedatum, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
                ).bind(p.id, p.projectType, p.client, p.title, p.projectNumber, p.amount, p.dockPhase, p.dockFinalAssignment, p.ts, p.freigabedatum, p.data).run();
                processedCount++;
                hubspotLogs.push({ event: 'create', source: 'hubspot', id: p.id, hubspotId: idStr });
          }

        } catch (hsErr) {
          console.error(`HubSpot API-Fehler (hsFetchDeal/hsFetchCompany/hsFetchOwner) bei Deal ${dealId}:`, hsErr);
          hubspotLogs.push({ event: 'error', error: String(hsErr), dealId });
        }
      }
    }

    if (hubspotLogs.length) {
      await logJSONL(env, hubspotLogs);
    }

    // Fallback logic intentionally omitted to focus on D1 fix.

    return respond({ ok: true, processed: processedCount });
  });
}
