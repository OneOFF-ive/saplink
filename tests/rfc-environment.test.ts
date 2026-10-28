import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { discoverRfcEnvironment, saveRfcEnvironment, checkRfcEnvironment } from '../src/rfc-environment.js';

async function fixture() {
  const testRoot = resolve('.saplink/tests'); await mkdir(testRoot, { recursive: true });
  const root = await mkdtemp(join(testRoot, 'rfc-env-'));
  const appRoot = join(root, 'install', 'app'), directory = join(root, 'config');
  const options = { directory, appRoot, env: {}, platform: 'win32' as const };
  const file = async (path: string) => { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, 'fixture'); };
  return { root, appRoot, directory, options, file, close: () => rm(root, { recursive: true, force: true }) };
}
test('RFC discovery prefers private settings, explicit environment, bundled Java, then system Java', async () => {
  const f = await fixture();
  try {
    const bundled = join(f.root, 'install', 'runtime', 'java', 'bin', 'java.exe'); await f.file(bundled);
    const systemHome = join(f.root, 'system-java'); await f.file(join(systemHome, 'bin', 'java.exe'));
    let detected = discoverRfcEnvironment({ ...f.options, env: { JAVA_HOME: systemHome } });
    assert.equal(detected.java?.source, 'bundled'); assert.equal(detected.java?.path, bundled);
    detected = discoverRfcEnvironment({ ...f.options, env: { SAPLINK_RFC_JAVA: join(systemHome, 'bin', 'java.exe') } });
    assert.equal(detected.java?.source, 'environment');
    await saveRfcEnvironment(f.directory, { java_home: join(f.root, 'chosen') });
    detected = discoverRfcEnvironment({ ...f.options, env: { SAPLINK_RFC_JAVA: join(systemHome, 'bin', 'java.exe') } });
    assert.equal(detected.java?.source, 'settings');
    assert.equal(detected.java?.path, join(f.root, 'chosen', 'bin', 'java.exe'), 'invalid explicit paths must not silently fall back');
    await saveRfcEnvironment(f.directory, {}); await rm(bundled);
    assert.equal(discoverRfcEnvironment({ ...f.options, env: { JAVA_HOME: systemHome } }).java?.source, 'system');
  } finally { await f.close(); }
});
test('JCo auto-detection requires a paired JAR and native library and retains explicit overrides', async () => {
  const f = await fixture();
  try {
    const home = join(f.directory, 'jco'); await f.file(join(home, 'sapjco3.jar'));
    assert.equal(discoverRfcEnvironment(f.options).jar, undefined);
    await f.file(join(home, 'sapjco3.dll'));
    const paired = discoverRfcEnvironment(f.options);
    assert.equal(paired.jar?.path, join(home, 'sapjco3.jar')); assert.equal(paired.native?.path, home);
    const explicit = discoverRfcEnvironment({ ...f.options, env: { SAPLINK_RFC_JCO_JAR: join(f.root, 'explicit.jar') } });
    assert.equal(explicit.jar?.source, 'environment'); assert.equal(explicit.native, undefined);
    await saveRfcEnvironment(f.directory, { jco_directory: join(f.root, 'custom') });
    assert.equal(discoverRfcEnvironment(f.options).jar?.path, join(f.root, 'custom', 'sapjco3.jar'));
    for (const value of [{ java_home: 'relative' }, { jco_directory: '../secret' }, { password: 'not-supported' }])
      await assert.rejects(saveRfcEnvironment(f.directory, value));
  } finally { await f.close(); }
});
test('environment checks report missing components without SAP access or launching an incomplete runtime', async () => {
  const f = await fixture();
  try {
    const result = await checkRfcEnvironment(f.options);
    assert.equal(result.healthy, false); assert.equal(result.sap_connected, false); assert.equal(result.versions, undefined);
    assert.ok(result.checks.some(check => check.name === 'jco' && !check.passed));
    await mkdir(f.directory, { recursive: true }); await writeFile(join(f.directory, 'rfc-runtime.json'), '{}garbage');
    assert.throws(() => discoverRfcEnvironment(f.options), /配置无效/);
  } finally { await f.close(); }
});


test('installed complete runtime ignores stale settings and inherited component overrides, and never falls back', async () => {
  const f = await fixture();
  try {
    const runtime = join(f.root, 'install', 'runtime');
    await f.file(join(runtime, 'java', 'bin', 'java.exe'));
    await f.file(join(runtime, 'jco', 'sapjco3.jar'));
    await f.file(join(runtime, 'jco', 'sapjco3.dll'));
    await writeFile(join(runtime, 'rfc-runtime.json'), JSON.stringify({schema_version: 1, architecture: 'x64'}));
    await mkdir(f.directory, {recursive: true});
    await writeFile(join(f.directory, 'rfc-runtime.json'), 'stale broken settings');
    const options = {...f.options, env: {SAPLINK_RFC_JAVA: 'invalid', SAPLINK_RFC_JCO_JAR: 'invalid', SAPLINK_RFC_NATIVE_DIR: 'invalid', SAPLINK_RFC_BRIDGE_CLASSES: 'invalid'}};
    let result = discoverRfcEnvironment(options);
    assert.equal(result.managed, true);
    assert.equal(result.java?.source, 'bundled');
    assert.equal(result.jar?.source, 'bundled');
    assert.equal(result.native?.source, 'bundled');
    assert.equal(result.classes, join(f.appRoot, 'bridge', 'classes'));
    await f.file(join(runtime, 'jco', 'com.sap.conn.jco_3.1.14.jar'));
    await writeFile(join(runtime, 'rfc-runtime.json'), JSON.stringify({schema_version:1, architecture:'x64', jar_file:'com.sap.conn.jco_3.1.14.jar'}));
    result = discoverRfcEnvironment(options);
    assert.equal(result.jar?.path, join(runtime, 'jco', 'com.sap.conn.jco_3.1.14.jar'));
    await rm(join(runtime, 'jco', 'sapjco3.dll'));
    result = discoverRfcEnvironment(options);
    assert.equal(result.native?.source, 'bundled');
    const checked = await checkRfcEnvironment(options);
    assert.equal(checked.healthy, false);
    assert.equal(checked.managed, true);
    assert.ok(checked.checks.some(c => c.name === 'native' && !c.passed));
    for (const invalid of ['{}', 'null', 'broken', JSON.stringify({schema_version:1,architecture:'x64',jar_file:'../../escape.jar'})]) {
      await writeFile(join(runtime, 'rfc-runtime.json'), invalid);
      assert.throws(() => discoverRfcEnvironment(options), {code:'RFC_ENVIRONMENT_INVALID'});
    }
  } finally {await f.close();}
});
