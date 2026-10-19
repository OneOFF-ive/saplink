import { spawn } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, request } from 'node:http';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { ConfigStore, Credentials } from './config.js';
import { AppError } from './errors.js';
import { acquireLease, inspectLease, type LeaseStatus } from './lease.js';
import { Operations, type CacheClearResult } from './operations.js';
import { startHttp } from './server.js';
import { cliFailure } from './cli-output.js';
import { localPortInUse } from './local-port.js';
import { startAdmin } from './admin.js';

const recordName = 'managed-service.json';
const recordSchema = z.object({
  schema_version: z.literal(1), instance_id: z.string().uuid(), pid: z.number().int().positive(),
  lease_nonce: z.string().uuid(), mcp_port: z.number().int().min(1).max(65535),
  control_port: z.number().int().min(1).max(65535), control_token: z.string().regex(/^[A-Za-z0-9_-]{43}$/)
}).strict();
type ManagedRecord = z.infer<typeof recordSchema>;
export type ServiceStatus = {
  state: 'stopped' | 'running' | 'external' | 'unresponsive' | 'unknown';
  managed: boolean; lease: LeaseStatus; pid?: number; port?: number; url?: string; mcp_running?: boolean;
};

async function readRecord(directory: string): Promise<ManagedRecord | undefined> {
  try {
    const text = await readFile(join(directory, recordName), 'utf8');
    if (text.length > 8192) throw new Error('Oversized state');
    return recordSchema.parse(JSON.parse(text));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new AppError('SERVICE_STATE_INVALID', 'Managed service metadata is invalid. Inspect it locally; do not delete a live runtime lock.');
  }
}

// Never follow redirects or accept a URL from the metadata file.
async function control(record: ManagedRecord, action: 'status' | 'stop' | 'cache/clear' | 'ui/session' | 'mcp/start', uiPort?: number) {
  return new Promise<{ instance_id: string; pid: number; stopping: boolean; mcp_running?: boolean; ui_url?: string; cache?: CacheClearResult }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: record.control_port, path: `/${action}${action === 'ui/session' || action === 'mcp/start' ? `?port=${uiPort}` : ''}`,
      method: action === 'status' ? 'GET' : 'POST', headers: { Authorization: `Bearer ${record.control_token}` } }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        body += chunk;
        if (body.length > 4096) req.destroy(new Error('Oversized control response'));
      });
      res.on('error', reject);
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) throw new Error('Control request rejected');
          const result = JSON.parse(body);
          if (result.instance_id !== record.instance_id || result.pid !== record.pid) throw new Error('Instance mismatch');
          if (result.error) throw new AppError(result.error.code, result.error.message);
          resolve(result);
        } catch (error) { reject(error); }
      });
    });
    req.setTimeout(['cache/clear', 'ui/session', 'mcp/start'].includes(action) ? 30000 : 1500, () => req.destroy(new Error('Control request timed out')));
    req.on('error', reject);
    req.end();
  });
}

export async function serviceStatus(directory: string): Promise<ServiceStatus> {
  const lease = await inspectLease(directory);
  if (lease.state === 'unknown') return { state: 'unknown', managed: false, lease };
  if (lease.state !== 'running') return { state: 'stopped', managed: false, lease };
  const record = await readRecord(directory);
  if (!record || record.pid !== lease.pid || record.lease_nonce !== lease.nonce) {
    return { state: 'external', managed: false, lease, pid: lease.pid };
  }
  const status = { managed: true, lease, pid: record.pid, port: record.mcp_port,
    url: `http://127.0.0.1:${record.mcp_port}/mcp` };
  try {
    const result = await control(record, 'status');
    return { ...status, state: 'running', mcp_running: result.mcp_running ?? true };
  } catch {
    return { ...status, state: 'unresponsive' };
  }
}

async function withServiceCommand<T>(directory: string, action: () => Promise<T>) {
  const release = await acquireLease(directory, 'service-command.lock');
  try { return await action(); } finally { await release(); }
}

async function start(directory: string, port: number): Promise<ServiceStatus> {
  const before = await serviceStatus(directory);
  if (before.lease.guard_present) throw new AppError('LEASE_BUSY', 'Runtime guard exists. Inspect running processes before any manual recovery.');
  if (before.state === 'running' && before.managed) {
    if (before.mcp_running === false) {
      const record = await readRecord(directory);
      if (!record || record.pid !== before.pid || record.lease_nonce !== before.lease.nonce) throw new AppError('SERVICE_STATE_CHANGED', 'Service instance changed');
      await control(record, 'mcp/start', port);
      return serviceStatus(directory);
    }
    if (before.port === port) return before;
  }
  if (before.state !== 'stopped') throw new AppError('SERVICE_ALREADY_OWNED', 'A service, UI, or uncertain process already owns this configuration. Run status; it will not be replaced.');
  if (await localPortInUse(port)) throw new AppError('EADDRINUSE', 'Port is already in use. Choose another port; no existing listener was stopped.');

  const instanceId = randomUUID();
  const startupFile = join(directory, `service-start-${instanceId}.json`);
  const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  // The installed Windows launcher creates the daemon without inheriting any
  // terminal handles. Older Node/libuv versions can otherwise keep an AI
  // client's output pipe open even with detached:true and stdio:'ignore'.
  const launcher = process.platform === 'win32' ? process.env.SAPLINK_WINDOWS_LAUNCHER : undefined;
  const child = spawn(launcher ?? process.execPath,
    launcher ? ['--internal-service-run', String(port)] : [cliPath, 'service', '_run', '--port', String(port)], {
    detached: true, windowsHide: true, stdio: 'ignore',
    env: { ...process.env, SAPLINK_CONFIG_DIR: directory, SAPLINK_STARTUP_ID: instanceId }
  });
  let spawnFailed = false;
  child.once('error', () => { spawnFailed = true; });
  child.unref();
  try {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (spawnFailed) throw new AppError('SERVICE_SPAWN_FAILED', 'Could not launch the background process. Run doctor.');
      const record = await readRecord(directory);
      if (record?.instance_id === instanceId) {
        const result = await serviceStatus(directory);
        if (result.state === 'running') return result;
      }
      try {
        const failure = JSON.parse(await readFile(startupFile, 'utf8'));
        throw new AppError(failure.code, failure.message);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (child.exitCode !== null && (!launcher || child.exitCode !== 0)) throw new AppError('SERVICE_START_FAILED', 'The background process exited before becoming ready. Run doctor.');
      await delay(150);
    }
    throw new AppError('SERVICE_START_UNKNOWN', 'Startup was not confirmed. Run status before retrying; a process may still be starting.');
  } finally {
    await unlink(startupFile).catch(() => {});
  }
}

export function startService(directory: string, port: number) {
  return withServiceCommand(directory, () => start(directory, port));
}

export async function openServiceUi(directory: string, port: number): Promise<{ url: string; pid: number }> {
  const status = await serviceStatus(directory);
  if (status.state !== 'running' || !status.managed) throw new AppError('SERVICE_NOT_MANAGED', 'Cannot attach UI to an unverified instance');
  const record = await readRecord(directory);
  if (!record || record.pid !== status.pid || record.lease_nonce !== status.lease.nonce) throw new AppError('SERVICE_STATE_CHANGED', 'Service instance changed');
  const result = await control(record, 'ui/session', port);
  const url = new URL(result.ui_url ?? '');
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/' ||
      url.username || url.password || !/^#[A-Za-z0-9_-]{43}$/.test(url.hash)) throw new AppError('SERVICE_STATE_INVALID', 'Invalid management session');
  return { url: url.href, pid: record.pid };
}

async function stop(directory: string): Promise<ServiceStatus> {
  const before = await serviceStatus(directory);
  if (before.state === 'stopped' && !before.lease.guard_present) return before;
  if (before.state !== 'running' || !before.managed) {
    throw new AppError('SERVICE_NOT_MANAGED', 'Cannot safely stop this process. It may be a foreground UI/service, unresponsive, or unknown. No process was killed.');
  }
  const record = await readRecord(directory);
  if (!record || record.pid !== before.pid || record.lease_nonce !== before.lease.nonce) {
    throw new AppError('SERVICE_STATE_CHANGED', 'Service metadata changed; run status again.');
  }
  try { await control(record, 'stop'); }
  catch { throw new AppError('SERVICE_STOP_UNKNOWN', 'Shutdown acceptance was not confirmed. Run status; no automatic retry or forced kill was performed.'); }

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const current = await readRecord(directory);
    if (!current || current.instance_id !== record.instance_id) return serviceStatus(directory);
    await delay(150);
  }
  throw new AppError('SERVICE_STOP_UNKNOWN', 'Graceful shutdown is still pending. Run status later; SAP work may still be finishing.');
}

export function clearServiceCache(directory: string): Promise<CacheClearResult> {
  return withServiceCommand(directory, async () => {
    const before = await serviceStatus(directory);
    if (before.lease.guard_present) throw new AppError('LEASE_BUSY', '运行锁状态待核实，无法清理缓存。');
    if (before.state === 'stopped') return { cleared_sessions: 0, retained_write_requests: 0 };
    if (before.state !== 'running' || !before.managed) throw new AppError('SERVICE_NOT_MANAGED', '请在持有运行锁的管理界面中清理连接缓存；无法确认的进程不会被操作。');
    const record = await readRecord(directory);
    if (!record || record.pid !== before.pid || record.lease_nonce !== before.lease.nonce) throw new AppError('SERVICE_STATE_CHANGED', '服务状态已变更，请重新检查。');
    try {
      const result = await control(record, 'cache/clear');
      if (!result.cache || !Number.isInteger(result.cache.cleared_sessions) || !Number.isInteger(result.cache.retained_write_requests)) throw new Error('Invalid cache response');
      return result.cache;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('CACHE_CLEAR_UNKNOWN', '无法确认清理结果，请先检查服务状态；不会自动重试或重启服务。');
    }
  });
}

export function stopService(directory: string) {
  return withServiceCommand(directory, () => stop(directory));
}

export function restartService(directory: string, port?: number) {
  return withServiceCommand(directory, async () => {
    const before = await serviceStatus(directory);
    const nextPort = port ?? before.port ?? 8765;
    await stop(directory);
    return start(directory, nextPort);
  });
}

export async function runManagedService(store: ConfigStore, credentials: Credentials, port: number) {
  const instanceId = z.string().uuid().parse(process.env.SAPLINK_STARTUP_ID);
  const release = await acquireLease(store.directory, 'runtime.lock');
  const sharedRuntime: { current?: Awaited<ReturnType<typeof startHttp>>; port: number } = { port };
  let admin: Awaited<ReturnType<typeof startAdmin>> | undefined;
  let openingAdmin: Promise<Awaited<ReturnType<typeof startAdmin>>> | undefined;
  let controlServer: ReturnType<typeof createServer> | undefined;
  let record: ManagedRecord | undefined;
  let shutdown: Promise<void> | undefined;
  const close = () => shutdown ??= (async () => {
    try {
      await openingAdmin?.catch(() => {});
      await admin?.close();
      await sharedRuntime.current?.close();
      if (controlServer) {
        controlServer.closeIdleConnections();
        await new Promise<void>(resolve => controlServer!.close(() => resolve()));
      }
    } finally {
      try {
        if (record && (await readRecord(store.directory))?.instance_id === instanceId) {
          await unlink(join(store.directory, recordName));
        }
      } finally { await release(); }
    }
  })();

  try {
    if (!(await store.load()).tokens.length) throw new AppError('TOKEN_REQUIRED', 'Create an MCP token before starting the service.');
    sharedRuntime.current = await startHttp(store, new Operations(store, credentials), port);
    const controlToken = randomBytes(32).toString('base64url');
    let controlPort = 0;
    controlServer = createServer((req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const supplied = Buffer.from(req.headers.authorization ?? '');
      const expected = Buffer.from(`Bearer ${controlToken}`);
      if (req.headers.host !== `127.0.0.1:${controlPort}` || req.headers.origin !== undefined) { res.writeHead(403).end(); return; }
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { res.writeHead(401).end(); return; }
      const route = new URL(req.url ?? '/', 'http://127.0.0.1');
      const isUi = route.pathname === '/ui/session' && req.method === 'POST';
      const isStart = route.pathname === '/mcp/start' && req.method === 'POST';
      const isStop = req.url === '/stop' && req.method === 'POST';
      const isClear = req.url === '/cache/clear' && req.method === 'POST';
      if (!isStop && !isClear && !isUi && !isStart && !(req.url === '/status' && req.method === 'GET')) { res.writeHead(404).end(); return; }
      req.resume();
      res.setHeader('Content-Type', 'application/json');
      if (isStart) {
        const nextPort = z.coerce.number().int().min(1).max(65535).safeParse(route.searchParams.get('port'));
        if (!nextPort.success || shutdown || !admin) { res.writeHead(400).end(); return; }
        void admin.startMcp(nextPort.data).then(() => res.end(JSON.stringify({ instance_id: instanceId, pid: process.pid, stopping: false })))
          .catch(error => res.end(JSON.stringify({ instance_id: instanceId, pid: process.pid, error: cliFailure(error) })));
        return;
      }
      if (isUi) {
        const uiPort = z.coerce.number().int().min(1).max(65535).safeParse(route.searchParams.get('port'));
        if (!uiPort.success || shutdown) { res.writeHead(400).end(); return; }
        openingAdmin ??= startAdmin(store, credentials, uiPort.data, undefined, close, { sharedRuntime,
          runtimeChanged: async () => {
            if (!record) return;
            record.mcp_port = sharedRuntime.port;
            const temporary = join(store.directory, `managed-service-${randomUUID()}.tmp`);
            await writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
            await rename(temporary, join(store.directory, recordName));
          }
        });
        void openingAdmin.then(instance => {
          admin = instance;
          res.end(JSON.stringify({ instance_id: instanceId, pid: process.pid, stopping: false, ui_url: instance.url }));
        }).catch(error => {
          openingAdmin = undefined;
          res.end(JSON.stringify({ instance_id: instanceId, pid: process.pid, error: cliFailure(error) }));
        });
        return;
      }
      if (isClear) {
        void (sharedRuntime.current ? sharedRuntime.current.clearCache() : Promise.resolve({ cleared_sessions: 0, retained_write_requests: 0 })).then(cache => res.end(JSON.stringify({ instance_id: instanceId, pid: process.pid, stopping: Boolean(shutdown), cache })))
          .catch(error => res.end(JSON.stringify({ instance_id: instanceId, pid: process.pid, error: cliFailure(error) })));
        return;
      }
      res.end(JSON.stringify({ instance_id: instanceId, pid: process.pid, stopping: isStop || Boolean(shutdown), mcp_running: Boolean(sharedRuntime.current) }));
      if (isStop) setImmediate(() => { void close().catch(() => { process.exitCode = 1; }); });
    });
    controlServer.requestTimeout = 5000;
    controlServer.headersTimeout = 5000;
    await new Promise<void>((resolve, reject) => {
      controlServer!.once('error', reject);
      controlServer!.listen(0, '127.0.0.1', resolve);
    });
    const address = controlServer.address();
    if (!address || typeof address === 'string') throw new Error('Control listener unavailable');
    controlPort = address.port;
    const lease = JSON.parse(await readFile(join(store.directory, 'runtime.lock'), 'utf8'));
    record = recordSchema.parse({ schema_version: 1, instance_id: instanceId, pid: process.pid, lease_nonce: lease.nonce,
      mcp_port: port, control_port: controlPort, control_token: controlToken });
    const temporary = join(store.directory, `managed-service-${instanceId}.tmp`);
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
    await rename(temporary, join(store.directory, recordName));
    process.once('SIGINT', () => { void close(); });
    process.once('SIGTERM', () => { void close(); });
  } catch (error) {
    await close();
    throw error;
  }
}

export async function reportStartupFailure(directory: string, error: unknown) {
  const id = z.string().uuid().safeParse(process.env.SAPLINK_STARTUP_ID);
  if (!id.success) return;
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `service-start-${id.data}.json`), JSON.stringify(cliFailure(error)), { mode: 0o600 });
}
