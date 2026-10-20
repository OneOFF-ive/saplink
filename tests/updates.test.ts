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

test('missing, offline, oversized or unsafe COS metadata falls back to GitHub', async () => {
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
      assert.equal(result.source, 'github'); assert.deepEqual(result.downloads, []);
      assert.equal(result.latest_version, '0.2.0'); assert.equal(urls.length, 2);
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
  const automatic = startDualAutomatic('0.1.0', directory, { fetcher: (async () => {
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
