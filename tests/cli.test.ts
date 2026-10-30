import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConfigStore, connectionSchema } from '../src/config.js';
import { acquireLease, inspectLease } from '../src/lease.js';
import { openServiceUi } from '../src/service.js';

const execute = promisify(execFile);

test('SapLink CLI exposes the renamed command and package entry', async () => {
  const manifest = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(resolve('package-lock.json'), 'utf8'));
  assert.deepEqual(manifest.bin, { saplink: 'dist/cli.js' });
  assert.deepEqual(lock.packages[''].bin, manifest.bin);
  const help = await execute(process.execPath, [resolve('dist/cli.js'), '--help'], { encoding: 'utf8' });
  assert.match(help.stdout, /Usage: saplink\b/);
  assert.equal(help.stderr, '');
});

async function fixture() {
  const root = join(process.cwd(), '.saplink', 'tests');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'cli-'));
  const env = { ...process.env, SAPLINK_CONFIG_DIR: directory, SAPLINK_LOG_DIR: join(directory, 'logs'), SAPLINK_AUTO_UPDATE_CHECK: '0' };
  const run = async (...args: string[]) => {
    let stdout: string; let stderr: string; let code = 0;
    try {
      const result = await execute(process.execPath, [resolve('dist/cli.js'), ...args, '--json'], { env, encoding: 'utf8', timeout: 65000 });
      stdout = result.stdout; stderr = result.stderr;
    } catch (error) {
      const result = error as { stdout: string; stderr: string; code: number };
      stdout = result.stdout; stderr = result.stderr; code = result.code;
    }
    assert.equal(stderr, '', 'JSON mode must not write banners or raw errors to stderr');
    return { code, result: JSON.parse(stdout) };
  };
  return { directory, env, run, store: new ConfigStore(directory), cleanup: async () => {
    await run('service', 'stop').catch(() => {});
    await rm(directory, { recursive: true, force: true });
  } };
}

async function freePort() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>(resolve => server.close(() => resolve()));
  return address.port;
}

test('app and MCP have independent lifecycles while preserving the UI, configuration and standalone CLI', async () => {
  const f = await fixture();
  try {
    const uiPort = await freePort(); const mcpPort = await freePort();
    const host = await f.run('app', 'start', '--port', String(uiPort));
    assert.equal(host.code, 0, JSON.stringify(host));
    assert.equal(host.result.data.mcp_running, false); assert.equal(host.result.data.ui_port, uiPort);
    const pid = host.result.data.pid;
    assert.equal((await f.run('mcp', 'status')).result.data.state, 'stopped');
    assert.equal((await f.run('mcp', 'start', '--port', String(mcpPort))).result.error.code, 'TOKEN_REQUIRED');
    assert.equal((await f.run('app', 'status')).result.data.pid, pid);
    await f.store.createToken('lifecycle-test');
    const enabled = await f.run('mcp', 'start', '--port', String(mcpPort));
    assert.equal(enabled.code, 0, JSON.stringify(enabled));
    assert.equal(enabled.result.data.pid, pid); assert.equal(enabled.result.data.state, 'running');
    const session = new URL((await openServiceUi(f.directory, uiPort)).url);
    const headers = { Origin: session.origin, 'X-Admin-Token': session.hash.slice(1) };
    const state = async () => (await fetch(`${session.origin}/api/state`, { headers })).json();
    assert.equal((await state()).running, true);
    const stopped = await f.run('mcp', 'stop');
    assert.equal(stopped.result.data.state, 'stopped'); assert.equal(stopped.result.data.pid, pid);
    assert.equal(stopped.result.data.app_state, 'running'); assert.equal((await state()).running, false);
    assert.equal((await f.run('sap', 'list_connections')).code, 0);
    const restarted = await f.run('mcp', 'restart');
    assert.equal(restarted.code, 0); assert.equal(restarted.result.data.pid, pid); assert.equal(restarted.result.data.port, mcpPort);
    const occupied = createServer();
    await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve));
    try {
      const failed = await f.run('mcp', 'restart', '--port', String((occupied.address() as { port: number }).port));
      assert.equal(failed.result.error.code, 'EADDRINUSE'); assert.equal((await state()).running, true);
      assert.equal((await f.run('mcp', 'status')).result.data.port, mcpPort);
    } finally { await new Promise<void>(resolve => occupied.close(() => resolve())); }
    const hostRestart = await f.run('app', 'restart');
    assert.equal(hostRestart.code, 0, JSON.stringify(hostRestart));
    assert.notEqual(hostRestart.result.data.pid, pid); assert.equal(hostRestart.result.data.mcp_running, true);
    assert.equal(hostRestart.result.data.ui_port, uiPort); assert.equal(hostRestart.result.data.port, mcpPort);
    await f.run('mcp', 'stop');
    const withoutMcp = await f.run('app', 'restart');
    assert.equal(withoutMcp.code, 0); assert.equal(withoutMcp.result.data.mcp_running, false);
    assert.equal((await f.run('mcp', 'start', '--port', String(mcpPort))).result.data.state, 'running');
    assert.equal((await f.run('app', 'stop')).result.data.state, 'stopped');
    assert.equal((await f.run('mcp', 'status')).result.data.state, 'stopped');
    assert.equal((await f.run('mcp', 'stop')).result.data.state, 'stopped');
    assert.equal((await f.run('sap', 'list_connections')).code, 0);
    assert.equal((await f.store.load()).tokens.length, 1);
  } finally { await f.cleanup(); }
});

test('background MCP and graphical management share one host and preserve it across repeated opens and MCP restarts', async () => {
  const f = await fixture();
  let relay: ReturnType<typeof spawn> | undefined;
  try {
    await f.store.createToken();
    const port = await freePort(); const uiPort = await freePort();
    const started = await f.run('service', 'start', '--port', String(port));
    assert.equal(started.code, 0);
    const pid = started.result.data.pid;
    const occupiedUi = createServer();
    await new Promise<void>(resolve => occupiedUi.listen(0, '127.0.0.1', resolve));
    try {
      await assert.rejects(openServiceUi(f.directory, (occupiedUi.address() as { port: number }).port));
      assert.equal((await f.run('service', 'status')).result.data.pid, pid);
      assert.equal((await f.run('service', 'status')).result.data.mcp_running, true);
    } finally { await new Promise<void>(resolve => occupiedUi.close(() => resolve())); }
    const sessions = await Promise.all([openServiceUi(f.directory, uiPort), openServiceUi(f.directory, uiPort)]);
    assert.equal(sessions[0].pid, pid); assert.equal(sessions[0].url, sessions[1].url);
    const session = new URL(sessions[0].url);
    const headers = { Origin: session.origin, 'X-Admin-Token': session.hash.slice(1), 'Content-Type': 'application/json' };
    const state = async () => (await fetch(`${session.origin}/api/state`, { headers })).json();
    assert.equal((await state()).running, true); assert.equal((await state()).mcp_port, port);
    assert.equal((await fetch(`${session.origin}/api/state`)).status, 401);
    relay = spawn(process.execPath, [resolve('dist/cli.js'), 'ui', '--no-open', '--port', String(uiPort)], {
      env: f.env, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('UI attachment timed out')), 15000);
      relay!.stdout!.on('data', chunk => {
        if (chunk.toString().includes('Management session URL: ')) { clearTimeout(timer); resolve(); }
      });
      relay!.once('error', error => { clearTimeout(timer); reject(error); });
    });
    assert.equal((await inspectLease(f.directory)).pid, pid);
    assert.equal((await fetch(`${session.origin}/api/service/stop`, { method: 'POST', headers })).status, 200);
    assert.equal((await state()).running, false);
    assert.equal((await f.run('service', 'status')).result.data.mcp_running, false);
    const resumed = await f.run('service', 'start', '--port', String(port));
    assert.equal(resumed.code, 0); assert.equal(resumed.result.data.pid, pid);
    assert.equal((await state()).running, true);
    const relayExit = new Promise(resolve => relay!.once('exit', resolve));
    assert.equal((await f.run('service', 'stop')).code, 0);
    await relayExit;
    assert.equal((await inspectLease(f.directory)).state, 'missing');
  } finally {
    if (relay?.exitCode === null) relay.kill();
    await f.cleanup();
  }
});

test('JSON diagnostics and argument errors are structured; tokens are not printed or overwritten', async () => {
  const f = await fixture();
  try {
    const expectedVersion = JSON.parse(await readFile(resolve('package.json'), 'utf8')).version;
    const version = await f.run('version');
    assert.equal(version.code, 0);
    assert.deepEqual(version.result, { schema_version: 1, status: 'success', data: { version: expectedVersion } });
    for (const argument of ['version', '--version']) {
      const text = await execute(process.execPath, [resolve('dist/cli.js'), argument], { env: f.env, encoding: 'utf8', timeout: 65000 });
      assert.equal(text.stdout.trim(), expectedVersion); assert.equal(text.stderr, '');
    }
    const status = await f.run('status');
    assert.equal(status.code, 0); assert.equal(status.result.data.service.state, 'stopped');
    assert.equal((await f.run('cache', 'clear')).result.data.cleared_sessions, 0);
    const logsPreview = await f.run('logs', 'clear');
    assert.equal(logsPreview.code, 0); assert.equal(logsPreview.result.data.dry_run, true);
    assert.equal((await f.run('logs', 'clear', '--older-than-days', '-1')).result.error.code, 'INVALID_INPUT');
    const diagnosis = await f.run('doctor');
    assert.equal(diagnosis.code, 0); assert.equal(diagnosis.result.data.healthy, true);
    assert.equal(diagnosis.result.data.checks.find((check: { name: string }) => check.name === 'tokens').status, 'warning');
    assert.equal(diagnosis.result.data.sap_probe_performed, false);
    assert.equal((await f.run('service', 'start')).result.error.code, 'TOKEN_REQUIRED');
    assert.equal((await f.run('token', 'create')).result.error.code, 'TOKEN_OUTPUT_REQUIRED');
    assert.equal((await f.run('service', 'start', '--port', 'oops')).code, 1);
    assert.equal((await f.run('not-a-command')).result.error.code, 'INVALID_ARGUMENTS');
    const tokenPath = join(f.directory, 'client-token.json');
    const created = await f.run('token', 'create', '--name', 'My Client', '--out', tokenPath);
    assert.equal(created.code, 0);
    const secret = JSON.parse(await readFile(tokenPath, 'utf8'));
    assert.equal(await f.store.authenticate(secret.token), true);
    assert.equal(created.result.data.name, 'My Client'); assert.equal(secret.name, 'My Client');
    const beforeRename = (await f.store.load()).tokens[0];
    const renamed = await f.run('token', 'rename', secret.id, '--name', '开发助手');
    assert.equal(renamed.code, 0); assert.equal(renamed.result.data.name, '开发助手');
    assert.deepEqual((await f.store.load()).tokens[0], { ...beforeRename, name: '开发助手' });
    assert.equal(await f.store.authenticate(secret.token), true);
    const listed = await f.run('token', 'list'); assert.equal(listed.result.data[0].name, '开发助手');
    assert.equal(JSON.stringify(renamed.result).includes(secret.token), false);
    assert.equal(JSON.stringify(created.result).includes(secret.token), false);
    const again = await f.run('token', 'create', '--out', tokenPath);
    assert.equal(again.result.error.code, 'EEXIST');
    assert.equal((await f.store.load()).tokens.length, 1);
    assert.equal(JSON.stringify((await f.run('status')).result).includes(secret.token), false);
    assert.equal(JSON.stringify((await f.run('token', 'list')).result).includes(secret.token), false);
    const connectionFile = join(f.directory, 'connection-parameters.json');
    const exported = await f.run('client-config', '--token-file', tokenPath, '--out', connectionFile);
    assert.equal(exported.code, 0);
    assert.equal(exported.result.data.client_specific, false);
    assert.equal(JSON.stringify(exported.result).includes(secret.token), false);
    const parameters = JSON.parse(await readFile(connectionFile, 'utf8'));
    assert.equal(parameters.headers.Authorization, `Bearer ${secret.token}`);
    assert.equal((await f.run('client-config', '--token-file', tokenPath, '--out', connectionFile)).result.error.code, 'EEXIST');
    await f.run('token', 'revoke', secret.id);
    assert.equal(await f.store.authenticate(secret.token), false);
    assert.equal((await f.run('client-config', '--token-file', tokenPath, '--out', join(f.directory, 'revoked.json'))).result.error.code, 'TOKEN_FILE_INVALID');
  } finally { await f.cleanup(); }
});

test('noninteractive connection edits preserve login secrets and never reuse credentials for changed identities', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.run('connection', 'add', 'dev')).result.error.code, 'INTERACTION_REQUIRED');
    assert.equal((await f.run('connection', 'add', 'dev', '--url', 'https://sap.test', '--client', '001', '--username', 'TEST')).result.error.code, 'INTERACTION_REQUIRED');
    const connection = connectionSchema.parse({ connection_id: randomUUID(), name: 'dev', base_url: 'https://sap.test', client: '001', username: 'TEST', language: 'EN' });
    await f.store.save({ schema_version: 1, connections: [connection], tokens: [] });
    const edited = await f.run('connection', 'edit', 'dev', '--language', 'zh', '--disable-writes');
    assert.equal(edited.code, 0); assert.equal(edited.result.data.language, 'ZH');
    assert.equal(edited.result.data.connection_id, connection.connection_id);
    const changed = await f.run('connection', 'edit', 'dev', '--url', 'https://other.test');
    assert.equal(changed.result.error.code, 'INTERACTION_REQUIRED');
    assert.equal((await f.store.load()).connections[0].base_url, 'https://sap.test');
    assert.equal((await f.run('connection', 'remove', 'dev')).result.error.code, 'CONFIRMATION_REQUIRED');
    assert.equal((await f.store.load()).connections.length, 1);
  } finally { await f.cleanup(); }
});

test('CLI selects transport, preserves router settings and requires credentials for route changes', async () => {
  const f = await fixture();
  try {
    const connection = connectionSchema.parse({ connection_id: randomUUID(), name: 'routed', base_url: 'https://sap.test', client: '001', username: 'TEST', language: 'EN',
      rfc: { ashost: 'sap.test', sysnr: '00', saprouter: '/H/router/S/3299' } });
    await f.store.save({ schema_version: 1, connections: [connection], tokens: [] });
    const preserved = await f.run('connection', 'edit', 'routed', '--language', 'ZH');
    assert.equal(preserved.code, 0); assert.deepEqual(preserved.result.data.rfc, connection.rfc);
    for (const flags of [['--rfc-saprouter', '/H/other/S/3299'], ['--clear-rfc-saprouter'], ['--transport', 'http']]) {
      const changed = await f.run('connection', 'edit', 'routed', ...flags);
      assert.equal(changed.result.error.code, 'INTERACTION_REQUIRED');
      assert.deepEqual((await f.store.load()).connections[0].rfc, connection.rfc);
    }
    for (const flags of [['--transport', 'http', '--rfc-ashost', 'sap.test'], ['--transport', 'unknown'],
      ['--transport', 'rfc', '--http-transport'], ['--rfc-saprouter', '/H/router', '--clear-rfc-saprouter']])
      assert.equal((await f.run('connection', 'edit', 'routed', ...flags)).result.error.code, 'INVALID_INPUT');
    const missingRfc = await f.run('connection', 'add', 'new', '--transport', 'rfc', '--url', 'https://sap.test', '--client', '001', '--username', 'TEST');
    assert.equal(missingRfc.result.error.code, 'INVALID_INPUT');
    const simplified = await f.run('connection', 'add', 'simple', '--transport', 'rfc', '--rfc-ashost', 'sap.test', '--rfc-sysnr', '02', '--client', '001', '--username', 'TEST');
    assert.equal(simplified.result.error.code, 'INTERACTION_REQUIRED');
    assert.match(simplified.result.error.message, /password/);
    const invalidRoute = await f.run('connection', 'edit', 'routed', '--rfc-saprouter', '/H/router/P/route-secret');
    assert.equal(invalidRoute.result.error.code, 'INVALID_INPUT'); assert.match(invalidRoute.result.error.message, /SAProuter/);
    assert.doesNotMatch(JSON.stringify(invalidRoute.result), /route-secret/);
  } finally { await f.cleanup(); }
});

test('managed background lifecycle authenticates control, preserves port on restart, and releases leases', async () => {
  const f = await fixture();
  try {
    await f.store.createToken();
    const port = await freePort();
    const started = await f.run('service', 'start', '--port', String(port));
    assert.equal(started.code, 0, JSON.stringify(started.result));
    assert.equal(started.result.data.state, 'running');
    const pid = started.result.data.pid;
    const cleared = await f.run('cache', 'clear');
    assert.equal(cleared.code, 0, JSON.stringify(cleared.result));
    assert.deepEqual(cleared.result.data, { cleared_sessions: 0, retained_write_requests: 0 });
    assert.equal((await f.run('service', 'status')).result.data.pid, pid);
    const record = JSON.parse(await readFile(join(f.directory, 'managed-service.json'), 'utf8'));
    assert.equal(JSON.stringify(started.result).includes(record.control_token), false);
    assert.equal((await fetch(`http://127.0.0.1:${record.control_port}/stop`, { method: 'POST' })).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${record.control_port}/cache/clear`, { method: 'POST' })).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${record.control_port}/stop`, { method: 'POST',
      headers: { Authorization: `Bearer ${record.control_token}`, Origin: 'http://evil.test' } })).status, 403);
    assert.equal((await f.run('service', 'start', '--port', String(port))).result.data.pid, pid);
    const blockedEdit = await f.run('connection', 'add', 'blocked');
    assert.equal(blockedEdit.result.error.code, 'SERVICE_RUNNING');
    const restarted = await f.run('service', 'restart');
    assert.equal(restarted.code, 0, JSON.stringify(restarted.result));
    assert.equal(restarted.result.data.port, port);
    assert.notEqual(restarted.result.data.pid, pid);
    const stopped = await f.run('service', 'stop');
    assert.equal(stopped.code, 0); assert.equal(stopped.result.data.state, 'stopped');
    assert.equal((await inspectLease(f.directory)).state, 'missing');
    assert.equal((await f.run('service', 'stop')).code, 0);
  } finally { await f.cleanup(); }
});

test('occupied ports fail without takeover; external owners and orphan guards are preserved', async () => {
  const f = await fixture();
  const occupied = createServer();
  let release: (() => Promise<void>) | undefined;
  try {
    await f.store.createToken();
    await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve));
    const address = occupied.address(); assert.ok(address && typeof address !== 'string');
    const failed = await f.run('service', 'start', '--port', String(address.port));
    assert.equal(failed.code, 1, JSON.stringify(failed.result));
    assert.equal(failed.result.error.code, 'EADDRINUSE');
    assert.equal(occupied.listening, true);
    assert.equal((await inspectLease(f.directory)).state, 'missing');
    release = await acquireLease(f.directory, 'runtime.lock');
    assert.equal((await f.run('status')).result.data.service.state, 'external');
    assert.equal((await f.run('service', 'stop')).result.error.code, 'SERVICE_NOT_MANAGED');
    assert.equal((await f.run('mcp', 'status')).result.data.state, 'unknown');
    assert.equal((await f.run('mcp', 'stop')).result.error.code, 'SERVICE_NOT_MANAGED');
    assert.equal((await inspectLease(f.directory)).state, 'running');
    await release(); release = undefined;
    await writeFile(join(f.directory, 'runtime.lock.guard'), '');
    assert.equal((await f.run('mcp', 'status')).result.data.state, 'unknown');
    assert.equal((await f.run('service', 'start', '--port', String(address.port))).result.error.code, 'LEASE_BUSY');
    assert.equal(await readFile(join(f.directory, 'runtime.lock.guard'), 'utf8'), '');
  } finally {
    await release?.();
    await new Promise<void>(resolve => occupied.close(() => resolve()));
    await f.cleanup();
  }
});

test('authenticated GUI shutdown drains the admin process and releases its runtime lease', async () => {
  const f = await fixture();
  const port = await freePort();
  const child = spawn(process.execPath, [resolve('dist/cli.js'), 'ui', '--no-open', '--port', String(port)], {
    env: f.env, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']
  });
  let session: URL | undefined;
  try {
    session = await new Promise<URL>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('GUI test startup timed out')), 20000);
      let output = '';
      child.stdout!.on('data', chunk => {
        output += chunk.toString();
        const match = output.match(/Management session URL: (http:\/\/127\.0\.0\.1:[0-9]+\/#[A-Za-z0-9_-]+)/);
        if (match) { clearTimeout(timer); resolve(new URL(match[1])); }
      });
      child.once('error', error => { clearTimeout(timer); reject(error); });
    });
    const lease = await inspectLease(f.directory);
    assert.equal(lease.state, 'running');
    assert.equal((await fetch(`${session.origin}/api/application/stop`, { method: 'POST' })).status, 401);
    const exited = new Promise<number | null>(resolve => child.once('exit', resolve));
    const response = await fetch(`${session.origin}/api/application/stop`, { method: 'POST',
      headers: { Origin: session.origin, 'X-Admin-Token': session.hash.slice(1) } });
    assert.equal(response.status, 200);
    assert.equal(await exited, 0);
    assert.equal((await inspectLease(f.directory)).state, 'missing');
  } finally {
    // This is only our isolated test process, never a user's service.
    if (child.exitCode === null) child.kill();
    await f.cleanup();
  }
});

test('foreground serve exposes the same authenticated shared management host', async () => {
  const f = await fixture();
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await f.store.createToken();
    const port = await freePort(); const uiPort = await freePort();
    child = spawn(process.execPath, [resolve('dist/cli.js'), 'serve', '--port', String(port)], {
      env: f.env, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Foreground host startup timed out')), 20000);
      child!.stdout!.on('data', chunk => {
        if (chunk.toString().includes('SapLink listening at ')) { clearTimeout(timer); resolve(); }
      });
      child!.once('error', error => { clearTimeout(timer); reject(error); });
    });
    const session = await openServiceUi(f.directory, uiPort);
    assert.equal(session.pid, child.pid);
    const url = new URL(session.url);
    const response = await fetch(`${url.origin}/api/state`, { headers: { 'X-Admin-Token': url.hash.slice(1) } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).running, true);
    const exited = new Promise(resolve => child!.once('exit', resolve));
    assert.equal((await f.run('service', 'stop')).code, 0);
    await exited;
  } finally {
    if (child?.exitCode === null) child.kill();
    await f.cleanup();
  }
});
