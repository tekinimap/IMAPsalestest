import test from 'node:test';
import assert from 'node:assert/strict';

const originalFetch = global.fetch;

test('config removes trailing wildcard from workerBase', async (t) => {
  try {
    global.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ workerBase: 'https://example.com/api/*' }),
    });

    const module = await import(`../../public/js/config.js?test=${Date.now()}${Math.random()}`);
    assert.equal(module.WORKER_BASE, 'https://example.com/api');
    assert(module.CONFIG_WARNINGS.some((msg) => msg.includes('Platzhalter')));
    assert.equal(module.CONFIG_ERRORS.length, 0);
  } finally {
    global.fetch = originalFetch;
  }
});
