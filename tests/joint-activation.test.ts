import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConfigStore, connectionSchema } from '../src/config.js';
import { AuditLog } from '../src/audit.js';
import { Operations } from '../src/operations.js';
import { AppError } from '../src/errors.js';
import { sourceResult, type Backend, type ActivationTarget } from '../src/adt.js';

const a = '/sap/bc/adt/programs/programs/za', b = '/sap/bc/adt/programs/programs/zb';
async function fixture() {
  const root = join(process.cwd(), '.saplink/tests'); await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'joint-activation-'));
  const store = new ConfigStore(directory), id = randomUUID();
  await store.save({ schema_version: 1, connections: [connectionSchema.parse({ connection_id: id, name: 'mock', base_url: 'http://mock.test',
    client: '001', username: 'TEST', language: 'EN', write_enabled: true })], tokens: [] });
  const active = new Map([[a, 'old a'], [b, 'old b']]);
  // The fake backend only allows these mutually dependent definitions to activate together.
  const inactive = new Map([[a, 'new a uses new b'], [b, 'new b uses new a']]);
  const locks = new Set<string>(), verified: string[] = [];
  let calls = 0;
  const backend = {
    capabilities: async () => ({}), close: async () => {}, packageOf: async () => '$TMP',
    lock: async (uri: string) => { locks.add(uri); return 'handle'; },
    unlock: async (uri: string) => { locks.delete(uri); },
    read: async (uri: string, version: 'active' | 'inactive') => {
      if (version === 'active') verified.push(uri);
      const code = (version === 'active' ? active : inactive).get(uri);
      if (code === undefined) throw new AppError('VERSION_UNAVAILABLE', 'Version unavailable');
      return sourceResult(id, uri, `${uri}/source/main`, code, version);
    },
    activateBatch: async (objects: ActivationTarget[], dispatch?: () => void | Promise<void>) => {
      assert.equal(locks.size, 0); await dispatch?.(); calls++;
      assert.deepEqual(objects.map(object => object.object_uri), [a, b]);
      for (const [uri, code] of inactive) active.set(uri, code);
      inactive.clear(); return { success: true, messages: [] };
    }
  } as unknown as Backend;
  const ops = new Operations(store, { get: async () => 'fake', set: async () => {}, remove: async () => {} }, new AuditLog(join(directory, 'logs')), () => backend);
  const input = { connection_id: id, request_id: 'joint', objects: [a, b].map(uri => ({ object_uri: uri,
    expected_revision: sourceResult(id, uri, `${uri}/source/main`, inactive.get(uri)!, 'inactive').revision })) };
  return { ops, backend, active, inactive, verified, input, calls: () => calls,
    cleanup: async () => { await ops.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('joint activation verifies the full set and replays request IDs without reactivation', async () => {
  const f = await fixture(); try {
    const result = await f.ops.run('activate_objects', f.input);
    assert.equal(result.status, 'success'); assert.equal(result.write_dispatched, true); assert.equal(f.calls(), 1);
    assert.deepEqual(f.verified, [a, b]); assert.equal((result.data as any).mode, 'joint');
    assert.deepEqual(await f.ops.run('activate_objects', f.input), result); assert.equal(f.calls(), 1);
  } finally { await f.cleanup(); }
});

test('a stale later object prevents activation of every object', async () => {
  const f = await fixture(); try {
    f.inactive.set(b, 'concurrent b edit');
    const result = await f.ops.run('activate_objects', f.input);
    assert.equal(result.error?.code, 'VERSION_CONFLICT'); assert.equal(result.write_dispatched, false);
    assert.equal(f.calls(), 0); assert.equal(f.active.get(a), 'old a');
  } finally { await f.cleanup(); }
});

test('an earlier object changed while a later lock is held is caught by final set validation', async () => {
  const f = await fixture(); try {
    const unlock = f.backend.unlock.bind(f.backend);
    f.backend.unlock = async (uri, handle) => { await unlock(uri, handle); if (uri === b) f.inactive.set(a, 'concurrent a edit'); };
    const result = await f.ops.run('activate_objects', f.input);
    assert.equal(result.error?.code, 'VERSION_CONFLICT'); assert.equal(f.calls(), 0); assert.equal(result.write_dispatched, false);
  } finally { await f.cleanup(); }
});

test('partial activation checks all objects and reports which draft remains', async () => {
  const f = await fixture(); let calls = 0; try {
    f.backend.activateBatch = async (_objects, dispatch) => {
      calls++; await dispatch?.(); f.active.set(a, f.inactive.get(a)!); f.inactive.delete(a);
      return { success: false, messages: [{ type: 'E', shortText: 'B failed' }] };
    };
    const result = await f.ops.run('activate_objects', f.input);
    assert.equal(result.error?.code, 'ACTIVATION_FAILED'); assert.equal(result.outcome, 'partial');
    const results = (result.error?.details as any).results;
    assert.deepEqual(results.map((item: any) => item.verification), ['passed', 'not_activated']);
    assert.deepEqual(f.verified, [a, b]); assert.equal(calls, 1);
  } finally { await f.cleanup(); }
});

test('version checks run after backend preparation and before the first activation dispatch', async () => {
  const f = await fixture(); let sent = false; try {
    f.backend.activateBatch = async (_objects, dispatch) => {
      f.inactive.set(b, 'changed during metadata preparation');
      await dispatch?.(); sent = true;
      return { success: true, messages: [] };
    };
    const result = await f.ops.run('activate_objects', f.input);
    assert.equal(result.error?.code, 'VERSION_CONFLICT'); assert.equal(result.write_dispatched, false); assert.equal(sent, false);
  } finally { await f.cleanup(); }
});

test('unknown network outcome still inspects all sources and never replays automatically', async () => {
  const f = await fixture(); let calls = 0; try {
    f.backend.activateBatch = async (_objects, dispatch) => {
      calls++; await dispatch?.(); f.active.set(a, f.inactive.get(a)!); f.inactive.delete(a);
      throw new AppError('OUTCOME_UNKNOWN', 'Response lost');
    };
    const result = await f.ops.run('activate_objects', f.input);
    assert.equal(result.error?.code, 'OUTCOME_UNKNOWN'); assert.equal(result.outcome, 'unknown');
    assert.deepEqual((result.error?.details as any).results.map((item: any) => item.verification), ['passed', 'not_activated']);
    assert.deepEqual(f.verified, [a, b]); assert.equal(calls, 1);
    await f.ops.run('activate_objects', f.input); assert.equal(calls, 1);
  } finally { await f.cleanup(); }
});

test('verification failure on one object does not prevent inspecting later objects', async () => {
  const f = await fixture(); try {
    const read = f.backend.read.bind(f.backend);
    f.backend.read = async (uri, version) => {
      if (uri === a && version === 'active') throw new AppError('OUTCOME_UNKNOWN', 'Read failed');
      return read(uri, version);
    };
    const result = await f.ops.run('activate_objects', f.input);
    assert.equal(result.error?.code, 'VERIFY_FAILED'); assert.equal(result.outcome, 'partial');
    assert.deepEqual((result.error?.details as any).results.map((item: any) => item.verification), ['unknown', 'passed']);
    assert.ok(f.verified.includes(b));
  } finally { await f.cleanup(); }
});

test('duplicates and missing batch capability never fall back to sequential activation', async () => {
  const f = await fixture(); try {
    const duplicate = await f.ops.run('activate_objects', { ...f.input, objects: [f.input.objects[0], { ...f.input.objects[0], object_uri: `${a}/source/main` }] });
    assert.equal(duplicate.error?.code, 'INVALID_INPUT'); assert.equal(duplicate.write_dispatched, false);
    (f.backend as any).activateBatch = undefined;
    const missing = await f.ops.run('activate_objects', { ...f.input, request_id: 'missing' });
    assert.equal(missing.error?.code, 'CAPABILITY_UNSUPPORTED'); assert.equal(f.calls(), 0);
  } finally { await f.cleanup(); }
});
