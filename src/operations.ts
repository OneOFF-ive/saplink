import { applySourceEdits, sourceUpdateSchema, type SourceEdit } from './source-edit.js';
import { randomUUID } from 'node:crypto';
import { qualitySchemas, qualityObject, type QualityInput, type QualityTool } from './quality-tools.js';
import { repositorySchemas, type RepositoryInput, type RepositoryTool } from './repository-query.js';
import { searchEnhancements } from './enhancements.js';
import { AdtBackend, adtUri, programUri, functionGroupUri, isFunctionGroup, compareSavedSource, savedSourceHash, definitionCommentsHash, type Backend, type Version, type ProgramKind, type Source, type GroupSnapshot, type BatchActivationResult } from './adt.js';
import { ConfigStore, digest, type Connection, type Credentials } from './config.js';
import { AuditLog } from './audit.js';
import { AppError, safeError } from './errors.js';
import { functionModuleGuidance } from './function-help.js';
import { tableQuerySchema, readOnlySql, type TableQuery } from './data-query.js';
import { writeTools } from './tool-policy.js';
import { validateRequestTimeout } from './request-timeout.js';

export type Input = RepositoryInput & QualityInput & {
  timeout_ms?: number;
  connection_id?: string;
  query?: string;
  type?: string;
  limit?: number;
  package_name?: string;
  object_uri?: string;
  source_uri?: string;
  version?: Version;
  source?: string;
  edits?: SourceEdit[];
  include_source?: boolean;
  expected_revision?: string;
  name?: string;
  description?: string;
  transport_task?: string;
  transport_number?: string;
  request_id?: string;
  program_kind?: ProgramKind;
  function_group_uri?: string;
  table_name?: string;
  fields?: string[];
  filters?: TableQuery['filters'];
  sql?: string;
  objects?: {
    object_uri: string;
    expected_revision: string;
  }[];
};

type SourceSaveState = {
  saved: boolean | 'unknown';
  verification: 'not_run' | 'pending' | 'passed' | 'failed' | 'unavailable';
  object_uri: string;
  source_uri?: string;
  inactive_revision?: string;
  next_action?: string;
  normalization_applied?: boolean;
  difference?: string;
};

export type Result = {
  operation_id: string;
  status: string;
  completed_steps: string[];
  data?: unknown;
  source_save?: SourceSaveState;
  outcome?: string;
  write_dispatched?: boolean;
  error?: ReturnType<typeof safeError>;
  warnings?: string[];
};

type Context = {
  steps: string[];
  dispatched: boolean;
  confirmed: boolean;
  warnings: string[];
  source_save?: SourceSaveState;
  diagnostic: (details: unknown) => Promise<void>;
  event: (phase: string) => Promise<void>;
};

export type BackendFactory = (c: Connection, password: string) => Backend;
export type CacheClearResult = { cleared_sessions: number; retained_write_requests: number };

function auditFailureDetails(details: unknown): Record<string, unknown> {
  const diagnostic = details as Record<string, unknown> | undefined;
  const safeDetails: Record<string, unknown> = {};
  for (const key of ['http_status', 'elapsed_ms', 'timeout_ms', 'attempts', 'reader_recreated', 'request_body_bytes', 'request_finished', 'socket_reused', 'response_started', 'request_content_length', 'request_chunked', 'request_connection_close']) {
    const value = diagnostic?.[key];
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) safeDetails[key] = value;
  }
  for (const key of ['request_method', 'network_code', 'cause_code', 'error_kind', 'session_recovery', 'sap_error_type', 'sap_message_id', 'sap_message_number', 'request_charset', 'request_content_encoding', 'transport']) {
    const value = diagnostic?.[key];
    if (typeof value === 'string' && /^[a-z0-9_-]{1,80}$/i.test(value)) safeDetails[key] = value;
  }
  for (const key of ['request_content_type', 'response_content_type']) {
    const value = diagnostic?.[key];
    if (typeof value === 'string' && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(value)) safeDetails[key] = value.slice(0, 100);
  }
  if (['1.0', '1.1', '2.0'].includes(String(diagnostic?.http_version))) safeDetails.http_version = diagnostic?.http_version;
  const path = diagnostic?.request_path;
  if (typeof path === 'string' && /^\/sap\/bc\/adt\/[a-z0-9_./%-]+$/i.test(path)) safeDetails.request_path = path.slice(0, 512);
  return safeDetails;
}

const recoverableSessionErrors = new Set(['AUTH_FAILED', 'CSRF_FAILED', 'HTTP_FORBIDDEN', 'ADT_ERROR', 'OUTCOME_UNKNOWN', 'RFC_CONTEXT_LOST']);

const cachedResultLimit = 32 * 1024;

function cacheResult(result: Result): Result {
  const compact: Result = JSON.parse(JSON.stringify(result, (key, value) => key === 'source' ? undefined : value));
  if (Buffer.byteLength(JSON.stringify(compact), 'utf8') <= cachedResultLimit)
    return compact;
  return {
    operation_id: result.operation_id,
    status: result.status,
    completed_steps: result.completed_steps,
    outcome: result.outcome,
    write_dispatched: result.write_dispatched,
    error: result.error ? {
      code: result.error.code,
      message: result.error.message.slice(0, 2048)
    } : undefined,
    warnings: [...(result.warnings ?? []), 'CACHED_DETAILS_OMITTED']
  };
}

export class Operations {
  private sessions = new Map<string, Backend>();
  private queues = new Map<string, Promise<unknown>>();
  private requests = new Map<string, {
    hash: string;
    result: Promise<Result>;
  }>();
  private pending = 0;
  private poisoned = new Set<Backend>();
  private closing = false;
  private maintenance: Promise<CacheClearResult> | undefined;

  constructor(private store: ConfigStore, private credentials: Credentials, private audit = new AuditLog(), private factory: BackendFactory = (c, p) => new AdtBackend(c, p), private cacheEntryLimit = 512) { }

  async run(tool: string, input: Input): Promise<Result> {
    validateRequestTimeout(input.timeout_ms);
    if (this.closing)
      throw new AppError('SERVER_STOPPING', 'Server is stopping');
    if (this.maintenance) throw new AppError('BUSY', '正在清理连接缓存，请稍后重试。');
    if (this.pending >= 100)
      throw new AppError('BUSY', 'Too many pending operations');
    if (writeTools.has(tool)) {
      const key = JSON.stringify([input.connection_id, input.request_id]);
      // Changing a transport timeout must never turn a repeated write into a
      // new intent, nor prevent retrieval of its already-dispatched result.
      const { timeout_ms: _timeout, ...intent } = input;
      const hash = digest(JSON.stringify([tool, intent]));
      const existing = this.requests.get(key);
      if (existing) {
        if (existing.hash !== hash)
          throw new AppError('REQUEST_ID_CONFLICT', 'Request ID was already used with different parameters');
        return existing.result;
      }
      if (this.requests.size >= this.cacheEntryLimit)
        throw new AppError('REQUEST_LIMIT', 'Request cache is full; confirm pending operations before restarting');
      const result = this.enqueue(tool, input);
      this.requests.set(key, {
        hash,
        result: result.then(cacheResult)
      });
      return result;
    }
    return this.enqueue(tool, input);
  }

  private enqueue(tool: string, input: Input) {
    const key = input.connection_id ?? 'list';
    this.pending++;
    const result = (this.queues.get(key) ?? Promise.resolve()).catch(() => { }).then(() => this.execute(tool, input));
    const tail = result.finally(() => {
      this.pending--;
      if (this.queues.get(key) === tail)
        this.queues.delete(key);
    });
    this.queues.set(key, tail);
    return tail;
  }

  private async execute(tool: string, input: Input): Promise<Result> {
    const { timeout_ms: timeoutMs, ...operationInput } = input;
    let backend: Backend | undefined;
    const id = randomUUID();
    const context: Context = {
      steps: [],
      dispatched: false,
      confirmed: false,
      warnings: [],
      diagnostic: async details => {
        try {
          await this.audit.append({ operation_id: id, request_id: input.request_id, connection_id: input.connection_id,
            tool, event: 'source_save_http_completed', ...auditFailureDetails(details) });
        } catch { context.warnings.push('LOG_WRITE_FAILED'); }
      },
      event: async (phase) => {
        context.steps.push(phase);
        try {
          await this.audit.append({
            operation_id: id,
            request_id: input.request_id,
            connection_id: input.connection_id,
            tool,
            object_uri: input.object_uri ?? input.source_uri,
            event: phase,
            completed_steps: [...context.steps]
          });
        }
        catch {
          if (!context.dispatched)
            throw new AppError('LOG_UNAVAILABLE', 'Cannot record operation before writing');
          context.warnings.push('LOG_WRITE_FAILED');
        }
      }
    };
    try {
      const config = await this.store.load();
      if (tool === 'list_connections')
        return {
          operation_id: id,
          status: 'success',
          completed_steps: [],
          data: config.connections.map(c => ({
            connection_id: c.connection_id,
            name: c.name,
            base_url: c.base_url,
            client: c.client,
            language: c.language,
            username: c.username,
            write_enabled: c.write_enabled,
            ...(c.rfc ? { transport: 'rfc', rfc: c.rfc } : {})
          }))
        };
      const connection = config.connections.find(c => c.connection_id === input.connection_id);
      if (!connection)
        throw new AppError('CONNECTION_NOT_FOUND', 'Unknown connection ID');
      if (writeTools.has(tool) && !connection.write_enabled)
        throw new AppError('WRITE_DISABLED', 'Enable writes in local connection settings first');
      backend = this.sessions.get(connection.connection_id);
      const cachedSession = Boolean(backend);
      if (!backend) {
        backend = this.factory(connection, await this.credentials.get(connection.connection_id));
        this.sessions.set(connection.connection_id, backend);
      }
      if (writeTools.has(tool) && this.poisoned.has(backend))
        throw new AppError('SESSION_NEEDS_REVIEW', 'Previous lock cleanup failed; verify SAP locks before restarting the service');
      backend.setRequestTimeout?.(timeoutMs);
      if (writeTools.has(tool)) {
        // Connection queues ensure no other operation is using the session during replacement.
        if (cachedSession) {
          this.sessions.delete(connection.connection_id);
          await backend.close().catch(() => { });
          backend = this.factory(connection, await this.credentials.get(connection.connection_id));
          this.sessions.set(connection.connection_id, backend);
          backend.setRequestTimeout?.(timeoutMs);
        }
        context.steps.push('write_session_check_started');
        try {
          await backend.capabilities();
          context.steps.push('write_session_ready');
        }
        catch (error) {
          this.sessions.delete(connection.connection_id);
          await backend.close().catch(() => { });
          throw error;
        }
      }
      let data: unknown;
      try {
        data = await this.dispatch(tool, operationInput, connection, backend, context);
      }
      catch (error) {
        // Retry only read operations, once, on a previously cached and unlocked session.
        if (writeTools.has(tool) || !cachedSession || this.poisoned.has(backend) ||
          !recoverableSessionErrors.has(safeError(error).code))
          throw error;
        const retryFailure = safeError(error);
        try {
          await this.audit.append({ operation_id: id, connection_id: input.connection_id, tool,
            event: 'session_recovery_started', error_code: retryFailure.code,
            ...auditFailureDetails(retryFailure.details) });
        } catch { context.warnings.push('LOG_WRITE_FAILED'); }
        await backend.close().catch(() => { });
        this.sessions.delete(connection.connection_id);
        backend = this.factory(connection, await this.credentials.get(connection.connection_id));
        this.sessions.set(connection.connection_id, backend);
        backend.setRequestTimeout?.(timeoutMs);
        context.steps.push('session_recreated');
        data = await this.dispatch(tool, operationInput, connection, backend, context);
      }
      if (tool === 'query_table' || tool === 'query_sql') {
        const queryData = data as { row_count?: number; session_recovery?: string };
        if (queryData.session_recovery) context.steps.push('query_reader_recreated');
        try {
          await this.audit.append({
            operation_id: id, connection_id: input.connection_id, tool,
            event: 'data_query_completed', completed_steps: [...context.steps],
            row_count: queryData.row_count, reader_recreated: Boolean(queryData.session_recovery),
            session_recovery: queryData.session_recovery
          });
        } catch { context.warnings.push('LOG_WRITE_FAILED'); }
      }
      return {
        operation_id: id,
        status: 'success',
        completed_steps: context.steps,
        data,
        ...(context.source_save ? { source_save: context.source_save } : {}),
        ...(writeTools.has(tool) ? {
          outcome: 'confirmed',
          write_dispatched: context.dispatched
        } : {}),
        ...(context.warnings.length ? { warnings: context.warnings } : {})
      };
    }
    catch (error) {
      const failure = safeError(error);
      const details = failure.details as Record<string, unknown> | undefined;
      if (tool === 'read_source' && input.version === 'inactive' && failure.code === 'VERSION_UNAVAILABLE') {
        failure.details = {
          ...details,
          requested_version: 'inactive',
          object_uri: input.object_uri,
          guidance: ("The requested inactive version is unavailable. This can be normal for an activated object; it does not by " +
            "itself prove activation success. Explicitly read active to obtain its source and revision. Review that " +
            "source before using its revision in update_source; do not blindly overwrite. No version fallback was " +
            "performed."),
          next_action: {
            tool: 'read_source',
            arguments: {
              connection_id: input.connection_id,
              object_uri: input.object_uri,
              version: 'active'
            }
          }
        };
      }
      if (tool === 'update_source' && (input.object_uri ?? input.source_uri)?.includes('/fmodules/') &&
        details?.http_status === 400 && details.sap_error_type === 'ExceptionResourceScanDuringSaveFailure') {
        failure.details = {
          ...details,
          hints: [
            'Check the FUNCTION definition, not CALL FUNCTION syntax: EXCEPTIONS lists names only (e.g. INVALID_INPUT.), never name = 1.',
            'Use ADT parameter typing, e.g. TABLES T_RETURN TYPE BAPIRET2 OPTIONAL. End the definition with a period.',
            ("Definition comments may be regenerated; do not use reserved implementation comment prefixes *\" or *\"---. " +
              "These are possible causes, not a definitive diagnosis."),
            'Read inactive and active source before retrying with a new request_id; do not assume the backend is unchanged.'
          ]
        };
      }
      try {
        // Persist no source, SQL, filter values, returned data, headers or raw backend messages.
        await this.audit.append({
          operation_id: id, request_id: input.request_id, connection_id: input.connection_id, tool,
          event: tool === 'query_table' || tool === 'query_sql' ? 'data_query_failed' : 'failed',
          completed_steps: [...context.steps], error_code: failure.code, ...auditFailureDetails(failure.details),
          ...(writeTools.has(tool) ? { write_dispatched: context.dispatched,
            outcome: context.confirmed ? 'partial' : context.dispatched ? 'unknown' : 'confirmed' } : {})
        });
      } catch { context.warnings.push('LOG_WRITE_FAILED'); }
      return {
        operation_id: id,
        status: 'error',
        completed_steps: context.steps,
        error: failure,
        ...(context.source_save ? { source_save: context.source_save } : {}),
        ...(writeTools.has(tool) ? {
          outcome: context.confirmed ? 'partial' : context.dispatched ? 'unknown' : 'confirmed',
          write_dispatched: context.dispatched
        } : {}),
        ...(context.warnings.length ? { warnings: context.warnings } : {})
      };
    }
    finally { backend?.setRequestTimeout?.(); }
  }

  private async requireTransport(backend: Backend, object: string, pkg: string, operation: 'I' | 'U', transport?: string) {
    if (transport || pkg.toUpperCase() === '$TMP')
      return;
    const details = {
      object_uri: object,
      package_name: pkg,
      operation,
      guidance: ("Use list_transport_requests to select a modifiable task for the configured SAP user, or ask the user. No " +
        "write has been dispatched; retry with a new request_id after review.")
    };
    if (!backend.transportRequirement)
      throw new AppError('TRANSPORT_CHECK_UNAVAILABLE', 'Cannot determine whether SAP requires a transport task; provide an explicit task or verify CTS settings.', details);
    let requirement;
    try {
      requirement = await backend.transportRequirement(object, pkg, operation);
    }
    catch (error) {
      const failure = safeError(error);
      throw new AppError('TRANSPORT_CHECK_UNAVAILABLE', 'SAP transport check failed; no write was sent. Provide an explicit task or verify CTS settings.', {
        ...details, ...auditFailureDetails(failure.details), cause_code: failure.code,
        cause: failure
      });
    }
    if (requirement === 'not_required')
      return;
    if (requirement === 'required')
      throw new AppError('TRANSPORT_REQUIRED', 'SAP requires a transport task for this operation; pass transport_task explicitly on this call.', details);
    throw new AppError('TRANSPORT_CHECK_UNAVAILABLE', 'SAP transport requirement is unknown; no write was sent.', details);
  }

  private async locked<T>(backend: Backend, object: string, context: Context, action: (handle: string) => Promise<T>): Promise<T> {
    let handle: string;
    try {
      handle = await backend.lock(object);
    }
    catch (error) {
      if (['OUTCOME_UNKNOWN', 'RFC_CONTEXT_LOST', 'RFC_PROTOCOL_ERROR'].includes(safeError(error).code)) {
        this.poisoned.add(backend);
        context.warnings.push('LOCK_STATE_UNKNOWN');
      }
      throw error;
    }
    if (!handle)
      throw new AppError('LOCK_FAILED', 'Backend did not return a lock handle');
    let value: T | undefined;
    let failure: unknown;
    try {
      value = await action(handle);
    }
    catch (error) {
      failure = error;
    }
    try {
      await backend.unlock(object, handle);
      context.steps.push('unlocked');
    }
    catch {
      context.warnings.push('LOCK_CLEANUP_FAILED');
      this.poisoned.add(backend);
    }
    await context.event('lock_cleanup_finished').catch(() => { context.warnings.push('LOG_WRITE_FAILED'); });
    if (failure)
      throw failure;
    return value as T;
  }

  private async dispatch(tool: string, input: Input, connection: Connection, backend: Backend, context: Context): Promise<unknown> {
    if (Object.hasOwn(qualitySchemas, tool)) {
      const name = tool as QualityTool;
      const { connection_id: _connectionId, ...args } = input;
      const query = qualitySchemas[name].parse(args);
      if ('object_uri' in query && query.object_uri) qualityObject(query.object_uri, adtUri);
      if (!backend.quality) throw new AppError('CAPABILITY_UNSUPPORTED', 'Quality/history tools are unavailable in this backend');
      if (!writeTools.has(tool)) return backend.quality(name, query);
      await context.event('quality_execution_started');
      context.dispatched = true;
      const result = await backend.quality(name, query);
      context.confirmed = true;
      await context.event('quality_execution_completed');
      return result;
    }
    if (Object.hasOwn(repositorySchemas, tool)) {
      const name = tool as RepositoryTool;
      const { connection_id: _connectionId, ...args } = input;
      const query = repositorySchemas[name].parse(args);
      if (!backend.inspectRepository)
        throw new AppError('CAPABILITY_UNSUPPORTED', 'Repository inspection is unavailable in this backend');
      return backend.inspectRepository(name, query);
    }
    switch (tool) {
      case 'get_capabilities':
        return backend.capabilities();
      case 'query_table': {
        const query = tableQuerySchema.parse({
          table_name: input.table_name,
          fields: input.fields,
          filters: input.filters,
          limit: input.limit
        });
        if (!backend.queryTable)
          throw new AppError('CAPABILITY_UNSUPPORTED', 'Table data preview is unavailable');
        return backend.queryTable(query);
      }
      case 'query_sql': {
        const query = readOnlySql({
          sql: input.sql!,
          limit: input.limit
        });
        if (!backend.querySql)
          throw new AppError('CAPABILITY_UNSUPPORTED', 'SQL data preview is unavailable');
        return backend.querySql(query);
      }
      case 'search_objects':
        return backend.search(input.query!, input.type, input.limit ?? 100);
      case 'search_enhancements':
        return searchEnhancements((query, type, limit) => backend.search(query, type, limit), input.query!, input.type, input.limit ?? 100, backend.enhancementActivation ? row => backend.enhancementActivation!(row.object_uri, row.name, row.type) : undefined);
      case 'list_package_objects':
        return backend.listPackage(input.package_name!, input.limit ?? 100);
      case 'read_source':
        return backend.read(adtUri(input.object_uri!), input.version ?? 'active', input.source_uri);
      case 'syntax_check':
        return backend.check(adtUri(input.object_uri!), input.version ?? 'inactive');
      case 'list_transport_requests':
        return backend.transports(input.transport_number);
      case 'create_transport_request': {
        if (!backend.createTransportRequest || !backend.verifyTransportRequest || !backend.transportRequirement) {
          throw new AppError('CAPABILITY_UNSUPPORTED', 'Transport request creation or verification is unavailable');
        }
        const object = programUri(input.object_uri!);
        if (object !== input.object_uri)
          throw new AppError('INVALID_URI', 'Provide an object URI, not its source URI');
        if (input.package_name!.toUpperCase() === '$TMP')
          throw new AppError('TRANSPORT_NOT_REQUIRED', 'Temporary package $TMP does not need a development transport request');
        const requirement = await backend.transportRequirement(object, input.package_name!, 'I');
        if (requirement === 'not_required')
          throw new AppError('TRANSPORT_NOT_REQUIRED', 'SAP reports no change recording requirement for this object and package');
        if (requirement !== 'required')
          throw new AppError('TRANSPORT_CHECK_UNAVAILABLE', 'Cannot determine the CTS requirement; no request was created');
        await context.event('started');
        context.dispatched = true;
        const number = await backend.createTransportRequest(object, input.package_name!, input.description!);
        context.confirmed = true;
        const recovery = {
          created: true,
          transport_number: number,
          next_action: {
            tool: 'list_transport_requests',
            arguments: { connection_id: connection.connection_id }
          },
          guidance: ("Creation was accepted. Query requests and tasks before retrying; do not create another request blindly. " +
            "The returned number may be a request or a task.")
        };
        await context.event('created');
        let verified;
        try {
          verified = await backend.verifyTransportRequest(number);
        }
        catch (error) {
          throw new AppError('TRANSPORT_VERIFY_FAILED', 'SAP accepted creation but request readback failed', {
            ...recovery,
            cause: safeError(error)
          });
        }
        if (!verified)
          throw new AppError('TRANSPORT_VERIFY_FAILED', 'Created number was not found in the current user modifiable workbench requests', recovery);
        await context.event('verified');
        return {
          ...recovery,
          ...verified,
          released: false,
          guidance: ("Use a confirmed modifiable task belonging to the configured SAP user as transport_task. Do not confuse " +
            "the parent request with a task. No request was released and no source was changed.")
        };
      }
      case 'list_function_group_members': {
        if (!backend.listFunctionGroupMembers)
          throw new AppError('CAPABILITY_UNSUPPORTED', 'Function group browsing unavailable');
        return backend.listFunctionGroupMembers(input.function_group_uri!, input.limit ?? 100);
      }
      case 'get_function_group': {
        if (!backend.functionGroupSnapshot)
          throw new AppError('CAPABILITY_UNSUPPORTED', 'Function group snapshots unavailable');
        return backend.functionGroupSnapshot(input.function_group_uri!);
      }
      case 'create_function_group': {
        if (!backend.createFunctionGroup)
          throw new AppError('CAPABILITY_UNSUPPORTED', 'Function group creation unavailable');
        await this.requireTransport(backend, `/sap/bc/adt/functions/groups/${encodeURIComponent(input.name!.toLowerCase())}`, input.package_name!, 'I', input.transport_task);
        await context.event('started');
        context.dispatched = true;
        const uri = await backend.createFunctionGroup(input.name!, input.description!, input.package_name!, input.transport_task);
        context.confirmed = true;
        await context.event('created');
        return {
          object_uri: uri,
          type: 'FUGR/F',
          activated: false,
          next_action: {
            tool: 'get_function_group',
            arguments: {
              connection_id: connection.connection_id,
              function_group_uri: uri
            }
          }
        };
      }
      case 'create_function_module': {
        if (!backend.createFunctionModule)
          throw new AppError('CAPABILITY_UNSUPPORTED', 'Function module creation unavailable');
        const group = functionGroupUri(input.function_group_uri!);
        if (group !== input.function_group_uri)
          throw new AppError('INVALID_URI', 'Specify the parent function group itself');
        await this.requireTransport(backend, `${group}/fmodules/${encodeURIComponent(input.name!.toLowerCase())}`, await backend.packageOf(group), 'I', input.transport_task);
        await context.event('started');
        return this.locked(backend, group, context, async () => {
          context.dispatched = true;
          const uri = await backend.createFunctionModule!(input.name!, input.description!, group, input.transport_task);
          context.confirmed = true;
          await context.event('created');
          return {
            object_uri: uri,
            function_group_uri: group,
            type: 'FUGR/FF',
            activated: false,
            interface_help: functionModuleGuidance(input.name!),
            next_action: {
              tool: 'read_source',
              arguments: {
                connection_id: connection.connection_id,
                object_uri: uri,
                version: 'inactive'
              }
            }
          };
        });
      }
      case 'create_program': {
        await this.requireTransport(backend, `/sap/bc/adt/programs/${input.program_kind === 'include' ? 'includes' : 'programs'}/${encodeURIComponent(input.name!.toLowerCase())}`, input.package_name!, 'I', input.transport_task);
        await context.event('started');
        context.dispatched = true;
        const uri = await backend.create(input.name!, input.description!, input.package_name!, input.transport_task, input.program_kind ?? 'report');
        context.confirmed = true;
        await context.event('created');
        return {
          object_uri: uri,
          program_kind: input.program_kind ?? 'report',
          activated: false,
          next_action: {
            tool: 'read_source',
            arguments: {
              connection_id: connection.connection_id,
              object_uri: uri,
              version: 'inactive'
            }
          }
        };
      }
      case 'update_source': {
        const update = sourceUpdateSchema.safeParse(input);
        if (!update.success) throw new AppError('INVALID_INPUT', 'Provide exactly one of source or edits; edits require non-empty old_text and new_text strings.');
        if (!input.object_uri && !input.source_uri)
          throw new AppError('INVALID_URI', 'Provide object_uri or the source_uri returned by read_source');
        const object = programUri(input.object_uri ?? input.source_uri!);
        if (input.object_uri && object !== input.object_uri)
          throw new AppError('INVALID_URI', 'object_uri must identify the object, not its source');
        if (input.source_uri && programUri(input.source_uri) !== object)
          throw new AppError('INVALID_URI', 'object_uri and source_uri identify different objects');
        const saveState: SourceSaveState = {
          saved: false,
          verification: 'not_run',
          object_uri: object,
          ...(input.source_uri ? { source_uri: input.source_uri } : {})
        };
        context.source_save = saveState;
        if (isFunctionGroup(object))
          throw new AppError('CAPABILITY_UNSUPPORTED', 'Edit a function module or group Include, not the function group container');
        await this.requireTransport(backend, object, await backend.packageOf(object), 'U', input.transport_task);
        await context.event('started');
        return this.locked(backend, object, context, async (handle) => {
          context.steps.push('locked');
          // Revisions from either version are accepted, but that exact version is re-read under lock.
          const active = input.version === 'inactive' ? undefined : await backend.read(object, 'active').catch(error => {
            if (safeError(error).code === 'OBJECT_NOT_FOUND' || safeError(error).code === 'VERSION_UNAVAILABLE')
              return undefined;
            throw error;
          });
          let current = active;
          if (input.version !== 'active' && (!active || active.revision !== input.expected_revision))
            current = await backend.read(object, 'inactive').catch(error => {
              if (['OBJECT_NOT_FOUND', 'VERSION_UNAVAILABLE'].includes(safeError(error).code))
                return undefined;
              throw error;
            });
          const conflict = (reason: string, latest = current) => new AppError('VERSION_CONFLICT', reason, {
            object_uri: object,
            ...(active ? { active_revision: active.revision } : {}),
            ...(latest?.version === 'inactive' ? { inactive_revision: latest.revision } : {}),
            next_action: {
              tool: 'read_source',
              arguments: {
                connection_id: connection.connection_id,
                object_uri: object,
                version: latest?.version ?? active?.version ?? 'inactive'
              }
            },
            guidance: 'Read and review current source before using its revision. Do not blindly overwrite or automatically retry.'
          });
          if (!current || current.revision !== input.expected_revision)
            throw conflict('Source changed; read it again');
          if (input.source_uri && current.source_uri !== input.source_uri)
            throw new AppError('INVALID_URI', 'Source is not the discovered main source');
          saveState.source_uri = current.source_uri;
          // An inactive draft must not be silently overwritten from an active revision.
          if (current.version === 'active') {
            const draft = await backend.read(object, 'inactive').catch(error => {
              if (['OBJECT_NOT_FOUND', 'VERSION_UNAVAILABLE'].includes(safeError(error).code))
                return undefined;
              throw error;
            });
            if (draft && draft.hash !== current.hash)
              throw conflict('An inactive draft exists; read inactive before editing', draft);
          }
          const code = update.data.edits ? applySourceEdits(current.source, update.data.edits) : update.data.source!;
          await context.event('version_checked');
          const markSaveDispatched = () => {
            context.dispatched = true;
            saveState.saved = 'unknown';
            saveState.next_action = 'Read inactive and active source to establish backend state before any new write; do not blindly retry.';
          };
          if (!backend.saveDispatchTracking) markSaveDispatched();
          try { await backend.save(current.source_uri, code, handle, input.transport_task, markSaveDispatched); }
          finally {
            for (const diagnostic of backend.takeSaveDiagnostics?.() ?? []) await context.diagnostic(diagnostic);
          }
          context.confirmed = true;
          saveState.saved = true;
          saveState.verification = 'pending';
          await context.event('saved');
          let saved;
          try {
            saved = await backend.read(object, 'inactive');
          }
          catch (error) {
            saveState.verification = 'unavailable';
            throw error;
          }
          saveState.inactive_revision = saved.revision;
          const comparison = compareSavedSource(code, saved.source, object);
          saveState.normalization_applied = comparison.normalization_applied;
          context.warnings.push(...comparison.warnings);
          if (!comparison.equivalent) {
            saveState.verification = 'failed';
            saveState.difference = comparison.difference;
            throw new AppError('VERIFY_FAILED', 'SAP accepted the save, but inactive source differs from the submitted source. Read inactive before editing or activating.', { difference: comparison.difference });
          }
          saveState.verification = 'passed';
          delete saveState.next_action;
          await context.event('verified');
          const { source: savedCode, ...metadata } = saved;
          return {
            ...metadata,
            ...((update.data.include_source ?? !update.data.edits) ? {source:savedCode} : {}),
            ...(update.data.edits ? {applied_edits:update.data.edits.length} : {}),
            activated: false
          };
        });
      }
      case 'activate_objects': {
        const selected = input.objects!.map(object => ({ ...object, object_uri: programUri(object.object_uri) }));
        const uris = new Set(selected.map(object => object.object_uri));
        if (uris.size !== selected.length) throw new AppError('INVALID_INPUT', 'Duplicate activation target');
        for (const object of selected) {
          if (!isFunctionGroup(object.object_uri) && object.object_uri.includes('/functions/groups/') && uris.has(functionGroupUri(object.object_uri)))
            throw new AppError('INVALID_INPUT', 'Select either a function group or its individual members');
          await backend.packageOf(object.object_uri);
        }
        if (!backend.activateBatch) throw new AppError('CAPABILITY_UNSUPPORTED', 'Joint activation is unavailable; no sequential fallback was used');
        await context.event('started');
        const plans: { object_uri: string; snapshot?: GroupSnapshot; source?: Source }[] = [];
        // Validate every reviewed version before activating any target.
        for (const object of selected) {
          const uri = object.object_uri;
          const plan = await this.locked(backend, uri, context, async () => {
            if (isFunctionGroup(uri)) {
              if (!backend.functionGroupSnapshot) throw new AppError('CAPABILITY_UNSUPPORTED', 'Function group snapshots unavailable');
              const snapshot = await backend.functionGroupSnapshot(uri);
              if (snapshot.revision !== object.expected_revision) throw new AppError('VERSION_CONFLICT', 'Function group members changed', { object_uri: uri });
              return { object_uri: uri, snapshot };
            }
            const source = await backend.read(uri, 'inactive');
            if (source.revision !== object.expected_revision) throw new AppError('VERSION_CONFLICT', 'Inactive source changed; read it again', { object_uri: uri });
            return { object_uri: uri, source };
          });
          plans.push(plan);
          if (this.poisoned.has(backend)) throw new AppError('LOCK_CLEANUP_FAILED', 'Editor lock was not released; activation was not sent');
        }
        let activation: BatchActivationResult | undefined;
        let failure: ReturnType<typeof safeError> | undefined;
        try {
          activation = await backend.activateBatch(plans.map(({ object_uri, snapshot }) => ({ object_uri, snapshot })), async () => {
            // Recheck after backend metadata preparation, immediately before the first activation request.
            if (!context.dispatched) {
              for (const plan of plans) {
                const revision = plan.snapshot ? (await backend.functionGroupSnapshot!(plan.object_uri)).revision
                  : (await backend.read(plan.object_uri, 'inactive')).revision;
                if (revision !== (plan.snapshot ?? plan.source)!.revision)
                  throw new AppError('VERSION_CONFLICT', 'Activation set changed after unlocking; review the set again', { object_uri: plan.object_uri });
              }
              await context.event('activation_version_checked');
            }
            context.dispatched = true; context.confirmed = false;
          });
          context.confirmed = true;
          await context.event(activation.success ? 'activated' : 'activation_failed');
        } catch (error) {
          failure = safeError(error);
          if (!context.dispatched) throw error;
        }
        // A response failure does not imply rollback. Inspect every selected source, even after a mismatch.
        const results: { object_uri: string; success: boolean; verification: string; member_results?: unknown[]; error?: unknown }[] = [];
        const verify = async (uri: string, hash: string, comments?: string) => {
          try {
            const active = await backend.read(uri, 'active');
            if (savedSourceHash(active.source, uri) === hash) {
              if (comments && definitionCommentsHash(active.source, uri) !== comments) context.warnings.push('FUNCTION_DEFINITION_COMMENTS_CHANGED');
              return { object_uri: uri, success: true, verification: 'passed', active_revision: active.revision };
            }
            const inactive = await backend.read(uri, 'inactive').catch(() => undefined);
            return { object_uri: uri, success: false, verification: inactive && savedSourceHash(inactive.source, uri) === hash ? 'not_activated' : 'mismatch', active_revision: active.revision };
          } catch (error) {
            return { object_uri: uri, success: false, verification: 'unknown', error: safeError(error) };
          }
        };
        for (const plan of plans) {
          if (plan.snapshot) {
            const members = [];
            for (const member of plan.snapshot.members) members.push(await verify(member.object_uri, member.hash, member.definition_comments_hash));
            results.push({ object_uri: plan.object_uri, success: members.every(member => member.success),
              verification: 'members_checked', member_results: members });
          } else {
            const source = plan.source!;
            results.push(await verify(plan.object_uri, savedSourceHash(source.source, plan.object_uri), definitionCommentsHash(source.source, plan.object_uri)));
          }
        }
        const details = { results, messages: activation?.messages ?? [], inactive: activation?.inactive ?? [],
          ...(failure ? { cause: failure.details } : {}),
          guidance: 'Joint activation is not transactional. Inspect per-object results and current versions before retrying; no automatic replay was performed.' };
        if (failure) throw new AppError(failure.code, failure.message, details);
        if (!activation!.success) throw new AppError('ACTIVATION_FAILED', 'SAP did not confirm the complete activation set', details);
        if (results.some(result => !result.success)) throw new AppError('VERIFY_FAILED', 'Some active sources could not be verified', details);
        await context.event('activation_verified');
        return { results, messages: activation!.messages, mode: 'joint' };
      }
      default: throw new AppError('UNKNOWN_TOOL', 'Unknown tool');
    }
  }

  async clearCache(): Promise<CacheClearResult> {
    if (this.closing) throw new AppError('SERVER_STOPPING', '服务正在停止，无法清理缓存。');
    if (this.pending || this.maintenance) throw new AppError('BUSY', '当前有操作正在执行，请完成后再清理缓存。');
    if (this.poisoned.size) throw new AppError('SESSION_NEEDS_REVIEW', '存在解锁状态异常的会话，请先核实 SAP 锁；不能通过清理缓存绕过保护。');
    const clear = async () => {
      let cleared = 0;
      let failed = 0;
      for (const [id, backend] of this.sessions) {
        try { await backend.close(); this.sessions.delete(id); cleared++; }
        catch { failed++; }
      }
      if (failed) throw new AppError('CACHE_CLEAR_FAILED', `已清理 ${cleared} 个连接缓存，${failed} 个会话未能确认关闭，请检查连接后重试。`);
      // These records prevent duplicate SAP writes; cache cleanup must retain them.
      return { cleared_sessions: cleared, retained_write_requests: this.requests.size };
    };
    this.maintenance = clear();
    try { return await this.maintenance; }
    finally { this.maintenance = undefined; }
  }

  async close() {
    this.closing = true;
    await this.maintenance?.catch(() => {});
    await Promise.allSettled([...this.queues.values()]);
    await Promise.allSettled([...this.sessions.values()].map(s => s.close()));
  }
}
