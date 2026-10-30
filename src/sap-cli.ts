import type { Command } from 'commander';
import { createReadStream } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ConfigStore, digest, type Credentials } from './config.js';
import { Operations, type Input, type Result } from './operations.js';
import { AppError } from './errors.js';
import { acquireLease } from './lease.js';
import { toolSchemas, toolDescription, type ToolName } from './tool-definitions.js';
import { writeTools } from './tool-policy.js';
import { clientInstructions } from './client-guidance.js';
import { printSuccess } from './cli-output.js';
import { validateRequestTimeout } from './request-timeout.js';

const inputLimit = 2 * 1024 * 1024;
const toolNames = Object.keys(toolSchemas) as ToolName[];
const directInstructions = clientInstructions
  .replace('Inspect structuredContent and isError.', 'Inspect the JSON envelope status and the full operation result in data.')
  .replace('Reuse the same ID and identical arguments only to retrieve that operation result in the same process; it is not a fresh check.',
    'CLI reserves request IDs persistently before dispatch and rejects every reuse, even after failure or restart. Read SAP state and operation logs before considering a new authorized write.');

export function describeSapTool(name: string) {
  if (!Object.hasOwn(toolSchemas, name)) throw new AppError('UNKNOWN_TOOL', 'Unknown SAP operation. Run saplink tools list --json.');
  const tool = name as ToolName;
  return { name: tool, description: toolDescription(tool), write: writeTools.has(tool),
    input_schema: z.toJSONSchema(toolSchemas[tool], { io: 'input' }) };
}

export async function readSapInput(path?: string): Promise<unknown> {
  if (!path) return {};
  if (path === '-' && process.stdin.isTTY) throw new AppError('INTERACTION_REQUIRED', 'Pipe one JSON object to stdin or use --input <file>.');
  const stream = path === '-' ? process.stdin : createReadStream(path);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > inputLimit) throw new AppError('INVALID_INPUT', 'SAP input exceeds the 2 MiB limit.');
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '')); }
  catch { throw new AppError('INVALID_INPUT', 'SAP input must be one valid JSON object.'); }
}

export function validateSapInput(tool: ToolName, raw: unknown, connection?: string, timeout?: string): Input {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AppError('INVALID_INPUT', 'SAP input must be a JSON object.');
  const fields = { ...raw } as Record<string, unknown>;
  if (timeout !== undefined) {
    if (!/^\d+$/.test(timeout)) throw new AppError('INVALID_INPUT', '--timeout-ms must be an integer from 100 to 600000 milliseconds.');
    const timeoutMs = validateRequestTimeout(Number(timeout));
    if (fields.timeout_ms !== undefined && fields.timeout_ms !== timeoutMs)
      throw new AppError('INVALID_INPUT', '--timeout-ms conflicts with input timeout_ms.');
    fields.timeout_ms = timeoutMs;
  }
  if (connection) {
    if (fields.connection_id !== undefined && fields.connection_id !== connection)
      throw new AppError('INVALID_INPUT', '--connection conflicts with input connection_id.');
    fields.connection_id = connection;
  }
  const parsed = toolSchemas[tool].safeParse(fields);
  if (!parsed.success) {
    // Do not echo source, row values or unrecognized input to terminal output.
    const paths = [...new Set(parsed.error.issues.map(issue => issue.path.join('.') || '(root)'))];
    throw new AppError('INVALID_INPUT', `Invalid SAP arguments at: ${paths.join(', ')}. Run saplink tools describe ${tool} --json.`);
  }
  return parsed.data as Input;
}

// An exclusive, durable reservation is made BEFORE dispatch. A killed process must
// never turn a repeated CLI invocation into a second SAP write. Store no source or
// result data; SAP and the operation log remain the authority after any failure.
export async function reserveCliWrite(directory: string, tool: ToolName, input: Input) {
  const folder = join(directory, 'cli-write-requests');
  await mkdir(folder, { recursive: true });
  const key = digest(JSON.stringify([input.connection_id, input.request_id]));
  let file;
  try { file = await open(join(folder, `${key}.json`), 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new AppError('REQUEST_ALREADY_USED', 'This CLI write request_id is already reserved. It may have reached SAP. Read SAP state and operation logs before considering a new authorized write; do not blindly retry with a new ID.');
    throw error;
  }
  try {
    await file.writeFile(JSON.stringify({ schema_version: 1, tool, connection_id: input.connection_id,
      request_id: input.request_id, reserved_at: new Date().toISOString() }) + '\n');
    await file.sync();
  } finally { await file.close(); }
}

export async function runSapOperation(store: ConfigStore, credentials: Credentials, tool: ToolName, input: Input,
  makeOperations: () => Pick<Operations, 'run' | 'close'> = () => new Operations(store, credentials)): Promise<Result> {
  // Configuration changes take this same lease. The MCP runtime uses its own
  // runtime lease, so direct SAP calls work while MCP is running or stopped.
  const release = await acquireLease(store.directory, 'config.lock');
  let operations: Pick<Operations, 'run' | 'close'> | undefined;
  try {
    if (writeTools.has(tool)) await reserveCliWrite(store.directory, tool, input);
    operations = makeOperations();
    return await operations.run(tool, input);
  } finally {
    try { await operations?.close(); } finally { await release(); }
  }
}

export function registerSapCli(cli: Command, store: ConfigStore, credentials: Credentials, json: boolean) {
  const tools = cli.command('tools').description('Discover SAP operations for direct CLI use; no MCP service required');
  tools.command('list').action(() => printSuccess(toolNames.map(name => ({ name,
    description: toolDescription(name), write: writeTools.has(name) })), json));
  tools.command('describe <name>').action(name => printSuccess(describeSapTool(name), json));
  tools.command('instructions').action(() => printSuccess({ instructions: directInstructions,
    cli_instructions: 'Use saplink sap <operation> --input <file|-> --json. Select the intended system and three-digit Client with list_connections first. Results are in data; inspect data.status and all write outcome fields. Each call creates and closes a SAP session. CLI write request IDs are durably reserved before dispatch; repeats are rejected, including after failure or process restart. MCP and CLI have separate request tracking: never replay a write through the other entry point. No automatic write retry. This entry point needs local command execution, not MCP configuration.' }, json));
  const sap = cli.command('sap').description('Call SAP directly using saved connections and credentials, independently of MCP');
  for (const tool of toolNames) {
    const command = sap.command(tool).description(toolDescription(tool))
      .option('--input <file|->', 'Read a JSON argument object from a UTF-8 file or piped stdin')
      .option('--connection <uuid>', 'Connection UUID returned by list_connections');
    if (tool !== 'list_connections') command.option('--timeout-ms <milliseconds>', 'Per SAP request timeout for this call, 100..600000; not a total deadline');
    command.action(async options => {
        const input = validateSapInput(tool, await readSapInput(options.input), options.connection, options.timeoutMs);
        const result = await runSapOperation(store, credentials, tool, input);
        // Keep all operation details, including partial/unknown write outcomes.
        console.log(JSON.stringify(json ? { schema_version: 1, status: result.status, data: result } : result, null, 2));
        if (result.status !== 'success') process.exitCode = 1;
      });
  }
}
