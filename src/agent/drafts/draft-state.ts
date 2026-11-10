import { z } from 'zod';

export const draftKind = z.enum(['change', 'workflow', 'operation']);
export type DraftKind = z.infer<typeof draftKind>;
export const draftStateSchema = z.object({
  key: z.string().max(80), artifact_id: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(['saving', 'saved', 'failed', 'uncertain', 'discarded', 'superseded', 'conflict']),
  replacement_id: z.uuid().optional(),
  plan_id: z.uuid().optional(), approval_ids: z.array(z.uuid()).optional(),
  evidence_artifact: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  message: z.string().max(2048).optional(),
  saved_source: z.object({ object_uri: z.string(), source_uri: z.string(), revision: z.string(), version: z.enum(['active','inactive']) }).strict().optional(),
  activation: z.enum(['running', 'completed', 'failed', 'uncertain']).optional(),
  activation_id: z.uuid().optional(), updated_at: z.iso.datetime(),
  saved_at: z.iso.datetime().optional(),
  created_program: z.object({object_uri:z.string(), completed_at:z.iso.datetime()}).strict().optional(),
  creation_baseline_revision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  recovery_required: z.boolean().optional(),
  legacy: z.boolean().optional()
}).strict();
export type DraftState = z.infer<typeof draftStateSchema>;
