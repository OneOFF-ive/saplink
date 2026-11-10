import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { workflowPlanSchema, workflowProposalSchema } from '../workflow-review.js';
import type { ModelTool } from './model.js';
import type { AgentTask, TaskStore } from './task-store.js';

export const workflowProposalTool: ModelTool = { type: 'function', function: {
  name: 'propose_program_workflow',
  description: 'Prepare a review-only program creation or source-update workflow, including the complete proposed source and requested syntax check, activation and optional ATC variant. Never executes SAP or grants approval. For updates use the real URI and revision returned by read_source; do not guess an ATC variant.',
  parameters: z.toJSONSchema(workflowProposalSchema, { io: 'input' })
} };

export const workflowSummarySchema = z.object({
  id: z.uuid(), artifact_id: z.string().regex(/^[a-f0-9]{64}$/),
  action: z.enum(['create_program', 'update_source']), created_at: z.iso.datetime(),
  object_label: z.string().max(2048).optional(),
  summary: z.string().max(500).optional()
}).strict();
export type WorkflowSummary = z.infer<typeof workflowSummarySchema>;

export async function createWorkflowProposal(task: AgentTask, store: TaskStore,
  proposal: z.infer<typeof workflowProposalSchema>, redact: (text: string) => string, persist = true) {
  if ((task.workflow_proposals?.length ?? 0) >= 20)
    throw new AppError('AGENT_OPERATION_LIMIT', '本会话的任务计划已达到上限。');
  if (redact(JSON.stringify(proposal)) !== JSON.stringify(proposal))
    throw new AppError('AGENT_OPERATION_INVALID', '任务参数包含敏感内容，不能保存为草稿。');
  const { resolves_drafts: _resolution, summary: description, ...fields } = proposal;
  const { revises_creation: _revision, ...intent } = fields.action === 'create_program'
    ? fields : {...fields, revises_creation: undefined};
  const plan = workflowPlanSchema.parse({ ...intent, connection_id: task.connection_id, plan_id: randomUUID() });
  const id = randomUUID(), created_at = new Date().toISOString();
  const artifact_id = await store.artifacts.put(task.id, 'workflow', JSON.stringify({
    id, created_at, target_fingerprint: task.target_fingerprint, plan
  }));
  const summary = workflowSummarySchema.parse({ id, artifact_id, action: plan.action, created_at,
    object_label: plan.action === 'create_program' ? plan.name : plan.object_uri.split('/').at(-1), summary: description });
  const previous = task.workflow_proposals;
  task.workflow_proposals = [...(previous ?? []), summary];
  try { if (persist) await store.save(task); } catch (error) { task.workflow_proposals = previous; throw error; }
  return { status: 'success', workflow_id: id, message: '任务计划已生成，等待用户审核；没有执行 SAP，也没有授予审批。' };
}

export async function readWorkflowProposal(task: AgentTask, store: TaskStore, id: string) {
  const summary = task.workflow_proposals?.find(item => item.id === id);
  if (!summary) throw new AppError('AGENT_OPERATION_NOT_FOUND', '任务计划不属于当前会话或已不存在。');
  const artifact = await store.artifacts.get(task.id, summary.artifact_id);
  if (artifact.kind !== 'workflow') throw new AppError('AGENT_OPERATION_INVALID', '任务计划类型无效。');
  let value: unknown;
  try { value = JSON.parse(artifact.content); } catch { throw new AppError('AGENT_OPERATION_INVALID', '任务计划无法解析。'); }
  const parsed = z.object({ id: z.literal(summary.id), created_at: z.literal(summary.created_at),
    target_fingerprint: z.literal(task.target_fingerprint), plan: workflowPlanSchema }).strict().safeParse(value);
  if (!parsed.success || parsed.data.plan.connection_id !== task.connection_id || parsed.data.plan.action !== summary.action)
    throw new AppError('AGENT_OPERATION_INVALID', '任务计划完整性校验失败。');
  return { ...summary, plan: parsed.data.plan };
}
