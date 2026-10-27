import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ConfigStore, connectionSchema, normalizeUrl, type Credentials } from '../src/config.js';
import { AuditLog } from '../src/audit.js';
import { adtUri, sameSavedSource, sourceResult, type Backend, type Version } from '../src/adt.js';
import { Operations } from '../src/operations.js';
import { AppError } from '../src/errors.js';
import { AdtErrorException } from 'abap-adt-api';
import { startHttp } from '../src/server.js';

const object = '/sap/bc/adt/programs/programs/ztest';
const source = `${object}/source/main`;
const credentials: Credentials = { get: async () => 'fake', set: async () => {}, remove: async () => {} };
test('save comparison ignores blank lines but preserves nonblank content and literal data', () => {
  assert.equal(sameSavedSource('REPORT ztest.\r\n', 'REPORT ztest.'), true);
  assert.equal(sameSavedSource('REPORT ztest.\n\n', 'REPORT ztest.\r\n'), true);
  assert.equal(sameSavedSource('REPORT ztest. ', 'REPORT ztest.'), false);
  assert.equal(sameSavedSource('REPORT ztest.\n* comment', 'REPORT ztest.* comment'), false);
  assert.equal(sameSavedSource('WRITE 1.', 'WRITE 2.'), false);
  assert.equal(sameSavedSource('\nREPORT ztest.\n\t \nWRITE 1.\n', 'REPORT ztest.\r\nWRITE 1.'), true);
  assert.equal(sameSavedSource('WRITE 1.\nWRITE 2.', 'WRITE 2.\nWRITE 1.'), false);
  assert.equal(sameSavedSource('  WRITE 1.', 'WRITE 1.'), false);
  assert.equal(sameSavedSource('* comment\nWRITE 1.', 'WRITE 1.'), false);
  assert.equal(sameSavedSource('DATA(text) = |first\n\nlast|.', 'DATA(text) = |first\nlast|.'), false);
  assert.equal(sameSavedSource('WRITE |a\\|b|.\n\nWRITE 1.', 'WRITE |a\\|b|.\nWRITE 1.'), true);
  assert.equal(sameSavedSource('" ignored quote |\n\nWRITE 1.', '" ignored quote |\nWRITE 1.'), true);
  assert.notEqual(sourceResult('id', object, source, 'WRITE 1.\n\n', 'active').revision,
    sourceResult('id', object, source, 'WRITE 1.', 'active').revision);
});
class FakeBackend implements Backend {
  active = 'REPORT ztest.'; inactive: string | undefined;
  saves = 0; locks = 0; unlocks = 0; failUnlock = false; uncertain = false; activationPass = true;
  constructor(private connection: string) {}
  async capabilities() { return { available: true }; }
  async search() { return { objects: [{ object_uri: object }] }; }
  async listPackage() { return { objects: [] }; }
  async read(uri: string, version: Version) {
    const code = version === 'active' ? this.active : this.inactive;
    if (code === undefined) throw new AppError('VERSION_UNAVAILABLE', 'No inactive source');
    return sourceResult(this.connection, uri, `${uri}/source/main`, code, version);
  }
  async packageOf() { return '$TMP'; }
  async transportRequirement(): Promise<'required' | 'not_required'> { return 'required'; }
  async lock() { this.locks++; return 'private-lock-handle'; }
  async unlock() { this.unlocks++; if (this.failUnlock) throw new Error('Unlock failed'); }
  async save(_uri: string, code: string) { this.saves++; this.inactive = code;
    if (this.uncertain) throw new AppError('OUTCOME_UNKNOWN', 'Connection was interrupted'); }
  async create() { this.inactive = this.active; return object; }
  async check() { return { passed: true }; }
  async activate() { if (this.activationPass) { this.active = this.inactive!; this.inactive = undefined; }
    return { success: this.activationPass, messages: [] }; }
  async transports() { return []; }
  async close() {}
}
async function fixture() {
  const root = join(process.cwd(), '.saplink', 'tests');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'test-'));
  const store = new ConfigStore(directory);
  const connection = connectionSchema.parse({ connection_id: randomUUID(), name: 'dev', base_url: 'http://sap.test:8000',
    client: '001', username: 'TEST', language: 'EN', write_enabled: true });
  await store.save({ schema_version: 1, connections: [connection], tokens: [] });
  const backend = new FakeBackend(connection.connection_id);
  const logDirectory = join(directory, 'logs');
  const operations = new Operations(store, credentials, new AuditLog(logDirectory), () => backend);
  return { directory, store, connection, backend, operations, logDirectory,
    cleanup: async () => { await operations.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('cache cleanup recreates sessions and retains write replay protection', async () => {
  const f = await fixture();
  let created = 0; let closed = 0;
  const ops = new Operations(f.store, credentials, new AuditLog(f.logDirectory), () => {
    created++; f.backend.close = async () => { closed++; }; return f.backend;
  });
  try {
    const args = { connection_id: f.connection.connection_id, name: 'znew', description: 'test', package_name: '$TMP', request_id: 'same-write' };
    const original = await ops.run('create_program', args);
    assert.equal(original.status, 'success');
    assert.deepEqual(await ops.clearCache(), { cleared_sessions: 1, retained_write_requests: 1 });
    assert.equal(closed, 1);
    assert.equal((await ops.run('create_program', args)).operation_id, original.operation_id);
    assert.equal(created, 1, 'replayed writes must not establish a new session or execute again');
    await ops.run('read_source', { connection_id: args.connection_id, object_uri: object, version: 'active' });
    assert.equal(created, 2);
  } finally { await ops.close(); await f.cleanup(); }
});

test('cache cleanup refuses active work and blocks new requests until session cleanup finishes', async () => {
  const f = await fixture();
  try {
    let finishRead!: () => void;
    const gate = new Promise<void>(resolve => { finishRead = resolve; });
    const read = f.backend.read.bind(f.backend);
    f.backend.read = async (...args) => { await gate; return read(...args); };
    const pending = f.operations.run('read_source', { connection_id: f.connection.connection_id, object_uri: object, version: 'active' });
    await assert.rejects(f.operations.clearCache(), (e: AppError) => e.code === 'BUSY');
    finishRead(); await pending;
    let finishClose!: () => void;
    f.backend.close = () => new Promise<void>(resolve => { finishClose = resolve; });
    const clearing = f.operations.clearCache();
    await assert.rejects(f.operations.run('list_connections', {}), (e: AppError) => e.code === 'BUSY');
    await assert.rejects(f.operations.clearCache(), (e: AppError) => e.code === 'BUSY');
    finishClose(); await clearing;
    assert.equal((await f.operations.run('list_connections', {})).status, 'success');
  } finally { await f.cleanup(); }
});

test('failed cache cleanup reports failure and retains the session for inspection', async () => {
  const f = await fixture();
  try {
    await f.operations.run('read_source', { connection_id: f.connection.connection_id, object_uri: object, version: 'active' });
    f.backend.close = async () => { throw new Error('private backend details'); };
    await assert.rejects(f.operations.clearCache(), (e: AppError) => e.code === 'CACHE_CLEAR_FAILED' && !e.message.includes('private'));
    f.backend.close = async () => {};
    assert.equal((await f.operations.clearCache()).cleared_sessions, 1);
  } finally { await f.cleanup(); }
});

test('source save reports accepted writes when readback fails, without inventing a revision', async () => {
  const f = await fixture(); try {
    const read = f.backend.read.bind(f.backend);
    f.backend.read = async (uri, version) => {
      if (version === 'inactive' && f.backend.saves) throw new AppError('OUTCOME_UNKNOWN', 'Read failed');
      return read(uri, version);
    };
    const result = await f.operations.run('update_source', { connection_id: f.connection.connection_id,
      source_uri: source, source: 'REPORT ztest. WRITE 1.',
      expected_revision: (await read(object, 'active')).revision, request_id: 'readback-failure' });
    assert.equal(result.status, 'error'); assert.equal(result.outcome, 'partial');
    assert.equal(result.source_save?.saved, true);
    assert.equal(result.source_save?.verification, 'unavailable');
    assert.equal(result.source_save?.inactive_revision, undefined);
    assert.equal(f.backend.unlocks, 1);
  } finally { await f.cleanup(); }
});

test('source save reports unknown dispatched outcomes and adds contextual signature hints only for module scanner errors', async () => {
  for (const module of [true, false]) {
    const f = await fixture(); try {
      const uri = module ? '/sap/bc/adt/functions/groups/zgroup/fmodules/zmodule' : object;
      const submitted = 'FUNCTION ZMODULE\n  EXCEPTIONS INVALID_INPUT = 1.\nENDFUNCTION.';
      let received = '';
      f.backend.save = async (_uri, code) => {
        received = code; f.backend.saves++;
        throw AdtErrorException.create(400, { 'T100KEY-ID': 'EU', 'T100KEY-NO': '271' },
          'ExceptionResourceScanDuringSaveFailure', 'Do not use special characters');
      };
      const result = await f.operations.run('update_source', { connection_id: f.connection.connection_id,
        source_uri: `${uri}/source/main`, source: submitted,
        expected_revision: (await f.backend.read(uri, 'active')).revision, request_id: 'scan-failure' });
      assert.equal(result.error?.code, 'ADT_ERROR');
      assert.equal(result.source_save?.saved, 'unknown');
      assert.equal(result.source_save?.verification, 'not_run');
      assert.equal(result.source_save?.inactive_revision, undefined);
      const details = result.error?.details as { hints?: string[]; sap_message_number?: string };
      assert.equal(details.sap_message_number, '271');
      assert.equal(Boolean(details.hints?.some(h => h.includes('never name = 1'))), module);
      assert.equal(received, submitted); assert.equal(f.backend.unlocks, 1);
    } finally { await f.cleanup(); }
  }
});

test('connections expose system identity without exposing credentials', async () => {
  const f = await fixture(); try {
    const result = await f.operations.run('list_connections', {});
    assert.deepEqual(result.data, [{ connection_id: f.connection.connection_id, name: 'dev',
      base_url: 'http://sap.test:8000', client: '001', language: 'EN', username: 'TEST', write_enabled: true }]);
    assert.equal(JSON.stringify(result.data).includes('fake'), false);
  } finally { await f.cleanup(); }
});

test('object URI saves discover the source under lock and reject ambiguous URIs', async () => {
  const f = await fixture(); try {
    const revision = (await f.backend.read(object, 'active')).revision;
    for (const args of [{}, { object_uri: object, source_uri: '/sap/bc/adt/programs/programs/other/source/main' },
      { object_uri: source }]) {
      const bad = await f.operations.run('update_source', { connection_id: f.connection.connection_id,
        ...args, source: 'REPORT ztest.', expected_revision: revision, request_id: randomUUID() });
      assert.equal(bad.error?.code, 'INVALID_URI'); assert.equal(f.backend.saves, 0);
    }
    const read = f.backend.read.bind(f.backend);
    f.backend.read = async (uri, version) => {
      assert.equal(f.backend.locks > f.backend.unlocks, true);
      return read(uri, version);
    };
    const saved = await f.operations.run('update_source', { connection_id: f.connection.connection_id,
      object_uri: object, source: 'REPORT ztest. WRITE 1.', expected_revision: revision, request_id: 'object-save' });
    assert.equal(saved.status, 'success'); assert.equal(saved.source_save?.source_uri, source);
    assert.equal(f.backend.saves, 1);
  } finally { await f.cleanup(); }
});

test('version conflicts provide observed revisions and safe read guidance without saving', async () => {
  const f = await fixture(); try {
    const active = await f.backend.read(object, 'active');
    f.backend.inactive = 'REPORT ztest. WRITE 2.';
    const draft = await f.backend.read(object, 'inactive');
    const result = await f.operations.run('update_source', { connection_id: f.connection.connection_id,
      object_uri: object, source: 'REPORT ztest. WRITE 3.', expected_revision: active.revision, request_id: 'draft-conflict' });
    assert.equal(result.error?.code, 'VERSION_CONFLICT'); assert.equal(f.backend.saves, 0);
    const details = result.error?.details as any;
    assert.equal(details.active_revision, active.revision); assert.equal(details.inactive_revision, draft.revision);
    assert.equal(details.next_action.arguments.version, 'inactive');
    assert.ok(details.guidance.includes('Do not blindly overwrite'));
    f.backend.inactive = undefined;
    const stale = await f.operations.run('update_source', { connection_id: f.connection.connection_id,
      object_uri: object, source: 'REPORT ztest.', expected_revision: '0'.repeat(64), request_id: 'stale-no-draft' });
    assert.equal(stale.error?.code, 'VERSION_CONFLICT');
    assert.equal((stale.error?.details as any).inactive_revision, undefined);
    assert.equal((stale.error?.details as any).next_action.arguments.version, 'active');
    assert.equal(f.backend.saves, 0);
  } finally { await f.cleanup(); }
});

test('missing inactive source suggests an explicit active read without silently switching versions', async () => {
  const f = await fixture(); try {
    const result = await f.operations.run('read_source', { connection_id: f.connection.connection_id, object_uri: object, version: 'inactive' });
    assert.equal(result.status, 'error'); assert.equal(result.error?.code, 'VERSION_UNAVAILABLE');
    assert.equal(result.data, undefined);
    const details = result.error?.details as any;
    assert.equal(details.requested_version, 'inactive');
    assert.deepEqual(details.next_action, { tool: 'read_source', arguments: { connection_id: f.connection.connection_id, object_uri: object, version: 'active' } });
    assert.ok(details.guidance.includes('No version fallback'));
    const active = await f.operations.run(details.next_action.tool, details.next_action.arguments);
    assert.equal(active.status, 'success'); assert.equal((active.data as any).version, 'active');
    f.backend.read = async () => { throw new AppError('VERSION_UNAVAILABLE', 'No active version'); };
    const unavailableActive = await f.operations.run('read_source', { connection_id: f.connection.connection_id, object_uri: object, version: 'active' });
    assert.equal((unavailableActive.error?.details as any)?.next_action, undefined);
    f.backend.read = async () => { throw new AppError('AUTH_FAILED', 'Login failed'); };
    const auth = await f.operations.run('read_source', { connection_id: f.connection.connection_id, object_uri: object, version: 'inactive' });
    assert.equal(auth.error?.code, 'AUTH_FAILED'); assert.equal((auth.error?.details as any)?.next_action, undefined);
  } finally { await f.cleanup(); }
});

test('creation returns actionable read instructions without inventing a source URI', async () => {
  const f = await fixture(); try {
    const result = await f.operations.run('create_program', { connection_id: f.connection.connection_id,
      name: 'ZTEST', description: 'Test', package_name: '$TMP', request_id: 'create-guide' });
    const data = result.data as any;
    assert.equal(data.source_uri, undefined); assert.equal(data.next_action.tool, 'read_source');
    const read = await f.operations.run(data.next_action.tool, data.next_action.arguments);
    assert.equal(read.status, 'success'); assert.equal((read.data as any).source_uri, source);
  } finally { await f.cleanup(); }
});

test('transport creation is guarded, verified and replayed without creating twice', async () => {
  const f = await fixture(); try {
    let creates = 0; let verification = 0;
    const b: Backend = f.backend;
    b.createTransportRequest = async (uri, pkg, description) => {
      assert.equal(uri, object); assert.equal(pkg, 'ZPACKAGE'); assert.equal(description, 'New development');
      creates++; return 'DEVK900001';
    };
    b.verifyTransportRequest = async number => {
      assert.equal(number, 'DEVK900001'); verification++;
      return { request_number: number, owner: 'TEST', status: 'modifiable',
        tasks: [{ task_number: 'DEVK900002', owner: 'TEST', status: 'modifiable' }], tasks_truncated: false };
    };
    const args = { connection_id: f.connection.connection_id, object_uri: object, package_name: 'ZPACKAGE',
      description: 'New development', request_id: 'new-transport' };
    const result = await f.operations.run('create_transport_request', args);
    assert.equal(result.status, 'success'); assert.equal(result.outcome, 'confirmed');
    assert.equal((result.data as any).request_number, 'DEVK900001');
    assert.equal((result.data as any).tasks[0].task_number, 'DEVK900002');
    assert.equal((result.data as any).released, false); assert.equal(f.backend.saves, 0);
    assert.deepEqual(await f.operations.run('create_transport_request', args), result);
    assert.equal(creates, 1); assert.equal(verification, 1);
    await assert.rejects(f.operations.run('create_transport_request', { ...args, description: 'Changed' }), /already used/);
    const config = await f.store.load(); config.connections[0].write_enabled = false; await f.store.save(config);
    const disabled = await f.operations.run('create_transport_request', { ...args, request_id: 'disabled-transport' });
    assert.equal(disabled.error?.code, 'WRITE_DISABLED'); assert.equal(creates, 1);
  } finally { await f.cleanup(); }
});

test('transport readback failures retain the created number and never auto-recreate', async () => {
  for (const failure of ['not-found', 'read-error', 'unknown-create']) {
    const f = await fixture(); try {
      let creates = 0;
      const b: Backend = f.backend;
      b.createTransportRequest = async () => {
        creates++;
        if (failure === 'unknown-create') throw new AppError('OUTCOME_UNKNOWN', 'Connection interrupted');
        return 'DEVK900001';
      };
      b.verifyTransportRequest = async () => {
        if (failure === 'read-error') throw new Error('Readback failed');
        return undefined;
      };
      const args = { connection_id: f.connection.connection_id, object_uri: object, package_name: 'ZPACKAGE',
        description: 'Test', request_id: 'uncertain-transport' };
      const result = await f.operations.run('create_transport_request', args);
      assert.equal(result.status, 'error');
      assert.equal(result.outcome, failure === 'unknown-create' ? 'unknown' : 'partial');
      if (failure !== 'unknown-create') {
        assert.equal(result.error?.code, 'TRANSPORT_VERIFY_FAILED');
        assert.equal((result.error?.details as any).transport_number, 'DEVK900001');
        assert.equal((result.error?.details as any).created, true);
      }
      await f.operations.run('create_transport_request', args);
      assert.equal(creates, 1); assert.equal(f.backend.saves, 0);
    } finally { await f.cleanup(); }
  }
});

test('local packages, ambiguous CTS checks and unavailable audit logs cannot create transports', async () => {
  const f = await fixture(); try {
    let creates = 0; const b: Backend = f.backend;
    b.createTransportRequest = async () => { creates++; return 'DEVK900001'; };
    b.verifyTransportRequest = async () => undefined;
    const args = { connection_id: f.connection.connection_id, object_uri: object, package_name: '$TMP', description: 'Test' };
    assert.equal((await f.operations.run('create_transport_request', { ...args, request_id: 'tmp-transport' })).error?.code, 'TRANSPORT_NOT_REQUIRED');
    f.backend.transportRequirement = async () => 'not_required';
    assert.equal((await f.operations.run('create_transport_request', { ...args, package_name: 'TEST_LOCAL', request_id: 'local-transport' })).error?.code, 'TRANSPORT_NOT_REQUIRED');
    f.backend.transportRequirement = async () => { throw new AppError('TRANSPORT_CHECK_UNAVAILABLE', 'Unknown CTS state'); };
    assert.equal((await f.operations.run('create_transport_request', { ...args, package_name: 'ZPACKAGE', request_id: 'unknown-transport' })).write_dispatched, false);
    f.backend.transportRequirement = async () => 'required';
    const badLog = join(f.directory, 'blocked-log'); await writeFile(badLog, 'not a directory');
    const ops = new Operations(f.store, credentials, new AuditLog(badLog), () => b);
    try {
      assert.equal((await ops.run('create_transport_request', { ...args, package_name: 'ZPACKAGE', request_id: 'log-transport' })).error?.code, 'LOG_UNAVAILABLE');
    } finally { await ops.close(); }
    assert.equal(creates, 0);
  } finally { await f.cleanup(); }
});

test('SAP stripping the final newline succeeds and returns the actual saved revision', async () => {
  const f = await fixture(); try {
    f.backend.save = async (_uri, code) => { f.backend.saves++; f.backend.inactive = code.replace(/[\r\n]+$/, ''); };
    const result = await f.operations.run('update_source', { connection_id: f.connection.connection_id,
      source_uri: source, source: 'REPORT ztest.\r\n* test\r\n',
      expected_revision: (await f.backend.read(object, 'active')).revision, request_id: 'normalized-save' });
    assert.equal(result.status, 'success'); assert.equal(result.outcome, 'confirmed');
    assert.equal(result.source_save?.saved, true); assert.equal(result.source_save?.verification, 'passed');
    assert.deepEqual(result.data, { ...await f.backend.read(object, 'inactive'), activated: false });
  } finally { await f.cleanup(); }
});

test('save verification still fails for changed program content', async () => {
  const f = await fixture(); try {
    f.backend.save = async () => { f.backend.saves++; f.backend.inactive = 'REPORT ztest. WRITE 99.'; };
    const result = await f.operations.run('update_source', { connection_id: f.connection.connection_id,
      source_uri: source, source: 'REPORT ztest. WRITE 1.\r\n',
      expected_revision: (await f.backend.read(object, 'active')).revision, request_id: 'changed-content' });
    assert.equal(result.error?.code, 'VERIFY_FAILED'); assert.equal(result.outcome, 'partial');
    assert.equal(result.source_save?.saved, true);
    assert.equal(result.source_save?.verification, 'failed');
    assert.equal(result.source_save?.inactive_revision, (await f.backend.read(object, 'inactive')).revision);
    assert.equal(result.source_save?.object_uri, object);
    assert.ok(result.source_save?.next_action?.includes('do not blindly retry'));
    const replay = await f.operations.run('update_source', { connection_id: f.connection.connection_id,
      source_uri: source, source: 'REPORT ztest. WRITE 1.\r\n',
      expected_revision: (await f.backend.read(object, 'active')).revision, request_id: 'changed-content' });
    assert.deepEqual(replay.source_save, result.source_save);
    assert.equal(f.backend.saves, 1);
  } finally { await f.cleanup(); }
});

test('activation verification accepts SAP removing final line breaks', async () => {
  const f = await fixture(); try {
    f.backend.inactive = 'REPORT ztest.\r\n* test\r\n';
    f.backend.activate = async () => {
      f.backend.active = f.backend.inactive!.replace(/[\r\n]+$/, '');
      f.backend.inactive = undefined; return { success: true, messages: [] };
    };
    const result = await f.operations.run('activate_objects', { connection_id: f.connection.connection_id,
      objects: [{ object_uri: object, expected_revision: (await f.backend.read(object, 'inactive')).revision }], request_id: 'normalized-activation' });
    assert.equal(result.status, 'success'); assert.ok(result.completed_steps.includes('activation_verified'));
  } finally { await f.cleanup(); }
});

test('activation releases the editor lock before calling SAP activation', async () => {
  const f = await fixture(); try {
    f.backend.inactive = 'REPORT ztest.\n* activation test';
    const original = f.backend.activate.bind(f.backend);
    f.backend.activate = async () => {
      assert.equal(f.backend.locks, f.backend.unlocks, 'Editor lock must be released before activation');
      return original();
    };
    const result = await f.operations.run('activate_objects', { connection_id: f.connection.connection_id,
      objects: [{ object_uri: object, expected_revision: (await f.backend.read(object, 'inactive')).revision }], request_id: 'unlock-first' });
    assert.equal(result.status, 'success');
    assert.ok(result.completed_steps.indexOf('unlocked') < result.completed_steps.indexOf('activated'));
  } finally { await f.cleanup(); }
});

test('activation stops when lock release fails or the source changes after unlocking', async () => {
  for (const failUnlock of [true, false]) {
    const f = await fixture(); try {
      f.backend.inactive = 'REPORT ztest.\n* original';
      const revision = (await f.backend.read(object, 'inactive')).revision;
      let activations = 0;
      f.backend.activate = async () => { activations++; return { success: true, messages: [] }; };
      f.backend.failUnlock = failUnlock;
      if (!failUnlock) f.backend.unlock = async () => { f.backend.unlocks++; f.backend.inactive += '\n* concurrent edit'; };
      const result = await f.operations.run('activate_objects', { connection_id: f.connection.connection_id,
        objects: [{ object_uri: object, expected_revision: revision }], request_id: 'activation-blocked' });
      assert.equal(result.error?.code, failUnlock ? 'LOCK_CLEANUP_FAILED' : 'VERSION_CONFLICT');
      assert.equal(activations, 0);
    } finally { await f.cleanup(); }
  }
});

test('normalization preserves client and rejects URL credentials/custom paths', () => {
  assert.equal(normalizeUrl('http://sap.test:8000/sap/bc/adt/'), 'http://sap.test:8000');
  assert.equal(normalizeUrl('https://sap.test:443/sap/bc/adt/'), 'https://sap.test');
  for (const url of ['http://user:secret@sap.test', 'https://user:secret@sap.test', 'ftp://sap.test', 'https://sap.test/other', 'http://sap.test/other', 'http://sap.test?q=1'])
    assert.throws(() => normalizeUrl(url));
});
test('ADT paths reject traversal, queries, remote URLs and double encoding', () => {
  assert.equal(adtUri(source), source);
  for (const uri of ['http://evil.test', '/sap/bc/adt/../x', '/sap/bc/adt/%2e%2e/x', '/sap/bc/adt/%252e%252e/x', '/sap/bc/adt/a?x', '/sap/bc/adt/a%5cb'])
    assert.throws(() => adtUri(uri));
});
test('tokens are stored hashed and revocation takes effect', async () => {
  const f = await fixture(); try {
    const { token } = await f.store.createToken();
    assert.equal(await f.store.authenticate(token), true);
    assert.equal(await f.store.authenticate('wrong'), false);
    assert.equal((await readFile(join(f.directory, 'config.json'), 'utf8')).includes(token), false);
    const config = await f.store.load(); config.tokens = []; await f.store.save(config);
    assert.equal(await f.store.authenticate(token), false);
  } finally { await f.cleanup(); }
});
test('obsolete package restrictions are rejected instead of silently ignored', async () => {
  const f = await fixture(); try {
    const config = await f.store.load();
    const legacy = { ...config, connections: [{ ...config.connections[0], allowed_packages: ['$TMP'] }] };
    await writeFile(join(f.directory, 'config.json'), JSON.stringify(legacy));
    await assert.rejects(f.store.load(), /allowed_packages/);
  } finally { await f.cleanup(); }
});
test('concurrent duplicate updates save once, unlock and log no source or handle', async () => {
  const f = await fixture(); try {
    const original = await f.backend.read(object, 'active');
    const args = { connection_id: f.connection.connection_id, source_uri: source, source: 'REPORT ztest.\nWRITE 1.',
      expected_revision: original.revision, request_id: 'one' };
    const [a, b] = await Promise.all([f.operations.run('update_source', args), f.operations.run('update_source', args)]);
    assert.equal(a.operation_id, b.operation_id); assert.equal(b.status, 'success');
    assert.equal((b.data as { source?: string }).source, undefined);
    assert.equal(a.status, 'success'); assert.equal(f.backend.saves, 1); assert.equal(f.backend.unlocks, 1);
    const text = await readFile(join(f.logDirectory, (await readdir(f.logDirectory))[0]), 'utf8');
    assert.ok(text.trim().split('\n').every(line => JSON.parse(line).operation_id));
    assert.equal(text.includes(args.source), false); assert.equal(text.includes('private-lock-handle'), false);
    await assert.rejects(f.operations.run('update_source', { ...args, source: 'different' }), /Request ID/);
  } finally { await f.cleanup(); }
});
test('stale revision and existing inactive draft do not overwrite code', async () => {
  const f = await fixture(); try {
    const revision = (await f.backend.read(object, 'active')).revision;
    f.backend.inactive = 'REPORT ztest. WRITE 99.';
    const result = await f.operations.run('update_source', { connection_id: f.connection.connection_id, source_uri: source,
      expected_revision: revision, source: 'REPORT ztest. WRITE 1.', request_id: 'conflict' });
    assert.equal(result.error?.code, 'VERSION_CONFLICT'); assert.equal(f.backend.saves, 0); assert.equal(f.backend.unlocks, 1);
  } finally { await f.cleanup(); }
});
test('SAP checks allow other local packages and stop required or unknown transport writes', async () => {
  const f = await fixture(); try {
    f.backend.packageOf = async () => 'TEST_LOCAL';
    const checks: string[] = [];
    f.backend.transportRequirement = async () => { checks.push('check'); return 'not_required'; };
    const created = await f.operations.run('create_program', { connection_id: f.connection.connection_id,
      name: 'ZTEST', description: 'Local', package_name: 'TEST_LOCAL', request_id: 'local-create' });
    assert.equal(created.status, 'success');
    const revision = (await f.backend.read(object, 'inactive')).revision;
    const args = { connection_id: f.connection.connection_id, object_uri: object,
      source: 'REPORT ztest. WRITE 1.', expected_revision: revision };
    const saved = await f.operations.run('update_source', { ...args, request_id: 'local-update' });
    assert.equal(saved.status, 'success'); assert.equal(checks.length, 2);
    const saves = f.backend.saves; const locks = f.backend.locks;
    f.backend.transportRequirement = async () => 'required';
    const required = await f.operations.run('update_source', { ...args, request_id: 'required-update' });
    assert.equal(required.error?.code, 'TRANSPORT_REQUIRED');
    f.backend.transportRequirement = async () => { throw new Error('Check failed'); };
    const unknown = await f.operations.run('update_source', { ...args, request_id: 'unknown-update' });
    assert.equal(unknown.error?.code, 'TRANSPORT_CHECK_UNAVAILABLE');
    assert.equal(f.backend.saves, saves); assert.equal(f.backend.locks, locks);
    assert.equal(unknown.write_dispatched, false);
    const explicit = await f.operations.run('update_source', { ...args,
      expected_revision: (await f.backend.read(object, 'inactive')).revision,
      transport_task: 'DEVK900001', request_id: 'explicit-update' });
    assert.equal(explicit.status, 'success');
  } finally { await f.cleanup(); }
});

test('disabled writes fail before locks; SAP-recorded packages require transport tasks', async () => {
  const f = await fixture(); try {
    const config = await f.store.load(); config.connections[0].write_enabled = false; await f.store.save(config);
    let result = await f.operations.run('create_program', { connection_id: f.connection.connection_id, name: 'ZTEST',
      package_name: '$TMP', description: 'Test', request_id: 'disabled' });
    assert.equal(result.error?.code, 'WRITE_DISABLED');
    config.connections[0].write_enabled = true; await f.store.save(config);
    result = await f.operations.run('create_program', { connection_id: f.connection.connection_id,
      name: 'ZTEST', package_name: 'ZOTHER', description: 'Test', request_id: 'no-transport' });
    assert.equal(result.error?.code, 'TRANSPORT_REQUIRED'); assert.equal(f.backend.locks, 0);
    result = await f.operations.run('create_program', { connection_id: f.connection.connection_id,
      name: 'ZTEST', package_name: 'ZOTHER', description: 'Test', transport_task: 'DEVK900001', request_id: 'any-package' });
    assert.equal(result.status, 'success');
  } finally { await f.cleanup(); }
});
test('unlock failure preserves confirmed save and returns warning', async () => {
  const f = await fixture(); try {
    f.backend.failUnlock = true;
    const result = await f.operations.run('update_source', { connection_id: f.connection.connection_id, source_uri: source,
      source: 'REPORT ztest. WRITE 2.', expected_revision: (await f.backend.read(object, 'active')).revision, request_id: 'unlock' });
    assert.equal(result.status, 'success'); assert.equal(result.outcome, 'confirmed');
    assert.ok(result.warnings?.includes('LOCK_CLEANUP_FAILED'));
    await assert.rejects(f.operations.clearCache(), (e: AppError) => e.code === 'SESSION_NEEDS_REVIEW');
    const blocked = await f.operations.run('create_program', { connection_id: f.connection.connection_id,
      name: 'ZOTHER', description: 'Test', package_name: '$TMP', request_id: 'after-unlock-failure' });
    assert.equal(blocked.error?.code, 'SESSION_NEEDS_REVIEW');
  } finally { await f.cleanup(); }
});
test('unknown write results are not retried, and locks are released', async () => {
  const f = await fixture(); try {
    f.backend.uncertain = true;
    const args = { connection_id: f.connection.connection_id, source_uri: source,
      source: 'REPORT ztest. WRITE 3.', expected_revision: (await f.backend.read(object, 'active')).revision, request_id: 'timeout' };
    const a = await f.operations.run('update_source', args); const b = await f.operations.run('update_source', args);
    assert.equal(a.outcome, 'unknown'); assert.equal(a.error?.code, 'OUTCOME_UNKNOWN');
    assert.equal(JSON.stringify(a), JSON.stringify(b));
    assert.equal(f.backend.saves, 1); assert.equal(f.backend.unlocks, 1);
  } finally { await f.cleanup(); }
});
test('failed activation reports partial state and preserves inactive code', async () => {
  const f = await fixture(); try {
    f.backend.inactive = 'REPORT ztest. WRITE 4.'; f.backend.activationPass = false;
    const result = await f.operations.run('activate_objects', { connection_id: f.connection.connection_id, request_id: 'activate',
      objects: [{ object_uri: object, expected_revision: (await f.backend.read(object, 'inactive')).revision }] });
    assert.equal(result.error?.code, 'ACTIVATION_FAILED'); assert.equal(result.outcome, 'partial');
    assert.ok(f.backend.inactive); assert.equal(f.backend.unlocks, 1);
  } finally { await f.cleanup(); }
});
test('log unavailable prevents SAP mutation', async () => {
  const f = await fixture(); try {
    const ops = new Operations(f.store, credentials, { append: async () => { throw new Error('Disk failed'); } } as AuditLog, () => f.backend);
    const result = await ops.run('create_program', { connection_id: f.connection.connection_id, name: 'ZTEST', package_name: '$TMP',
      description: 'Test', request_id: 'no-log' });
    assert.equal(result.error?.code, 'LOG_UNAVAILABLE'); assert.equal(f.backend.inactive, undefined); await ops.close();
  } finally { await f.cleanup(); }
});
test('logging failure after SAP save preserves the known result', async () => {
  const f = await fixture(); try {
    let count = 0;
    const ops = new Operations(f.store, credentials, { append: async () => {
      count++; if (count >= 3) throw new Error('Disk failed after saving');
    } } as AuditLog, () => f.backend);
    const result = await ops.run('update_source', { connection_id: f.connection.connection_id,
      source_uri: source, source: 'REPORT ztest. WRITE 5.', expected_revision: (await f.backend.read(object, 'active')).revision,
      request_id: 'log-after-save' });
    assert.equal(result.status, 'success'); assert.equal(result.outcome, 'confirmed');
    assert.ok(result.warnings?.includes('LOG_WRITE_FAILED')); assert.equal(f.backend.saves, 1); await ops.close();
  } finally { await f.cleanup(); }
});
test('shutdown waits for queued operations and prevents new work', async () => {
  const f = await fixture(); try {
    const pending = f.operations.run('read_source', { connection_id: f.connection.connection_id, object_uri: object });
    const closing = f.operations.close();
    await assert.rejects(f.operations.run('list_connections', {}), /stopping/);
    assert.equal((await pending).status, 'success'); await closing;
  } finally { await f.cleanup(); }
});

test('failed cached read session is recreated once and the read succeeds', async () => {
  const f = await fixture();
  let created = 0;
  const ops = new Operations(f.store, credentials, new AuditLog(f.logDirectory), () => {
    created++;
    const b = new FakeBackend(f.connection.connection_id);
    if (created === 1) {
      let reads = 0;
      const read = b.read.bind(b);
      b.read = async (uri, version) => {
        if (++reads > 1) throw new AppError('ADT_ERROR', 'Stale stateful session');
        return read(uri, version);
      };
    }
    return b;
  });
  try {
    const args = { connection_id: f.connection.connection_id, object_uri: object, version: 'active' as const };
    assert.equal((await ops.run('read_source', args)).status, 'success');
    const recovered = await ops.run('read_source', args);
    assert.equal(recovered.status, 'success'); assert.ok(recovered.completed_steps.includes('session_recreated'));
    assert.equal(created, 2);
  } finally { await ops.close(); await f.cleanup(); }
});

test('writes replace cached sessions and validate the new session before dispatch', async () => {
  const f = await fixture();
  const events: string[] = [];
  let created = 0;
  const ops = new Operations(f.store, credentials, new AuditLog(f.logDirectory), () => {
    const number = ++created;
    const b = new FakeBackend(f.connection.connection_id);
    b.close = async () => { events.push(`close-${number}`); };
    b.capabilities = async () => {
      events.push(`check-${number}`);
      if (number === 1) throw new AppError('AUTH_FAILED', 'Cached session expired');
      return { available: true };
    };
    b.create = async () => { events.push(`create-${number}`); return object; };
    return b;
  });
  try {
    await ops.run('read_source', { connection_id: f.connection.connection_id, object_uri: object });
    const args = { connection_id: f.connection.connection_id, name: 'ZTEST', description: 'Test', package_name: '$TMP', request_id: 'fresh-write' };
    const result = await ops.run('create_program', args);
    assert.equal(result.status, 'success'); assert.equal(result.write_dispatched, true);
    assert.deepEqual(events, ['close-1', 'check-2', 'create-2']);
    assert.ok(result.completed_steps.includes('write_session_ready'));
    assert.deepEqual(await ops.run('create_program', args), result); assert.equal(created, 2);
  } finally { await ops.close(); await f.cleanup(); }
});

test('failed write preflight sends no mutation or lock and its failed session is discarded', async () => {
  const f = await fixture();
  let created = 0;
  const ops = new Operations(f.store, credentials, new AuditLog(f.logDirectory), () => {
    created++;
    if (created === 1) f.backend.capabilities = async () => { throw new AppError('AUTH_FAILED', 'Login failed'); };
    else f.backend.capabilities = async () => ({ available: true });
    return f.backend;
  });
  try {
    const args = { connection_id: f.connection.connection_id, source_uri: source, source: 'REPORT ztest. WRITE 1.',
      expected_revision: (await f.backend.read(object, 'active')).revision, request_id: 'preflight-failed' };
    const result = await ops.run('update_source', args);
    assert.equal(result.error?.code, 'AUTH_FAILED'); assert.equal(result.write_dispatched, false);
    assert.equal(f.backend.saves, 0); assert.equal(f.backend.locks, 0);
    assert.equal((await ops.run('update_source', { ...args, request_id: 'explicit-new-attempt' })).status, 'success');
    assert.equal(created, 2); assert.equal(f.backend.saves, 1);
  } finally { await ops.close(); await f.cleanup(); }
});

test('fresh session read failure and cached write failure are never automatically replayed', async () => {
  const f = await fixture();
  let created = 0;
  const ops = new Operations(f.store, credentials, new AuditLog(f.logDirectory), () => {
    created++; return f.backend;
  });
  try {
    f.backend.read = async () => { throw new AppError('ADT_ERROR', 'Read failed'); };
    assert.equal((await ops.run('read_source', { connection_id: f.connection.connection_id, object_uri: object })).status, 'error');
    assert.equal(created, 1);
    let attempts = 0;
    f.backend.create = async () => { attempts++; throw new AppError('ADT_ERROR', 'Write failed'); };
    const result = await ops.run('create_program', { connection_id: f.connection.connection_id, name: 'ZTEST',
      description: 'Test', package_name: '$TMP', request_id: 'no-write-replay' });
    assert.equal(result.status, 'error'); assert.equal(attempts, 1); assert.equal(created, 2);
  } finally { await ops.close(); await f.cleanup(); }
});
test('Include source uses the same guarded update and activation workflow', async () => {
  const f = await fixture();
  try {
    const uri = '/sap/bc/adt/programs/includes/zinclude';
    const original = await f.backend.read(uri, 'active');
    const updated = await f.operations.run('update_source', { connection_id: f.connection.connection_id,
      source_uri: `${uri}/source/main`, source: '* include change', expected_revision: original.revision, request_id: 'include-save' });
    assert.equal(updated.status, 'success'); assert.equal(f.backend.saves, 1); assert.equal(f.backend.unlocks, 1);
    const saved = await f.backend.read(uri, 'inactive');
    const activated = await f.operations.run('activate_objects', { connection_id: f.connection.connection_id,
      objects: [{ object_uri: uri, expected_revision: saved.revision }], request_id: 'include-activate' });
    assert.equal(activated.status, 'success'); assert.equal(f.backend.active, '* include change');
    assert.equal(f.backend.unlocks, 2);
  } finally { await f.cleanup(); }
});
test('create tool forwards selected program kind and preserves the REPORT default', async () => {
  const f = await fixture(); const kinds: unknown[] = [];
  f.backend.create = async (...args: unknown[]) => { kinds.push(args[4]); return object; };
  try {
    const base = { connection_id: f.connection.connection_id, name: 'ZTEST', description: 'Test', package_name: '$TMP' };
    const defaultResult = await f.operations.run('create_program', { ...base, request_id: 'default-kind' });
    const includeResult = await f.operations.run('create_program', { ...base, program_kind: 'include', request_id: 'include-kind' });
    assert.deepEqual(kinds, ['report', 'include']);
    assert.equal((defaultResult.data as { program_kind: string }).program_kind, 'report');
    assert.equal((includeResult.data as { program_kind: string }).program_kind, 'include');
  } finally { await f.cleanup(); }
});

test('request cache omits large source and rejects new writes at capacity without evicting old IDs', async () => {
  const f = await fixture();
  const ops = new Operations(f.store, credentials, new AuditLog(f.logDirectory), () => f.backend, 1);
  try {
    const args = { connection_id: f.connection.connection_id, source_uri: source,
      source: 'REPORT ztest.\n' + 'x'.repeat(256 * 1024),
      expected_revision: (await f.backend.read(object, 'active')).revision, request_id: 'large' };
    const first = await ops.run('update_source', args);
    assert.equal((first.data as { source: string }).source, args.source);
    const duplicate = await ops.run('update_source', args);
    assert.equal(duplicate.operation_id, first.operation_id);
    assert.equal((duplicate.data as { source?: string }).source, undefined);
    assert.ok(Buffer.byteLength(JSON.stringify(duplicate)) <= 32 * 1024);
    await assert.rejects(ops.run('update_source', { ...args, request_id: 'new' }), /cache is full/);
    assert.equal((await ops.run('update_source', args)).operation_id, first.operation_id);
    assert.equal(f.backend.saves, 1);
  } finally { await ops.close(); await f.cleanup(); }
});

test('authentication counts toward concurrency even for invalid tokens, and releases slots after rejection', async () => {
  const f = await fixture();
  const original = f.store.authenticate.bind(f.store);
  let releaseGate!: () => void;
  const gate = new Promise<void>(resolve => { releaseGate = resolve; });
  let reached!: () => void;
  const occupied = new Promise<void>(resolve => { reached = resolve; });
  let calls = 0;
  f.store.authenticate = async () => { calls++; if (calls === 16) reached(); await gate; return false; };
  const runtime = await startHttp(f.store, f.operations, 0);
  const address = runtime.listener.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/mcp`;
  const options = { method: 'POST', headers: { Authorization: 'Bearer invalid' } };
  const pending = Array.from({ length: 16 }, () => fetch(url, options));
  try {
    await occupied;
    assert.equal((await fetch(url, options)).status, 503);
    assert.equal(calls, 16);
    releaseGate();
    assert.ok((await Promise.all(pending)).every(response => response.status === 401));
    f.store.authenticate = original;
    assert.equal((await fetch(url, options)).status, 401);
  } finally { releaseGate(); await Promise.allSettled(pending); await runtime.close(); await f.cleanup(); }
});

test('real MCP SDK HTTP client initializes, lists tools and reads source; HTTP rejects bad auth/origin', async () => {
  const f = await fixture();
  const token = await f.store.createToken(); const runtime = await startHttp(f.store, f.operations, 0);
  const address = runtime.listener.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/mcp`;
  const client = new Client({ name: 'test-client', version: '1.0' });
  try {
    assert.equal((await fetch(url, { method: 'POST' })).status, 401);
    assert.equal((await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token.token}`, Origin: 'http://evil.test' } })).status, 403);
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token.token}` } } }));
    const expectedVersion = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')).version;
    assert.equal(client.getServerVersion()?.version, expectedVersion);
    const instructions = client.getInstructions()!;
    assert.ok(instructions.includes('untrusted data'));
    assert.ok(instructions.includes('VERSION_CONFLICT'));
    assert.ok(instructions.includes('runtime enablement'));
    const listedTools = (await client.listTools()).tools;
    assert.equal(listedTools.length, 31);
    const queryTableTool = listedTools.find(t => t.name === 'query_table')!;
    assert.ok((queryTableTool.inputSchema.properties?.filters as { description?: string }).description?.includes('AND-combined'));
    assert.ok((queryTableTool.inputSchema.properties?.connection_id as { description?: string }).description?.includes('list_connections'));
    for (const name of ['query_table', 'query_sql', 'search_enhancements']) {
      const tool = listedTools.find(t => t.name === name)!;
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.equal(tool.annotations?.destructiveHint, false);
      assert.ok(!tool.inputSchema.required?.includes('request_id'));
    }
    const createTransport = listedTools.find(t => t.name === 'create_transport_request')!;
    assert.equal(createTransport.annotations?.readOnlyHint, false);
    assert.ok(createTransport.inputSchema.required?.includes('request_id'));
    for (const name of ['create_program', 'create_function_group', 'create_function_module', 'update_source']) {
      const tool = listedTools.find(t => t.name === name)!;
      assert.ok(tool.description?.includes('required on each call when SAP requires change recording'), name);
      assert.ok(tool.description?.includes('NOT remembered or inherited'), name);
      const field = tool.inputSchema.properties?.transport_task as { description?: string };
      assert.ok(field.description?.includes('when SAP requires change recording'), name);
    }
    const result = await client.callTool({ name: 'read_source', arguments: { connection_id: f.connection.connection_id, object_uri: object } });
    assert.equal(result.isError, false); assert.equal((result.structuredContent as { data: { source: string } }).data.source, 'REPORT ztest.');
    const invalid = await client.callTool({ name: 'read_source', arguments: { connection_id: f.connection.connection_id, object_uri: 'http://evil.test' } });
    assert.equal(invalid.isError, true);
    const oversized = await client.callTool({ name: 'list_connections', arguments: { extra: Array(2001).fill(null) } });
    assert.equal(oversized.isError, true);
    assert.ok(JSON.stringify(oversized).includes('maximum of 2000 elements'));
  } finally { await client.close(); await runtime.close(); await f.cleanup(); }
});

test('query tools work with writes disabled and validate through the MCP boundary', async () => {
  const f = await fixture();
  await f.store.save({ schema_version: 1, connections: [{ ...f.connection, write_enabled: false }], tokens: [] });
  const calls: unknown[] = [];
  Object.assign(f.backend, {
    queryTable: async (p: unknown) => { calls.push(p); return { columns: [{ name: 'MATNR' }], rows: [{ MATNR: '000001' }] }; },
    querySql: async (p: unknown) => { calls.push(p); return { rows: [] }; }
  });
  const token = await f.store.createToken(); const runtime = await startHttp(f.store, f.operations, 0);
  const address = runtime.listener.address(); assert.ok(address && typeof address !== 'string');
  const client = new Client({ name: 'query-test', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`),
      { requestInit: { headers: { Authorization: `Bearer ${token.token}` } } }));
    const base = { connection_id: f.connection.connection_id };
    const result = await client.callTool({ name: 'query_table', arguments: { ...base, table_name: 'MARA' } });
    assert.equal(result.isError, false);
    assert.equal((result.structuredContent as { data: { rows: { MATNR: string }[] } }).data.rows[0].MATNR, '000001');
    const sql = await client.callTool({ name: 'query_sql', arguments: { ...base, sql: 'SELECT * FROM mara' } });
    assert.equal(sql.isError, false);
    for (const args of [{ table_name: 'MARA', limit: 501 }, { table_name: 'MARA;DELETE' }, { table_name: 'MARA', extra: true }]) {
      const invalid = await client.callTool({ name: 'query_table', arguments: { ...base, ...args } });
      assert.equal(invalid.isError, true);
    }
    for (const sql of ['DELETE FROM mara', 'SELECT * FROM mara USING ALL CLIENTS', 'SELECT * FROM mara USING CLIENTS IN @clients']) {
      const invalid = await client.callTool({ name: 'query_sql', arguments: { ...base, sql } });
      assert.equal(invalid.isError, true);
    }
    assert.equal(calls.length, 2); assert.equal(f.backend.locks, 0); assert.equal(f.backend.saves, 0);
  } finally { await client.close(); await runtime.close(); await f.cleanup(); }
});

test('query audit records operation IDs and recovery without query values or returned data', async () => {
  const f = await fixture();
  Object.assign(f.backend, {
    queryTable: async () => ({ row_count: 1, rows: [{ MATNR: 'PRIVATE_ROW' }], session_recovery: 'reader_recreated_after_idle_timeout' }),
    querySql: async () => { throw new AppError('DATA_PREVIEW_FAILED', 'failed', {
      http_status: 404, request_path: '/sap/bc/adt/datapreview/freestyle', attempts: 2, reader_recreated: true,
      sap_message: 'PRIVATE_MESSAGE'
    }); }
  });
  try {
    const good = await f.operations.run('query_table', { connection_id: f.connection.connection_id, table_name: 'MARA',
      filters: [{ field: 'MATNR', operator: 'eq', value: 'PRIVATE_FILTER' }] });
    const bad = await f.operations.run('query_sql', { connection_id: f.connection.connection_id,
      sql: "SELECT * FROM mara WHERE matnr = 'PRIVATE_SQL'" });
    assert.equal(good.status, 'success');
    assert.ok(good.completed_steps.includes('query_reader_recreated'));
    assert.equal(bad.status, 'error');
    const log = await readFile(join(f.logDirectory, (await readdir(f.logDirectory))[0]), 'utf8');
    const events = log.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(events[0].operation_id, good.operation_id);
    assert.equal(events[0].event, 'data_query_completed');
    assert.equal(events[0].session_recovery, 'reader_recreated_after_idle_timeout');
    assert.equal(events[1].operation_id, bad.operation_id);
    assert.equal(events[1].event, 'data_query_failed');
    assert.equal(events[1].attempts, 2);
    assert.equal(events[1].http_status, 404);
    assert.equal(log.includes('PRIVATE_'), false);
  } finally { await f.cleanup(); }
});

test('repository tools register as read-only, preserve schema refinements and run with writes disabled', async () => {
  const { makeMcp } = await import('../src/server.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { repositorySchemas } = await import('../src/repository-query.js');
  const f = await fixture();
  await f.store.save({ schema_version: 1, connections: [{ ...f.connection, write_enabled: false }], tokens: [] });
  let dispatched = 0;
  Object.assign(f.backend, { inspectRepository: async (tool: string, args: unknown) => { dispatched++; return { tool, args }; } });
  const server = makeMcp(f.operations);
  const client = new Client({ name: 'repository-test', version: '1' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    for (const name of Object.keys(repositorySchemas)) {
      const tool = tools.find(t => t.name === name)!;
      assert.ok(tool, name); assert.equal(tool.annotations?.readOnlyHint, true);
      assert.equal(tool.annotations?.destructiveHint, false);
    }
    const inputs = {
      get_ddic_definition: { entity_name: 'EKKO', field_name: 'EBELN' },
      get_data_element: { data_element_uri: '/sap/bc/adt/ddic/dataelements/ebeln' },
      get_domain_values: { domain_uri: '/sap/bc/adt/ddic/domains/ebeln' },
      find_references: { object_uri: object },
      find_definition: { object_uri: object, line: 1, column: 8 },
      get_class_structure: { object_uri: '/sap/bc/adt/oo/classes/ztest' },
      get_type_hierarchy: { object_uri: object, line: 1, column: 8 }
    };
    for (const [name, args] of Object.entries(inputs)) {
      const result = await client.callTool({ name, arguments: { ...args, connection_id: f.connection.connection_id } });
      assert.equal(result.isError, false, name);
      const data = (result.structuredContent as any).data;
      assert.equal(data.tool, name);
      assert.equal(data.args.connection_id, undefined, 'backend receives only query parameters');
    }
    const invalid = await client.callTool({ name: 'find_references', arguments: {
      connection_id: f.connection.connection_id, object_uri: object, line: 1
    } });
    assert.equal(invalid.isError, true);
    assert.equal(dispatched, 7, 'invalid coordinates are rejected before dispatch');
    assert.equal(f.backend.locks, 0); assert.equal(f.backend.saves, 0);
    assert.equal((await f.operations.run('get_ddic_definition', {
      connection_id: f.connection.connection_id, entity_name: 'EKKO', limit: 501
    })).status, 'error', 'direct Operations callers also get validation');
  } finally { await client.close(); await server.close(); await f.cleanup(); }
});

test('quality executions require write authorization and confirmation, are audited and never replay unknown runs', async () => {
  const f = await fixture();
  let executions = 0;
  Object.assign(f.backend, { quality: async (tool: string) => {
    if (tool === 'run_unit_tests' || tool === 'run_atc') executions++;
    return { test_status: 'passed', run_id: 'WL_1' };
  } });
  try {
    await f.store.save({ schema_version: 1, connections: [{ ...f.connection, write_enabled: false }], tokens: [] });
    const args = { connection_id: f.connection.connection_id, object_uri: object, request_id: 'test-one', confirm_execution: true as const };
    const blocked = await f.operations.run('run_unit_tests', args);
    assert.equal(blocked.error?.code, 'WRITE_DISABLED'); assert.equal(executions, 0);
    for (const name of ['get_atc_configuration', 'get_atc_results', 'list_source_versions', 'compare_source_versions']) {
      const result = await f.operations.run(name, { connection_id: f.connection.connection_id,
        ...(name === 'get_atc_results' ? { run_id: 'WL_1' } : name === 'get_atc_configuration' ? {} : { object_uri: object }) });
      assert.equal(result.status, 'success', name);
    }
    await f.store.save({ schema_version: 1, connections: [f.connection], tokens: [] });
    const missingConfirm = await f.operations.run('run_unit_tests', { ...args, request_id: 'missing-confirm', confirm_execution: undefined });
    assert.equal(missingConfirm.status, 'error'); assert.equal(executions, 0);
    const actual = await f.operations.run('run_unit_tests', { ...args, request_id: 'authorized' });
    assert.equal(actual.outcome, 'confirmed'); assert.equal(actual.write_dispatched, true); assert.equal(executions, 1);
    assert.equal((await f.operations.run('run_unit_tests', { ...args, request_id: 'authorized' })).operation_id, actual.operation_id);
    assert.equal(executions, 1);
    Object.assign(f.backend, { quality: async () => { executions++; throw new AppError('OUTCOME_UNKNOWN', 'Timed out'); } });
    const failed = await f.operations.run('run_atc', { ...args, request_id: 'unknown-run', check_variant: 'DEFAULT' });
    assert.equal(failed.outcome, 'unknown'); assert.equal(failed.write_dispatched, true);
    await f.operations.run('run_atc', { ...args, request_id: 'unknown-run', check_variant: 'DEFAULT' });
    assert.equal(executions, 2, 'unknown backend execution is not automatically repeated');
    const logs = await readdir(f.logDirectory);
    const text = (await Promise.all(logs.map(name => readFile(join(f.logDirectory, name), 'utf8')))).join('');
    assert.ok(text.includes('quality_execution_started')); assert.ok(text.includes('quality_execution_completed'));
    assert.ok(!text.includes('check_variant')); assert.equal(f.backend.locks, 0); assert.equal(f.backend.saves, 0);
  } finally { await f.cleanup(); }
});

test('quality tools advertise actual execution policy and reject missing confirmation through MCP', async () => {
  const { makeMcp } = await import('../src/server.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const f = await fixture();
  let dispatched = 0;
  Object.assign(f.backend, { quality: async () => { dispatched++; return { test_status: 'no_tests' }; } });
  const server = makeMcp(f.operations); const client = new Client({ name: 'quality-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a); await client.connect(b);
    const tools = (await client.listTools()).tools;
    for (const name of ['run_atc', 'run_unit_tests']) {
      const tool = tools.find(t => t.name === name)!;
      assert.equal(tool.annotations?.readOnlyHint, false); assert.equal(tool.annotations?.idempotentHint, false);
      assert.ok(tool.inputSchema.required?.includes('request_id')); assert.ok(tool.inputSchema.required?.includes('confirm_execution'));
    }
    for (const name of ['get_atc_configuration', 'get_atc_results', 'list_source_versions', 'compare_source_versions'])
      assert.equal(tools.find(t => t.name === name)?.annotations?.readOnlyHint, true);
    const invalid = await client.callTool({ name: 'run_unit_tests', arguments: { connection_id: f.connection.connection_id, object_uri: object, request_id: 'one' } });
    assert.equal(invalid.isError, true); assert.equal(dispatched, 0);
    const result = await client.callTool({ name: 'run_unit_tests', arguments: { connection_id: f.connection.connection_id, object_uri: object, request_id: 'two', confirm_execution: true } });
    assert.equal(result.isError, false); assert.equal(dispatched, 1);
    assert.equal((result.structuredContent as any).data.test_status, 'no_tests');
  } finally { await client.close(); await server.close(); await f.cleanup(); }
});


test('transport preflight failure leaves source save undispatched and records diagnostics', async () => {
  const f = await fixture();
  Object.assign(f.backend, { saveDispatchTracking: true,
    save: async () => { throw new AppError('BACKEND_RESPONSE_TOO_LARGE', 'bounded', {
      request_path: '/sap/bc/adt/cts/transportrequests', error_kind: 'response_size_limit', elapsed_ms: 42,
      network_code: 'ERR_BAD_RESPONSE', raw: 'PRIVATE_SOURCE', sap_message: 'PRIVATE_MESSAGE'
    }); }
  });
  try {
    const current = await f.backend.read(object, 'active');
    const result = await f.operations.run('update_source', { connection_id: f.connection.connection_id,
      object_uri: object, expected_revision: current.revision, source: 'REPORT ztest.\nWRITE 1.', request_id: randomUUID() });
    assert.equal(result.status, 'error'); assert.equal(result.write_dispatched, false);
    assert.equal(result.outcome, 'confirmed'); assert.equal(result.source_save?.saved, false);
    assert.equal(f.backend.unlocks, 1);
    const log = (await Promise.all((await readdir(f.logDirectory)).map(file => readFile(join(f.logDirectory, file), 'utf8')))).join('');
    const event = log.trim().split('\n').map(line => JSON.parse(line)).find(e => e.event === 'failed');
    assert.equal(event.tool, 'update_source'); assert.equal(event.network_code, 'ERR_BAD_RESPONSE');
    assert.equal(event.elapsed_ms, 42); assert.equal(event.write_dispatched, false);
    assert.equal(log.includes('PRIVATE_'), false);
  } finally { await f.cleanup(); }
});

test('read failures are audited with the operation ID', async () => {
  const f = await fixture();
  try {
    const result = await f.operations.run('read_source', { connection_id: f.connection.connection_id, object_uri: object, version: 'inactive' });
    const log = await readFile(join(f.logDirectory, (await readdir(f.logDirectory))[0]), 'utf8');
    const event = JSON.parse(log.trim());
    assert.equal(event.operation_id, result.operation_id); assert.equal(event.tool, 'read_source');
    assert.equal(event.error_code, 'VERSION_UNAVAILABLE');
  } finally { await f.cleanup(); }
});


test('save HTTP diagnostics are correlated and sanitized on success and unknown outcome', async () => {
  for (const uncertain of [false, true]) {
    const f = await fixture();
    try {
      f.backend.uncertain = uncertain;
      (f.backend as Backend).takeSaveDiagnostics = () => [{ request_path: source, request_method: 'PUT',
        request_body_bytes: 123, request_content_length: 123, request_charset: 'utf-8', http_version: '1.1',
        request_chunked: false, request_finished: true, response_started: !uncertain, elapsed_ms: 12,
        transport: 'axios_node_http', ...(uncertain ? { network_code: 'ECONNRESET' } : { http_status: 204 }),
        authorization: 'PRIVATE_TOKEN', body: 'PRIVATE_SOURCE' } as any];
      const active = await f.backend.read(object, 'active');
      const result = await f.operations.run('update_source', { connection_id: f.connection.connection_id,
        object_uri: object, expected_revision: active.revision, source: 'REPORT ztest.\n* test', request_id: randomUUID() });
      assert.equal(result.status, uncertain ? 'error' : 'success');
      const text = await readFile(join(f.logDirectory, (await readdir(f.logDirectory))[0]), 'utf8');
      const rows = text.trim().split('\n').map(line => JSON.parse(line));
      const diagnostic = rows.find(row => row.event === 'source_save_http_completed');
      assert.equal(diagnostic.operation_id, result.operation_id);
      assert.equal(diagnostic.connection_id, f.connection.connection_id);
      assert.equal(diagnostic.request_content_length, 123); assert.equal(diagnostic.request_charset, 'utf-8');
      assert.equal(diagnostic.http_version, '1.1'); assert.equal(diagnostic.request_chunked, false);
      assert.equal(text.includes('PRIVATE_'), false);
      assert.equal(f.backend.unlocks, 1);
    } finally { await f.cleanup(); }
  }
});
