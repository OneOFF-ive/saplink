import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { SelfUpdater, downloadInstaller, type UpdateDependencies, type InstalledApplication } from '../src/self-update.js';
import type { UpdateResult } from '../src/updates.js';
import { ConfigStore } from '../src/config.js';
import { startAdmin } from '../src/admin.js';

const executable = Buffer.from('MZ-synthetic-installer-never-executed');
const sha256 = createHash('sha256').update(executable).digest('hex');
const release: UpdateResult = { current_version: '1.0.1', latest_version: '9.0.0', update_available: true, source: 'cos',
  downloads: [{ architecture: 'x64', url: 'https://updates.example/saplink/v9.0.0/SapLink-9.0.0-win-x64-setup.exe', sha256 }],
  release_url: 'https://github.com/OneOFF-ive/saplink/releases', published_at: '2026-10-18T00:00:00Z',
  checked_at: '2026-10-18T00:00:00Z', cached: false, message: 'Update available' };
async function temporary() {
  const root = join(process.cwd(), '.saplink', 'tests'); await mkdir(root, { recursive: true });
  return mkdtemp(join(root, 'self-update-'));
}
const fetcher = (body: BodyInit, headers: HeadersInit = {}) => (async (_url, init) => {
  assert.equal(init?.redirect, 'error');
  assert.equal(new Headers(init?.headers).has('Authorization'), false);
  return new Response(body, { headers });
}) as typeof fetch;

async function setup(directory: string, overrides: Partial<UpdateDependencies> = {}) {
  const installation: InstalledApplication = { root: join(directory, 'installed'), architecture: 'x64', launcher: 'synthetic-only' };
  await mkdir(installation.root, { recursive: true });
  await writeFile(join(installation.root, 'update-runner.ps1'), '# synthetic runner, never executed');
  const dependencies: UpdateDependencies = {
    installation: async () => installation, check: async () => release, github: async () => { throw new Error('GitHub offline in fixture'); },
    download: (item, folder, progress) => downloadInstaller(item, folder, progress, fetcher(executable, { 'Content-Length': String(executable.length) })),
    launch: async (_installation, _script, path) => {
      const plan = JSON.parse(await readFile(path, 'utf8'));
      assert.equal(plan.version, '9.0.0'); assert.equal(plan.architecture, 'x64'); assert.equal(plan.sha256, sha256);
      assert.equal(await readFile(plan.installer, 'utf8'), executable.toString());
      await writeFile(join(dirname(path), 'ready.json'), JSON.stringify({ id: plan.id }));
    }, ...overrides
  };
  return new SelfUpdater(directory, dependencies);
}

test('installer streaming validates hash, PE header and byte counts before producing an executable', async () => {
  const directory = await temporary();
  try {
    let reported = 0;
    const file = await downloadInstaller(release.downloads[0], directory, bytes => { reported = bytes; }, fetcher(executable, { 'content-length': String(executable.length) }));
    assert.deepEqual(await readFile(file), executable); assert.equal(reported, executable.length);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('bad hash, non-PE payloads, truncated and oversized downloads never leave an executable', async () => {
  const cases = [
    { body: executable, headers: {}, hash: '0'.repeat(64) },
    { body: Buffer.from('not-an-installer'), headers: {}, hash: sha256 },
    { body: executable, headers: { 'Content-Length': '500' }, hash: sha256 },
    { body: executable, headers: { 'Content-Length': String(257 * 1024 * 1024) }, hash: sha256 }
  ];
  for (const item of cases) {
    const directory = await temporary();
    try {
      await assert.rejects(downloadInstaller({ ...release.downloads[0], sha256: item.hash }, directory, () => {}, fetcher(item.body, item.headers)));
      await assert.rejects(access(join(directory, 'installer.exe')));
      await assert.rejects(access(join(directory, 'installer.part')));
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test('self-update uses matching architecture, waits for native readiness and commits before graceful shutdown', async () => {
  const directory = await temporary(); let stopped = 0;
  try {
    const updater = await setup(directory);
    await updater.install('9.0.0', { mode: 'ui', ui_port: 8766, mcp_port: 9000 }, async () => { stopped++; });
    await updater.wait();
    assert.equal(stopped, 1); assert.equal((await updater.status()).phase, 'installing');
    assert.equal(JSON.parse(await readFile(join(directory, 'updates', 'pending.json'), 'utf8')).id.length, 36);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unsupported environments and downgrades are rejected without starting a job', async () => {
  const directory = await temporary(); let checks = 0;
  try {
    const updater = new SelfUpdater(directory, { installation: async () => null, check: async () => { checks++; return release; } });
    await assert.rejects(updater.install('9.0.0', { mode: 'stopped' }, async () => {}), /Windows/);
    await assert.rejects(updater.install('0.1.0', { mode: 'stopped' }, async () => {}), /正式版本/);
    assert.equal(checks, 0); assert.equal(updater.busy, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('changed versions, unverified GitHub fallback or unavailable architecture cannot stop the existing application', async () => {
  for (const change of [{ latest_version: '9.0.1' }, { source: 'github' as const, downloads: [] }, { downloads: [{ ...release.downloads[0], architecture: 'arm64' as const }] }]) {
    const directory = await temporary(); let stopped = false; let launched = false;
    try {
      const updater = await setup(directory, { check: async () => ({ ...release, ...change }), launch: async () => { launched = true; } });
      await updater.install('9.0.0', { mode: 'stopped' }, async () => { stopped = true; }); await updater.wait();
      assert.equal((await updater.status()).phase, 'failed'); assert.equal(stopped, false); assert.equal(launched, false);
      await assert.rejects(access(join(directory, 'updates', 'pending.json')));
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test('failed download and failed native preflight preserve the running app and permit a later retry', async () => {
  for (const nativeFailure of [false, true]) {
    const directory = await temporary(); let stopped = false;
    try {
      const updater = await setup(directory, nativeFailure ? { launch: async (_installation, _script, path) => {
        await writeFile(join(dirname(path), 'result.json'), JSON.stringify({ status: 'failed' }));
      } } : { download: async () => { throw new Error('offline'); } });
      await updater.install('9.0.0', { mode: 'stopped' }, async () => { stopped = true; }); await updater.wait();
      assert.equal((await updater.status()).phase, 'failed'); assert.equal(stopped, false); assert.equal(updater.busy, false);
      await assert.rejects(access(join(directory, 'updates', 'pending.json')));
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test('pending updates and overlapping operations cannot launch duplicate installers', async () => {
  const directory = await temporary();
  try {
    let finishCheck!: (value: UpdateResult) => void;
    const updater = await setup(directory, { check: () => new Promise(resolve => { finishCheck = resolve; }) });
    const checking = updater.check();
    await assert.rejects(updater.install('9.0.0', { mode: 'stopped' }, async () => {}), /更新/);
    finishCheck(release); await checking;
    await mkdir(join(directory, 'updates'), { recursive: true });
    await writeFile(join(directory, 'updates', 'pending.json'), '{"id":"another-job"}');
    await assert.rejects(updater.install('9.0.0', { mode: 'stopped' }, async () => {}), /已有更新/);
    assert.equal(JSON.parse(await readFile(join(directory, 'updates', 'pending.json'), 'utf8')).id, 'another-job');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('web update routes require the management session and same-origin confirmation; source mode cannot install', async () => {
  const directory = await temporary(); let checks = 0;
  const store = new ConfigStore(directory);
  const updater = new SelfUpdater(directory, { installation: async () => null, check: async () => { checks++; return release; } });
  const admin = await startAdmin(store, { get: async () => '', set: async () => {}, remove: async () => {} }, 0, undefined, undefined, { updater });
  const url = new URL(admin.url), origin = url.origin;
  const headers = { 'X-Admin-Token': url.hash.slice(1), Origin: origin, 'Content-Type': 'application/json' };
  try {
    assert.equal((await fetch(origin + '/api/updates/check', { method: 'POST', headers: { Origin: origin }, body: '{}' })).status, 401);
    assert.equal((await fetch(origin + '/api/updates/install', { method: 'POST', headers: { ...headers, Origin: 'http://evil.test' }, body: '{}' })).status, 403);
    const result = await fetch(origin + '/api/updates/check', { method: 'POST', headers, body: '{}' });
    assert.equal(result.status, 200); assert.equal((await result.json()).update_install.supported, false); assert.equal(checks, 1);
    const injected = await fetch(origin + '/api/updates/install', { method: 'POST', headers, body: JSON.stringify({ version: '9.0.0', url: 'https://evil.test/setup.exe' }) });
    assert.equal(injected.status, 400);
    const install = await fetch(origin + '/api/updates/install', { method: 'POST', headers, body: JSON.stringify({ version: '9.0.0' }) });
    assert.equal((await install.json()).error.code, 'UPDATE_NOT_INSTALLED');
  } finally { await admin.close(); await rm(directory, { recursive: true, force: true }); }
});

/* Restoring an update must preserve both the UI endpoint and the previous MCP port. */
test('admin restart restores MCP on the recorded port when tokens exist', async () => {
  const { createServer } = await import('node:net');
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const directory = await temporary();
  const store = new ConfigStore(directory); await store.createToken();
  const admin = await startAdmin(store, { get: async () => '', set: async () => {}, remove: async () => {} }, 0, undefined, undefined, { initialMcpPort: port });
  try {
    const url = new URL(admin.url);
    const state = await (await fetch(url.origin + '/api/state', { headers: { 'X-Admin-Token': url.hash.slice(1) } })).json();
    assert.equal(state.running, true); assert.equal(state.mcp_port, port);
  } finally { await admin.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a graceful-shutdown failure after handoff keeps the native job reservation', async () => {
  const directory = await temporary();
  try {
    const updater = await setup(directory);
    await updater.install('9.0.0', { mode: 'stopped' }, async () => { throw new Error('shutdown unknown'); });
    await updater.wait();
    assert.equal((await updater.status()).phase, 'failed');
    assert.ok(JSON.parse(await readFile(join(directory, 'updates', 'pending.json'), 'utf8')).id);
    await assert.rejects(updater.install('9.0.0', { mode: 'stopped' }, async () => {}), /已有更新/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('COS download failure falls back to the same verified GitHub installer before shutdown', async () => {
  const directory = await temporary(); const sources:string[]=[]; let stopped=false;
  const alternate={...release,source:'github' as const,downloads:[{...release.downloads[0],url:'https://github.com/OneOFF-ive/saplink/releases/download/v9.0.0/SapLink-9.0.0-win-x64-setup.exe'}]};
  try {
    const updater=await setup(directory,{github:async()=>alternate,download:async(item,folder,progress)=>{
      sources.push(item.url);
      if(sources.length===1)throw new Error('COS offline');
      return downloadInstaller(item,folder,progress,(async()=>new Response(executable)) as typeof fetch);
    }});
    await updater.install('9.0.0',{mode:'stopped'},async()=>{stopped=true;}); await updater.wait();
    assert.equal(stopped,true);assert.equal(sources.length,2);assert.equal(sources[1],alternate.downloads[0].url);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('fallback version or hash mismatch never executes an installer', async () => {
  for(const change of [{latest_version:'9.0.1'},{downloads:[{...release.downloads[0],sha256:'0'.repeat(64)}]}]) {
    const directory=await temporary();let stopped=false;let attempts=0;
    try {
      const updater=await setup(directory,{github:async()=>({...release,source:'github',...change}),download:async()=>{attempts++;throw new Error('COS offline');}});
      await updater.install('9.0.0',{mode:'stopped'},async()=>{stopped=true;});await updater.wait();
      assert.equal(stopped,false);assert.equal(attempts,1);assert.equal((await updater.status()).phase,'failed');
    } finally {await rm(directory,{recursive:true,force:true});}
  }
});

test('GitHub attachment redirects allow official HTTPS CDN only and retain SHA-256 validation', async () => {
  const item={...release.downloads[0],url:'https://github.com/OneOFF-ive/saplink/releases/download/v9.0.0/SapLink-9.0.0-win-x64-setup.exe'};
  for(const target of ['https://release-assets.githubusercontent.com/file?signature=example','https://evil.test/file','http://release-assets.githubusercontent.com/file']) {
    const directory=await temporary();let calls=0;
    try {
      const download=downloadInstaller(item,directory,()=>{},(async (_url,init)=>{
        calls++;assert.equal(init?.redirect,'manual');assert.equal(new Headers(init?.headers).has('Authorization'),false);
        return calls===1?new Response(null,{status:302,headers:{location:target}}):new Response(executable);
      }) as typeof fetch);
      if(target.startsWith('https://release-assets.')){assert.deepEqual(await readFile(await download),executable);assert.equal(calls,2);}
      else{await assert.rejects(download,/官方附件域名/);assert.equal(calls,1);}
    } finally {await rm(directory,{recursive:true,force:true});}
  }
});
