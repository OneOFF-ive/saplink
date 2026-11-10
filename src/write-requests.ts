import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { digest } from './config.js';
import { AppError } from './errors.js';
import type { Input } from './operations.js';
import type { ToolName } from './tool-definitions.js';

export async function reserveWriteRequest(directory: string, tool: ToolName, input: Input) {
  const folder = join(directory, 'cli-write-requests');
  await mkdir(folder, { recursive: true });
  const key = digest(JSON.stringify([input.connection_id, input.request_id]));
  let file;
  try { file = await open(join(folder, `${key}.json`), 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new AppError('REQUEST_ALREADY_USED', 'This write request_id is already reserved. It may have reached SAP. Read SAP state and operation logs before considering a new authorized write; do not blindly retry with a new ID.');
    throw error;
  }
  try {
    await file.writeFile(JSON.stringify({ schema_version: 1, tool, connection_id: input.connection_id,
      request_id: input.request_id, reserved_at: new Date().toISOString() }) + '\n');
    await file.sync();
  } finally { await file.close(); }
}
