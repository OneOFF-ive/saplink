import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const exec = promisify(execFile);
test('NSIS waits for PowerShell process exit and retains Unicode diagnostics without output pipes',
  { skip: process.platform !== 'win32' }, async t => {
    const compiler = resolve('.saplink/installer-cache/nsis-3.12/makensis.exe');
    try { await access(compiler); } catch { t.skip('NSIS compiler is not cached'); return; }
    const directory = await mkdtemp(join(tmpdir(), 'saplink-control-test-'));
    t.after(async () => { assert.equal(dirname(directory), tmpdir()); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
    const helper = join(directory, 'helper.ps1');
    const result = join(directory, 'result.txt');
    const executable = join(directory, 'probe.exe');
    await writeFile(helper, "\uFEFFparam($Action,$InstallDirectory,$ReportPath,[int]$Code)\n[IO.File]::WriteAllText($ReportPath, ('中文诊断 code=' + $Code), [Text.Encoding]::Unicode)\nWrite-Output 'console output is not used for completion'\nexit $Code\n", 'utf8');
    const controlHost = join(directory, 'installer-host.exe');
    const csc = join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET/Framework/v4.0.30319/csc.exe');
    await exec(csc, ['/nologo', '/target:winexe', '/platform:anycpu', '/define:GUI', '/out:' + controlHost,
      resolve('packaging/windows/Launcher.cs'), resolve('packaging/windows/InstallerControlHost.cs')], {windowsHide:true});
    const macro = resolve('packaging/windows/installer-control.nsh');
    const script = [
      'Unicode true', 'RequestExecutionLevel user', 'SilentInstall silent',
      'OutFile "' + executable + '"',
      '!include "LogicLib.nsh"', '!include "FileFunc.nsh"',
      '!include "' + macro + '"',
      'Section', 'InitPluginsDir', 'SetOutPath "$PLUGINSDIR"',
      'File /oname=installer-host.exe "' + controlHost + '"',
      '${GetParameters} $R0', '${GetOptions} $R0 "/CASE=" $R1',
      '!insertmacro RunInstallerControl "' + helper + '" \'-Action Check -InstallDirectory "' + directory + '" -Code $R1\'',
      'FileOpen $3 "' + result + '" w',
      'FileWriteUTF16LE $3 "$0|$1"',
      'FileClose $3', 'SectionEnd'
    ].join('\n');
    const source = join(directory, 'probe.nsi');
    await writeFile(source, script);
    await exec(compiler, ['/V2', source], { windowsHide: true });
    for (const code of [0, 10]) {
      await exec(executable, ['/S', '/CASE=' + code], { windowsHide: true });
      const report = (await readFile(result, 'utf16le')).replace(/\uFEFF/g, '');
      assert.equal(report, code + '|中文诊断 code=' + code);
    }
  });

test('real installer precheck writes diagnostics for failures before any payload mutation',
  { skip: process.platform !== 'win32' }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'saplink-precheck-test-'));
    t.after(async () => { assert.equal(dirname(directory), tmpdir()); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
    const report = join(directory, 'report.txt');
    const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'SysWOW64/WindowsPowerShell/v1.0/powershell.exe');
    const helper = resolve('packaging/windows/installer-control.ps1');
    await assert.rejects(exec(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', helper, '-Action', 'Check', '-InstallDirectory', 'C:\\invalid;directory',
      '-ReportPath', report], { windowsHide: true }), error => (error as { code?: number }).code === 1);
    const text = await readFile(report, 'utf16le');
    assert.match(text, /安装控制脚本失败/);
    assert.match(text, /dedicated application directory/);
    const empty = join(directory, 'empty');
    await mkdir(empty);
    await exec(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', helper, '-Action', 'Check', '-InstallDirectory', empty, '-TestMode'],
      { windowsHide: true, env: { ...process.env, SAPLINK_CONFIG_DIR: join(directory, 'config') } });
  });

