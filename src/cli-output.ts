import { z } from 'zod';
import { AppError, safeError } from './errors.js';
import { connectionFieldHints } from './config.js';

export function cliFailure(error: unknown) {
  if (error instanceof AppError) return safeError(error);
  if (error instanceof z.ZodError) {
    const fields = [...new Set(error.issues.map(issue => issue.path[0] === 'rfc' && issue.path.length > 1
      ? `rfc_${String(issue.path[1])}` : String(issue.path[0] ?? '')))];
    return { code: 'INVALID_INPUT', message: fields.map(field => connectionFieldHints[field] ?? 'Invalid command arguments.').join('\n') };
  }
  const code = (error as NodeJS.ErrnoException)?.code;
  const known: Record<string, string> = {
    EADDRINUSE: 'Port is already in use. Run doctor; do not terminate an unrelated process.',
    EACCES: 'Local access denied. Check this user\'s file and port permissions.',
    EPERM: 'Local operation is not permitted for this user.',
    EEXIST: 'The destination already exists; choose a new output file.',
    ENOENT: 'A required local file or executable is missing. Run doctor.'
  };
  if (code && known[code]) return { code, message: known[code] };
  const failure = safeError(error);
  if (failure.code !== 'ADT_ERROR' || failure.details) return failure;
  return { code: 'CLI_FAILED', message: 'Local operation failed. Run doctor --json and inspect the reported checks.' };
}

export function printSuccess(data: unknown, json: boolean) {
  console.log(JSON.stringify(json ? { schema_version: 1, status: 'success', data } : data, null, 2));
}

export function printFailure(error: unknown, json: boolean) {
  const failure = cliFailure(error);
  if (json) console.log(JSON.stringify({ schema_version: 1, status: 'error', error: failure }, null, 2));
  else console.error(failure.message);
  process.exitCode = 1;
}

export function parsePort(value: string | number): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new AppError('INVALID_PORT', 'Port must be an integer from 1 to 65535.');
  return port;
}
