import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { AdtBackend } from '../src/adt.js';
import { connectionSchema } from '../src/config.js';
import { safeError } from '../src/errors.js';

test('CTS accepts over 4 MiB but retains a bounded limit and sanitized diagnostics', async () => {
  let size = 5 * 1024 * 1024;
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('x-csrf-token', 'PRIVATE_TOKEN');
    if (req.url?.includes('/compatibility/graph')) return res.end('<graph/>');
    if (req.url?.includes('/icf/logoff')) return res.end('');
    res.end('<root><!--' + 'x'.repeat(size) + '--><workbench/><customizing/></root>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port;
  const backend = new AdtBackend(connectionSchema.parse({ connection_id: randomUUID(), name: 'mock',
    base_url: 'http://127.0.0.1:' + port, client: '001', username: 'TEST', language: 'EN' }), 'PRIVATE_PASSWORD');
  try {
    assert.deepEqual(await backend.transports(), { workbench: [], customizing: [] });
    await assert.rejects(backend.search('PRIVATE_QUERY', undefined, 10), error => {
      const safe = safeError(error);
      assert.equal(safe.code, 'BACKEND_RESPONSE_TOO_LARGE');
      assert.equal((safe.details as any).request_method, 'GET');
      assert.equal((safe.details as any).error_kind, 'response_size_limit');
      assert.ok((safe.details as any).elapsed_ms >= 0);
      assert.equal(JSON.stringify(safe).includes('PRIVATE_'), false);
      return true;
    });
    size = 17 * 1024 * 1024;
    await assert.rejects(backend.transports(), error => {
      const safe = safeError(error);
      assert.equal(safe.code, 'BACKEND_RESPONSE_TOO_LARGE');
      assert.equal((safe.details as any).request_path, '/sap/bc/adt/cts/transportrequests');
      return true;
    });
  } finally { await backend.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});


test('connection resets retain safe request body and socket diagnostics', async () => {
  const server = createServer((req, res) => {
    if (req.url?.includes('/compatibility/graph')) {
      res.setHeader('x-csrf-token', 'PRIVATE_TOKEN'); return res.end('<graph/>');
    }
    if (req.url?.includes('/icf/logoff')) return res.end('');
    req.socket.destroy();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const backend = new AdtBackend(connectionSchema.parse({ connection_id: randomUUID(), name: 'mock',
    base_url: 'http://127.0.0.1:' + (server.address() as any).port, client: '001', username: 'TEST', language: 'EN' }), 'PRIVATE_PASSWORD');
  const body = 'PRIVATE_SOURCE 中文';
  try {
    await assert.rejects((backend as any).client.httpClient.request('/sap/bc/adt/checkruns', {
      method: 'POST', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body
    }), error => {
      const safe = safeError(error); const details = safe.details as any;
      assert.equal(safe.code, 'OUTCOME_UNKNOWN'); assert.equal(details.network_code, 'ECONNRESET');
      assert.equal(details.request_path, '/sap/bc/adt/checkruns');
      assert.equal(details.request_body_bytes, Buffer.byteLength(body));
      assert.equal(details.request_content_type, 'text/plain'); assert.equal(details.response_started, false);
      assert.equal(typeof details.socket_reused, 'boolean');
      assert.equal(JSON.stringify(safe).includes('PRIVATE_'), false); return true;
    });
  } finally { await backend.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
