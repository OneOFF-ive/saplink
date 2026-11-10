import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ConfigStore, connectionSchema, normalizeUrl, writePolicy, digest, type Credentials } from '../src/config.js';
import { AuditLog } from '../src/audit.js';
import { adtUri, sameSavedSource, sourceResult, type Backend, type Version } from '../src/adt.js';
import { Operations, type Input } from '../src/operations.js';
import { AppError } from '../src/errors.js';
import { writeTools } from '../src/tool-policy.js';
import { AdtErrorException } from 'abap-adt-api';
import { startHttp } from '../src/server.js';
import { parseControlledOperation, WriteApprovalStore } from '../src/write-approval.js';
import { targetFingerprint } from '../src/connection-identity.js';
import { reserveCliWrite, runSapOperation, validateSapInput } from '../src/sap-cli.js';
import { startAdmin } from '../src/admin.js';
import type { Message } from '../src/agent/model.js';
import { ApprovalService } from '../src/approval-service.js';
import { WorkflowReview } from '../src/workflow-review.js';
import { WorkflowExecution } from '../src/workflow-execution.js';
import { toolSchemas } from '../src/tool-definitions.js';
import { AgentRuntime } from '../src/agent/runtime.js';
import { ClientDrafts } from '../src/agent/client-drafts.js';
import { createOperationProposal } from '../src/agent/operation-proposal.js';
import { mergeDraftSources } from '../src/agent/draft-merge.js';

const object = '/sap/bc/adt/programs/programs/ztest';
const source = `${object}/source/main`;
const credentials: Credentials = { get: async () => 'fake', set: async () => {}, remove: async () => {} };

test('draft merge preserves insertion coordinates and refuses different insertions at the same point', () => {
  const base = 'A\r\nB\r\nC\r\nD\r\n';
  assert.equal(mergeDraftSources(base,'FIRST\r\nA\r\nB\r\nC\r\nD\r\n',
    'A\r\nB\r\nTHIRD\r\nC\r\nD\r\nLAST\r\n'),
  'FIRST\r\nA\r\nB\r\nTHIRD\r\nC\r\nD\r\nLAST\r\n');
  assert.equal(mergeDraftSources(base,'A\r\nB\r\nX\r\nC\r\nD\r\n',
    'A\r\nB\r\nY\r\nC\r\nD\r\n'),undefined);
});
test('save comparison ignores blank lines but preserves nonblank content and literal data', () => {
  assert.equal(sameSavedSource('REPORT ztest.\r\n', 'REPORT ztest.'), true);
  assert.equal(sameSavedSource('REPORT ztest.\n\n', 'REPORT ztest.\r\n'), true);
  assert.equal(sameSavedSource('REPORT ztest. ', 'REPORT ztest.'), false);
  assert.equal(sameSavedSource('REPORT ztest.\n* comment', 'REPORT ztest.* comment'), false);
  assert.equal(sameSavedSource('WRITE 1.', 'WRITE 2.'), false);
  assert.equal(sameSavedSource('\nREPORT ztest.\n\t \nWRITE 1.\n', 'REPORT ztest.\r\nWRITE 1.'), true);
  assert.equal(sameSavedSource('WRITE 1.\nWRITE 2.', 'WRITE 2.\nWRITE 1.'), false);
  assert.equal(sameSavedSource('  WRITE 1.', 'WRITE 1.'), false);
  assert.equal(sameSavedSource('* comment\nWRITE 1.', 'WRITE 1.'), false);
  assert.equal(sameSavedSource('DATA(text) = |first\n\nlast|.', 'DATA(text) = |first\nlast|.'), false);
  assert.equal(sameSavedSource('WRITE |a\\|b|.\n\nWRITE 1.', 'WRITE |a\\|b|.\nWRITE 1.'), true);
  assert.equal(sameSavedSource('" ignored quote |\n\nWRITE 1.', '" ignored quote |\nWRITE 1.'), true);
  assert.notEqual(sourceResult('id', object, source, 'WRITE 1.\n\n', 'active').revision,
    sourceResult('id', object, source, 'WRITE 1.', 'active').revision);
});
class FakeBackend implements Backend {
  quality?: Backend['quality'];
  createDdic?: Backend['createDdic'];
  active = 'REPORT ztest.'; inactive: string | undefined;
  saves = 0; locks = 0; unlocks = 0; failUnlock = false; uncertain = false; activationPass = true;
  constructor(private connection: string) {}
  async capabilities() { return { available: true }; }
  async search() { return { objects: [{ object_uri: object }] }; }
  async listPackage() { return { objects: [] }; }
  async read(uri: string, version: Version) {
    const code = version === 'active' ? this.active : this.inactive;
    if (code === undefined) throw new AppError('VERSION_UNAVAILABLE', 'No inactive source');
    return sourceResult(this.connection, uri, `${uri}/source/main`, code, version);
  }
  async packageOf() { return '$TMP'; }
  async transportRequirement(): Promise<'required' | 'not_required'> { return 'required'; }
  async lock() { this.locks++; return 'private-lock-handle'; }
  async unlock() { this.unlocks++; if (this.failUnlock) throw new Error('Unlock failed'); }
  async save(_uri: string, code: string) { this.saves++; this.inactive = code;
    if (this.uncertain) throw new AppError('OUTCOME_UNKNOWN', 'Connection was interrupted'); }
  async create() { this.inactive = this.active; return object; }
  async check() { return { passed: true }; }
  async activate() { if (this.activationPass) { this.active = this.inactive!; this.inactive = undefined; }
    return { success: this.activationPass, messages: [] }; }
  async activateBatch(_objects: unknown[], onDispatch?: () => void | Promise<void>) { await onDispatch?.(); return this.activate(); }
  async transports() { return []; }
  async close() {}
}
async function fixture() {
  const root = join(process.cwd(), '.saplink', 'tests');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'test-'));
  const store = new ConfigStore(directory);
  const connection = connectionSchema.parse({ connection_id: randomUUID(), name: 'dev', base_url: 'http://sap.test:8000',
    client: '001', username: 'TEST', language: 'EN', write_enabled: true });
  await store.save({ schema_version: 1, connections: [connection], tokens: [] });
  const backend = new FakeBackend(connection.connection_id);
  const logDirectory = join(directory, 'logs');
  const operations = new Operations(store, credentials, new AuditLog(logDirectory), () => backend);
  return { directory, store, connection, backend, operations, logDirectory,
    cleanup: async () => { await operations.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('Dictionary creation saves under lock, uses the reviewed DDL, and activates separately', async () => {
  const f = await fixture();
  const runtime = new AgentRuntime(f.store,{model:async()=>({message:{role:'assistant',content:'就绪'}}),credentials,factory:()=>f.backend});
  const name='ZTEST_TABLE', uri='/sap/bc/adt/ddic/structures/ztest_table';
  const definition="@AbapCatalog.tableCategory : #TRANSPARENT\ndefine table ztest_table { key id : abap.int4 not null; }";
  let creates=0;
  f.backend.createDdic=async(kind,objectName,_description,_package,_task,dispatch)=>{
    assert.equal(kind,'table');assert.equal(objectName,name);dispatch();creates++;
    f.backend.inactive='define table ztest_table { }';return uri;
  };
  try {
    const task=await runtime.create('新建测试表',f.connection.connection_id,'chat');
    for(let attempt=0;attempt<100&&(await runtime.tasks.get(task.id)).status!=='completed';attempt++)
      await new Promise(resolve=>setTimeout(resolve,10));
    const savedTask=await runtime.tasks.get(task.id);
    assert.equal(savedTask.status,'completed');
    await createOperationProposal(savedTask,runtime.tasks,{tool:'create_ddic_object',input:{
      ddic_kind:'table',name,description:'Test',package_name:'$TMP',source:definition
    }},text=>text);
    const plan=await runtime.draftPlan(task.id);
    assert.equal(plan.items.length,1);assert.equal(creates,0);
    await runtime.actOnDraftPlan(task.id,'save',plan.token);
    const done=await runtime.tasks.get(task.id),draft=done.drafts![0];
    assert.equal(draft.state,'saved');assert.equal(draft.saved_source?.object_uri,uri);
    assert.equal(f.backend.inactive,definition);assert.equal(f.backend.saves,1);
    assert.equal(creates,1);assert.notEqual(f.backend.active,definition);
    const proposal=done.operation_proposals![0];
    const activated=await runtime.activateDraft(task.id,'operation',proposal.id,proposal.artifact_id,false);
    assert.equal(activated.activation,'completed');assert.equal(f.backend.active,definition);
  } finally { await runtime.close();await f.cleanup(); }
});

test('Dictionary creation blocks a mismatched definition and does not replay an uncertain save',async()=>{
  const f=await fixture();
  let creates=0;
  f.backend.createDdic=async(_kind,_name,_description,_package,_task,dispatch)=>{
    dispatch();creates++;f.backend.inactive='define structure zexample { }';return '/sap/bc/adt/ddic/structures/zexample';
  };
  const args={connection_id:f.connection.connection_id,ddic_kind:'structure' as const,name:'ZEXAMPLE',description:'Test',
    package_name:'$TMP',source:'define structure zexample { field : abap.int4; }',request_id:randomUUID()};
  try{
    const invalid=await f.operations.run('create_ddic_object',{...args,source:'define structure zother { field : abap.int4; }'});
    assert.equal(invalid.error?.code,'INVALID_INPUT');assert.equal(creates,0);
    const standard=await f.operations.run('activate_objects',{connection_id:args.connection_id,request_id:randomUUID(),
      objects:[{object_uri:'/sap/bc/adt/ddic/tables/mara',expected_revision:'a'.repeat(64)}]});
    assert.equal(standard.error?.code,'CAPABILITY_UNSUPPORTED');assert.equal(f.backend.locks,0);
    f.backend.uncertain=true;
    const input={...args,request_id:randomUUID()};
    const result=await f.operations.run('create_ddic_object',input);
    assert.equal(result.write_dispatched,true);assert.equal(result.outcome,'unknown');
    assert.equal(result.source_save?.saved,'unknown');assert.equal((result.error?.details as {created?:boolean})?.created,true);
    assert.equal((await f.operations.run('create_ddic_object',input)).operation_id,result.operation_id);
    assert.equal(creates,1);assert.equal(f.backend.saves,1);
  }finally{await f.cleanup();}
});

test('Dictionary updates enforce the original kind, name and revision before saving',async()=>{
  const f=await fixture();
  const uri='/sap/bc/adt/ddic/tables/zexample';
  const code='define table zexample { key id : abap.int4 not null; }';
  const proposed=code.replace('not null;','not null; extra : abap.int4;');
  try {
    f.backend.active=code;
    const base=await f.backend.read(uri,'active');
    const input={connection_id:f.connection.connection_id,object_uri:uri,source_uri:base.source_uri,
      expected_revision:base.revision,version:'active' as const};
    for(const source of [proposed.replace('zexample','zother'),proposed.replace('define table','define structure')]){
      const result=await f.operations.run('update_source',{...input,source,request_id:randomUUID()});
      assert.equal(result.error?.code,'INVALID_INPUT');assert.equal(result.write_dispatched,false);
    }
    f.backend.inactive=code.replace('abap.int4','abap.int8');
    const conflict=await f.operations.run('update_source',{...input,source:proposed,request_id:randomUUID()});
    assert.equal(conflict.error?.code,'VERSION_CONFLICT');assert.equal(f.backend.saves,0);
    const draft=await f.backend.read(uri,'inactive');
    const saved=await f.operations.run('update_source',{...input,source:proposed,version:'inactive',
      expected_revision:draft.revision,request_id:randomUUID()});
    assert.equal(saved.source_save?.verification,'passed');
    assert.equal(f.backend.active,code);assert.equal(f.backend.inactive,proposed);
  }finally{await f.cleanup();}
});

test('Dictionary change drafts show the reviewed diff, save inactive DDL, and verify activation',async()=>{
  const f=await workflowApiFixture();
  const runtime=new AgentRuntime(f.store,{credentials,factory:()=>f.backend});
  const uri='/sap/bc/adt/ddic/structures/zexample';
  const code='define structure zexample {\n  id : abap.int4;\n}';
  const edited=code.replace('  id : abap.int4;','  id : abap.int4;\n  extra : abap.int4;');
  try{
    f.backend.active=code;f.backend.inactive=undefined;
    const task=await runtime.tasks.get(f.task.id);
    const data=await f.backend.read(uri,'active');
    const artifact_id=await runtime.tasks.artifacts.put(task.id,'result',JSON.stringify({status:'success',data}));
    task.source_reads=[{artifact_id,object_uri:uri,revision:data.revision,read_source:true,
      total_characters:data.source.length,ranges:[[0,data.source.length]]}];
    const drafts=new ClientDrafts(f.store,runtime.tasks,f.operations);
    const change=await drafts.publishChange(task,{source_artifact_id:artifact_id,summary:'增加字段',
      edits:[{old_text:'  id : abap.int4;',new_text:'  id : abap.int4;\n  extra : abap.int4;'}]},text=>text);
    const review=await runtime.draftDetail(task.id,'change',change.change_id);
    assert.equal(review.diff?.added_lines,1);assert.equal(f.backend.saves,0);
    const saved=await runtime.saveDraft(task.id,'change',change.change_id,change.artifact_id);
    assert.equal(saved.state,'saved');assert.equal(saved.saved_source?.version,'inactive');
    assert.equal(f.backend.active,code);assert.equal(f.backend.inactive,edited);
    const activated=await runtime.activateDraft(task.id,'change',change.change_id,change.artifact_id,false);
    assert.equal(activated.activation,'completed');assert.equal(f.backend.active,edited);
  }finally{await runtime.close();await f.cleanup();}
});

test('workflow review binds the target, complete source and ordered steps without writing', async () => {
  const f = await fixture();
  try {
    const connection = { ...f.connection, write_governance: 'approval_required' as const };
    await f.store.save({ schema_version: 1, connections: [connection], tokens: [] });
    const approvals = new ApprovalService(f.store, input => f.operations.run('read_source', input));
    const workflows = new WorkflowReview(approvals);
    const plan = { connection_id: connection.connection_id, plan_id: randomUUID(), action: 'create_program',
      name: 'ZTEST', description: 'test', package_name: '$TMP', source: 'REPORT ztest.\nWRITE 1.',
      syntax_check: true, activate: true };
    const review = await workflows.review(plan);
    assert.deepEqual(review.steps, ['create_program', 'update_source', 'syntax_check', 'activate_objects']);
    assert.equal(review.plan.source, plan.source);
    assert.equal(review.target.connection_id, connection.connection_id);
    assert.notEqual((await workflows.review({ ...plan, source: 'REPORT ztest.\nWRITE 2.' })).review_id, review.review_id);
    assert.notEqual((await workflows.review({ ...plan, activate: false })).review_id, review.review_id);
    await assert.rejects(() => workflows.review({ ...plan, activate: false, atc_variant: 'DEFAULT' }),
      (error: unknown) => error instanceof AppError && error.code === 'WORKFLOW_INVALID');
    assert.equal(f.backend.saves, 0);

    f.backend.inactive = 'REPORT ztest.';
    const baseline = await f.backend.read(object, 'inactive');
    const update = await workflows.review({ connection_id: connection.connection_id, plan_id: randomUUID(),
      action: 'update_source', object_uri: object, source_uri: source, version: 'inactive',
      expected_revision: baseline.revision, source: 'REPORT ztest.\nWRITE 1.', activate: false });
    assert.deepEqual(update.steps, ['update_source', 'syntax_check']);
    assert.ok(update.diff?.hunks.some(hunk => hunk.lines.some(line => line.text === 'WRITE 1.')));
    f.backend.inactive = 'REPORT ztest.\nWRITE 2.';
    await assert.rejects(() => workflows.review(update.plan),
      (error: unknown) => error instanceof AppError && error.code === 'APPROVAL_BASELINE_CHANGED');
    assert.equal(f.backend.saves, 0);
  } finally { await f.cleanup(); }
});

test('one reviewed workflow creates, saves, checks and activates once', async () => {
  const f = await fixture();
  try {
    const connection = { ...f.connection, write_governance: 'approval_required' as const };
    await f.store.save({ schema_version: 1, connections: [connection], tokens: [] });
    const workflows = new WorkflowExecution(f.store, f.operations);
    const plan = { connection_id: connection.connection_id, plan_id: randomUUID(), action: 'create_program',
      name: 'ZTEST', description: 'test', package_name: '$TMP', source: 'REPORT ztest.\nWRITE 1.', activate: true };
    const reviewed = await workflows.review(plan);
    await assert.rejects(() => workflows.execute({ ...plan, source: 'REPORT ztest.\nWRITE 2.' }, reviewed.review_id),
      (error: unknown) => error instanceof AppError && error.code === 'WORKFLOW_REVIEW_CHANGED');
    const result = await workflows.execute(plan, reviewed.review_id);
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.results.map(item => item.step),
      ['create_program', 'read_source', 'update_source', 'read_source', 'syntax_check', 'read_source', 'activate_objects']);
    assert.equal(f.backend.active, plan.source);
    assert.equal(f.backend.saves, 1);
    assert.equal((await workflows.status(connection.connection_id, plan.plan_id)).state, 'completed');
    await assert.rejects(() => workflows.execute(plan, reviewed.review_id),
      (error: unknown) => error instanceof AppError && error.code === 'WORKFLOW_ALREADY_STARTED');
    assert.equal(f.backend.saves, 1);
  } finally { await f.cleanup(); }
});

test('workflow stops on failed syntax and never activates or repeats the plan', async () => {
  const f = await fixture();
  try {
    const connection = { ...f.connection, write_governance: 'approval_required' as const };
    await f.store.save({ schema_version: 1, connections: [connection], tokens: [] });
    f.backend.inactive = 'REPORT ztest.';
    Object.assign(f.backend, { check: async () => ({ passed: false }) });
    const baseline = await f.backend.read(object, 'inactive');
    const workflows = new WorkflowExecution(f.store, f.operations);
    const plan = { connection_id: connection.connection_id, plan_id: randomUUID(), action: 'update_source',
      object_uri: object, source_uri: source, version: 'inactive', expected_revision: baseline.revision,
      source: 'REPORT ztest.\nWRITE 1.', activate: true };
    const reviewed = await workflows.review(plan);
    await assert.rejects(() => workflows.execute(plan, reviewed.review_id),
      (error: unknown) => error instanceof AppError && error.code === 'WORKFLOW_SYNTAX_FAILED');
    assert.equal(f.backend.active, 'REPORT ztest.');
    assert.equal(f.backend.inactive, plan.source);
    assert.equal((await workflows.status(connection.connection_id, plan.plan_id)).state, 'stopped');
    await assert.rejects(() => workflows.execute(plan, reviewed.review_id));
    assert.equal(f.backend.saves, 1);
  } finally { await f.cleanup(); }
});

test('workflow stops on an uncertain write and blocks subsequent controlled edits', async () => {
  const f = await fixture();
  try {
    const connection = { ...f.connection, write_governance: 'approval_required' as const };
    await f.store.save({ schema_version: 1, connections: [connection], tokens: [] });
    f.backend.inactive = 'REPORT ztest.';
    f.backend.uncertain = true;
    const baseline = await f.backend.read(object, 'inactive');
    const workflows = new WorkflowExecution(f.store, f.operations);
    const plan = { connection_id: connection.connection_id, plan_id: randomUUID(), action: 'update_source',
      object_uri: object, source_uri: source, version: 'inactive', expected_revision: baseline.revision,
      source: 'REPORT ztest.\nWRITE 1.', activate: true };
    const reviewed = await workflows.review(plan);
    await assert.rejects(() => workflows.execute(plan, reviewed.review_id), { code: 'WORKFLOW_STEP_FAILED' });
    assert.equal(f.backend.active, 'REPORT ztest.');
    assert.equal(f.backend.saves, 1);
    assert.equal((await workflows.status(connection.connection_id, plan.plan_id)).state, 'stopped');
    const current = await f.backend.read(object, 'inactive');
    const next = { ...plan, plan_id: randomUUID(), expected_revision: current.revision, source: 'REPORT ztest.\nWRITE 2.' };
    const nextReview = await workflows.review(next);
    await assert.rejects(() => workflows.execute(next, nextReview.review_id), { code: 'APPROVAL_RECONCILIATION_REQUIRED' });
    assert.equal(f.backend.saves, 1);
  } finally { await f.cleanup(); }
});

test('workflow records ATC submission and never treats it as an ATC pass', async () => {
  const f = await fixture();
  try {
    const connection = { ...f.connection, write_governance: 'approval_required' as const };
    await f.store.save({ schema_version: 1, connections: [connection], tokens: [] });
    let runs = 0;
    Object.assign(f.backend, { quality: async (name: string) => {
      assert.equal(name, 'run_atc'); runs++; return { run_id: 'WL_1', submission: 'accepted' };
    } });
    const workflows = new WorkflowExecution(f.store, f.operations);
    const plan = { connection_id: connection.connection_id, plan_id: randomUUID(), action: 'create_program',
      name: 'ZTEST', description: 'test', package_name: '$TMP', source: 'REPORT ztest.\nWRITE 1.',
      activate: true, atc_variant: 'DEFAULT' };
    const review = await workflows.review(plan);
    const executed = await workflows.execute(plan, review.review_id);
    assert.equal(runs, 1);
    assert.deepEqual(executed.results.at(-1)?.result.data, { run_id: 'WL_1', submission: 'accepted' });
    const status = await workflows.status(connection.connection_id, plan.plan_id);
    assert.ok(JSON.stringify(status.events).includes('WL_1'));
    assert.equal(JSON.stringify(status.events).includes(plan.source), false);
  } finally { await f.cleanup(); }
});


test('agent workflow proposal stays read-only until one authenticated confirmation', async () => {
  const f = await fixture();
  const connection = { ...f.connection, write_governance: 'approval_required' as const };
  await f.store.save({ schema_version: 1, connections: [connection], tokens: [] });
  let round = 0;
  const model = async () => {
    const tool = (name: string, args: object) => ({ message: { role: 'assistant' as const, content: null,
      tool_calls: [{ id: randomUUID(), type: 'function' as const, function: { name, arguments: JSON.stringify(args) } }] } });
    if (++round === 1) return tool('get_capabilities', {});
    if (round === 2) return tool('propose_program_workflow', { action: 'create_program', name: 'ZTEST',
      description: 'test', package_name: '$TMP', source: 'REPORT ztest.\nWRITE 1.', activate: true });
    return { message: { role: 'assistant' as const, content: '计划已生成。' } };
  };
  const host = await startAdmin(f.store, credentials, 0, () => f.backend, undefined, { agent: {
    model, execute: async () => ({ status: 'success', data: {} }), audit: new AuditLog(f.logDirectory)
  } });
  const url = new URL(host.url), origin = url.origin;
  const headers = { 'X-Admin-Token': url.hash.slice(1), Origin: origin, 'Content-Type': 'application/json' };
  const post = (path: string, body: unknown) => fetch(`${origin}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  try {
    const created = await (await post('/api/agent/tasks', { prompt: '创建程序并激活', connection_id: connection.connection_id,
      output_mode: 'chat' })).json();
    let task;
    for (let i = 0; i < 500; i++) {
      task = await (await fetch(`${origin}/api/agent/tasks/${created.id}`, { headers })).json();
      if (!['queued', 'running'].includes(task.status)) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(task.status, 'completed', JSON.stringify(task.error));
    assert.equal(f.backend.saves, 0);
    const base = `/api/agent/tasks/${created.id}/workflows/${task.workflow_proposals[0].id}`;
    const detail = await (await fetch(`${origin}${base}`, { headers })).json();
    assert.equal(detail.review.plan.source, 'REPORT ztest.\nWRITE 1.');
    assert.deepEqual(detail.review.steps, ['create_program', 'update_source', 'syntax_check', 'activate_objects']);
    assert.equal((await post(`${base}/execute`, { confirm: false, review_id: detail.review.review_id })).status, 400);
    assert.equal(f.backend.saves, 0);
    const response = await post(`${base}/execute`, { confirm: true, review_id: detail.review.review_id });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, 'completed');
    assert.equal(f.backend.active, detail.review.plan.source);
    const after = await (await fetch(`${origin}${base}`, { headers })).json();
    assert.equal(after.execution.state, 'completed');
    assert.equal((await post(`${base}/execute`, { confirm: true, review_id: detail.review.review_id })).status, 400);
    assert.equal(f.backend.saves, 1);
  } finally { await host.close(); await f.cleanup(); }
});

async function workflowApiFixture(mode: 'controlled' | 'unrestricted' = 'controlled', configure?: (backend: FakeBackend) => void, expected = 'completed') {
  const f = await fixture();
  configure?.(f.backend);
  await f.store.save({ schema_version: 1, connections: [{ ...f.connection, write_governance: 'approval_required' }], tokens: [] });
  let round = 0;
  const host = await startAdmin(f.store, credentials, 0, () => f.backend, undefined, { agent: {
    model: async () => {
      const tool = (name: string, args: object) => ({ message: { role: 'assistant' as const, content: null,
        tool_calls: [{ id: randomUUID(), type: 'function' as const, function: { name, arguments: JSON.stringify(args) } }] } });
      if (++round === 1) return tool('get_capabilities', {});
      if (round === 2) return tool('propose_program_workflow', { action: 'create_program', name: 'ZTEST',
        description: 'test', package_name: '$TMP', source: 'REPORT ztest.\nWRITE 1.', activate: true });
      return { message: { role: 'assistant' as const, content: '已生成计划' } };
    }, execute: async () => ({ status: 'success', data: {} }), audit: new AuditLog(f.logDirectory)
  } });
  const url = new URL(host.url), origin = url.origin;
  const headers = { 'X-Admin-Token': url.hash.slice(1), Origin: origin, 'Content-Type': 'application/json' };
  const post = (path: string, body: unknown) => fetch(origin + path, { method: 'POST', headers, body: JSON.stringify(body) });
  const get = async (path: string) => { const response = await fetch(origin + path, { headers });
    assert.equal(response.status, 200); return response.json(); };
  try {
    const created = await (await post('/api/agent/tasks', { prompt: '创建程序并激活', connection_id: f.connection.connection_id,
      output_mode: 'chat', write_mode: mode })).json();
    let task;
    for (let i = 0; i < 500; i++) {
      task = await get(`/api/agent/tasks/${created.id}`);
      if (!['queued', 'running'].includes(task.status)) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(task.status, expected, JSON.stringify(task.error));
    const base = `/api/agent/tasks/${created.id}/workflows/${task.workflow_proposals[0].id}`;
    const detail = await get(base);
    return { ...f, base, origin, headers, get, post, detail, task, cleanup: async () => { await host.close(); await f.cleanup(); } };
  } catch (error) { await host.close(); await f.cleanup(); throw error; }
}

test('unified Save reviews once, saves without activating, and activates only after the second choice', async () => {
  const f = await workflowApiFixture();
  try {
    const proposal = f.task.workflow_proposals[0];
    const base = `/api/agent/tasks/${f.task.id}/drafts/workflow/${proposal.id}`;
    const body = {confirm:true,artifact_id:proposal.artifact_id};
    const savedResponse = await f.post(base+'/save',body);
    const saved = await savedResponse.json();
    assert.equal(savedResponse.status,200,JSON.stringify(saved));
    assert.equal(saved.state,'saved',JSON.stringify(saved));
    assert.equal(f.backend.saves,1);
    assert.equal(f.backend.active,'REPORT ztest.');
    assert.equal(f.backend.inactive,'REPORT ztest.\nWRITE 1.');
    assert.equal((await f.post(base+'/save',body)).status,400);
    assert.equal(f.backend.saves,1);
    const activated = await (await f.post(base+'/activate',{...body,atc:false})).json();
    assert.equal(activated.activation,'completed',JSON.stringify(activated));
    assert.equal(f.backend.active,'REPORT ztest.\nWRITE 1.');
    assert.equal((await f.post(base+'/activate',{...body,atc:false})).status,400);
  } finally { await f.cleanup(); }
});

test('session source drafts merge across proposal types, isolate conflicts and preserve saved history', async () => {
  const f = await workflowApiFixture();
  const runtime = new AgentRuntime(f.store, {credentials, factory:() => f.backend});
  try {
    const task = await runtime.tasks.get(f.task.id);
    const drafts = new ClientDrafts(f.store, runtime.tasks, f.operations);
    const uri = '/sap/bc/adt/programs/programs/zmerge';
    f.backend.active = 'REPORT zmerge.\nWRITE 1.\nWRITE 2.\nWRITE 3.';
    const record = async (version:Version) => {
      const data = await f.backend.read(uri, version);
      const artifact_id = await runtime.tasks.artifacts.put(task.id, 'result', JSON.stringify({status:'success', data}));
      task.source_reads = [...(task.source_reads ?? []), {artifact_id, object_uri:uri, revision:data.revision,
        read_source:true, total_characters:data.source.length, ranges:[[0,data.source.length]]}];
      return {data, artifact_id};
    };
    const original = await record('active');
    const change = (old_text:string,new_text:string) => drafts.publishChange(task, {
      source_artifact_id:original.artifact_id, summary:'修改输出', edits:[{old_text,new_text}]
    }, text=>text);
    const workflow = (replacement:string, resolves_drafts?:string[]) => drafts.publishWorkflow(task, {
      action:'update_source', object_uri:uri, source_uri:original.data.source_uri, version:'active',
      expected_revision:original.data.revision, source:replacement, syntax_check:false, activate:false, resolves_drafts
    }, text=>text);
    const first = await change('WRITE 1.', 'WRITE 10.');
    const second = await workflow(original.data.source.replace('WRITE 3.', 'WRITE 30.'));
    assert.equal(second.review_required,true);
    const old = await drafts.detail(task,'change',first.change_id);
    assert.equal(old.diff?.context_lines,8);
    assert.equal(old.draft?.state,'superseded');
    assert.equal(old.can_save,false);
    assert.equal(old.can_discard,false);
    await assert.rejects(runtime.saveDraft(task.id,'change',first.change_id,first.artifact_id),{code:'AGENT_DRAFT_USED'});
    const current = await drafts.detail(task,'workflow',second.workflow_id);
    assert.match((current.proposal as typeof f.detail).plan.source,/WRITE 10\.\nWRITE 2\.\nWRITE 30\./);
    assert.equal(current.diff?.added_lines,2);
    assert.equal(current.diff?.context_lines,8);
    await assert.rejects(change('WRITE 1.', 'WRITE 11.'),{code:'AGENT_DRAFT_CONFLICT'});
    assert.equal((await drafts.detail(task,'workflow',second.workflow_id)).draft?.state,'conflict');
    assert.equal((await drafts.detail(task,'workflow',f.task.workflow_proposals[0].id)).can_save,true);
    assert.equal(f.backend.saves,0);

    const resolved = await workflow('REPORT zmerge.\nWRITE 11.\nWRITE 2.\nWRITE 30.', [second.workflow_id]);
    assert.equal((await runtime.saveDraft(task.id,'workflow',resolved.workflow_id,resolved.artifact_id)).state,'saved');
    const currentTask = await runtime.tasks.get(task.id);
    Object.assign(task,currentTask);
    const saved = await record('inactive');
    const next = await drafts.publishChange(task,{source_artifact_id:saved.artifact_id,summary:'只改第二行输出',
      edits:[{old_text:'WRITE 2.',new_text:'WRITE 20.'}]},text=>text);
    assert.equal(next.review_required,false);
    assert.equal((await drafts.detail(task,'workflow',resolved.workflow_id)).draft?.state,'saved');
    assert.equal(next.added_lines,1);
    await runtime.discardDraft(task.id,'change',next.change_id,next.artifact_id);
    assert.equal(f.backend.saves,1);
    assert.equal(f.backend.inactive,'REPORT zmerge.\nWRITE 11.\nWRITE 2.\nWRITE 30.');
  } finally {
    await runtime.close();
    await f.cleanup();
  }
});

test('one modification plan preflights all objects and resumes after a partial save without replaying completed writes', async () => {
  const f = await workflowApiFixture();
  const runtime = new AgentRuntime(f.store, {credentials, factory:() => f.backend});
  try {
    const task = await runtime.tasks.get(f.task.id);
    const drafts = new ClientDrafts(f.store,runtime.tasks,f.operations);
    const existing = task.workflow_proposals![0];
    await runtime.discardDraft(task.id,'workflow',existing.id,existing.artifact_id);
    Object.assign(task,await runtime.tasks.get(task.id));
    const other = '/sap/bc/adt/programs/programs/zother';
    const active = new Map([[object,'REPORT ztest.'],[other,'REPORT zother.']]);
    const inactive = new Map<string,string>();
    const writes:string[] = [];
    f.backend.read = async (uri,version) => {
      const code = (version === 'active' ? active : inactive).get(uri);
      if (!code) throw new AppError('VERSION_UNAVAILABLE','No source');
      return sourceResult(f.connection.connection_id,uri,uri+'/source/main',code,version);
    };
    f.backend.save = async (uri,code) => {
      const target = uri.replace(/\/source\/main$/,'');
      assert.ok(Object.values(runtime.draftSaveProgress(task.id)).includes('saving'));
      writes.push(target);
      inactive.set(target,code);
    };
    for (const uri of [object,other]) {
      const data = await f.backend.read(uri,'active');
      const artifact_id = await runtime.tasks.artifacts.put(task.id,'result',JSON.stringify({status:'success',data}));
      task.source_reads = [...(task.source_reads ?? []),{artifact_id,object_uri:uri,revision:data.revision,
        read_source:true,total_characters:data.source.length,ranges:[[0,data.source.length]]}];
      await drafts.publishChange(task,{source_artifact_id:artifact_id,summary:'增加输出',
        edits:[{old_text:data.source,new_text:data.source+'\nWRITE 1.'}]},text=>text);
    }
    const base = '/api/agent/tasks/'+task.id+'/draft-plan';
    const initial = await f.get(base);
    assert.equal(initial.items.length,2);
    assert.equal(initial.can_save,true);
    const save = async (token:string) => {
      const response = await f.post(base+'/save',{confirm:true,token});
      const body = await response.json();
      assert.equal(response.status,200,JSON.stringify(body));
      return body;
    };
    active.set(other,'REPORT zother.\nWRITE 9.');
    const rejected = await save(initial.token);
    assert.equal(rejected.failure.key,initial.items[1].key);
    assert.deepEqual(writes,[]);
    // Run the partial-save path with a separate runtime without a configured model.
    active.set(other,'REPORT zother.');
    const lock = f.backend.lock.bind(f.backend);
    let blocked = true;
    f.backend.lock = async uri => {
      if (uri === other && blocked) throw new AppError('OBJECT_LOCKED','Object locked');
      return lock();
    };
    const current = await runtime.draftPlan(task.id);
    const partial = await runtime.actOnDraftPlan(task.id,'save',current.token);
    assert.ok('plan' in partial);
    assert.deepEqual(partial.plan.items.map(item=>item.state),['saved','failed']);
    const members = initial.items.map(item=>item.key);
    assert.deepEqual((await runtime.tasks.get(task.id)).draft_plan_history,[members]);
    assert.deepEqual(writes,[object]);
    await assert.rejects(runtime.actOnDraftPlan(task.id,'save',current.token),{code:'AGENT_PLAN_CHANGED'});
    blocked = false;
    const remaining = await runtime.draftPlan(task.id);
    assert.equal(remaining.can_save,true);
    const completed = await runtime.actOnDraftPlan(task.id,'save',remaining.token);
    assert.ok('plan' in completed);
    assert.deepEqual(completed.plan.items.map(item=>item.state),['saved','saved']);
    assert.deepEqual(runtime.draftSaveProgress(task.id),{});
    assert.deepEqual(writes,[object,other]);
    assert.deepEqual((await runtime.tasks.get(task.id)).draft_plan_history,[members]);
    assert.equal((await runtime.draftPlan(task.id)).items.length,0);
  } finally { await runtime.close(); await f.cleanup(); }
});

test('one modification plan creates a program and saves changes to a second object in order', async () => {
  const f = await workflowApiFixture();
  const runtime = new AgentRuntime(f.store,{credentials,factory:()=>f.backend});
  try {
    const task = await runtime.tasks.get(f.task.id);
    const other = '/sap/bc/adt/programs/programs/zexisting';
    const inactive = new Map<string,string>();
    const writes:string[] = [];
    f.backend.read = async (uri,version) => {
      const code = version === 'inactive' ? inactive.get(uri) : uri === other ? 'REPORT zexisting.' : undefined;
      if (!code) throw new AppError('OBJECT_NOT_FOUND','No source');
      return sourceResult(f.connection.connection_id,uri,uri+'/source/main',code,version);
    };
    f.backend.create = async () => {
      writes.push('create');
      inactive.set(object,'REPORT ztest.');
      return object;
    };
    f.backend.save = async (uri,code) => {
      writes.push(uri);
      inactive.set(uri.replace(/\/source\/main$/,''),code);
    };
    const data = await f.backend.read(other,'active');
    const artifact_id = await runtime.tasks.artifacts.put(task.id,'result',JSON.stringify({status:'success',data}));
    task.source_reads = [{artifact_id,object_uri:other,revision:data.revision,read_source:true,
      total_characters:data.source.length,ranges:[[0,data.source.length]]}];
    const drafts = new ClientDrafts(f.store,runtime.tasks,f.operations);
    await drafts.publishChange(task,{source_artifact_id:artifact_id,summary:'增加注释',
      edits:[{old_text:data.source,new_text:data.source+'\n* Modified.'}]},text=>text);
    const plan = await runtime.draftPlan(task.id);
    assert.equal(plan.items.length,2);
    const result = await runtime.actOnDraftPlan(task.id,'save',plan.token);
    assert.ok('plan' in result);
    assert.deepEqual(result.plan.items.map(item=>item.state),['saved','saved']);
    assert.deepEqual(writes,['create',source,other+'/source/main']);
    assert.equal(f.backend.active,'REPORT ztest.');
  } finally { await runtime.close(); await f.cleanup(); }
});

test('revising a pending program creation promotes its shell and writes only the final source once', async () => {
  const f = await workflowApiFixture();
  const runtime = new AgentRuntime(f.store,{credentials,factory:()=>f.backend});
  try {
    const original = f.task.workflow_proposals[0];
    await runtime.discardDraft(f.task.id,'workflow',original.id,original.artifact_id);
    const task = await runtime.tasks.get(f.task.id);
    const drafts = new ClientDrafts(f.store,runtime.tasks,f.operations);
    const shell = await createOperationProposal(task,runtime.tasks,{tool:'create_program',input:{
      name:'ZTEST',description:'test',package_name:'$TMP',program_kind:'report'
    }},text=>text);
    const base = {action:'create_program' as const,name:'ZTEST',description:'test',package_name:'$TMP',
      syntax_check:false,activate:false};
    const first = await drafts.publishWorkflow(task,{...base,source:'REPORT ztest.\nWRITE 1.'},text=>text);
    assert.equal(first.review_required,true);
    assert.equal((await drafts.detail(task,'operation',shell.operation_id)).draft?.replacement_id,first.workflow_id);
    const second = await drafts.publishWorkflow(task,{...base,source:'REPORT ztest.\nWRITE 1.\n* Note.'},text=>text);
    const final = await drafts.publishWorkflow(task,{...base,source:'REPORT ztest.\nWRITE 2.\n* Note.',
      revises_creation:second.artifact_id},text=>text);
    assert.equal(final.review_required,true);
    assert.equal((await runtime.draftPlan(task.id)).items.length,1);
    await assert.rejects(runtime.saveDraft(task.id,'workflow',second.workflow_id,second.artifact_id),{code:'AGENT_DRAFT_USED'});
    const create = f.backend.create.bind(f.backend);
    let creations = 0;
    f.backend.create = async () => {creations++;return create();};
    assert.equal((await runtime.saveDraft(task.id,'workflow',final.workflow_id,final.artifact_id)).state,'saved');
    assert.equal(creations,1);
    assert.equal(f.backend.saves,1);
    assert.equal(f.backend.inactive,'REPORT ztest.\nWRITE 2.\n* Note.');
    assert.equal(f.backend.active,'REPORT ztest.');
  } finally { await runtime.close(); await f.cleanup(); }
});

test('modification history shows a confirmed creation separately when saving its source fails', async () => {
  const f = await workflowApiFixture();
  const runtime = new AgentRuntime(f.store,{credentials,factory:()=>f.backend});
  try {
    const lock = f.backend.lock.bind(f.backend);
    const create = f.backend.create.bind(f.backend);
    let creations = 0;
    f.backend.create = async () => {creations++;return create();};
    f.backend.lock = async () => {throw new AppError('OBJECT_LOCKED','Object locked');};
    const proposal = f.task.workflow_proposals[0];
    const result = await runtime.saveDraft(f.task.id,'workflow',proposal.id,proposal.artifact_id);
    assert.equal(result.state,'failed');
    assert.equal(result.created_program?.object_uri,object);
    assert.equal(f.backend.saves,0);
    assert.equal(f.backend.inactive,'REPORT ztest.');
    const path = '/api/agent/tasks/'+f.task.id+'/draft-creation-history';
    const receipt = {...result.created_program,draft_key:'workflow:' + proposal.id};
    assert.deepEqual(await f.get(path),[receipt]);
    const oldTask = await runtime.tasks.get(f.task.id);
    delete oldTask.drafts![0].created_program;
    await runtime.tasks.save(oldTask);
    assert.deepEqual(await f.get(path),[receipt]);
    assert.equal((await runtime.draftDetail(f.task.id,'workflow',proposal.id)).can_resume,true);
    f.backend.lock = lock;
    f.backend.inactive = 'REPORT ztest.\n* Someone else edited this.';
    await assert.rejects(runtime.saveDraft(f.task.id,'workflow',proposal.id,proposal.artifact_id),{code:'AGENT_CHANGE_STALE'});
    assert.equal(f.backend.saves,0);
    f.backend.inactive = 'REPORT ztest.';
    const resumed = await runtime.saveDraft(f.task.id,'workflow',proposal.id,proposal.artifact_id);
    assert.equal(resumed.state,'saved',JSON.stringify(resumed));
    assert.equal(resumed.created_program?.object_uri,object);
    assert.equal(creations,1);
    assert.equal(f.backend.saves,1);
  } finally { await runtime.close(); await f.cleanup(); }
});

test('only a definitively unsent transient source save retries once and rereads the unchanged baseline', async () => {
  const f=await fixture();
  try {
    const originalLock=f.backend.lock.bind(f.backend);let attempts=0;
    f.backend.lock=async()=>{if(++attempts===1)throw new AppError('CONNECTION_FAILED','temporary connection failure');return originalLock();};
    const baseline=await f.backend.read(object,'active');
    const plan={action:'update_source',connection_id:f.connection.connection_id,plan_id:randomUUID(),
      object_uri:object,source_uri:baseline.source_uri,version:'active',expected_revision:baseline.revision,
      source:'REPORT ztest.\nWRITE 4.',syntax_check:false,activate:false};
    const workflow=new WorkflowExecution(f.store,f.operations,undefined,true);
    const review=await workflow.review(plan);
    const saved=await workflow.execute(plan,review.review_id);
    assert.equal(saved.status,'completed');assert.equal(f.backend.saves,1);assert.equal(attempts,2);
    const journal=await workflow.status(f.connection.connection_id,plan.plan_id);
    assert.equal(journal.events.filter(e=>e.retry===true).length,1);
  }finally{await f.cleanup();}
});

test('save retry stops after one attempt and refuses a changed baseline', async () => {
  for(const change of [false,true]) {
    const f=await fixture();
    try {
      let attempts=0;
      f.backend.lock=async()=>{attempts++;if(change)f.backend.active='REPORT ztest.\nWRITE 9.';throw new AppError('CONNECTION_FAILED','temporary connection failure');};
      const baseline=await f.backend.read(object,'active');
      const plan={action:'update_source',connection_id:f.connection.connection_id,plan_id:randomUUID(),
        object_uri:object,source_uri:baseline.source_uri,version:'active',expected_revision:baseline.revision,
        source:'REPORT ztest.\nWRITE 4.',syntax_check:false,activate:false};
      const workflow=new WorkflowExecution(f.store,f.operations,undefined,true);
      const review=await workflow.review(plan);
      await assert.rejects(workflow.execute(plan,review.review_id));
      assert.equal(attempts,change?1:2);assert.equal(f.backend.saves,0);
    }finally{await f.cleanup();}
  }
});

test('unified Save rejects changed artifacts, discards locally, and blocks the legacy execution route', async () => {
  const f = await workflowApiFixture();
  try {
    const proposal=f.task.workflow_proposals[0],base=`/api/agent/tasks/${f.task.id}/drafts/workflow/${proposal.id}`;
    assert.equal((await f.post(base+'/save',{confirm:true,artifact_id:'0'.repeat(64)})).status,400);
    const discarded=await (await f.post(base+'/discard',{confirm:true,artifact_id:proposal.artifact_id})).json();
    assert.equal(discarded.state,'discarded');
    assert.equal((await f.post(base+'/save',{confirm:true,artifact_id:proposal.artifact_id})).status,400);
    assert.equal((await f.post(f.base+'/execute',{confirm:true,review_id:f.detail.review.review_id})).status,400);
    assert.equal(f.backend.saves,0);
  } finally { await f.cleanup(); }
});

test('legacy completed workflows appear saved in the unified view without repeating or abandoning the SAP write',async()=>{
  const f=await workflowApiFixture('unrestricted');
  try{
    const p=f.task.workflow_proposals[0],base=`/api/agent/tasks/${f.task.id}/drafts/workflow/${p.id}`;
    const detail=await f.get(base);
    assert.equal(detail.draft.state,'saved');assert.equal(detail.draft.legacy,true);
    assert.equal(detail.can_save,false);assert.equal(detail.can_discard,false);assert.match(detail.draft.message,/已执行成功/);
    assert.equal((await f.get(`/api/agent/tasks/${f.task.id}`)).drafts[0].state,'saved');
    const body={confirm:true,artifact_id:p.artifact_id};
    assert.equal((await f.post(base+'/save',body)).status,400);assert.equal((await f.post(base+'/discard',body)).status,400);
    assert.equal(f.backend.saves,1);
  }finally{await f.cleanup();}
});

test('legacy baseline-only failures allow Save or Discard while incomplete write journals stay blocked',async()=>{
  for(const action of ['save','discard','unknown']){
    const f=await workflowApiFixture();
    try{
      const p=f.task.workflow_proposals[0],base=`/api/agent/tasks/${f.task.id}/drafts/workflow/${p.id}`;
      const artifact=JSON.parse((await readFile(join(f.directory,'agent','tasks',f.task.id,'artifacts',p.artifact_id+'.json'),'utf8'))).content;
      const plan=JSON.parse(artifact).plan;
      await mkdir(join(f.directory,'workflow-runs'),{recursive:true});
      const events=action==='unknown'?[{state:'started'},{state:'step_started',step:'update_source'}]
        :[{state:'started'},{state:'step_started',step:'read_source'},{state:'step_finished',step:'read_source',status:'error'},{state:'stopped',step:'read_source'}];
      await writeFile(join(f.directory,'workflow-runs',digest(`${f.connection.connection_id}:${plan.plan_id}`)+'.jsonl'),events.map(e=>JSON.stringify(e)).join('\n')+'\n');
      const detail=await f.get(base);assert.equal(detail.can_save,action!=='unknown');assert.equal(detail.can_discard,action!=='unknown');
      const body={confirm:true,artifact_id:p.artifact_id};
      if(action==='unknown'){
        assert.equal(detail.draft.state,'uncertain');assert.equal((await f.post(base+'/save',body)).status,400);assert.equal((await f.post(base+'/discard',body)).status,400);assert.equal(f.backend.saves,0);
      }else{
        const result=await (await f.post(base+'/'+action,body)).json();
        assert.equal(result.state,action==='save'?'saved':'discarded',JSON.stringify(result));assert.equal(f.backend.saves,action==='save'?1:0);
      }
    }finally{await f.cleanup();}
  }
});

test('activation refuses changed saved source and an unavailable ATC variant without changing SAP', async () => {
  const f = await workflowApiFixture();
  try {
    const proposal=f.task.workflow_proposals[0],base=`/api/agent/tasks/${f.task.id}/drafts/workflow/${proposal.id}`;
    const body={confirm:true,artifact_id:proposal.artifact_id};
    assert.equal((await (await f.post(base+'/save',body)).json()).state,'saved');
    assert.equal((await f.post(base+'/activate',{...body,atc:true})).status,400);
    f.backend.inactive='REPORT ztest.\nWRITE 2.';
    assert.equal((await f.post(base+'/activate',{...body,atc:false})).status,400);
    assert.equal(f.backend.active,'REPORT ztest.');
  } finally { await f.cleanup(); }
});

test('optional ATC uses the real default variant after activation and never claims a quality pass', async () => {
  const f=await workflowApiFixture();let atcRuns=0;
  f.backend.quality=async(tool,input)=>{
    if(tool==='get_atc_configuration')return {properties:[{name:'supportsExemptions',value:true},{name:'defaultCheckVariant',value:'REAL_VARIANT'}]};
    assert.equal(tool,'run_atc');assert.equal((input as {check_variant:string}).check_variant,'REAL_VARIANT');
    assert.equal(f.backend.active,'REPORT ztest.\nWRITE 1.');atcRuns++;return {run_id:'test-atc',status:'running'};
  };
  try {
    const p=f.task.workflow_proposals[0],base=`/api/agent/tasks/${f.task.id}/drafts/workflow/${p.id}`,body={confirm:true,artifact_id:p.artifact_id};
    assert.equal((await (await f.post(base+'/save',body)).json()).state,'saved');assert.equal(atcRuns,0);
    const result=await (await f.post(base+'/activate',{...body,atc:true})).json();
    assert.equal(result.activation,'completed',JSON.stringify(result));assert.equal(atcRuns,1);
    assert.match(result.message,/实际检查结果/);assert.doesNotMatch(result.message,/检查通过/);
  }finally{await f.cleanup();}
});

test('draft execution is exclusive across runtimes and a recovered saved draft is not resubmitted', async () => {
  const f=await workflowApiFixture();const other=new AgentRuntime(f.store,{credentials,factory:()=>f.backend});
  let release=()=>{},started=()=>{};
  const gate=new Promise<void>(r=>{release=r;}),saving=new Promise<void>(r=>{started=r;});
  const original=f.backend.save.bind(f.backend);
  f.backend.save=async(uri,source)=>{started();await gate;return original(uri,source);};
  try {
    const p=f.task.workflow_proposals[0],base=`/api/agent/tasks/${f.task.id}/drafts/workflow/${p.id}`,body={confirm:true,artifact_id:p.artifact_id};
    const pending=f.post(base+'/save',body);await saving;
    await assert.rejects(other.saveDraft(f.task.id,'workflow',p.id,p.artifact_id),{code:'AGENT_DRAFT_BUSY'});
    // Read-only status must not misclassify the live writer as an interrupted one.
    assert.equal((await other.draftDetail(f.task.id,'workflow',p.id)).draft?.state,'saving');
    release();assert.equal((await (await pending).json()).state,'saved');
    const checkpoint=await other.tasks.get(f.task.id);checkpoint.drafts![0].state='saving';delete checkpoint.drafts![0].saved_source;
    await other.tasks.save(checkpoint);
    const recovered=await other.draftDetail(f.task.id,'workflow',p.id);
    assert.equal(recovered.draft?.state,'saved');assert.ok(recovered.draft?.saved_source);assert.equal(f.backend.saves,1);
    await assert.rejects(other.saveDraft(f.task.id,'workflow',p.id,p.artifact_id),{code:'AGENT_DRAFT_USED'});
  }finally{release();await other.close();await f.cleanup();}
});

test('save timeout automatically reads back and starts read-only diagnosis without repeating the write', async () => {
  const f = await workflowApiFixture(); f.backend.uncertain=true;
  try {
    const proposal=f.task.workflow_proposals[0],base=`/api/agent/tasks/${f.task.id}/drafts/workflow/${proposal.id}`;
    const body={confirm:true,artifact_id:proposal.artifact_id};
    const saved=await (await f.post(base+'/save',body)).json();
    assert.equal(saved.state,'uncertain',JSON.stringify(saved));
    assert.ok(saved.saved_source);
    assert.match(saved.message,/读回源码与草稿一致/);
    assert.ok(saved.evidence_artifact);
    assert.equal(f.backend.saves,1);
    for(let i=0;i<200;i++) {
      const task=await f.get(`/api/agent/tasks/${f.task.id}`);
      if(!['running','queued'].includes(task.status))break;
      await new Promise(r=>setTimeout(r,10));
    }
    assert.equal((await f.post(base+'/save',body)).status,400);
    assert.equal((await f.post(base+'/activate',{...body,atc:false})).status,400);
    assert.equal((await f.post(base+'/discard',body)).status,400);
    const reconcile = {artifact_id:proposal.artifact_id,sap_execution_finished:true};
    assert.equal((await f.post(base+'/reconcile',{artifact_id:proposal.artifact_id})).status,400);
    const intended = f.backend.inactive;
    f.backend.inactive = 'REPORT ztest.\nWRITE 42.';
    assert.equal((await f.post(base+'/reconcile',reconcile)).status,400);
    assert.equal((await f.get(base)).draft.state,'uncertain');
    f.backend.inactive = intended;
    const response = await f.post(base+'/reconcile',reconcile);
    const resolved = await response.json();
    assert.equal(response.status,200,JSON.stringify(resolved));
    assert.equal(resolved.state,'saved');
    const store = new WriteApprovalStore(f.directory);
    for (const approval of resolved.approval_ids) assert.equal(await store.requiresReconciliation(approval),false);
    assert.equal(f.backend.saves,1);
  } finally { await f.cleanup(); }
});

test('automatic repair prepares a fresh reviewed draft even when the conversation has full write permission', async () => {
  const f=await fixture();let round=0;
  const agent=new AgentRuntime(f.store,{credentials,factory:()=>f.backend,audit:new AuditLog(f.logDirectory),
    execute:async(name,input)=>f.operations.run(name,input),model:async()=>{
      const call=(name:string,args:object)=>({message:{role:'assistant' as const,content:null,tool_calls:[{id:randomUUID(),type:'function' as const,function:{name,arguments:JSON.stringify(args)}}]}});
      if(++round===1)return call('get_capabilities',{});
      if(round===2)return call('propose_program_workflow',{action:'create_program',name:'ZTEST',description:'test',package_name:'$TMP',source:'REPORT ztest.\nWRITE 1.'});
      if(round===4){const baseline=await f.backend.read(object,'active');return call('propose_program_workflow',{
        action:'update_source',object_uri:object,source_uri:baseline.source_uri,version:'active',expected_revision:baseline.revision,source:'REPORT ztest.\nWRITE 2.'});}
      return {message:{role:'assistant' as const,content:'请审核修复草稿。'}};
    }});
  async function terminal(id:string){for(let i=0;i<500;i++){const t=await agent.tasks.get(id);if(!['running','queued'].includes(t.status))return t;await new Promise(r=>setTimeout(r,10));}throw new Error('not terminal');}
  try {
    await agent.initialize();const created=await agent.create('创建程序',f.connection.connection_id,'chat');
    const initial=await terminal(created.id),proposal=initial.workflow_proposals![0];
    await agent.setWriteMode(created.id,'unrestricted');f.backend.uncertain=true;
    const result=await agent.saveDraft(created.id,'workflow',proposal.id,proposal.artifact_id);
    assert.equal(result.state,'uncertain');
    const repaired=await terminal(created.id);assert.equal(repaired.status,'completed',JSON.stringify(repaired.error));
    assert.equal(repaired.workflow_proposals?.length,2);assert.equal(f.backend.saves,1);
    assert.equal(repaired.write_mode,'unrestricted');assert.equal(repaired.repair_only,true);
    const next=repaired.workflow_proposals![1];
    assert.equal(repaired.drafts?.some(d=>d.key==='workflow:'+next.id),false);
    // A repair draft has no grant and cannot be activated before reviewed saving.
    await assert.rejects(agent.activateDraft(created.id,'workflow',next.id,next.artifact_id,false));
  }finally{await agent.close();await f.cleanup();}
});

test('unchanged readback after an unknown save never retries, and unavailable diagnosis leaves a usable failure record', async () => {
  const f=await workflowApiFixture(),agent=new AgentRuntime(f.store,{credentials,factory:()=>f.backend});
  f.backend.save=async()=>{f.backend.saves++;throw new AppError('OUTCOME_UNKNOWN','connection reset before confirmation');};
  try {
    const p=f.task.workflow_proposals[0];
    const result=await agent.saveDraft(f.task.id,'workflow',p.id,p.artifact_id);
    assert.equal(result.state,'uncertain');assert.equal(result.saved_source,undefined);assert.equal(f.backend.saves,1);
    assert.match(result.message!,/自动排查暂未启动/);
    assert.equal((await agent.cleanupPreview(0,[],f.connection.connection_id)).candidates.length,0);
    const task=await agent.tasks.get(f.task.id);
    await assert.rejects(agent.remove(task.id,task.updated_at),{code:'AGENT_APPROVAL_ACTIVE'});
    await assert.rejects(agent.saveDraft(task.id,'workflow',p.id,p.artifact_id),{code:'AGENT_DRAFT_USED'});
    assert.equal(f.backend.saves,1);
  }finally{await agent.close();await f.cleanup();}
});

test('a baseline conflict generates a new draft that is saved only after a fresh user confirmation', async () => {
  const f=await fixture();let round=0;
  const agent=new AgentRuntime(f.store,{credentials,factory:()=>f.backend,execute:async(name,input)=>f.operations.run(name,input),model:async messages=>{
    const call=(name:string,args:object)=>({message:{role:'assistant' as const,content:null,tool_calls:[{id:randomUUID(),type:'function' as const,function:{name,arguments:JSON.stringify(args)}}]}});
    round++;if(round===1)return call('get_capabilities',{});
    if(round===5)assert.ok(messages.some(m=>m.role==='system'&&m.content?.includes('不要仅因基线变化让用户重新描述修改要求')));
    if(round===2||round===5)return call('read_source',{object_uri:object,version:'active'});
    if(round===3||round===6){const read=JSON.parse(messages.findLast(m=>m.role==='tool'&&m.content?.includes('"source_uri"'))!.content!).data;
      return call('propose_program_workflow',{action:'update_source',object_uri:object,source_uri:read.source_uri,version:'active',expected_revision:read.revision,
        source:read.source+'\nWRITE 2.'});}
    return {message:{role:'assistant' as const,content:'请审核草稿。'}};
  }});
  async function terminal(id:string){for(let i=0;i<500;i++){const t=await agent.tasks.get(id);if(!['running','queued'].includes(t.status))return t;await new Promise(r=>setTimeout(r,10));}throw new Error('not terminal');}
  try {
    const created=await agent.create('修改程序',f.connection.connection_id,'chat');const first=(await terminal(created.id)).workflow_proposals![0];
    f.backend.active='REPORT ztest.\nWRITE 9.';
    assert.equal((await agent.saveDraft(created.id,'workflow',first.id,first.artifact_id)).state,'failed');
    assert.equal(f.backend.saves,0);
    const repaired=await terminal(created.id);assert.equal(repaired.status,'completed',JSON.stringify(repaired.error));
    assert.equal(repaired.workflow_proposals?.length,2);assert.equal(f.backend.saves,0);
    const retry=await agent.reviseDraft(created.id,'workflow',first.id,first.artifact_id);
    assert.equal(retry.recovery_started,true);
    const resumed=await terminal(created.id);
    assert.equal(resumed.latest_prompt,undefined);
    assert.equal(resumed.messages.filter(m=>m.role==='user').length,1);
    assert.equal(f.backend.saves,0);
    const second=repaired.workflow_proposals![1];const saved=await agent.saveDraft(created.id,'workflow',second.id,second.artifact_id);
    assert.equal(saved.state,'saved',JSON.stringify(saved));assert.equal(f.backend.saves,1);
    assert.equal(f.backend.inactive,'REPORT ztest.\nWRITE 9.\nWRITE 2.');assert.equal(f.backend.active,'REPORT ztest.\nWRITE 9.');
  }finally{await agent.close();await f.cleanup();}
});

test('ordinary draft revision binds the selected artifact internally without asking the user to repeat the requirement', async () => {
  const f=await workflowApiFixture();let received:Message[]=[];
  const agent=new AgentRuntime(f.store,{credentials,factory:()=>f.backend,model:async messages=>{
    received=structuredClone(messages);return {message:{role:'assistant',content:'已沿用原要求准备修改。'}};
  }});
  try {
    const p=f.task.workflow_proposals[0];await agent.setWriteMode(f.task.id,'unrestricted');
    assert.equal((await agent.reviseDraft(f.task.id,'workflow',p.id,p.artifact_id)).recovery_started,false);
    await agent.followUp(f.task.id,'沿用原来的修改目标继续完善');
    let task;
    for(let i=0;i<200;i++){task=await agent.tasks.get(f.task.id);if(!['queued','running'].includes(task.status))break;await new Promise(r=>setTimeout(r,10));}
    assert.equal(task!.status,'completed');assert.equal(task!.repair_only,true);
    assert.ok(received.some(m=>m.role==='system'&&m.content?.includes(p.artifact_id)));
    assert.equal(received.filter(m=>m.role==='user').at(-1)?.content,'沿用原来的修改目标继续完善');
    assert.equal(task!.draft_revision_artifact,undefined);assert.equal(f.backend.saves,0);
  }finally{await agent.close();await f.cleanup();}
});

test('client full mode executes the requested workflow without per-operation confirmation and records its authority', async () => {
  const f = await workflowApiFixture('unrestricted');
  try {
    assert.equal(f.task.write_mode, 'unrestricted');
    assert.equal(f.backend.saves, 1);
    assert.equal(f.backend.active, 'REPORT ztest.\nWRITE 1.');
    assert.equal(f.detail.execution.state, 'completed');
    for (const item of f.detail.approvals) {
      const record = await new WriteApprovalStore(f.directory).get(item.id);
      assert.equal(record.authorization, 'client_full');
    }
  } finally { await f.cleanup(); }
});
test('client full mode can save a source change or create an object directly, with complete receipts across stop and resume', async () => {
  for (const kind of ['source','operation']) {
    const f = await fixture(); let round = 0, release = () => {}, started = () => {};
    const saving = new Promise<void>(resolve => { started = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    if (kind === 'source') {
      const save = f.backend.save.bind(f.backend);
      f.backend.save = async (uri,code) => { started(); await blocked; await save(uri,code); };
    }
    const agent = new AgentRuntime(f.store,{credentials,factory:()=>f.backend,audit:new AuditLog(f.logDirectory),
      execute:async(name,input)=>f.operations.run(name,input), model:async messages=>{
        const call=(name:string,args:object)=>({message:{role:'assistant' as const,content:null,tool_calls:[{id:randomUUID(),type:'function' as const,function:{name,arguments:JSON.stringify(args)}}]}});
        if (++round===1) return call('get_capabilities',{});
        if (kind==='operation' && round===2) return call('propose_controlled_operation',{tool:'create_program',input:{name:'ZTEST',description:'test',package_name:'$TMP'}});
        if (kind==='source' && round===2) return call('read_source',{object_uri:object,version:'active'});
        if (kind==='source' && round===3) {
          const read=JSON.parse(messages.findLast(message=>message.role==='tool')!.content!);
          return call('propose_source_change',{source_artifact_id:read._task_artifact.artifact_id,summary:'修改输出',edits:[{old_text:'REPORT ztest.',new_text:'REPORT ztest.\nWRITE 1.'}]});
        }
        return {message:{role:'assistant' as const,content:'已按执行结果完成。'}};
      }});
    async function terminal(id:string) {
      for(let i=0;i<500;i++){const task=await agent.tasks.get(id);if(!['running','queued'].includes(task.status))return task;await new Promise(resolve=>setTimeout(resolve,10));}
      throw new Error('Task did not finish');
    }
    try {
      await agent.initialize();
      const created=await agent.create('执行修改',f.connection.connection_id,'chat',undefined,undefined,'unrestricted');
      if(kind==='source') {
        await saving; const stopped=agent.stop(created.id); release();
        assert.equal((await stopped).status,'stopped');
        assert.equal((await agent.tasks.get(created.id)).messages.at(-1)?.role,'tool');
        await agent.resume(created.id);
      }
      const task=await terminal(created.id);assert.equal(task.status,'completed',JSON.stringify(task.error));
      if(kind==='source'){assert.equal(f.backend.saves,1);assert.equal(f.backend.inactive,'REPORT ztest.\nWRITE 1.');}
      else assert.equal(task.operation_proposals?.length,1);
    } finally {release();await agent.close();await f.cleanup();}
  }
});

test('client full mode replies locally on unknown writes and retains a complete tool receipt for review', async () => {
  const f = await workflowApiFixture('unrestricted', backend => { backend.uncertain = true; });
  try {
    assert.equal(f.backend.saves, 1);
    assert.match(f.task.answer, /写入未完成或结果暂时无法确认/);
    assert.equal(f.detail.execution.state, 'stopped');
    assert.ok(f.detail.approvals.some(item => item.needs_reconciliation));
    const saved = await f.get(`/api/agent/tasks/${f.task.id}/conversation`);
    assert.match(saved.messages.at(-1).content, /执行回执已保留/);
  } finally { await f.cleanup(); }
});

test('client mode switching is local, does not execute pending plans and cannot bypass a disabled connection', async () => {
  const f = await workflowApiFixture();
  try {
    const path = `/api/agent/tasks/${f.task.id}/write-mode`;
    const patch = (mode: string) => fetch(f.origin + path, { method:'PATCH', headers:f.headers, body:JSON.stringify({mode}) });
    assert.equal(f.task.write_mode,'controlled'); assert.equal(f.backend.saves,0);
    assert.equal((await patch('unrestricted')).status,200);
    assert.equal(f.backend.saves,0);
    assert.equal(Object.hasOwn((await f.store.load()).connections[0],'write_governance'),false);
    assert.equal((await patch('controlled')).status,200);
    const config = await f.store.load(); config.connections[0].write_enabled = false; await f.store.save(config);
    assert.equal((await patch('unrestricted')).status,400);
    assert.equal((await f.post('/api/agent/tasks',{prompt:'写入',connection_id:f.connection.connection_id,write_mode:'unrestricted'})).status,400);
    assert.equal(f.backend.saves,0);
  } finally { await f.cleanup(); }
});

test('MCP writes independently without approval tools or tickets and obeys the connection write switch', async () => {
  const f = await fixture(); const token = await f.store.createToken();
  const runtime = await startHttp(f.store,f.operations,0), address = runtime.listener.address();
  assert.ok(address && typeof address !== 'string');
  const client = new Client({name:'independent-writes',version:'1'});
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${token.token}`}}}));
    const tools = (await client.listTools()).tools;
    assert.equal(tools.some(tool=>tool.name.startsWith('approval_')||tool.name.startsWith('workflow_')),false);
    const result = await client.callTool({name:'create_program',arguments:{connection_id:f.connection.connection_id,name:'ZTEST',description:'test',package_name:'$TMP',request_id:randomUUID()}});
    assert.equal((result.structuredContent as {status:string}).status,'success');
    const config=await f.store.load();config.connections[0].write_enabled=false;await f.store.save(config);
    const denied=await client.callTool({name:'create_program',arguments:{connection_id:f.connection.connection_id,name:'ZTEST',description:'test',package_name:'$TMP',request_id:randomUUID()}});
    assert.equal((denied.structuredContent as {error:{code:string}}).error.code,'WRITE_DISABLED');
  } finally {await client.close();await runtime.close();await f.cleanup();}
});

test('workflow progress remains readable during execution and reports a failed syntax check precisely', async () => {
  const f = await workflowApiFixture();
  let release!: () => void, started!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const saving = new Promise<void>(resolve => { started = resolve; });
  const save = f.backend.save.bind(f.backend);
  f.backend.save = async (uri, code) => { started(); await blocked; await save(uri, code); };
  f.backend.check = async () => ({ passed: false });
  const request = f.post(`${f.base}/execute`, { confirm: true, review_id: f.detail.review.review_id });
  try {
    await saving;
    const current = await f.get(`${f.base}/progress`);
    assert.equal(current.execution.state, 'running');
    assert.equal(current.execution.can_reconcile, false);
    assert.equal(Object.hasOwn(current, 'plan'), false);
    assert.equal(Object.hasOwn(current, 'review'), false);
    assert.equal(current.progress.phases.find(phase => phase.id === 'update_source').status, 'running');
    const approval = current.approvals.find(item => item.step === 'update_source');
    assert.equal((await f.post(`${f.base}/reconcile`, { confirm: true, action: 'resolve', approval_id: approval.id })).status, 400);
    assert.equal((await f.post(`${f.base}/verify`, {})).status, 400);
    release(); assert.equal((await request).status, 400);
    const after = await f.get(`${f.base}/progress`);
    assert.equal(after.execution.state, 'stopped');
    assert.equal(after.progress.phases.find(phase => phase.id === 'update_source').status, 'completed');
    assert.equal(after.progress.phases.find(phase => phase.id === 'syntax_check').status, 'failed');
    assert.equal(after.progress.phases.find(phase => phase.id === 'activate_objects').status, 'skipped');
    assert.equal(after.progress.failure.code, 'WORKFLOW_SYNTAX_FAILED');
    const verification = await (await f.post(`${f.base}/verify`, {})).json();
    assert.equal(verification.observations.find(item => item.version === 'inactive').matches_plan, true);
    assert.equal(verification.observations.find(item => item.version === 'active').matches_plan, false);
    assert.equal(f.backend.saves, 1);
  } finally { release(); await request; await f.cleanup(); }
});

test('workflow reconciliation is authenticated, plan-scoped, explicit and never repeats an uncertain save', async () => {
  const f = await workflowApiFixture(); f.backend.uncertain = true;
  try {
    assert.equal((await f.post(`${f.base}/execute`, { confirm: true, review_id: f.detail.review.review_id })).status, 400);
    const current = await f.get(`${f.base}/progress`);
    const approval = current.approvals.find(item => item.step === 'update_source');
    assert.equal(approval.needs_reconciliation, true);
    assert.equal(current.progress.phases.find(phase => phase.id === 'update_source').status, 'unknown');
    assert.equal((await f.post(`${f.base}/reconcile`, { confirm: false, action: 'resolve', approval_id: approval.id })).status, 400);
    assert.equal((await f.post(`${f.base}/reconcile`, { confirm: true, action: 'resolve', approval_id: randomUUID() })).status, 400);
    assert.equal((await fetch(`${f.origin}${f.base}/reconcile`, { method: 'POST', headers: { 'Content-Type':'application/json' },
      body: JSON.stringify({ confirm:true, action:'resolve', approval_id:approval.id }) })).status, 401);
    assert.equal((await f.post(`${f.base}/reconcile`, { confirm: true, action: 'resolve', approval_id: approval.id })).status, 200);
    const after = await f.get(`${f.base}/progress`);
    assert.equal(after.approvals.find(item => item.id === approval.id).resolved, true);
    assert.equal(after.approvals.find(item => item.id === approval.id).needs_reconciliation, false);
    assert.equal(after.progress.phases.find(phase => phase.id === 'update_source').status, 'unknown');
    assert.equal((await f.post(`${f.base}/reconcile`, { confirm: true, action: 'resolve', approval_id: approval.id })).status, 400);
    assert.equal((await f.post(`${f.base}/execute`, { confirm: true, review_id: f.detail.review.review_id })).status, 400);
    assert.equal(f.backend.saves, 1);
  } finally { await f.cleanup(); }
});

test('workflow recovery can revoke a journal-linked unused approval without touching SAP', async () => {
  const f = await workflowApiFixture();
  try {
    const approvals = new WriteApprovalStore(f.directory);
    const plan = f.detail.plan;
    const record = await approvals.createOperation(parseControlledOperation('create_program', {
      connection_id: f.connection.connection_id, name: 'ZTEST', description: 'test', package_name: '$TMP',
      request_id: `${plan.plan_id}:write` }), targetFingerprint(f.connection), 'a'.repeat(64), new Date(Date.now() + 60000));
    const directory = join(f.directory, 'workflow-runs'); await mkdir(directory, { recursive: true });
    await writeFile(join(directory, digest(`${f.connection.connection_id}:${plan.plan_id}`) + '.jsonl'), [
      { state:'started', plan_id:plan.plan_id },
      { state:'step_approved', step:'create_program', phase:'create_program', approval_id:record.id },
      { state:'stopped', phase:'create_program', error:{ code:'SYNTHETIC', message:'审批后中断' } }
    ].map(event => JSON.stringify(event) + '\n').join(''));
    assert.equal((await f.get(`${f.base}/progress`)).approvals[0].state, 'pending');
    assert.equal((await f.post(`${f.base}/reconcile`, { confirm:true, action:'revoke', approval_id:record.id })).status, 200);
    assert.equal((await approvals.status(record.id)).state, 'revoked');
    assert.equal(f.backend.saves, 0);
  } finally { await f.cleanup(); }
});


test('legacy connection policies map safely and obsolete object scopes are discarded', async () => {
  const f = await fixture();
  try {
    assert.equal(writePolicy({ ...f.connection, write_enabled: false, write_governance: 'approval_required' }), 'disabled');
    assert.equal(writePolicy({ ...f.connection, write_enabled: true }), 'enabled');
    assert.equal(writePolicy({ ...f.connection, write_enabled: true, write_governance: 'approval_required' }), 'enabled');
    const config = await f.store.load();
    await writeFile(join(f.directory, 'config.json'), JSON.stringify({ ...config, connections: [
      { ...f.connection, write_governance: 'approval_required', write_objects: ['/sap/bc/adt/programs/programs/old'] }
    ] }));
    const migrated = await f.store.load();
    assert.equal(writePolicy(migrated.connections[0]), 'enabled');
    assert.equal(Object.hasOwn(migrated.connections[0], 'write_objects'), false);
    await writeFile(join(f.directory, 'config.json'), JSON.stringify({ ...config, connections: [
      { ...f.connection, write_objects: ['/sap/bc/adt/programs/programs/old'] }
    ] }));
    const unrestricted = await f.operations.run('create_program', { connection_id: f.connection.connection_id,
      name: 'znew', description: 'test', package_name: '$TMP', request_id: randomUUID() });
    assert.equal(unrestricted.status, 'success');
    await f.store.save(migrated);
    assert.equal(Object.hasOwn(JSON.parse(await readFile(join(f.directory, 'config.json'), 'utf8')).connections[0], 'write_objects'), false);
  } finally { await f.cleanup(); }
});

test('client controlled execution denies every write tool before credentials or backend access', async () => {
  const f = await fixture();
  let credentialReads = 0, backends = 0;
  const protectedCredentials: Credentials = { ...credentials, get: async () => { credentialReads++; return 'fake'; } };
  const ops = new Operations(f.store, protectedCredentials, new AuditLog(f.logDirectory), () => { backends++; return f.backend; }, 512, false, true);
  try {
    await f.store.save({ schema_version: 1, connections: [{ ...f.connection, write_governance: 'approval_required' }], tokens: [] });
    for (const name of writeTools) {
      const result = await ops.run(name, { connection_id: f.connection.connection_id, request_id: randomUUID(), object_uri: object });
      assert.equal(result.status, 'error', name);
      assert.equal(result.error?.code, 'CLIENT_APPROVAL_REQUIRED', name);
      assert.equal(result.write_dispatched, false, name);
    }
    assert.equal(credentialReads, 0);
    assert.equal(backends, 0);
    for (const args of [{}, { object_uri: object + 'other' }, { object_uri: object.toUpperCase() }, { source_uri: source },
      { object_uri: object, source_uri: '/sap/bc/adt/programs/programs/other/source/main' }]) {
      const denied = await ops.run('update_source', { connection_id: f.connection.connection_id, request_id: randomUUID(), ...args });
      assert.equal(denied.error?.code, 'CLIENT_APPROVAL_REQUIRED');
      assert.equal(denied.write_dispatched, false);
    }
    assert.equal(credentialReads, 0);
    assert.equal(backends, 0);
    const read = await ops.run('read_source', { connection_id: f.connection.connection_id, object_uri: object, version: 'active' });
    assert.equal(read.status, 'success');
    assert.equal(credentialReads, 1);
    assert.equal(backends, 1);
    await f.store.save({ schema_version: 1, connections: [{ ...f.connection, write_enabled: false, write_governance: 'approval_required' }], tokens: [] });
    const disabled = await ops.run('create_program', { connection_id: f.connection.connection_id, request_id: randomUUID() });
    assert.equal(disabled.error?.code, 'WRITE_DISABLED');
  } finally { await ops.close(); await f.cleanup(); }
});

test('approved source writes bind the exact target and intent and cannot replay across processes', async () => {
  const f = await fixture();
  try {
    const connection = { ...f.connection, write_governance: 'approval_required' as const };
    await f.store.save({ schema_version: 1, connections: [connection], tokens: [] });
    const base = await f.backend.read(object, 'active');
    const input = { connection_id: connection.connection_id, object_uri: object, source_uri: source,
      version: 'active' as const, expected_revision: base.revision, request_id: randomUUID(),
      edits: [{ old_text: 'REPORT ztest.', new_text: 'REPORT ztest.\nWRITE 2.' }] };
    const approvals = new WriteApprovalStore(f.directory);
    const approval = await approvals.create(input, targetFingerprint(connection), 'a'.repeat(64), new Date(Date.now() + 60000));
    const createOps = () => new Operations(f.store, credentials, new AuditLog(f.logDirectory), () => f.backend);
    const forged = createOps();
    try {
      const result = await forged.run('update_source', { ...input, approval_id: approval.id, edits: [{ old_text: 'REPORT ztest.', new_text: 'MALICIOUS' }] });
      assert.equal(result.error?.code, 'APPROVAL_MISMATCH');
      assert.equal(result.write_dispatched, false);
      assert.equal(f.backend.saves, 0);
    } finally { await forged.close(); }
    const original = createOps();
    try {
      const result = await original.run('update_source', { ...input, approval_id: approval.id });
      assert.equal(result.status, 'success');
      assert.equal(result.source_save?.verification, 'passed');
      assert.equal(f.backend.saves, 1);
      assert.equal(f.backend.inactive, 'REPORT ztest.\nWRITE 2.');
      assert.equal((await approvals.status(approval.id)).state, 'completed');
    } finally { await original.close(); }
    const replay = createOps();
    try {
      assert.equal((await replay.run('update_source', { ...input, approval_id: approval.id })).error?.code, 'APPROVAL_USED');
      await assert.rejects(reserveCliWrite(f.directory, 'update_source', input), { code: 'REQUEST_ALREADY_USED' });
      assert.equal(f.backend.saves, 1);
    } finally { await replay.close(); }
    const other = await approvals.create(input, targetFingerprint(connection), 'a'.repeat(64), new Date(Date.now() + 60000));
    const duplicate = createOps();
    try {
      const result = await duplicate.run('update_source', { ...input, approval_id: other.id });
      assert.equal(result.error?.code, 'REQUEST_ALREADY_USED');
      assert.equal(result.write_dispatched, false);
      assert.equal(f.backend.saves, 1);
    } finally { await duplicate.close(); }
  } finally { await f.cleanup(); }
});

test('concurrent operation instances cannot execute the same controlled approval twice', async () => {
  const f = await fixture();
  try {
    const connection = { ...f.connection, write_governance: 'approval_required' as const };
    await f.store.save({ schema_version: 1, connections: [connection], tokens: [] });
    const base = await f.backend.read(object, 'active');
    const input = { connection_id: connection.connection_id, object_uri: object, source_uri: source,
      version: 'active' as const, expected_revision: base.revision, request_id: randomUUID(),
      edits: [{ old_text: 'REPORT ztest.', new_text: 'REPORT ztest.\nWRITE 2.' }] };
    const approval = await new WriteApprovalStore(f.directory).create(input, targetFingerprint(connection), 'a'.repeat(64), new Date(Date.now() + 60000));
    const one = new Operations(f.store, credentials, new AuditLog(f.logDirectory), () => f.backend);
    const two = new Operations(f.store, credentials, new AuditLog(f.logDirectory), () => f.backend);
    try {
      const results = await Promise.all([one.run('update_source', { ...input, approval_id: approval.id }),
        two.run('update_source', { ...input, approval_id: approval.id })]);
      assert.equal(results.filter(result => result.status === 'success').length, 1);
      assert.equal(results.filter(result => result.status === 'error').length, 1);
      assert.equal(f.backend.saves, 1);
    } finally { await one.close(); await two.close(); }
  } finally { await f.cleanup(); }
});

test('target changes and stale revisions cannot use a controlled approval', async () => {
  const f = await fixture();
  try {
    const connection = { ...f.connection, write_governance: 'approval_required' as const };
    await f.store.save({ schema_version: 1, connections: [connection], tokens: [] });
    const base = await f.backend.read(object, 'active');
    const input = { connection_id: connection.connection_id, object_uri: object, source_uri: source,
      version: 'active' as const, expected_revision: base.revision, request_id: randomUUID(),
      edits: [{ old_text: 'REPORT ztest.', new_text: 'REPORT ztest.\nWRITE 2.' }] };
    const approvals = new WriteApprovalStore(f.directory);
    const approval = await approvals.create(input, targetFingerprint(connection), 'a'.repeat(64), new Date(Date.now() + 60000));
    await f.store.save({ schema_version: 1, connections: [{ ...connection, username: 'OTHER' }], tokens: [] });
    const changed = new Operations(f.store, credentials, new AuditLog(f.logDirectory), () => f.backend);
    assert.equal((await changed.run('update_source', { ...input, approval_id: approval.id })).error?.code, 'APPROVAL_MISMATCH');
    await changed.close();
    await f.store.save({ schema_version: 1, connections: [connection], tokens: [] });
    f.backend.active = 'REPORT changed.';
    const stale = new Operations(f.store, credentials, new AuditLog(f.logDirectory), () => f.backend);
    const result = await stale.run('update_source', { ...input, approval_id: approval.id });
    assert.equal(result.error?.code, 'VERSION_CONFLICT');
    assert.equal(result.write_dispatched, false);
    assert.equal(f.backend.saves, 0);
    assert.equal((await approvals.status(approval.id)).state, 'completed');
    await stale.close();
  } finally { await f.cleanup(); }
});

test('uncertain controlled saves block the object until explicitly reconciled', async () => {
  const f = await fixture();
  try {
    const connection = { ...f.connection, write_governance: 'approval_required' as const };
    await f.store.save({ schema_version: 1, connections: [connection], tokens: [] });
    const approvals = new WriteApprovalStore(f.directory), fingerprint = targetFingerprint(connection);
    const active = await f.backend.read(object, 'active');
    const first = { connection_id: connection.connection_id, object_uri: object, source_uri: source,
      version: 'active' as const, expected_revision: active.revision, request_id: randomUUID(),
      edits: [{ old_text: 'REPORT ztest.', new_text: 'REPORT ztest.\nWRITE 2.' }] };
    const approved = await approvals.create(first, fingerprint, 'a'.repeat(64), new Date(Date.now() + 60000));
    f.backend.uncertain = true;
    const op1 = new Operations(f.store, credentials, new AuditLog(f.logDirectory), () => f.backend);
    const result = await op1.run('update_source', { ...first, approval_id: approved.id });
    assert.equal(result.outcome, 'unknown');
    assert.equal(result.write_dispatched, true);
    await op1.close();
    const inactive = await f.backend.read(object, 'inactive');
    const second = { ...first, version: 'inactive' as const, expected_revision: inactive.revision, request_id: randomUUID(),
      edits: [{ old_text: 'WRITE 2.', new_text: 'WRITE 3.' }] };
    const next = await approvals.create(second, fingerprint, 'b'.repeat(64), new Date(Date.now() + 60000));
    const blocked = new Operations(f.store, credentials, new AuditLog(f.logDirectory), () => f.backend);
    assert.equal((await blocked.run('update_source', { ...second, approval_id: next.id })).error?.code, 'APPROVAL_RECONCILIATION_REQUIRED');
    assert.equal(f.backend.saves, 1);
    await blocked.close();
    await approvals.resolve(approved.id, new Date().toISOString());
    f.backend.uncertain = false;
    const op2 = new Operations(f.store, credentials, new AuditLog(f.logDirectory), () => f.backend);
    assert.equal((await op2.run('update_source', { ...second, approval_id: next.id })).status, 'success');
    assert.equal(f.backend.inactive, 'REPORT ztest.\nWRITE 3.');
    await op2.close();
  } finally { await f.cleanup(); }
});


test('authenticated draft approval and execution persist the actual SAP result', async () => {
  const f = await fixture();
  const connection = { ...f.connection, write_governance: 'approval_required' as const };
  await f.store.save({ schema_version: 1, connections: [connection], tokens: [] });
  let round = 0;
  const model = async (messages: Message[]) => {
    round++;
    const tool = (name: string, args: object) => ({ message: { role: 'assistant' as const, content: null,
      tool_calls: [{ id: randomUUID(), type: 'function' as const, function: { name, arguments: JSON.stringify(args) } }] } });
    if (round === 1) return tool('get_capabilities', {});
    if (round === 2) return tool('read_source', { object_uri: object, version: 'active' });
    if (round === 3) {
      const read = messages.findLast(message => message.role === 'tool' && message.content?.includes('REPORT ztest.'));
      const artifact = JSON.parse(read!.content!)._task_artifact.artifact_id;
      return tool('propose_source_change', { source_artifact_id: artifact, summary: '修改输出',
        edits: [{ old_text: 'REPORT ztest.', new_text: 'REPORT ztest.\nWRITE 2.' }] });
    }
    return { message: { role: 'assistant' as const, content: '草稿已生成。' } };
  };
  const host = await startAdmin(f.store, credentials, 0, () => f.backend, undefined, { agent: {
    model, execute: async name => name === 'read_source'
      ? { status: 'success', data: await f.backend.read(object, 'active') } : { status: 'success', data: {} },
    audit: new AuditLog(f.logDirectory)
  } });
  const url = new URL(host.url), origin = url.origin;
  const headers = { 'X-Admin-Token': url.hash.slice(1), Origin: origin, 'Content-Type': 'application/json' };
  const post = (path: string, body: unknown, method = 'POST') => fetch(`${origin}${path}`, { method, headers, body: JSON.stringify(body) });
  try {
    const created = await post('/api/agent/tasks', { prompt: '修改输出', connection_id: connection.connection_id, output_mode: 'chat' });
    assert.equal(created.status, 202);
    const id = (await created.json()).id;
    let task: { status: string; changes: { id: string; artifact_id: string }[] } | undefined;
    for (let i = 0; i < 500; i++) {
      task = await (await fetch(`${origin}/api/agent/tasks/${id}`, { headers })).json();
      if (task && !['queued', 'running'].includes(task.status)) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(task?.status, 'completed');
    const change = task!.changes[0], base = `/api/agent/tasks/${id}/changes/${change.id}`;
    assert.equal((await fetch(`${origin}${base}/approval`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true, artifact_id: change.artifact_id }) })).status, 401);
    assert.equal((await fetch(`${origin}${base}/approval`, { method: 'POST', headers: { ...headers, Origin: 'http://evil.test' },
      body: JSON.stringify({ confirm: true, artifact_id: change.artifact_id }) })).status, 403);
    assert.equal((await post(`${base}/approval`, { confirm: false, artifact_id: change.artifact_id })).status, 400);
    const approved = await post(`${base}/approval`, { confirm: true, artifact_id: change.artifact_id });
    assert.equal(approved.status, 200);
    const approval = await approved.json();
    assert.equal(approval.state, 'pending');
    assert.equal(f.backend.saves, 0);
    assert.equal((await post(`${base}/approval`, { confirm: true, artifact_id: change.artifact_id })).status, 400);
    const updated = await (await fetch(`${origin}/api/agent/tasks/${id}`, { headers })).json();
    const blockedDelete = await post(`/api/agent/tasks/${id}`, { confirm: true, updated_at: updated.updated_at }, 'DELETE');
    assert.equal((await blockedDelete.json()).error.code, 'AGENT_APPROVAL_ACTIVE');
    assert.equal((await post(`${base}/approval`, { confirm: true, approval_id: approval.id }, 'DELETE')).status, 200);
    const approvedAgain = await (await post(`${base}/approval`, { confirm: true, artifact_id: change.artifact_id })).json();
    assert.notEqual(approvedAgain.id, approval.id);
    const executed = await post(`${base}/execute`, { confirm: true, approval_id: approvedAgain.id });
    assert.equal(executed.status, 200);
    const result = await executed.json();
    assert.equal(result.status, 'success');
    assert.equal(result.source_save.verification, 'passed');
    assert.equal(f.backend.saves, 1);
    const detail = await (await fetch(`${origin}${base}`, { headers })).json();
    assert.equal(detail.approval.state, 'completed');
    assert.equal(detail.approval.result.source_save.saved, true);
    assert.equal((await post(`${base}/execute`, { confirm: true, approval_id: approvedAgain.id }).then(r => r.json())).error.code, 'APPROVAL_USED');
    assert.equal((await post(`${base}/approval`, { confirm: true, artifact_id: change.artifact_id })).status, 400);
    assert.equal(f.backend.saves, 1);
  } finally { await host.close(); await f.cleanup(); }
});

test('controlled operation drafts require authenticated approval and execute each approved action once', async () => {
  const f = await fixture();
  const connection = { ...f.connection, write_governance: 'approval_required' as const };
  await f.store.save({ schema_version: 1, connections: [connection], tokens: [] });
  let calls = 0, round = 0;
  let proposal: { tool: string; input: object };
  f.backend.transportRequirement = async (_object, pkg) => pkg === 'ZDEV' ? 'required' : 'not_required';
  f.backend.create = async () => { calls++; return object; };
  Object.assign(f.backend, {
    createFunctionGroup: async () => { calls++; return '/sap/bc/adt/functions/groups/zgroup'; },
    createFunctionModule: async () => { calls++; return '/sap/bc/adt/functions/groups/zgroup/fmodules/zfunc'; },
    createTransportRequest: async () => { calls++; return 'DEVK900001'; },
    verifyTransportRequest: async () => ({ request_number: 'DEVK900001', owner: 'TEST', status: 'modifiable', tasks: [], tasks_truncated: false }),
    quality: async (name: string) => { calls++; return name === 'run_atc' ? { run_id: 'RUN1', submission: 'accepted' }
      : { test_status: 'failed', failed: 1 }; }
  });
  const activate = f.backend.activate.bind(f.backend);
  f.backend.activate = async () => { calls++; return activate(); };
  const model = async () => {
    round++;
    const tool = (name: string, args: object) => ({ message: { role: 'assistant' as const, content: null,
      tool_calls: [{ id: randomUUID(), type: 'function' as const, function: { name, arguments: JSON.stringify(args) } }] } });
    if (round === 1) return tool('get_capabilities', {});
    if (round === 2) return tool('propose_controlled_operation', proposal);
    return { message: { role: 'assistant' as const, content: '草稿已生成，等待审核。' } };
  };
  const host = await startAdmin(f.store, credentials, 0, () => f.backend, undefined, { agent: {
    model, execute: async () => ({ status: 'success', data: {} }), audit: new AuditLog(f.logDirectory)
  } });
  const url = new URL(host.url), origin = url.origin;
  const headers = { 'X-Admin-Token': url.hash.slice(1), Origin: origin, 'Content-Type': 'application/json' };
  const post = (path: string, body: unknown, method = 'POST') => fetch(`${origin}${path}`, { method, headers, body: JSON.stringify(body) });
  try {
    f.backend.inactive = 'REPORT ztest.\nWRITE 2.';
    const revision = (await f.backend.read(object, 'inactive')).revision;
    const proposals = [
      { tool: 'create_program', input: { name: 'ZTEST', description: 'test', package_name: '$TMP' } },
      { tool: 'create_function_group', input: { name: 'ZGROUP', description: 'test', package_name: '$TMP' } },
      { tool: 'create_function_module', input: { name: 'ZFUNC', description: 'test', function_group_uri: '/sap/bc/adt/functions/groups/zgroup' } },
      { tool: 'create_transport_request', input: { object_uri: object, package_name: 'ZDEV', description: 'test' } },
      { tool: 'activate_objects', input: { objects: [{ object_uri: object, expected_revision: revision }] } },
      { tool: 'run_atc', input: { object_uri: object, check_variant: 'DEFAULT' } },
      { tool: 'run_unit_tests', input: { object_uri: object, max_duration: 'short' } }
    ];
    for (const [index, item] of proposals.entries()) {
      proposal = item; round = 0;
      const created = await post('/api/agent/tasks', { prompt: `请求操作 ${item.tool}`, connection_id: connection.connection_id, output_mode: 'chat' });
      assert.equal(created.status, 202);
      const id = (await created.json()).id;
      let task;
      for (let i = 0; i < 500; i++) {
        task = await (await fetch(`${origin}/api/agent/tasks/${id}`, { headers })).json();
        if (!['queued', 'running'].includes(task.status)) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(task.status, 'completed', JSON.stringify(task.error));
      assert.equal(calls, index, 'a draft must not execute SAP');
      const draft = task.operation_proposals[0], base = `/api/agent/tasks/${id}/operations/${draft.id}`;
      const detail = await (await fetch(`${origin}${base}`, { headers })).json();
      assert.equal(detail.intent.tool, item.tool);
      assert.equal(detail.intent.input.connection_id, connection.connection_id);
      assert.equal((await fetch(`${origin}${base}/approval`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true, artifact_id: draft.artifact_id }) })).status, 401);
      assert.equal((await post(`${base}/approval`, { confirm: false, artifact_id: draft.artifact_id })).status, 400);
      assert.equal((await post(`${base}/approval`, { confirm: true, artifact_id: 'a'.repeat(64) })).status, 400);
      let approved = await (await post(`${base}/approval`, { confirm: true, artifact_id: draft.artifact_id })).json();
      assert.equal(approved.state, 'pending');
      assert.equal(calls, index);
      if (index === 0) {
        const current = await (await fetch(`${origin}/api/agent/tasks/${id}`, { headers })).json();
        const deleted = await (await post(`/api/agent/tasks/${id}`, { confirm: true, updated_at: current.updated_at }, 'DELETE')).json();
        assert.equal(deleted.error.code, 'AGENT_APPROVAL_ACTIVE');
        assert.equal((await post(`${base}/approval`, { confirm: true, approval_id: approved.id }, 'DELETE')).status, 200);
        const revoked = approved.id;
        approved = await (await post(`${base}/approval`, { confirm: true, artifact_id: draft.artifact_id })).json();
        assert.notEqual(approved.id, revoked);
      }
      const executed = await (await post(`${base}/execute`, { confirm: true, approval_id: approved.id })).json();
      assert.equal(executed.status, 'success', JSON.stringify(executed));
      assert.equal(calls, index + 1);
      const saved = await (await fetch(`${origin}${base}`, { headers })).json();
      assert.equal(saved.approval.state, 'completed');
      if (item.tool === 'run_atc') assert.equal(saved.approval.result.data.run_id, 'RUN1');
      if (item.tool === 'run_unit_tests') assert.equal(saved.approval.result.data.test_status, 'failed');
      const replay = await (await post(`${base}/execute`, { confirm: true, approval_id: approved.id })).json();
      assert.equal(replay.error.code, 'APPROVAL_USED');
      const repeated = await f.operations.run(item.tool, { ...detail.intent.input, approval_id: approved.id });
      assert.equal(repeated.error?.code, 'APPROVAL_USED');
      assert.equal(calls, index + 1);
    }
  } finally { await host.close(); await f.cleanup(); }
});

test('uncertain operation requires authenticated human reconciliation and protects task deletion', async () => {
  const f = await fixture();
  const connection = { ...f.connection, write_governance: 'approval_required' as const };
  await f.store.save({ schema_version: 1, connections: [connection], tokens: [] });
  let round = 0, calls = 0;
  Object.assign(f.backend, { quality: async () => { calls++; throw new AppError('ATC_EXECUTION_FAILED', 'Uncertain', { worklist_id: 'WL1' }); } });
  const model = async () => {
    round++;
    const tool = (name: string, args: object) => ({ message: { role: 'assistant' as const, content: null,
      tool_calls: [{ id: randomUUID(), type: 'function' as const, function: { name, arguments: JSON.stringify(args) } }] } });
    if (round === 1) return tool('get_capabilities', {});
    if (round === 2) return tool('propose_controlled_operation', { tool: 'run_atc', input: { object_uri: object, check_variant: 'DEFAULT' } });
    return { message: { role: 'assistant' as const, content: '等待审核。' } };
  };
  const host = await startAdmin(f.store, credentials, 0, () => f.backend, undefined, { agent: {
    model, execute: async () => ({ status: 'success', data: {} }), audit: new AuditLog(f.logDirectory)
  } });
  const url = new URL(host.url), origin = url.origin;
  const headers = { 'X-Admin-Token': url.hash.slice(1), Origin: origin, 'Content-Type': 'application/json' };
  const post = (path: string, body: unknown, method = 'POST') => fetch(`${origin}${path}`, { method, headers, body: JSON.stringify(body) });
  try {
    const created = await (await post('/api/agent/tasks', { prompt: '运行 ATC', connection_id: connection.connection_id })).json();
    let task;
    for (let i = 0; i < 500; i++) {
      task = await (await fetch(`${origin}/api/agent/tasks/${created.id}`, { headers })).json();
      if (!['queued', 'running'].includes(task.status)) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(task.status, 'completed', JSON.stringify(task.error));
    const draft = task.operation_proposals[0], base = `/api/agent/tasks/${created.id}/operations/${draft.id}`;
    const approved = await (await post(`${base}/approval`, { confirm: true, artifact_id: draft.artifact_id })).json();
    const result = await (await post(`${base}/execute`, { confirm: true, approval_id: approved.id })).json();
    assert.equal(result.outcome, 'unknown');
    let detail = await (await fetch(`${origin}${base}`, { headers })).json();
    assert.equal(detail.approval.result.error.details.worklist_id, 'WL1');
    task = await (await fetch(`${origin}/api/agent/tasks/${created.id}`, { headers })).json();
    assert.equal((await post(`/api/agent/tasks/${created.id}`, { confirm: true, updated_at: task.updated_at }, 'DELETE').then(r => r.json())).error.code, 'AGENT_APPROVAL_ACTIVE');
    assert.equal((await post(`${base}/resolve`, { confirm: false, approval_id: approved.id })).status, 400);
    assert.equal((await fetch(`${origin}${base}/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true, approval_id: approved.id }) })).status, 401);
    const resolved = await (await post(`${base}/resolve`, { confirm: true, approval_id: approved.id })).json();
    assert.equal(resolved.verification, 'user_attested');
    detail = await (await fetch(`${origin}${base}`, { headers })).json();
    assert.equal(detail.approval.resolved, true);
    assert.equal(calls, 1);
    assert.equal((await post(`${base}/resolve`, { confirm: true, approval_id: approved.id })).status, 400);
    assert.equal((await post(`/api/agent/tasks/${created.id}`, { confirm: true, updated_at: task.updated_at }, 'DELETE')).status, 200);
  } finally { await host.close(); await f.cleanup(); }
});

test('uncertain ATC execution blocks related approvals until explicit user attestation', async () => {
  const f = await fixture();
  const connection = { ...f.connection, write_governance: 'approval_required' as const };
  await f.store.save({ schema_version: 1, connections: [connection], tokens: [] });
  let calls = 0, fail = true;
  Object.assign(f.backend, { quality: async () => {
    calls++;
    if (fail) throw new AppError('ATC_EXECUTION_FAILED', 'Uncertain', { worklist_id: 'WL1' });
    return { run_id: 'RUN2', submission: 'accepted' };
  } });
  const approvals = new WriteApprovalStore(f.directory);
  const first = { tool: 'run_atc' as const, input: { connection_id: connection.connection_id,
    object_uri: object, check_variant: 'DEFAULT', request_id: randomUUID(), confirm_execution: true as const } };
  const second = { ...first, input: { ...first.input, request_id: randomUUID() } };
  const a = await approvals.createOperation(first, targetFingerprint(connection), 'a'.repeat(64), new Date(Date.now() + 60000));
  const b = await approvals.createOperation(second, targetFingerprint(connection), 'b'.repeat(64), new Date(Date.now() + 60000));
  try {
    const result = await f.operations.run(first.tool, { ...first.input, approval_id: a.id });
    assert.equal(result.outcome, 'unknown');
    const status = await approvals.status(a.id);
    assert.equal(status.state, 'completed');
    if (status.state === 'completed') assert.deepEqual(status.result.error?.details, { worklist_id: 'WL1' });
    const blocked = new Operations(f.store, credentials, new AuditLog(f.logDirectory), () => f.backend);
    assert.equal((await blocked.run(second.tool, { ...second.input, approval_id: b.id })).error?.code, 'APPROVAL_RECONCILIATION_REQUIRED');
    assert.equal(calls, 1);
    await blocked.close();
    await approvals.resolve(a.id, new Date().toISOString());
    fail = false;
    const resumed = new Operations(f.store, credentials, new AuditLog(f.logDirectory), () => f.backend);
    assert.equal((await resumed.run(second.tool, { ...second.input, approval_id: b.id })).status, 'success');
    assert.equal(calls, 2);
    await resumed.close();
  } finally { await f.cleanup(); }
});

test('partial batch activation persists per-object results and blocks later source writes', async () => {
  const f = await fixture();
  const connection = { ...f.connection, write_governance: 'approval_required' as const };
  await f.store.save({ schema_version: 1, connections: [connection], tokens: [] });
  f.backend.inactive = 'REPORT ztest.\nWRITE 2.';
  f.backend.activateBatch = async (_objects, dispatch) => {
    await dispatch?.();
    return { success: false, messages: ['activation failed'], inactive: [] };
  };
  const revision = (await f.backend.read(object, 'inactive')).revision;
  const intent = { tool: 'activate_objects' as const, input: { connection_id: connection.connection_id,
    objects: [{ object_uri: object, expected_revision: revision }], request_id: randomUUID() } };
  const approvals = new WriteApprovalStore(f.directory);
  const approval = await approvals.createOperation(intent, targetFingerprint(connection), 'a'.repeat(64), new Date(Date.now() + 60000));
  try {
    const result = await f.operations.run(intent.tool, { ...intent.input, approval_id: approval.id });
    assert.equal(result.outcome, 'partial');
    const state = await approvals.status(approval.id);
    assert.equal(state.state, 'completed');
    if (state.state === 'completed') {
      const details = state.result.error?.details as { results: { object_uri: string; verification: string }[] };
      assert.equal(details.results[0].object_uri, object);
      assert.equal(details.results[0].verification, 'not_activated');
    }
    await assert.rejects(approvals.requireResolved({ connection_id: connection.connection_id, object_uri: object,
      expected_revision: revision, source: 'REPORT ztest.', request_id: randomUUID() }),
    { code: 'APPROVAL_RECONCILIATION_REQUIRED' });
  } finally { await f.cleanup(); }
});

test('controlled operations reject modified intent, changed targets and stale activation revisions', async () => {
  const f = await fixture();
  const connection = { ...f.connection, write_governance: 'approval_required' as const };
  await f.store.save({ schema_version: 1, connections: [connection], tokens: [] });
  let activated = 0;
  f.backend.inactive = 'REPORT ztest.\nWRITE 2.';
  f.backend.activateBatch = async () => { activated++; return { success: true, messages: [] }; };
  const revision = (await f.backend.read(object, 'inactive')).revision;
  const intent = { tool: 'activate_objects' as const, input: { connection_id: connection.connection_id,
    objects: [{ object_uri: object, expected_revision: revision }], request_id: randomUUID() } };
  const approvals = new WriteApprovalStore(f.directory);
  const approval = await approvals.createOperation(intent, targetFingerprint(connection), 'a'.repeat(64), new Date(Date.now() + 60000));
  const run = async (input: typeof intent.input) => {
    const ops = new Operations(f.store, credentials, new AuditLog(f.logDirectory), () => f.backend);
    try { return await ops.run(intent.tool, { ...input, approval_id: approval.id }); } finally { await ops.close(); }
  };
  try {
    assert.equal((await run({ ...intent.input, objects: [{ object_uri: object, expected_revision: 'f'.repeat(64) }] })).error?.code, 'APPROVAL_MISMATCH');
    await f.store.save({ schema_version: 1, connections: [{ ...connection, username: 'OTHER' }], tokens: [] });
    assert.equal((await run(intent.input)).error?.code, 'APPROVAL_MISMATCH');
    await f.store.save({ schema_version: 1, connections: [connection], tokens: [] });
    f.backend.inactive += '\nWRITE 3.';
    const stale = await run(intent.input);
    assert.equal(stale.error?.code, 'VERSION_CONFLICT');
    assert.equal(stale.write_dispatched, false);
    assert.equal(activated, 0);
    assert.equal((await run(intent.input)).error?.code, 'APPROVAL_USED');
  } finally { await f.cleanup(); }
});


test('cache cleanup recreates sessions and retains write replay protection', async () => {
  const f = await fixture();
  let created = 0; let closed = 0;
  const ops = new Operations(f.store, credentials, new AuditLog(f.logDirectory), () => {
    created++; f.backend.close = async () => { closed++; }; return f.backend;
  });
  try {
    const args = { connection_id: f.connection.connection_id, name: 'znew', description: 'test', package_name: '$TMP', request_id: 'same-write' };
    const original = await ops.run('create_program', args);
    assert.equal(original.status, 'success');
    assert.deepEqual(await ops.clearCache(), { cleared_sessions: 1, retained_write_requests: 1 });
    assert.equal(closed, 1);
    assert.equal((await ops.run('create_program', args)).operation_id, original.operation_id);
    assert.equal(created, 1, 'replayed writes must not establish a new session or execute again');
    await ops.run('read_source', { connection_id: args.connection_id, object_uri: object, version: 'active' });
    assert.equal(created, 2);
  } finally { await ops.close(); await f.cleanup(); }
});

test('cache cleanup refuses active work and blocks new requests until session cleanup finishes', async () => {
  const f = await fixture();
  try {
    let finishRead!: () => void;
    const gate = new Promise<void>(resolve => { finishRead = resolve; });
    const read = f.backend.read.bind(f.backend);
    f.backend.read = async (...args) => { await gate; return read(...args); };
    const pending = f.operations.run('read_source', { connection_id: f.connection.connection_id, object_uri: object, version: 'active' });
    await assert.rejects(f.operations.clearCache(), (e: AppError) => e.code === 'BUSY');
    finishRead(); await pending;
    let finishClose!: () => void;
    f.backend.close = () => new Promise<void>(resolve => { finishClose = resolve; });
    const clearing = f.operations.clearCache();
    await assert.rejects(f.operations.run('list_connections', {}), (e: AppError) => e.code === 'BUSY');
    await assert.rejects(f.operations.clearCache(), (e: AppError) => e.code === 'BUSY');
    finishClose(); await clearing;
    assert.equal((await f.operations.run('list_connections', {})).status, 'success');
  } finally { await f.cleanup(); }
});

test('failed cache cleanup reports failure and retains the session for inspection', async () => {
  const f = await fixture();
  try {
    await f.operations.run('read_source', { connection_id: f.connection.connection_id, object_uri: object, version: 'active' });
    f.backend.close = async () => { throw new Error('private backend details'); };
    await assert.rejects(f.operations.clearCache(), (e: AppError) => e.code === 'CACHE_CLEAR_FAILED' && !e.message.includes('private'));
    f.backend.close = async () => {};
    assert.equal((await f.operations.clearCache()).cleared_sessions, 1);
  } finally { await f.cleanup(); }
});

test('source save reports accepted writes when readback fails, without inventing a revision', async () => {
  const f = await fixture(); try {
    const read = f.backend.read.bind(f.backend);
    f.backend.read = async (uri, version) => {
      if (version === 'inactive' && f.backend.saves) throw new AppError('OUTCOME_UNKNOWN', 'Read failed');
      return read(uri, version);
    };
    const result = await f.operations.run('update_source', { connection_id: f.connection.connection_id,
      source_uri: source, source: 'REPORT ztest. WRITE 1.',
      expected_revision: (await read(object, 'active')).revision, request_id: 'readback-failure' });
    assert.equal(result.status, 'error'); assert.equal(result.outcome, 'partial');
    assert.equal(result.source_save?.saved, true);
    assert.equal(result.source_save?.verification, 'unavailable');
    assert.equal(result.source_save?.inactive_revision, undefined);
    assert.equal(f.backend.unlocks, 1);
  } finally { await f.cleanup(); }
});

test('source save reports unknown dispatched outcomes and adds contextual signature hints only for module scanner errors', async () => {
  for (const module of [true, false]) {
    const f = await fixture(); try {
      const uri = module ? '/sap/bc/adt/functions/groups/zgroup/fmodules/zmodule' : object;
      const submitted = 'FUNCTION ZMODULE\n  EXCEPTIONS INVALID_INPUT = 1.\nENDFUNCTION.';
      let received = '';
      f.backend.save = async (_uri, code) => {
        received = code; f.backend.saves++;
        throw AdtErrorException.create(400, { 'T100KEY-ID': 'EU', 'T100KEY-NO': '271' },
          'ExceptionResourceScanDuringSaveFailure', 'Do not use special characters');
      };
      const result = await f.operations.run('update_source', { connection_id: f.connection.connection_id,
        source_uri: `${uri}/source/main`, source: submitted,
        expected_revision: (await f.backend.read(uri, 'active')).revision, request_id: 'scan-failure' });
      assert.equal(result.error?.code, 'ADT_ERROR');
      assert.equal(result.source_save?.saved, 'unknown');
      assert.equal(result.source_save?.verification, 'not_run');
      assert.equal(result.source_save?.inactive_revision, undefined);
      const details = result.error?.details as { hints?: string[]; sap_message_number?: string };
      assert.equal(details.sap_message_number, '271');
      assert.equal(Boolean(details.hints?.some(h => h.includes('never name = 1'))), module);
      assert.equal(received, submitted); assert.equal(f.backend.unlocks, 1);
    } finally { await f.cleanup(); }
  }
});

test('connections expose system identity without exposing credentials', async () => {
  const f = await fixture(); try {
    const result = await f.operations.run('list_connections', {});
    assert.deepEqual(result.data, [{ connection_id: f.connection.connection_id, name: 'dev',
      base_url: 'http://sap.test:8000', client: '001', language: 'EN', username: 'TEST', write_enabled: true, write_policy: 'enabled', allow_table_data: true }]);
    assert.equal(JSON.stringify(result.data).includes('fake'), false);
  } finally { await f.cleanup(); }
});

test('object URI saves discover the source under lock and reject ambiguous URIs', async () => {
  const f = await fixture(); try {
    const revision = (await f.backend.read(object, 'active')).revision;
    for (const args of [{}, { object_uri: object, source_uri: '/sap/bc/adt/programs/programs/other/source/main' },
      { object_uri: source }]) {
      const bad = await f.operations.run('update_source', { connection_id: f.connection.connection_id,
        ...args, source: 'REPORT ztest.', expected_revision: revision, request_id: randomUUID() });
      assert.equal(bad.error?.code, 'INVALID_URI'); assert.equal(f.backend.saves, 0);
    }
    const read = f.backend.read.bind(f.backend);
    f.backend.read = async (uri, version) => {
      assert.equal(f.backend.locks > f.backend.unlocks, true);
      return read(uri, version);
    };
    const saved = await f.operations.run('update_source', { connection_id: f.connection.connection_id,
      object_uri: object, source: 'REPORT ztest. WRITE 1.', expected_revision: revision, request_id: 'object-save' });
    assert.equal(saved.status, 'success'); assert.equal(saved.source_save?.source_uri, source);
    assert.equal(f.backend.saves, 1);
  } finally { await f.cleanup(); }
});

test('version conflicts provide observed revisions and safe read guidance without saving', async () => {
  const f = await fixture(); try {
    const active = await f.backend.read(object, 'active');
    f.backend.inactive = 'REPORT ztest. WRITE 2.';
    const draft = await f.backend.read(object, 'inactive');
    const result = await f.operations.run('update_source', { connection_id: f.connection.connection_id,
      object_uri: object, source: 'REPORT ztest. WRITE 3.', expected_revision: active.revision, request_id: 'draft-conflict' });
    assert.equal(result.error?.code, 'VERSION_CONFLICT'); assert.equal(f.backend.saves, 0);
    const details = result.error?.details as any;
    assert.equal(details.active_revision, active.revision); assert.equal(details.inactive_revision, draft.revision);
    assert.equal(details.next_action.arguments.version, 'inactive');
    assert.ok(details.guidance.includes('Do not blindly overwrite'));
    f.backend.inactive = undefined;
    const stale = await f.operations.run('update_source', { connection_id: f.connection.connection_id,
      object_uri: object, source: 'REPORT ztest.', expected_revision: '0'.repeat(64), request_id: 'stale-no-draft' });
    assert.equal(stale.error?.code, 'VERSION_CONFLICT');
    assert.equal((stale.error?.details as any).inactive_revision, undefined);
    assert.equal((stale.error?.details as any).next_action.arguments.version, 'active');
    assert.equal(f.backend.saves, 0);
  } finally { await f.cleanup(); }
});

test('missing inactive source suggests an explicit active read without silently switching versions', async () => {
  const f = await fixture(); try {
    const result = await f.operations.run('read_source', { connection_id: f.connection.connection_id, object_uri: object, version: 'inactive' });
    assert.equal(result.status, 'error'); assert.equal(result.error?.code, 'VERSION_UNAVAILABLE');
    assert.equal(result.data, undefined);
    const details = result.error?.details as any;
    assert.equal(details.requested_version, 'inactive');
    assert.deepEqual(details.next_action, { tool: 'read_source', arguments: { connection_id: f.connection.connection_id, object_uri: object, version: 'active' } });
    assert.ok(details.guidance.includes('No version fallback'));
    const active = await f.operations.run(details.next_action.tool, details.next_action.arguments);
    assert.equal(active.status, 'success'); assert.equal((active.data as any).version, 'active');
    f.backend.read = async () => { throw new AppError('VERSION_UNAVAILABLE', 'No active version'); };
    const unavailableActive = await f.operations.run('read_source', { connection_id: f.connection.connection_id, object_uri: object, version: 'active' });
    assert.equal((unavailableActive.error?.details as any)?.next_action, undefined);
    f.backend.read = async () => { throw new AppError('AUTH_FAILED', 'Login failed'); };
    const auth = await f.operations.run('read_source', { connection_id: f.connection.connection_id, object_uri: object, version: 'inactive' });
    assert.equal(auth.error?.code, 'AUTH_FAILED'); assert.equal((auth.error?.details as any)?.next_action, undefined);
  } finally { await f.cleanup(); }
});

test('creation returns actionable read instructions without inventing a source URI', async () => {
  const f = await fixture(); try {
    const result = await f.operations.run('create_program', { connection_id: f.connection.connection_id,
      name: 'ZTEST', description: 'Test', package_name: '$TMP', request_id: 'create-guide' });
    const data = result.data as any;
    assert.equal(data.source_uri, undefined); assert.equal(data.next_action.tool, 'read_source');
    const read = await f.operations.run(data.next_action.tool, data.next_action.arguments);
    assert.equal(read.status, 'success'); assert.equal((read.data as any).source_uri, source);
  } finally { await f.cleanup(); }
});

test('transport creation is guarded, verified and replayed without creating twice', async () => {
  const f = await fixture(); try {
    let creates = 0; let verification = 0;
    const b: Backend = f.backend;
    b.createTransportRequest = async (uri, pkg, description) => {
      assert.equal(uri, object); assert.equal(pkg, 'ZPACKAGE'); assert.equal(description, 'New development');
      creates++; return 'DEVK900001';
    };
    b.verifyTransportRequest = async number => {
      assert.equal(number, 'DEVK900001'); verification++;
      return { request_number: number, owner: 'TEST', status: 'modifiable',
        tasks: [{ task_number: 'DEVK900002', owner: 'TEST', status: 'modifiable' }], tasks_truncated: false };
    };
    const args = { connection_id: f.connection.connection_id, object_uri: object, package_name: 'ZPACKAGE',
      description: 'New development', request_id: 'new-transport' };
    const result = await f.operations.run('create_transport_request', args);
    assert.equal(result.status, 'success'); assert.equal(result.outcome, 'confirmed');
    assert.equal((result.data as any).request_number, 'DEVK900001');
    assert.equal((result.data as any).tasks[0].task_number, 'DEVK900002');
    assert.equal((result.data as any).released, false); assert.equal(f.backend.saves, 0);
    assert.deepEqual(await f.operations.run('create_transport_request', args), result);
    assert.equal(creates, 1); assert.equal(verification, 1);
    await assert.rejects(f.operations.run('create_transport_request', { ...args, description: 'Changed' }), /already used/);
    const config = await f.store.load(); config.connections[0].write_enabled = false; await f.store.save(config);
    const disabled = await f.operations.run('create_transport_request', { ...args, request_id: 'disabled-transport' });
    assert.equal(disabled.error?.code, 'WRITE_DISABLED'); assert.equal(creates, 1);
  } finally { await f.cleanup(); }
});

test('transport readback failures retain the created number and never auto-recreate', async () => {
  for (const failure of ['not-found', 'read-error', 'unknown-create']) {
    const f = await fixture(); try {
      let creates = 0;
      const b: Backend = f.backend;
      b.createTransportRequest = async () => {
        creates++;
        if (failure === 'unknown-create') throw new AppError('OUTCOME_UNKNOWN', 'Connection interrupted');
        return 'DEVK900001';
      };
      b.verifyTransportRequest = async () => {
        if (failure === 'read-error') throw new Error('Readback failed');
        return undefined;
      };
      const args = { connection_id: f.connection.connection_id, object_uri: object, package_name: 'ZPACKAGE',
        description: 'Test', request_id: 'uncertain-transport' };
      const result = await f.operations.run('create_transport_request', args);
      assert.equal(result.status, 'error');
      assert.equal(result.outcome, failure === 'unknown-create' ? 'unknown' : 'partial');
      if (failure !== 'unknown-create') {
        assert.equal(result.error?.code, 'TRANSPORT_VERIFY_FAILED');
        assert.equal((result.error?.details as any).transport_number, 'DEVK900001');
        assert.equal((result.error?.details as any).created, true);
      }
      await f.operations.run('create_transport_request', args);
      assert.equal(creates, 1); assert.equal(f.backend.saves, 0);
    } finally { await f.cleanup(); }
  }
});

test('local packages, ambiguous CTS checks and unavailable audit logs cannot create transports', async () => {
  const f = await fixture(); try {
    let creates = 0; const b: Backend = f.backend;
    b.createTransportRequest = async () => { creates++; return 'DEVK900001'; };
    b.verifyTransportRequest = async () => undefined;
    const args = { connection_id: f.connection.connection_id, object_uri: object, package_name: '$TMP', description: 'Test' };
    assert.equal((await f.operations.run('create_transport_request', { ...args, request_id: 'tmp-transport' })).error?.code, 'TRANSPORT_NOT_REQUIRED');
    f.backend.transportRequirement = async () => 'not_required';
    assert.equal((await f.operations.run('create_transport_request', { ...args, package_name: 'TEST_LOCAL', request_id: 'local-transport' })).error?.code, 'TRANSPORT_NOT_REQUIRED');
    f.backend.transportRequirement = async () => { throw new AppError('TRANSPORT_CHECK_UNAVAILABLE', 'Unknown CTS state'); };
    assert.equal((await f.operations.run('create_transport_request', { ...args, package_name: 'ZPACKAGE', request_id: 'unknown-transport' })).write_dispatched, false);
    f.backend.transportRequirement = async () => 'required';
    const badLog = join(f.directory, 'blocked-log'); await writeFile(badLog, 'not a directory');
    const ops = new Operations(f.store, credentials, new AuditLog(badLog), () => b);
    try {
      assert.equal((await ops.run('create_transport_request', { ...args, package_name: 'ZPACKAGE', request_id: 'log-transport' })).error?.code, 'LOG_UNAVAILABLE');
    } finally { await ops.close(); }
    assert.equal(creates, 0);
  } finally { await f.cleanup(); }
});

test('SAP stripping the final newline succeeds and returns the actual saved revision', async () => {
  const f = await fixture(); try {
    f.backend.save = async (_uri, code) => { f.backend.saves++; f.backend.inactive = code.replace(/[\r\n]+$/, ''); };
    const result = await f.operations.run('update_source', { connection_id: f.connection.connection_id,
      source_uri: source, source: 'REPORT ztest.\r\n* test\r\n',
      expected_revision: (await f.backend.read(object, 'active')).revision, request_id: 'normalized-save' });
    assert.equal(result.status, 'success'); assert.equal(result.outcome, 'confirmed');
    assert.equal(result.source_save?.saved, true); assert.equal(result.source_save?.verification, 'passed');
    assert.deepEqual(result.data, { ...await f.backend.read(object, 'inactive'), activated: false });
  } finally { await f.cleanup(); }
});

test('save verification still fails for changed program content', async () => {
  const f = await fixture(); try {
    f.backend.save = async () => { f.backend.saves++; f.backend.inactive = 'REPORT ztest. WRITE 99.'; };
    const result = await f.operations.run('update_source', { connection_id: f.connection.connection_id,
      source_uri: source, source: 'REPORT ztest. WRITE 1.\r\n',
      expected_revision: (await f.backend.read(object, 'active')).revision, request_id: 'changed-content' });
    assert.equal(result.error?.code, 'VERIFY_FAILED'); assert.equal(result.outcome, 'partial');
    assert.equal(result.source_save?.saved, true);
    assert.equal(result.source_save?.verification, 'failed');
    assert.equal(result.source_save?.inactive_revision, (await f.backend.read(object, 'inactive')).revision);
    assert.equal(result.source_save?.object_uri, object);
    assert.ok(result.source_save?.next_action?.includes('do not blindly retry'));
    const replay = await f.operations.run('update_source', { connection_id: f.connection.connection_id,
      source_uri: source, source: 'REPORT ztest. WRITE 1.\r\n',
      expected_revision: (await f.backend.read(object, 'active')).revision, request_id: 'changed-content' });
    assert.deepEqual(replay.source_save, result.source_save);
    assert.equal(f.backend.saves, 1);
  } finally { await f.cleanup(); }
});

test('activation verification accepts SAP removing final line breaks', async () => {
  const f = await fixture(); try {
    f.backend.inactive = 'REPORT ztest.\r\n* test\r\n';
    f.backend.activate = async () => {
      f.backend.active = f.backend.inactive!.replace(/[\r\n]+$/, '');
      f.backend.inactive = undefined; return { success: true, messages: [] };
    };
    const result = await f.operations.run('activate_objects', { connection_id: f.connection.connection_id,
      objects: [{ object_uri: object, expected_revision: (await f.backend.read(object, 'inactive')).revision }], request_id: 'normalized-activation' });
    assert.equal(result.status, 'success'); assert.ok(result.completed_steps.includes('activation_verified'));
  } finally { await f.cleanup(); }
});

test('activation releases the editor lock before calling SAP activation', async () => {
  const f = await fixture(); try {
    f.backend.inactive = 'REPORT ztest.\n* activation test';
    const original = f.backend.activate.bind(f.backend);
    f.backend.activate = async () => {
      assert.equal(f.backend.locks, f.backend.unlocks, 'Editor lock must be released before activation');
      return original();
    };
    const result = await f.operations.run('activate_objects', { connection_id: f.connection.connection_id,
      objects: [{ object_uri: object, expected_revision: (await f.backend.read(object, 'inactive')).revision }], request_id: 'unlock-first' });
    assert.equal(result.status, 'success');
    assert.ok(result.completed_steps.indexOf('unlocked') < result.completed_steps.indexOf('activated'));
  } finally { await f.cleanup(); }
});

test('activation stops when lock release fails or the source changes after unlocking', async () => {
  for (const failUnlock of [true, false]) {
    const f = await fixture(); try {
      f.backend.inactive = 'REPORT ztest.\n* original';
      const revision = (await f.backend.read(object, 'inactive')).revision;
      let activations = 0;
      f.backend.activate = async () => { activations++; return { success: true, messages: [] }; };
      f.backend.failUnlock = failUnlock;
      if (!failUnlock) f.backend.unlock = async () => { f.backend.unlocks++; f.backend.inactive += '\n* concurrent edit'; };
      const result = await f.operations.run('activate_objects', { connection_id: f.connection.connection_id,
        objects: [{ object_uri: object, expected_revision: revision }], request_id: 'activation-blocked' });
      assert.equal(result.error?.code, failUnlock ? 'LOCK_CLEANUP_FAILED' : 'VERSION_CONFLICT');
      assert.equal(activations, 0);
    } finally { await f.cleanup(); }
  }
});

test('normalization preserves client and rejects URL credentials/custom paths', () => {
  assert.equal(normalizeUrl('http://sap.test:8000/sap/bc/adt/'), 'http://sap.test:8000');
  assert.equal(normalizeUrl('https://sap.test:443/sap/bc/adt/'), 'https://sap.test');
  for (const url of ['http://user:secret@sap.test', 'https://user:secret@sap.test', 'ftp://sap.test', 'https://sap.test/other', 'http://sap.test/other', 'http://sap.test?q=1'])
    assert.throws(() => normalizeUrl(url));
});
test('ADT paths reject traversal, queries, remote URLs and double encoding', () => {
  assert.equal(adtUri(source), source);
  for (const uri of ['http://evil.test', '/sap/bc/adt/../x', '/sap/bc/adt/%2e%2e/x', '/sap/bc/adt/%252e%252e/x', '/sap/bc/adt/a?x', '/sap/bc/adt/a%5cb'])
    assert.throws(() => adtUri(uri));
});
test('tokens are stored hashed and revocation takes effect', async () => {
  const f = await fixture(); try {
    const { token } = await f.store.createToken();
    assert.equal(await f.store.authenticate(token), true);
    assert.equal(await f.store.authenticate('wrong'), false);
    assert.equal((await readFile(join(f.directory, 'config.json'), 'utf8')).includes(token), false);
    const config = await f.store.load(); config.tokens = []; await f.store.save(config);
    assert.equal(await f.store.authenticate(token), false);
  } finally { await f.cleanup(); }
});
test('obsolete package restrictions are rejected instead of silently ignored', async () => {
  const f = await fixture(); try {
    const config = await f.store.load();
    const legacy = { ...config, connections: [{ ...config.connections[0], allowed_packages: ['$TMP'] }] };
    await writeFile(join(f.directory, 'config.json'), JSON.stringify(legacy));
    await assert.rejects(f.store.load(), /allowed_packages/);
  } finally { await f.cleanup(); }
});
test('concurrent duplicate updates save once, unlock and log no source or handle', async () => {
  const f = await fixture(); try {
    const original = await f.backend.read(object, 'active');
    const args = { connection_id: f.connection.connection_id, source_uri: source, source: 'REPORT ztest.\nWRITE 1.',
      expected_revision: original.revision, request_id: 'one' };
    const [a, b] = await Promise.all([f.operations.run('update_source', args), f.operations.run('update_source', args)]);
    assert.equal(a.operation_id, b.operation_id); assert.equal(b.status, 'success');
    assert.equal((b.data as { source?: string }).source, undefined);
    assert.equal(a.status, 'success'); assert.equal(f.backend.saves, 1); assert.equal(f.backend.unlocks, 1);
    const text = await readFile(join(f.logDirectory, (await readdir(f.logDirectory))[0]), 'utf8');
    assert.ok(text.trim().split('\n').every(line => JSON.parse(line).operation_id));
    assert.equal(text.includes(args.source), false); assert.equal(text.includes('private-lock-handle'), false);
    await assert.rejects(f.operations.run('update_source', { ...args, source: 'different' }), /Request ID/);
  } finally { await f.cleanup(); }
});
test('stale revision and existing inactive draft do not overwrite code', async () => {
  const f = await fixture(); try {
    const revision = (await f.backend.read(object, 'active')).revision;
    f.backend.inactive = 'REPORT ztest. WRITE 99.';
    const result = await f.operations.run('update_source', { connection_id: f.connection.connection_id, source_uri: source,
      expected_revision: revision, source: 'REPORT ztest. WRITE 1.', request_id: 'conflict' });
    assert.equal(result.error?.code, 'VERSION_CONFLICT'); assert.equal(f.backend.saves, 0); assert.equal(f.backend.unlocks, 1);
  } finally { await f.cleanup(); }
});
test('SAP checks allow other local packages and stop required or unknown transport writes', async () => {
  const f = await fixture(); try {
    f.backend.packageOf = async () => 'TEST_LOCAL';
    const checks: string[] = [];
    f.backend.transportRequirement = async () => { checks.push('check'); return 'not_required'; };
    const created = await f.operations.run('create_program', { connection_id: f.connection.connection_id,
      name: 'ZTEST', description: 'Local', package_name: 'TEST_LOCAL', request_id: 'local-create' });
    assert.equal(created.status, 'success');
    const revision = (await f.backend.read(object, 'inactive')).revision;
    const args = { connection_id: f.connection.connection_id, object_uri: object,
      source: 'REPORT ztest. WRITE 1.', expected_revision: revision };
    const saved = await f.operations.run('update_source', { ...args, request_id: 'local-update' });
    assert.equal(saved.status, 'success'); assert.equal(checks.length, 2);
    const saves = f.backend.saves; const locks = f.backend.locks;
    f.backend.transportRequirement = async () => 'required';
    const required = await f.operations.run('update_source', { ...args, request_id: 'required-update' });
    assert.equal(required.error?.code, 'TRANSPORT_REQUIRED');
    f.backend.transportRequirement = async () => { throw new Error('Check failed'); };
    const unknown = await f.operations.run('update_source', { ...args, request_id: 'unknown-update' });
    assert.equal(unknown.error?.code, 'TRANSPORT_CHECK_UNAVAILABLE');
    assert.equal(f.backend.saves, saves); assert.equal(f.backend.locks, locks);
    assert.equal(unknown.write_dispatched, false);
    const explicit = await f.operations.run('update_source', { ...args,
      expected_revision: (await f.backend.read(object, 'inactive')).revision,
      transport_task: 'DEVK900001', request_id: 'explicit-update' });
    assert.equal(explicit.status, 'success');
  } finally { await f.cleanup(); }
});

test('disabled writes fail before locks; SAP-recorded packages require transport tasks', async () => {
  const f = await fixture(); try {
    const config = await f.store.load(); config.connections[0].write_enabled = false; await f.store.save(config);
    let result = await f.operations.run('create_program', { connection_id: f.connection.connection_id, name: 'ZTEST',
      package_name: '$TMP', description: 'Test', request_id: 'disabled' });
    assert.equal(result.error?.code, 'WRITE_DISABLED');
    config.connections[0].write_enabled = true; await f.store.save(config);
    result = await f.operations.run('create_program', { connection_id: f.connection.connection_id,
      name: 'ZTEST', package_name: 'ZOTHER', description: 'Test', request_id: 'no-transport' });
    assert.equal(result.error?.code, 'TRANSPORT_REQUIRED'); assert.equal(f.backend.locks, 0);
    result = await f.operations.run('create_program', { connection_id: f.connection.connection_id,
      name: 'ZTEST', package_name: 'ZOTHER', description: 'Test', transport_task: 'DEVK900001', request_id: 'any-package' });
    assert.equal(result.status, 'success');
  } finally { await f.cleanup(); }
});
test('unlock failure preserves confirmed save and returns warning', async () => {
  const f = await fixture(); try {
    f.backend.failUnlock = true;
    const result = await f.operations.run('update_source', { connection_id: f.connection.connection_id, source_uri: source,
      source: 'REPORT ztest. WRITE 2.', expected_revision: (await f.backend.read(object, 'active')).revision, request_id: 'unlock' });
    assert.equal(result.status, 'success'); assert.equal(result.outcome, 'confirmed');
    assert.ok(result.warnings?.includes('LOCK_CLEANUP_FAILED'));
    await assert.rejects(f.operations.clearCache(), (e: AppError) => e.code === 'SESSION_NEEDS_REVIEW');
    const blocked = await f.operations.run('create_program', { connection_id: f.connection.connection_id,
      name: 'ZOTHER', description: 'Test', package_name: '$TMP', request_id: 'after-unlock-failure' });
    assert.equal(blocked.error?.code, 'SESSION_NEEDS_REVIEW');
  } finally { await f.cleanup(); }
});
test('unknown write results are not retried, and locks are released', async () => {
  const f = await fixture(); try {
    f.backend.uncertain = true;
    const args = { connection_id: f.connection.connection_id, source_uri: source,
      source: 'REPORT ztest. WRITE 3.', expected_revision: (await f.backend.read(object, 'active')).revision, request_id: 'timeout' };
    const a = await f.operations.run('update_source', args); const b = await f.operations.run('update_source', args);
    assert.equal(a.outcome, 'unknown'); assert.equal(a.error?.code, 'OUTCOME_UNKNOWN');
    assert.equal(JSON.stringify(a), JSON.stringify(b));
    assert.equal(f.backend.saves, 1); assert.equal(f.backend.unlocks, 1);
  } finally { await f.cleanup(); }
});
test('failed activation reports partial state and preserves inactive code', async () => {
  const f = await fixture(); try {
    f.backend.inactive = 'REPORT ztest. WRITE 4.'; f.backend.activationPass = false;
    const result = await f.operations.run('activate_objects', { connection_id: f.connection.connection_id, request_id: 'activate',
      objects: [{ object_uri: object, expected_revision: (await f.backend.read(object, 'inactive')).revision }] });
    assert.equal(result.error?.code, 'ACTIVATION_FAILED'); assert.equal(result.outcome, 'partial');
    assert.ok(f.backend.inactive); assert.equal(f.backend.unlocks, 1);
  } finally { await f.cleanup(); }
});
test('log unavailable prevents SAP mutation', async () => {
  const f = await fixture(); try {
    const ops = new Operations(f.store, credentials, { append: async () => { throw new Error('Disk failed'); } } as AuditLog, () => f.backend);
    const result = await ops.run('create_program', { connection_id: f.connection.connection_id, name: 'ZTEST', package_name: '$TMP',
      description: 'Test', request_id: 'no-log' });
    assert.equal(result.error?.code, 'LOG_UNAVAILABLE'); assert.equal(f.backend.inactive, undefined); await ops.close();
  } finally { await f.cleanup(); }
});
test('logging failure after SAP save preserves the known result', async () => {
  const f = await fixture(); try {
    let count = 0;
    const ops = new Operations(f.store, credentials, { append: async () => {
      count++; if (count >= 3) throw new Error('Disk failed after saving');
    } } as AuditLog, () => f.backend);
    const result = await ops.run('update_source', { connection_id: f.connection.connection_id,
      source_uri: source, source: 'REPORT ztest. WRITE 5.', expected_revision: (await f.backend.read(object, 'active')).revision,
      request_id: 'log-after-save' });
    assert.equal(result.status, 'success'); assert.equal(result.outcome, 'confirmed');
    assert.ok(result.warnings?.includes('LOG_WRITE_FAILED')); assert.equal(f.backend.saves, 1); await ops.close();
  } finally { await f.cleanup(); }
});
test('shutdown waits for queued operations and prevents new work', async () => {
  const f = await fixture(); try {
    const pending = f.operations.run('read_source', { connection_id: f.connection.connection_id, object_uri: object });
    const closing = f.operations.close();
    await assert.rejects(f.operations.run('list_connections', {}), /stopping/);
    assert.equal((await pending).status, 'success'); await closing;
  } finally { await f.cleanup(); }
});

test('failed cached read session is recreated once and the read succeeds', async () => {
  const f = await fixture();
  let created = 0;
  const ops = new Operations(f.store, credentials, new AuditLog(f.logDirectory), () => {
    created++;
    const b = new FakeBackend(f.connection.connection_id);
    if (created === 1) {
      let reads = 0;
      const read = b.read.bind(b);
      b.read = async (uri, version) => {
        if (++reads > 1) throw new AppError('ADT_ERROR', 'Stale stateful session');
        return read(uri, version);
      };
    }
    return b;
  });
  try {
    const args = { connection_id: f.connection.connection_id, object_uri: object, version: 'active' as const };
    assert.equal((await ops.run('read_source', args)).status, 'success');
    const recovered = await ops.run('read_source', args);
    assert.equal(recovered.status, 'success'); assert.ok(recovered.completed_steps.includes('session_recreated'));
    assert.equal(created, 2);
  } finally { await ops.close(); await f.cleanup(); }
});

test('writes replace cached sessions and validate the new session before dispatch', async () => {
  const f = await fixture();
  const events: string[] = [];
  let created = 0;
  const ops = new Operations(f.store, credentials, new AuditLog(f.logDirectory), () => {
    const number = ++created;
    const b = new FakeBackend(f.connection.connection_id);
    b.close = async () => { events.push(`close-${number}`); };
    b.capabilities = async () => {
      events.push(`check-${number}`);
      if (number === 1) throw new AppError('AUTH_FAILED', 'Cached session expired');
      return { available: true };
    };
    b.create = async () => { events.push(`create-${number}`); return object; };
    return b;
  });
  try {
    await ops.run('read_source', { connection_id: f.connection.connection_id, object_uri: object });
    const args = { connection_id: f.connection.connection_id, name: 'ZTEST', description: 'Test', package_name: '$TMP', request_id: 'fresh-write' };
    const result = await ops.run('create_program', args);
    assert.equal(result.status, 'success'); assert.equal(result.write_dispatched, true);
    assert.deepEqual(events, ['close-1', 'check-2', 'create-2']);
    assert.ok(result.completed_steps.includes('write_session_ready'));
    assert.deepEqual(await ops.run('create_program', args), result); assert.equal(created, 2);
  } finally { await ops.close(); await f.cleanup(); }
});

test('failed write preflight sends no mutation or lock and its failed session is discarded', async () => {
  const f = await fixture();
  let created = 0;
  const ops = new Operations(f.store, credentials, new AuditLog(f.logDirectory), () => {
    created++;
    if (created === 1) f.backend.capabilities = async () => { throw new AppError('AUTH_FAILED', 'Login failed'); };
    else f.backend.capabilities = async () => ({ available: true });
    return f.backend;
  });
  try {
    const args = { connection_id: f.connection.connection_id, source_uri: source, source: 'REPORT ztest. WRITE 1.',
      expected_revision: (await f.backend.read(object, 'active')).revision, request_id: 'preflight-failed' };
    const result = await ops.run('update_source', args);
    assert.equal(result.error?.code, 'AUTH_FAILED'); assert.equal(result.write_dispatched, false);
    assert.equal(f.backend.saves, 0); assert.equal(f.backend.locks, 0);
    assert.equal((await ops.run('update_source', { ...args, request_id: 'explicit-new-attempt' })).status, 'success');
    assert.equal(created, 2); assert.equal(f.backend.saves, 1);
  } finally { await ops.close(); await f.cleanup(); }
});

test('fresh session read failure and cached write failure are never automatically replayed', async () => {
  const f = await fixture();
  let created = 0;
  const ops = new Operations(f.store, credentials, new AuditLog(f.logDirectory), () => {
    created++; return f.backend;
  });
  try {
    f.backend.read = async () => { throw new AppError('ADT_ERROR', 'Read failed'); };
    assert.equal((await ops.run('read_source', { connection_id: f.connection.connection_id, object_uri: object })).status, 'error');
    assert.equal(created, 1);
    let attempts = 0;
    f.backend.create = async () => { attempts++; throw new AppError('ADT_ERROR', 'Write failed'); };
    const result = await ops.run('create_program', { connection_id: f.connection.connection_id, name: 'ZTEST',
      description: 'Test', package_name: '$TMP', request_id: 'no-write-replay' });
    assert.equal(result.status, 'error'); assert.equal(attempts, 1); assert.equal(created, 2);
  } finally { await ops.close(); await f.cleanup(); }
});
test('Include source uses the same guarded update and activation workflow', async () => {
  const f = await fixture();
  try {
    const uri = '/sap/bc/adt/programs/includes/zinclude';
    const original = await f.backend.read(uri, 'active');
    const updated = await f.operations.run('update_source', { connection_id: f.connection.connection_id,
      source_uri: `${uri}/source/main`, source: '* include change', expected_revision: original.revision, request_id: 'include-save' });
    assert.equal(updated.status, 'success'); assert.equal(f.backend.saves, 1); assert.equal(f.backend.unlocks, 1);
    const saved = await f.backend.read(uri, 'inactive');
    const activated = await f.operations.run('activate_objects', { connection_id: f.connection.connection_id,
      objects: [{ object_uri: uri, expected_revision: saved.revision }], request_id: 'include-activate' });
    assert.equal(activated.status, 'success'); assert.equal(f.backend.active, '* include change');
    assert.equal(f.backend.unlocks, 2);
  } finally { await f.cleanup(); }
});
test('create tool forwards selected program kind and preserves the REPORT default', async () => {
  const f = await fixture(); const kinds: unknown[] = [];
  f.backend.create = async (...args: unknown[]) => { kinds.push(args[4]); return object; };
  try {
    const base = { connection_id: f.connection.connection_id, name: 'ZTEST', description: 'Test', package_name: '$TMP' };
    const defaultResult = await f.operations.run('create_program', { ...base, request_id: 'default-kind' });
    const includeResult = await f.operations.run('create_program', { ...base, program_kind: 'include', request_id: 'include-kind' });
    assert.deepEqual(kinds, ['report', 'include']);
    assert.equal((defaultResult.data as { program_kind: string }).program_kind, 'report');
    assert.equal((includeResult.data as { program_kind: string }).program_kind, 'include');
  } finally { await f.cleanup(); }
});

test('request cache omits large source and rejects new writes at capacity without evicting old IDs', async () => {
  const f = await fixture();
  const ops = new Operations(f.store, credentials, new AuditLog(f.logDirectory), () => f.backend, 1);
  try {
    const args = { connection_id: f.connection.connection_id, source_uri: source,
      source: 'REPORT ztest.\n' + 'x'.repeat(256 * 1024),
      expected_revision: (await f.backend.read(object, 'active')).revision, request_id: 'large' };
    const first = await ops.run('update_source', args);
    assert.equal((first.data as { source: string }).source, args.source);
    const duplicate = await ops.run('update_source', args);
    assert.equal(duplicate.operation_id, first.operation_id);
    assert.equal((duplicate.data as { source?: string }).source, undefined);
    assert.ok(Buffer.byteLength(JSON.stringify(duplicate)) <= 32 * 1024);
    await assert.rejects(ops.run('update_source', { ...args, request_id: 'new' }), /cache is full/);
    assert.equal((await ops.run('update_source', args)).operation_id, first.operation_id);
    assert.equal(f.backend.saves, 1);
  } finally { await ops.close(); await f.cleanup(); }
});

test('authentication counts toward concurrency even for invalid tokens, and releases slots after rejection', async () => {
  const f = await fixture();
  const original = f.store.authenticate.bind(f.store);
  let releaseGate!: () => void;
  const gate = new Promise<void>(resolve => { releaseGate = resolve; });
  let reached!: () => void;
  const occupied = new Promise<void>(resolve => { reached = resolve; });
  let calls = 0;
  f.store.authenticate = async () => { calls++; if (calls === 16) reached(); await gate; return false; };
  const runtime = await startHttp(f.store, f.operations, 0);
  const address = runtime.listener.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/mcp`;
  const options = { method: 'POST', headers: { Authorization: 'Bearer invalid' } };
  const pending = Array.from({ length: 16 }, () => fetch(url, options));
  try {
    await occupied;
    assert.equal((await fetch(url, options)).status, 503);
    assert.equal(calls, 16);
    releaseGate();
    assert.ok((await Promise.all(pending)).every(response => response.status === 401));
    f.store.authenticate = original;
    assert.equal((await fetch(url, options)).status, 401);
  } finally { releaseGate(); await Promise.allSettled(pending); await runtime.close(); await f.cleanup(); }
});

test('real MCP SDK HTTP client initializes, lists tools and reads source; HTTP rejects bad auth/origin', async () => {
  const f = await fixture();
  const token = await f.store.createToken(); const runtime = await startHttp(f.store, f.operations, 0);
  const address = runtime.listener.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/mcp`;
  const client = new Client({ name: 'test-client', version: '1.0' });
  try {
    assert.equal((await fetch(url, { method: 'POST' })).status, 401);
    assert.equal((await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token.token}`, Origin: 'http://evil.test' } })).status, 403);
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token.token}` } } }));
    const expectedVersion = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')).version;
    assert.equal(client.getServerVersion()?.version, expectedVersion);
    const instructions = client.getInstructions()!;
    assert.ok(instructions.includes('untrusted data'));
    assert.ok(instructions.includes('VERSION_CONFLICT'));
    assert.ok(instructions.includes('runtime enablement'));
    const listedTools = (await client.listTools()).tools;
    assert.equal(listedTools.length, Object.keys(toolSchemas).length);
    assert.equal(listedTools.some(tool => tool.name.startsWith('approval_') || tool.name.startsWith('workflow_')), false);
    for (const tool of listedTools) assert.equal(Object.hasOwn(tool.inputSchema.properties ?? {}, 'approval_id'), false);
    const queryTableTool = listedTools.find(t => t.name === 'query_table')!;
    assert.ok((queryTableTool.inputSchema.properties?.filters as { description?: string }).description?.includes('AND-combined'));
    assert.ok((queryTableTool.inputSchema.properties?.connection_id as { description?: string }).description?.includes('list_connections'));
    for (const name of ['query_table', 'query_sql', 'search_enhancements']) {
      const tool = listedTools.find(t => t.name === name)!;
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.equal(tool.annotations?.destructiveHint, false);
      assert.ok(!tool.inputSchema.required?.includes('request_id'));
    }
    const createTransport = listedTools.find(t => t.name === 'create_transport_request')!;
    assert.equal(createTransport.annotations?.readOnlyHint, false);
    assert.ok(createTransport.inputSchema.required?.includes('request_id'));
    for (const name of ['create_program', 'create_function_group', 'create_function_module', 'update_source']) {
      const tool = listedTools.find(t => t.name === name)!;
      assert.ok(tool.description?.includes('required on each call when SAP requires change recording'), name);
      assert.ok(tool.description?.includes('NOT remembered or inherited'), name);
      const field = tool.inputSchema.properties?.transport_task as { description?: string };
      assert.ok(field.description?.includes('when SAP requires change recording'), name);
    }
    const result = await client.callTool({ name: 'read_source', arguments: { connection_id: f.connection.connection_id, object_uri: object } });
    assert.equal(result.isError, false); assert.equal((result.structuredContent as { data: { source: string } }).data.source, 'REPORT ztest.');
    const invalid = await client.callTool({ name: 'read_source', arguments: { connection_id: f.connection.connection_id, object_uri: 'http://evil.test' } });
    assert.equal(invalid.isError, true);
    const oversized = await client.callTool({ name: 'list_connections', arguments: { extra: Array(2001).fill(null) } });
    assert.equal(oversized.isError, true);
    assert.ok(JSON.stringify(oversized).includes('maximum of 2000 elements'));
  } finally { await client.close(); await runtime.close(); await f.cleanup(); }
});



test('query tools work with writes disabled and validate through the MCP boundary', async () => {
  const f = await fixture();
  await f.store.save({ schema_version: 1, connections: [{ ...f.connection, write_enabled: false }], tokens: [] });
  const calls: unknown[] = [];
  Object.assign(f.backend, {
    queryTable: async (p: unknown) => { calls.push(p); return { columns: [{ name: 'MATNR' }], rows: [{ MATNR: '000001' }] }; },
    querySql: async (p: unknown) => { calls.push(p); return { rows: [] }; }
  });
  const token = await f.store.createToken(); const runtime = await startHttp(f.store, f.operations, 0);
  const address = runtime.listener.address(); assert.ok(address && typeof address !== 'string');
  const client = new Client({ name: 'query-test', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`),
      { requestInit: { headers: { Authorization: `Bearer ${token.token}` } } }));
    const base = { connection_id: f.connection.connection_id };
    const result = await client.callTool({ name: 'query_table', arguments: { ...base, table_name: 'MARA' } });
    assert.equal(result.isError, false);
    assert.equal((result.structuredContent as { data: { rows: { MATNR: string }[] } }).data.rows[0].MATNR, '000001');
    const sql = await client.callTool({ name: 'query_sql', arguments: { ...base, sql: 'SELECT * FROM mara' } });
    assert.equal(sql.isError, false);
    for (const args of [{ table_name: 'MARA', limit: 501 }, { table_name: 'MARA;DELETE' }, { table_name: 'MARA', extra: true }]) {
      const invalid = await client.callTool({ name: 'query_table', arguments: { ...base, ...args } });
      assert.equal(invalid.isError, true);
    }
    for (const sql of ['DELETE FROM mara', 'SELECT * FROM mara USING ALL CLIENTS', 'SELECT * FROM mara USING CLIENTS IN @clients']) {
      const invalid = await client.callTool({ name: 'query_sql', arguments: { ...base, sql } });
      assert.equal(invalid.isError, true);
    }
    assert.equal(calls.length, 2); assert.equal(f.backend.locks, 0); assert.equal(f.backend.saves, 0);
  } finally { await client.close(); await runtime.close(); await f.cleanup(); }
});

test('table-data policy applies per connection through MCP even with cached sessions', async () => {
  const f = await fixture();
  const second = { ...f.connection, connection_id: randomUUID(), name: 'other', allow_table_data: true };
  await f.store.save({ schema_version: 1, connections: [{ ...f.connection, allow_table_data: false }, second], tokens: [] });
  let queries = 0;
  Object.assign(f.backend, {
    queryTable: async () => { queries++; return { rows: [] }; },
    querySql: async () => { queries++; return { rows: [] }; }
  });
  const token = await f.store.createToken(); const runtime = await startHttp(f.store, f.operations, 0);
  const address = runtime.listener.address(); assert.ok(address && typeof address !== 'string');
  const client = new Client({ name: 'policy-test', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`),
      { requestInit: { headers: { Authorization: `Bearer ${token.token}` } } }));
    const listed = await client.callTool({ name: 'list_connections', arguments: {} });
    const entries = (listed.structuredContent as { data: { connection_id: string; allow_table_data: boolean }[] }).data;
    assert.equal(entries.find(item => item.connection_id === f.connection.connection_id)?.allow_table_data, false);
    assert.equal(entries.find(item => item.connection_id === second.connection_id)?.allow_table_data, true);
    for (const [name, args] of [['query_table', { table_name: 'MARA' }], ['query_sql', { sql: 'SELECT * FROM mara' }]] as const) {
      const denied = await client.callTool({ name, arguments: { connection_id: f.connection.connection_id, ...args } });
      assert.equal(denied.isError, true);
      assert.equal((denied.structuredContent as { error: { code: string } }).error.code, 'TABLE_DATA_DISABLED');
      assert.equal((await client.callTool({ name, arguments: { connection_id: second.connection_id, ...args } })).isError, false);
    }
    assert.equal(queries, 2);
    assert.equal((await client.callTool({ name: 'read_source', arguments: { connection_id: f.connection.connection_id, object_uri: object } })).isError, false);
    const config = await f.store.load();
    config.connections.find(item => item.connection_id === second.connection_id)!.allow_table_data = false;
    await f.store.save(config);
    const revoked = await client.callTool({ name: 'query_table', arguments: { connection_id: second.connection_id, table_name: 'MARA' } });
    assert.equal((revoked.structuredContent as { error: { code: string } }).error.code, 'TABLE_DATA_DISABLED');
    assert.equal(queries, 2);
    const governed = await f.store.load();
    governed.connections.find(item => item.connection_id === f.connection.connection_id)!.write_enabled = false;
    await f.store.save(governed);
    const deniedWrite = await client.callTool({ name: 'update_source', arguments: {
      connection_id: f.connection.connection_id, object_uri: object, expected_revision: '0'.repeat(64),
      source: 'REPORT ztest.', request_id: 'mcp-governance-test' } });
    assert.equal(deniedWrite.isError, true);
    assert.equal((deniedWrite.structuredContent as { error: { code: string } }).error.code, 'WRITE_DISABLED');
    const outside = await client.callTool({ name: 'update_source', arguments: {
      connection_id: f.connection.connection_id, object_uri: object + 'other', expected_revision: '0'.repeat(64),
      source: 'REPORT ztest.', request_id: 'mcp-outside-scope' } });
    assert.equal((outside.structuredContent as { error: { code: string } }).error.code, 'WRITE_DISABLED');
    assert.equal(f.backend.saves, 0);
  } finally { await client.close(); await runtime.close(); await f.cleanup(); }
});

test('query audit records operation IDs and recovery without query values or returned data', async () => {
  const f = await fixture();
  Object.assign(f.backend, {
    queryTable: async () => ({ row_count: 1, rows: [{ MATNR: 'PRIVATE_ROW' }], session_recovery: 'reader_recreated_after_idle_timeout' }),
    querySql: async () => { throw new AppError('DATA_PREVIEW_FAILED', 'failed', {
      http_status: 404, request_path: '/sap/bc/adt/datapreview/freestyle', attempts: 2, reader_recreated: true,
      sap_message: 'PRIVATE_MESSAGE'
    }); }
  });
  try {
    const good = await f.operations.run('query_table', { connection_id: f.connection.connection_id, table_name: 'MARA',
      filters: [{ field: 'MATNR', operator: 'eq', value: 'PRIVATE_FILTER' }] });
    const bad = await f.operations.run('query_sql', { connection_id: f.connection.connection_id,
      sql: "SELECT * FROM mara WHERE matnr = 'PRIVATE_SQL'" });
    assert.equal(good.status, 'success');
    assert.ok(good.completed_steps.includes('query_reader_recreated'));
    assert.equal(bad.status, 'error');
    const log = await readFile(join(f.logDirectory, (await readdir(f.logDirectory))[0]), 'utf8');
    const events = log.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(events[0].operation_id, good.operation_id);
    assert.equal(events[0].event, 'data_query_completed');
    assert.equal(events[0].session_recovery, 'reader_recreated_after_idle_timeout');
    assert.equal(events[1].operation_id, bad.operation_id);
    assert.equal(events[1].event, 'data_query_failed');
    assert.equal(events[1].attempts, 2);
    assert.equal(events[1].http_status, 404);
    assert.equal(log.includes('PRIVATE_'), false);
  } finally { await f.cleanup(); }
});

test('repository tools register as read-only, preserve schema refinements and run with writes disabled', async () => {
  const { makeMcp } = await import('../src/server.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { repositorySchemas } = await import('../src/repository-query.js');
  const f = await fixture();
  await f.store.save({ schema_version: 1, connections: [{ ...f.connection, write_enabled: false }], tokens: [] });
  let dispatched = 0;
  Object.assign(f.backend, { inspectRepository: async (tool: string, args: unknown) => { dispatched++; return { tool, args }; } });
  const server = makeMcp(f.operations, new ApprovalService(f.store, input => f.operations.run('read_source', input)), new WorkflowExecution(f.store, f.operations));
  const client = new Client({ name: 'repository-test', version: '1' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    for (const name of Object.keys(repositorySchemas)) {
      const tool = tools.find(t => t.name === name)!;
      assert.ok(tool, name); assert.equal(tool.annotations?.readOnlyHint, true);
      assert.equal(tool.annotations?.destructiveHint, false);
    }
    const inputs = {
      get_ddic_definition: { entity_name: 'EKKO', field_name: 'EBELN' },
      get_data_element: { data_element_uri: '/sap/bc/adt/ddic/dataelements/ebeln' },
      get_domain_values: { domain_uri: '/sap/bc/adt/ddic/domains/ebeln' },
      get_odata_service_binding: { object_uri: '/sap/bc/adt/businessservices/bindings/ztest' },
      find_references: { object_uri: object },
      find_definition: { object_uri: object, line: 1, column: 8 },
      get_class_structure: { object_uri: '/sap/bc/adt/oo/classes/ztest' },
      get_type_hierarchy: { object_uri: object, line: 1, column: 8 }
    };
    for (const [name, args] of Object.entries(inputs)) {
      const result = await client.callTool({ name, arguments: { ...args, connection_id: f.connection.connection_id } });
      assert.equal(result.isError, false, name);
      const data = (result.structuredContent as any).data;
      assert.equal(data.tool, name);
      assert.equal(data.args.connection_id, undefined, 'backend receives only query parameters');
    }
    const invalid = await client.callTool({ name: 'find_references', arguments: {
      connection_id: f.connection.connection_id, object_uri: object, line: 1
    } });
    assert.equal(invalid.isError, true);
    assert.equal(dispatched, Object.keys(inputs).length, 'invalid coordinates are rejected before dispatch');
    assert.equal(f.backend.locks, 0); assert.equal(f.backend.saves, 0);
    assert.equal((await f.operations.run('get_ddic_definition', {
      connection_id: f.connection.connection_id, entity_name: 'EKKO', limit: 501
    })).status, 'error', 'direct Operations callers also get validation');
  } finally { await client.close(); await server.close(); await f.cleanup(); }
});

test('quality executions require write authorization and confirmation, are audited and never replay unknown runs', async () => {
  const f = await fixture();
  let executions = 0;
  Object.assign(f.backend, { quality: async (tool: string) => {
    if (tool === 'run_unit_tests' || tool === 'run_atc') executions++;
    return { test_status: 'passed', run_id: 'WL_1' };
  } });
  try {
    await f.store.save({ schema_version: 1, connections: [{ ...f.connection, write_enabled: false }], tokens: [] });
    const args = { connection_id: f.connection.connection_id, object_uri: object, request_id: 'test-one', confirm_execution: true as const };
    const blocked = await f.operations.run('run_unit_tests', args);
    assert.equal(blocked.error?.code, 'WRITE_DISABLED'); assert.equal(executions, 0);
    for (const name of ['get_atc_configuration', 'get_atc_results', 'list_source_versions', 'compare_source_versions']) {
      const result = await f.operations.run(name, { connection_id: f.connection.connection_id,
        ...(name === 'get_atc_results' ? { run_id: 'WL_1' } : name === 'get_atc_configuration' ? {} : { object_uri: object }) });
      assert.equal(result.status, 'success', name);
    }
    await f.store.save({ schema_version: 1, connections: [f.connection], tokens: [] });
    const missingConfirm = await f.operations.run('run_unit_tests', { ...args, request_id: 'missing-confirm', confirm_execution: undefined });
    assert.equal(missingConfirm.status, 'error'); assert.equal(executions, 0);
    const actual = await f.operations.run('run_unit_tests', { ...args, request_id: 'authorized' });
    assert.equal(actual.outcome, 'confirmed'); assert.equal(actual.write_dispatched, true); assert.equal(executions, 1);
    assert.equal((await f.operations.run('run_unit_tests', { ...args, request_id: 'authorized' })).operation_id, actual.operation_id);
    assert.equal(executions, 1);
    Object.assign(f.backend, { quality: async () => { executions++; throw new AppError('OUTCOME_UNKNOWN', 'Timed out'); } });
    const failed = await f.operations.run('run_atc', { ...args, request_id: 'unknown-run', check_variant: 'DEFAULT' });
    assert.equal(failed.outcome, 'unknown'); assert.equal(failed.write_dispatched, true);
    await f.operations.run('run_atc', { ...args, request_id: 'unknown-run', check_variant: 'DEFAULT' });
    assert.equal(executions, 2, 'unknown backend execution is not automatically repeated');
    const logs = await readdir(f.logDirectory);
    const text = (await Promise.all(logs.map(name => readFile(join(f.logDirectory, name), 'utf8')))).join('');
    assert.ok(text.includes('quality_execution_started')); assert.ok(text.includes('quality_execution_completed'));
    assert.ok(!text.includes('check_variant')); assert.equal(f.backend.locks, 0); assert.equal(f.backend.saves, 0);
  } finally { await f.cleanup(); }
});

test('quality tools advertise actual execution policy and reject missing confirmation through MCP', async () => {
  const { makeMcp } = await import('../src/server.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const f = await fixture();
  let dispatched = 0;
  Object.assign(f.backend, { quality: async () => { dispatched++; return { test_status: 'no_tests' }; } });
  const server = makeMcp(f.operations, new ApprovalService(f.store, input => f.operations.run('read_source', input)), new WorkflowExecution(f.store, f.operations)); const client = new Client({ name: 'quality-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a); await client.connect(b);
    const tools = (await client.listTools()).tools;
    for (const name of ['run_atc', 'run_unit_tests']) {
      const tool = tools.find(t => t.name === name)!;
      assert.equal(tool.annotations?.readOnlyHint, false); assert.equal(tool.annotations?.idempotentHint, false);
      assert.ok(tool.inputSchema.required?.includes('request_id')); assert.ok(tool.inputSchema.required?.includes('confirm_execution'));
    }
    for (const name of ['get_atc_configuration', 'get_atc_results', 'list_source_versions', 'compare_source_versions'])
      assert.equal(tools.find(t => t.name === name)?.annotations?.readOnlyHint, true);
    const invalid = await client.callTool({ name: 'run_unit_tests', arguments: { connection_id: f.connection.connection_id, object_uri: object, request_id: 'one' } });
    assert.equal(invalid.isError, true); assert.equal(dispatched, 0);
    const result = await client.callTool({ name: 'run_unit_tests', arguments: { connection_id: f.connection.connection_id, object_uri: object, request_id: 'two', confirm_execution: true } });
    assert.equal(result.isError, false); assert.equal(dispatched, 1);
    assert.equal((result.structuredContent as any).data.test_status, 'no_tests');
  } finally { await client.close(); await server.close(); await f.cleanup(); }
});


test('transport preflight failure leaves source save undispatched and records diagnostics', async () => {
  const f = await fixture();
  Object.assign(f.backend, { saveDispatchTracking: true,
    save: async () => { throw new AppError('BACKEND_RESPONSE_TOO_LARGE', 'bounded', {
      request_path: '/sap/bc/adt/cts/transportrequests', error_kind: 'response_size_limit', elapsed_ms: 42,
      network_code: 'ERR_BAD_RESPONSE', raw: 'PRIVATE_SOURCE', sap_message: 'PRIVATE_MESSAGE'
    }); }
  });
  try {
    const current = await f.backend.read(object, 'active');
    const result = await f.operations.run('update_source', { connection_id: f.connection.connection_id,
      object_uri: object, expected_revision: current.revision, source: 'REPORT ztest.\nWRITE 1.', request_id: randomUUID() });
    assert.equal(result.status, 'error'); assert.equal(result.write_dispatched, false);
    assert.equal(result.outcome, 'confirmed'); assert.equal(result.source_save?.saved, false);
    assert.equal(f.backend.unlocks, 1);
    const log = (await Promise.all((await readdir(f.logDirectory)).map(file => readFile(join(f.logDirectory, file), 'utf8')))).join('');
    const event = log.trim().split('\n').map(line => JSON.parse(line)).find(e => e.event === 'failed');
    assert.equal(event.tool, 'update_source'); assert.equal(event.network_code, 'ERR_BAD_RESPONSE');
    assert.equal(event.elapsed_ms, 42); assert.equal(event.write_dispatched, false);
    assert.equal(log.includes('PRIVATE_'), false);
  } finally { await f.cleanup(); }
});

test('read failures are audited with the operation ID', async () => {
  const f = await fixture();
  try {
    const result = await f.operations.run('read_source', { connection_id: f.connection.connection_id, object_uri: object, version: 'inactive' });
    const log = await readFile(join(f.logDirectory, (await readdir(f.logDirectory))[0]), 'utf8');
    const event = JSON.parse(log.trim());
    assert.equal(event.operation_id, result.operation_id); assert.equal(event.tool, 'read_source');
    assert.equal(event.error_code, 'VERSION_UNAVAILABLE');
  } finally { await f.cleanup(); }
});


test('save HTTP diagnostics are correlated and sanitized on success and unknown outcome', async () => {
  for (const uncertain of [false, true]) {
    const f = await fixture();
    try {
      f.backend.uncertain = uncertain;
      (f.backend as Backend).takeSaveDiagnostics = () => [{ request_path: source, request_method: 'PUT',
        request_body_bytes: 123, request_content_length: 123, request_charset: 'utf-8', http_version: '1.1',
        request_chunked: false, request_finished: true, response_started: !uncertain, elapsed_ms: 12,
        transport: 'axios_node_http', ...(uncertain ? { network_code: 'ECONNRESET' } : { http_status: 204 }),
        authorization: 'PRIVATE_TOKEN', body: 'PRIVATE_SOURCE' } as any];
      const active = await f.backend.read(object, 'active');
      const result = await f.operations.run('update_source', { connection_id: f.connection.connection_id,
        object_uri: object, expected_revision: active.revision, source: 'REPORT ztest.\n* test', request_id: randomUUID() });
      assert.equal(result.status, uncertain ? 'error' : 'success');
      const text = await readFile(join(f.logDirectory, (await readdir(f.logDirectory))[0]), 'utf8');
      const rows = text.trim().split('\n').map(line => JSON.parse(line));
      const diagnostic = rows.find(row => row.event === 'source_save_http_completed');
      assert.equal(diagnostic.operation_id, result.operation_id);
      assert.equal(diagnostic.connection_id, f.connection.connection_id);
      assert.equal(diagnostic.request_content_length, 123); assert.equal(diagnostic.request_charset, 'utf-8');
      assert.equal(diagnostic.http_version, '1.1'); assert.equal(diagnostic.request_chunked, false);
      assert.equal(text.includes('PRIVATE_'), false);
      assert.equal(f.backend.unlocks, 1);
    } finally { await f.cleanup(); }
  }
});

test('small source edits on a large program preserve save verification without echoing the whole program', async () => {
  const f = await fixture();
  try {
    f.backend.active = 'REPORT ztest.\n' + '* unchanged line\n'.repeat(15000) + 'WRITE 1.\n';
    const before = await f.backend.read(object,'active');
    const args = {connection_id:f.connection.connection_id,object_uri:object,version:'active' as const,
      expected_revision:before.revision,edits:[{old_text:'WRITE 1.',new_text:'WRITE 2.'}],request_id:'small-edit-large-program'};
    const result = await f.operations.run('update_source',args);
    assert.equal(result.status,'success'); assert.equal(result.source_save?.verification,'passed');
    assert.equal(f.backend.inactive,before.source.replace('WRITE 1.','WRITE 2.'));
    assert.equal(f.backend.active,before.source,'save never activates');
    assert.equal((result.data as any).source,undefined); assert.equal((result.data as any).applied_edits,1);
    assert.ok(JSON.stringify(args).length < before.source.length/100);
    assert.ok(JSON.stringify(result).length < before.source.length/100);
    assert.equal((await f.operations.run('update_source',args)).operation_id,result.operation_id);
    assert.equal(f.backend.saves,1,'request replay protection also applies to fragment edits');
  } finally {await f.cleanup();}
});

test('inactive source edits avoid an active read and may explicitly return full source', async () => {
  const f=await fixture();
  try {
    f.backend.inactive='REPORT ztest.\nWRITE 1.';
    const before=await f.backend.read(object,'inactive');
    const read=f.backend.read.bind(f.backend);const versions:Version[]=[];
    f.backend.read=async(uri,version)=>{versions.push(version);return read(uri,version);};
    const result=await f.operations.run('update_source',{connection_id:f.connection.connection_id,object_uri:object,
      version:'inactive',expected_revision:before.revision,edits:[{old_text:'WRITE 1.',new_text:'WRITE 2.'}],include_source:true,request_id:'inactive-patch'});
    assert.equal(result.status,'success');assert.equal((result.data as any).source,'REPORT ztest.\nWRITE 2.');
    assert.deepEqual(versions,['inactive','inactive']);
  } finally {await f.cleanup();}
});

test('invalid source edit sets never write and still release the object lock', async () => {
  for(const edits of [[{old_text:'missing',new_text:'new'}],[{old_text:'WRITE',new_text:'WRITE 3'}],
    [{old_text:'WRITE 1.',new_text:'x'},{old_text:'1.',new_text:'y'}]]) {
    const f=await fixture();
    try {
      f.backend.active='REPORT ztest.\nWRITE 1.\nWRITE 2.';
      const before=await f.backend.read(object,'active');
      const result=await f.operations.run('update_source',{connection_id:f.connection.connection_id,object_uri:object,
        expected_revision:before.revision,edits,request_id:'invalid-patch'});
      assert.equal(result.status,'error');assert.match(result.error!.code,/SOURCE_EDIT_/);
      assert.equal(result.write_dispatched,false);assert.equal(f.backend.saves,0);assert.equal(f.backend.locks,f.backend.unlocks);
    } finally {await f.cleanup();}
  }
});

test('source edits preserve stale-revision and existing-draft protection', async () => {
  for(const stale of [false,true]) {
    const f=await fixture();
    try {
      const before=await f.backend.read(object,'active');
      if(stale) f.backend.active='REPORT ztest.\nWRITE 2.';
      else f.backend.inactive='REPORT ztest.\nWRITE 1.';
      const result=await f.operations.run('update_source',{connection_id:f.connection.connection_id,object_uri:object,
        version:'active',expected_revision:before.revision,edits:[{old_text:'REPORT ztest.',new_text:'REPORT ztest.\nWRITE 3.'}],request_id:'stale-patch'});
      assert.equal(result.error?.code,'VERSION_CONFLICT');assert.equal(f.backend.saves,0);
    } finally {await f.cleanup();}
  }
});


test('cached RFC reader context loss recovers once even when closing the failed bridge throws', async () => {
  const f = await fixture(); let created = 0;
  const ops = new Operations(f.store, credentials, new AuditLog(f.logDirectory), () => {
    const b = new FakeBackend(f.connection.connection_id);
    if (++created === 1) {
      let reads = 0; const read = b.read.bind(b);
      b.read = async (...args) => { if (++reads > 1) throw new AppError('RFC_CONTEXT_LOST', 'RFC call timed out'); return read(...args); };
      b.close = async () => { throw new AppError('RFC_CONTEXT_LOST', 'Failed bridge cleanup'); };
    }
    return b;
  });
  try {
    const args = { connection_id: f.connection.connection_id, object_uri: object, version: 'active' as const };
    assert.equal((await ops.run('read_source', args)).status, 'success');
    const result = await ops.run('read_source', args);
    assert.equal(result.status, 'success'); assert.ok(result.completed_steps.includes('session_recreated'));
    assert.equal(created, 2);
  } finally { await ops.close(); await f.cleanup(); }
});

test('RFC read recovery is bounded and never replays a write or bypasses an uncertain lock', async () => {
  const f = await fixture(); let created = 0;
  const ops = new Operations(f.store, credentials, new AuditLog(f.logDirectory), () => { created++; return f.backend; });
  try {
    const args = { connection_id: f.connection.connection_id, object_uri: object, version: 'active' as const };
    await ops.run('read_source', args);
    let reads = 0;
    f.backend.read = async () => { reads++; throw new AppError('RFC_CONTEXT_LOST', 'RFC call timed out'); };
    const result = await ops.run('read_source', args);
    assert.equal(result.error?.code, 'RFC_CONTEXT_LOST'); assert.equal(reads, 2); assert.equal(created, 2);
    let creates = 0;
    f.backend.create = async () => { creates++; throw new AppError('RFC_CONTEXT_LOST', 'RFC call timed out'); };
    assert.equal((await ops.run('create_program', { connection_id: args.connection_id, name: 'ZTEST',
      description: 'Test', package_name: '$TMP', request_id: 'rfc-write-no-replay' })).error?.code, 'RFC_CONTEXT_LOST');
    assert.equal(creates, 1);
    (ops as any).poisoned.add(f.backend);
    const before = created; reads = 0;
    assert.equal((await ops.run('read_source', args)).error?.code, 'RFC_CONTEXT_LOST');
    assert.equal(reads, 1); assert.equal(created, before);
  } finally { await ops.close(); await f.cleanup(); }
});
