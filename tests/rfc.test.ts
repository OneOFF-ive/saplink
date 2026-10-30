import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ADTClient } from 'abap-adt-api';
import { RfcTransport, rfcRequestTimeoutMs, rfcRequest, rfcResponse, rfcRuntime, type RfcRuntime, type RfcRole } from '../src/rfc.js';
import { ConfigStore, connectionSchema, connectionIdentityChanged, sapRouterSchema } from '../src/config.js';
import { AdtBackend } from '../src/adt.js';
import { Operations } from '../src/operations.js';
import { AuditLog } from '../src/audit.js';
import { AppError, safeError } from '../src/errors.js';

const object = '/sap/bc/adt/programs/programs/ztest';
test('legacy configs stay HTTP; RFC identity changes require new credentials', () => {
  const legacy = connectionSchema.parse({ connection_id: randomUUID(), name: 'test', base_url: 'https://sap.invalid', client: '001', username: 'TEST', language: 'EN' });
  assert.equal(legacy.rfc, undefined);
  const rfc = connectionSchema.parse({ ...legacy, rfc: { ashost: 'sap.invalid', sysnr: '00' } });
  assert.equal(connectionIdentityChanged(legacy, rfc), true);
  assert.equal(connectionIdentityChanged(rfc, { ...rfc, language: 'ZH' }), false);
  assert.equal(connectionIdentityChanged(rfc, { ...rfc, base_url: 'http://rfc.invalid' }), false);
  for (const settings of [{ ashost: 'sap.invalid', sysnr: '0' }, { ashost: 'user:password@host', sysnr: '00' },
    { ashost: 'host', sysnr: '00', password: 'forbidden' }]) assert.throws(() => connectionSchema.parse({ ...legacy, rfc: settings }));
  assert.throws(() => rfcRuntime({ SAPLINK_CONFIG_DIR: resolve('.saplink/nonexistent-rfc-config') }), (error: unknown) => safeError(error).code === 'RFC_RUNTIME_MISSING');
});
test('SAProuter accepts non-secret multi-hop routes and rejects secret or malformed routes', () => {
  for (const route of ['/H/router.example/S/3299', '/H/10.0.0.1', '/H/outer/S/saprouter/H/inner/S/3299'])
    assert.equal(sapRouterSchema.parse(` ${route} `), route);
  assert.equal(sapRouterSchema.parse(' '), undefined);
  for (const route of ['/H/router/P/secret', '/H/router/W/secret', '/H/router/K/p:snc',
    '/H/router/S/0', '/H/router/S/65536', '/H/', '/S/3299/H/router', 'http://router', '/H/user:secret@router',
    '/H/router/S/', '/H/router?x=1', '/H/router/H/', '/H/a'.repeat(9)]) {
    assert.throws(() => sapRouterSchema.parse(route));
  }
  assert.throws(() => sapRouterSchema.parse('/H/router\n/H/inner'));
  const connection = connectionSchema.parse({ connection_id: randomUUID(), name: 'routed', base_url: 'https://sap.test', client: '001', username: 'TEST', language: 'EN', rfc: { ashost: 'sap.test', sysnr: '00' } });
  const routed = connectionSchema.parse({ ...connection, rfc: { ...connection.rfc, saprouter: '/H/router/S/3299' } });
  assert.equal(connectionIdentityChanged(connection, routed), true);
  assert.equal(connectionIdentityChanged(routed, connection), true);
  assert.equal(connectionIdentityChanged(routed, { ...routed, language: 'ZH' }), false);
});

test('RFC boundary validates paths, strips credentials and preserves read-only POSTs', () => {
  const request = rfcRequest({ url: '/sap/bc/adt/checkruns', method: 'POST', body: '<check/>',
    qs: { name: 'A&B' }, headers: { Authorization: 'secret', Cookie: 'secret', 'x-csrf-token': 'fetch' } }, 'editor', false);
  assert.match(request.uri, /A%26B/);
  assert.doesNotMatch(request.headers, /secret|csrf/i);
  assert.equal(rfcRequest({ url: '/sap/bc/adt/cts/transportchecks', method: 'POST' }, 'reader', false).method, 'POST');
  for (const uri of ['https://evil.invalid/sap/bc/adt/x', '/sap/bc/adt/%2e%2e/secret', '/sap/bc/adt/x#fragment', '/sap/bc/adt/%252e'])
    assert.throws(() => rfcRequest({ url: uri }, 'reader', false));
  assert.throws(() => rfcRequest({ url: object, method: 'PUT' }, 'editor', false), (error: unknown) => safeError(error).code === 'WRITE_DISABLED');
  assert.throws(() => rfcRequest({ url: object, method: 'PUT' }, 'reader', true));
  assert.throws(() => rfcRequest({ url: object, headers: { Accept: 'xml\r\nInjected:1' } }, 'reader', false));
  assert.throws(() => rfcResponse(['1', 'OK', '200', '%%', '%%']));
  for (const path of ['/sap/bc/adt/repository/nodestructure', '/sap/bc/adt/navigation/target',
    '/sap/bc/adt/repository/informationsystem/usageReferences', '/sap/bc/adt/repository/informationsystem/usageSnippets',
    '/sap/bc/adt/abapsource/typehierarchy']) {
    assert.equal(rfcRequest({ url: path, method: 'POST', body: '<read/>' }, 'reader', false).method, 'POST');
  }
  for (const path of ['/sap/bc/adt/activation', '/sap/bc/adt/atc/runs', '/sap/bc/adt/abapunit/testruns'])
    assert.throws(() => rfcRequest({ url: path, method: 'POST' }, 'reader', false));
});
test('RFC large valid base64 responses stay bounded without overflowing the regexp stack', () => {
  const body = Buffer.alloc(5 * 1024 * 1024, 65);
  assert.equal(rfcResponse(['1', 'OK', '200', '', body.toString('base64')]).body.length, body.length);
  for (const invalid of ['AAA', 'A===', 'AA=A', '====', '=AAA'])
    assert.throws(() => rfcResponse(['1', 'OK', '200', '', invalid]));
});
async function fixture(mode = 'normal', saprouter?: string) {
  const root = resolve('.saplink/tests'); await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'rfc-'));
  const state = join(directory, 'state.json'), events = join(directory, 'events.jsonl');
  await writeFile(state, JSON.stringify({ active: 'REPORT ztest.', inactive: 'REPORT ztest.' }));
  await writeFile(events, ''); await writeFile(join(directory, 'SapLinkRfcBridge.class'), 'fixture');
  const connection = connectionSchema.parse({ connection_id: randomUUID(), name: 'rfc', base_url: 'http://never-contact.invalid',
    client: '001', username: 'TEST', language: 'EN', write_enabled: true, rfc: { ashost: 'fake.invalid', sysnr: '00', saprouter } });
  const runtime: RfcRuntime = { java: process.execPath, jcoJar: state, nativeDirectory: directory, classes: directory, cwd: directory, timeoutMs: 2000 };
  const channels: RfcTransport[] = [];
  const create = (role: RfcRole, onActivity?: () => void) => {
    const channel = new RfcTransport(connection, 'synthetic-secret', role, runtime, onActivity,
      () => spawn(process.execPath, [resolve('tests/fixtures/rfc-bridge.mjs'), state, events, mode], { stdio: 'pipe', windowsHide: true }));
    channels.push(channel); return channel;
  };
  return { directory, connection, runtime, state, create, channels,
    events: async () => (await readFile(events, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
    close: async () => { await Promise.allSettled(channels.map(channel => channel.close())); await rm(directory, { recursive: true, force: true }); } };
}
test('all RFC roles receive the configured SAProuter over the private initialization pipe', async () => {
  const route = '/H/router.example/S/3299/H/inner.example/S/3299', f = await fixture('normal', route);
  try {
    for (const role of ['reader', 'editor', 'quality'] as const) {
      await f.create(role).request({ url: '/sap/bc/adt/discovery' });
      const init = JSON.parse(await readFile(`${f.state}.init-${role}.json`, 'utf8'));
      assert.deepEqual(init, { router: route, role });
    }
    assert.doesNotMatch(JSON.stringify(await f.events()), /synthetic-secret/);
  } finally { await f.close(); }
  const direct = await fixture();
  try {
    await direct.create('reader').request({ url: '/sap/bc/adt/discovery' });
    assert.equal(JSON.parse(await readFile(`${direct.state}.init-reader.json`, 'utf8')).router, '');
  } finally { await direct.close(); }
});

test('real ADT backend reads, saves and checks through RFC with isolated channels and one login each', async () => {
  const f = await fixture();
  const backend = new AdtBackend(f.connection, 'synthetic-secret', { transportFactory: f.create });
  try {
    assert.equal((await backend.capabilities() as { transport: string }).transport, 'rfc');
    assert.equal((await backend.read(object, 'inactive')).source, 'REPORT ztest.');
    const lock = await backend.lock(object);
    await backend.save(`${object}/source/main`, 'REPORT ztest.\n* test', lock);
    const diagnostics = backend.takeSaveDiagnostics();
    assert.equal(diagnostics.length, 1); assert.equal(diagnostics[0].request_method, 'PUT');
    assert.equal(diagnostics[0].request_path, `${object}/source/main`); assert.equal(diagnostics[0].http_status, 204);
    assert.doesNotMatch(JSON.stringify(diagnostics), /synthetic-secret|private-lock/);
    assert.deepEqual(backend.takeSaveDiagnostics(), []);
    assert.equal((await backend.read(object, 'inactive')).source, 'REPORT ztest.\n* test');
    assert.equal((await backend.check(object, 'inactive') as { passed: boolean }).passed, true);
    await backend.unlock(object, lock);
    const events = await f.events();
    assert.equal(events.filter(event => event.role === 'editor' && event.path.endsWith('/compatibility/graph')).length, 1);
    assert.equal(events.filter(event => event.role === 'reader' && event.path.endsWith('/compatibility/graph')).length, 1);
    assert.equal(events.some(event => event.credential_headers), false);
    assert.equal(f.channels.length, 3);
  } finally { await backend.close(); await f.close(); }
});
test('idle data preview replaces only the RFC reader and preserves the live editor channel', async () => {
  const f = await fixture(); let now = 0;
  const backend = new AdtBackend(f.connection, 'synthetic-secret', { transportFactory: f.create, queryIdleTimeoutMs: 10, now: () => now });
  try {
    backend.setRequestTimeout(60000);
    const lock = await backend.lock(object);
    assert.equal((await backend.queryTable({ table_name: 'MARA', limit: 1 })).row_count, 1);
    now = 20;
    const query = await backend.queryTable({ table_name: 'MARA', limit: 1 });
    assert.equal(query.row_count, 1);
    assert.equal(query.session_recovery, 'reader_recreated_after_idle_timeout');
    await backend.unlock(object, lock);
    assert.equal(f.channels.filter(channel => channel.role === 'editor').length, 1);
    assert.equal(f.channels.filter(channel => channel.role === 'reader').length, 2);
    assert.equal(f.channels.filter(channel => channel.role === 'reader').at(-1)?.lastDiagnostic.timeout_ms, 60000);
    backend.setRequestTimeout();
    await backend.queryTable({ table_name: 'MARA', limit: 1 });
    assert.equal(f.channels.filter(channel => channel.role === 'reader').at(-1)?.lastDiagnostic.timeout_ms, 2000);
  } finally { await backend.close(); await f.close(); }
});

test('RFC history reads absolute HTTPS/nonstandard-port links over RFC and ignores the legacy HTTP origin', async () => {
  const f = await fixture();
  const backend = new AdtBackend(f.connection, 'synthetic-secret', { transportFactory: f.create });
  try {
    const state = { active: 'REPORT ztest.', inactive: 'REPORT ztest.', historyOrigin: 'https://sap-alias.invalid:8443' };
    await writeFile(f.state, JSON.stringify(state));
    const history: any = await backend.quality('list_source_versions', { object_uri: object });
    assert.equal(history.returned_count, 1);
    const compared: any = await backend.quality('compare_source_versions', { object_uri: object,
      from_version: history.items[0].version_id, to_version: 'active' });
    assert.equal(compared.equal, false);
    assert.equal(compared.from.source_uri, `${object}/source/main/versions/00001/content`);
    const events = await f.events();
    assert.ok(events.some(event => event.role === 'quality' && event.path === `${object}/source/main/versions`));
    assert.ok(events.some(event => event.role === 'quality' && event.path.endsWith('/00001/content')));
    assert.ok(events.every(event => event.method === 'GET'));
    for (const historyLink of ['https://another.invalid:9443/sap/bc/adt/programs/programs/other/source/main',
      `https://alias.invalid:9443${object}/source/main?sap-client=999`]) {
      const before = (await f.events()).length;
      await writeFile(f.state, JSON.stringify({ ...state, historyLink }));
      await assert.rejects(backend.quality('list_source_versions', { object_uri: object }), error => safeError(error).code === 'INVALID_URI');
      assert.ok((await f.events()).slice(before).every(event => event.path === object || event.path === `${object}/source/main/versions`));
    }
  } finally { await backend.close(); await f.close(); }
});
for (const mode of ['hang', 'crash', 'malformed', 'auth']) test(`RFC ${mode} poisons the channel without replay or leaking credentials`, async () => {
  // Allow normal process startup under the full suite's parallel load. The hang
  // fixture still must time out after a request was sent, rather than during boot.
  const f = await fixture(mode);
  const channel = f.create('editor');
  try {
    await assert.rejects(channel.request({ url: '/sap/bc/adt/discovery' }), (error: unknown) => {
      assert.doesNotMatch(JSON.stringify(safeError(error)), /synthetic-secret|private-lock/);
      assert.equal(safeError(error).code, mode === 'auth' ? 'RFC_AUTH_FAILED' : mode === 'malformed' ? 'RFC_PROTOCOL_ERROR' : 'RFC_CONTEXT_LOST');
      return true;
    });
    await assert.rejects(channel.request({ url: '/sap/bc/adt/discovery' }));
    assert.equal((await f.events()).length, 1);
  } finally { await f.close(); }
});
test('Operations keeps RFC write-disabled, version, audit and duplicate request guards', async () => {
  const f = await fixture(); const store = new ConfigStore(f.directory);
  const logs = new AuditLog(join(f.directory, 'logs'));
  await store.save({ schema_version: 1, connections: [f.connection], tokens: [] });
  const ops = new Operations(store, { get: async () => 'synthetic-secret', set: async () => {}, remove: async () => {} }, logs,
    connection => new AdtBackend(connection, 'synthetic-secret', { transportFactory: f.create }));
  try {
    const before = await ops.run('read_source', { connection_id: f.connection.connection_id, object_uri: object, version: 'inactive' });
    assert.equal(before.status, 'success');
    const revision = (before.data as { revision: string }).revision;
    const stale = await ops.run('update_source', { connection_id: f.connection.connection_id, object_uri: object,
      source: 'REPORT ztest.\n* guarded', expected_revision: 'stale', request_id: randomUUID() });
    assert.equal(stale.error?.code, 'VERSION_CONFLICT');
    assert.equal((await f.events()).filter(event => event.method === 'PUT').length, 0);
    // Package lookup uses the same production path; this fixture only changes a $TMP program.
    const input = { connection_id: f.connection.connection_id, object_uri: object, source: 'REPORT ztest.\n* guarded', expected_revision: revision, request_id: randomUUID() };
    const saved = await ops.run('update_source', input);
    assert.equal(saved.status, 'success', JSON.stringify(saved.error));
    const repeated = await ops.run('update_source', input);
    assert.equal(repeated.status, 'success');
    assert.equal((await f.events()).filter(event => event.method === 'PUT').length, 1);
    f.connection.write_enabled = false; await store.save({ schema_version: 1, connections: [f.connection], tokens: [] });
    const denied = await ops.run('update_source', { ...input, request_id: randomUUID() });
    assert.equal(denied.error?.code, 'WRITE_DISABLED');
  } finally { await ops.close().catch(() => {}); await f.close(); }
});
test('a dispatched RFC save followed by bridge exit stays unknown, is never replayed, and blocks subsequent writes', async () => {
  const f = await fixture('save-crash'); const store = new ConfigStore(f.directory);
  await store.save({ schema_version: 1, connections: [f.connection], tokens: [] });
  const ops = new Operations(store, { get: async () => 'synthetic-secret', set: async () => {}, remove: async () => {} },
    new AuditLog(join(f.directory, 'logs')), connection => new AdtBackend(connection, 'synthetic-secret', { transportFactory: f.create }));
  try {
    const before = await ops.run('read_source', { connection_id: f.connection.connection_id, object_uri: object, version: 'inactive' });
    const input = { connection_id: f.connection.connection_id, object_uri: object, source: 'REPORT ztest.\n* maybe saved',
      expected_revision: (before.data as { revision: string }).revision, request_id: randomUUID() };
    const result = await ops.run('update_source', input);
    assert.equal(result.status, 'error'); assert.equal(result.outcome, 'unknown');
    assert.equal(result.write_dispatched, true);
    assert.equal(result.source_save?.saved, 'unknown');
    await ops.run('update_source', input);
    assert.equal((await f.events()).filter(event => event.method === 'PUT').length, 1);
    const next = await ops.run('update_source', { ...input, request_id: randomUUID() });
    assert.equal(next.error?.code, 'SESSION_NEEDS_REVIEW');
  } finally { await ops.close().catch(() => {}); await f.close(); }
});


for (const mode of ['hang', 'crash']) test('cache cleanup discards an exited failed RFC reader: ' + mode, async () => {
  const f = await fixture(mode); const store = new ConfigStore(f.directory);
  await store.save({ schema_version: 1, connections: [f.connection], tokens: [] });
  const ops = new Operations(store, { get: async () => 'synthetic-secret', set: async () => {}, remove: async () => {} },
    new AuditLog(join(f.directory, 'logs')), () => new AdtBackend(f.connection, '', { transportFactory: f.create }));
  try {
    const failed = await ops.run('read_source', { connection_id: f.connection.connection_id, object_uri: object, version: 'active' });
    assert.equal(failed.error?.code, 'RFC_CONTEXT_LOST');
    const cleared = await ops.clearCache(); assert.equal(cleared.cleared_sessions, 1);
    assert.equal((await ops.clearCache()).cleared_sessions, 0);
  } finally { await ops.close(); await f.close(); }
});

test('failed RFC editor and quality contexts still require confirmed cleanup', async () => {
  const f = await fixture('crash');
  try {
    for (const role of ['editor', 'quality'] as const) {
      const channel = f.create(role);
      await assert.rejects(channel.request({ url: '/sap/bc/adt/discovery' }));
      await assert.rejects(channel.close(), error => safeError(error).code === 'RFC_CONTEXT_LOST');
    }
  } finally { await f.close(); }
});


test('RFC CTS timeout budget is scoped to transport reads and preflight, never mutations', () => {
  const runtime = {timeoutMs:15000} as RfcRuntime;
  for (const path of ['/sap/bc/adt/cts/transportrequests', '/sap/bc/adt/cts/transportrequests/DEVK904228'])
    assert.equal(rfcRequestTimeoutMs(runtime, 'GET', path), 60000);
  assert.equal(rfcRequestTimeoutMs(runtime, 'POST', '/sap/bc/adt/cts/transportchecks'), 60000);
  for (const [method, path] of [['POST', '/sap/bc/adt/cts/transportrequests'], ['PUT', object+'/source/main'], ['POST', '/sap/bc/adt/activation'], ['GET', object], ['GET', '/sap/bc/adt/cts/transportrequestsevil']])
    assert.equal(rfcRequestTimeoutMs(runtime, method, path), 15000);
  assert.equal(rfcRequestTimeoutMs({...runtime,ctsTimeoutMs:90000}, 'GET', '/sap/bc/adt/cts/transportrequests'),90000);
  assert.equal(rfcRequestTimeoutMs({...runtime,timeoutMs:120000}, 'GET', '/sap/bc/adt/cts/transportrequests'),120000);
});

test('RFC per-call timeout overrides CTS defaults and resets without mutating the runtime', async () => {
  const f = await fixture();
  try {
    const channel = f.create('reader');
    channel.setRequestTimeout(1000);
    await channel.request({ url: '/sap/bc/adt/cts/transportrequests' });
    assert.equal(channel.lastDiagnostic.timeout_ms, 1000);
    assert.equal(f.runtime.timeoutMs, 2000);
    channel.setRequestTimeout();
    await channel.request({ url: '/sap/bc/adt/cts/transportrequests' });
    assert.equal(channel.lastDiagnostic.timeout_ms, 60000);
    await channel.request({ url: '/sap/bc/adt/discovery' });
    assert.equal(channel.lastDiagnostic.timeout_ms, 2000);
    assert.throws(() => channel.setRequestTimeout(0), /timeout_ms/);
  } finally { await f.close(); }
});

test('RFC request timer uses the dynamic override on an already-running bridge', async () => {
  const f = await fixture('slow');
  try {
    const channel = f.create('reader');
    channel.setRequestTimeout(2000);
    await channel.request({ url: '/sap/bc/adt/discovery' });
    channel.setRequestTimeout(100);
    await assert.rejects(channel.request({ url: '/sap/bc/adt/discovery' }), error => {
      const result = safeError(error);
      assert.equal(result.code, 'RFC_CONTEXT_LOST');
      assert.equal((result.details as any).timeout_ms, 100);
      assert.equal(channel.lastDiagnostic.timeout_ms, 100);
      return true;
    });
    assert.equal(f.runtime.timeoutMs, 2000);
  } finally { await f.close(); }
});
