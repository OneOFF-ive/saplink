import { z } from 'zod';
import { AppError } from './errors.js';

export const requestTimeoutSchema = z.number().int().min(100).max(600000).optional().describe(
  'Per SAP backend request timeout in milliseconds, 100..600000 (10 minutes). Applies only to this call, including login, metadata and verification requests; not a total operation deadline. Omit to preserve transport defaults (normally 15000; RFC CTS reads at least 60000). A timeout does not prove SAP stopped or rolled back. Never automatically retry writes; inspect SAP state first. The AI client must also allow enough time for the full tool call.');

export function validateRequestTimeout(value: unknown): number | undefined {
  const result = requestTimeoutSchema.safeParse(value);
  if (!result.success) throw new AppError('INVALID_INPUT', 'timeout_ms must be an integer from 100 to 600000 milliseconds.');
  return result.data;
}
