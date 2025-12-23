import { extractFreigabedatumFromEntry } from '../log-analytics-core.js';
import {
  firstNonEmpty,
  normalizeString,
  normalizeTransactionKv,
  toNumberMaybe,
} from '../utils/validation.js';
import { throttle, sleep } from '../utils/time.js';
import { toEpochMillis } from '../log-analytics-core.js';

export const HUBSPOT_UPDATE_MAX_ATTEMPTS = 5;
export const DEFAULT_HUBSPOT_THROTTLE_MS = 1100;
export const DEFAULT_HUBSPOT_RETRY_BACKOFF_MS = 3000;

function formatHubspotAmount(value) {
  const numeric = toNumberMaybe(value);
  if (numeric == null) return null;
  const rounded = Math.round((numeric + Number.EPSILON) * 100) / 100;
  return rounded.toFixed(2);
}

export async function hsCreateCalloffDeal(transaction, parentEntry, env) {
  const token = normalizeString(env.HUBSPOT_ACCESS_TOKEN);
  if (!token) throw new Error('HUBSPOT_ACCESS_TOKEN missing');

  if (!transaction || typeof transaction !== 'object') {
    throw new Error('transaction missing');
  }

  const kv = normalizeTransactionKv(transaction);
  if (!kv) {
    throw new Error('transaction kv_nummer missing');
  }

  const amountFormatted = formatHubspotAmount(transaction.amount);
  const projectNumber = firstNonEmpty(
    transaction.projectNumber,
    transaction.projektnummer,
    parentEntry?.projectNumber,
    parentEntry?.projektnummer
  );

  const freigabeTs = extractFreigabedatumFromEntry(transaction) ?? extractFreigabedatumFromEntry(parentEntry) ?? Date.now();
  const closedate = Number.isFinite(Number(freigabeTs)) ? Math.trunc(Number(freigabeTs)) : Date.now();

  const parentTitle = firstNonEmpty(
    transaction.title,
    parentEntry?.title,
    parentEntry?.dealname
  );
  const clientName = firstNonEmpty(transaction.client, parentEntry?.client);
  const dealname = firstNonEmpty(
    parentTitle && kv ? `${parentTitle} – ${kv}` : '',
    clientName && kv ? `${clientName} – ${kv}` : '',
    kv
  );

  const dealstage = firstNonEmpty(
    env.HUBSPOT_CALL_OFF_STAGE_ID,
    env.HUBSPOT_CALL_OFF_DEALSTAGE,
    String(env.HUBSPOT_CLOSED_WON_STAGE_IDS || '').split(',').map(part => part.trim())
  );

  const pipeline = firstNonEmpty(
    env.HUBSPOT_CALL_OFF_PIPELINE,
    env.HUBSPOT_PIPELINE_ID,
    env.HUBSPOT_DEFAULT_PIPELINE
  );

  const ownerId = firstNonEmpty(
    transaction.hubspotOwnerId,
    transaction.hubspot_owner_id,
    parentEntry?.hubspotOwnerId,
    parentEntry?.hubspot_owner_id,
    parentEntry?.ownerId,
    parentEntry?.owner_id
  );

  const companyId = firstNonEmpty(
    transaction.hubspotCompanyId,
    transaction.hubspot_company_id,
    parentEntry?.hubspotCompanyId,
    parentEntry?.hubspot_company_id,
    parentEntry?.companyId,
    parentEntry?.company_id
  );

  const properties = {
    dealname,
    kvnummer: kv,
    closedate: String(closedate),
  };

  if (amountFormatted != null) {
    properties.amount = amountFormatted;
  }
  if (projectNumber) {
    properties.projektnummer = projectNumber;
  }
  if (dealstage) {
    properties.dealstage = dealstage;
  }
  if (pipeline) {
    properties.pipeline = pipeline;
  }
  if (ownerId) {
    properties.hubspot_owner_id = ownerId;
  }

  const associations = [];
  if (companyId) {
    associations.push({
      to: { id: companyId },
      types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }],
    });
  }

  const payload = { properties };
  if (associations.length) {
    payload.associations = associations;
  }

  const delayCandidates = [env.HUBSPOT_CALL_DELAY_MS, env.HUBSPOT_THROTTLE_MS, env.THROTTLE_MS];
  const delayMs = delayCandidates
    .map(value => Number(value))
    .find(value => Number.isFinite(value) && value >= 0) ?? 200;
  await throttle(delayMs);

  const response = await fetch('https://api.hubapi.com/crm/v3/objects/deals', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HubSpot create deal failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  const newId = firstNonEmpty(data.id, data.properties?.hs_object_id);
  if (!newId) {
    throw new Error('HubSpot create deal response missing id');
  }

  return { id: String(newId), raw: data };
}

export function collectHubspotSyncPayload(before, after) {
  if (!after || typeof after !== 'object') return null;

  const normalizedSource = normalizeString(after.source).toLowerCase();
  if (normalizedSource !== 'hubspot') {
    return null;
  }

  const dealId = normalizeString(after.hubspotId || after.hs_object_id);
  const previousProjectNumber = normalizeString(before?.projectNumber);
  const nextProjectNumber = normalizeString(after?.projectNumber);
  const previousKvNummer = normalizeString(firstNonEmpty(before?.kv, before?.kv_nummer));
  const nextKvNummer = normalizeString(firstNonEmpty(after?.kv, after?.kv_nummer));
  const previousFreigabeTs = extractFreigabedatumFromEntry(before);
  const nextFreigabeTs = extractFreigabedatumFromEntry(after);
  const previousClosedate = previousFreigabeTs != null ? Math.trunc(Number(previousFreigabeTs)) : null;
  const nextClosedate = nextFreigabeTs != null ? Math.trunc(Number(nextFreigabeTs)) : null;

  const previousAmount = toNumberMaybe(before?.amount);
  const nextAmount = toNumberMaybe(after?.amount);
  let amountChanged = false;
  if (previousAmount == null && nextAmount != null) {
    amountChanged = true;
  } else if (previousAmount != null && nextAmount == null) {
    amountChanged = true;
  } else if (Number.isFinite(previousAmount) && Number.isFinite(nextAmount)) {
    amountChanged = Math.abs(previousAmount - nextAmount) >= 0.01;
  }

  const properties = {};
  if (previousProjectNumber !== nextProjectNumber) {
    properties.projektnummer = nextProjectNumber;
  }
  if (previousKvNummer !== nextKvNummer) {
    properties.kvnummer = nextKvNummer;
  }
  if (previousClosedate !== nextClosedate) {
    properties.closedate = nextClosedate;
  }
  if (amountChanged && nextAmount != null) {
    properties.amount = nextAmount;
    if (!('projektnummer' in properties)) {
      properties.projektnummer = nextProjectNumber;
    }
    if (!('kvnummer' in properties)) {
      properties.kvnummer = nextKvNummer;
    }
  }

  if (!Object.keys(properties).length) {
    return null;
  }

  return {
    dealId,
    entryId: after.id,
    source: after.source,
    previous: {
      projektnummer: previousProjectNumber,
      kvnummer: previousKvNummer,
      amount: previousAmount,
      closedate: previousClosedate,
    },
    next: {
      projektnummer: nextProjectNumber,
      kvnummer: nextKvNummer,
      amount: nextAmount,
      closedate: nextClosedate,
    },
    properties,
  };
}

export async function hsUpdateDealProperties(dealId, properties, env) {
  const normalizedDealId = normalizeString(dealId);
  if (!normalizedDealId) {
    return { ok: false, error: 'missing_deal_id', attempts: 0, status: null };
  }
  const token = normalizeString(env.HUBSPOT_ACCESS_TOKEN);
  if (!token) {
    return { ok: false, error: 'missing_hubspot_access_token', attempts: 0, status: null };
  }

  const payload = {};
  if (properties && typeof properties === 'object') {
    if (properties.projektnummer != null) payload.projektnummer = normalizeString(properties.projektnummer);
    if (properties.kvnummer != null) payload.kvnummer = normalizeString(properties.kvnummer);
    if ('closedate' in properties) {
      const ts = toEpochMillis(properties.closedate);
      payload.closedate = ts != null ? String(Math.trunc(ts)) : null;
    }
    if (properties.amount != null) {
      const formattedAmount = formatHubspotAmount(properties.amount);
      if (formattedAmount != null) {
        payload.amount = formattedAmount;
      }
    }
  }

  if (!Object.keys(payload).length) {
    return { ok: true, skipped: true, attempts: 0, status: null };
  }

  const backoffRaw = Number(env.HUBSPOT_RETRY_BACKOFF_MS ?? env.RETRY_BACKOFF_MS);
  const backoffMs = Number.isFinite(backoffRaw) && backoffRaw > 0 ? backoffRaw : DEFAULT_HUBSPOT_RETRY_BACKOFF_MS;
  let attempt = 0;
  let lastStatus = null;
  let lastError = '';

  while (attempt < HUBSPOT_UPDATE_MAX_ATTEMPTS) {
    attempt++;
    if (attempt > 1) {
      const delay = backoffMs * Math.pow(2, attempt - 2);
      await sleep(delay);
    }
    try {
      const response = await fetch(`https://api.hubapi.com/crm/v3/objects/deals/${encodeURIComponent(normalizedDealId)}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ properties: payload }),
      });

      lastStatus = response.status;
      const responseText = await response.text();

      if (response.ok) {
        return { ok: true, status: response.status, attempts: attempt };
      }

      lastError = responseText || `HTTP ${response.status}`;
      if ((response.status === 429 || response.status >= 500) && attempt < HUBSPOT_UPDATE_MAX_ATTEMPTS) {
        continue;
      }

      return { ok: false, status: response.status, attempts: attempt, error: lastError };
    } catch (err) {
      lastError = String(err);
      if (attempt >= HUBSPOT_UPDATE_MAX_ATTEMPTS) {
        return { ok: false, status: lastStatus, attempts: attempt, error: lastError };
      }
    }
  }

  return { ok: false, status: lastStatus, attempts: HUBSPOT_UPDATE_MAX_ATTEMPTS, error: lastError || 'unknown_error' };
}

export async function hsFetchDeal(dealId, env) {
  if (!env.HUBSPOT_ACCESS_TOKEN) throw new Error("HUBSPOT_ACCESS_TOKEN missing");

  const properties = [
    "dealname", "amount", "dealstage", "closedate", "hs_object_id", "pipeline",
    "hubspot_owner_id",
    "hs_all_collaborator_owner_ids",
    "flagship_projekt",
  ];

  const associations = "company";

  const url = `https://api.hubapi.com/crm/v3/objects/deals/${dealId}?properties=${properties.join(",")}&associations=${associations}`;

  const r = await fetch(url, { headers: { "Authorization": `Bearer ${env.HUBSPOT_ACCESS_TOKEN}` } });
  if (!r.ok) throw new Error(`HubSpot GET deal ${dealId} failed: ${r.status} ${await r.text()}`);
  return r.json();
}

export async function hsFetchCompany(companyId, env) {
  if (!env.HUBSPOT_ACCESS_TOKEN) throw new Error("HUBSPOT_ACCESS_TOKEN missing for company fetch");
  if (!companyId) return "";
  try {
    const url = `https://api.hubapi.com/crm/v3/objects/companies/${companyId}?properties=name`;
    const r = await fetch(url, { headers: { "Authorization": `Bearer ${env.HUBSPOT_ACCESS_TOKEN}` } });
    if (!r.ok) {
      console.error(`HubSpot GET company ${companyId} failed: ${r.status}`);
      return "";
    }
    const data = await r.json();
    return data?.properties?.name || "";
  } catch (e) {
    console.error(`Error fetching company ${companyId}:`, e);
    return "";
  }
}

export async function hsFetchOwner(ownerId, env) {
  if (!env.HUBSPOT_ACCESS_TOKEN) throw new Error("HUBSPOT_ACCESS_TOKEN missing for owner fetch");
  if (!ownerId) return "";
  try {
    const url = `https://api.hubapi.com/crm/v3/owners/${ownerId}`;
    const r = await fetch(url, { headers: { "Authorization": `Bearer ${env.HUBSPOT_ACCESS_TOKEN}` } });
    if (!r.ok) {
      console.error(`HubSpot GET owner ${ownerId} failed: ${r.status}`);
      return "";
    }
    const data = await r.json();
    return `${data.firstName || ''} ${data.lastName || ''}`.trim();
  } catch (e) {
    console.error(`Error fetching owner ${ownerId}:`, e);
    return "";
  }
}
