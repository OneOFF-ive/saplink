#!/usr/bin/env node
import { Command, CommanderError } from 'commander';
import { input, password, confirm } from '@inquirer/prompts';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { open, readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { appVersion } from './version.js';
import { ConfigStore, WindowsCredentials, connectionSchema, type Connection } from './config.js';
import { AdtBackend } from './adt.js';
import { AppError } from './errors.js';
import { acquireLease } from './lease.js';
import { startAdmin } from './admin.js';
import { printSuccess, printFailure, parsePort } from './cli-output.js';
import { installationStatus, doctor } from './diagnostics.js';
import { startService, stopService, restartService, serviceStatus, clearServiceCache, runManagedService, reportStartupFailure, openServiceUi } from './service.js';
import { promptLocalPassword } from './password-prompt.js';
import { cleanupLogs, retentionDays } from './log-cleanup.js';
import { checkForUpdate, startRuntimeUpdateChecks } from './updates.js';
import { SelfUpdater } from './self-update.js';

const store = new ConfigStore();
const credentials = new WindowsCredentials();
const jsonOutput = process.argv.includes('--json');
const cli = new Command().name('saplink').description('SapLink: local SAP ADT MCP server and lifecycle manager')
  .version(appVersion).option('--json', 'Return one JSON result; never prompt in the terminal')
  .exitOverride().configureOutput({ writeErr: text => { if (!jsonOutput) process.stderr.write(text); } });

cli.hook('postAction', (_command, action) => {
  if (!['ui', 'serve', '_run'].includes(action.name())) return;
  const updates = startRuntimeUpdateChecks(store.directory);
  process.once('SIGINT', updates.stop);
  process.once('SIGTERM', updates.stop);
});

async function mutate<T>(action: () => Promise<T>, connectionChange = true): Promise<T> {
  const releaseRuntime = connectionChange ? await acquireLease(store.directory, 'runtime.lock') : undefined;
  let releaseConfig: (() => Promise<void>) | undefined;
  try {
    releaseConfig = await acquireLease(store.directory, 'config.lock');
    return await action();
  } finally {
    await releaseConfig?.();
    await releaseRuntime?.();
  }
}

type ConnectionOptions = {
  url?: string; client?: string; username?: string; language?: string;
  enableWrites?: boolean; disableWrites?: boolean; passwordPrompt?: boolean;
};

function addConnectionOptions(command: Command) {
  return command.option('--url <url>', 'SAP HTTP/HTTPS server URL')
    .option('--client <client>', 'Three-digit SAP Client, preserving leading zeros')
    .option('--username <username>', 'SAP login username')
    .option('--language <language>', 'Two-letter language, e.g. EN')
    .option('--enable-writes', 'Explicitly enable writes on this connection')
    .option('--disable-writes', 'Disable writes on this connection')
    .option('--password-prompt', 'Ask the human for the password in a local Windows dialog');
}

async function connectionInput(name: string, options: ConnectionOptions, old?: Connection) {
  if (options.enableWrites && options.disableWrites) throw new AppError('INVALID_INPUT', 'Choose either --enable-writes or --disable-writes.');
  const hasOptions = Object.values(options).some(value => value !== undefined);
  const interactive = !jsonOutput && Boolean(process.stdin.isTTY) && !hasOptions;
  let fields;
  if (interactive) {
    fields = {
      base_url: await input({ message: 'ADT server URL (HTTPS recommended):', default: old?.base_url }),
      client: await input({ message: 'Client (three digits):', default: old?.client ?? '100' }),
      username: await input({ message: 'SAP username:', default: old?.username }),
      language: (await input({ message: 'Language:', default: old?.language ?? 'EN' })).toUpperCase(),
      write_enabled: await confirm({ message: 'Enable program writes?', default: old?.write_enabled ?? false })
    };
  } else {
    if (!old && (!options.url || !options.client || !options.username)) {
      throw new AppError('INTERACTION_REQUIRED', 'Provide --url, --client and --username; use --password-prompt for secure local password entry.');
    }
    fields = {
      base_url: options.url ?? old?.base_url, client: options.client ?? old?.client,
      username: options.username ?? old?.username, language: (options.language ?? old?.language ?? 'EN').toUpperCase(),
      write_enabled: options.enableWrites ? true : options.disableWrites ? false : old?.write_enabled ?? false
    };
  }
  const connection = connectionSchema.parse({ ...fields, name, connection_id: old?.connection_id ?? randomUUID() });
  const identityChanged = Boolean(old && (connection.base_url !== old.base_url || connection.username !== old.username || connection.client !== old.client));
  let replacePassword = !old || identityChanged || Boolean(options.passwordPrompt);
  if (interactive && old && !identityChanged) replacePassword = await confirm({ message: 'Replace stored password?', default: false });
  let secret: string | undefined;
  if (replacePassword) {
    if (options.passwordPrompt) secret = await promptLocalPassword(connection);
    else if (interactive) secret = await password({ message: 'SAP password:', mask: '*' });
    else throw new AppError('INTERACTION_REQUIRED', 'A password is required for this new or changed login identity. Re-run with --password-prompt; never pass passwords in arguments or chat.');
    if (!secret) throw new AppError('PASSWORD_REQUIRED', 'Password cannot be empty.');
  }
  return { connection, secret };
}

cli.command('version').description('Show the current application version; supports --json')
  .action(() => jsonOutput ? printSuccess({ version: appVersion }, true) : console.log(appVersion));

const updates = cli.command('update').description('Check releases or install a confirmed COS update');
updates.command('check').option('--force', 'Bypass the 24-hour release metadata cache')
  .action(async options => {
    const result = await checkForUpdate(appVersion, store.directory, { force: Boolean(options.force) });
    if (jsonOutput) printSuccess(result, true);
    else {
      console.log(`SapLink ${result.current_version}; latest stable: ${result.latest_version ?? 'unknown'}`);
      console.log(result.message);
      console.log(`Release / download page: ${result.release_url}`);
      console.log(`Update source: ${result.source}`);
      for (const item of result.downloads) console.log(`Windows ${item.architecture}: ${item.url}\nSHA-256: ${item.sha256}`);
      if (result.cached) console.log('Using cached metadata; use --force to refresh update sources.');
    }
  });

updates.command('install').option('--yes', 'Confirm download, graceful stop and installation of the latest COS version')
  .action(async options => {
    if (!options.yes) throw new AppError('CONFIRMATION_REQUIRED', '自动更新会下载安装包并正常停止应用，请确认后使用 update install --yes --json。');
    const updater = new SelfUpdater(store.directory);
    if (!(await updater.status()).supported) throw new AppError('UPDATE_NOT_INSTALLED', '自动安装仅支持 Windows 安装版；源码运行请手动安装。');
    const before = await serviceStatus(store.directory);
    if (!['stopped', 'running'].includes(before.state) || before.lease.guard_present) {
      throw new AppError('SERVICE_NOT_MANAGED', '请在已打开的管理页面更新，或先正常退出前台应用；无法确认的进程不会被关闭。');
    }
    const release = await updater.check();
    if (!release.update_available || !release.latest_version) { printSuccess(release, jsonOutput); return; }
    await updater.install(release.latest_version, before.managed ? { mode: 'service', mcp_port: before.port } : { mode: 'stopped' },
      async () => { if (before.managed) await stopService(store.directory); });
    const result = await updater.wait();
    if (result.phase === 'failed') throw new AppError(result.error_code ?? 'UPDATE_FAILED', result.message);
    printSuccess({ ...result, message: '安装包已验证并移交独立更新程序；请查看 update-install-result.json 确认最终结果。' }, jsonOutput);
  });

cli.command('status').description('Inspect configuration and process state without returning credentials')
  .action(async () => printSuccess(await installationStatus(store), jsonOutput));
cli.command('doctor').description('Diagnose local setup; SAP probing is opt-in with --connection')
  .option('--port <port>', 'Port to check when stopped', '8765').option('--connection <name>', 'Also test this SAP login and ADT discovery')
  .action(async options => {
    const result = await doctor(store, credentials, parsePort(options.port), options.connection);
    printSuccess(result, jsonOutput);
    if (!result.healthy) process.exitCode = 1;
  });

cli.command('cache').description('Manage SAP connection caches; preserve configuration and write deduplication')
  .command('clear').description('Close idle cached SAP sessions; refuse cleanup while operations are pending')
  .action(async () => printSuccess(await clearServiceCache(store.directory), jsonOutput));

cli.command('logs').description('Manage historical audit logs; always preserve today and unknown files')
  .command('clear').option('--older-than-days <days>', 'Keep this many UTC calendar days; 0 still preserves today', '30')
  .option('--yes', 'Delete eligible historical logs; without this flag preview only')
  .action(async options => {
    const result = await cleanupLogs(retentionDays(options.olderThanDays), Boolean(options.yes));
    printSuccess(result, jsonOutput);
    if (result.failed_files) process.exitCode = 1;
  });

const service = cli.command('service').description('Manage only background instances created by this CLI');
service.command('status').action(async () => printSuccess(await serviceStatus(store.directory), jsonOutput));
service.command('start').option('--port <port>', 'MCP port', '8765').action(async options => {
  if (!(await store.load()).tokens.length) throw new AppError('TOKEN_REQUIRED', 'Create a token with token create --out <file> --json before starting.');
  printSuccess(await startService(store.directory, parsePort(options.port)), jsonOutput);
});
service.command('stop').action(async () => printSuccess(await stopService(store.directory), jsonOutput));
service.command('restart').option('--port <port>', 'New MCP port; omitted preserves the managed port').action(async options => {
  if (!(await store.load()).tokens.length) throw new AppError('TOKEN_REQUIRED', 'Create a token before restarting.');
  printSuccess(await restartService(store.directory, options.port ? parsePort(options.port) : undefined), jsonOutput);
});
service.command('_run', { hidden: true }).option('--port <port>', 'MCP port', '8765')
  .action(async options => runManagedService(store, credentials, parsePort(options.port)));

const connections = cli.command('connection').description('Manage local SAP connections');
connections.command('list').action(async () => {
  const config = await store.load();
  if (jsonOutput) printSuccess(config.connections, true);
  else console.table(config.connections);
});
addConnectionOptions(connections.command('add <name>')).action(async (name, options) => {
  const result = await mutate(async () => {
    const config = await store.load();
    if (config.connections.some(connection => connection.name === name)) throw new AppError('DUPLICATE_NAME', 'Connection name already exists.');
    const { connection, secret } = await connectionInput(name, options);
    await credentials.set(connection.connection_id, secret!);
    config.connections.push(connection);
    try { await store.save(config); }
    catch (error) { await credentials.remove(connection.connection_id); throw error; }
    return connection;
  });
  printSuccess(result, jsonOutput);
});
addConnectionOptions(connections.command('edit <name>')).action(async (name, options) => {
  const result = await mutate(async () => {
    const config = await store.load();
    const index = config.connections.findIndex(connection => connection.name === name);
    if (index < 0) throw new AppError('NOT_FOUND', 'Connection not found. Run connection list --json.');
    const old = config.connections[index];
    const { connection, secret } = await connectionInput(name, options, old);
    const previous = secret ? await credentials.get(old.connection_id).catch(() => undefined) : undefined;
    if (secret) await credentials.set(old.connection_id, secret);
    config.connections[index] = connection;
    try { await store.save(config); }
    catch (error) {
      if (secret) { if (previous) await credentials.set(old.connection_id, previous); else await credentials.remove(old.connection_id); }
      throw error;
    }
    return connection;
  });
  printSuccess(result, jsonOutput);
});
connections.command('remove <name>').option('--yes', 'Confirm removal of this named connection and its credential').action(async (name, options) => {
  const result = await mutate(async () => {
    const config = await store.load();
    const connection = config.connections.find(connection => connection.name === name);
    if (!connection) throw new AppError('NOT_FOUND', 'Connection not found.');
    if (!options.yes) {
      if (jsonOutput || !process.stdin.isTTY) throw new AppError('CONFIRMATION_REQUIRED', 'Re-run with --yes only when removal of this named connection is intended.');
      if (!(await confirm({ message: `Remove ${name} and its credential?`, default: false }))) return { removed: false };
    }
    const previous = await credentials.get(connection.connection_id).catch(() => undefined);
    await credentials.remove(connection.connection_id);
    config.connections = config.connections.filter(item => item !== connection);
    try { await store.save(config); }
    catch (error) { if (previous) await credentials.set(connection.connection_id, previous); throw error; }
    return { removed: true, connection_id: connection.connection_id };
  });
  printSuccess(result, jsonOutput);
});
connections.command('test <name>').action(async name => {
  const connection = (await store.load()).connections.find(connection => connection.name === name);
  if (!connection) throw new AppError('NOT_FOUND', 'Connection not found.');
  const backend = new AdtBackend(connection, await credentials.get(connection.connection_id));
  try { printSuccess(await backend.capabilities(), jsonOutput); }
  finally { await backend.close().catch(() => {}); }
});

const token = cli.command('token').description('Manage MCP tokens; AI use should write secrets to a file');
token.command('list').action(async () => {
  printSuccess((await store.load()).tokens.map(({ id, created_at }) => ({ id, created_at })), jsonOutput);
});
token.command('create').option('--out <file>', 'Write the secret to a NEW local file; do not print it')
  .action(async options => {
    if (!options.out && (jsonOutput || !process.stdout.isTTY)) {
      throw new AppError('TOKEN_OUTPUT_REQUIRED', 'Use --out <new-local-file> to avoid printing the token into captured AI output.');
    }
    const result = await mutate(async () => {
      if (!options.out) return store.createToken();
      const path = resolve(options.out);
      const file = await open(path, 'wx', 0o600);
      let created: Awaited<ReturnType<ConfigStore['createToken']>> | undefined;
      try {
        created = await store.createToken();
        await file.writeFile(JSON.stringify(created, null, 2) + '\n');
        return { id: created.id, token_file: path, contains_secret: true };
      } catch (error) {
        if (created) {
          const config = await store.load();
          config.tokens = config.tokens.filter(item => item.id !== created!.id);
          await store.save(config);
        }
        await file.close();
        await unlink(path);
        throw error;
      } finally { await file.close(); }
    }, false);
    printSuccess(result, jsonOutput);
  });
token.command('revoke <id>').action(async id => {
  const result = await mutate(async () => {
    const config = await store.load();
    if (!config.tokens.some(token => token.id === id)) throw new AppError('NOT_FOUND', 'Token ID not found.');
    config.tokens = config.tokens.filter(token => token.id !== id);
    await store.save(config);
    return { revoked: true, id };
  }, false);
  printSuccess(result, jsonOutput);
});

cli.command('client-config').description('Export portable connection parameters, not a client-specific settings file')
  .requiredOption('--token-file <file>', 'Local secret file created by token create --out')
  .requiredOption('--out <file>', 'NEW local file for connection parameters; contains a bearer token')
  .option('--port <port>', 'MCP port; omitted uses the managed port or 8765')
  .action(async options => {
    let secret;
    try {
      const text = await readFile(resolve(options.tokenFile), 'utf8');
      if (text.length > 4096) throw new Error('Oversized secret file');
      secret = JSON.parse(text);
    } catch { throw new AppError('TOKEN_FILE_INVALID', 'Cannot read this token file. Use the local file returned by token create --out.'); }
    if (typeof secret.token !== 'string' || !(await store.authenticate(secret.token))) {
      throw new AppError('TOKEN_FILE_INVALID', 'Token is missing, revoked, or belongs to another configuration directory.');
    }
    const state = await serviceStatus(store.directory);
    const port = options.port ? parsePort(options.port) : state.port ?? 8765;
    const url = `http://127.0.0.1:${port}/mcp`;
    const path = resolve(options.out);
    const file = await open(path, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify({ transport: 'streamable-http', url, headers: { Authorization: `Bearer ${secret.token}` } }, null, 2) + '\n');
    } finally { await file.close(); }
    printSuccess({ connection_file: path, contains_secret: true, url, client_specific: false,
      next_action: 'Import these parameters using the target client\'s supported configuration format. Client connectivity has not been verified.' }, jsonOutput);
  });

cli.command('ui').description('Open the interactive local management interface')
  .option('--port <port>', 'Management port', process.env.SAPLINK_UI_PORT ?? '8766').option('--no-open', 'Do not launch a browser')
  .action(async options => {
    if (jsonOutput) throw new AppError('INTERACTION_REQUIRED', 'ui is an interactive foreground command. Use status/doctor/service commands with --json for automation.');
    const port = parsePort(options.port);
    const existing = await serviceStatus(store.directory);
    if (existing.state === 'running' && existing.managed) {
      const session = await openServiceUi(store.directory, port);
      if (options.open && process.platform === 'win32') {
        const browser = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          "$ErrorActionPreference = 'Stop'; Start-Process -FilePath $env:SAPLINK_BROWSER_URL"],
          { windowsHide: true, stdio: 'ignore', env: { ...process.env, SAPLINK_BROWSER_URL: session.url } });
        browser.on('error', () => console.error('Browser launch failed; use the local session URL.'));
      }
      console.log(`Management session URL: ${session.url}`);
      // The desktop launcher is only a tray client; the existing host owns MCP and UI.
      let checking = false;
      const timer = setInterval(() => {
        if (checking) return;
        checking = true;
        void serviceStatus(store.directory).then(state => {
          if (state.pid !== session.pid || state.state !== 'running') clearInterval(timer);
        }).catch(() => clearInterval(timer)).finally(() => { checking = false; });
      }, 1000);
      process.once('SIGINT', () => clearInterval(timer));
      process.once('SIGTERM', () => clearInterval(timer));
      return;
    }
    const release = await acquireLease(store.directory, 'runtime.lock');
    let runtime: Awaited<ReturnType<typeof startAdmin>> | undefined;
    let closing = false;
    const stop = async () => { if (closing) return; closing = true; try { await runtime?.close(); } finally { await release(); } };
    try {
      const restartMcpPort = process.env.SAPLINK_RESTART_MCP_PORT;
      delete process.env.SAPLINK_RESTART_MCP_PORT;
      delete process.env.SAPLINK_UI_PORT;
      runtime = await startAdmin(store, credentials, port, undefined, stop, { initialMcpPort: restartMcpPort ? parsePort(restartMcpPort) : undefined });
      console.log(`SapLink management: http://127.0.0.1:${port}/`);
      if (options.open && process.platform === 'win32') {
        const browser = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          "$ErrorActionPreference = 'Stop'; Start-Process -FilePath $env:SAPLINK_BROWSER_URL"],
          { windowsHide: true, cwd: process.env.SystemRoot ?? 'C:\\Windows', stdio: 'ignore', env: { ...process.env, SAPLINK_BROWSER_URL: runtime.url } });
        browser.on('error', () => console.error('Browser launch failed; use the local session URL.'));
      }
      process.once('SIGINT', () => { void stop(); });
      process.once('SIGTERM', () => { void stop(); });
      console.log(`Management session URL: ${runtime.url}`);
    } catch (error) { await release(); throw error; }
  });
cli.command('serve').description('Run MCP in the foreground; use service start for background automation')
  .option('--port <port>', 'MCP port', '8765').action(async options => {
    if (jsonOutput) throw new AppError('INTERACTION_REQUIRED', 'serve stays attached to the terminal. Use service start --json for background startup.');
    const port = parsePort(options.port);
    if (!(await store.load()).tokens.length) throw new AppError('TOKEN_REQUIRED', 'Create a token before starting.');
    process.env.SAPLINK_STARTUP_ID = randomUUID();
    await runManagedService(store, credentials, port);
    console.log(`SapLink listening at http://127.0.0.1:${port}/mcp`);
  });

try { await cli.parseAsync(); }
catch (error) {
  if (error instanceof CommanderError && error.exitCode === 0) { /* --help and --version */ }
  else {
    const failure = error instanceof CommanderError
      ? new AppError('INVALID_ARGUMENTS', 'Unknown or missing option. Use --help; never pass passwords as command arguments.') : error;
    if (process.argv.includes('_run')) await reportStartupFailure(store.directory, failure).catch(() => {});
    printFailure(failure, jsonOutput);
  }
}
