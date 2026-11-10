import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import { toolSchemas } from '../../tool-definitions.js';
import { parseControlledOperation, type ControlledOperationIntent } from '../../write-approval.js';
import type { ModelTool } from '../model/model.js';
import type { AgentTask, TaskStore } from '../task-store.js';

const common = { connection_id: true, request_id: true, approval_id: true, timeout_ms: true } as const;
export const operationProposalInput = z.discriminatedUnion('tool', [
  z.object({ tool: z.literal('create_program'), input: toolSchemas.create_program.omit(common) }).strict(),
  z.object({ tool: z.literal('create_ddic_object'), input: toolSchemas.create_ddic_object.omit(common) }).strict(),
  z.object({ tool: z.literal('create_function_group'), input: toolSchemas.create_function_group.omit(common) }).strict(),
  z.object({ tool: z.literal('create_function_module'), input: toolSchemas.create_function_module.omit(common) }).strict(),
  z.object({ tool: z.literal('create_transport_request'), input: toolSchemas.create_transport_request.omit(common) }).strict(),
  z.object({ tool: z.literal('activate_objects'), input: toolSchemas.activate_objects.omit(common) }).strict(),
  z.object({ tool: z.literal('run_atc'), input: toolSchemas.run_atc.omit({ ...common, confirm_execution: true }) }).strict(),
  z.object({ tool: z.literal('run_unit_tests'), input: toolSchemas.run_unit_tests.omit({ ...common, confirm_execution: true }) }).strict()
]);
export const operationProposalTool: ModelTool = { type: 'function', function: {
  name: 'propose_controlled_operation',
  description: 'Create a local review-only proposal for a user-requested object or transport request creation, joint activation, ATC or ABAP Unit operation. Never executes SAP or grants approval. Use real discovered objects, variants and inactive revisions; do not invent them. One operation per proposal.',
  parameters: z.toJSONSchema(operationProposalInput, { io: 'input' })
} };
export const operationSummarySchema = z.object({
  id: z.uuid(), artifact_id: z.string().regex(/^[a-f0-9]{64}$/),
  tool: z.enum(['create_program', 'create_ddic_object', 'create_function_group', 'create_function_module', 'create_transport_request', 'activate_objects', 'run_atc', 'run_unit_tests']),
  created_at: z.iso.datetime(), approval_id: z.uuid().optional(), object_label:z.string().max(2048).optional()
}).strict();
export type OperationSummary = z.infer<typeof operationSummarySchema>;

export async function createOperationProposal(task: AgentTask, store: TaskStore,
  proposal: z.infer<typeof operationProposalInput>, redact: (text: string) => string) {
  if ((task.operation_proposals?.length ?? 0) >= 20) throw new AppError('AGENT_OPERATION_LIMIT', '本会话的操作草稿已达到上限。');
  if (redact(JSON.stringify(proposal)) !== JSON.stringify(proposal))
    throw new AppError('AGENT_OPERATION_INVALID', '操作参数包含敏感内容，不能保存为草稿。');
  const intent = parseControlledOperation(proposal.tool, { ...proposal.input, connection_id: task.connection_id,
    request_id: randomUUID(), ...(['run_atc', 'run_unit_tests'].includes(proposal.tool) ? { confirm_execution: true } : {}) });
  const id = randomUUID(), created_at = new Date().toISOString();
  const artifact_id = await store.artifacts.put(task.id, 'operation', JSON.stringify({
    id, created_at, target_fingerprint: task.target_fingerprint, intent
  }));
  const objectLabel = 'name' in intent.input ? intent.input.name : 'object_uri' in intent.input
    ? intent.input.object_uri?.split('/').at(-1) : undefined;
  const summary = operationSummarySchema.parse({ id, artifact_id, tool: intent.tool, created_at, object_label:objectLabel });
  const previous = task.operation_proposals;
  task.operation_proposals = [...(previous ?? []), summary];
  try { await store.save(task); } catch (error) { task.operation_proposals = previous; throw error; }
  return { status: 'success', operation_id: id, tool: intent.tool,
    message: '本机操作草稿已生成，等待用户审核；没有执行 SAP，也没有授予审批。' };
}

export async function readOperationProposal(task: AgentTask, store: TaskStore, id: string) {
  const summary = task.operation_proposals?.find(item => item.id === id);
  if (!summary) throw new AppError('AGENT_OPERATION_NOT_FOUND', '操作草稿不属于当前会话或已不存在。');
  const artifact = await store.artifacts.get(task.id, summary.artifact_id);
  if (artifact.kind !== 'operation') throw new AppError('AGENT_OPERATION_INVALID', '操作草稿类型无效。');
  let value: unknown;
  try { value = JSON.parse(artifact.content); } catch { throw new AppError('AGENT_OPERATION_INVALID', '操作草稿无法解析。'); }
  const parsed = z.object({ id: z.literal(summary.id), created_at: z.literal(summary.created_at),
    target_fingerprint: z.literal(task.target_fingerprint), intent: z.object({ tool: z.literal(summary.tool), input: z.unknown() }).strict()
  }).strict().safeParse(value);
  if (!parsed.success) throw new AppError('AGENT_OPERATION_INVALID', '操作草稿完整性校验失败。');
  const intent: ControlledOperationIntent = parseControlledOperation(summary.tool, parsed.data.intent.input);
  if (intent.input.connection_id !== task.connection_id) throw new AppError('AGENT_TARGET_CHANGED', '操作草稿目标与会话不一致。');
  return { ...summary, intent };
}
