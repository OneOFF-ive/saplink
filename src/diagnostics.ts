import { access, mkdtemp, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { ConfigStore, type Credentials } from './config.js';
import { AdtBackend } from './adt.js';
import { serviceStatus } from './service.js';
import { cliFailure } from './cli-output.js';
import { localPortInUse } from './local-port.js';
import { checkRfcEnvironment } from './rfc-environment.js';

type Check = { name: string; status: 'passed' | 'warning' | 'failed'; message: string };

export async function installationStatus(store: ConfigStore) {
  const config = await store.load();
  return {
    config_directory: store.directory,
    connection_count: config.connections.length,
    token_count: config.tokens.length,
    service: await serviceStatus(store.directory)
  };
}

async function portAvailable(port: number) {
  if (await localPortInUse(port)) return false;
  return new Promise<boolean>(resolve => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

export async function doctor(store: ConfigStore, credentials: Credentials, port: number, connectionName?: string) {
  const checks: Check[] = [];
  const add = (name: string, status: Check['status'], message: string) => checks.push({ name, status, message });
  const major = Number(process.versions.node.split('.')[0]);
  add('node', major >= 22 ? 'passed' : 'failed', `Node.js ${process.versions.node}; version 22+ required.`);
  add('platform', process.platform === 'win32' ? 'passed' : 'failed', 'Windows is required for the supported credential-store workflow.');
  try {
    await access(fileURLToPath(new URL('../dist/cli.js', import.meta.url)));
    add('build', 'passed', 'Compiled CLI is available.');
  } catch { add('build', 'failed', 'Run npm run build before background startup.'); }

  let config;
  try {
    config = await store.load();
    add('configuration', 'passed', `Configuration is readable; ${config.connections.length} connection(s).`);
    add('tokens', config.tokens.length ? 'passed' : 'warning', config.tokens.length ? 'At least one optional MCP token exists.' : 'No MCP token configured. Direct SAP CLI use does not require one; create a token only when enabling optional MCP access.');
    add('connections', config.connections.length ? 'passed' : 'warning', config.connections.length ? 'Connections are configured.' : 'No connection configured; add one before using SAP tools.');
  } catch (error) { add('configuration', 'failed', cliFailure(error).message); }

  // Use the directory itself only if present; diagnose without creating configuration.
  try {
    await access(store.directory);
    const probe = await mkdtemp(join(store.directory, '.doctor-'));
    await rmdir(probe);
    add('config_directory', 'passed', 'Configuration directory is writable.');
  } catch (error) {
    add('config_directory', (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'warning' : 'failed',
      'Configuration directory is absent or not writable; creation will be checked when saving.');
  }

  let service;
  try {
    service = await serviceStatus(store.directory);
    const uncertain = ['unknown', 'unresponsive'].includes(service.state) || service.lease.guard_present;
    add('service', uncertain ? 'failed' : 'passed', `Service state: ${service.state}. Foreground UI/service instances are never terminated by the manager.`);
    if (service.lease.guard_present) add('runtime_guard', 'failed', 'An orphan or busy runtime guard exists. Do not delete it without checking all running SapLink processes.');
    if (service.state === 'stopped') add('port', await portAvailable(port) ? 'passed' : 'warning', `Checking optional MCP port ${port}; a busy port is never taken over and does not prevent direct SAP CLI use.`);
  } catch (error) { add('service', 'failed', cliFailure(error).message); }

  if (config && process.platform === 'win32') {
    if (config.connections.some(connection => connection.rfc)) {
      try {
        const environment = await checkRfcEnvironment({ directory: store.directory });
        for (const check of environment.checks) add(`rfc:${check.name}`, check.passed ? 'passed' : 'failed', check.message);
      } catch { add('rfc:environment', 'failed', 'RFC 运行环境配置无效，请在管理页面重新设置。'); }
    }
    for (const connection of config.connections) {
      try {
        await credentials.get(connection.connection_id);
        add(`credential:${connection.name}`, 'passed', 'A credential is present in the current Windows user credential store.');
      } catch { add(`credential:${connection.name}`, 'failed', 'Credential unavailable; enter it locally with connection edit --password-prompt.'); }
    }
  }
  if (connectionName && config) {
    const connection = config.connections.find(item => item.name === connectionName);
    if (!connection) add('sap_probe', 'failed', 'The selected connection does not exist. Run connection list --json.');
    else {
      let backend: AdtBackend | undefined;
      try {
        backend = new AdtBackend(connection, await credentials.get(connection.connection_id));
        await backend.capabilities();
        add('sap_probe', 'passed', 'SAP ADT login and discovery succeeded; this does not establish business or write authorization.');
      } catch (error) { add('sap_probe', 'failed', cliFailure(error).message); }
      finally { await backend?.close().catch(() => {}); }
    }
  }
  return { healthy: checks.every(check => check.status !== 'failed'), checks, service,
    sap_probe_performed: Boolean(connectionName && config?.connections.some(connection => connection.name === connectionName)) };
}
