import test from 'node:test';
import assert from 'node:assert/strict';
import { access, copyFile, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import { previewEnvironment, previewRfcEnvironment, previewRuntimeEnvironment } from '../scripts/dev-environment.mjs';
import { credentialService, WindowsCredentials } from '../dist/config.js';
import { randomUUID } from 'node:crypto';
import { defaultMcpPort, defaultUiPort } from '../dist/paths.js';

test('preview configuration, logs and ports are separate from installed state', async t => {
  const root = await mkdtemp(join(tmpdir(), 'saplink-preview-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = await previewEnvironment({ APPDATA: root });
  assert.equal(env.SAPLINK_CONFIG_DIR, join(root, 'saplink-3.0-dev'));
  assert.equal(env.SAPLINK_LOG_DIR, join(root, 'saplink-3.0-dev', 'logs'));
  assert.equal(env.SAPLINK_UI_PORT, '18766');
  assert.equal(env.SAPLINK_DEV_PREVIEW, '1');
  assert.equal(env.SAPLINK_WINDOWS_LAUNCHER, undefined);
  for (const directory of [join(root, 'saplink'), join(root, 'saplink', 'child'), root]) {
    await assert.rejects(previewEnvironment({ APPDATA: root, SAPLINK_DEV_CONFIG_DIR: directory }), { code: 'DEV_DIRECTORY_CONFLICT' });
  }
  await assert.rejects(previewEnvironment({ APPDATA: root, SAPLINK_CONFIG_DIR: join(root, 'custom'),
    SAPLINK_DEV_CONFIG_DIR: join(root, 'custom') }), { code: 'DEV_DIRECTORY_CONFLICT' });
  await mkdir(join(root, 'saplink'));
  if (process.platform !== 'win32') {
    await symlink(join(root, 'saplink'), join(root, 'alias'), 'dir');
    await assert.rejects(previewEnvironment({ APPDATA: root, SAPLINK_DEV_CONFIG_DIR: join(root, 'alias') }),
      { code: 'DEV_DIRECTORY_CONFLICT' });
    await mkdir(join(root, 'saplink-3.0-dev'));
    await symlink(join(root, 'saplink'), join(root, 'saplink-3.0-dev', 'logs'), 'dir');
    await assert.rejects(previewEnvironment({ APPDATA: root }), { code: 'DEV_DIRECTORY_CONFLICT' });
  }
});

test('preview CLI reuses only a verified matching installed RFC runtime', async t => {
  const root = await mkdtemp(join(tmpdir(), 'saplink-preview-rfc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const src = join(root, 'app', 'bridge', 'src'), classes = join(root, 'app', 'bridge', 'classes');
  const java = join(root, 'runtime', 'java', 'bin'), jco = join(root, 'runtime', 'jco');
  await Promise.all([mkdir(src, { recursive: true }), mkdir(classes, { recursive: true }),
    mkdir(java, { recursive: true }), mkdir(jco, { recursive: true })]);
  await writeFile(join(root, 'install-manifest.json'), JSON.stringify({ app_id: 'org.saplink.desktop', schema_version: 1 }));
  await writeFile(join(root, 'runtime', 'rfc-runtime.json'), JSON.stringify({ schema_version: 1, jar_file: 'sapjco3.jar' }));
  await copyFile(join('bridge', 'src', 'SapLinkRfcBridge.java'), join(src, 'SapLinkRfcBridge.java'));
  await writeFile(join(java, 'java.exe'), '');
  await writeFile(join(jco, 'sapjco3.jar'), '');
  const env = await previewRfcEnvironment({ SAPLINK_DEV_PREVIEW: '1' }, root);
  assert.equal(env.SAPLINK_RFC_JAVA, join(java, 'java.exe'));
  assert.equal(env.SAPLINK_RFC_JCO_JAR, join(jco, 'sapjco3.jar'));
  assert.equal(env.SAPLINK_RFC_BRIDGE_CLASSES, classes);
  const automaticRoot = await mkdtemp(join(tmpdir(), 'saplink-preview-auto-'));
  t.after(() => rm(automaticRoot, {recursive:true,force:true}));
  const automaticInstall = join(automaticRoot,'Programs','SapLink');
  await mkdir(join(automaticRoot,'Programs'),{recursive:true});
  const { cp } = await import('node:fs/promises');
  await cp(root,automaticInstall,{recursive:true});
  const automatic = await previewRuntimeEnvironment({LOCALAPPDATA:automaticRoot},'win32');
  assert.equal(automatic.SAPLINK_RFC_JAVA,join(automaticInstall,'runtime','java','bin','java.exe'));
  assert.equal(automatic.SAPLINK_RFC_JCO_JAR,join(automaticInstall,'runtime','jco','sapjco3.jar'));
  const explicit={LOCALAPPDATA:automaticRoot,SAPLINK_RFC_JAVA:'custom-java'};
  assert.deepEqual(await previewRuntimeEnvironment(explicit,'win32'),explicit);
  assert.deepEqual(await previewRuntimeEnvironment({LOCALAPPDATA:automaticRoot},'linux'),{LOCALAPPDATA:automaticRoot});
  await writeFile(join(src, 'SapLinkRfcBridge.java'), 'different');
  await assert.rejects(previewRfcEnvironment({}, root), { code: 'DEV_BRIDGE_MISMATCH' });
  await writeFile(join(automaticInstall,'app','bridge','src','SapLinkRfcBridge.java'),'different');
  await assert.rejects(previewRuntimeEnvironment({LOCALAPPDATA:automaticRoot},'win32'),{code:'DEV_BRIDGE_MISMATCH'});
});

test('credential namespaces and default ports differ between installed and preview mode', () => {
  const previous = process.env.SAPLINK_DEV_PREVIEW;
  try {
    delete process.env.SAPLINK_DEV_PREVIEW;
    assert.equal(credentialService(), 'saplink');
    assert.equal(defaultMcpPort(), 8765);
    assert.equal(defaultUiPort(), 8766);
    process.env.SAPLINK_DEV_PREVIEW = '1';
    assert.equal(credentialService(), 'saplink-3.0-dev');
    assert.equal(defaultMcpPort(), 18765);
    assert.equal(defaultUiPort(), 18766);
  } finally {
    if (previous === undefined) delete process.env.SAPLINK_DEV_PREVIEW;
    else process.env.SAPLINK_DEV_PREVIEW = previous;
  }
});

test('missing preview SAP credential gives actionable guidance', { skip: process.platform !== 'win32' }, async () => {
  const previous = process.env.SAPLINK_DEV_PREVIEW;
  try {
    process.env.SAPLINK_DEV_PREVIEW = '1';
    await assert.rejects(new WindowsCredentials().get(randomUUID()), error => {
      assert.equal(error.code, 'SAP_CREDENTIAL_MISSING');
      assert.match(error.message, /开发预览.*编辑连接.*重新输入密码/);
      return true;
    });
  } finally {
    if (previous === undefined) delete process.env.SAPLINK_DEV_PREVIEW;
    else process.env.SAPLINK_DEV_PREVIEW = previous;
  }
});

test('direct checkout CLI refuses to use the installed default directory', async t => {
  const root = await mkdtemp(join(tmpdir(), 'saplink-direct-guard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env, APPDATA: root, SAPLINK_CONFIG_DIR: undefined, SAPLINK_DEV_PREVIEW: undefined };
  await assert.rejects(promisify(execFile)(process.execPath, ['dist/cli.js', 'app', 'start', '--json'],
    { env, windowsHide: true }), error => {
    assert.equal(JSON.parse(error.stdout).error.code, 'DEV_CONFIG_REQUIRED');
    return true;
  });
  await assert.rejects(access(join(root, 'saplink')), { code: 'ENOENT' });
});

test('preview host restart leaves an independent installed host running', { timeout: 90000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'saplink-host-isolation-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const prod = join(root, 'saplink');
  const env = { ...process.env, APPDATA: root, SAPLINK_CONFIG_DIR: prod, SAPLINK_AUTO_UPDATE_CHECK: '0',
    SAPLINK_WINDOWS_LAUNCHER: undefined, SAPLINK_DEV_PREVIEW: undefined, SAPLINK_DEV_CONFIG_DIR: undefined };
  const execute = promisify(execFile);
  const port = () => new Promise((resolve, reject) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const number = server.address().port;
      server.close(error => error ? reject(error) : resolve(number));
    });
    server.on('error', reject);
  });
  const run = async (entry, ...args) => JSON.parse((await execute(process.execPath, [entry, ...args, '--json'],
    { env, windowsHide: true, timeout: 30000 })).stdout).data;
  const installed = (...args) => run('dist/cli.js', ...args);
  const preview = (...args) => run('scripts/dev-cli.mjs', ...args);
  try {
    const stable = await installed('app', 'start', '--port', String(await port()));
    assert.equal(stable.state, 'running');
    const dev = await preview('app', 'start', '--port', String(await port()));
    assert.equal(dev.state, 'running');
    assert.equal(dev.port, 18765);
    assert.notEqual(dev.pid, stable.pid);
    await preview('app', 'restart');
    const compiled = await run('scripts/dev-cli.mjs', '--compiled', 'app', 'status');
    assert.equal(compiled.state, 'running');
    assert.notEqual(compiled.pid, stable.pid);
    const after = await installed('app', 'status');
    assert.equal(after.state, 'running');
    assert.equal(after.pid, stable.pid);
  } finally {
    await preview('app', 'stop');
    await installed('app', 'stop');
  }
});
