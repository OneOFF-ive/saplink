import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkForUpdate as checkDualSource, defaultManifestUrl, isNewerVersion, startAutomaticUpdates as startDualAutomatic } from '../src/updates.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

// Keep the original GitHub contract checks explicit; dual-source behavior is tested below.
const checkForUpdate = (...args: Parameters<typeof checkDualSource>) => checkDualSource(args[0], args[1], { ...args[2], manifestUrl: null });
const startAutomaticUpdates = (...args: Parameters<typeof startDualAutomatic>) => startDualAutomatic(args[0], args[1], { ...args[2], manifestUrl: null });

const release = { tag_name: 'v0.2.0', draft: false, prerelease: false, published_at: '2026-10-17T00:00:00Z',
  html_url: 'https://github.com/OneOFF-ive/saplink/releases/tag/v0.2.0' };
const fetcher = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
async function temporaryDirectory() {
  const root = join(process.cwd(), '.saplink', 'tests');
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, 'updates-'));
}

test('release comparison uses numeric versions and handles prerelease builds', () => {
  assert.equal(isNewerVersion('v0.10.0', '0.9.0'), true);
  assert.equal(isNewerVersion('v0.2.0', '0.2.0+local'), false);
  assert.equal(isNewerVersion('v0.2.0', '0.2.0-beta.1'), true);
  assert.equal(isNewerVersion('v0.2.0', '1.0.0'), false);
  assert.throws(() => isNewerVersion('v0.3.0-beta', '0.1.0'));
});

test('check caches metadata, recomputes against installed version, expires and supports force', async () => {
  const directory = await temporaryDirectory();
  let calls = 0;
  const mock = (async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.github.com/repos/OneOFF-ive/saplink/releases/latest');
    assert.equal(init?.redirect, 'error');
    return new Response(JSON.stringify(release));
  }) as typeof fetch;
  try {
    const first = await checkForUpdate('0.1.0', directory, { fetcher: mock, now: 1000 });
    assert.equal(first.update_available, true); assert.equal(first.cached, false);
    const second = await checkForUpdate('0.2.0', directory, { fetcher: mock, now: 2000 });
    assert.equal(second.update_available, false); assert.equal(second.cached, true); assert.equal(calls, 1);
    await checkForUpdate('0.1.0', directory, { fetcher: mock, force: true, now: 3000 });
    assert.equal(calls, 2);
    await checkForUpdate('0.1.0', directory, { fetcher: mock, now: 3000 + 86400000 });
    assert.equal(calls, 3);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('missing releases, invalid metadata, network errors and rate limits are explicit', async () => {
  const directory = await temporaryDirectory();
  try {
    const check = (mock: typeof fetch) => checkForUpdate('0.1.0', directory, { force: true, fetcher: mock });
    const missing = await check(fetcher({}, 404));
    assert.equal(missing.latest_version, null);
    assert.equal(missing.release_url, 'https://github.com/OneOFF-ive/saplink/releases');
    await assert.rejects(check(fetcher({}, 403)), /HTTP 403/);
    await assert.rejects(check(fetcher({ ...release, html_url: 'https://evil.test/download' })), /invalid release metadata/);
    await assert.rejects(check(fetcher({ ...release, html_url: 'https://github.com/OneOFF-ive/another-repo/releases/tag/v0.2.0' })), /invalid release metadata/);
    await assert.rejects(check(fetcher({ ...release, prerelease: true })), /invalid release metadata/);
    await assert.rejects(check((async () => { throw new Error('offline'); }) as typeof fetch), /Could not reach GitHub/);
    await writeFile(join(directory, 'update-check.json'), 'broken cache');
    assert.equal((await checkForUpdate('0.1.0', directory, { fetcher: fetcher(release) })).update_available, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('cached metadata from a different repository is refreshed before exposing a download link', async () => {
  const directory = await temporaryDirectory();
  try {
    await writeFile(join(directory, 'update-check.json'), JSON.stringify({ checked_at: 1000,
      release: { ...release, html_url: 'https://github.com/OneOFF-ive/another-repo/releases/tag/v0.2.0' } }));
    let calls = 0;
    const result = await checkForUpdate('0.1.0', directory, { now: 2000,
      fetcher: (async () => { calls++; return new Response(JSON.stringify(release)); }) as typeof fetch });
    assert.equal(calls, 1);
    assert.equal(result.cached, false);
    assert.equal(result.release_url, release.html_url);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('CLI exposes cached update and download information in text and JSON modes', async () => {
  const directory = await temporaryDirectory();
  try {
    await checkForUpdate('0.1.0', directory, { fetcher: fetcher(release) });
    const execute = promisify(execFile);
    const env = { ...process.env, SAPLINK_CONFIG_DIR: directory, SAPLINK_UPDATE_URL: 'github' };
    const json = await execute(process.execPath, [resolve('dist/cli.js'), 'update', 'check', '--json'], { env, timeout: 20000 });
    const result = JSON.parse(json.stdout);
    assert.equal(json.stderr, '');
    assert.equal(result.status, 'success');
    assert.equal(result.data.latest_version, '0.2.0');
    assert.equal(result.data.release_url, release.html_url);
    assert.equal(result.data.cached, true);
    const text = await execute(process.execPath, [resolve('dist/cli.js'), 'update', 'check'], { env, timeout: 20000 });
    assert.match(text.stdout, /Release \/ download page: https:\/\/github.com/);
    assert.match(text.stdout, /--force/);
    assert.equal(text.stderr, '');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('automatic checks refresh metadata, notify once per version and stop cleanly', async () => {
  const directory = await temporaryDirectory();
  let calls = 0; let notices = 0;
  const automatic = startAutomaticUpdates('0.1.0', directory, {
    fetcher: (async () => { calls++; return new Response(JSON.stringify(release)); }) as typeof fetch,
    notify: () => { notices++; }
  });
  try {
    await automatic.initialCheck;
    await automatic.check();
    assert.equal(calls, 2); assert.equal(notices, 1);
    automatic.stop(); await automatic.check(); assert.equal(calls, 2);
  } finally { automatic.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('automatic checks can be disabled and failures stay isolated', async () => {
  const directory = await temporaryDirectory();
  let calls = 0;
  const offline = (async () => { calls++; throw new Error('offline'); }) as typeof fetch;
  const disabled = startAutomaticUpdates('0.1.0', directory, { disabled: true, fetcher: offline });
  const enabled = startAutomaticUpdates('0.1.0', directory, { fetcher: offline });
  try {
    await Promise.all([disabled.initialCheck, enabled.initialCheck]);
    assert.equal(calls, 1);
  } finally { disabled.stop(); enabled.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('stopping before a queued refresh prevents a new network request', async () => {
  const directory = await temporaryDirectory();
  let calls = 0;
  const automatic = startAutomaticUpdates('0.1.0', directory, {
    fetcher: (async () => { calls++; throw new Error('offline'); }) as typeof fetch
  });
  try {
    await automatic.initialCheck;
    assert.equal(calls, 1);
    const pending = automatic.check();
    automatic.stop();
    await pending;
    assert.equal(calls, 1);
  } finally { automatic.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('automatic timer schedules later checks without blocking the caller', async () => {
  const directory = await temporaryDirectory();
  let calls = 0;
  const automatic = startAutomaticUpdates('0.1.0', directory, { intervalMs: 15,
    fetcher: (async () => { calls++; throw new Error('offline'); }) as typeof fetch });
  try {
    await automatic.initialCheck;
    await new Promise(resolve => setTimeout(resolve, 70));
    assert.ok(calls >= 2);
    automatic.stop(); const stopped = calls;
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(calls, stopped);
  } finally { automatic.stop(); await rm(directory, { recursive: true, force: true }); }
});

const manifest = { schema_version: 1, version: '0.2.0', published_at: '2026-10-17T00:00:00Z', downloads: [{
  architecture: 'x64', sha256: 'a'.repeat(64),
  url: new URL('v0.2.0/SapLink-0.2.0-win-x64-setup.exe', defaultManifestUrl).href
}] };

test('COS is preferred, exposes verified download metadata and caches it', async () => {
  const directory = await temporaryDirectory();
  let calls = 0;
  try {
    const mock = (async (url, init) => {
      if (String(url).endsWith('/release-notes.json')) return new Response(JSON.stringify({schema_version:1, version:'0.2.0', title:'', notes:''}));
      calls++; assert.equal(url, defaultManifestUrl); assert.equal(init?.redirect, 'error');
      assert.equal(new Headers(init?.headers).has('Authorization'), false);
      return new Response(JSON.stringify(manifest));
    }) as typeof fetch;
    const first = await checkDualSource('0.1.0', directory, { fetcher: mock, now: 1000 });
    assert.equal(first.source, 'cos'); assert.equal(first.update_available, true);
    assert.deepEqual(first.downloads, manifest.downloads);
    const cached = await checkDualSource('1.0.1', directory, { fetcher: mock, now: 2000 });
    assert.equal(cached.cached, true); assert.equal(cached.update_available, false); assert.equal(calls, 1);
    await checkDualSource('0.1.0', directory, { fetcher: mock, now: 3000, force: true });
    assert.equal(calls, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unified COS manifest accepts skill metadata without treating it as an installer', async () => {
  const directory = await temporaryDirectory();
  const skill = { commit: 'b'.repeat(40), filename: 'SapLink-0.2.0-skill.zip',
    url: new URL('v0.2.0/SapLink-0.2.0-skill.zip', defaultManifestUrl).href,
    size: 1024, sha256: 'c'.repeat(64) };
  let calls = 0;
  try {
    const mock = (async (url) => {
      if (String(url).endsWith('/release-notes.json')) return new Response(JSON.stringify({schema_version:1, version:'0.2.0', title:'', notes:''}));
      calls++; assert.equal(url, defaultManifestUrl);
      return new Response(JSON.stringify({ ...manifest, skill }));
    }) as typeof fetch;
    const result = await checkDualSource('0.1.0', directory, { fetcher: mock, force: true });
    assert.equal(result.source, 'cos');
    assert.equal(result.update_available, true);
    assert.deepEqual(result.downloads, manifest.downloads);
    assert.equal(calls, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('missing, offline, oversized or unsafe COS metadata falls back to official GitHub', async () => {
  const directory = await temporaryDirectory();
  const invalid = [
    () => new Response('{}', { status: 404 }),
    () => { throw new Error('offline'); },
    () => new Response('x'.repeat(300 * 1024)),
    () => new Response(JSON.stringify({ ...manifest, version: '0.3.0-beta' })),
    () => new Response(JSON.stringify({ ...manifest, downloads: [{ ...manifest.downloads[0], url: 'https://evil.test/setup.exe' }] })),
    () => new Response(JSON.stringify({ ...manifest, downloads: [{ ...manifest.downloads[0], url: manifest.downloads[0].url.replace('win-x64', 'win-arm64') }] })),
    () => new Response(JSON.stringify({ ...manifest, downloads: [manifest.downloads[0], manifest.downloads[0]] }))
  ];
  try {
    for (const response of invalid) {
      const urls: string[] = [];
      const result = await checkDualSource('0.1.0', directory, { force: true, fetcher: (async url => {
        urls.push(String(url));
        return String(url) === defaultManifestUrl ? response() : new Response(JSON.stringify(release));
      }) as typeof fetch });
      assert.equal(result.source, 'github');
      assert.deepEqual(urls, [defaultManifestUrl, 'https://api.github.com/repos/OneOFF-ive/saplink/releases/latest']);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('changing configured manifest invalidates cache and download origin is scoped', async () => {
  const directory = await temporaryDirectory();
  const customUrl = 'https://updates.example.org/saplink/latest.json';
  const customManifest = { ...manifest, downloads: [{ ...manifest.downloads[0], url: new URL('v0.2.0/SapLink-0.2.0-win-x64-setup.exe', customUrl).href }] };
  try {
    await checkDualSource('0.1.0', directory, { now: 1000, fetcher: fetcher(manifest) });
    let calls = 0;
    const changed = await checkDualSource('0.1.0', directory, { now: 2000, manifestUrl: customUrl, fetcher: (async url => {
      if (String(url).endsWith('/release-notes.json')) return new Response(JSON.stringify({schema_version:1, version:'0.2.0', title:'', notes:''}));
      calls++; assert.equal(url, customUrl); return new Response(JSON.stringify(customManifest));
    }) as typeof fetch });
    assert.equal(calls, 1); assert.equal(changed.cached, false); assert.equal(changed.source, 'cos');
    await assert.rejects(checkDualSource('0.1.0', directory, { manifestUrl: 'https://user:secret@example.org/latest.json' }), /UPDATE_SOURCE_INVALID|must be an HTTPS/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('cancellation during COS failure prevents a fallback request', async () => {
  const directory = await temporaryDirectory();
  const controller = new AbortController();
  let calls = 0;
  try {
    await assert.rejects(checkDualSource('0.1.0', directory, { signal: controller.signal, fetcher: (async () => {
      calls++; controller.abort(); throw new Error('cancelled');
    }) as typeof fetch }));
    assert.equal(calls, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test('startup bypasses a fresh old COS cache and subsequent checks discover newly published versions', async () => {
  const directory = await temporaryDirectory();
  await checkDualSource('0.1.0', directory, { fetcher: fetcher(manifest) });
  let version = '0.3.0';
  let calls = 0;
  const automatic = startDualAutomatic('0.1.0', directory, { fetcher: (async url => {
    if (String(url).endsWith('/release-notes.json')) return new Response(JSON.stringify({schema_version:1, version, title:'', notes:''}));
    calls++;
    return new Response(JSON.stringify({ ...manifest, version, downloads: [{ ...manifest.downloads[0],
      url: new URL(`v${version}/SapLink-${version}-win-x64-setup.exe`, defaultManifestUrl).href }] }));
  }) as typeof fetch });
  try {
    await automatic.initialCheck;
    const { getAutomaticUpdate } = await import('../src/updates.js');
    assert.equal(getAutomaticUpdate()?.latest_version, '0.3.0');
    assert.equal(getAutomaticUpdate()?.cached, false);
    version = '0.4.0';
    await automatic.check();
    assert.equal(getAutomaticUpdate()?.latest_version, '0.4.0');
    assert.equal(calls, 2);
  } finally { automatic.stop(); await rm(directory, { recursive: true, force: true }); }
});


test('the published 1.0.4 strict schema accepts the installer manifest without skill metadata', async () => {
  const { z } = await import('zod');
  // Preserve the published client's contract; changing today's parser cannot repair old installations.
  const legacy = z.object({ schema_version: z.literal(1), version: z.string().regex(/^\d+\.\d+\.\d+$/),
    published_at: z.string().datetime(), downloads: z.array(z.object({ architecture: z.enum(['x64', 'arm64']),
      url: z.string().url(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(2) }).strict();
  assert.equal(legacy.safeParse(manifest).success, true);
  assert.equal(legacy.safeParse({ ...manifest, skill: {} }).success, false);
  const directory = await temporaryDirectory();
  try {
    const result = await checkDualSource('0.1.0', directory, { force: true, fetcher: fetcher(manifest) });
    assert.equal(result.source, 'cos');
    assert.equal(result.update_available, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('COS release title and notes match the detected version, survive cache and never require GitHub', async () => {
  const directory = await temporaryDirectory();
  const urls: string[] = [];
  const notesUrl = new URL('v0.2.0/release-notes.json', defaultManifestUrl).href;
  const mock = (async url => {
    urls.push(String(url));
    assert.ok([defaultManifestUrl, notesUrl].includes(String(url)));
    return new Response(JSON.stringify(String(url) === defaultManifestUrl ? manifest : {
      schema_version: 1, version: '0.2.0', title: 'SapLink 更新', notes: '## 修复\n- 问题一'
    }));
  }) as typeof fetch;
  try {
    const result = await checkDualSource('0.1.0', directory, { fetcher: mock });
    assert.equal(result.release_title, 'SapLink 更新');
    assert.equal(result.release_notes, '## 修复\n- 问题一');
    const cached = await checkDualSource('0.1.0', directory, { fetcher: mock });
    assert.equal(cached.release_notes, result.release_notes);
    assert.equal(cached.cached, true);
    assert.deepEqual(urls, [defaultManifestUrl, notesUrl]);
    for (const notes of [{schema_version: 1, version: '0.3.0', title: 'wrong', notes: 'wrong'}, {},
      {schema_version: 1, version: '0.2.0', title: 'large', notes: 'x'.repeat(64001)}]) {
      const missing = await checkDualSource('0.1.0', directory, { force: true,
        fetcher: (async url => new Response(JSON.stringify(String(url) === defaultManifestUrl ? manifest : notes))) as typeof fetch });
      assert.equal(missing.update_available, true);
      assert.equal(missing.release_notes, undefined);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('cached fallback remains usable and forced checks retry COS first', async () => {
  const directory = await temporaryDirectory();
  try {
    await writeFile(join(directory, 'update-check.json'), JSON.stringify({ checked_at: 1000,
      manifest_url: defaultManifestUrl, source: 'github', release, downloads: [] }));
    const urls: string[] = [];
    const result = await checkDualSource('0.2.0', directory, { now: 2000, force: true,
      fetcher: (async url => { urls.push(String(url)); return new Response(JSON.stringify(manifest)); }) as typeof fetch });
    assert.equal(result.source, 'cos');
    assert.equal(result.cached, false);
    assert.deepEqual(urls, [defaultManifestUrl]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('CLI text and JSON both expose COS release title and multiline notes', async () => {
  const directory = await temporaryDirectory();
  const title = 'SapLink 9.0.0 更新';
  const notes = '## 更新内容\n- 优化查询\n- 修复问题';
  const newer = { ...manifest, version: '9.0.0', downloads: [{ ...manifest.downloads[0],
    url: new URL('v9.0.0/SapLink-9.0.0-win-x64-setup.exe', defaultManifestUrl).href }] };
  try {
    await checkDualSource('1.0.0', directory, { fetcher: (async url => {
      assert.ok(String(url).startsWith(new URL('.', defaultManifestUrl).href));
      return new Response(JSON.stringify(String(url) === defaultManifestUrl ? newer : {
        schema_version: 1, version: '9.0.0', title, notes
      }));
    }) as typeof fetch });
    const execute = promisify(execFile);
    const env = { ...process.env, SAPLINK_CONFIG_DIR: directory, SAPLINK_UPDATE_URL: defaultManifestUrl };
    const json = await execute(process.execPath, [resolve('dist/cli.js'), 'update', 'check', '--json'], { env, timeout: 20000 });
    const result = JSON.parse(json.stdout);
    assert.equal(result.status, 'success');
    assert.equal(result.data.source, 'cos');
    assert.equal(result.data.update_available, true);
    assert.equal(result.data.release_title, title);
    assert.equal(result.data.release_notes, notes);
    const text = await execute(process.execPath, [resolve('dist/cli.js'), 'update', 'check'], { env, timeout: 20000 });
    assert.ok(text.stdout.includes('Release title: ' + title));
    assert.ok(text.stdout.includes('Release notes:\n' + notes));
    assert.equal(text.stderr, '');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('GitHub fallback exposes verified official installer digests and matching release prose', async () => {
  const directory = await temporaryDirectory();
  const url = 'https://github.com/OneOFF-ive/saplink/releases/download/v0.2.0/SapLink-0.2.0-win-x64-setup.exe';
  const metadata = {...release, name:'更新标题', body:'修复说明', assets:[
    {name:'SapLink-0.2.0-win-x64-setup.exe',browser_download_url:url,digest:'sha256:'+'a'.repeat(64)},
    {name:'SapLink-0.2.0-win-arm64-setup.exe',browser_download_url:url,digest:null}
  ]};
  try {
    const result = await checkDualSource('0.1.0', directory, {fetcher:(async target =>
      String(target) === defaultManifestUrl ? new Response('{}',{status:503}) : new Response(JSON.stringify(metadata))) as typeof fetch});
    assert.equal(result.source,'github');
    assert.equal(result.release_title,'更新标题');
    assert.equal(result.release_notes,'修复说明');
    assert.deepEqual(result.downloads,[{architecture:'x64',url,sha256:'a'.repeat(64)}]);
    const cached = await checkDualSource('0.1.0',directory,{fetcher:(async()=>{throw new Error('must use cache')}) as typeof fetch});
    assert.equal(cached.cached,true);
    assert.deepEqual(cached.downloads,result.downloads);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('missing COS prose falls back to the same GitHub tag without replacing COS installer metadata', async () => {
  const directory = await temporaryDirectory(); const urls:string[]=[];
  try {
    const result=await checkDualSource('0.1.0',directory,{fetcher:(async url=>{
      urls.push(String(url));
      if(String(url)===defaultManifestUrl)return new Response(JSON.stringify(manifest));
      if(String(url).endsWith('/release-notes.json'))return new Response('{}',{status:404});
      return new Response(JSON.stringify({...release,name:'后备标题',body:'后备说明'}));
    }) as typeof fetch});
    assert.equal(result.source,'cos'); assert.equal(result.release_notes,'后备说明');
    assert.deepEqual(result.downloads,manifest.downloads);
    assert.equal(urls[2],'https://api.github.com/repos/OneOFF-ive/saplink/releases/tags/v0.2.0');
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('MCP restarts trigger checks without blocking the listener or queueing overlapping checks', {timeout: 20000}, async () => {
  const {startRuntimeUpdateChecks} = await import('../src/updates.js');
  const {startHttp} = await import('../src/server.js');
  const {ConfigStore} = await import('../src/config.js');
  const {Operations} = await import('../src/operations.js');
  const directory = await temporaryDirectory();
  const store = new ConfigStore(directory);
  const credentials = {get: async () => '', set: async () => {}, remove: async () => {}};
  let calls = 0;
  let nextRequest: (() => void) | undefined;
  let enter!: () => void;
  const entered = new Promise<void>(resolve => {enter = resolve;});
  let finish!: (value: Response) => void;
  let completed!: () => void;
  const checked = new Promise<void>(resolve => {completed = resolve;});
  const automatic = startRuntimeUpdateChecks(directory, {manifestUrl: null, fetcher: (async () => {
    calls++;
    if (calls === 2) {enter(); return new Promise<Response>(resolve => {finish = resolve;});}
    if (calls > 2) { nextRequest?.(); throw new Error('update source offline'); }
    return new Response(JSON.stringify({...release,tag_name:'v9.0.0'}));
  }) as typeof fetch, notify: result => {if (result.latest_version === '9.1.0') completed();}});
  let runtime: Awaited<ReturnType<typeof startHttp>> | undefined;
  try {
    await automatic.initialCheck;
    assert.equal(startRuntimeUpdateChecks(directory), automatic, 'reuse the existing scheduler');
    runtime = await startHttp(store, new Operations(store, credentials), 0);
    await entered;
    const address = runtime.listener.address() as {port: number};
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/mcp`)).status, 401, 'MCP responds while update check is pending');
    await runtime.close(); runtime = undefined;
    runtime = await startHttp(store, new Operations(store, credentials), 0);
    assert.equal(calls, 2, 'restart during an active check neither duplicates nor queues');
    finish(new Response(JSON.stringify({...release,tag_name:'v9.1.0'})));
    await checked;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 2, 'finishing the existing check does not schedule a follow-up');
    await automatic.check();
    assert.equal(calls, 3, 'no queued check after the in-flight check finishes');
    // Failed background checks do not stop the listener.
    const next = runtime.listener.address() as {port:number};
    assert.equal((await fetch(`http://127.0.0.1:${next.port}/mcp`)).status, 401);
    await runtime.close(); runtime = undefined;
    const freshCheck = new Promise<void>(resolve => { nextRequest = resolve; });
    runtime = await startHttp(store, new Operations(store, credentials), 0);
    await freshCheck;
    assert.equal(calls, 4, 'a later restart triggers another check');
  } finally {
    automatic.stop();
    await runtime?.close();
    await rm(directory, {recursive:true, force:true});
  }
});
