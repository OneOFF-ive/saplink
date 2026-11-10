import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { sourceResult } from '../../adt.js';
import { AppError } from '../../errors.js';
import { sourceDiff } from '../../source-diff.js';
import { applySourceEdits, sourceUpdateFields } from '../../source-edit.js';
import { ddicUriName } from '../../adt-uri.js';
import { verifyDdicUpdate } from '../../ddic-definition.js';
import type { ModelTool } from '../model/model.js';
import type { AgentTask, TaskStore } from '../task-store.js';

export const changePreviewInput = z.object({
  transport_task: z.string().regex(/^[A-Za-z0-9]{1,30}$/).optional(),
  source_artifact_id: z.string().regex(/^[a-f0-9]{64}$/),
  summary: z.string().trim().min(1).max(500),
  resolves_drafts: z.array(z.uuid()).min(1).max(40).optional(),
  edits: sourceUpdateFields.edits.unwrap()
}).strict();
export const changePreviewTool: ModelTool = { type: 'function', function: {
  name: 'propose_source_change',
  description: 'Create a local review-only source change from a previously read source artifact in this task. Use exact unique old_text and new_text edits. It does not write, check or activate SAP.',
  parameters: z.toJSONSchema(changePreviewInput, { io: 'input' })
} };

export const changeSummarySchema = z.object({
  id: z.uuid(), artifact_id: z.string().regex(/^[a-f0-9]{64}$/), summary: z.string().min(1).max(500),
  object_uri: z.string().min(1).max(2048), source_uri: z.string().min(1).max(2048),
  version: z.enum(['active', 'inactive']), revision: z.string().regex(/^[a-f0-9]{64}$/),
  created_at: z.iso.datetime()
}).strict();
export type ChangeSummary = z.infer<typeof changeSummarySchema>;

export const changeReviewSchema = z.object({
  id: z.uuid(), change_id: z.uuid(), artifact_id: z.string().regex(/^[a-f0-9]{64}$/),
  target_fingerprint: z.string().regex(/^[a-f0-9]{64}$/), revision: z.string().regex(/^[a-f0-9]{64}$/),
  verified_at: z.iso.datetime(), reviewed_at: z.iso.datetime()
}).strict();
export type ChangeReview = z.infer<typeof changeReviewSchema>;

export const changeApprovalSchema = z.object({
  id: z.uuid(), change_id: z.uuid(), artifact_id: z.string().regex(/^[a-f0-9]{64}$/),
  request_id: z.uuid(), transport_task: z.string().regex(/^[A-Za-z0-9]+$/).max(30).optional()
}).strict();
export type ChangeApproval = z.infer<typeof changeApprovalSchema>;

const sourceSchema = z.object({ status: z.literal('success'), data: z.object({
  object_uri: z.string().min(1).max(2048), source_uri: z.string().min(1).max(2048),
  source: z.string().max(1024 * 1024), version: z.enum(['active', 'inactive']),
  revision: z.string().regex(/^[a-f0-9]{64}$/), hash: z.string().regex(/^[a-f0-9]{64}$/)
}).passthrough() }).passthrough();

export async function createChangePreview(task: AgentTask, store: TaskStore, input: z.infer<typeof changePreviewInput>,
  redact: (text: string) => string, persist = true) {
  if ((task.changes?.length ?? 0) >= 20) throw new AppError('AGENT_CHANGE_LIMIT', '本会话的变更草稿已达到上限。');
  const recorded = task.source_reads?.find(read => read.artifact_id === input.source_artifact_id && read.read_source === true);
  if (!recorded)
    throw new AppError('AGENT_CHANGE_SOURCE_INVALID', '请先在当前会话读取目标源码，再创建变更草稿。');
  const artifact = await store.artifacts.get(task.id, input.source_artifact_id);
  if (artifact.kind !== 'result') throw new AppError('AGENT_CHANGE_SOURCE_INVALID', '变更基线不是源码读取结果。');
  let value: unknown;
  try { value = JSON.parse(artifact.content); }
  catch { throw new AppError('AGENT_CHANGE_SOURCE_INVALID', '源码读取结果无法解析。'); }
  const parsed = sourceSchema.safeParse(value);
  if (!parsed.success) throw new AppError('AGENT_CHANGE_SOURCE_INVALID', '源码读取结果缺少完整基线信息。');
  const source = parsed.data.data;
  if (recorded.object_uri !== source.object_uri || recorded.revision !== source.revision)
    throw new AppError('AGENT_CHANGE_SOURCE_INVALID', '源码读取记录与基线不一致，请重新读取。');
  const expected = sourceResult(task.connection_id, source.object_uri, source.source_uri, source.source, source.version);
  if (expected.hash !== source.hash || expected.revision !== source.revision)
    throw new AppError('AGENT_CHANGE_SOURCE_INVALID', '源码基线完整性校验失败，请重新读取。');
  const edits = input.edits.map(edit => ({ old_text: redact(edit.old_text), new_text: redact(edit.new_text) }));
  const proposed = applySourceEdits(source.source, edits);
  const ddicName = ddicUriName(source.object_uri);
  if (ddicName) verifyDdicUpdate(ddicName,source.source,proposed);
  const diff = sourceDiff(source.source, proposed, 3, 2000);
  if (diff.equal) throw new AppError('AGENT_CHANGE_EMPTY', '变更草稿没有实际修改。');
  if (diff.truncated || diff.line_endings_only)
    throw new AppError('AGENT_CHANGE_DIFF_INCOMPLETE', '无法展示完整差异，请缩小修改范围后重试。');
  const summary = redact(input.summary);
  if (!summary.trim() || summary.length > 500) throw new AppError('AGENT_CHANGE_INVALID', '变更摘要无效。');
  const id = randomUUID(), created_at = new Date().toISOString();
  const artifactId = await store.artifacts.put(task.id, 'change', JSON.stringify({
    id, connection_id: task.connection_id, target_fingerprint: task.target_fingerprint,
    source_artifact_id: input.source_artifact_id, object_uri: source.object_uri, source_uri: source.source_uri,
    version: source.version, revision: source.revision, original_hash: source.hash,
    proposed_source: proposed, transport_task: input.transport_task, edits, diff, summary, created_at
  }));
  const change = changeSummarySchema.parse({ id, artifact_id: artifactId, summary, object_uri: source.object_uri,
    source_uri: source.source_uri, version: source.version, revision: source.revision, created_at });
  const previousChanges = task.changes;
  task.changes = [...(previousChanges ?? []), change];
  try { if (persist) await store.save(task); }
  catch (error) { task.changes = previousChanges; throw error; }
  return { status: 'success', change_id: id, object_uri: source.object_uri, version: source.version,
    revision: source.revision, added_lines: diff.added_lines, removed_lines: diff.removed_lines,
    message: '本机变更草稿已生成，等待用户审核；没有写入、检查或激活 SAP。' };
}

export async function readChangePreview(task: AgentTask, store: TaskStore, id: string) {
  const change = task.changes?.find(item => item.id === id);
  if (!change) throw new AppError('AGENT_CHANGE_NOT_FOUND', '变更草稿不属于当前会话或已不存在。');
  const artifact = await store.artifacts.get(task.id, change.artifact_id);
  if (artifact.kind !== 'change') throw new AppError('AGENT_CHANGE_INVALID', '变更草稿无法读取。');
  let data: unknown;
  try { data = JSON.parse(artifact.content); }
  catch { throw new AppError('AGENT_CHANGE_INVALID', '变更草稿无法读取。'); }
  const detail = z.object({ id: z.literal(change.id), connection_id: z.literal(task.connection_id),
    target_fingerprint: z.literal(task.target_fingerprint), object_uri: z.literal(change.object_uri),
    source_uri: z.literal(change.source_uri), version: z.literal(change.version), revision: z.literal(change.revision),
    summary: z.literal(change.summary), created_at: z.literal(change.created_at),
    edits: sourceUpdateFields.edits.unwrap(),
    proposed_source: z.string().min(1).max(1024 * 1024),
    transport_task: z.string().regex(/^[A-Za-z0-9]{1,30}$/).optional(),
    diff: z.object({ equal: z.boolean(), line_endings_only: z.boolean(), truncated: z.literal(false),
      added_lines: z.number().int(), removed_lines: z.number().int(),
      hunks: z.array(z.object({ lines: z.array(z.object({ kind: z.enum(['context','added','removed']),
        old_line: z.number().int().nullable(), new_line: z.number().int().nullable(), text: z.string(),
        text_truncated: z.boolean().optional() })) })) }).passthrough()
  }).passthrough().safeParse(data);
  if (!detail.success) throw new AppError('AGENT_CHANGE_INVALID', '变更草稿完整性校验失败。');
  const review = task.change_reviews?.find(item => item.change_id === change.id);
  if (review && (review.artifact_id !== change.artifact_id || review.revision !== change.revision ||
      review.target_fingerprint !== task.target_fingerprint))
    throw new AppError('AGENT_CHANGE_INVALID', '草稿审核记录与草稿不一致。');
  return { ...change, proposed_source: detail.data.proposed_source, transport_task: detail.data.transport_task, diff: detail.data.diff, edits: detail.data.edits, status: 'preview' as const,
    review: review ? { id: review.id, reviewed_at: review.reviewed_at, verified_at: review.verified_at } : null };
}

export function compareChangeBaseline(task: AgentTask, change: ChangeSummary, result: unknown) {
  const parsed = sourceSchema.safeParse(result);
  if (!parsed.success) throw new AppError('AGENT_CHANGE_VERIFY_FAILED', 'SAP 未返回完整源码，无法核对草稿基线。');
  const source = parsed.data.data;
  if (source.object_uri !== change.object_uri || source.source_uri !== change.source_uri || source.version !== change.version)
    throw new AppError('AGENT_CHANGE_VERIFY_FAILED', 'SAP 返回的源码对象或版本与草稿不一致，无法核对。');
  const expected = sourceResult(task.connection_id, source.object_uri, source.source_uri, source.source, source.version);
  if (expected.hash !== source.hash || expected.revision !== source.revision)
    throw new AppError('AGENT_CHANGE_VERIFY_FAILED', 'SAP 源码结果完整性校验失败，无法核对。');
  return { matches: source.revision === change.revision, checked_at: new Date().toISOString() };
}
