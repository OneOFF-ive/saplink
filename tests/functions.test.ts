import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { AdtBackend, functionGroupUri, programUri, sameSavedSource, savedSourceHash, definitionCommentsHash, sourceResult, type Backend, type GroupSnapshot } from '../src/adt.js';
import { ConfigStore, connectionSchema, digest } from '../src/config.js';
import { Operations } from '../src/operations.js';
import { AuditLog } from '../src/audit.js';

const group = '/sap/bc/adt/functions/groups/zgroup';
const moduleUri = `${group}/fmodules/zmodule`;
const includeUri = `${group}/includes/lzgrouptop`;
test('function source verification tolerates SAP interface separator lines without hiding code changes', () => {
  const source = "FUNCTION zmodule\n IMPORTING VALUE(iv) TYPE string DEFAULT 'a. b'.\n  WRITE iv.\nENDFUNCTION.";
  const formatted = source.replace("b'.\n", "b'.\n\n\n").replace(/\n/g, '\r\n');
  assert.equal(sameSavedSource(source, formatted, moduleUri), true);
  assert.equal(savedSourceHash(source, moduleUri), savedSourceHash(formatted, moduleUri));
  assert.equal(sameSavedSource(source, formatted), true);
  assert.equal(sameSavedSource(source, formatted.replace('WRITE iv.', 'WRITE 1.'), moduleUri), false);
  assert.equal(sameSavedSource(source, formatted.replace('TYPE string', 'TYPE matnr'), moduleUri), false);
  assert.equal(sameSavedSource(source, formatted.replace('WRITE iv.', 'WRITE iv.\r\n\r\n'), moduleUri), true);
  assert.equal(sameSavedSource(source, formatted.replace('a. b', 'a.  b'), moduleUri), false);
  const commented = 'FUNCTION zmodule\n " comment.\n.\n  WRITE 1.\nENDFUNCTION.';
  assert.equal(sameSavedSource(commented, commented.replace('\n.\n', '\n.\n\n\n'), moduleUri), true);
});
test('function URI parsing accepts groups and members but rejects other nested endpoints', () => {
  for (const uri of [group, moduleUri, includeUri]) { assert.equal(programUri(`${uri}/source/main`), uri); assert.equal(functionGroupUri(uri), group); }
  assert.throws(() => programUri(`${group}/fmodules/zmodule/parameters`));
  assert.throws(() => functionGroupUri('/sap/bc/adt/programs/programs/ztest'));
});

test('group Include saving uses its resource lock, not the parent group handle', async () => {
  const backend = new AdtBackend(connectionSchema.parse({ connection_id: randomUUID(), name: 'mock', base_url: 'http://mock.test',
    client: '001', username: 'TEST', language: 'EN', write_enabled: true }), 'fake');
  const held = new Map<string, string>();
  let saved = false;
  (backend as any).client = {
    lock: async (uri: string) => { const handle = `handle-${uri}`; held.set(uri, handle); return { LOCK_HANDLE: handle }; },
    unLock: async (uri: string, handle: string) => { assert.equal(held.get(uri), handle); held.delete(uri); },
    setObjectSource: async (source: string, _code: string, handle: string) => {
      assert.equal(held.get(programUri(source)), handle, 'SAP requires the same resource to be locked and saved'); saved = true;
    }
  };
  const groupHandle = await backend.lock(group);
  const includeHandle = await backend.lock(`${includeUri}/source/main`);
  assert.notEqual(includeHandle, groupHandle);
  assert.equal(held.size, 2);
  await backend.save(`${includeUri}/source/main`, 'TYPES ty_test TYPE i.', includeHandle);
  await backend.unlock(includeUri, includeHandle);
  assert.equal(saved, true); assert.equal(held.size, 1); assert.ok(held.has(group));
  await backend.unlock(group, groupHandle); assert.equal(held.size, 0);
});

test('function interface save normalization and group activation verification work together', async () => {
  const root = join(process.cwd(), '.saplink/tests'); await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'function-format-'));
  const store = new ConfigStore(directory);
  const c = connectionSchema.parse({ connection_id: randomUUID(), name: 'mock', base_url: 'http://mock.test', client: '001', username: 'TEST', language: 'EN', write_enabled: true });
  await store.save({ schema_version: 1, connections: [c], tokens: [] });
  let active = 'FUNCTION zmodule.\nENDFUNCTION.';
  let inactive: string | undefined;
  let locked = false;
  const snapshot = (): GroupSnapshot => ({ object_uri: group, name: 'ZGROUP', revision: digest(inactive ?? active),
    members: [{ object_uri: moduleUri, version: inactive ? 'inactive' : 'active', revision: 'a'.repeat(64), hash: savedSourceHash(inactive ?? active, moduleUri),
      definition_comments_hash: definitionCommentsHash(inactive ?? active, moduleUri) }] });
  const backend = { capabilities: async () => ({}), close: async () => {}, packageOf: async () => '$TMP',
    lock: async () => { locked = true; return 'h'; }, unlock: async () => { locked = false; },
    read: async (uri: string, version: 'active' | 'inactive') => {
      if (version === 'inactive' && inactive === undefined) throw new (await import('../src/errors.js')).AppError('VERSION_UNAVAILABLE', 'No draft');
      return sourceResult(c.connection_id, uri, `${uri}/source/main`, version === 'active' ? active : inactive!, version);
    },
    save: async (_uri: string, source: string) => {
      assert.equal(locked, true);
      inactive = source.replace('OPTIONAL.\n', 'OPTIONAL.\n\n\n')
        .replace('IMPORTING VALUE(iv)', 'importing   VALUE ( IV )').replace(' " definition comment\n', '');
    },
    functionGroupSnapshot: async () => snapshot(),
    activateBatch: async (objects: { object_uri: string; snapshot?: GroupSnapshot }[], onDispatch?: () => void | Promise<void>) => {
      assert.equal(locked, false); assert.equal(objects.length, 1); assert.equal(objects[0].object_uri, group); assert.deepEqual(objects[0].snapshot, snapshot());
      await onDispatch?.();
      active = inactive!.replace('OPTIONAL.\n\n\n', 'OPTIONAL.\n\n').replace(' " activation comment\n', ''); inactive = undefined;
      return { success: true, messages: [] };
    }
  } as Backend;
  const ops = new Operations(store, { get: async () => 'fake', set: async () => {}, remove: async () => {} }, new AuditLog(join(directory, 'logs')), () => backend);
  try {
    const source = 'FUNCTION zmodule\n " definition comment\n IMPORTING VALUE(iv) TYPE matnr OPTIONAL.\n WRITE iv.\nENDFUNCTION.';
    const original = await backend.read(moduleUri, 'active');
    const saved = await ops.run('update_source', { connection_id: c.connection_id, source_uri: original.source_uri,
      source, expected_revision: original.revision, request_id: 'normalized-function' });
    assert.equal(saved.status, 'success');
    assert.equal(saved.source_save?.normalization_applied, true);
    assert.ok(saved.warnings?.includes('FUNCTION_DEFINITION_COMMENTS_CHANGED'));
    assert.notEqual(inactive, source); assert.deepEqual(saved.data, { ...await backend.read(moduleUri, 'inactive'), activated: false });
    inactive = inactive!.replace('FUNCTION zmodule\n', 'FUNCTION zmodule\n " activation comment\n');
    const result = await ops.run('activate_objects', { connection_id: c.connection_id,
      objects: [{ object_uri: group, expected_revision: snapshot().revision }], request_id: 'activate-normalized-group' });
    assert.equal(result.status, 'success'); assert.ok(result.completed_steps.includes('activation_verified'));
    assert.ok(result.warnings?.includes('FUNCTION_DEFINITION_COMMENTS_CHANGED'));
    assert.equal(sameSavedSource(active, source, moduleUri), true);
  } finally { await ops.close(); await rm(directory, { recursive: true, force: true }); }
});
test('function ADT adapter creates groups/modules and edits module source with its own lock', async () => {
  const events: string[] = []; const created: Record<string, unknown>[] = [];
  const activationBodies: string[] = [];
  const moduleCorrections: (string | null)[] = [];
  let rejectContainer = false;
  let active = 'FUNCTION zmodule.\nENDFUNCTION.'; let inactive = active;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://local'); let body = ''; for await (const chunk of req) body += chunk;
    res.setHeader('Content-Type', 'application/xml');
    const action = url.searchParams.get('_action');
    if (url.pathname.endsWith('/compatibility/graph')) { res.setHeader('x-csrf-token', 'csrf'); res.end('<graph/>'); }
    else if (url.pathname.endsWith('/validation')) res.end('<asx:abap xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA><SEVERITY>SUCCESS</SEVERITY><CHECK_RESULT>X</CHECK_RESULT></DATA></asx:values></asx:abap>');
    else if (req.method === 'POST' && ['/sap/bc/adt/functions/groups', `${group}/fmodules`].includes(url.pathname)) {
      if (url.pathname === `${group}/fmodules`) {
        moduleCorrections.push(url.searchParams.get('corrNr'));
        if (url.searchParams.get('corrNr') === 'DEVK904717') {
          res.statusCode = 403; res.end('UXX include is already locked in parent request'); return;
        }
      }
      created.push(new XMLParser({ ignoreAttributes: false }).parse(body)); events.push(`create:${url.pathname}`); res.statusCode = 201; res.end();
    } else if (url.pathname === '/sap/bc/adt/cts/transportrequests') {
      assert.equal(req.headers.accept, 'application/vnd.sap.adt.transportorganizertree.v1+xml');
      res.end('<tm:root xmlns:tm="test"><tm:workbench><tm:target tm:name="DEV"><tm:modifiable><tm:request tm:number="DEVK904716" tm:owner="TEST" tm:status="D"><tm:task tm:number="DEVK904717" tm:owner="TEST" tm:status="D"/></tm:request></tm:modifiable></tm:target></tm:workbench></tm:root>');
    } else if (action) {
      events.push(`${action}:${url.pathname}`);
      if (![group, moduleUri].includes(url.pathname)) { res.statusCode = 400; res.end('Unexpected lock target'); return; }
      res.end(action === 'LOCK' ? `<asx:abap xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA><LOCK_HANDLE>${url.pathname === moduleUri ? 'module-lock' : 'group-lock'}</LOCK_HANDLE></DATA></asx:values></asx:abap>` : '');
    } else if (url.pathname.endsWith('/nodepath')) res.end('<projectexplorer:nodepath xmlns:projectexplorer="test" xmlns:adtcore="http://www.sap.com/adt/core"><projectexplorer:objectLinkReferences><objectLinkReference adtcore:type="DEVC/K" adtcore:name="$TMP"/></projectexplorer:objectLinkReferences></projectexplorer:nodepath>');
    else if (url.pathname.endsWith('/nodestructure')) res.end(`<asx:abap xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA><TREE_CONTENT>
      <SEU_ADT_REPOSITORY_OBJ_NODE><OBJECT_TYPE>FUGR/F</OBJECT_TYPE><OBJECT_NAME/><OBJECT_URI/></SEU_ADT_REPOSITORY_OBJ_NODE>
      <SEU_ADT_REPOSITORY_OBJ_NODE><OBJECT_TYPE>FUGR/FF</OBJECT_TYPE><OBJECT_NAME>ZMODULE</OBJECT_NAME><OBJECT_URI>${moduleUri}</OBJECT_URI></SEU_ADT_REPOSITORY_OBJ_NODE>
      <SEU_ADT_REPOSITORY_OBJ_NODE><OBJECT_TYPE>FUGR/I</OBJECT_TYPE><OBJECT_NAME>LZGROUPTOP</OBJECT_NAME><OBJECT_URI>${includeUri}</OBJECT_URI></SEU_ADT_REPOSITORY_OBJ_NODE>
      </TREE_CONTENT></DATA></asx:values></asx:abap>`);
    else if ([group, moduleUri, includeUri].includes(url.pathname)) {
      const type = url.pathname === group ? 'FUGR/F' : url.pathname === moduleUri ? 'FUGR/FF' : 'FUGR/I';
      res.end(`<group:object xmlns:group="test" xmlns:adtcore="http://www.sap.com/adt/core" xmlns:abapsource="http://www.sap.com/adt/abapsource" adtcore:name="${type === 'FUGR/F' ? 'ZGROUP' : type === 'FUGR/FF' ? 'ZMODULE' : 'LZGROUPTOP'}" adtcore:type="${type}" adtcore:version="${url.searchParams.get('version') ?? 'active'}" adtcore:changedAt="2026-10-14T00:00:00Z" ${type === 'FUGR/F' ? '' : 'abapsource:sourceUri="source/main"'}/>`);
    } else if (url.pathname.endsWith('/source/main')) {
      if (req.method === 'PUT') { assert.equal(url.searchParams.get('lockHandle'), 'module-lock'); inactive = body; events.push('saved'); res.statusCode = 204; res.end(); }
      else { res.setHeader('Content-Type', 'text/plain'); res.end(url.pathname.startsWith(includeUri) ? '* top include' : url.searchParams.get('version') === 'inactive' ? inactive : active); }
    } else if (url.pathname.endsWith('/activation')) {
      activationBodies.push(body);
      if (body.includes('adtcore:parentUri=') || body.includes('adtcore:type=')) {
        res.statusCode = 400; res.end('Condition check failed'); return;
      }
      if (rejectContainer && body.includes(`adtcore:uri="${group}"`)) {
        res.statusCode = 400; res.end('Container activation failed'); return;
      }
      // The group reference alone does not promote a function module's inactive source.
      if (body.includes(`adtcore:uri="${moduleUri}"`)) active = inactive;
      events.push('activated'); res.statusCode = 204; res.end();
    }
    else res.end('');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const backend = new AdtBackend(connectionSchema.parse({ connection_id: randomUUID(), name: 'mock', base_url: `http://127.0.0.1:${address.port}`, username: 'TEST', client: '001', language: 'EN' }), 'fake');
  try {
    assert.equal(await backend.createFunctionGroup('ZGROUP', 'A & B', '$TMP'), group);
    assert.equal(await backend.packageOf(group), '$TMP');
    const handle = await backend.lock(group);
    assert.equal(await backend.createFunctionModule('ZMODULE', 'Module', group), moduleUri); await backend.unlock(group, handle);
    const groupXml = created[0]['group:abapFunctionGroup'] as Record<string, unknown>;
    const moduleXml = created[1]['fmodule:abapFunctionModule'] as Record<string, unknown>;
    assert.equal(groupXml['@_adtcore:type'], 'FUGR/F'); assert.equal(groupXml['@_adtcore:description'], 'A & B');
    assert.equal((moduleXml['adtcore:containerRef'] as Record<string, unknown>)['@_adtcore:uri'], group);
    const transportHandle = await backend.lock(group);
    try {
      assert.equal(await backend.createFunctionModule('ZMODULE', 'Transport module', group, 'DEVK904717'), moduleUri);
      assert.deepEqual(moduleCorrections, [null, 'DEVK904716']);
      for (const invalid of ['DEVK904716', 'DEVK999999']) {
        await assert.rejects(backend.createFunctionModule('ZMODULE', 'Invalid transport', group, invalid),
          (error: any) => error.code === 'TRANSPORT_TASK_INVALID');
      }
      assert.equal(moduleCorrections.length, 2);
    } finally { await backend.unlock(group, transportHandle); }
    const members = await backend.listFunctionGroupMembers(group, 10); assert.equal(members.members.length, 2); assert.equal(members.truncated, false);
    assert.equal((await backend.listFunctionGroupMembers(group, 1)).truncated, true);
    const before = await backend.functionGroupSnapshot(group); assert.equal(before.members.length, 2);
    const editHandle = await backend.lock(moduleUri);
    await backend.save(`${moduleUri}/source/main`, 'FUNCTION zmodule.\nWRITE 1.\nENDFUNCTION.', editHandle);
    await backend.unlock(moduleUri, editHandle);
    assert.notEqual((await backend.functionGroupSnapshot(group)).revision, before.revision);
    assert.equal((await backend.read(moduleUri, 'inactive')).source, inactive);
    await assert.rejects(backend.activate(group), /snapshot/);
    assert.equal((await backend.activate(group, await backend.functionGroupSnapshot(group))).success, true);
    assert.equal(activationBodies.length, 1);
    const refs = new XMLParser({ ignoreAttributes: false }).parse(activationBodies[0])['adtcore:objectReferences']['adtcore:objectReference'];
    assert.deepEqual(refs.map((r: Record<string, string>) => r['@_adtcore:uri']), [moduleUri, includeUri, group]);
    for (const ref of refs) {
      assert.equal(ref['@_adtcore:parentUri'], undefined); assert.equal(ref['@_adtcore:type'], undefined);
    }
    assert.equal((await backend.read(moduleUri, 'active')).source, inactive);
    rejectContainer = true;
    const snapshot = await backend.functionGroupSnapshot(group);
    await assert.rejects(backend.activate(group, snapshot), error => {
      assert.ok(error);
      return true;
    });
    const calls = activationBodies.length;
    await assert.rejects(backend.activate(group, { ...snapshot, members: [{ ...snapshot.members[0], object_uri: '/sap/bc/adt/functions/groups/other/fmodules/zbad' }] }), /another group/);
    assert.equal(activationBodies.length, calls);
    assert.equal((await backend.activate(moduleUri)).success, true);
    assert.equal((await backend.read(moduleUri, 'active')).source, inactive);
    assert.ok(events.includes(`LOCK:${group}`)); assert.ok(events.includes(`LOCK:${moduleUri}`));
  } finally { await backend.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('function tools enforce transport and write controls, and group activation rejects stale snapshots', async () => {
  const root = join(process.cwd(), '.saplink/tests'); await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'functions-')); const store = new ConfigStore(directory);
  const connection = connectionSchema.parse({ connection_id: randomUUID(), name: 'mock', base_url: 'http://mock.test', client: '001', username: 'TEST', language: 'EN', write_enabled: true });
  await store.save({ schema_version: 1, connections: [connection], tokens: [] });
  let revision = 'a'.repeat(64); let activated = 0; let locked = false; let created = 0;
  const snapshot = (): GroupSnapshot => ({ object_uri: group, name: 'ZGROUP', revision,
    members: [{ object_uri: moduleUri, version: 'inactive', revision: 'c'.repeat(64), hash: digest('') }] });
  const backend = { capabilities: async () => ({}), close: async () => {}, packageOf: async () => '$TMP',
    lock: async () => { locked = true; return 'h'; }, unlock: async () => { locked = false; },
    createFunctionGroup: async () => { created++; return group; }, createFunctionModule: async () => { assert.equal(locked, true); created++; return moduleUri; },
    listFunctionGroupMembers: async () => ({ members: [] }), functionGroupSnapshot: async () => snapshot(),
    activateBatch: async (objects: { object_uri: string; snapshot?: GroupSnapshot }[], onDispatch?: () => void | Promise<void>) => {
      assert.equal(locked, false); assert.equal(objects.length, 1); assert.equal(objects[0].object_uri, group); assert.deepEqual(objects[0].snapshot, snapshot());
      await onDispatch?.();
      activated++; return { success: true, messages: [] };
    },
    read: async (uri: string, version: 'active' | 'inactive') => sourceResult(connection.connection_id, uri, `${uri}/source/main`, '', version)
  } as Backend;
  const ops = new Operations(store, { get: async () => 'fake', set: async () => {}, remove: async () => {} }, new AuditLog(join(directory, 'logs')), () => backend);
  const base = { connection_id: connection.connection_id, name: 'ZGROUP', description: 'Test' };
  try {
    backend.transportRequirement = async () => 'required';
    const missingTask = await ops.run('create_function_group', { ...base, package_name: 'ZPACKAGE', request_id: 'no-task' });
    assert.equal(missingTask.error?.code, 'TRANSPORT_REQUIRED'); assert.equal(created, 0);
    assert.equal((await ops.run('create_function_group', { ...base, package_name: '$TMP', request_id: 'group' })).status, 'success');
    const moduleResult = await ops.run('create_function_module', { ...base, name: 'ZMODULE', function_group_uri: group, request_id: 'module' });
    assert.equal(moduleResult.status, 'success');
    const moduleData = moduleResult.data as { interface_help: { example_source: string; guidance: string; example_applied: boolean }; next_action: { tool: string } };
    assert.ok(moduleData.interface_help.example_source.startsWith('FUNCTION ZMODULE'));
    assert.ok(moduleData.interface_help.example_source.includes('T_RETURN TYPE BAPIRET2 OPTIONAL.'));
    assert.ok(moduleData.interface_help.guidance.includes('never name = 1'));
    assert.equal(moduleData.interface_help.example_applied, false); assert.equal(moduleData.next_action.tool, 'read_source');
    assert.equal((await ops.run('get_function_group', { connection_id: connection.connection_id, function_group_uri: group })).status, 'success');
    const stale = await ops.run('activate_objects', { connection_id: connection.connection_id, objects: [{ object_uri: group, expected_revision: 'b'.repeat(64) }], request_id: 'stale' });
    assert.equal(stale.error?.code, 'VERSION_CONFLICT'); assert.equal(activated, 0);
    const current = await ops.run('activate_objects', { connection_id: connection.connection_id, objects: [{ object_uri: group, expected_revision: revision }], request_id: 'current' });
    assert.equal(current.status, 'success'); assert.equal(activated, 1);
    let snapshots = 0;
    backend.functionGroupSnapshot = async () => { snapshots++; return { ...snapshot(), revision: snapshots === 1 ? revision : 'd'.repeat(64) }; };
    const changed = await ops.run('activate_objects', { connection_id: connection.connection_id,
      objects: [{ object_uri: group, expected_revision: revision }], request_id: 'changed-after-unlock' });
    assert.equal(changed.error?.code, 'VERSION_CONFLICT'); assert.equal(activated, 1);
    backend.functionGroupSnapshot = async () => snapshot();
    backend.unlock = async () => { throw new Error('Unlock failed'); };
    const held = await ops.run('activate_objects', { connection_id: connection.connection_id,
      objects: [{ object_uri: group, expected_revision: revision }], request_id: 'held-lock' });
    assert.equal(held.error?.code, 'LOCK_CLEANUP_FAILED'); assert.equal(activated, 1);
    const config = await store.load(); config.connections[0].write_enabled = false; await store.save(config);
    assert.equal((await ops.run('create_function_module', { ...base, function_group_uri: group, request_id: 'disabled' })).error?.code, 'WRITE_DISABLED');
    const containerSave = await ops.run('update_source', { connection_id: connection.connection_id, source_uri: `${group}/source/main`, source: '', expected_revision: revision, request_id: 'container' });
    assert.equal(containerSave.error?.code, 'WRITE_DISABLED');
  } finally { await ops.close(); await rm(directory, { recursive: true, force: true }); }
});
