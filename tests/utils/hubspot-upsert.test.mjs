import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { upsertByHubSpotId, normalizeTransactionKv } from '../../worker/index.js';

describe('upsertByHubSpotId duplicate handling', () => {
  it('überspringt neuen HubSpot-Deal bei bestehender Projektnummer und KV', () => {
    const existingEntry = {
      id: 'entry_existing',
      projectNumber: 'PN-100',
      kvNummern: ['KV-123'],
    };
    const entries = [existingEntry];

    const deal = {
      id: '9001',
      properties: {
        dealname: 'Testdeal',
        projektnummer: 'PN-100',
        kvnummer: 'KV-123',
      },
    };

    const result = upsertByHubSpotId(entries, deal);

    assert.equal(result.action, 'skip');
    assert.equal(result.reason, 'duplicate_project_kv');
    assert.equal(entries.length, 1);
  });

  it('legt einen neuen Eintrag an, wenn keine Überschneidung besteht', () => {
    const entries = [];
    const deal = {
      id: '9002',
      properties: {
        dealname: 'Neuer Deal',
        projektnummer: 'PN-200',
        kvnummer: 'KV-999',
      },
    };

    const result = upsertByHubSpotId(entries, deal);

    assert.equal(result.action, 'create');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].projectNumber, 'PN-200');
    assert.deepEqual(entries[0].kvNummern, ['KV-999']);
  });

  it('aktualisiert bestehende HubSpot-Einträge weiterhin', () => {
    const entries = [{
      id: 'hubspot_entry',
      hubspotId: '9003',
      projectNumber: 'PN-300',
      kvNummern: ['KV-777'],
      title: 'Alter Titel',
    }];

    const deal = {
      id: '9003',
      properties: {
        dealname: 'Aktualisierter Titel',
        projektnummer: 'PN-300',
        kvnummer: 'KV-777',
        amount: '1234.56',
      },
    };

    const result = upsertByHubSpotId(entries, deal);

    assert.equal(result.action, 'update');
    assert.equal(entries[0].title, 'Aktualisierter Titel');
    assert.equal(entries[0].hubspotId, '9003');
  });
});

describe('normalizeTransactionKv', () => {
  it('bevorzugt KV-Listenfelder gegenüber Einzelfeldern', () => {
    const transaction = {
      kvNummern: [' KV-100 ', 'KV-200'],
      kv: 'IGNORED',
    };

    assert.equal(normalizeTransactionKv(transaction), 'KV-100');
  });

  it('fällt auf Einzelfelder zurück, wenn keine Liste vorhanden ist', () => {
    const transaction = {
      kv_nummer: 'KV-300',
    };

    assert.equal(normalizeTransactionKv(transaction), 'KV-300');
  });
});
