import express from 'express';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { connectionSchema, connectionBaseUrl, connectionFieldHints, connectionIdentityChanged, type ConfigStore, type Credentials } from './config.js';
import { AdtBackend } from './adt.js';
import { Operations } from './operations.js';
import { startHttp } from './server.js';
import { acquireLease } from './lease.js';
import { safeError, AppError } from './errors.js';
import type { BackendFactory } from './operations.js';
import { cleanupLogs } from './log-cleanup.js';
import { getAutomaticUpdate } from './updates.js';
import { appVersion } from './version.js';
import { SelfUpdater } from './self-update.js';
import { localPortInUse } from './local-port.js';
import { readSapLogon } from './sap-logon.js';
import { checkRfcEnvironment, discoverRfcEnvironment, saveRfcEnvironment } from './rfc-environment.js';

const draft = connectionSchema.omit({ connection_id: true }).extend({
  base_url: connectionSchema.shape.base_url.optional(),
  write_enabled: z.boolean(),
  password: z.string().max(512).optional()
}).strict();

function validationResponse(error: z.ZodError) {
  const fields = [...new Set(error.issues.map(issue => issue.path[0] === 'rfc' && issue.path.length > 1
    ? `rfc_${String(issue.path[1])}` : String(issue.path[0] ?? '')))]
    .filter(field => Object.hasOwn(connectionFieldHints, field))
    .map(field => ({ field, message: connectionFieldHints[field] }));
  const message = fields.length
    ? fields.map(field => field.message).join('\n')
    : error.issues.some(issue => issue.path[0] === 'port')
      ? '端口必须是 1～65535 之间的整数，例如 8765。'
      : error.issues.some(issue => issue.path[0] === 'older_than_days')
        ? '日志保留天数必须是 0～36500 的整数；0 表示清理今天以前的日志。'
        : '请求参数格式不正确，或包含不支持的字段，请检查后重试。';
  return { code: 'INVALID_INPUT', message, fields };
}

export async function startAdmin(store: ConfigStore, credentials: Credentials, port = 8766,
  factory: BackendFactory = (c, p) => new AdtBackend(c, p), requestExit?: () => Promise<void>,
  options: { updater?: SelfUpdater; initialMcpPort?: number;
    sharedRuntime?: { current?: Awaited<ReturnType<typeof startHttp>>; port: number };
    exclusive?: <T>(action: () => Promise<T>) => Promise<T>;
    runtimeChanged?: () => Promise<void> } = {}) {
  if (port && await localPortInUse(port)) throw new AppError('EADDRINUSE', '管理端口已被占用，现有进程不会被接管');
  const key = randomBytes(32).toString('base64url');
  const app = express();
  app.disable('x-powered-by');
  const state = options.sharedRuntime ?? { current: undefined as Awaited<ReturnType<typeof startHttp>> | undefined, port: 8765 };
  let busy = false;
  let active = 0;
  let closing = false;
  const updater = options.updater ?? new SelfUpdater(store.directory);
  if (options.initialMcpPort) {
    if (!(await store.load()).tokens.length) throw new AppError('TOKEN_REQUIRED', '恢复 MCP 服务需要有效的访问令牌。');
    state.current = await startHttp(store, new Operations(store, credentials, undefined, factory), options.initialMcpPort);
    state.port = options.initialMcpPort;
  }
  const exclusive = options.exclusive ?? (async <T>(action: () => Promise<T>) => {
    if (busy)
      throw new AppError('BUSY', '另一项管理操作正在执行');
    busy = true;
    try {
      return await action();
    }
    finally {
      busy = false;
    }
  });
  const changeConfig = async <T>(action: () => Promise<T>) => {
    const release = await acquireLease(store.directory, 'config.lock');
    try {
      return await action();
    }
    finally {
      await release();
    }
  };
  app.use((req, res, next) => {
    const host = req.headers.host;
    if (!host || !/^127\.0\.0\.1:\d+$/.test(host) ||
      (req.headers.origin && req.headers.origin !== `http://${host}`)) {
      res.sendStatus(403);
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', ("default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; " +
      "frame-ancestors 'none'; base-uri 'none'; form-action 'self'"));
    if (closing || active >= 8) {
      res.sendStatus(503);
      return;
    }
    active++;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        active--;
      }
    };
    res.once('finish', release);
    res.once('close', release);
    // Express routes are case-insensitive by default; authentication must match that policy.
    if (/^\/api(?:\/|$)/i.test(req.path)) {
      const supplied = Buffer.from(req.headers['x-admin-token'] as string ?? '');
      const expected = Buffer.from(key);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        res.sendStatus(401);
        return;
      }
      if (req.method !== 'GET' && req.headers.origin !== `http://${host}`) {
        res.sendStatus(403);
        return;
      }
    }
    next();
  });
  app.use(express.json({ limit: '16kb' }));
  app.use('/api', (req, _res, next) => {
    if (req.method !== 'GET' && updater.busy) return next(new AppError('BUSY', '更新任务正在执行，请等待完成。'));
    next();
  });
  // Both polling routes must use the newest manual or background check.
  const latestUpdate = () => {
    const background = getAutomaticUpdate();
    return updater.latest && (!background || updater.latest.checked_at >= background.checked_at)
      ? updater.latest : background ?? null;
  };
  app.get('/api/state', async (_req, res) => {
    const config = await store.load();
    res.json({
      version: appVersion,
      connections: config.connections,
      tokens: config.tokens.map(({ id, name, created_at }) => ({
        id,
        name,
        created_at
      })),
      running: Boolean(state.current),
      update: latestUpdate(),
      update_install: await updater.status(),
      mcp_port: state.port,
      busy
    });
  });
  app.get('/api/sap-logon/connections', async (_req, res) => {
    res.json(await readSapLogon());
  });
  app.get('/api/rfc/environment', (_req, res) => {
    res.json(discoverRfcEnvironment({ directory: store.directory }));
  });
  app.post('/api/rfc/environment/check', async (req, res) => {
    z.object({}).strict().parse(req.body ?? {});
    res.json(await exclusive(() => checkRfcEnvironment({ directory: store.directory })));
  });
  app.put('/api/rfc/environment', async (req, res) => {
    const settings = await exclusive(() => changeConfig(async () => {
      if (state.current) throw new AppError('MCP_RUNNING', '请先停止 MCP 服务再更改 RFC 运行环境。');
      return saveRfcEnvironment(store.directory, req.body);
    }));
    res.json({ settings });
  });
  app.post('/api/updates/check', async (req, res) => {
    z.object({}).strict().parse(req.body ?? {});
    const result = await exclusive(() => updater.check());
    res.json({ update: result, update_install: await updater.status() });
  });
  app.get('/api/updates/status', async (_req, res) => {
    res.json({ update: latestUpdate(), update_install: await updater.status() });
  });
  app.post('/api/updates/install', async (req, res) => {
    const { version } = z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/) }).strict().parse(req.body);
    const result = await exclusive(() => updater.install(version, { mode: 'ui', ui_port: actualPort,
      ...(state.current ? { mcp_port: state.port } : {}) }, async () => {
      // The POST response is sent before the background download completes.
      await (requestExit ? requestExit() : close());
    }));
    res.status(202).json({ update_install: result });
  });
  app.post('/api/connections/:id/test', async (req, res) => {
    const result = await exclusive(async () => {
      const c = (await store.load()).connections.find(c => c.connection_id === req.params.id);
      if (!c)
        throw new AppError('NOT_FOUND', '连接不存在');
      const backend = factory(c, await credentials.get(c.connection_id));
      try {
        const result = await backend.capabilities() as {
          discovery?: unknown[];
        };
        return {
          success: true,
          collections: result.discovery?.length ?? 0,
          tested_at: new Date().toISOString()
        };
      }
      finally {
        await backend.close().catch(() => { });
      }
    });
    res.json(result);
  });
  app.post('/api/connections', async (req, res) => {
    const result = await exclusive(async () => changeConfig(async () => {
      if (state.current)
        throw new AppError('MCP_RUNNING', '请先停止 MCP 服务再编辑连接');
      const p = draft.parse(req.body);
      if (!p.password)
        throw new AppError('PASSWORD_REQUIRED', '请输入 SAP 密码');
      const { password, ...fields } = p;
      const c = connectionSchema.parse({
        ...fields,
        base_url: connectionBaseUrl(fields.base_url, fields.rfc),
        connection_id: randomUUID()
      });
      const config = await store.load();
      if (config.connections.some(v => v.name === c.name))
        throw new AppError('DUPLICATE_NAME', '连接名称已存在');
      await credentials.set(c.connection_id, password);
      config.connections.push(c);
      try {
        await store.save(config);
      }
      catch (error) {
        await credentials.remove(c.connection_id);
        throw error;
      }
      return c;
    }));
    res.json(result);
  });
  app.put('/api/connections/:id', async (req, res) => {
    const result = await exclusive(async () => changeConfig(async () => {
      if (state.current)
        throw new AppError('MCP_RUNNING', '请先停止 MCP 服务再编辑连接');
      const config = await store.load();
      const index = config.connections.findIndex(c => c.connection_id === req.params.id);
      if (index < 0)
        throw new AppError('NOT_FOUND', '连接不存在');
      const p = draft.parse(req.body);
      const { password, ...fields } = p;
      const old = config.connections[index];
      const updated = connectionSchema.parse({
        ...fields,
        base_url: connectionBaseUrl(fields.base_url, fields.rfc, old),
        connection_id: old.connection_id
      });
      if (config.connections.some(c => c !== old && c.name === updated.name))
        throw new AppError('DUPLICATE_NAME', '连接名称已存在');
      if (!password && connectionIdentityChanged(old, updated))
        throw new AppError('PASSWORD_REQUIRED', '地址或登录身份已变更，请重新输入密码');
      let previous: string | undefined;
      if (password) {
        previous = await credentials.get(old.connection_id).catch(() => undefined);
        await credentials.set(old.connection_id, password);
      }
      config.connections[index] = updated;
      try {
        await store.save(config);
      }
      catch (error) {
        if (password) {
          if (previous)
            await credentials.set(old.connection_id, previous);
          else
            await credentials.remove(old.connection_id);
        }
        throw error;
      }
      return updated;
    }));
    res.json(result);
  });
  app.delete('/api/connections/:id', async (req, res) => {
    await exclusive(async () => changeConfig(async () => {
      if (state.current)
        throw new AppError('MCP_RUNNING', '请先停止 MCP 服务再编辑连接');
      const config = await store.load();
      const c = config.connections.find(c => c.connection_id === req.params.id);
      if (!c)
        throw new AppError('NOT_FOUND', '连接不存在');
      const previous = await credentials.get(c.connection_id).catch(() => undefined);
      await credentials.remove(c.connection_id);
      config.connections = config.connections.filter(v => v !== c);
      try {
        await store.save(config);
      }
      catch (error) {
        if (previous)
          await credentials.set(c.connection_id, previous);
        throw error;
      }
    }));
    res.json({ success: true });
  });
  app.post('/api/tokens', async (req, res) => {
    const p = z.object({ name: z.string().optional() }).strict().parse(req.body ?? {});
    res.json(await exclusive(() => changeConfig(() => store.createToken(p.name))));
  });
  app.put('/api/tokens/:id', async (req, res) => {
    const p = z.object({ name: z.string() }).strict().parse(req.body);
    res.json(await exclusive(() => changeConfig(() => store.renameToken(req.params.id as string, p.name))));
  });
  app.delete('/api/tokens/:id', async (req, res) => {
    await exclusive(() => changeConfig(async () => {
      const config = await store.load();
      config.tokens = config.tokens.filter(t => t.id !== req.params.id);
      await store.save(config);
    }));
    res.json({ success: true });
  });
  const startMcp = (port: number) => exclusive(async () => {
    if (closing || updater.busy) throw new AppError('BUSY', '应用正在退出或更新，请稍后重试');
    if (state.current)
      throw new AppError('MCP_RUNNING', 'MCP 服务已启动');
    if (!(await store.load()).tokens.length)
      throw new AppError('TOKEN_REQUIRED', '请先创建访问令牌');
    state.current = await startHttp(store, new Operations(store, credentials, undefined, factory), port);
    state.port = port;
    await options.runtimeChanged?.();
  });
  app.post('/api/service/start', async (req, res) => {
    const p = z.object({ port: z.number().int().min(1).max(65535) }).strict().parse(req.body);
    await startMcp(p.port);
    res.json({ success: true });
  });
  app.post('/api/service/stop', async (_req, res) => {
    await exclusive(async () => {
      if (state.current) {
        await state.current.close();
        state.current = undefined;
        await options.runtimeChanged?.();
      }
    });
    res.json({ success: true });
  });
  app.post('/api/cache/clear', async (_req, res) => {
    res.json(await exclusive(async () => state.current ? await state.current.clearCache() : { cleared_sessions: 0, retained_write_requests: 0 }));
  });
  app.post('/api/logs/clear', async (req, res) => {
    const options = z.object({ older_than_days: z.number().int().min(0).max(36500), confirm: z.boolean().default(false) }).strict().parse(req.body);
    res.json(await exclusive(() => cleanupLogs(options.older_than_days, options.confirm)));
  });
  app.post('/api/application/stop', (_req, res) => {
    res.json({ success: true });
    // Respond first, then drain MCP/admin requests and release the CLI runtime lease.
    setImmediate(() => { void (requestExit ? requestExit() : close()).catch(() => { process.exitCode = 1; }); });
  });
  const assets = fileURLToPath(new URL('../web/', import.meta.url));
  // This fixed asset may live beneath a .codex worktree; no user-supplied path is accepted.
  app.get('/icons.js', (_req, res) => res.sendFile(fileURLToPath(new URL('../node_modules/lucide/dist/umd/lucide.js', import.meta.url)), { dotfiles: 'allow' }));
  app.use(express.static(assets, { etag: false }));
  app.use((_req, res) => res.sendStatus(404));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const response = error instanceof AppError ? {
      code: error.code,
      message: error.message
    }
      : error instanceof z.ZodError ? validationResponse(error)
        : {
          code: safeError(error).code,
          message: '操作失败，请检查连接信息、凭据或端口占用情况'
        };
    res.status(400).json({ error: response });
  });
  const listener = await new Promise<ReturnType<typeof app.listen>>((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  }).catch(async error => { if (!options.sharedRuntime) await state.current?.close(); throw error; });
  listener.requestTimeout = 30000;
  listener.headersTimeout = 10000;
  const address = listener.address();
  const actualPort = address && typeof address !== 'string' ? address.port : port;
  let shutdown: Promise<void> | undefined;
  const close = () => shutdown ??= (async () => {
    closing = true;
    const stopped = new Promise<void>(resolve => listener.close(() => resolve()));
    while (busy) await new Promise(resolve => setTimeout(resolve, 50));
    if (!options.sharedRuntime && state.current) await state.current.close();
    listener.closeIdleConnections();
    await stopped;
  })();
  return {
    listener,
    url: `http://127.0.0.1:${actualPort}/#${key}`,
    isUpdating: () => updater.busy,
    startMcp,
    close
  };
}
