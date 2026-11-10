import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ConfigStore, type Credentials } from '../src/config.js';
import { startAdmin } from '../src/admin.js';
import type { Backend } from '../src/adt.js';
import { AppError } from '../src/errors.js';

test('local web management protects APIs and manages connections, credentials, tokens and service lifecycle', async () => {
  const root = join(process.cwd(), '.saplink', 'tests'); await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'admin-'));
  const oldLogDirectory = process.env.SAPLINK_LOG_DIR;
  process.env.SAPLINK_LOG_DIR = join(directory, 'logs');
  const store = new ConfigStore(directory); const passwords = new Map<string, string>();
  const credentials: Credentials = { get: async id => { const value = passwords.get(id); if (!value) throw new AppError('SAP_CREDENTIAL_MISSING', '请编辑连接并重新输入密码。'); return value; },
    set: async (id, value) => { passwords.set(id, value); }, remove: async id => { passwords.delete(id); } };
  let probes = 0;
  const runtime = await startAdmin(store, credentials, 0, () => ({ capabilities: async () => { probes++; return { discovery: [{}] }; }, close: async () => {} } as Backend));
  const address = new URL(runtime.url); const origin = address.origin;
  const key = address.hash.slice(1);
  const api = async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(`${origin}/api/${path}`, { method,
      headers: { 'X-Admin-Token': key, Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  try {
    const home = await fetch(origin); assert.equal(home.status, 200); assert.ok((await home.text()).includes('连接配置'));
    assert.ok(home.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"));
    assert.equal((await fetch(`${origin}/icons.js`)).status, 200);
    assert.equal((await fetch(`${origin}/api/state`)).status, 401);
    assert.equal((await fetch(`${origin}/api/sap-logon/connections`)).status, 401);
    assert.equal((await fetch(`${origin}/api/rfc/environment`)).status, 401);
    assert.equal((await api('rfc/environment')).status, 200);
    assert.equal((await api('rfc/environment', 'PUT', { java_home: 'relative' })).body.error.code, 'INVALID_INPUT');
    const localJco = join(directory, 'jco-files');
    assert.equal((await api('rfc/environment', 'PUT', { jco_directory: localJco })).status, 200);
    const environment = await api('rfc/environment');
    assert.equal(environment.body.settings.jco_directory, localJco);
    assert.equal(environment.body.jar.source, 'settings');
    const checked = await api('rfc/environment/check', 'POST', {});
    assert.equal(checked.status, 200); assert.equal(checked.body.healthy, false); assert.equal(checked.body.sap_connected, false);
    assert.equal((await api('rfc/environment', 'PUT', {})).status, 200);
    const imported = await api('sap-logon/connections'); assert.equal(imported.status, 200);
    assert.ok(Array.isArray(imported.body.connections));
    for (const entry of imported.body.connections) assert.ok(Object.keys(entry).every(key =>
      ['id', 'label', 'system_id', 'available', 'reason', 'rfc', 'client', 'language'].includes(key)));
    const expectedVersion = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')).version;
    assert.equal((await api('state')).body.version, expectedVersion);
    assert.equal((await fetch(`${origin}/api/cache/clear`, { method: 'POST', headers: { Origin: origin } })).status, 401);
    assert.equal((await api('cache/clear', 'POST')).body.cleared_sessions, 0);
    assert.equal((await fetch(`${origin}/api/logs/clear`, { method: 'POST', headers: { Origin: origin } })).status, 401);
    await mkdir(join(directory, 'logs'));
    const oldLog = join(directory, 'logs', 'operations-2000-01-01-0.jsonl');
    await writeFile(oldLog, 'old log'); await utimes(oldLog, new Date('2000-01-01'), new Date('2000-01-01'));
    const tasks = join(directory,'agent','tasks'), orphan = randomUUID(), existing = randomUUID(), marked = randomUUID();
    const output = (id:string) => join(tasks,id,'artifacts','file.json');
    for (const id of [orphan,existing,marked]) {
      await mkdir(join(tasks,id,'artifacts'),{recursive:true});
      await writeFile(output(id),'archived output');
    }
    await writeFile(join(tasks,existing+'.json'),'metadata still exists even if unreadable');
    await writeFile(join(tasks,orphan,'keep.txt'),'unrelated data');
    await mkdir(join(tasks,'.trash'));
    await writeFile(join(tasks,'.trash',marked+'.json'),'deleted task');
    const preview = (await api('logs/clear', 'POST', { older_than_days: 30 })).body;
    assert.equal(preview.eligible_files,1);
    assert.equal(preview.eligible_session_outputs,2);
    assert.equal(await readFile(oldLog, 'utf8'), 'old log');
    assert.equal(await readFile(output(orphan),'utf8'),'archived output');
    const cleaned = (await api('logs/clear', 'POST', { older_than_days: 30, confirm: true })).body;
    assert.equal(cleaned.deleted_files,1);
    assert.equal(cleaned.deleted_session_outputs,2);
    await assert.rejects(readFile(oldLog), { code: 'ENOENT' });
    await assert.rejects(readFile(output(orphan)),{code:'ENOENT'});
    await assert.rejects(readFile(output(marked)),{code:'ENOENT'});
    assert.equal(await readFile(output(existing),'utf8'),'archived output');
    assert.equal(await readFile(join(tasks,orphan,'keep.txt'),'utf8'),'unrelated data');
    await mkdir(join(tasks,orphan,'artifacts'));
    await writeFile(output(orphan),'another leftover');
    const outputsOnly = (await api('logs/clear', 'POST', { older_than_days:36500, confirm:true })).body;
    assert.equal(outputsOnly.deleted_files,0);
    assert.equal(outputsOnly.deleted_session_outputs,1);
    await assert.rejects(readFile(output(orphan)),{code:'ENOENT'});
    for (const path of ['/API/state', '/Api/state', '/aPi/tokens']) {
      assert.equal((await fetch(`${origin}${path}`)).status, 401, path);
    }
    assert.equal((await fetch(`${origin}/API/tokens`, { method: 'POST', headers: { Origin: origin } })).status, 401);
    assert.equal((await fetch(`${origin}/API/tokens`, { method: 'POST', headers: { 'X-Admin-Token': key } })).status, 403);
    assert.equal((await fetch(`${origin}/API/tokens`, { method: 'POST', headers: { Origin: origin, 'X-Admin-Token': 'invalid' } })).status, 401);
    assert.equal((await store.load()).tokens.length, 0);
    assert.equal((await fetch(`${origin}/api/state`, { headers: { 'X-Admin-Token': key, Origin: 'http://evil.test' } })).status, 403);
    assert.equal((await fetch(`${origin}/api/tokens`, { method: 'POST', headers: { 'X-Admin-Token': key } })).status, 403);
    assert.equal((await fetch(`${origin}/api/application/stop`, { method: 'POST', headers: { Origin: origin } })).status, 401);
    const draft = { name: '开发系统_DEV', base_url: 'http://sap.test:8000', client: '001', username: 'TEST', language: 'EN', write_enabled: false, password: 'synthetic-secret' };
    for (const name of ['sap system', 'sap.system', 'sap/system', '开发 系统', '开发/系统']) {
      const invalid = await api('connections', 'POST', { ...draft, name });
      assert.equal(invalid.status, 400);
      assert.equal(invalid.body.error.code, 'INVALID_INPUT');
      assert.equal(invalid.body.error.fields[0].field, 'name');
      assert.ok(invalid.body.error.message.includes('下划线'));
      assert.ok(invalid.body.error.message.includes('sap_system_01'));
      assert.equal(JSON.stringify(invalid.body).includes('synthetic-secret'), false);
    }
    for (const base_url of ['not-a-url', 'ftp://sap.test', 'http://sap.test/other',
      'https://user:URL_SECRET@sap.test', 'http://sap.test?password=URL_SECRET', 'http://sap.test/#fragment']) {
      const invalid = await api('connections', 'POST', { ...draft, base_url });
      assert.equal(invalid.body.error.code, 'INVALID_INPUT');
      assert.equal(invalid.body.error.fields[0].field, 'base_url');
      assert.ok(invalid.body.error.message.includes('https://sap-host:443'));
      assert.equal(JSON.stringify(invalid.body).includes('URL_SECRET'), false);
    }
    const invalidFields = await api('connections', 'POST', { ...draft, client: '01', language: 'en' });
    assert.deepEqual(invalidFields.body.error.fields.map(field => field.field), ['client', 'language']);
    assert.ok(invalidFields.body.error.message.includes('3 位半角数字'));
    assert.ok(invalidFields.body.error.message.includes('2 位大写英文字母'));
    assert.equal(passwords.size, 0);
    const initial = await store.load();
    await writeFile(join(directory, 'config.json'), JSON.stringify({ ...initial, connections: [{ ...draft,
      password: undefined, connection_id: '01234567-89ab-4def-8123-456789abcdef', allowed_packages: ['$TMP'] }] }));
    const invalidConfig = await api('connections', 'POST', draft);
    assert.equal(invalidConfig.body.error.code, 'CONFIG_INVALID');
    assert.ok(invalidConfig.body.error.message.includes('allowed_packages'));
    assert.equal(passwords.size, 0);
    await store.save(initial);
    const created = await api('connections', 'POST', draft); assert.equal(created.status, 200);
    const id = created.body.connection_id; assert.ok(id);
    assert.equal(created.body.name, draft.name);
    assert.equal(created.body.allow_table_data,false);
    assert.equal((await store.load()).connections[0].name, draft.name); assert.equal(created.body.password, undefined);
    const invalidEdit = await api(`connections/${id}`, 'PUT', { ...draft, name: 'bad.name' });
    assert.equal(invalidEdit.body.error.fields[0].field, 'name');
    assert.equal(passwords.get(id), draft.password);
    assert.equal((await api('connections', 'POST', draft)).status, 400);
    assert.equal((await api(`connections/${id}/test`, 'POST')).body.success, true); assert.equal(probes, 1);
    passwords.delete(id);
    const missingCredential = await api(`connections/${id}/test`, 'POST');
    assert.equal(missingCredential.body.error.code, 'SAP_CREDENTIAL_MISSING');
    assert.match(missingCredential.body.error.message, /编辑连接.*重新输入密码/);
    assert.equal(probes, 1);
    assert.equal((await api(`connections/${id}`, 'PUT', draft)).status, 200);
    assert.equal((await api(`connections/${id}/test`, 'POST')).body.success, true); assert.equal(probes, 2);
    const changedTarget = await api(`connections/${id}`, 'PUT', { ...draft, base_url: 'http://other.test', password: undefined });
    assert.equal(changedTarget.body.error.code, 'CONNECTION_TARGET_IMMUTABLE');
    assert.equal((await api(`connections/${id}`, 'PUT', { ...draft, base_url: 'http://other.test', password: 'replacement-secret' })).body.error.code, 'CONNECTION_TARGET_IMMUTABLE');
    assert.equal((await store.load()).connections[0].base_url, draft.base_url);
    assert.equal(passwords.get(id), draft.password);
    const update = await api(`connections/${id}`, 'PUT', { ...draft, password: undefined, write_enabled: true });
    assert.equal(update.status, 200); assert.equal(update.body.connection_id, id);
    assert.equal((await api(`connections/${id}`, 'PUT', { ...draft, password: undefined, write_governance: 'approval_required' })).status, 400);
    const writeEnabled = await api(`connections/${id}`, 'PUT', { ...draft, password: undefined, write_enabled:true });
    assert.equal(writeEnabled.body.write_enabled, true);
    assert.equal(Object.hasOwn(writeEnabled.body,'write_governance'),false);
    const enabled = await api(`connections/${id}`, 'PUT', { ...draft, password: undefined, allow_table_data:true });
    assert.equal(enabled.body.allow_table_data,true);
    const legacyEdit = await api(`connections/${id}`, 'PUT', { ...draft, password: undefined });
    assert.equal(legacyEdit.body.allow_table_data,true);
    assert.equal((await api(`connections/${id}`, 'PUT', { ...draft, password: undefined, allow_table_data:'yes' })).status,400);
    assert.equal((await api(`connections/${id}`, 'PUT', { ...draft, client: '002', password: undefined })).body.error.code, 'PASSWORD_REQUIRED');
    const changedClient = await api(`connections/${id}`, 'PUT', { ...draft, client: '002' });
    assert.equal(changedClient.status, 200); assert.equal(changedClient.body.client, '002');
    assert.equal(changedClient.body.base_url, draft.base_url); assert.equal(changedClient.body.allow_table_data, true);
    const changedUser = await api(`connections/${id}`, 'PUT', { ...draft, client: '002', username: 'OTHER' });
    assert.equal(changedUser.status, 200); assert.equal(changedUser.body.allow_table_data, true);
    const disabled = await api(`connections/${id}`, 'PUT', { ...draft, client: '003', username: 'OTHER', allow_table_data: false });
    assert.equal(disabled.status, 200); assert.equal(disabled.body.allow_table_data, false);
    const restored = await api(`connections/${id}`, 'PUT', draft);
    assert.equal(restored.status, 200); assert.equal(restored.body.allow_table_data, false);
    assert.equal((await store.load()).connections[0].allow_table_data, false);
    const rfcDraft = { ...draft, rfc: { ashost: 'rfc.test', sysnr: '00' } };
    assert.equal((await api(`connections/${id}`, 'PUT', rfcDraft)).body.error.code, 'CONNECTION_TARGET_IMMUTABLE');
    const simplifiedCreate = await api('connections', 'POST', { ...rfcDraft, name: 'simple_rfc', base_url: undefined });
    assert.equal(simplifiedCreate.status, 200); assert.equal(simplifiedCreate.body.base_url, 'http://rfc.invalid');
    const rfcId = simplifiedCreate.body.connection_id;
    const simplifiedEdit = await api(`connections/${rfcId}`, 'PUT', { ...rfcDraft, name: 'simple_rfc', base_url: undefined, password: undefined });
    assert.equal(simplifiedEdit.status, 200); assert.equal(simplifiedEdit.body.base_url, 'http://rfc.invalid');
    for (const rfc of [{ ...rfcDraft.rfc, ashost: 'other.test' }, { ...rfcDraft.rfc, sysnr: '01' },
      { ...rfcDraft.rfc, saprouter: '/H/router.example/S/3299' }]) {
      const changed = await api(`connections/${rfcId}`, 'PUT', { ...rfcDraft, name: 'simple_rfc', base_url: undefined, rfc });
      assert.equal(changed.body.error.code, 'CONNECTION_TARGET_IMMUTABLE');
    }
    assert.equal((await api(`connections/${rfcId}`, 'PUT', { ...draft, name: 'simple_rfc' })).body.error.code, 'CONNECTION_TARGET_IMMUTABLE');
    assert.equal((await api('connections', 'POST', { ...draft, name: 'http_without_url', base_url: undefined })).status, 400);
    const routedDraft = { ...rfcDraft, rfc: { ...rfcDraft.rfc, saprouter: '/H/router.example/S/3299' } };
    const routed = await api('connections', 'POST', { ...routedDraft, name: 'routed' });
    assert.equal(routed.status, 200); assert.equal(routed.body.rfc.saprouter, routedDraft.rfc.saprouter);
    const routedId = routed.body.connection_id;
    const invalidRoute = await api(`connections/${routedId}`, 'PUT', { ...routedDraft, name: 'routed', rfc: { ...routedDraft.rfc, saprouter: '/H/router/P/route-secret' } });
    assert.equal(invalidRoute.status, 400); assert.equal(invalidRoute.body.error.fields[0].field, 'rfc_saprouter');
    assert.equal(JSON.stringify(invalidRoute.body).includes('route-secret'), false);
    assert.equal((await api(`connections/${routedId}`, 'PUT', { ...rfcDraft, name: 'routed' })).body.error.code, 'CONNECTION_TARGET_IMMUTABLE');
    assert.equal((await api(`connections/${rfcId}`, 'DELETE')).status, 200);
    assert.equal((await api(`connections/${routedId}`, 'DELETE')).status, 200);
    const token = await api('tokens', 'POST', { name: '  开发客户端  ' }); assert.equal(token.status, 200);
    assert.equal(token.body.name, '开发客户端');
    const tokenBeforeRename = (await store.load()).tokens[0];
    const renamed = await api(`tokens/${token.body.id}`, 'PUT', { name: '测试客户端' });
    assert.equal(renamed.status, 200); assert.equal(renamed.body.name, '测试客户端');
    assert.equal(renamed.body.token, undefined); assert.equal(renamed.body.hash, undefined);
    assert.deepEqual((await store.load()).tokens[0], { ...tokenBeforeRename, name: '测试客户端' });
    for (const name of ['', '   ', 'x'.repeat(81), 'line\nnext']) {
      assert.equal((await api('tokens', 'POST', { name })).body.error.code, 'INVALID_INPUT');
      assert.equal((await api(`tokens/${token.body.id}`, 'PUT', { name })).body.error.code, 'INVALID_INPUT');
    }
    assert.equal((await api('tokens/missing', 'PUT', { name: 'Missing' })).body.error.code, 'NOT_FOUND');
    assert.equal((await fetch(`${origin}/api/tokens/${token.body.id}`, { method: 'PUT', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({name:'Unauthorized'}) })).status, 401);
    assert.equal(await store.authenticate(token.body.token), true);
    const state = await api('state');
    assert.equal(state.body.tokens[0].name, '测试客户端');
    assert.equal(JSON.stringify(state.body).includes(tokenBeforeRename.hash), false);
    assert.equal(JSON.stringify(state.body).includes(token.body.token), false);
    assert.equal(JSON.stringify(state.body).includes('synthetic-secret'), false);
    assert.equal((await readFile(join(directory, 'config.json'), 'utf8')).includes('synthetic-secret'), false);
    const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as { port: number }).port; await new Promise<void>(resolve => probe.close(() => resolve()));
    assert.equal((await api('service/start', 'POST', { port })).status, 200);
    assert.equal((await api('state')).body.running, true);
    assert.equal((await api('rfc/environment', 'PUT', {})).body.error.code, 'MCP_RUNNING');
    const client = new Client({ name: 'cache-admin-test', version: '1' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token.body.token}` } }
      }));
      await client.callTool({ name: 'get_capabilities', arguments: { connection_id: id } });
      const cleared = await api('cache/clear', 'POST');
      assert.equal(cleared.status, 200);
      assert.deepEqual(cleared.body, { cleared_sessions: 1, retained_write_requests: 0 });
      assert.equal((await api('state')).body.running, true);
      assert.equal((await client.callTool({ name: 'get_capabilities', arguments: { connection_id: id } })).isError, false);
    } finally { await client.close(); }
    assert.equal((await api(`connections/${id}`, 'DELETE')).body.error.code, 'MCP_RUNNING');
    assert.equal((await api(`connections/${id}`, 'PUT', { ...draft, password: undefined })).body.error.code, 'MCP_RUNNING');
    assert.equal((await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST' })).status, 401);
    assert.equal((await api('service/stop', 'POST')).status, 200);
    assert.equal((await api('state')).body.running, false);
    await api(`tokens/${token.body.id}`, 'DELETE'); assert.equal(await store.authenticate(token.body.token), false);
    assert.equal((await api('service/start', 'POST', { port })).body.error.code, 'TOKEN_REQUIRED');
    assert.equal((await api(`connections/${id}`, 'DELETE')).status, 200); assert.equal(passwords.size, 0);
    assert.equal((await api('application/stop', 'POST')).body.success, true);
  } finally {
    await runtime.close(); await rm(directory, { recursive: true, force: true });
    if (oldLogDirectory === undefined) delete process.env.SAPLINK_LOG_DIR;
    else process.env.SAPLINK_LOG_DIR = oldLogDirectory;
  }
});
