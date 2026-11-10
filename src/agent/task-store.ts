import { lstat, mkdir, open, readFile, readdir, rename, stat, unlink, rm } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../errors.js';
import type { Message } from './model/model.js';
import { ArtifactStore } from './artifacts.js';
import type { SourceRead } from './source-progress.js';
import { extensionRefSchema,type ExtensionRef } from './extensions.js';
import { generatedFileSchema,localScriptSchema,type GeneratedFile,type LocalScript } from './local-work.js';
import { automaticTitle,taskTitle } from './title.js';
import { createHash } from 'node:crypto';
import { reportToolRecords } from './report.js';
import { maxUploadFiles, type UploadedFile } from './attachments/uploads.js';
import { changeApprovalSchema, changeReviewSchema, changeSummarySchema, type ChangeApproval, type ChangeReview, type ChangeSummary } from './drafts/change-preview.js';
import { operationSummarySchema, type OperationSummary } from './drafts/operation-proposal.js';
import { workflowSummarySchema, type WorkflowSummary } from './drafts/workflow-proposal.js';
import { maxOutputCharacters, maxToolArgumentCharacters, maxTaskBytes } from './output-limits.js';
import { draftStateSchema, type DraftState } from './drafts/draft-state.js';
import { recalledMemoriesSchema,type MemoryRecord } from './long-term-memory.js';
import { mcpProposalSchema,type McpProposal } from './mcp-management.js';
import { pendingQuestionSchema, type PendingQuestion } from './questions.js';

export type TaskStatus = 'queued' | 'running' | 'waiting_input' | 'completed' | 'failed' | 'stopped' | 'interrupted';
export type TaskEvent = { sequence: number; time: string; type: string; tool?: string; operation_id?: string;
  result_artifact_id?: string; summary?: string };
export type ReportEntry={id:string;title:string;artifact_id:string;created_at:string;updated_at:string;request_key?:string};
export type AgentTask = { schema_version: 1; id: string; status: TaskStatus; connection_id: string; target_fingerprint: string;
  allow_table_data?: boolean;
  recalled_memories?: MemoryRecord[];
  web_sources?: {title:string;url:string}[];
  custom_mcp_enabled?: boolean;
  mcp_proposal?: McpProposal;
  pending_question?: PendingQuestion;
  skill_authoring_enabled?:boolean;
  write_mode?: 'controlled' | 'unrestricted'; write_enabled?: boolean;
  context_tokens?: number; memory?: string; compactions?: number; archive_head?: string;
  event_archive_head?: string; capabilities_verified?: boolean;
  model_usage?: { reported_requests: number; prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  last_model_input_tokens?: number;
  source_reads?: SourceRead[];
  latest_prompt?: string; latest_user_id?: string;
  initial_uploads?: UploadedFile[]; latest_uploads?: UploadedFile[];
  initial_references?: ExtensionRef[]; latest_references?: ExtensionRef[];
  local_scripts?:LocalScript[]; generated_files?:GeneratedFile[];
  changes?: ChangeSummary[];
  change_reviews?: ChangeReview[];
  change_approvals?: ChangeApproval[];
  operation_proposals?: OperationSummary[];
  workflow_proposals?: WorkflowSummary[];
  drafts?: DraftState[];
  draft_plan_members?: string[];
  draft_plan_history?: string[][];
  repair_only?: boolean;
  draft_revision_pending?: boolean;
  draft_revision_artifact?: string;
  draft_save_recovery?: string;
  title?: string; pinned?: boolean;
  output_mode?: 'chat'|'report'; report_schema?: 1; report_artifact_id?: string; report_updated_at?: string;
  reports?:ReportEntry[];active_report_id?:string;report_target_id?:string;report_target_context?:string;selected_report_id?:string;
  client: string; prompt: string; created_at: string; updated_at: string; model_requests: number; tool_calls: number;
  messages: Message[]; events: TaskEvent[]; answer?: string; error?: { code: string; message: string } };

const reportIdSchema=z.union([z.uuid(),z.string().regex(/^[a-f0-9]{64}$/),z.literal('legacy')]);
const uploadedFileSchema = z.object({ name: z.string().min(1).max(200), artifact_id: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const taskSchema = z.object({ schema_version: z.literal(1), id: z.uuid(),
  allow_table_data: z.boolean().default(false),
  recalled_memories:recalledMemoriesSchema.optional(),
  write_mode: z.enum(['controlled', 'unrestricted']).default('controlled'), write_enabled: z.boolean().default(false),
  title: z.string().trim().min(1).max(80).optional(), pinned: z.boolean().optional(),
  web_sources:z.array(z.object({title:z.string().max(160),url:z.string().max(2048)})).max(10).optional(),
  custom_mcp_enabled:z.boolean().optional(),
  mcp_proposal:mcpProposalSchema.optional(),
  pending_question:pendingQuestionSchema.optional(),
  skill_authoring_enabled:z.boolean().optional(),
  output_mode:z.enum(['chat','report']).optional(),report_schema:z.literal(1).optional(),
  report_artifact_id:z.string().regex(/^[a-f0-9]{64}$/).optional(),report_updated_at:z.iso.datetime().optional(),
  reports:z.array(z.object({id:reportIdSchema,title:z.string().min(1).max(80),artifact_id:z.string().regex(/^[a-f0-9]{64}$/),created_at:z.iso.datetime(),updated_at:z.iso.datetime(),request_key:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict()).optional(),
  active_report_id:reportIdSchema.optional(),report_target_id:reportIdSchema.optional(),
  report_target_context:z.string().max(16000).optional(),
  selected_report_id:reportIdSchema.optional(),
  latest_prompt: z.string().min(1).max(4000).optional(), latest_user_id: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  initial_uploads: z.array(uploadedFileSchema).max(maxUploadFiles).optional(), latest_uploads: z.array(uploadedFileSchema).max(maxUploadFiles).optional(),
  initial_references:z.array(extensionRefSchema).max(18).optional(), latest_references:z.array(extensionRefSchema).max(18).optional(),
  local_scripts:z.array(localScriptSchema).max(24).optional(), generated_files:z.array(generatedFileSchema).max(48).optional(),
  changes: z.array(changeSummarySchema).max(20).optional(),
  change_reviews: z.array(changeReviewSchema).max(20).optional(),
  change_approvals: z.array(changeApprovalSchema).max(20).optional(),
  operation_proposals: z.array(operationSummarySchema).max(20).optional(),
  workflow_proposals: z.array(workflowSummarySchema).max(20).optional(),
  drafts: z.array(draftStateSchema).max(60).optional(),
  draft_plan_members: z.array(z.string().max(80)).max(60).optional(),
  draft_plan_history: z.array(z.array(z.string().max(80)).max(60)).max(60).optional(),
  repair_only: z.boolean().optional(),
  draft_revision_pending: z.boolean().optional(),
  draft_revision_artifact: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  draft_save_recovery: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  context_tokens: z.number().int().min(16000).max(1000000).optional(), memory: z.string().max(16000).optional(),
  compactions: z.number().int().nonnegative().optional(), archive_head: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  event_archive_head: z.string().regex(/^[a-f0-9]{64}$/).optional(), capabilities_verified: z.boolean().optional(),
  model_usage: z.object({ reported_requests: z.number().int().nonnegative(),
    prompt_tokens: z.number().int().nonnegative().optional(), completion_tokens: z.number().int().nonnegative().optional(),
    total_tokens: z.number().int().nonnegative().optional() }).strict().optional(),
  last_model_input_tokens: z.number().int().nonnegative().optional(),
  source_reads: z.array(z.object({ artifact_id: z.string().regex(/^[a-f0-9]{64}$/), object_uri: z.string().max(4096).optional(),
    revision: z.string().max(256).optional(), read_source: z.literal(true).optional(), total_characters: z.number().int().nonnegative(),
    ranges: z.array(z.tuple([z.number().int().nonnegative(),z.number().int().nonnegative()])).max(128) }).strict()).max(128).optional(),
  status: z.enum(['queued', 'running', 'waiting_input', 'completed', 'failed', 'stopped', 'interrupted']),
  connection_id: z.uuid(), target_fingerprint: z.string().regex(/^[a-f0-9]{64}$/), client: z.string().regex(/^\d{3}$/),
  prompt: z.string().min(1).max(4000), created_at: z.iso.datetime(), updated_at: z.iso.datetime(),
  model_requests: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), tool_calls: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  messages: z.array(z.object({ role: z.enum(['system', 'user', 'assistant', 'tool']), content: z.string().max(maxOutputCharacters).nullable(),
    reasoning_content: z.string().max(maxOutputCharacters).optional(),
    tool_call_id: z.string().max(256).optional(), tool_calls: z.array(z.object({ id: z.string().min(1).max(256),
      type: z.literal('function'), function: z.object({ name: z.string().min(1).max(128), arguments: z.string().max(maxToolArgumentCharacters) }).strict()
    }).strict()).max(128).optional() }).strict()).max(4096),
  events: z.array(z.object({ sequence: z.number().int().positive(), time: z.iso.datetime(), type: z.string().max(64),
    tool: z.string().max(128).optional(), operation_id: z.string().max(256).optional(),
    result_artifact_id: z.string().regex(/^[a-f0-9]{64}$/).optional(), summary: z.string().max(1200).optional() }).strict()).max(16384),
  answer: z.string().max(maxOutputCharacters).optional(), error: z.object({ code: z.string().max(128), message: z.string().max(2048) }).strict().optional()
}).strict();

export function taskEvent(task: AgentTask, type: string, extra: Pick<TaskEvent, 'tool' | 'operation_id' | 'result_artifact_id' | 'summary'> = {}) {
  const time = new Date().toISOString();
  task.updated_at = time;
  task.events.push({ sequence: (task.events.at(-1)?.sequence ?? 0) + 1, time, type, ...extra });
}

export class TaskStore {
  readonly directory: string;
  readonly artifacts: ArtifactStore;
  private pending: Promise<void> = Promise.resolve();
  constructor(directory: string) {
    this.directory = join(directory, 'agent', 'tasks');
    this.artifacts = new ArtifactStore(this.directory);
  }
  private serialized<T>(action: () => Promise<T>): Promise<T> {
    const next = this.pending.then(action);
    this.pending = next.then(() => {}, () => {});
    return next;
  }
  private path(id: string) {
    if (!z.uuid().safeParse(id).success) throw new AppError('AGENT_INVALID_TASK', '任务 ID 无效。');
    return join(this.directory, `${id}.json`);
  }
  async save(task: AgentTask) {
    if (task.events.length > 512) {
      const head = await this.artifacts.put(task.id, 'events', JSON.stringify({ previous: task.event_archive_head ?? null,
        events: task.events.slice(0, -256) }));
      task.event_archive_head = head; task.events = task.events.slice(-256);
    }
    taskSchema.parse(task);
    const path = this.path(task.id);
    const content = JSON.stringify(task);
    if (Buffer.byteLength(content) > maxTaskBytes) throw new AppError('AGENT_STORAGE_LIMIT', '任务存储达到上限。');
    return this.serialized(() => this.write(task.id, path, content));
  }
  private async write(id: string, path: string, content: string) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `${id}.${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
      // Windows readers/scanners can briefly deny atomic replacement. Keep the
      // existing snapshot intact and bound retries to this local file operation.
      for (let attempt = 0; ; attempt++) {
        try { await rename(temporary, path); break; }
        catch (error) {
          if (process.platform !== 'win32' || attempt >= 4 ||
              !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
          await new Promise(resolve => setTimeout(resolve, 10 * 2 ** attempt));
        }
      }
    } finally { await unlink(temporary).catch(() => {}); }
  }
  async get(id: string): Promise<AgentTask> {
    const path = this.path(id);
    return this.serialized(() => this.read(id, path));
  }
  private async read(id: string, path: string): Promise<AgentTask> {
    try {
      if ((await stat(path)).size > maxTaskBytes) throw new Error('size');
      const task = taskSchema.parse(JSON.parse(await readFile(path, 'utf8')));
      if (task.id !== id) throw new Error('format');
      return task;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new AppError('AGENT_TASK_NOT_FOUND', '任务不存在。');
      throw new AppError('AGENT_TASK_UNREADABLE', '任务文件无法读取。');
    }
  }
  async ids() {
    const names = await readdir(this.directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    return names.filter(name => name.endsWith('.json') && z.uuid().safeParse(name.slice(0, -5)).success)
      .map(name => name.slice(0, -5));
  }
  async toolResult(id: string, sequence: number, offset: number) {
    const task = await this.get(id);
    const event = task.events.find(item => item.sequence === sequence && ['tool_completed', 'tool_failed'].includes(item.type));
    if (!event) throw new AppError('AGENT_ARTIFACT_UNAVAILABLE', '这项操作没有可查看的结果。');
    let artifactId = event.result_artifact_id;
    if (!artifactId && event.operation_id) {
      // Older checkpoints can still identify a result by its operation receipt.
      for (const message of task.messages) {
        if (message.role !== 'tool' || !message.content) continue;
        let receipt;
        try { receipt = JSON.parse(message.content); } catch { continue; }
        if (receipt?.operation_id === event.operation_id) {
          artifactId = receipt._task_artifact?.artifact_id;
          break;
        }
      }
    }
    if (!artifactId) throw new AppError('AGENT_ARTIFACT_UNAVAILABLE', '这项历史操作没有可查看的结果。');
    const artifact = await this.artifacts.get(id, artifactId);
    if (artifact.kind !== 'result') throw new AppError('AGENT_ARTIFACT_UNAVAILABLE', '这项操作没有可查看的结果。');
    const text = artifact.content.length <= 64000 ? JSON.stringify(JSON.parse(artifact.content), null, 2) : artifact.content;
    const length = 12000;
    const end = Math.min(offset + length, text.length);
    return { text: text.slice(offset, end), offset, total_characters: text.length,
      previous_offset: offset ? Math.max(0, offset - length) : null, next_offset: end < text.length ? end : null };
  }
  async conversation(id: string, before?: string) {
    const task = await this.get(id);
    const initial = { id: 'initial', role: 'user', content: task.prompt, attachments: task.initial_uploads ?? [], ...(task.initial_references?.length ? {references:task.initial_references} : {}) };
    if (before === 'initial') return { messages: [initial], next_cursor: null };
    let head = before ?? task.archive_head, scanned = 0;
    const messages: { id: string; role: string; content: string; attachments?: UploadedFile[]; references?:ExtensionRef[] }[] = [];
    while (head && scanned++ < 500 && messages.length < 20) {
      const archive = await this.artifacts.get(id, head);
      if (archive.kind !== 'turn') throw new AppError('AGENT_INVALID_TASK', '对话分页标识无效。');
      const turn = JSON.parse(archive.content) as { previous: string | null; messages: Message[]; attachments?: UploadedFile[]; references?:ExtensionRef[] };
      messages.unshift(...turn.messages.flatMap((message,index) =>
        (message.role === 'user' || message.role === 'assistant' && !message.tool_calls?.length) && message.content
          ? [{ id: `${head}:${index}`, role: message.role, content: message.content,
            ...(message.role === 'user' && turn.attachments ? { attachments: turn.attachments } : {}),
            ...(message.role === 'user' && turn.references ? {references:turn.references} : {}) }] : []));
      head = turn.previous ?? undefined;
    }
    if (!head && messages.length < 20) messages.unshift(initial);
    // Older pre-archive tasks still expose their existing final answer.
    if (!before && !task.archive_head && task.answer) messages.push({ id: 'legacy-answer', role: 'assistant', content: task.answer });
    return { messages, next_cursor: head ?? (messages.some(message => message.id === 'initial') ? null : 'initial') };
  }
  async recover() {
    await this.drainDeleted();
    for (const id of await this.ids()) {
      // Keep a damaged historical task from disabling the management UI. A
      // direct read still reports the corruption; never execute that history.
      const task = await this.get(id).catch(() => undefined);
      if (!task) continue;
      const interrupted = (task.local_scripts ?? []).filter(script=>script.state==='running');
      for (const script of interrupted) {
        script.state = 'interrupted';
        script.message = '客户端重启，脚本执行结果待核实。';
      }
      if (['running', 'queued'].includes(task.status)) {
        task.status = 'interrupted';
        taskEvent(task, 'interrupted');
        await this.save(task);
      } else if (interrupted.length) await this.save(task);
    }
  }
  async report(id:string,reportId?:string) {
    const task=await this.get(id);
    const entry=task.reports?.find(report=>report.id===(reportId??task.active_report_id))??(!reportId?task.reports?.at(-1):undefined);
    if(reportId&&task.reports&&!entry)throw new AppError('AGENT_REPORT_NOT_FOUND','报告不属于当前会话或已不存在。');
    if(reportId&&!task.reports&&reportId!==(task.report_artifact_id??'legacy'))throw new AppError('AGENT_REPORT_NOT_FOUND','报告不属于当前会话或已不存在。');
    if(task.reports&&!entry)return {report:null};
    const artifactId=entry?.artifact_id??task.report_artifact_id;
    if(artifactId){
      const artifact=await this.artifacts.get(id,artifactId);
      if(artifact.kind!=='report')throw new AppError('AGENT_REPORT_INVALID','分析报告无法读取。');
      const value=z.object({content:z.string(),created_at:z.iso.datetime(),
        tools:z.array(z.object({name:z.string().max(100),completed:z.number().int().nonnegative(),failed:z.number().int().nonnegative()}).strict()).optional(),
        tools_partial:z.boolean().optional()}).strict().parse(JSON.parse(artifact.content));
      return {report:{...value,id:artifactId,report_id:entry?.id??artifactId,title:entry?.title??taskTitle(task),updated_at:entry?.updated_at??value.created_at,legacy:false}};
    }
    if(task.report_schema===1)return {report:null};
    // Pre-workspace conversations used their first complete answer as a report.
    let cursor:string|undefined,first:{content:string}|undefined;
    const seen=new Set<string>();
    do {
      const page=await this.conversation(id,cursor);
      const earliest=page.messages.find(message=>message.role==='assistant');if(earliest)first=earliest;
      cursor=page.next_cursor??undefined;
      if(cursor&&seen.has(cursor))throw new AppError('AGENT_REPORT_INVALID','历史报告无法完整读取。');
      if(cursor)seen.add(cursor);
    }while(cursor);
    return {report:first?{id:'legacy',report_id:'legacy',title:taskTitle(task),content:first.content,created_at:task.created_at,updated_at:task.created_at,legacy:true}:null};
  }
  async reportList(id:string){
    const task=await this.get(id);
    if(task.reports)return {reports:task.reports.map(({request_key:_key,...report})=>report),active_report_id:task.active_report_id??null};
    const {report}=await this.report(id);
    return {reports:report?[{id:report.report_id,title:report.title,created_at:report.created_at,updated_at:report.updated_at,artifact_id:report.id}]:[],active_report_id:report?.report_id??null};
  }
  async saveReport(task:AgentTask,content:string,title?:string,targetId?:string){
    let reports=task.reports?[...task.reports]:[];
    if(!task.reports){
      const {report}=await this.report(task.id);
      if(report){const artifact=report.id==='legacy'?await this.artifacts.put(task.id,'report',JSON.stringify({content:report.content,created_at:report.created_at})):report.id;
        reports.push({id:report.report_id,title:report.title,artifact_id:artifact,created_at:report.created_at,updated_at:report.updated_at});}
    }
    const target=targetId?reports.find(report=>report.id===targetId):undefined;
    if(targetId&&!target)throw new AppError('AGENT_REPORT_NOT_FOUND','要更新的报告不属于当前会话。');
    const requestKey=createHash('sha256').update(JSON.stringify([task.latest_user_id??task.id,title??'',content])).digest('hex');
    const duplicate=!targetId&&reports.find(report=>report.request_key===requestKey);if(duplicate)return duplicate;
    const now=new Date().toISOString();
    const artifact=await this.artifacts.put(task.id,'report',JSON.stringify({content,created_at:target?.created_at??now,
      tools:reportToolRecords(task.events),tools_partial:Boolean(task.event_archive_head)}));
    const inferred=/^请基于本会话已有资料新建一份独立分析报告/.test(task.latest_prompt??'')?`${automaticTitle(task.prompt)} · ${reports.length+1}`:automaticTitle(task.latest_prompt??task.prompt);
    const entry:ReportEntry={id:target?.id??randomUUID(),title:title??target?.title??inferred,artifact_id:artifact,created_at:target?.created_at??now,updated_at:now,request_key:requestKey};
    reports=target?reports.map(report=>report.id===target.id?entry:report):[...reports,entry];
    task.reports=reports;task.active_report_id=entry.id;task.report_artifact_id=artifact;task.report_updated_at=now;task.report_schema=1;
    return entry;
  }
  private dataDirectory(id: string) {
    this.path(id); // UUID validation precedes any recursive filesystem operation.
    const target = resolve(this.directory,id);
    if (dirname(target) !== resolve(this.directory)) throw new AppError('AGENT_INVALID_TASK','任务目录无效。');
    return target;
  }
  private async finishDelete(id: string) {
    const target = this.dataDirectory(id);
    await rm(target,{recursive:true,force:true});
    await unlink(join(this.directory,'.trash',id+'.json'));
  }
  async remove(id: string) {
    return this.serialized(async () => {
      await mkdir(join(this.directory,'.trash'),{recursive:true,mode:0o700});
      await rename(this.path(id),join(this.directory,'.trash',id+'.json'));
      try { await this.finishDelete(id); return { id, cleanup_pending:false }; }
      catch { return { id, cleanup_pending:true }; }
    });
  }
  async drainDeleted() {
    await this.cleanupDeletedOutputs(true, false);
  }
  async cleanupDeletedOutputs(confirm: boolean, includeOrphans = true) {
    return this.serialized(async () => {
      const result = { eligible_session_outputs:0, deleted_session_outputs:0, failed_session_outputs:0 };
      const info = (path: string) => lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      const trash = join(this.directory,'.trash');
      for (const path of [dirname(this.directory), this.directory, trash]) {
        const entry = await info(path);
        if (entry && !entry.isDirectory()) return {...result,failed_session_outputs:1};
        if (!entry && path !== trash) return result;
      }
      const entries = await readdir(trash, {withFileTypes:true}).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      const marked = new Set(entries.filter(entry=>entry.isFile()&&entry.name.endsWith('.json')&&
        z.uuid().safeParse(entry.name.slice(0,-5)).success).map(entry=>entry.name.slice(0,-5)));
      const candidates = new Set(marked);
      if (includeOrphans) for (const entry of await readdir(this.directory,{withFileTypes:true})) {
        if (entry.isDirectory() && z.uuid().safeParse(entry.name).success) candidates.add(entry.name);
      }
      for (const id of candidates) {
        try {
          // The presence of the session metadata protects its outputs even if the metadata is unreadable.
          if (await info(this.path(id))) continue;
          const directory = this.dataDirectory(id);
          const session = await info(directory);
          if (session && !session.isDirectory()) throw new Error('Unsafe session directory');
          const artifacts = join(directory,'artifacts');
          if (!marked.has(id)) {
            const entry = await info(artifacts);
            if (!entry) continue;
            if (!entry.isDirectory()) throw new Error('Unsafe artifacts directory');
          }
          result.eligible_session_outputs++;
          if (!confirm) continue;
          if (marked.has(id)) await this.finishDelete(id);
          else await rm(artifacts,{recursive:true,force:true});
          result.deleted_session_outputs++;
        } catch {
          result.failed_session_outputs++;
        }
      }
      return result;
    });
  }
}
