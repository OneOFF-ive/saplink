// Launch the current source build through the supported managed-host lifecycle.
// The session secret is passed privately to the browser launcher, never printed.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { previewEnvironment, previewRuntimeEnvironment } from './dev-environment.mjs';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
let stage = 'build';
try {
  Object.assign(process.env, await previewEnvironment());
  delete process.env.SAPLINK_WINDOWS_LAUNCHER;
  await execute(process.execPath, [join(root, 'node_modules/typescript/bin/tsc')], { cwd: root, windowsHide: true, timeout: 60000 });
  stage = 'load';
  const { ConfigStore } = await import('../dist/config.js');
  const { serviceStatus, restartApplication, openServiceUi } = await import('../dist/service.js');
  const config = new ConfigStore();
  stage = 'inspect_host';
  const before = await serviceStatus(config.directory);
  if (before.lease.guard_present || (before.state !== 'stopped' && (before.state !== 'running' || !before.managed)))
    throw Object.assign(new Error(), { code: 'DEV_HOST_NOT_MANAGED' });
  if (before.state === 'running' && (before.ui_port === 8766 || before.port === 8765))
    throw Object.assign(new Error(), { code: 'DEV_HOST_PORT_CONFLICT' });

  // A source checkout has no RFC payload. Reuse only a verified matching
  // SapLink installation for this process; never edit global runtime settings.
  stage = 'verify_rfc_runtime';
  Object.assign(process.env, await previewRuntimeEnvironment(process.env));
  // The installed launcher would spawn the installed CLI. Spawn this checkout's
  // compiled CLI instead and preserve the host's prior MCP mode and ports.
  delete process.env.SAPLINK_WINDOWS_LAUNCHER;
  process.env.SAPLINK_AUTO_UPDATE_CHECK = '0';
  stage = 'restart_host';
  await restartApplication(config.directory, before.ui_port ?? 18766);
  const host = await serviceStatus(config.directory);
  stage = 'open_session';
  const session = await openServiceUi(config.directory, host.ui_port ?? 18766);
  const url = new URL(session.url);
  const headers = { 'X-Admin-Token': url.hash.slice(1) };
  stage = 'verify_agent';
  const modelResponse = await fetch(url.origin + '/api/agent/model', { headers, signal: AbortSignal.timeout(10000) });
  if (!modelResponse.ok) throw Object.assign(new Error(), { code: 'DEV_AGENT_NOT_READY' });
  const model = await modelResponse.json();
  stage = 'verify_extensions';
  const extensionsResponse = await fetch(url.origin + '/api/agent/extensions', { headers, signal: AbortSignal.timeout(10000) });
  if (!extensionsResponse.ok) throw Object.assign(new Error(), { code: 'DEV_EXTENSIONS_NOT_READY' });
  const extensions = await extensionsResponse.json();
  if (!Array.isArray(extensions.skills) || !Array.isArray(extensions.mcp))
    throw Object.assign(new Error(), { code: 'DEV_EXTENSIONS_NOT_READY' });
  stage = 'verify_assets';
  const page = await fetch(url.origin + '/agent.js', { signal: AbortSignal.timeout(10000) });
  if (!page.ok) throw Object.assign(new Error(), { code: 'DEV_ASSETS_NOT_READY' });
  url.searchParams.set('view', 'agent'); url.searchParams.set('dev', '1');
  stage = 'open_browser';
  await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop'; $shell=New-Object -ComObject Shell.Application; $shell.ShellExecute($env:SAPLINK_BROWSER_URL)"],
    { windowsHide: true, timeout: 15000, env: { ...process.env, SAPLINK_BROWSER_URL: url.href } });
  stage = 'record_status';
  const status = { running: true, development: true, pid: host.pid, ui_url: url.origin,
    mcp_running: host.mcp_running, model_configured: model.configured, browser_open_requested: true };
  await mkdir(join(root, '.saplink'), { recursive: true });
  await writeFile(join(root, '.saplink/dev-client-state.json'), JSON.stringify(status, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(status));
} catch (error) {
  // Never print subprocess output, URLs with session secrets, or credential errors.
  console.error(JSON.stringify({ status: 'error', stage, code: /^[A-Z0-9_]+$/.test(error?.code ?? '') ? error.code : 'DEV_START_FAILED' }));
  process.exitCode = 1;
}
