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


test('save captures actual outgoing framing for success and reset without source or credentials', async () => {
  let reset = false;
  let receivedBytes = 0;
  const server = createServer((req, res) => {
    if (req.url?.includes('/compatibility/graph')) { res.setHeader('x-csrf-token', 'PRIVATE_TOKEN'); return res.end('<graph/>'); }
    if (req.url?.includes('/icf/logoff')) return res.end('');
    req.on('data', chunk => { receivedBytes += chunk.length; });
    req.on('end', () => { if (reset) req.socket.destroy(); else { res.statusCode = 204; res.end(); } });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const backend = new AdtBackend(connectionSchema.parse({ connection_id: randomUUID(), name: 'mock',
    base_url: 'http://127.0.0.1:' + (server.address() as any).port, client: '001', username: 'TEST', language: 'EN' }), 'PRIVATE_PASSWORD');
  const path = '/sap/bc/adt/programs/programs/ztest/source/main';
  const body = 'PRIVATE_SOURCE 中文\r\n';
  try {
    for (const failed of [false, true]) {
      reset = failed; receivedBytes = 0;
      const save = backend.save(path, body, 'PRIVATE_LOCK');
      if (failed) await assert.rejects(save); else await save;
      assert.equal(receivedBytes, Buffer.byteLength(body));
      const rows = backend.takeSaveDiagnostics();
      assert.equal(rows.length, 1);
      const row = rows[0];
      assert.equal(row.request_method, 'PUT'); assert.equal(row.request_path, path);
      assert.equal(row.request_body_bytes, receivedBytes); assert.equal(row.request_content_length, receivedBytes);
      assert.equal(row.request_chunked, false); assert.equal(row.request_charset, 'utf-8');
      assert.equal(row.http_version, '1.1'); assert.equal(row.transport, 'axios_node_http');
      assert.equal(row.request_finished, true); assert.equal(row.response_started, !failed);
      if (failed) assert.equal(row.network_code, 'ECONNRESET'); else assert.equal(row.http_status, 204);
      assert.ok(typeof row.elapsed_ms === 'number');
      assert.equal(JSON.stringify(rows).includes('PRIVATE_'), false);
      assert.deepEqual(backend.takeSaveDiagnostics(), []);
    }
  } finally { await backend.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
