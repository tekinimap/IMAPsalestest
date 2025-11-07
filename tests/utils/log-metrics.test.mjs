import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractPersonAmounts,
  computeEntryTotal,
  computeLogMetrics,
} from '../../worker/log-analytics.js';

const peopleMap = new Map([
  ['Alice Example', 'Team Alpha'],
  ['Bob Example', 'Team Beta'],
]);

test('extractPersonAmounts uses money and pct fallback', () => {
  const entry = {
    amount: 200,
    list: [
      { name: 'Alice Example', money: 120 },
      { name: 'Bob Example', pct: 40 },
      { name: 'Unknown', money: null },
    ],
  };
  const result = extractPersonAmounts(entry);
  assert.equal(result.get('Alice Example'), 120);
  assert.equal(Math.round(result.get('Bob Example')), 80);
  assert.equal(result.has('Unknown'), false);
});

test('computeEntryTotal prefers list sums and falls back to transactions', () => {
  const entryWithList = {
    amount: 500,
    list: [
      { name: 'Alice Example', money: 200 },
      { name: 'Bob Example', money: 150 },
    ],
  };
  assert.equal(computeEntryTotal(entryWithList), 350);

  const entryWithTransactions = {
    transactions: [
      { amount: 250 },
      { amount: 125 },
    ],
  };
  assert.equal(computeEntryTotal(entryWithTransactions), 375);
});

test('computeLogMetrics aggregates totals, months, and events', () => {
  const logs = [
    {
      ts: Date.parse('2025-10-01T00:00:00Z'),
      event: 'create',
      after: {
        amount: 100,
        freigabedatum: Date.parse('2025-08-20T00:00:00Z'),
        list: [
          { name: 'Alice Example', money: 60 },
          { name: 'Bob Example', money: 40 },
        ],
      },
    },
    {
      ts: Date.parse('2025-10-15T00:00:00Z'),
      event: 'update',
      before: {
        amount: 100,
        freigabedatum: Date.parse('2025-09-10T00:00:00Z'),
        list: [
          { name: 'Alice Example', money: 60 },
          { name: 'Bob Example', money: 40 },
        ],
      },
      after: {
        amount: 160,
        freigabedatum: Date.parse('2025-09-10T00:00:00Z'),
        list: [
          { name: 'Alice Example', money: 90 },
          { name: 'Bob Example', money: 70 },
        ],
      },
    },
    {
      ts: Date.parse('2025-11-05T00:00:00Z'),
      event: 'delete',
      before: {
        amount: 50,
        freigabedatum: Date.parse('2025-07-05T00:00:00Z'),
        list: [
          { name: 'Alice Example', money: 20 },
          { name: 'Bob Example', money: 30 },
        ],
      },
    },
  ];

  const overall = computeLogMetrics(logs, {}, peopleMap);
  assert.equal(overall.totals.count, 3);
  assert.equal(overall.totals.positiveCount, 2);
  assert.equal(overall.totals.negativeCount, 1);
  assert.equal(overall.totals.amount, 110);
  assert.ok(Math.abs(overall.totals.successRate - (2 / 3)) < 1e-9);
  assert.deepEqual(
    overall.months.map((m) => ({ month: m.month, amount: m.amount })),
    [
      { month: '2025-07', amount: -50 },
      { month: '2025-08', amount: 100 },
      { month: '2025-09', amount: 60 },
    ],
  );
  assert.deepEqual(
    overall.events.map((ev) => ({ event: ev.event, count: ev.count, amount: ev.amount })),
    [
      { event: 'create', count: 1, amount: 100 },
      { event: 'delete', count: 1, amount: -50 },
      { event: 'update', count: 1, amount: 60 },
    ],
  );

  const teamAlpha = computeLogMetrics(logs, { team: 'Team Alpha' }, peopleMap);
  assert.equal(teamAlpha.totals.amount, 70);
  assert.equal(teamAlpha.totals.positiveCount, 2);
  assert.equal(teamAlpha.totals.negativeCount, 1);

  const teamBeta = computeLogMetrics(logs, { team: 'Team Beta' }, peopleMap);
  assert.equal(teamBeta.totals.amount, 40);
  assert.equal(teamBeta.totals.positiveCount, 2);
  assert.equal(teamBeta.totals.negativeCount, 1);
});
