import test from 'node:test';
import assert from 'node:assert/strict';

const createHeaders = (entries = {}) => ({
  get(key) {
    const target = key.toLowerCase();
    const match = Object.entries(entries).find(([name]) => name.toLowerCase() === target);
    return match ? match[1] : null;
  },
});

const createRequest = (headers = {}) => ({ headers: createHeaders(headers) });

await test('getCorsHeaders prefers request origin when wildcard configured', async () => {
  const { getCorsHeaders } = await import('../../worker/index.js');
  const headers = getCorsHeaders({ ALLOWED_ORIGIN: '*' }, createRequest({ Origin: 'https://example.org' }));
  assert.equal(headers['Access-Control-Allow-Origin'], 'https://example.org');
  assert.equal(headers['Access-Control-Allow-Credentials'], 'true');
});

await test('getCorsHeaders falls back to referer when origin header missing', async () => {
  const { getCorsHeaders } = await import('../../worker/index.js');
  const headers = getCorsHeaders({}, createRequest({ Referer: 'https://fallback.example.com/path' }));
  assert.equal(headers['Access-Control-Allow-Origin'], 'https://fallback.example.com');
  assert.equal(headers['Access-Control-Allow-Credentials'], 'true');
});
