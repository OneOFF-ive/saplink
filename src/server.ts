import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { ConfigStore } from './config.js';
import { Operations, type Input } from './operations.js';
import { safeError } from './errors.js';
import { clientInstructions } from './client-guidance.js';
import { toolSchemas, toolDescription, type ToolName } from './tool-definitions.js';
import { writeTools } from './tool-policy.js';
import { appVersion } from './version.js';
import { notifyMcpStarted } from './updates.js';

export function makeMcp(operations: Operations) {
  const server = new McpServer({
    name: 'saplink',
    version: appVersion
  }, {
    instructions: clientInstructions,
    maxToolInputElements: 2000
  });
  for (const name of Object.keys(toolSchemas) as ToolName[]) {
    const write = writeTools.has(name);
    server.registerTool(name, {
      description: toolDescription(name),
      inputSchema: toolSchemas[name],
      annotations: {
        readOnlyHint: !write,
        destructiveHint: write,
        idempotentHint: !write,
        openWorldHint: true
      }
    }, async (args: Input) => {
      try {
        const result = await operations.run(name, args as Input);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(result)
          }],
          structuredContent: result,
          isError: result.status === 'error'
        };
      }
      catch (error) {
        const result = {
          status: 'error',
          error: safeError(error)
        };
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(result)
          }],
          structuredContent: result,
          isError: true
        };
      }
    });
  }
  return server;
}

export async function startHttp(store: ConfigStore, operations: Operations, port = 8765) {
  const app = express();
  app.disable('x-powered-by');
  let inFlight = 0;
  let stopping = false;
  app.use(async (req, res, next) => {
    const host = req.headers.host;
    if (!host || !/^127\.0\.0\.1:\d+$/.test(host)) {
      res.sendStatus(403);
      return;
    }
    if (req.headers.origin) {
      res.sendStatus(403);
      return;
    }
    if (stopping || inFlight >= 16) {
      res.sendStatus(503);
      return;
    }
    inFlight++;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        inFlight--;
      }
    };
    res.once('finish', release);
    res.once('close', release);
    const auth = req.headers.authorization;
    try {
      if (!auth?.startsWith('Bearer ') || !(await store.authenticate(auth.slice(7)))) {
        res.sendStatus(401);
        return;
      }
    }
    catch {
      res.sendStatus(503);
      return;
    }
    if (stopping || released) {
      if (!released)
        res.sendStatus(503);
      return;
    }
    next();
  });
  app.use(express.json({
    limit: '2mb',
    type: 'application/json'
  }));
  app.post('/mcp', async (req, res) => {
    const mcp = makeMcp(operations);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res, req.body);
    }
    catch {
      if (!res.headersSent)
        res.status(500).json({ error: 'MCP request failed' });
    }
    finally {
      await mcp.close();
    }
  });
  app.all('/mcp', (_req, res) => res.sendStatus(405));
  app.use((_req, res) => res.sendStatus(404));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status((error as {
      status?: number;
    }).status === 413 ? 413 : 400).json({ error: 'Invalid request body' });
  });
  const listener = await new Promise<ReturnType<typeof app.listen>>((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });
  listener.requestTimeout = 30000;
  listener.headersTimeout = 10000;
  notifyMcpStarted(store.directory);
  return {
    listener,
    clearCache: () => operations.clearCache(),
    close: async () => {
      stopping = true;
      const stopped = new Promise<void>(resolve => listener.close(() => resolve()));
      await operations.close();
      listener.closeIdleConnections();
      await stopped;
    }
  };
}
