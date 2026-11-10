import type { Express } from 'express';
import { z } from 'zod';
import { AgentRuntime, estimateTaskContext } from './runtime.js';
import type { AgentTask } from './task-store.js';
import { taskTitle } from './title.js';
import { uploadsInput } from './uploads.js';
import { draftKind } from './draft-state.js';
import { extensionRefsInput,skillInput,mcpInput } from './extensions.js';
import { packageInput,prepareSkillPackage,prepareSkillDraft,skillChatInput,skillDraft,skillFileInput } from './skill-packages.js';
import { questionReplyInput } from './questions.js';

const createTask = z.object({ prompt: z.string().trim().min(1).max(4000), connection_id: z.uuid(),
  output_mode:z.enum(['chat','report']).default('report'),
  write_mode:z.enum(['controlled','unrestricted']).default('controlled'),
  attachments: uploadsInput,
  references:extensionRefsInput.optional(),
  allow_table_data:z.literal(false).optional(),
  allow_model_data: z.literal(true).default(true) }).strict();
const idSchema = z.uuid();
const reportIdSchema=z.union([z.uuid(),z.string().regex(/^[a-f0-9]{64}$/),z.literal('legacy')]);

// Internal model history and fingerprints are never included in API responses.
export function taskView(task: AgentTask) {
  return { id: task.id, status: task.status, connection_id: task.connection_id, client: task.client, allow_table_data: task.allow_table_data ?? false,
    write_mode: task.write_mode ?? 'controlled', write_enabled: task.write_enabled ?? false,
    title:taskTitle(task),pinned:task.pinned??false,
    output_mode:task.output_mode??'report',report_updated_at:task.report_updated_at,active_report_id:task.active_report_id,report_target_id:task.report_target_id,report_count:task.reports?.length,
    prompt: task.prompt, created_at: task.created_at, updated_at: task.updated_at,
    current_prompt: task.latest_prompt ?? task.prompt, current_user_id: task.latest_user_id ? `${task.latest_user_id}:0` : 'initial',
    current_attachments: task.latest_prompt ? task.latest_uploads ?? [] : task.initial_uploads ?? [],
    current_references:task.latest_prompt ? task.latest_references ?? [] : task.initial_references ?? [],
    changes: task.changes ?? [],
    operation_proposals: task.operation_proposals ?? [],
    workflow_proposals: task.workflow_proposals ?? [],
    drafts: task.drafts ?? [],
    draft_plan_members: task.draft_plan_members ?? [],
    draft_plan_history: task.draft_plan_history ?? [],
    local_scripts:task.local_scripts ?? [], generated_files:task.generated_files ?? [],
    mcp_proposal:task.mcp_proposal && {id:task.mcp_proposal.id,label:task.mcp_proposal.label,state:task.mcp_proposal.state},
    current_answer_id: task.archive_head && (task.status === 'completed' || (task.status === 'failed' && task.answer))
      ? `${task.archive_head}:0` : task.answer ? 'legacy-answer' : undefined,
    context_tokens: task.context_tokens ?? 512000, compactions: task.compactions ?? 0,
    event_count: task.events.at(-1)?.sequence ?? 0, events_archived: Boolean(task.event_archive_head),
    model_usage: task.model_usage, last_model_input_tokens: task.last_model_input_tokens,
    usage_complete: task.model_usage?.reported_requests === task.model_requests,
    model_requests: task.model_requests, tool_calls: task.tool_calls, events: task.events,
    answer: task.answer, error: task.error, pending_question:task.pending_question };
}
export function registerAgentApi(app: Express, agent: AgentRuntime) {
  // Must be registered behind the existing /api authentication/origin middleware.
  app.get('/api/agent/status', async (_req, res) => res.json(await agent.status()));
  app.post('/api/agent/tasks/:id/mcp-change/:proposalId',async(req,res)=>{
    const {confirm} = z.strictObject({confirm:z.boolean()}).parse(req.body);
    await agent.actOnMcpChange(idSchema.parse(req.params.id),idSchema.parse(req.params.proposalId),confirm);
    res.json(taskView(await agent.tasks.get(idSchema.parse(req.params.id))));
  });
  app.get('/api/agent/tasks/:id/local-scripts/:scriptId',async(req,res)=>
    res.json(await agent.readLocalScript(idSchema.parse(req.params.id),idSchema.parse(req.params.scriptId))));
  app.post('/api/agent/tasks/:id/local-scripts/:scriptId/run',async(req,res)=>{
    const {artifact_id} = z.object({confirm:z.literal(true),artifact_id:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(req.body);
    res.json(await agent.runLocalScript(idSchema.parse(req.params.id),idSchema.parse(req.params.scriptId),artifact_id));
  });
  app.get('/api/agent/tasks/:id/generated-files/:artifactId',async(req,res)=>{
    const artifactId = z.string().regex(/^[a-f0-9]{64}$/).parse(req.params.artifactId);
    const file = await agent.downloadLocalFile(idSchema.parse(req.params.id),artifactId);
    res.attachment(file.name).type('application/octet-stream').send(file.bytes);
  });
  app.get('/api/agent/extensions',async (_req,res)=>res.json(await agent.extensions.view()));
  app.post('/api/agent/extensions/skills/import',async (req,res)=>
    res.json(await agent.extensions.installSkill(prepareSkillPackage(packageInput.parse(req.body)))));
  app.put('/api/agent/extensions/skills/:id/package',async (req,res)=>
    res.json(await agent.extensions.installSkill(prepareSkillPackage(packageInput.parse(req.body)),idSchema.parse(req.params.id))));
  app.post('/api/agent/extensions/skills/chat',async (req,res)=>
    res.json(await agent.draftSkill(skillChatInput.parse(req.body))));
  app.post('/api/agent/extensions/skills/install',async (req,res)=>
    res.json(await agent.extensions.installSkill(prepareSkillDraft(skillDraft.parse(req.body)))));
  app.patch('/api/agent/extensions/skills/:id',async (req,res)=>
    res.json(await agent.extensions.setSkillEnabled(idSchema.parse(req.params.id),z.object({enabled:z.boolean()}).strict().parse(req.body).enabled)));
  app.get('/api/agent/extensions/skills/:id/file',async (req,res)=>{
    const {path,offset} = skillFileInput.extend({offset:z.coerce.number().int().min(0).default(0)}).parse(req.query);
    res.json(await agent.extensions.skillFile(idSchema.parse(req.params.id),path,offset));
  });
  app.put('/api/agent/extensions/skills/:id',async (req,res)=>
    res.json(await agent.extensions.saveSkill(idSchema.parse(req.params.id),skillInput.parse(req.body))));
  app.put('/api/agent/extensions/mcp/:id',async (req,res)=>
    res.json(await agent.extensions.saveMcp(idSchema.parse(req.params.id),mcpInput.parse(req.body))));
  app.patch('/api/agent/extensions/mcp/:id',async (req,res)=>
    res.json(await agent.extensions.setMcpEnabled(idSchema.parse(req.params.id),z.object({enabled:z.boolean()}).strict().parse(req.body).enabled)));
  app.delete('/api/agent/extensions/:kind/:id',async (req,res)=>
    res.json(await agent.extensions.remove(z.enum(['skills','mcp']).parse(req.params.kind),idSchema.parse(req.params.id))));
  app.post('/api/agent/extensions/mcp/:id/test',async (req,res)=>
    res.json(await agent.extensions.listMcp(idSchema.parse(req.params.id),AbortSignal.timeout(25000),true)));
  app.get('/api/agent/tasks/:id/draft-plan', async(req,res) => res.json(await agent.draftPlan(idSchema.parse(req.params.id))));
  app.get('/api/agent/tasks/:id/draft-plan/progress',(req,res)=>res.json(agent.draftSaveProgress(idSchema.parse(req.params.id))));
  app.get('/api/agent/tasks/:id/draft-creation-history', async(req,res) =>
    res.json(await agent.draftCreationHistory(idSchema.parse(req.params.id))));
  app.post('/api/agent/tasks/:id/draft-regenerate',async(req,res)=>{
    const {regenerate_id} = z.object({regenerate_id:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(req.body);
    const task = await agent.regenerateDraft(idSchema.parse(req.params.id),regenerate_id);
    if (!task) throw new Error('Draft regeneration was not started');
    res.status(202).json(taskView(task));
  });
  app.post('/api/agent/tasks/:id/draft-plan/:action', async(req,res) => {
    const action=z.enum(['save','discard','revise']).parse(req.params.action);
    const input=z.object({confirm:z.literal(true),token:z.string().regex(/^[a-f0-9]{64}$/),
      ...(action==='save' ? {manual_recovery:z.boolean().optional()} : {})}).strict().parse(req.body);
    res.json(await agent.actOnDraftPlan(idSchema.parse(req.params.id),action,input.token,'manual_recovery' in input && input.manual_recovery===true));
  });
  app.get('/api/agent/tasks/:id/drafts/:kind/:draftId', async(req,res) => {
    res.json(await agent.draftDetail(idSchema.parse(req.params.id),draftKind.parse(req.params.kind),idSchema.parse(req.params.draftId)));
  });
  app.post('/api/agent/tasks/:id/drafts/:kind/:draftId/reconcile',async(req,res)=>{
    const input = z.object({artifact_id:z.string().regex(/^[a-f0-9]{64}$/),sap_execution_finished:z.literal(true)}).strict().parse(req.body);
    res.json(await agent.reconcileSourceDraft(idSchema.parse(req.params.id),draftKind.parse(req.params.kind),
      idSchema.parse(req.params.draftId),input.artifact_id));
  });
  for (const action of ['save','discard','activate','revise'] as const) app.post(`/api/agent/tasks/:id/drafts/:kind/:draftId/${action}`,async(req,res)=>{
    const input = z.object({confirm:z.literal(true),artifact_id:z.string().regex(/^[a-f0-9]{64}$/),
      ...(action === 'activate' ? {atc:z.boolean().default(false)} : {}),
      ...(action === 'save' ? {manual_recovery:z.boolean().optional()} : {}),
      ...(action === 'revise' ? {prepare_only:z.boolean().optional()} : {})}).strict().parse(req.body);
    const args = [idSchema.parse(req.params.id),draftKind.parse(req.params.kind),idSchema.parse(req.params.draftId),input.artifact_id] as const;
    res.json(action === 'save' ? await agent.saveDraft(...args,'manual_recovery' in input && input.manual_recovery===true) : action === 'discard' ? await agent.discardDraft(...args) : action === 'revise' ? await agent.reviseDraft(...args,'prepare_only' in input && input.prepare_only === true)
      : await agent.activateDraft(...args,'atc' in input && input.atc === true));
  });
  app.get('/api/agent/model', async (_req, res) => res.json(await agent.settings.status()));
  app.put('/api/agent/model', async (req, res) => res.json(await agent.configure(req.body)));
  app.get('/api/agent/tasks', async (_req, res) => {
    const connectionId=z.uuid().optional().parse(_req.query.connection_id);
    const tasks = [];
    for (const id of (await agent.tasks.ids()).slice(0, 100)) {
      const task = await agent.tasks.get(id).catch(() => undefined);
      if (task) {
        if(connectionId&&task.connection_id!==connectionId)continue;
        const { answer: _answer, events: _events, ...summary } = taskView(task);
        tasks.push(summary);
      }
    }
    res.json({ tasks: tasks.sort((a, b) => Number(b.pinned)-Number(a.pinned) || b.updated_at.localeCompare(a.updated_at)) });
  });
  app.post('/api/agent/tasks/cleanup/preview',async(req,res)=>{
    const input=z.object({older_than_days:z.number().int().min(0).max(36500),keep_ids:z.array(z.uuid()).max(100).default([]),connection_id:z.uuid().optional()}).strict().parse(req.body);
    res.json(await agent.cleanupPreview(input.older_than_days,input.keep_ids,input.connection_id));
  });
  app.post('/api/agent/tasks/cleanup',async(req,res)=>{
    const input=z.object({confirm:z.literal(true),items:z.array(z.object({id:z.uuid(),updated_at:z.iso.datetime()}).strict()).min(1).max(100)}).strict().parse(req.body);
    res.json(await agent.cleanup(input.items));
  });
  app.post('/api/agent/tasks', async (req, res) => {
    const input = createTask.parse(req.body);
    res.status(202).json(taskView(await agent.create(input.prompt, input.connection_id,input.output_mode,input.allow_table_data,input.attachments,input.write_mode,input.references)));
  });
  app.get('/api/agent/tasks/:id', async (req, res) => {
    const task=await agent.tasks.get(idSchema.parse(req.params.id));
    res.json({...taskView(task),context_estimated_tokens:estimateTaskContext(task),live:agent.liveSnapshot(task.id)});
  });
  app.patch('/api/agent/tasks/:id/write-mode', async (req, res) => {
    const input = z.object({ mode:z.enum(['controlled','unrestricted']) }).strict().parse(req.body);
    res.json(taskView(await agent.setWriteMode(idSchema.parse(req.params.id),input.mode)));
  });
  app.get('/api/agent/tasks/:id/changes/:changeId', async (req, res) => {
    res.json(await agent.changeDetail(idSchema.parse(req.params.id), idSchema.parse(req.params.changeId)));
  });
  app.get('/api/agent/tasks/:id/operations/:operationId', async (req, res) => {
    res.json(await agent.operationDetail(idSchema.parse(req.params.id), idSchema.parse(req.params.operationId)));
  });
  app.get('/api/agent/tasks/:id/workflows/:workflowId', async (req, res) => {
    res.json(await agent.workflowDetail(idSchema.parse(req.params.id), idSchema.parse(req.params.workflowId)));
  });
  app.get('/api/agent/tasks/:id/workflows/:workflowId/progress', async (req, res) => {
    res.json(await agent.workflowDetail(idSchema.parse(req.params.id), idSchema.parse(req.params.workflowId), true));
  });
  app.post('/api/agent/tasks/:id/workflows/:workflowId/execute', async (req, res) => {
    const input = z.object({ confirm: z.literal(true), review_id: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(req.body);
    res.json(await agent.executeWorkflow(idSchema.parse(req.params.id), idSchema.parse(req.params.workflowId), input.review_id));
  });
  app.post('/api/agent/tasks/:id/workflows/:workflowId/reconcile', async (req, res) => {
    const input = z.object({ confirm: z.literal(true), approval_id: z.uuid(), action: z.enum(['resolve', 'revoke']) }).strict().parse(req.body);
    res.json(await agent.reconcileWorkflow(idSchema.parse(req.params.id), idSchema.parse(req.params.workflowId), input.approval_id, input.action));
  });
  app.post('/api/agent/tasks/:id/workflows/:workflowId/verify', async (req, res) => {
    z.object({}).strict().parse(req.body);
    res.json(await agent.verifyWorkflow(idSchema.parse(req.params.id), idSchema.parse(req.params.workflowId)));
  });
  app.post('/api/agent/tasks/:id/operations/:operationId/approval', async (req, res) => {
    const input = z.object({ confirm: z.literal(true), artifact_id: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(req.body);
    res.json(await agent.approveOperation(idSchema.parse(req.params.id), idSchema.parse(req.params.operationId), input.artifact_id));
  });
  app.delete('/api/agent/tasks/:id/operations/:operationId/approval', async (req, res) => {
    const input = z.object({ confirm: z.literal(true), approval_id: z.uuid() }).strict().parse(req.body);
    res.json(await agent.revokeOperation(idSchema.parse(req.params.id), idSchema.parse(req.params.operationId), input.approval_id));
  });
  app.post('/api/agent/tasks/:id/operations/:operationId/execute', async (req, res) => {
    const input = z.object({ confirm: z.literal(true), approval_id: z.uuid() }).strict().parse(req.body);
    res.json(await agent.executeOperation(idSchema.parse(req.params.id), idSchema.parse(req.params.operationId), input.approval_id));
  });
  app.post('/api/agent/tasks/:id/operations/:operationId/resolve', async (req, res) => {
    const input = z.object({ confirm: z.literal(true), approval_id: z.uuid() }).strict().parse(req.body);
    res.json(await agent.resolveOperation(idSchema.parse(req.params.id), idSchema.parse(req.params.operationId), input.approval_id));
  });
  app.post('/api/agent/tasks/:id/changes/:changeId/approval', async (req, res) => {
    const input = z.object({ confirm: z.literal(true), artifact_id: z.string().regex(/^[a-f0-9]{64}$/),
      transport_task: z.string().regex(/^[A-Za-z0-9]+$/).max(30).optional() }).strict().parse(req.body);
    res.json(await agent.approveChange(idSchema.parse(req.params.id), idSchema.parse(req.params.changeId), input.artifact_id, input.transport_task));
  });
  app.delete('/api/agent/tasks/:id/changes/:changeId/approval', async (req, res) => {
    const input = z.object({ confirm: z.literal(true), approval_id: z.uuid() }).strict().parse(req.body);
    res.json(await agent.revokeChangeApproval(idSchema.parse(req.params.id), idSchema.parse(req.params.changeId), input.approval_id));
  });
  app.post('/api/agent/tasks/:id/changes/:changeId/execute', async (req, res) => {
    const input = z.object({ confirm: z.literal(true), approval_id: z.uuid() }).strict().parse(req.body);
    res.json(await agent.executeChange(idSchema.parse(req.params.id), idSchema.parse(req.params.changeId), input.approval_id));
  });
  app.post('/api/agent/tasks/:id/changes/:changeId/resolve', async (req, res) => {
    const input = z.object({ confirm: z.literal(true), approval_id: z.uuid() }).strict().parse(req.body);
    res.json(await agent.resolveChangeApproval(idSchema.parse(req.params.id), idSchema.parse(req.params.changeId), input.approval_id));
  });
  app.post('/api/agent/tasks/:id/changes/:changeId/verify', async (req, res) => {
    z.object({}).strict().parse(req.body);
    res.json(await agent.verifyChangeBaseline(idSchema.parse(req.params.id), idSchema.parse(req.params.changeId)));
  });
  app.post('/api/agent/tasks/:id/changes/:changeId/review', async (req, res) => {
    const input = z.object({ confirm: z.literal(true), artifact_id: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(req.body);
    res.json(await agent.reviewChange(idSchema.parse(req.params.id), idSchema.parse(req.params.changeId), input.artifact_id));
  });
  app.delete('/api/agent/tasks/:id/changes/:changeId/review', async (req, res) => {
    const input = z.object({ confirm: z.literal(true), review_id: z.uuid() }).strict().parse(req.body);
    res.json(await agent.revokeChangeReview(idSchema.parse(req.params.id), idSchema.parse(req.params.changeId), input.review_id));
  });
  app.get('/api/agent/tasks/:id/reports',async(req,res)=>res.json(await agent.tasks.reportList(idSchema.parse(req.params.id))));
  app.get('/api/agent/tasks/:id/report',async(req,res)=>res.json(await agent.tasks.report(idSchema.parse(req.params.id),reportIdSchema.optional().parse(req.query.report_id))));
  app.patch('/api/agent/tasks/:id/reports/:reportId',async(req,res)=>{
    const input=z.object({title:z.string().trim().min(1).max(80),updated_at:z.iso.datetime(),artifact_id:z.union([z.string().regex(/^[a-f0-9]{64}$/),z.literal('legacy')])}).strict().parse(req.body);
    res.json(await agent.manageReport(idSchema.parse(req.params.id),reportIdSchema.parse(req.params.reportId),input,input.title));
  });
  app.delete('/api/agent/tasks/:id/reports/:reportId',async(req,res)=>{
    const input=z.object({confirm:z.literal(true),updated_at:z.iso.datetime(),artifact_id:z.union([z.string().regex(/^[a-f0-9]{64}$/),z.literal('legacy')])}).strict().parse(req.body);
    res.json(await agent.manageReport(idSchema.parse(req.params.id),reportIdSchema.parse(req.params.reportId),input));
  });
  app.patch('/api/agent/tasks/:id',async(req,res)=>{
    const input=z.object({title:z.string().trim().min(1).max(80).optional(),pinned:z.boolean().optional()}).strict()
      .refine(value=>value.title!==undefined||value.pinned!==undefined).parse(req.body);
    res.json(taskView(await agent.edit(idSchema.parse(req.params.id),input)));
  });
  app.delete('/api/agent/tasks/:id',async(req,res)=>{
    const input=z.object({confirm:z.literal(true),updated_at:z.iso.datetime()}).strict().parse(req.body);
    res.json(await agent.remove(idSchema.parse(req.params.id),input.updated_at));
  });
  app.get('/api/agent/tasks/:id/export',async(req,res)=>{
    const id=idSchema.parse(req.params.id);res.type('text/markdown').attachment(`saplink-chat-${id}.md`).send(await agent.exportConversation(id));
  });
  let streamCount=0;
  app.get('/api/agent/tasks/:id/stream',async(req,res)=>{
    const id=idSchema.parse(req.params.id);await agent.tasks.get(id);
    if(streamCount>=20){res.status(429).json({error:{message:'实时连接过多，请关闭重复页面。'}});return;}
    streamCount++;res.set({'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive'});res.flushHeaders();
    let last=-1,ended=false,blocked=false,writeAt=Date.now();
    const close=()=>{if(ended)return;ended=true;clearInterval(timer);streamCount--;};
    const tick=()=>{
      if(ended)return;
      const snapshot=agent.liveSnapshot(id);
      if(blocked){if(snapshot.finished||Date.now()-writeAt>10000)res.destroy();return;}
      if(snapshot.revision!==last){
        last=snapshot.revision;writeAt=Date.now();blocked=!res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
      }else if(Date.now()-writeAt>=10000){
        writeAt=Date.now();blocked=!res.write(': heartbeat\n\n');
      }
      if(snapshot.finished){res.end();close();}
    };
    const timer=setInterval(tick,100);
    res.on('drain',()=>{blocked=false;});res.on('close',close);res.on('error',close);tick();
  });
  app.get('/api/agent/tasks/:id/conversation', async (req,res) => {
    const before = z.union([z.string().regex(/^[a-f0-9]{64}$/),z.literal('initial')]).optional().parse(req.query.before);
    res.json(await agent.tasks.conversation(idSchema.parse(req.params.id),before));
  });
  app.get('/api/agent/tasks/:id/tool-results/:sequence', async (req, res) => {
    const sequence = z.coerce.number().int().positive().parse(req.params.sequence);
    const offset = z.coerce.number().int().min(0).max(64 * 1024 * 1024).default(0).parse(req.query.offset);
    res.set('Cache-Control', 'no-store');
    res.json(await agent.tasks.toolResult(idSchema.parse(req.params.id), sequence, offset));
  });
  app.post('/api/agent/tasks/:id/messages', async (req,res) => {
    const input = z.object({ prompt: z.string().trim().min(1).max(4000),output_mode:z.enum(['chat','report']).default('chat'),report_id:reportIdSchema.optional(),selected_report_id:reportIdSchema.optional(),attachments: uploadsInput,references:extensionRefsInput.optional(),write_mode:z.enum(['controlled','unrestricted']).optional() }).strict().parse(req.body);
    res.status(202).json(taskView(await agent.followUp(idSchema.parse(req.params.id),input.prompt,input.output_mode,input.report_id,input.selected_report_id,input.attachments,input.write_mode,input.references)));
  });
  app.post('/api/agent/tasks/:id/steer', (req,res) => {
    const {prompt} = z.object({prompt:z.string().trim().min(1).max(4000)}).strict().parse(req.body);
    res.status(202).json(agent.steer(idSchema.parse(req.params.id),prompt));
  });
  app.post('/api/agent/tasks/:id/question-answer', async (req,res) => {
    res.status(202).json(taskView(await agent.answerQuestions(idSchema.parse(req.params.id),questionReplyInput.parse(req.body))));
  });
  app.post('/api/agent/tasks/:id/stop', async (req, res) => res.json(taskView(await agent.stop(idSchema.parse(req.params.id)))));
  app.post('/api/agent/tasks/:id/compact', async (req, res) => {
    z.object({ confirm: z.literal(true) }).strict().parse(req.body);
    const task = await agent.compact(idSchema.parse(req.params.id));
    res.json({...taskView(task), context_estimated_tokens:estimateTaskContext(task)});
  });
  app.post('/api/agent/tasks/:id/resume', async (req, res) => {
    z.object({ allow_model_data: z.literal(true).default(true) }).strict().parse(req.body ?? {});
    res.status(202).json(taskView(await agent.resume(idSchema.parse(req.params.id))));
  });
}
