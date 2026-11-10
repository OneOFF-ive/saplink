import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ConfigStore, digest } from './config.js';
import { AppError, safeError } from './errors.js';
import { targetFingerprint } from './connection-identity.js';
import { ApprovalService } from './approval-service.js';
import type { Input, Operations, Result } from './operations.js';
import { WorkflowReview } from './workflow-review.js';
import { writeTools } from './tool-policy.js';
import { acquireLease, inspectLease } from './lease.js';
import type { WorkflowEvent } from './workflow-progress.js';

export function safeSaveRetry(result: Result | undefined) {
  const details=result?.error?.details as {http_status?:number;network_code?:string;request_finished?:boolean}|undefined;
  const transient=['CONNECTION_FAILED','SAP_CONNECTION_FAILED','SERVICE_UNAVAILABLE','HTTP_503','ECONNREFUSED'].includes(result?.error?.code ?? '') ||
    result?.error?.code==='ADT_ERROR'&&(details?.http_status===503 || details?.network_code==='ECONNREFUSED');
  return result?.status === 'error' && result.write_dispatched === false && result.outcome === 'confirmed' &&
    transient;
}

const sourceSchema = z.object({
  object_uri: z.string(), source_uri: z.string(), version: z.enum(['active', 'inactive']),
  revision: z.string().regex(/^[a-f0-9]{64}$/), source: z.string()
}).passthrough();

export class WorkflowExecution {
  private static readonly active = new Set<string>();
  private readonly directory: string;
  private readonly reviews: WorkflowReview;

  constructor(private store: ConfigStore, private operations: Pick<Operations, 'run'>,
    private approvals = new ApprovalService(store, input => operations.run('read_source', input)), private retryUnsentSave = false) {
    this.directory = join(store.directory, 'workflow-runs');
    this.reviews = new WorkflowReview(approvals);
  }

  review(input: unknown) { return this.reviews.review(input); }

  async execute(raw: unknown, reviewId: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!/^[a-f0-9]{64}$/.test(reviewId))
      throw new AppError('WORKFLOW_INVALID', '任务审核标识无效。');
    const review = await this.reviews.review(raw);
    if (review.review_id !== reviewId)
      throw new AppError('WORKFLOW_REVIEW_CHANGED', '任务计划、连接或源码基线已变化，请重新审核。');
    const plan = review.plan;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, `${digest(`${plan.connection_id}:${plan.plan_id}`)}.jsonl`);
    let file;
    try { file = await open(path, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new AppError('WORKFLOW_ALREADY_STARTED', '此任务已开始或结果不确定；请检查记录和 SAP 状态，不要重复执行。');
      throw error;
    }
    const append = async (event: unknown) => {
      const body = JSON.stringify(event, (key, value) => key === 'source' ? undefined : value);
      if (Buffer.byteLength(body, 'utf8') > 1024 * 1024)
        throw new AppError('WORKFLOW_RECORD_LIMIT', '步骤结果过大，无法持久记录；任务已停止，请核实 SAP 状态。');
      await file.writeFile(body + '\n');
      await file.sync();
    };
    const results: { step: string; result: Result }[] = [];
    let release: (() => Promise<void>) | undefined;
    let currentStep: string | undefined, currentPhase: string | undefined;
    try {
      release = await acquireLease(this.directory, `${digest(`${plan.connection_id}:${plan.plan_id}`)}.lock`);
      WorkflowExecution.active.add(path);
      await append({ state: 'started', plan_id: plan.plan_id, review_id: reviewId, time: new Date().toISOString() });
      const ensureTarget = async () => {
        signal?.throwIfAborted();
        const connection = (await this.store.load()).connections.find(item => item.connection_id === plan.connection_id);
        if (!connection || targetFingerprint(connection) !== review.target.fingerprint ||
            !connection.write_enabled)
          throw new AppError('WORKFLOW_TARGET_CHANGED', '连接身份或写入策略已变化；任务已停止。');
      };
      const run = async (step: string, input: Input, phase = step) => {
        currentStep = step; currentPhase = phase;
        await ensureTarget();
        await append({ state: 'step_started', step, phase, time: new Date().toISOString() });
        const result = await this.operations.run(step, input);
        results.push({ step, result });
        const read = step === 'read_source' ? sourceSchema.safeParse(result.data) : undefined;
        await append({ state: 'step_finished', step, phase, operation_id: result.operation_id, status: result.status,
          outcome: result.outcome, write_dispatched: result.write_dispatched, error: result.error, warnings: result.warnings,
          ...(step !== 'read_source' ? { data: result.data, source_save: result.source_save }
            : read?.success ? { data: { object_uri: read.data.object_uri, source_uri: read.data.source_uri,
              version: read.data.version, revision: read.data.revision } } : {}),
          time: new Date().toISOString() });
        if (result.status !== 'success')
          throw new AppError('WORKFLOW_STEP_FAILED', `${step} 未成功；任务已停止。`, { step, result });
        if (result.warnings?.includes('APPROVAL_RESULT_PERSIST_FAILED') ||
            writeTools.has(step) && (result.outcome !== 'confirmed' || !result.write_dispatched))
          throw new AppError('WORKFLOW_RESULT_UNCERTAIN', `${step} 的结果未能确认或持久保存；任务已停止。`, { step, result });
        return result;
      };
      const authorized = async (tool: string, input: Input) => {
        currentStep = tool; currentPhase = tool;
        await ensureTarget();
        const stepReview = await this.approvals.review(tool, input);
        if (stepReview.target.fingerprint !== review.target.fingerprint)
          throw new AppError('WORKFLOW_TARGET_CHANGED', '连接身份已变化；任务已停止。');
        const approval = await this.approvals.approve(tool, input, stepReview.review_id);
        try {
          await append({ state: 'step_approved', step: tool, phase: tool, approval_id: approval.approval_id,
            time: new Date().toISOString() });
        } catch (error) {
          await this.approvals.revoke(approval.approval_id);
          throw error;
        }
        try { return await run(tool, approval.input); }
        catch(error) {
          // Only a definitively unsent source save is eligible. The second review
          // reads the exact same baseline again; changed content is never retried.
          const last = results.at(-1);
          if (!this.retryUnsentSave || tool !== 'update_source' || last?.step !== tool || !safeSaveRetry(last.result)) throw error;
          await ensureTarget();
          const retryInput = {...input,request_id:`${input.request_id}:retry`};
          const retryReview = await this.approvals.review(tool,retryInput);
          const retryGrant = await this.approvals.approve(tool,retryInput,retryReview.review_id);
          try { await append({state:'step_approved',step:tool,phase:tool,approval_id:retryGrant.approval_id,retry:true,time:new Date().toISOString()}); }
          catch(error) {await this.approvals.revoke(retryGrant.approval_id);throw error;}
          return run(tool,retryGrant.input);
        }
      };
      const base = { connection_id: plan.connection_id };
      let baseline;
      if (plan.action === 'create_program') {
        const created = await authorized('create_program', { ...base, name: plan.name,
          description: plan.description, package_name: plan.package_name, program_kind: 'report',
          transport_task: plan.transport_task, request_id: `${plan.plan_id}:write` });
        const parsed = z.object({ object_uri: z.string() }).passthrough().safeParse(created.data);
        const expected = `/sap/bc/adt/programs/programs/${plan.name.toLowerCase()}`;
        if (!parsed.success || parsed.data.object_uri.toLowerCase() !== expected)
          throw new AppError('WORKFLOW_TARGET_CHANGED', '创建结果与计划对象不一致；任务已停止。');
        baseline = await this.readSource(run, base, parsed.data.object_uri, 'inactive', undefined, 'baseline');
        const lines = baseline.source.split(/\r?\n/).filter(line => line.trim() && !line.startsWith('*'));
        if (lines.length !== 1 || lines[0].trim().toUpperCase() !== `REPORT ${plan.name}.`)
          throw new AppError('WORKFLOW_BASELINE_CHANGED', '新建程序的初始源码不是预期模板；请重新审核后继续。');
      } else {
        baseline = await this.readSource(run, base, plan.object_uri, plan.version, plan.source_uri, 'baseline');
        if (baseline.revision !== plan.expected_revision || baseline.source_uri !== plan.source_uri)
          throw new AppError('WORKFLOW_BASELINE_CHANGED', '源码基线已变化；请重新审核。');
      }
      const saved = await authorized('update_source', { ...base, object_uri: baseline.object_uri,
        source_uri: baseline.source_uri, version: baseline.version, expected_revision: baseline.revision,
        source: plan.source, include_source: false, transport_task: plan.transport_task,
        request_id: `${plan.plan_id}:save` });
      const revision = saved.source_save?.inactive_revision;
      if (saved.source_save?.verification !== 'passed' || !revision)
        throw new AppError('WORKFLOW_SAVE_UNVERIFIED', '源码保存未完成验证；任务已停止。');
      if (plan.syntax_check) {
        const beforeCheck = await this.readSource(run, base, baseline.object_uri, 'inactive', undefined, 'before_check');
        if (beforeCheck.revision !== revision)
          throw new AppError('WORKFLOW_BASELINE_CHANGED', '语法检查前源码已变化；任务已停止。');
        const syntax = await run('syntax_check', { ...base, object_uri: baseline.object_uri, version: 'inactive' });
        const checked = z.object({ passed: z.boolean() }).passthrough().safeParse(syntax.data);
        if (!checked.success || !checked.data.passed)
          throw new AppError('WORKFLOW_SYNTAX_FAILED', '语法检查未通过或结果不明确；任务已停止。', { result: syntax });
        const afterCheck = await this.readSource(run, base, baseline.object_uri, 'inactive', undefined, 'after_check');
        if (afterCheck.revision !== revision)
          throw new AppError('WORKFLOW_BASELINE_CHANGED', '语法检查期间源码已变化；任务已停止。');
      }
      if (plan.activate) {
        await authorized('activate_objects', { ...base, objects: [{ object_uri: baseline.object_uri,
          expected_revision: revision }], request_id: `${plan.plan_id}:activate` });
      }
      if (plan.atc_variant) {
        const current = await this.readSource(run, base, baseline.object_uri, 'active', undefined, 'before_atc');
        if (current.source.replace(/\r\n/g, '\n') !== plan.source.replace(/\r\n/g, '\n'))
          throw new AppError('WORKFLOW_BASELINE_CHANGED', '活动源码与审批内容不一致；未执行 ATC。');
        await authorized('run_atc', { ...base, object_uri: baseline.object_uri, check_variant: plan.atc_variant,
          confirm_execution: true, request_id: `${plan.plan_id}:atc` });
      }
      await append({ state: 'completed', time: new Date().toISOString() });
      return { plan_id: plan.plan_id, status: 'completed', results };
    } catch (error) {
      await append({ state: 'stopped', step: currentStep, phase: currentPhase, error: safeError(error), time: new Date().toISOString() });
      throw error;
    } finally {
      WorkflowExecution.active.delete(path);
      try { await file.close(); } finally { await release?.(); }
    }
  }

  private async readSource(run: (step: string, input: Input, phase?: string) => Promise<Result>,
    base: { connection_id: string }, object: string, version: 'active' | 'inactive', sourceUri?: string, phase?: string) {
    const result = await run('read_source', { ...base, object_uri: object, version,
      ...(sourceUri ? { source_uri: sourceUri } : {}) }, phase);
    const parsed = sourceSchema.safeParse(result.data);
    if (!parsed.success || parsed.data.object_uri !== object || parsed.data.version !== version)
      throw new AppError('WORKFLOW_BASELINE_UNAVAILABLE', '无法确认任务源码基线。');
    return parsed.data;
  }

  async status(connectionId: string, planId: string) {
    z.uuid().parse(connectionId);
    z.uuid().parse(planId);
    const path = join(this.directory, `${digest(`${connectionId}:${planId}`)}.jsonl`);
    let raw: string;
    try { raw = await readFile(path, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new AppError('WORKFLOW_NOT_FOUND', '任务执行记录不存在。');
      throw error;
    }
    const active = WorkflowExecution.active.has(path);
    const lease = active ? { state: 'running' as const, guard_present: false }
      : await inspectLease(this.directory, `${digest(`${connectionId}:${planId}`)}.lock`);
    const running = lease.state === 'running';
    const canReconcile = !running && !lease.guard_present && ['missing', 'stale'].includes(lease.state);
    const events: WorkflowEvent[] = [];
    let incomplete = !raw.endsWith('\n');
    for (const line of raw.split('\n').slice(0, -1)) {
      try {
        const event = z.object({ state: z.string() }).passthrough().parse(JSON.parse(line));
        events.push(event);
      } catch (error) {
        if (!(error instanceof SyntaxError) && !(error instanceof z.ZodError)) throw error;
        incomplete = true; break;
      }
    }
    const last = events.at(-1)?.state;
    return { plan_id: planId, state: incomplete ? running ? 'running' : 'unknown'
      : last === 'completed' ? 'completed' : last === 'stopped' ? 'stopped' : running ? 'running' : 'unknown',
      running, can_reconcile: canReconcile, events,
      ...(incomplete ? { warning: '执行记录不完整，请核对 SAP 和操作日志。' } : {}) };
  }
}
