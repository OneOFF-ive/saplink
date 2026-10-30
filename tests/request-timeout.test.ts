import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AdtBackend, type Backend } from '../src/adt.js';
import { ConfigStore, connectionSchema, type Credentials } from '../src/config.js';
import { AuditLog } from '../src/audit.js';
import { Operations } from '../src/operations.js';
import { safeError } from '../src/errors.js';
import { validateRequestTimeout } from '../src/request-timeout.js';
import { toolSchemas } from '../src/tool-definitions.js';
import { validateSapInput } from '../src/sap-cli.js';
import { startHttp } from '../src/server.js';

const credentials: Credentials = { get: async () => 'fake', set: async () => {}, remove: async () => {} };
const connection = () => connectionSchema.parse({ connection_id: randomUUID(), name: 'test',
  base_url: 'http://127.0.0.1:1', client: '001', username: 'TEST', language: 'EN', write_enabled: true });

test('shared MCP schemas and CLI timeout flags validate bounds, types and conflicting input', () => {
  for (const value of [100, 15000, 60000, 600000, undefined]) assert.equal(validateRequestTimeout(value), value);
  for (const value of [0, -1, 99, 600001, 100.5, NaN, Infinity, null, '60000']) assert.throws(() => validateRequestTimeout(value));
  for (const [name, schema] of Object.entries(toolSchemas)) {
    if (name !== 'list_connections') assert.ok(schema.shape.timeout_ms, name);
  }
  const id = randomUUID();
  assert.equal(validateSapInput('get_capabilities', {}, id, '60000').timeout_ms, 60000);
  assert.equal(validateSapInput('get_capabilities', { timeout_ms: 60000 }, id, '60000').timeout_ms, 60000);
  assert.throws(() => validateSapInput('get_capabilities', { timeout_ms: 15000 }, id, '60000'), /conflicts/);
  for (const value of ['1e4', '12s', '0', '600001', '100.5']) assert.throws(() => validateSapInput('get_capabilities', {}, id, value));
});

test('HTTP channels enforce per-request timeouts and restore defaults without changing other backends', async () => {
  const server = createServer((req, res) => {
    if (req.url?.includes('/compatibility/graph')) { res.setHeader('x-csrf-token', 'fake'); res.end('<graph/>'); return; }
    if (req.url?.includes('/icf/logoff')) { res.end(''); return; }
    const timer = setTimeout(() => res.end('ok'), 300);
    res.once('close', () => clearTimeout(timer));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const c = { ...connection(), base_url: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
  const backend = new AdtBackend(c, 'fake');
  const other = new AdtBackend(c, 'fake');
  try {
    backend.setRequestTimeout(100);
    for (const channel of (backend as any).channels) {
      await assert.rejects(channel.request({ url: '/sap/bc/adt/slow' }), () => {
        assert.equal(channel.lastDiagnostic.timeout_ms, 100); return true;
      });
    }
    backend.setRequestTimeout(2000);
    assert.equal((await (backend as any).channels[0].request({ url: '/sap/bc/adt/slow' })).body, 'ok');
    backend.setRequestTimeout();
    assert.equal((await (backend as any).channels[0].request({ url: '/sap/bc/adt/slow' })).body, 'ok');
    assert.equal((backend as any).channels[0].lastDiagnostic.timeout_ms, 15000);
    await (other as any).channels[0].request({ url: '/sap/bc/adt/slow' });
    assert.equal((other as any).channels[0].lastDiagnostic.timeout_ms, 15000);
    backend.setRequestTimeout(100);
    await assert.rejects((backend as any).client.httpClient.request('/sap/bc/adt/slow'), error => {
      assert.equal((safeError(error).details as any).timeout_ms, 100); return true;
    });
  } finally {
    backend.setRequestTimeout(); await backend.close(); await other.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

async function fixture() {
  const root = resolve('.saplink/tests'); await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'timeouts-'));
  const store = new ConfigStore(directory); const c = connection();
  await store.save({ schema_version: 1, connections: [c], tokens: [] });
  let timeout: number | undefined; const observed: (number | undefined)[] = [];
  const backend = {
    setRequestTimeout: (value?: number) => { timeout = value; },
    capabilities: async () => { const captured = timeout; await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(timeout, captured, 'same-connection calls must be serialized'); observed.push(captured); return { timeout_ms: captured ?? 'default' }; },
    quality: async (_tool: string, args: object) => { assert.ok(!('timeout_ms' in args)); return { timeout_ms: timeout }; },
    inspectRepository: async (_tool: string, args: object) => { assert.ok(!('timeout_ms' in args)); return { timeout_ms: timeout }; },
    close: async () => {}
  } as unknown as Backend;
  const operations = new Operations(store, credentials, new AuditLog(join(directory, 'logs')), () => backend);
  return { c, store, operations, observed, timeout: () => timeout,
    cleanup: async () => { await operations.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('queued operations scope timeout to the call and strip it from strict quality/repository arguments', async () => {
  const f = await fixture(); const input = { connection_id: f.c.connection_id };
  try {
    const results = await Promise.all([f.operations.run('get_capabilities', { ...input, timeout_ms: 60000 }),
      f.operations.run('get_capabilities', input), f.operations.run('get_capabilities', { ...input, timeout_ms: 1000 })]);
    assert.ok(results.every(result => result.status === 'success'));
    assert.deepEqual(f.observed, [60000, undefined, 1000]); assert.equal(f.timeout(), undefined);
    for (const [tool, args] of [['get_atc_configuration', {}], ['get_ddic_definition', { entity_name: 'MARA' }]] as const) {
      const result = await f.operations.run(tool, { ...input, ...args, timeout_ms: 60000 });
      assert.equal(result.status, 'success', JSON.stringify(result));
      assert.equal((result.data as any).timeout_ms, 60000); assert.equal(f.timeout(), undefined);
    }
    await assert.rejects(f.operations.run('get_capabilities', { ...input, timeout_ms: 0 }), /timeout_ms/);
  } finally { await f.cleanup(); }
});

test('changing a write timeout retrieves the same MCP-process result without a new dispatch', async () => {
  const f = await fixture();
  try {
    const args = { connection_id: f.c.connection_id, request_id: 'one-intent', timeout_ms: 100 };
    // Invalid tool payload fails before a mutation, but remains a tracked write intent.
    const first = await f.operations.run('run_unit_tests', args);
    const second = await f.operations.run('run_unit_tests', { ...args, timeout_ms: 60000 });
    assert.equal(second.operation_id, first.operation_id); assert.equal(second.status, first.status);
    assert.equal(f.observed.length, 1); assert.equal(f.timeout(), undefined);
  } finally { await f.cleanup(); }
});

test('MCP advertises and accepts timeout_ms on a real tool call and rejects out-of-range input', async () => {
  const f = await fixture(); const { token } = await f.store.createToken();
  const runtime = await startHttp(f.store, f.operations, 0);
  const client = new Client({ name: 'timeout-test', version: '1' });
  try {
    const address = runtime.listener.address() as { port: number };
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`),
      { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const list = await client.listTools();
    assert.ok(list.tools.find(tool => tool.name === 'syntax_check')?.inputSchema.properties?.timeout_ms);
    const result = await client.callTool({ name: 'get_capabilities', arguments: { connection_id: f.c.connection_id, timeout_ms: 60000 } });
    assert.equal(result.isError, false); assert.equal((result.structuredContent as any).data.timeout_ms, 60000);
    const invalid = await client.callTool({ name: 'get_capabilities', arguments: { connection_id: f.c.connection_id, timeout_ms: 600001 } });
    assert.equal(invalid.isError, true); assert.deepEqual(f.observed, [60000]);
    assert.equal(f.timeout(), undefined);
  } finally { await client.close(); await runtime.close(); await f.cleanup(); }
});
