import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { digest } from './config.js';
import { AppError } from './errors.js';
import { toolSchemas } from './tool-definitions.js';
import type { Result } from './operations.js';
import { adtUri, ddicUriName, functionGroupUri, programUri, sourceObjectUri } from './adt-uri.js';
import { ddicCreationUri, verifyDdicDefinition } from './ddic-definition.js';
import { qualityObject } from './quality-tools.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const approvalSchema = z.object({
  schema_version: z.literal(1),
  authorization: z.enum(['user', 'client_full']).optional(),
  id: z.uuid(),
  connection_id: z.uuid(),
  target_fingerprint: hash,
  intent_hash: hash,
  artifact_id: hash,
  object_hash: hash,
  operation: z.enum(['create_program', 'create_ddic_object', 'create_function_group', 'create_function_module', 'create_transport_request', 'activate_objects', 'run_atc', 'run_unit_tests']).optional(),
  object_hashes: z.array(hash).min(1).max(40).optional(),
  created_at: z.iso.datetime(),
  expires_at: z.iso.datetime()
}).strict().refine(value => Boolean(value.operation) === Boolean(value.object_hashes) &&
  (!value.object_hashes || value.object_hashes.includes(value.object_hash)));
const resultSchema = z.object({
  operation_id: z.string(), status: z.string(), outcome: z.string().optional(), write_dispatched: z.boolean().optional(),
  data: z.unknown().optional(),
  source_save: z.object({ saved: z.union([z.boolean(), z.literal('unknown')]), verification: z.string(),
    object_uri: z.string(), source_uri: z.string().optional(), inactive_revision: z.string().optional(),
    next_action: z.string().optional(), normalization_applied: z.boolean().optional(), difference: z.string().optional() }).strict().optional(),
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }).strict().optional(),
  warnings: z.array(z.string()).optional(), completed_steps: z.array(z.string())
}).strict();

export type SourceWriteIntent = z.input<typeof toolSchemas.update_source>;
export type WriteApproval = z.infer<typeof approvalSchema>;
export type ControlledOperation = 'create_program' | 'create_ddic_object' | 'create_function_group' | 'create_function_module' |
  'create_transport_request' | 'activate_objects' | 'run_atc' | 'run_unit_tests';
export type ControlledOperationIntent = {
  [K in ControlledOperation]: { tool: K; input: z.input<(typeof toolSchemas)[K]> }
}[ControlledOperation];
export function isControlledOperation(tool: string): tool is ControlledOperation {
  return ['create_program', 'create_ddic_object', 'create_function_group', 'create_function_module', 'create_transport_request', 'activate_objects', 'run_atc', 'run_unit_tests'].includes(tool);
}
export function parseControlledOperation(tool: ControlledOperation, input: unknown): ControlledOperationIntent {
  const parsed = toolSchemas[tool].safeParse(input);
  if (!parsed.success || parsed.data.approval_id)
    throw new AppError('APPROVAL_INVALID', '审批的操作参数无效。');
  if (tool === 'create_ddic_object') {
    const {ddic_kind,name,source}=toolSchemas.create_ddic_object.parse(parsed.data);
    verifyDdicDefinition(ddic_kind,name,source);
  }
  return { tool, input: parsed.data } as ControlledOperationIntent;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter(key => record[key] !== undefined).sort()
      .map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  const result = JSON.stringify(value);
  if (result === undefined) throw new AppError('APPROVAL_INVALID', '审批内容格式无效。');
  return result;
}

function validateIntent(raw: SourceWriteIntent) {
  const { approval_id: _approval, ...intent } = raw;
  const result = toolSchemas.update_source.safeParse(intent);
  if (!result.success) throw new AppError('APPROVAL_INVALID', '审批的源码写入参数无效。');
  return result.data;
}
function objectHash(input: SourceWriteIntent) {
  const object = sourceObjectUri(input.object_uri ?? input.source_uri!);
  const name = ddicUriName(object);
  return digest(name ? ddicCreationUri('structure',name) : decodeURIComponent(object).toLowerCase());
}

function objectHashes(uri: string) {
  const ddicName = ddicUriName(uri);
  if (ddicName) return [digest(ddicCreationUri('structure',ddicName))];
  const decoded = decodeURIComponent(uri).toLowerCase();
  const normalized = decoded.startsWith('/sap/bc/adt/programs/') || decoded.startsWith('/sap/bc/adt/functions/groups/')
    ? programUri(decoded) : decoded;
  const objects = [normalized];
  if (normalized.startsWith('/sap/bc/adt/functions/groups/'))
    objects.push(functionGroupUri(normalized));
  return [...new Set(objects.map(object => digest(object)))];
}

function operationIntent(raw: ControlledOperationIntent) {
  const parsed = toolSchemas[raw.tool].safeParse(raw.input);
  if (!parsed.success || parsed.data.approval_id) throw new AppError('APPROVAL_INVALID', '审批的操作参数无效。');
  const input = parsed.data;
  const { timeout_ms: _timeout, approval_id: _approval, ...intent } = input;
  let uris: string[];
  switch (raw.tool) {
    case 'create_program': {
      const p = toolSchemas.create_program.parse(input);
      uris = [`/sap/bc/adt/programs/${p.program_kind === 'include' ? 'includes' : 'programs'}/${encodeURIComponent(p.name.toLowerCase())}`];
      break;
    }
    case 'create_ddic_object': {
      const p = toolSchemas.create_ddic_object.parse(input);
      verifyDdicDefinition(p.ddic_kind,p.name,p.source);
      uris = [ddicCreationUri(p.ddic_kind,p.name)];
      break;
    }
    case 'create_function_group': {
      const p = toolSchemas.create_function_group.parse(input);
      uris = [`/sap/bc/adt/functions/groups/${encodeURIComponent(p.name.toLowerCase())}`];
      break;
    }
    case 'create_function_module': {
      const p = toolSchemas.create_function_module.parse(input);
      const group = functionGroupUri(p.function_group_uri);
      if (group !== p.function_group_uri) throw new AppError('INVALID_URI', 'Specify the parent function group itself');
      uris = [`${group}/fmodules/${encodeURIComponent(p.name.toLowerCase())}`];
      break;
    }
    case 'create_transport_request':
      uris = [programUri(toolSchemas.create_transport_request.parse(input).object_uri)];
      break;
    case 'activate_objects':
      uris = toolSchemas.activate_objects.parse(input).objects.map(object => sourceObjectUri(object.object_uri));
      break;
    case 'run_atc':
    case 'run_unit_tests':
      uris = [qualityObject(toolSchemas[raw.tool].parse(input).object_uri, adtUri)];
      break;
  }
  const hashes = [...new Set(uris.flatMap(objectHashes))].sort();
  return { input: intent, connectionId: input.connection_id, hashes, intentHash: digest(canonical([raw.tool, intent])) };
}

// Approvals contain hashes, not source. This store relies on the local
// configuration directory being trusted; it is not protection from its owner.
export class WriteApprovalStore {
  private readonly directory: string;
  constructor(directory: string, private readonly now: () => number = Date.now) { this.directory = join(directory, 'write-approvals'); }

  async create(intent: SourceWriteIntent, targetFingerprint: string, artifactId: string, expiresAt: Date, authorization?: 'user' | 'client_full') {
    const input = validateIntent(intent);
    const created = new Date(this.now());
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= created)
      throw new AppError('APPROVAL_INVALID', '审批有效期必须在未来。');
    const approval = approvalSchema.parse({ schema_version: 1, authorization, id: randomUUID(), connection_id: input.connection_id,
      target_fingerprint: targetFingerprint, intent_hash: digest(canonical(input)), artifact_id: artifactId,
      object_hash: objectHash(input),
      created_at: created.toISOString(), expires_at: expiresAt.toISOString() });
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = await open(join(this.directory, `${approval.id}.json`), 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(approval)); await file.sync(); }
    finally { await file.close(); }
    return approval;
  }

  async get(id: string): Promise<WriteApproval> {
    if (!z.uuid().safeParse(id).success) throw new AppError('APPROVAL_INVALID', '审批标识无效。');
    let raw: string;
    try { raw = await readFile(join(this.directory, `${id}.json`), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new AppError('APPROVAL_NOT_FOUND', '审批记录不存在。');
      throw error;
    }
    let data: unknown;
    try { data = JSON.parse(raw); }
    catch { throw new AppError('APPROVAL_INVALID', '审批记录无法解析。'); }
    const result = approvalSchema.safeParse(data);
    if (!result.success || result.data.id !== id || Date.parse(result.data.expires_at) <= Date.parse(result.data.created_at))
      throw new AppError('APPROVAL_INVALID', '审批记录无效。');
    return result.data;
  }

  async createOperation(intent: ControlledOperationIntent, targetFingerprint: string, artifactId: string, expiresAt: Date, authorization?: 'user' | 'client_full') {
    const operation = operationIntent(intent);
    const created = new Date(this.now());
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= created)
      throw new AppError('APPROVAL_INVALID', '审批有效期必须在未来。');
    const approval = approvalSchema.parse({ schema_version: 1, authorization, id: randomUUID(), connection_id: operation.connectionId,
      target_fingerprint: targetFingerprint, intent_hash: operation.intentHash, artifact_id: artifactId,
      object_hash: operation.hashes[0], object_hashes: operation.hashes, operation: intent.tool,
      created_at: created.toISOString(), expires_at: expiresAt.toISOString() });
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = await open(join(this.directory, `${approval.id}.json`), 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(approval)); await file.sync(); }
    finally { await file.close(); }
    return approval;
  }

  async consumeOperation(id: string, intent: ControlledOperationIntent, targetFingerprint: string, artifactId: string) {
    const operation = operationIntent(intent);
    const approval = await this.get(id);
    if (approval.operation !== intent.tool || approval.connection_id !== operation.connectionId ||
        approval.target_fingerprint !== targetFingerprint || approval.artifact_id !== artifactId ||
        approval.intent_hash !== operation.intentHash)
      throw new AppError('APPROVAL_MISMATCH', '操作内容或目标与审批不一致。');
    if (this.now() >= Date.parse(approval.expires_at))
      throw new AppError('APPROVAL_EXPIRED', '审批已过期，请重新审核。');
    await this.finish(id, 'consumed');
    if (this.now() >= Date.parse(approval.expires_at))
      throw new AppError('APPROVAL_EXPIRED', '审批已过期，请重新审核。');
    return approval;
  }

  async consume(id: string, intent: SourceWriteIntent, targetFingerprint: string, artifactId: string) {
    const input = validateIntent(intent);
    const approval = await this.get(id);
    if (approval.connection_id !== input.connection_id || approval.target_fingerprint !== targetFingerprint ||
        approval.artifact_id !== artifactId || approval.intent_hash !== digest(canonical(input)))
      throw new AppError('APPROVAL_MISMATCH', '写入内容或目标与审批不一致。');
    if (this.now() >= Date.parse(approval.expires_at))
      throw new AppError('APPROVAL_EXPIRED', '审批已过期，请重新审核。');
    await this.finish(id, 'consumed');
    if (this.now() >= Date.parse(approval.expires_at))
      throw new AppError('APPROVAL_EXPIRED', '审批已过期，请重新审核。');
    return approval;
  }

  async revoke(id: string) {
    await this.get(id);
    await this.finish(id, 'revoked');
  }

  async status(id: string) {
    const approval = await this.get(id);
    let raw: string;
    try { raw = await readFile(join(this.directory, `${id}.final`), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { approval, state: Date.parse(approval.expires_at) <= this.now() ? 'expired' as const : 'pending' as const };
      throw error;
    }
    let final: unknown;
    try { final = JSON.parse(raw); }
    catch { return { approval, state: 'unknown' as const, resolved: await this.isResolved(id) }; }
    const state = z.object({ state: z.enum(['consumed', 'revoked']), time: z.iso.datetime() }).strict().safeParse(final);
    if (!state.success) return { approval, state: 'unknown' as const, resolved: await this.isResolved(id) };
    if (state.data.state === 'revoked') return { approval, state: 'revoked' as const };
    try {
      const result = JSON.parse(await readFile(join(this.directory, `${id}.result`), 'utf8'));
      const parsed = resultSchema.safeParse(result);
      if (!parsed.success) return { approval, state: 'unknown' as const, resolved: await this.isResolved(id) };
      return { approval, state: 'completed' as const, result: parsed.data, resolved: await this.isResolved(id) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError)
        return { approval, state: 'unknown' as const, resolved: await this.isResolved(id) };
      throw error;
    }
  }

  private async isResolved(id: string) {
    try {
      const value = JSON.parse(await readFile(join(this.directory, `${id}.resolved`), 'utf8'));
      if (!z.object({ checked_at: z.iso.datetime(), resolved_at: z.iso.datetime() }).strict().safeParse(value).success)
        throw new AppError('APPROVAL_INVALID', '写入核实记录无效。');
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  private requiresResolution(status: Awaited<ReturnType<WriteApprovalStore['status']>>) {
    if ('resolved' in status && status.resolved) return false;
    if (status.state === 'unknown') return true;
    return status.state === 'completed' && Boolean(status.result &&
      (status.result.outcome === 'unknown' || status.result.outcome === 'partial' ||
        status.result.write_dispatched && status.result.status !== 'success'));
  }

  async requiresReconciliation(id: string) {
    return this.requiresResolution(await this.status(id));
  }

  async requireResolved(intent: SourceWriteIntent) {
    const input = validateIntent(intent);
    const targetObject = objectHash(input);
    const targetHashes = objectHashes(sourceObjectUri(input.object_uri ?? input.source_uri!));
    await this.requireHashesResolved(input.connection_id, targetHashes, false, targetObject);
  }

  async requireOperationResolved(intent: ControlledOperationIntent) {
    const operation = operationIntent(intent);
    await this.requireHashesResolved(operation.connectionId, operation.hashes, true);
  }

  private async requireHashesResolved(connectionId: string, hashes: string[], blockLegacy: boolean, legacyObject?: string) {
    let names: string[];
    try { names = await readdir(this.directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const name of names) {
      if (!/^[0-9a-f-]{36}\.json$/i.test(name)) continue;
      const record = await this.get(name.slice(0, -5));
      const overlaps = record.object_hashes
        ? record.object_hashes.some(hash => hashes.includes(hash))
        : blockLegacy || record.object_hash === legacyObject;
      if (record.connection_id === connectionId && overlaps &&
          this.requiresResolution(await this.status(record.id)))
        throw new AppError('APPROVAL_RECONCILIATION_REQUIRED', '此对象先前的写入结果不确定或部分完成。请先核对 SAP 和操作日志并确认核实，不能继续写入。');
    }
  }

  async resolve(id: string, checkedAt: string) {
    const status = await this.status(id);
    if (!this.requiresResolution(status)) throw new AppError('APPROVAL_RESOLUTION_INVALID', '此审批无需核实或已经核实。');
    const file = await open(join(this.directory, `${id}.resolved`), 'wx', 0o600);
    try { await file.writeFile(JSON.stringify({ checked_at: checkedAt, resolved_at: new Date(this.now()).toISOString() })); await file.sync(); }
    finally { await file.close(); }
  }

  async complete(id: string, result: Result) {
    const approval = await this.get(id);
    const saved = resultSchema.parse({ operation_id: result.operation_id, status: result.status,
      outcome: result.outcome, write_dispatched: result.write_dispatched,
      source_save: result.source_save,
      ...(approval.operation ? { data: result.data } : {}),
      error: result.error ? { code: result.error.code, message: result.error.message,
        ...(approval.operation ? { details: result.error.details } : {}) } : undefined,
      warnings: result.warnings, completed_steps: result.completed_steps });
    const body = JSON.stringify(saved);
    if (Buffer.byteLength(body, 'utf8') > 1024 * 1024)
      throw new AppError('APPROVAL_RESULT_LIMIT', '操作结果过大，无法持久保存，请核实 SAP 状态。');
    const file = await open(join(this.directory, `${id}.result`), 'wx', 0o600);
    try { await file.writeFile(body); await file.sync(); }
    finally { await file.close(); }
  }

  private async finish(id: string, state: 'consumed' | 'revoked') {
    let file;
    try { file = await open(join(this.directory, `${id}.final`), 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new AppError('APPROVAL_USED', '审批已使用、撤销或状态不确定，不可重用。');
      throw error;
    }

    try { await file.writeFile(JSON.stringify({ state, time: new Date(this.now()).toISOString() })); await file.sync(); }
    finally { await file.close(); }
  }
}
