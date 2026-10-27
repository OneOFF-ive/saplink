import { isAdtError } from 'abap-adt-api';

export type BackendDiagnostic = { request_path?: string; request_method?: string; http_status?: number;
  network_code?: string; cause_code?: string; elapsed_ms?: number; response_content_type?: string; error_kind?: string; request_body_bytes?: number; request_content_type?: string;
  request_finished?: boolean; socket_reused?: boolean; response_started?: boolean;
  request_content_length?: number; request_chunked?: boolean; request_connection_close?: boolean;
  request_charset?: string; request_content_encoding?: string; http_version?: string; transport?: string };
const backendDiagnostics = new WeakMap<object, BackendDiagnostic>();
export function attachBackendDiagnostic(error: unknown, diagnostic: BackendDiagnostic) {
  if (error && typeof error === 'object') backendDiagnostics.set(error, { ...diagnostic });
}
function diagnosticFor(error: unknown): BackendDiagnostic {
  const seen = new Set<object>();
  let current = error;
  for (let i = 0; i < 6 && current && typeof current === 'object' && !seen.has(current); i++) {
    seen.add(current);
    const found = backendDiagnostics.get(current);
    if (found) return found;
    current = (current as { parent?: unknown; cause?: unknown }).parent ?? (current as { cause?: unknown }).cause;
  }
  return {};
}

export class AppError extends Error {
  constructor(public code: string, message: string, public details?: unknown) { super(message); }
}

function redact(value: string): string {
  return value.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, '[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/((?:password|passwd|pwd|authorization|cookie|set-cookie|x-csrf-token|csrf(?:\s+token)?|lock(?:\s*handle)?|lock_handle|sap[-_]sessionid[^\s:=]*|密码)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,)]+)/gi, '$1[REDACTED]')
    .replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 1024);
}

function classifyBackendError(status: number | undefined, message: string, networkCode?: string): string {
  switch (status) {
    case 401:
      return 'AUTH_FAILED';
    case 403:
      if (/currently editing|当前编辑|locked|锁定/i.test(message))
        return 'OBJECT_LOCKED';
      if (/csrf/i.test(message))
        return 'CSRF_FAILED';
      return 'HTTP_FORBIDDEN';
    case 404:
      return 'OBJECT_NOT_FOUND';
    case 409:
    case 423:
      return 'OBJECT_LOCKED';
    default:
      return ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET'].includes(networkCode ?? '')
        ? 'OUTCOME_UNKNOWN'
        : 'ADT_ERROR';
  }
}

export function safeError(error: unknown) {
  if (error instanceof AppError)
    return {
      code: error.code,
      message: error.message,
      details: error.details
    };
  const backendError = (error ?? {}) as {
    response?: {
      status?: number;
    };
    status?: number;
    code?: string;
    message?: string;
    err?: number;
    localizedMessage?: string;
    type?: string;
    properties?: Record<string, string>;
  };
  const isSapError = isAdtError(error);
  // The library's XML exception parser keeps HTTP status in err, not response/status.
  const diagnostic = diagnosticFor(error);
  const rawStatus = diagnostic.http_status ?? backendError.response?.status ?? backendError.status ?? (isSapError ? backendError.err : undefined);
  const status = typeof rawStatus === 'number' && rawStatus >= 100 && rawStatus <= 599 ? rawStatus : undefined;
  const rawMessage = backendError.localizedMessage || backendError.message || '';
  const code = diagnostic.error_kind === 'response_size_limit' ? 'BACKEND_RESPONSE_TOO_LARGE'
    : diagnostic.error_kind === 'request_size_limit' ? 'REQUEST_TOO_LARGE'
    : classifyBackendError(status, rawMessage, diagnostic.network_code ?? backendError.code);
  const details = {
    ...diagnostic,
    ...(status ? { http_status: status } : {}),
    ...(isSapError && status !== 401 && rawMessage ? { sap_message: redact(rawMessage) } : {}),
    ...(isSapError && backendError.type ? { sap_error_type: redact(backendError.type).slice(0, 256) } : {}),
    ...(isSapError && backendError.properties?.['T100KEY-ID'] ? { sap_message_id: redact(backendError.properties['T100KEY-ID']).slice(0, 80) } : {}),
    ...(isSapError && backendError.properties?.['T100KEY-NO'] ? { sap_message_number: redact(backendError.properties['T100KEY-NO']).slice(0, 16) } : {})
  };
  return {
    code,
    message: 'Operation failed; inspect sanitized SAP details and verify backend state.',
    ...(Object.keys(details).length ? { details } : {})
  };
}
