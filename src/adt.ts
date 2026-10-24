import { ADTClient, session_types, type HttpClient } from 'abap-adt-api';
import { RepositoryQueries, repositorySchemas, type RepositoryTool, type RepositoryInput } from './repository-query.js';
import { HttpClientException, type HttpClientOptions } from 'abap-adt-api/build/AdtHTTP.js';
import axios from 'axios';
import { XMLBuilder } from 'fast-xml-parser';
import type { Connection } from './config.js';
import { digest } from './config.js';
import { AppError, safeError } from './errors.js';
import { functionDefinition } from './function-signature.js';
import { parseTransportList, parseTransportDetails } from './transports.js';
import { groupActivationBody, activationResponse } from './activation.js';
import { probeEnhancementActivation, type EnhancementActivation } from './enhancements.js';
import { tableQuery, readOnlySql, queryResult, queryCapabilities, type TableQuery, type SqlQuery } from './data-query.js';

export type Version = 'active' | 'inactive';
export type ProgramKind = 'report' | 'include' | 'module_pool' | 'subroutine_pool';
const programTypes = { report: 'executableProgram', module_pool: 'modulePool', subroutine_pool: 'subroutinePool' } as const;
export function adtUri(uri: string): string {
  if (!uri.startsWith('/sap/bc/adt/') || /[?#\\\s]/.test(uri)) throw new AppError('INVALID_URI', 'Use an ADT relative object URI');
  let decoded: string;
  try { decoded = decodeURIComponent(uri); } catch { throw new AppError('INVALID_URI', 'Invalid URI encoding'); }
  if (decoded.includes('%') || decoded.includes('\\') || /[?#\x00-\x20]/.test(decoded) || decoded.split('/').some(s => s === '.' || s === '..')) {
    throw new AppError('INVALID_URI', 'Unsafe ADT URI');
  }
  return uri;
}
export function programUri(uri: string): string {
  adtUri(uri);
  if (!/^\/sap\/bc\/adt\/(?:programs\/(?:programs|includes)\/[a-zA-Z0-9_%]+|functions\/groups\/[a-zA-Z0-9_%]+(?:\/(?:fmodules|includes)\/[a-zA-Z0-9_%]+)?)(?:\/source\/main)?$/.test(uri)) {
    throw new AppError('CAPABILITY_UNSUPPORTED', 'Unsupported ABAP source object URI');
  }
  return uri.replace(/\/source\/main$/, '');
}
export function functionGroupUri(uri: string): string {
  const object = programUri(uri);
  const match = object.match(/^(\/sap\/bc\/adt\/functions\/groups\/[a-zA-Z0-9_%]+)(?:\/(?:fmodules|includes)\/[^/]+)?$/);
  if (!match) throw new AppError('INVALID_URI', 'Use a function group or member URI');
  return match[1];
}
export const isFunctionGroup = (uri: string) => /^\/sap\/bc\/adt\/functions\/groups\/[^/]+$/.test(uri);
export type GroupSnapshot = { object_uri: string; revision: string; name: string; members: { object_uri: string; version: Version; revision: string; hash: string; definition_comments_hash?: string }[] };
export type Source = { object_uri: string; source_uri: string; source: string; version: Version; revision: string; hash: string };
export type CreatedTransport = { request_number: string; owner: string; status: string; tasks: { task_number: string; owner: string; status: string }[]; tasks_truncated: boolean };
function verificationSource(source: string): string {
  const lines: string[] = [];
  let quote = '';
  for (const line of source.replace(/\r\n?/g, '\n').split('\n')) {
    // Empty lines inside a multi-line literal are data, not formatting.
    if (!quote && /^[ \t]*$/.test(line)) continue;
    lines.push(line);
    if (!quote && line.startsWith('*')) continue;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quote) {
        if (quote === '|' && c === '\\') { i++; continue; }
        if (c === quote) {
          if (quote !== '|' && line[i + 1] === quote) i++;
          else quote = '';
        }
      } else {
        if (c === '"') break;
        if (c === "'" || c === '`' || c === '|') quote = c;
      }
    }
  }
  return lines.join('\n');
}
export function savedSourceHash(source: string, objectUri?: string): string {
  if (objectUri && /\/fmodules\/[^/]+(?:\/source\/main)?$/.test(objectUri)) {
    const parsed = functionDefinition(source);
    if (parsed) return digest(JSON.stringify([parsed.signature, verificationSource(parsed.implementation)]));
  }
  return digest(verificationSource(source));
}
export function definitionCommentsHash(source: string, objectUri: string): string | undefined {
  if (!/\/fmodules\/[^/]+(?:\/source\/main)?$/.test(objectUri)) return undefined;
  const definition = functionDefinition(source);
  return definition ? digest(JSON.stringify(definition.comments)) : undefined;
}
export function compareSavedSource(left: string, right: string, objectUri?: string) {
  const strict = verificationSource(left) === verificationSource(right);
  if (strict) return { equivalent: true, normalization_applied: false, warnings: [] as string[] };
  if (!objectUri || !/\/fmodules\/[^/]+(?:\/source\/main)?$/.test(objectUri)) {
    return { equivalent: false, normalization_applied: false, warnings: [], difference: 'source' };
  }
  const a = functionDefinition(left); const b = functionDefinition(right);
  if (!a || !b) return { equivalent: false, normalization_applied: false, warnings: [], difference: 'unsupported_definition' };
  if (a.signature !== b.signature) return { equivalent: false, normalization_applied: false, warnings: [], difference: 'interface' };
  if (verificationSource(a.implementation) !== verificationSource(b.implementation)) {
    return { equivalent: false, normalization_applied: false, warnings: [], difference: 'implementation' };
  }
  return { equivalent: true, normalization_applied: true,
    warnings: JSON.stringify(a.comments) === JSON.stringify(b.comments) ? [] : ['FUNCTION_DEFINITION_COMMENTS_CHANGED'] };
}
export function sameSavedSource(left: string, right: string, objectUri?: string): boolean {
  return compareSavedSource(left, right, objectUri).equivalent;
}
export function sourceResult(connectionId: string, object: string, uri: string, source: string, version: Version): Source {
  const hash = digest(source);
  return { object_uri: object, source_uri: uri, source, version, hash,
    revision: digest(JSON.stringify([connectionId, uri, version, hash])) };
}
export interface Backend {
  inspectRepository?(tool: RepositoryTool, input: RepositoryInput): Promise<unknown>;
  enhancementActivation?(object: string, name: string, type: string): Promise<EnhancementActivation>;
  queryTable?(input: TableQuery): Promise<unknown>;
  querySql?(input: SqlQuery): Promise<unknown>;
  capabilities(): Promise<unknown>;
  search(query: string, type: string | undefined, limit: number): Promise<unknown>;
  listPackage(name: string, limit: number): Promise<unknown>;
  read(object: string, version: Version, source?: string): Promise<Source>;
  packageOf(object: string): Promise<string>;
  transportRequirement?(object: string, pkg: string, operation: 'I' | 'U'): Promise<'required' | 'not_required'>;
  lock(object: string): Promise<string>;
  unlock(object: string, handle: string): Promise<void>;
  save(source: string, code: string, handle: string, transport?: string): Promise<void>;
  create(name: string, description: string, pkg: string, transport?: string, kind?: ProgramKind): Promise<string>;
  createFunctionGroup?(name: string, description: string, pkg: string, transport?: string): Promise<string>;
  createFunctionModule?(name: string, description: string, group: string, transport?: string): Promise<string>;
  listFunctionGroupMembers?(group: string, limit: number): Promise<unknown>;
  functionGroupSnapshot?(group: string): Promise<GroupSnapshot>;
  check(object: string, version: Version): Promise<unknown>;
  activate(object: string, snapshot?: GroupSnapshot): Promise<{ success: boolean; messages: unknown[] }>;
  transports(): Promise<unknown>;
  createTransportRequest?(object: string, pkg: string, description: string): Promise<string>;
  verifyTransportRequest?(number: string): Promise<CreatedTransport | undefined>;
  close(): Promise<void>;
}

// Use a bounded client that never redirects authentication to another server.
class BoundedHttp implements HttpClient {
  lastFailure?: { http_status: number; request_path: string; request_method: string };
  constructor(private base: string, private onActivity?: () => void) {}
  async request(o: HttpClientOptions) {
    this.lastFailure = undefined;
    const url = new URL(o.url, this.base);
    if (url.origin !== this.base) throw new AppError('INVALID_URI', 'Cross-origin backend request rejected');
    try {
    const r = await axios.request<string>({ url: url.href, method: o.method ?? 'GET', headers: o.headers,
      params: o.qs, auth: o.auth, data: o.body, timeout: 15000, maxRedirects: 0,
      maxContentLength: 4 * 1024 * 1024, maxBodyLength: 2 * 1024 * 1024, responseType: 'text', proxy: false,
      validateStatus: () => true });
    if (r.status >= 400) this.lastFailure = {
      http_status: r.status, request_path: url.pathname, request_method: o.method ?? 'GET'
    };
    // ADT must process cookies even on error responses before classifying the error.
    if (r.status >= 300 && r.status < 400) throw new HttpClientException('Backend HTTP request failed', undefined, r.status, undefined, o,
      { body: r.data, status: r.status, statusText: r.statusText, headers: {} });
    return { body: r.data, status: r.status, statusText: r.statusText, headers: r.headers as Record<string, string> };
    } catch (error) {
      if (error instanceof HttpClientException) throw error;
      throw new HttpClientException('Backend network request failed', axios.isAxiosError(error) ? error.code : undefined,
        undefined, undefined, o);
    } finally { this.onActivity?.(); }
  }
}

export type AdtBackendOptions = { queryIdleTimeoutMs?: number; now?: () => number };

function queryIdleTimeoutMs() {
  const seconds = process.env.SAPLINK_QUERY_IDLE_TIMEOUT_SECONDS ?? '300';
  if (!/^[1-9]\d*$/.test(seconds) || Number(seconds) > 86400)
    throw new AppError('INVALID_CONFIG', 'SAPLINK_QUERY_IDLE_TIMEOUT_SECONDS must be an integer between 1 and 86400');
  return Number(seconds) * 1000;
}

export class AdtBackend implements Backend {
  private client: ADTClient;
  private reader: ADTClient;
  private readerHttp: BoundedHttp;
  private createReader: () => ADTClient;
  private readerLastActivity?: number;
  private readonly queryIdleTimeoutMs: number;
  private readonly now: () => number;
  constructor(private connection: Connection, password: string, options: AdtBackendOptions = {}) {
    this.queryIdleTimeoutMs = options.queryIdleTimeoutMs ?? queryIdleTimeoutMs();
    if (!Number.isSafeInteger(this.queryIdleTimeoutMs) || this.queryIdleTimeoutMs < 1 || this.queryIdleTimeoutMs > 86400000)
      throw new AppError('INVALID_CONFIG', 'Query reader idle timeout must be between 1 and 86400000 milliseconds');
    this.now = options.now ?? (() => performance.now());
    this.client = new ADTClient(new BoundedHttp(connection.base_url), connection.username, password, connection.client, connection.language);
    this.client.stateful = session_types.stateful;
    // Version probes must not alter the stateful editor context that owns SAP locks.
    this.readerHttp = new BoundedHttp(connection.base_url, () => { this.readerLastActivity = this.now(); });
    this.createReader = () => new ADTClient(this.readerHttp, connection.username, password, connection.client, connection.language);
    this.reader = this.createReader();
  }
  async capabilities() {
    const discovery = await this.client.adtDiscovery();
    if (!discovery.length) throw new AppError('ADT_UNAVAILABLE', 'Backend did not return a usable ADT discovery document');
    return { discovery, data_query: queryCapabilities(discovery), probed_at: new Date().toISOString(),
      source_lock_policy: { function_module: 'module', function_group_include: 'parent_group' },
      repository_query: { tools: Object.keys(repositorySchemas), source_version: 'active', max_items: 500,
        availability_policy: 'Tools are implemented locally; backend availability and authorization must be verified by actual calls' },
      source_read_policy: 'separate_stateless_session',
      source_verification_policy: 'conservative_function_definition_tokens_v1',
      transport_policy: 'sap_cts_preflight_when_task_omitted',
      limitations: ['Programs, Includes, function groups and function modules are supported subject to SAP permissions', 'Function module signature editing requires backend support for source-based declarations; no structured parameter tool is provided', 'Source revision checks use hashes under SAP object locks'] };
  }
  async inspectRepository(tool: RepositoryTool, input: RepositoryInput) {
    return new RepositoryQueries(this.reader, (object, version) => this.read(object, version), adtUri).run(tool, input);
  }
  async search(query: string, type: string | undefined, limit: number) {
    const requestedType = type?.toUpperCase();
    // The ADT library sends only the type family (PROG), so enforce subtypes locally.
    const fetchLimit = requestedType?.includes('/') ? 501 : limit + 1;
    const rows = await this.client.searchObject(query, requestedType, fetchLimit);
    const matches = rows.filter(r => !requestedType || (requestedType.includes('/')
      ? r['adtcore:type'].toUpperCase() === requestedType
      : r['adtcore:type'].split('/')[0].toUpperCase() === requestedType));
    return { objects: matches.slice(0, limit).map(r => ({ name: r['adtcore:name'], type: r['adtcore:type'],
      package_name: r['adtcore:packageName'], object_uri: adtUri(r['adtcore:uri']), description: r['adtcore:description'] })),
      truncated: matches.length > limit || rows.length >= fetchLimit };
  }
  async enhancementActivation(object: string, name: string, type: string): Promise<EnhancementActivation> {
    const uri = adtUri(object);
    return probeEnhancementActivation(async version => {
      const { metaData } = await this.reader.objectStructure(uri, version);
      return { name: metaData['adtcore:name'], type: metaData['adtcore:type'], version: metaData['adtcore:version'] };
    }, name, type);
  }
  private async recreateReader() {
    if (this.reader.loggedin) await this.reader.logout().catch(() => {});
    this.reader = this.createReader();
    this.readerLastActivity = undefined;
  }
  private async dataQuery(run: () => Promise<{ columns: unknown[]; values: unknown[] }>, limit: number) {
    let sessionRecovery: string | undefined;
    if (this.readerLastActivity !== undefined && this.now() - this.readerLastActivity >= this.queryIdleTimeoutMs) {
      await this.recreateReader();
      sessionRecovery = 'reader_recreated_after_idle_timeout';
    }
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const result = queryResult(await run(), limit);
        return { ...result, ...(sessionRecovery ? { session_recovery: sessionRecovery } : {}) };
      }
      catch (error) {
        const failure = safeError(error);
        const transport = this.readerHttp.lastFailure;
        const status = (failure.details as { http_status?: number } | undefined)?.http_status;
        const previewFailure = transport && ['/sap/bc/adt/datapreview/ddic', '/sap/bc/adt/datapreview/freestyle'].includes(transport.request_path);
        if (attempt === 1 && status === 404 && previewFailure) {
          // Refresh only the stateless reader, preserving the editor and its locks.
          await this.recreateReader();
          sessionRecovery = 'reader_recreated_after_http_404';
          continue;
        }
        if (status && [404, 405, 501].includes(status)) {
          throw new AppError(previewFailure ? 'DATA_PREVIEW_FAILED' : failure.code,
            previewFailure ? 'SAP data preview request failed; HTTP status alone does not establish missing capability'
              : failure.message,
            { ...(failure.details as Record<string, unknown> | undefined), ...transport, attempts: attempt, reader_recreated: Boolean(sessionRecovery), session_recovery: sessionRecovery });
        }
        throw error;
      }
    }
    throw new AppError('DATA_PREVIEW_FAILED', 'SAP data preview retry exhausted');
  }
  async queryTable(input: TableQuery) {
    const p = tableQuery(input);
    return this.dataQuery(() => this.reader.tableContents(p.table_name, p.limit + 1, false, p.sql), p.limit);
  }
  async querySql(input: SqlQuery) {
    const p = readOnlySql(input);
    return this.dataQuery(() => this.reader.runQuery(p.sql, p.limit + 1, false), p.limit);
  }
  async listPackage(name: string, limit: number) {
    const result = await this.client.nodeContents('DEVC/K', name);
    const objects = result.nodes.filter(node => typeof node.OBJECT_URI === 'string' && node.OBJECT_URI.trim().length > 0);
    return { objects: objects.slice(0, limit), truncated: objects.length > limit,
      pagination_supported: false };
  }
  async read(object: string, version: Version, requestedSource?: string) {
    adtUri(object);
    const metadata = await this.reader.objectStructure(object, version);
    if (metadata.metaData['adtcore:version'] !== version) throw new AppError('VERSION_UNAVAILABLE', 'Backend did not return the requested version');
    const sourceUri = adtUri(ADTClient.mainInclude(metadata, false));
    if (sourceUri === object) throw new AppError('CAPABILITY_UNSUPPORTED', 'Object does not expose a main source');
    if (requestedSource && adtUri(requestedSource) !== sourceUri) throw new AppError('INVALID_URI', 'Only the discovered main source is supported');
    return sourceResult(this.connection.connection_id, object, sourceUri, await this.reader.getObjectSource(sourceUri, { version }), version);
  }
  async packageOf(object: string) {
    const objectUri = programUri(object);
    const metadata = await this.client.objectStructure(objectUri);
    const expectedType = objectUri.startsWith('/sap/bc/adt/programs/includes/') ? 'PROG/I'
      : objectUri.startsWith('/sap/bc/adt/programs/programs/') ? 'PROG/P'
      : objectUri.includes('/fmodules/') ? 'FUGR/FF' : objectUri.includes('/includes/') ? 'FUGR/I' : 'FUGR/F';
    if (metadata.metaData['adtcore:type'] !== expectedType) {
      throw new AppError('CAPABILITY_UNSUPPORTED', 'Object metadata does not match its URI');
    }
    const path = await this.client.findObjectPath(adtUri(object));
    const pkg = [...path].reverse().find(p => p['adtcore:type'] === 'DEVC/K');
    if (!pkg) throw new AppError('PACKAGE_UNKNOWN', 'Cannot verify the owning package');
    return pkg['adtcore:name'];
  }
  private lockUri(object: string) {
    const uri = programUri(object);
    // Function module source saving requires the module's own ADT lock handle.
    return uri.startsWith('/sap/bc/adt/functions/groups/') && !uri.includes('/fmodules/') ? functionGroupUri(uri) : uri;
  }
  async transportRequirement(object: string, pkg: string, _operation: 'I' | 'U') {
    // CTS operation I inserts an object into change recording, for both create and edit.
    const info = await this.reader.transportInfo(programUri(object), pkg, 'I');
    if (info.RESULT === 'S' && info.RECORDING === 'X') return 'required' as const;
    if (info.RESULT === 'S' && info.RECORDING === '' && info.KORRFLAG === '') return 'not_required' as const;
    throw new AppError('TRANSPORT_CHECK_UNAVAILABLE', 'SAP returned an ambiguous transport requirement; provide an explicit task or verify CTS settings.');
  }
  async lock(object: string) { return (await this.client.lock(this.lockUri(object))).LOCK_HANDLE; }
  async unlock(object: string, handle: string) { await this.client.unLock(this.lockUri(object), handle); }
  private async correctionRequest(transport?: string): Promise<string | undefined> {
    if (transport) {
      const listed = await this.transports();
      const matches = listed.workbench.flatMap(target => target.modifiable)
        .filter(request => request.tasks.some(task => task['tm:number'] === transport &&
          task['tm:owner']?.toUpperCase() === this.connection.username.toUpperCase() &&
          ['D', 'modifiable'].includes(task['tm:status'])));
      const parents = [...new Set(matches.map(request => request['tm:number']))];
      if (parents.length !== 1 || !/^[A-Z0-9]{3}K[0-9]{6}$/.test(parents[0])) {
        throw new AppError('TRANSPORT_TASK_INVALID', 'Cannot resolve the supplied task to one modifiable workbench request for the configured user. No create or save request was sent.');
      }
      return parents[0];
    }
    return undefined;
  }
  async save(source: string, code: string, handle: string, transport?: string) {
    programUri(source);
    const correction = await this.correctionRequest(transport);
    await this.client.setObjectSource(source, code, handle, correction);
  }
  async create(name: string, description: string, pkg: string, transport?: string, kind: ProgramKind = 'report') {
    const include = kind === 'include';
    const objectType = include ? 'PROG/I' : 'PROG/P';
    const collection = include ? 'includes' : 'programs';
    const prefix = include ? 'include' : 'program';
    const validation = await this.client.validateNewObject({ objtype: objectType, objname: name, description, packagename: pkg });
    if (!validation.success) throw new AppError('CREATE_VALIDATION_FAILED', 'Backend rejected program creation', validation);
    const root = `${prefix}:${include ? 'abapInclude' : 'abapProgram'}`;
    const body = new XMLBuilder({ ignoreAttributes: false }).build({ [root]: {
      [`@_xmlns:${prefix}`]: `http://www.sap.com/adt/programs/${collection}`,
      '@_xmlns:adtcore': 'http://www.sap.com/adt/core', '@_adtcore:name': name,
      '@_adtcore:type': objectType, '@_adtcore:description': description,
      '@_adtcore:responsible': this.connection.username, '@_adtcore:language': this.connection.language,
      '@_adtcore:masterLanguage': this.connection.language,
      ...(!include ? { '@_program:programType': programTypes[kind] } : {}),
      'adtcore:packageRef': { '@_adtcore:name': pkg }
    } });
    const uri = `/sap/bc/adt/programs/${collection}/${encodeURIComponent(name.toLowerCase())}`;
    await this.client.httpClient.request(`/sap/bc/adt/programs/${collection}`, {
      method: 'POST', headers: { 'Content-Type': 'application/*' }, body,
      ...(transport ? { qs: { corrNr: transport } } : {})
    });
    const metadata = await this.client.objectStructure(uri, 'inactive');
    if (metadata.metaData['adtcore:type'] !== objectType || (!include &&
        (!('program:programType' in metadata.metaData) || metadata.metaData['program:programType'] !== programTypes[kind]))) {
      throw new AppError('VERIFY_FAILED', 'Created object does not match the requested type', { object_uri: uri, program_kind: kind });
    }
    return uri;
  }
  async createFunctionGroup(name: string, description: string, pkg: string, transport?: string) {
    const validation = await this.client.validateNewObject({ objtype: 'FUGR/F', objname: name, description, packagename: pkg });
    if (!validation.success) throw new AppError('CREATE_VALIDATION_FAILED', 'SAP rejected function group creation', validation);
    const uri = `/sap/bc/adt/functions/groups/${encodeURIComponent(name.toLowerCase())}`;
    await this.createFunctionXml('/sap/bc/adt/functions/groups', 'group', 'abapFunctionGroup', 'FUGR/F', name, description,
      { 'adtcore:packageRef': { '@_adtcore:name': pkg } }, transport);
    await this.verifyFunctionCreated(uri, 'FUGR/F'); return uri;
  }
  async createFunctionModule(name: string, description: string, group: string, transport?: string) {
    const groupUri = functionGroupUri(group);
    if (group !== groupUri) throw new AppError('INVALID_URI', 'Specify the parent function group itself');
    // Adding a module updates the existing group's UXX include. Like source PUT,
    // this needs the parent correction request, not the task used to create the group.
    const correction = await this.correctionRequest(transport);
    const parent = await this.client.objectStructure(groupUri);
    if (parent.metaData['adtcore:type'] !== 'FUGR/F') throw new AppError('CAPABILITY_UNSUPPORTED', 'Parent is not a function group');
    const validation = await this.client.validateNewObject({ objtype: 'FUGR/FF', objname: name, description, fugrname: parent.metaData['adtcore:name'] });
    if (!validation.success) throw new AppError('CREATE_VALIDATION_FAILED', 'SAP rejected function module creation', validation);
    const uri = `${groupUri}/fmodules/${encodeURIComponent(name.toLowerCase())}`;
    await this.createFunctionXml(`${groupUri}/fmodules`, 'fmodule', 'abapFunctionModule', 'FUGR/FF', name, description,
      { 'adtcore:containerRef': { '@_adtcore:name': parent.metaData['adtcore:name'], '@_adtcore:type': 'FUGR/F', '@_adtcore:uri': groupUri } }, correction);
    await this.verifyFunctionCreated(uri, 'FUGR/FF'); return uri;
  }
  private async createFunctionXml(path: string, prefix: string, root: string, type: string, name: string,
    description: string, children: Record<string, unknown>, transport?: string) {
    const namespace = type === 'FUGR/F' ? 'groups' : 'fmodules';
    const body = new XMLBuilder({ ignoreAttributes: false }).build({ [`${prefix}:${root}`]: {
      [`@_xmlns:${prefix}`]: `http://www.sap.com/adt/functions/${namespace}`,
      '@_xmlns:adtcore': 'http://www.sap.com/adt/core', '@_adtcore:name': name, '@_adtcore:type': type,
      '@_adtcore:description': description, '@_adtcore:responsible': this.connection.username,
      '@_adtcore:language': this.connection.language, ...children
    } });
    await this.client.httpClient.request(path, { method: 'POST', headers: { 'Content-Type': 'application/*' }, body,
      ...(transport ? { qs: { corrNr: transport } } : {}) });
  }
  private async verifyFunctionCreated(uri: string, type: string) {
    const metadata = await this.client.objectStructure(uri);
    if (metadata.metaData['adtcore:type'] !== type) throw new AppError('VERIFY_FAILED', 'Created function object type differs', { object_uri: uri });
  }
  async listFunctionGroupMembers(group: string, limit: number) {
    const uri = functionGroupUri(group);
    if (uri !== group) throw new AppError('INVALID_URI', 'Specify the function group itself');
    const metadata = await this.client.objectStructure(uri);
    if (metadata.metaData['adtcore:type'] !== 'FUGR/F') throw new AppError('CAPABILITY_UNSUPPORTED', 'Object is not a function group');
    const result = await this.client.nodeContents('FUGR/F', metadata.metaData['adtcore:name']);
    const members = result.nodes.filter(n => ['FUGR/FF', 'FUGR/I'].includes(n.OBJECT_TYPE) && n.OBJECT_URI &&
      functionGroupUri(n.OBJECT_URI) === uri);
    return { object_uri: uri, members: members.slice(0, limit).map(n => ({ name: n.OBJECT_NAME, type: n.OBJECT_TYPE,
      object_uri: adtUri(n.OBJECT_URI), description: n.DESCRIPTION })), truncated: members.length > limit, pagination_supported: false };
  }
  async functionGroupSnapshot(group: string): Promise<GroupSnapshot> {
    const listed = await this.listFunctionGroupMembers(group, 500);
    if (listed.truncated) throw new AppError('CAPABILITY_UNSUPPORTED', 'Function group exceeds snapshot limit');
    const metadata = await this.client.objectStructure(group);
    const members: GroupSnapshot['members'] = [];
    for (const row of listed.members.sort((a, b) => a.object_uri.localeCompare(b.object_uri))) {
      let source: Source;
      try { source = await this.read(row.object_uri, 'inactive'); }
      catch (error) {
        if (!['OBJECT_NOT_FOUND', 'VERSION_UNAVAILABLE'].includes(safeError(error).code)) throw error;
        source = await this.read(row.object_uri, 'active');
      }
      const comments = definitionCommentsHash(source.source, row.object_uri);
      members.push({ object_uri: row.object_uri, version: source.version, revision: source.revision, hash: savedSourceHash(source.source, row.object_uri),
        ...(comments ? { definition_comments_hash: comments } : {}) });
    }
    const name = metadata.metaData['adtcore:name'];
    const revision = digest(JSON.stringify([this.connection.connection_id, group, name, metadata.metaData['adtcore:changedAt'], members]));
    return { object_uri: group, name, revision, members };
  }
  async check(object: string, version: Version) {
    const source = await this.read(object, version);
    const diagnostics = await this.client.syntaxCheck(object, source.source_uri, source.source, undefined, version);
    return { passed: !diagnostics.some(d => ['E', 'A', 'X', 'error'].includes(d.severity)), diagnostics,
      position_format: 'backend-native; line and offset require real-system verification' };
  }
  async activate(object: string, snapshot?: GroupSnapshot) {
    if (isFunctionGroup(object)) {
      if (!snapshot || snapshot.object_uri !== object) throw new AppError('VERSION_CONFLICT', 'Group activation requires a matching member snapshot');
      // Validate the complete snapshot before sending any activation request.
      for (const member of snapshot.members) {
        if (functionGroupUri(member.object_uri) !== object || member.object_uri === object) {
          throw new AppError('INVALID_URI', 'Activation member belongs to another group');
        }
      }
      const targets = [...new Set([...snapshot.members.filter(member => member.version === 'inactive')
        .map(member => member.object_uri), object])];
      const members = [];
      for (const uri of targets) {
        const metadata = await this.reader.objectStructure(uri);
        members.push({ uri, name: metadata.metaData['adtcore:name'] });
      }
      const results: { object_uri: string; success: boolean; messages: unknown[] }[] = [];
      for (const member of members) {
        try {
          // Use the same minimal reference format that works for single-object activation.
          let result = await this.client.activate(member.name, member.uri);
          if (result.inactive.length && !result.messages.some(message => /[EAX]/.test(message.type))) {
            const body = groupActivationBody(result, object, snapshot.members.map(member => member.object_uri), this.connection.username);
            const response = await this.client.httpClient.request('/sap/bc/adt/activation', {
              method: 'POST', qs: { method: 'activate', preauditRequested: false },
              headers: { 'Content-Type': 'application/xml', Accept: 'application/xml' }, body
            });
            const completed = activationResponse(response.body);
            result = { ...completed, messages: [...result.messages, ...completed.messages] };
          }
          results.push({ object_uri: member.uri, ...result });
          if (!result.success) return { success: false, messages: results.flatMap(r => r.messages), member_results: results };
        } catch (error) {
          const failure = safeError(error);
          throw new AppError(failure.code, failure.message, { member_results: results,
            failed_object_uri: member.uri, cause: failure.details });
        }
      }
      return { success: true, messages: results.flatMap(r => r.messages), member_results: results };
    }
    const metadata = await this.client.objectStructure(programUri(object), 'inactive');
    return this.client.activate(metadata.metaData['adtcore:name'], object);
  }
  async transports() {
    const response = await this.reader.httpClient.request('/sap/bc/adt/cts/transportrequests', {
      qs: { user: this.connection.username, targets: true },
      headers: { Accept: 'application/vnd.sap.adt.transportorganizertree.v1+xml' }
    });
    try { return parseTransportList(response.body); }
    catch (error) {
      if (!(error instanceof AppError) || error.code !== 'TRANSPORT_RESPONSE_INVALID' ||
          (error.details as { response_element_paths?: string[] } | undefined)?.response_element_paths?.length !== 0) throw error;
      // Newer ADT servers may return an empty root for the legacy user query.
      // Reuse a matching saved configuration without creating or modifying SAP settings.
      const configurations = await this.reader.transportConfigurations();
      const enabled = (value: unknown) => value === true || value === 'true' || value === 'X';
      for (const entry of configurations.slice(0, 10)) {
        const uri = adtUri(entry.link);
        if (!uri.startsWith('/sap/bc/adt/cts/transportrequests/searchconfiguration/configurations/')) continue;
        const config = await this.reader.getTransportConfiguration(uri);
        if (config.User?.toUpperCase() !== this.connection.username.toUpperCase() ||
            !enabled(config.WorkbenchRequests) || !enabled(config.Modifiable)) continue;
        const configured = await this.reader.httpClient.request('/sap/bc/adt/cts/transportrequests', {
          qs: { configUri: uri, targets: true },
          headers: { Accept: 'application/vnd.sap.adt.transportorganizertree.v1+xml' }
        });
        return parseTransportList(configured.body);
      }
      throw new AppError('TRANSPORT_QUERY_CONFIG_REQUIRED',
        'Legacy user query returned no categories and no suitable saved search configuration was found. Save an ADT Transport Organizer configuration for the configured user with WorkbenchRequests and Modifiable enabled, then retry. No configuration was changed.',
        { configurations_checked: Math.min(configurations.length, 10) });
    }
  }
  async createTransportRequest(object: string, pkg: string, description: string) {
    const number = (await this.client.createTransport(programUri(object), description, pkg)).trim();
    if (!/^[A-Z0-9]{3}K[0-9]{6}$/.test(number)) {
      throw new AppError('TRANSPORT_RESPONSE_INVALID', 'SAP may have created a request but returned no valid transport number. Query existing requests before any retry.');
    }
    return number;
  }
  async verifyTransportRequest(number: string): Promise<CreatedTransport | undefined> {
    const listed = await this.transports();
    if (!listed.workbench.some(target => target.modifiable.some(request => request['tm:number'] === number || request.tasks.some(task => task['tm:number'] === number)))) {
      const response = await this.reader.httpClient.request(`/sap/bc/adt/cts/transportrequests/${number}`, {
        headers: { Accept: 'application/vnd.sap.adt.transportorganizer.v1+xml' }
      });
      if (response.body.trim()) {
        const detail = parseTransportDetails(response.body);
        // Only classify independently read details when SAP explicitly identifies a modifiable workbench request.
        if (detail && detail['tm:number'] === number && ['D', 'modifiable'].includes(detail['tm:status']) &&
            (detail as unknown as Record<string, string>)['tm:type'] === 'K' &&
            detail['tm:owner']?.toUpperCase() === this.connection.username.toUpperCase()) {
          listed.workbench.push({ 'tm:name': '', 'tm:desc': '', modifiable: [detail], released: [] });
        }
      }
    }
    for (const target of listed.workbench) {
      for (const request of target.modifiable) {
        if (request['tm:number'] !== number && !request.tasks.some(task => task['tm:number'] === number)) continue;
        if (!/^[A-Z0-9]{3}K[0-9]{6}$/.test(request['tm:number'])) return undefined;
        const tasks = request.tasks.filter(task => task['tm:owner']?.toUpperCase() === this.connection.username.toUpperCase());
        if (tasks.some(task => !/^[A-Z0-9]{3}K[0-9]{6}$/.test(task['tm:number']))) return undefined;
        return { request_number: request['tm:number'], owner: request['tm:owner'], status: request['tm:status'],
          tasks: tasks.slice(0, 20).map(task => ({ task_number: task['tm:number'], owner: task['tm:owner'], status: task['tm:status'] })),
          tasks_truncated: tasks.length > 20 };
      }
    }
    return undefined;
  }
  async close() {
    try { if (this.client.loggedin) await this.client.logout(); }
    finally { if (this.reader.loggedin) await this.reader.logout(); }
  }
}
