import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ConfigStore, digest } from './config.js';
import { targetFingerprint } from './connection-identity.js';
import { AppError } from './errors.js';
import { acquireLease } from './lease.js';
import type { Input, Result } from './operations.js';
import { applySourceEdits } from './source-edit.js';
import { sourceDiff } from './source-diff.js';
import { ddicUriName } from './adt-uri.js';
import { verifyDdicUpdate } from './ddic-definition.js';
import { toolSchemas } from './tool-definitions.js';
import { isControlledOperation, parseControlledOperation, WriteApprovalStore, type SourceWriteIntent } from './write-approval.js';
import { validateSapInput } from './sap-cli.js';

type Intent = { tool: 'update_source'; input: SourceWriteIntent } | ReturnType<typeof parseControlledOperation>;
type BaselineReader = (input: Input) => Promise<Result>;

export class ApprovalService {
  constructor(private store: ConfigStore, private baselineReader: BaselineReader, private authorization: 'user' | 'client_full' = 'user') {}

  private async locked<T>(action: () => Promise<T>) {
    const release = await acquireLease(this.store.directory, 'config.lock');
    try { return await action(); } finally { await release(); }
  }

  private parse(tool: string, raw: unknown): Intent {
    if (tool !== 'update_source' && !isControlledOperation(tool))
      throw new AppError('APPROVAL_INVALID', '此工具不支持受控审批。');
    const input = validateSapInput(tool, raw);
    if (input.approval_id) throw new AppError('APPROVAL_INVALID', '待审核参数不能包含 approval_id。');
    if (tool !== 'update_source') return parseControlledOperation(tool, input);
    const parsed = toolSchemas.update_source.parse(input);
    if (!parsed.object_uri || !parsed.source_uri || !parsed.version)
      throw new AppError('APPROVAL_INVALID', '源码审批需要实际 object_uri、source_uri、version 和 expected_revision。');
    return { tool, input: parsed };
  }

  private async inspect(tool: string, raw: unknown) {
    const intent = this.parse(tool, raw);
    const connection = (await this.store.load()).connections.find(c => c.connection_id === intent.input.connection_id);
    if (!connection) throw new AppError('CONNECTION_NOT_FOUND', '所选连接不存在。');
    if (!connection.write_enabled)
      throw new AppError('APPROVAL_POLICY_CHANGED', '当前连接未允许写入。');
    let diff: ReturnType<typeof sourceDiff> | undefined;
    if (intent.tool === 'update_source') {
      const input = intent.input;
      const request: Input = { connection_id: input.connection_id, object_uri: input.object_uri,
        source_uri: input.source_uri, version: input.version, timeout_ms: input.timeout_ms };
      const result = await this.baselineReader(request);
      if (result.status !== 'success') throw new AppError('APPROVAL_BASELINE_UNAVAILABLE',
        '无法读取 SAP 源码基线；请检查连接和操作日志后重新审核。', result.error);
      const baseline = z.object({ object_uri: z.string(), source_uri: z.string(), version: z.enum(['active', 'inactive']),
        revision: z.string().regex(/^[a-f0-9]{64}$/), source: z.string().max(1024 * 1024) }).passthrough().safeParse(result.data);
      if (!baseline.success || baseline.data.object_uri !== input.object_uri || baseline.data.source_uri !== input.source_uri ||
          baseline.data.version !== input.version || baseline.data.revision !== input.expected_revision)
        throw new AppError('APPROVAL_BASELINE_CHANGED', 'SAP 源码基线不匹配，请重新读取并审核。');
      const proposed = input.source !== undefined ? input.source : applySourceEdits(baseline.data.source, input.edits!);
      const ddicName = ddicUriName(baseline.data.object_uri);
      if (ddicName) verifyDdicUpdate(ddicName,baseline.data.source,proposed);
      diff = sourceDiff(baseline.data.source, proposed, 3, 2000);
      if (diff.equal) throw new AppError('APPROVAL_CHANGE_EMPTY', '源码没有实际修改。');
      if (diff.truncated || diff.line_endings_only)
        throw new AppError('APPROVAL_DIFF_INCOMPLETE', '无法展示完整差异，请缩小修改范围后重试。');
    }
    const reviewed = { schema_version: 1 as const, target: { connection_id: connection.connection_id,
      name: connection.name, client: connection.client, fingerprint: targetFingerprint(connection) },
      intent, ...(diff ? { diff } : {}) };
    return { ...reviewed, review_id: digest(JSON.stringify(reviewed)) };
  }

  async review(tool: string, input: unknown) { return this.locked(() => this.inspect(tool, input)); }

  async approve(tool: string, input: unknown, reviewId: string) {
    if (!/^[a-f0-9]{64}$/.test(reviewId)) throw new AppError('APPROVAL_INVALID', '审核标识无效。');
    return this.locked(async () => {
      const review = await this.inspect(tool, input);
      if (review.review_id !== reviewId) throw new AppError('APPROVAL_REVIEW_CHANGED', '审核内容或目标已变化，请重新审核。');
      const approvals = new WriteApprovalStore(this.store.directory);
      for (const prior of await this.list()) {
        if (prior.review_id === reviewId && prior.connection_id === review.target.connection_id &&
            ['pending', 'completed', 'unknown'].includes(prior.state))
          throw new AppError('APPROVAL_EXISTS', '此审核已有待执行或已使用的审批；请核实后重新生成操作。');
      }
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
      let record;
      if (review.intent.tool === 'update_source') {
        await approvals.requireResolved(review.intent.input);
        record = await approvals.create(review.intent.input, review.target.fingerprint, reviewId, expiresAt, this.authorization);
      } else {
        await approvals.requireOperationResolved(review.intent);
        record = await approvals.createOperation(review.intent, review.target.fingerprint, reviewId, expiresAt, this.authorization);
      }
      return { approval_id: record.id, review_id: reviewId, state: 'pending', expires_at: record.expires_at,
        tool: review.intent.tool, input: { ...review.intent.input, approval_id: record.id } };
    });
  }

  async status(id: string) {
    const result = await new WriteApprovalStore(this.store.directory).status(id);
    return { id, connection_id: result.approval.connection_id, operation: result.approval.operation ?? 'update_source',
      review_id: result.approval.artifact_id, state: result.state, expires_at: result.approval.expires_at,
      ...('resolved' in result ? { resolved: result.resolved } : {}), ...('result' in result ? { result: result.result } : {}) };
  }

  async list() {
    let names: string[];
    try { names = await readdir(join(this.store.directory, 'write-approvals')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const result = [];
    for (const name of names.filter(value => /^[0-9a-f-]{36}\.json$/i.test(value)).sort())
      result.push(await this.status(name.slice(0, -5)));
    return result;
  }

  async revoke(id: string) {
    return this.locked(async () => { await new WriteApprovalStore(this.store.directory).revoke(id); return { revoked: true, id }; });
  }

  async resolve(id: string) {
    return this.locked(async () => {
      const approvals = new WriteApprovalStore(this.store.directory);
      const record = await approvals.get(id);
      const connection = (await this.store.load()).connections.find(c => c.connection_id === record.connection_id);
      if (!connection || targetFingerprint(connection) !== record.target_fingerprint)
        throw new AppError('APPROVAL_TARGET_CHANGED', '连接身份已变化，不能确认此审批的核实。');
      const checkedAt = new Date().toISOString();
      await approvals.resolve(id, checkedAt);
      return { id, resolved: true, checked_at: checkedAt, verification: 'user_attested' };
    });
  }
}
