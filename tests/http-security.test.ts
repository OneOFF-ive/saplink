import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { gzipSync } from 'node:zlib';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ConfigStore, type Credentials } from '../src/config.js';
import { startAdmin } from '../src/admin.js';
import { startHttp } from '../src/server.js';
import { Operations } from '../src/operations.js';

const credentials: Credentials = { get: async () => '', set: async () => {}, remove: async () => {} };
const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
  protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'security-regression', version: '1' }
} };

function compressedPost(url: string, headers: Record<string, string>, body: Buffer): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json',
      'Content-Encoding': 'gzip', 'Content-Length': String(body.length) } }, response => {
      response.resume();
      response.once('error', reject);
      response.once('end', () => resolve(response.statusCode!));
    });
    req.once('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('Regression request timed out')));
    req.end(body);
  });
}

test('compressed bodies with trailing garbage cannot crash either authenticated HTTP listener', async () => {
  const root = join(process.cwd(), '.saplink', 'tests');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'http-security-'));
  const store = new ConfigStore(directory);
  const { token } = await store.createToken();
  const admin = await startAdmin(store, credentials, 0);
  const mcp = await startHttp(store, new Operations(store, credentials), 0);
  const adminUrl = new URL(admin.url);
  const mcpOrigin = 'http://127.0.0.1:' + (mcp.listener.address() as { port: number }).port;
  const adminHeaders = { 'X-Admin-Token': adminUrl.hash.slice(1), Origin: adminUrl.origin };
  const mcpHeaders = { Authorization: 'Bearer ' + token, Accept: 'application/json, text/event-stream' };
  try {
    // Authentication precedes parsing, but authorized clients can reach the decoder.
    for (const [url, headers, payload] of [
      [adminUrl.origin + '/unknown-route', {}, '{}'],
      [adminUrl.origin + '/api/updates/check', {}, '{}'],
      [adminUrl.origin + '/api/connections', adminHeaders, '{}'],
      [mcpOrigin + '/mcp', mcpHeaders, JSON.stringify(initialize)]
    ] as const) {
      const body = Buffer.concat([gzipSync(Buffer.from(payload)), Buffer.from('invalid trailing frame')]);
      const status = await compressedPost(url, headers, body);
      assert.ok(status >= 200 && status < 500);
      await delay(30); // The vulnerable stream's uncaught error happened after the response.
    }
    assert.equal((await fetch(adminUrl.origin + '/api/state', { headers: adminHeaders })).status, 200);
    const response = await fetch(mcpOrigin + '/mcp', { method: 'POST', headers: { ...mcpHeaders,
      'Content-Type': 'application/json' }, body: JSON.stringify(initialize) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).result.serverInfo.name, 'saplink');
  } finally {
    await admin.close();
    await mcp.close();
    await rm(directory, { recursive: true, force: true });
  }
});
