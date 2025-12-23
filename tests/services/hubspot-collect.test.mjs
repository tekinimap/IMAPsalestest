import assert from 'node:assert/strict';
import test from 'node:test';

import { collectHubspotSyncPayload } from '../../functions/services/hubspot.js';

test('collectHubspotSyncPayload ignoriert Nicht-HubSpot-Quellen', () => {
  const before = {
    projectNumber: 'PN-1',
    kv: 'KV-1',
    amount: 100,
    freigabedatum: 1700000000000,
  };

  const after = {
    ...before,
    projectNumber: 'PN-2',
    source: 'erp-import',
  };

  const payload = collectHubspotSyncPayload(before, after);
  assert.equal(payload, null);
});

test('collectHubspotSyncPayload ignoriert fehlende Quellen', () => {
  const before = {
    projectNumber: 'PN-1',
    kv: 'KV-1',
    amount: 100,
    freigabedatum: 1700000000000,
  };

  const after = {
    ...before,
    projectNumber: 'PN-2',
  };

  const payload = collectHubspotSyncPayload(before, after);
  assert.equal(payload, null);
});

test('collectHubspotSyncPayload liefert Payload für HubSpot-Deals', () => {
  const before = {
    hubspotId: '9001',
    projectNumber: 'PN-1',
    kv: 'KV-1',
    amount: 100,
    freigabedatum: 1700000000000,
    source: 'hubspot',
  };

  const after = {
    ...before,
    projectNumber: 'PN-2',
    amount: 150,
  };

  const payload = collectHubspotSyncPayload(before, after);

  assert.ok(payload);
  assert.equal(payload.dealId, '9001');
  assert.equal(payload.properties.projektnummer, 'PN-2');
  assert.equal(payload.properties.amount, 150);
  assert.equal(payload.properties.kvnummer, 'KV-1');
});
