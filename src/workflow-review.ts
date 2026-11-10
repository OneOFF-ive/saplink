import { z } from 'zod';
import { digest } from './config.js';
import { AppError } from './errors.js';
import type { ApprovalService } from './approval-service.js';
import { toolSchemas } from './tool-definitions.js';

const common = {
  connection_id: toolSchemas.create_program.shape.connection_id,
  plan_id: z.uuid(),
  source: z.string().min(1).max(1024 * 1024),
  syntax_check: z.boolean().default(true),
  activate: z.boolean().default(false),
  atc_variant: toolSchemas.run_atc.shape.check_variant.optional()
};

const createPlan = z.object({
    ...common,
    action: z.literal('create_program'),
    name: toolSchemas.create_program.shape.name,
    description: toolSchemas.create_program.shape.description,
    package_name: toolSchemas.create_program.shape.package_name,
    transport_task: toolSchemas.create_program.shape.transport_task
  }).strict();
const updatePlan = z.object({
    ...common,
    action: z.literal('update_source'),
    object_uri: toolSchemas.read_source.shape.object_uri,
    source_uri: toolSchemas.read_source.shape.source_uri.unwrap(),
    version: z.enum(['active', 'inactive']),
    expected_revision: toolSchemas.update_source.shape.expected_revision,
    transport_task: toolSchemas.create_program.shape.transport_task
  }).strict();
const proposalFields = {
  resolves_drafts: z.array(z.uuid()).min(1).max(40).optional(),
  summary: z.string().trim().min(1).max(500).optional()
};
export const workflowProposalSchema = z.discriminatedUnion('action', [
  createPlan.omit({ connection_id: true, plan_id: true }).extend({
    ...proposalFields,
    revises_creation: z.string().regex(/^[a-f0-9]{64}$/).optional()
  }),
  updatePlan.omit({ connection_id: true, plan_id: true }).extend(proposalFields)
]);
export const workflowPlanSchema = z.discriminatedUnion('action', [createPlan, updatePlan]).superRefine((plan, context) => {
  if (plan.atc_variant && !plan.activate)
    context.addIssue({ code: 'custom', path: ['atc_variant'], message: 'ATC requires activation in this workflow.' });
});

export type WorkflowPlan = z.output<typeof workflowPlanSchema>;

export class WorkflowReview {
  constructor(private approvals: Pick<ApprovalService, 'review'>) {}

  async review(raw: unknown) {
    const parsed = workflowPlanSchema.safeParse(raw);
    if (!parsed.success) throw new AppError('WORKFLOW_INVALID', '任务计划参数无效。', {
      fields: [...new Set(parsed.error.issues.map(issue => issue.path.join('.') || '(root)'))]
    });
    const plan = parsed.data;
    const base = { connection_id: plan.connection_id, request_id: `${plan.plan_id}:write`,
      transport_task: plan.transport_task };
    const operation = plan.action === 'create_program'
      ? { tool: 'create_program' as const, input: { ...base, name: plan.name,
        description: plan.description, package_name: plan.package_name, program_kind: 'report' as const } }
      : { tool: 'update_source' as const, input: { ...base, object_uri: plan.object_uri,
        source_uri: plan.source_uri, version: plan.version, expected_revision: plan.expected_revision, source: plan.source } };
    const operationReview = await this.approvals.review(operation.tool, operation.input);
    const steps = [
      ...(plan.action === 'create_program' ? ['create_program'] : []),
      'update_source',
      ...(plan.syntax_check ? ['syntax_check'] : []),
      ...(plan.activate ? ['activate_objects'] : []),
      ...(plan.atc_variant ? ['run_atc'] : [])
    ];
    const reviewed = { schema_version: 1 as const, target: operationReview.target, plan, steps,
      ...(operationReview.diff ? { diff: operationReview.diff } : {}) };
    return { ...reviewed, review_id: digest(JSON.stringify(reviewed)) };
  }
}
