import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { gunzipSync, inflateSync } from 'node:zlib';
import type { HttpClient } from 'abap-adt-api';
import type { AdtHTTP, HttpClientOptions, HttpClientResponse } from 'abap-adt-api/build/AdtHTTP.js';
import { AppError, type BackendDiagnostic } from './errors.js';
import type { Connection } from './config.js';
import { defaultLogDirectory } from './paths.js';
import { discoverRfcEnvironment, javaProcessEnvironment } from './rfc-environment.js';
import { validateRequestTimeout } from './request-timeout.js';

export type RfcRole = 'editor' | 'reader' | 'quality';
export type RfcRuntime = { java: string; jcoJar: string; nativeDirectory: string; classes: string; cwd: string; timeoutMs: number; ctsTimeoutMs?: number };
export type RfcLauncher = (runtime: RfcRuntime) => ChildProcessWithoutNullStreams;
const launchBridge: RfcLauncher = runtime => spawn(runtime.java, [`-Djava.library.path=${runtime.nativeDirectory}`, '-cp',
  `${runtime.classes}${delimiter}${runtime.jcoJar}`, 'SapLinkRfcBridge'], { cwd: runtime.cwd, windowsHide: true, stdio: 'pipe',
    env: javaProcessEnvironment() });
export interface AdtTransport extends HttpClient {
  lastDiagnostic: BackendDiagnostic;
  lastFailure?: { http_status: number; request_path: string; request_method: string };
  terminalError?: AppError;
  bindSession?(http: AdtHTTP): void;
  close?(): Promise<void>;
  setRequestTimeout?(timeoutMs?: number): void;
}

export function rfcRuntime(env: NodeJS.ProcessEnv = process.env): RfcRuntime {
  const found = discoverRfcEnvironment({ env });
  if (!found.java || !found.jar || !found.native)
    throw new AppError('RFC_RUNTIME_MISSING', 'RFC 运行环境不完整，请在管理页面检查 Java、JCo 和原生库。');
  const timeout = env.SAPLINK_RFC_TIMEOUT_MS ?? '15000';
  if (!/^\d+$/.test(timeout) || Number(timeout) < 100 || Number(timeout) > 120000)
    throw new AppError('INVALID_CONFIG', 'SAPLINK_RFC_TIMEOUT_MS must be between 100 and 120000.');
  const ctsTimeout = env.SAPLINK_RFC_CTS_TIMEOUT_MS ?? '60000';
  if (!/^\d+$/.test(ctsTimeout) || Number(ctsTimeout) < 100 || Number(ctsTimeout) > 120000)
    throw new AppError('INVALID_CONFIG', 'SAPLINK_RFC_CTS_TIMEOUT_MS must be between 100 and 120000.');
  return { java: found.java.path, jcoJar: found.jar.path,
    nativeDirectory: found.native.path, classes: found.classes,
    cwd: join(defaultLogDirectory(), 'rfc'), timeoutMs: Number(timeout), ctsTimeoutMs: Number(ctsTimeout) };
}

export function rfcRequestTimeoutMs(runtime: RfcRuntime, method: string, path: string): number {
  const ctsRead = (method === 'GET' && /^\/sap\/bc\/adt\/cts\/transportrequests(?:\/|$)/.test(path))
    || (method === 'POST' && path === '/sap/bc/adt/cts/transportchecks');
  return ctsRead ? Math.max(runtime.timeoutMs, runtime.ctsTimeoutMs ?? 60000) : runtime.timeoutMs;
}

const b64 = (value: string) => Buffer.from(value, 'utf8').toString('base64');
function from64(value: string): Buffer {
  // A repeated capture/group regex can overflow V8's regexp stack on large valid
  // transport inventories. Validate length/alphabet/padding without recursion.
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  if (value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value)
    || value.slice(0, value.length - padding).includes('='))
    throw new AppError('RFC_PROTOCOL_ERROR', 'Invalid RFC bridge encoding.');
  return Buffer.from(value, 'base64');
}

export function rfcRequest(o: HttpClientOptions, role: RfcRole, writeEnabled: boolean) {
  if (o.url.length > 32768 || !o.url.startsWith('/sap/bc/adt/') || /[\\#\x00-\x20]/.test(o.url))
    throw new AppError('INVALID_URI', 'RFC accepts only relative ADT paths.');
  let decoded: string;
  try { decoded = decodeURIComponent(o.url.split('?')[0]); }
  catch { throw new AppError('INVALID_URI', 'Invalid ADT path encoding.'); }
  if (/[\\?#\x00-\x20%]/.test(decoded) || decoded.split('/').some(part => part === '.' || part === '..'))
    throw new AppError('INVALID_URI', 'Unsafe ADT path.');
  const method = (o.method ?? 'GET').toUpperCase();
  if (!['GET', 'POST', 'PUT'].includes(method)) throw new AppError('CAPABILITY_UNSUPPORTED', 'Unsupported ADT-over-RFC method.');
  const path = o.url.split('?')[0];
  const readPost = method === 'POST' && ['/sap/bc/adt/checkruns', '/sap/bc/adt/datapreview/ddic',
    '/sap/bc/adt/datapreview/freestyle', '/sap/bc/adt/ddic/elementinfo', '/sap/bc/adt/cts/transportchecks',
    '/sap/bc/adt/repository/nodestructure', '/sap/bc/adt/navigation/target',
    '/sap/bc/adt/repository/informationsystem/usageReferences', '/sap/bc/adt/repository/informationsystem/usageSnippets',
    '/sap/bc/adt/abapsource/typehierarchy'].includes(path);
  if (method !== 'GET' && !readPost && !writeEnabled) throw new AppError('WRITE_DISABLED', 'Enable writes in local connection settings first.');
  if (method !== 'GET' && role === 'reader' && !readPost)
    throw new AppError('RFC_ROLE_POLICY', 'The independent RFC reader cannot modify development objects.');
  let uri = o.url;
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(o.qs ?? {}))
    for (const item of Array.isArray(value) ? value : [value])
      if (item !== undefined) query.append(name, String(item));
  if (query.size) uri += `${uri.includes('?') ? '&' : '?'}${query}`;
  if (Buffer.byteLength(uri) > 32768) throw new AppError('REQUEST_TOO_LARGE', 'RFC request URI is too large.');
  if (o.body !== undefined && typeof o.body !== 'string') throw new AppError('INVALID_INPUT', 'ADT body must be text.');
  if (Buffer.byteLength(o.body ?? '') > 2 * 1024 * 1024) throw new AppError('REQUEST_TOO_LARGE', 'RFC request body exceeds 2 MiB.');
  const headers = Object.entries(o.headers ?? {}).filter(([name]) =>
    !/^(authorization|cookie|host|content-length|accept-encoding|x-csrf-token|x-sap-adt-sessiontype)$/i.test(name));
  headers.push(['Accept-Encoding', 'identity'], ['X-sap-adt-sessiontype', role === 'reader' ? 'stateless' : 'stateful']);
  if (headers.some(([name, value]) => !/^[!#$%&'*+.^_`|~\w-]+$/.test(name) || /[\r\n\x00]/.test(String(value))))
    throw new AppError('INVALID_INPUT', 'Invalid ADT request header.');
  const headerText = headers.map(([name, value]) => `${name}:${value}`).join('\n');
  if (Buffer.byteLength(headerText) > 65536) throw new AppError('REQUEST_TOO_LARGE', 'RFC headers exceed 64 KiB.');
  return { method, path, uri, headers: headerText, body: o.body ?? '' };
}

export function rfcResponse(fields: string[]): HttpClientResponse {
  if (fields.length !== 5 || fields[1] !== 'OK' || !/^[1-5]\d{2}$/.test(fields[2]))
    throw new AppError('RFC_PROTOCOL_ERROR', 'Invalid RFC bridge response.');
  const headers: Record<string, string> = {};
  const headerText = from64(fields[3]).toString('utf8');
  if (Buffer.byteLength(headerText) > 65536) throw new AppError('BACKEND_RESPONSE_TOO_LARGE', 'RFC response headers exceed 64 KiB.');
  for (const line of headerText.split('\n')) {
    const separator = line.indexOf(':');
    if (separator < 1) continue;
    const name = line.slice(0, separator).toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (!/^[!#$%&'*+.^_`|~\w-]+$/.test(name) || /[\r\n\x00]/.test(value)) throw new AppError('RFC_PROTOCOL_ERROR', 'Invalid RFC response header.');
    if (['set-cookie', 'cookie', 'authorization', 'x-csrf-token'].includes(name)) continue;
    headers[name] = headers[name] === undefined ? value : `${headers[name]}, ${value}`;
  }
  let body = from64(fields[4]);
  const options = { maxOutputLength: 16 * 1024 * 1024 };
  try {
    if (headers['content-encoding'] === 'gzip') body = gunzipSync(body, options);
    else if (headers['content-encoding'] === 'deflate') body = inflateSync(body, options);
    else if (headers['content-encoding'] && headers['content-encoding'] !== 'identity')
      throw new AppError('RFC_PROTOCOL_ERROR', 'Unsupported RFC response content encoding.');
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('BACKEND_RESPONSE_TOO_LARGE', 'RFC decompression failed or exceeded its limit.');
  }
  if (body.length > 16 * 1024 * 1024) throw new AppError('BACKEND_RESPONSE_TOO_LARGE', 'RFC response exceeds 16 MiB.');
  delete headers['content-length']; delete headers['content-encoding'];
  return { status: Number(fields[2]), statusText: '', headers, body: body.toString('utf8') };
}

export class RfcTransport implements AdtTransport {
  lastDiagnostic: BackendDiagnostic = {};
  lastFailure?: AdtTransport['lastFailure'];
  terminalError?: AppError;
  private child?: ChildProcessWithoutNullStreams;
  private startup?: Promise<void>;
  private readyResolve?: () => void;
  private readyReject?: (error: AppError) => void;
  private startupTimer?: NodeJS.Timeout;
  private pending?: { id: string; resolve: (result: HttpClientResponse) => void; reject: (error: AppError) => void; timer: NodeJS.Timeout };
  private sequence = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private closing = false;
  private clean = false;
  private closePromise?: Promise<void>;
  private requestTimeoutMs?: number;
  setRequestTimeout(timeoutMs?: number) { this.requestTimeoutMs = validateRequestTimeout(timeoutMs); }
  constructor(private connection: Connection, private password: string, readonly role: RfcRole,
    private runtime?: RfcRuntime, private onActivity?: () => void, private launcher: RfcLauncher = launchBridge) { }

  private fail(error: AppError) {
    if (this.terminalError || this.clean) return;
    this.terminalError = error;
    this.password = '';
    clearTimeout(this.startupTimer);
    this.readyReject?.(error);
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(error); this.pending = undefined; }
    // Only our own bridge process is terminated. SAP completion is never inferred from termination.
    this.child?.kill();
  }
  private start(): Promise<void> {
    if (this.closing) return Promise.reject(new AppError('RFC_CONTEXT_LOST', 'RFC context is closed.'));
    if (this.terminalError) return Promise.reject(this.terminalError);
    return this.startup ??= this.launch();
  }
  private async launch() {
    try {
      const runtime = this.runtime ??= rfcRuntime();
      await Promise.all([runtime.java, runtime.jcoJar, runtime.nativeDirectory, join(runtime.classes, 'SapLinkRfcBridge.class')]
        .map(path => access(path, constants.R_OK)));
      await mkdir(runtime.cwd, { recursive: true });
      if (this.closing) throw new AppError('RFC_CONTEXT_LOST', 'RFC context is closed.');
      const ready = new Promise<void>((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
      this.startupTimer = setTimeout(() => this.fail(new AppError('RFC_RUNTIME_UNAVAILABLE', 'RFC bridge startup timed out.')),
        this.requestTimeoutMs ?? runtime.timeoutMs);
      this.child = this.launcher(runtime);
      let buffered = '';
      const decoder = new StringDecoder('utf8');
      this.child.stdout.on('data', (chunk: Buffer) => {
        buffered += decoder.write(chunk);
        if (buffered.length > 24 * 1024 * 1024) { this.fail(new AppError('RFC_PROTOCOL_ERROR', 'RFC bridge output exceeded its bound.')); return; }
        for (let end; (end = buffered.indexOf('\n')) >= 0;) {
          const line = buffered.slice(0, end).replace(/\r$/, ''); buffered = buffered.slice(end + 1);
          const fields = line.split('\t');
          if (fields[0] === 'READY' && fields.length === 2 && !this.readySeen) {
            this.readySeen = true; clearTimeout(this.startupTimer); this.readyResolve?.();
          } else if (line === 'CLOSED' && this.closing) this.clean = true;
          else if (fields[0] === 'FATAL') this.fail(new AppError(this.readySeen ? 'RFC_CONTEXT_LOST' : 'RFC_RUNTIME_UNAVAILABLE', 'RFC bridge could not initialize or preserve its context.'));
          else if (this.pending && fields[0] === this.pending.id) {
            const pending = this.pending;
            if (fields[1] === 'ERROR') {
              this.fail(new AppError(fields[2] === '103' ? 'RFC_AUTH_FAILED' : 'RFC_CONTEXT_LOST',
                fields[2] === '103' ? 'SAP RFC logon failed; check the configured credentials.' : 'RFC context lost; verify SAP state before continuing.'));
              continue;
            }
            try {
              const response = rfcResponse(fields);
              this.pending = undefined; clearTimeout(pending.timer); pending.resolve(response);
            } catch (error) { this.fail(error instanceof AppError ? error : new AppError('RFC_PROTOCOL_ERROR', 'Invalid RFC bridge response.')); }
          } else this.fail(new AppError('RFC_PROTOCOL_ERROR', 'Unexpected RFC bridge response.'));
        }
      });
      // Never expose raw Java/native diagnostics or SDK exception payloads.
      this.child.stderr.on('data', () => {});
      this.child.on('error', () => this.fail(new AppError('RFC_RUNTIME_UNAVAILABLE', 'Could not start RFC bridge.')));
      this.child.stdin.on('error', () => this.fail(new AppError('RFC_CONTEXT_LOST', 'RFC bridge input closed.')));
      this.child.on('exit', () => { if (!this.clean) this.fail(new AppError('RFC_CONTEXT_LOST', 'RFC bridge exited; verify SAP state.')); });
      const rfc = this.connection.rfc!;
      this.child.stdin.write(['INIT', ...[rfc.ashost, rfc.sysnr, this.connection.client, this.connection.username,
        this.password, this.connection.language, this.role, this.connection.write_enabled ? '1' : '0', rfc.saprouter ?? ''].map(b64)].join('\t') + '\n');
      this.password = '';
      await ready;
    } catch (error) {
      const failure = error instanceof AppError ? error : new AppError('RFC_RUNTIME_MISSING', 'RFC Java, JCo or compiled bridge files are unavailable.');
      this.fail(failure); throw failure;
    }
  }
  private readySeen = false;
  request(o: HttpClientOptions): Promise<HttpClientResponse> {
    // A channel never has overlapping SAP calls; other channels have independent JVMs/contexts.
    const run = this.tail.then(() => this.perform(o));
    this.tail = run.catch(() => {});
    return run;
  }
  private async perform(o: HttpClientOptions) {
    const request = rfcRequest(o, this.role, this.connection.write_enabled);
    this.lastFailure = undefined;
    this.lastDiagnostic = { request_path: request.path, request_method: request.method, request_body_bytes: Buffer.byteLength(request.body) };
    const started = performance.now();
    try {
      await this.start();
      if (this.terminalError) throw this.terminalError;
      const response = await new Promise<HttpClientResponse>((resolve, reject) => {
        const id = String(++this.sequence);
        const timeoutMs = this.requestTimeoutMs ?? rfcRequestTimeoutMs(this.runtime!, request.method, request.path);
        this.lastDiagnostic.timeout_ms = timeoutMs;
        const timer = setTimeout(() => this.fail(new AppError('RFC_CONTEXT_LOST', 'RFC call timed out; verify SAP state before continuing.', {
          request_path: request.path, request_method: request.method, timeout_ms: timeoutMs,
          elapsed_ms: Math.round(performance.now() - started)
        })), timeoutMs);
        this.pending = { id, resolve, reject, timer };
        this.lastDiagnostic.request_finished = true;
        this.child!.stdin.write([id, ...[request.method, request.uri, request.headers, request.body].map(b64)].join('\t') + '\n');
      });
      this.lastDiagnostic.http_status = response.status;
      this.lastDiagnostic.response_started = true;
      if (response.status >= 400) this.lastFailure = { http_status: response.status, request_path: request.path, request_method: request.method };
      if (response.status >= 300 && response.status < 400) throw new AppError('RFC_REDIRECT_REJECTED', 'ADT-over-RFC redirects are not followed.');
      const limit = /^\/sap\/bc\/adt\/cts\/transportrequests(?:\/|$)/.test(request.path) ? 16 : 4;
      if (Buffer.byteLength(response.body) > limit * 1024 * 1024) throw new AppError('BACKEND_RESPONSE_TOO_LARGE', 'RFC response exceeds this operation limit.');
      return response;
    } finally { this.lastDiagnostic.elapsed_ms = Math.round(performance.now() - started); this.onActivity?.(); }
  }
  bindSession(http: AdtHTTP) {
    let authenticated = false;
    let login: Promise<void> | undefined;
    http.stateful = 'stateful' as typeof http.stateful;
    Object.defineProperty(http, 'loggedin', { configurable: true, get: () => authenticated && !this.closing && !this.terminalError });
    http.login = async () => {
      if (this.terminalError) throw this.terminalError;
      if (this.closing) throw new AppError('RFC_CONTEXT_LOST', 'RFC context is closed.');
      if (authenticated) return;
      return login ??= this.request({ url: '/sap/bc/adt/compatibility/graph',
        qs: { 'sap-client': this.connection.client, 'sap-language': this.connection.language }, headers: { Accept: '*/*' } })
        .then(response => {
          if (response.status !== 200) {
            const error = new AppError(response.status === 401 ? 'RFC_AUTH_FAILED' : 'RFC_LOGIN_FAILED', 'RFC ADT login probe failed.');
            this.fail(error); throw error;
          }
          authenticated = true;
        }).finally(() => { login = undefined; });
    };
    http.logout = async () => { authenticated = false; await this.close(); };
    http.dropSession = http.logout;
  }
  close(): Promise<void> {
    return this.closePromise ??= this.shutdown();
  }
  private async shutdown() {
    this.closing = true;
    this.password = '';
    await this.tail;
    await this.startup?.catch(() => {});
    if (!this.child) return;
    if (this.terminalError) {
      // A read-only bridge owns no editor locks. Discard it only after its local
      // process has actually exited; this does not claim SAP execution was cancelled.
      if (this.role !== 'reader') throw this.terminalError;
      const child = this.child;
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve, reject) => {
          const onExit = () => { clearTimeout(timer); resolve(); };
          const timer = setTimeout(() => {
            child.removeListener('exit', onExit);
            reject(new AppError('RFC_CONTEXT_LOST', 'Failed RFC reader process has not exited; cache cleanup was not confirmed.'));
          }, 3000);
          child.once('exit', onExit);
        });
      }
      return;
    }
    const child = this.child;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new AppError('RFC_CONTEXT_LOST', 'RFC context cleanup timed out.')); }, 3000);
      child.once('exit', () => {
        clearTimeout(timer);
        if (this.clean) resolve(); else reject(new AppError('RFC_CONTEXT_LOST', 'RFC context cleanup was not confirmed.'));
      });
      child.stdin.end('CLOSE\n');
    });
  }
}
