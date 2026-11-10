import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const exec = promisify(execFile);

test('Windows launcher distinguishes missing components and process errors, and preserves CLI execution',
  { skip: process.platform !== 'win32' }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'saplink-launcher-'));
    t.after(async () => { assert.equal(dirname(root), tmpdir()); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
    const install = join(root, '自定义安装 with spaces');
    const bin = join(install, 'bin'), runtime = join(install, 'runtime'), app = join(install, 'app', 'dist');
    await mkdir(bin, { recursive: true }); await mkdir(runtime); await mkdir(app, { recursive: true });
    const launcher = join(bin, 'saplink.exe'), node = join(runtime, 'node.exe'), cli = join(app, 'cli.js');
    const compiler = join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe');
    await exec(compiler, ['/nologo', '/target:exe', '/platform:anycpu', '/out:' + launcher,
      resolve('packaging', 'windows', 'Launcher.cs')], { windowsHide: true });
    const run = (...args: string[]) => spawnSync(launcher, args, { cwd: root, encoding: 'utf8', windowsHide: true });
    let result = run('version');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /could not find or access its bundled Node\.js runtime/);
    await copyFile(process.execPath, node);
    result = run('version');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /could not find or access its CLI entry point/);
    await writeFile(cli, 'console.log(JSON.stringify({args: process.argv.slice(2), cwd: process.cwd(), launcher: process.env.SAPLINK_WINDOWS_LAUNCHER})); process.exitCode = 7;');
    result = run('中文', 'two words', 'trailing\\');
    assert.equal(result.status, 7);
    assert.deepEqual(JSON.parse(result.stdout), { args: ['中文', 'two words', 'trailing\\'], cwd: root, launcher });
    const direct = spawnSync(node, [cli, 'version', '--json'], { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(direct.status, 7);
    assert.deepEqual(JSON.parse(direct.stdout).args, ['version', '--json']);
    await writeFile(node, 'not a Windows executable');
    result = run('version');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /could not start its bundled Node\.js process \(Windows error \d+\)/);
    assert.doesNotMatch(result.stderr, /runtime is required|could not find or access its bundled/);
  });
