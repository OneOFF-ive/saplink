import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConfigStore, type Connection } from '../src/config.js';
import { AppError } from '../src/errors.js';
import { AgentRuntime } from '../src/agent/runtime.js';
import { TaskStore, taskEvent } from '../src/agent/task-store.js';
import { ArtifactStore, artifactTool } from '../src/agent/artifacts.js';
import { createReportTool, updateReportTool } from '../src/agent/report.js';
import { askUserTool } from '../src/agent/questions.js';
import { changePreviewTool, createChangePreview, readChangePreview } from '../src/agent/change-preview.js';
import { operationProposalTool } from '../src/agent/operation-proposal.js';
import { workflowProposalTool } from '../src/agent/workflow-proposal.js';
import { sourceResult } from '../src/adt.js';
import { compactContext, estimateTokens, workingMessages } from '../src/agent/context.js';
import { agentModelTools, agentReadTools, agentTableTools, validateAgentTool, cliExecutor, projectAgentResult, projectAgentReadFailure } from '../src/agent/cli-executor.js';
import { deepSeekModel, ModelLengthError, readModelStream, type Message, type Model } from '../src/agent/model.js';
import { deepSeekSearch,webSearchTool } from '../src/agent/web-search.js';
import { memoryTool } from '../src/agent/long-term-memory.js';
import { localWorkTools } from '../src/agent/local-work.js';
import { mcpManagementTools } from '../src/agent/mcp-management.js';
import { skillDraftTool } from '../src/agent/skill-packages.js';
import { writeTools } from '../src/tool-policy.js';
import { targetFingerprint } from '../src/connection-identity.js';
import { runSapOperation } from '../src/sap-cli.js';
import { startAdmin } from '../src/admin.js';

const connection: Connection = { connection_id: randomUUID(), name: 'Agent_DEV', base_url: 'https://sap.test:443',
  client: '100', username: 'TEST', language: 'ZH', write_enabled: false };
const credentials = { get: async () => { throw new Error('Must not access credentials'); }, set: async () => {}, remove: async () => {} };
const answer = (content = '根据实际读取的程序，这里输出参数值。') => ({ message: { role: 'assistant', content } as Message });
const call = (name: string, args: Record<string, unknown> = {}) => ({ message: { role: 'assistant', content: null,
  tool_calls: [{ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] } as Message });

async function fixture(model: Model, execute = async () => ({ operation_id: 'fixture-operation', status: 'success', data: {} }), allowTableData = false) {
  const root = resolve('.saplink/tests'); await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'agent-'));
  const store = new ConfigStore(directory);
  const config = await store.load(); config.connections.push({ ...connection, allow_table_data: allowTableData }); await store.save(config);
  const runtime = new AgentRuntime(store, { model, execute }); await runtime.initialize();
  return { directory, store, runtime, cleanup: async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); } };
}
// Leave room for the tool schemas and a completed tool turn before compaction.
const smallTestContext = 20000;
function useSmallTestContext(runtime: AgentRuntime) {
  const resolve = runtime.settings.resolve.bind(runtime.settings);
  runtime.settings.resolve = async () => ({...await resolve(),contextTokens:smallTestContext});
}
async function setTablePolicy(store:ConfigStore,id:string,allowed:boolean){
  const config=await store.load();const target=config.connections.find(item=>item.connection_id===id);
  assert.ok(target);target.allow_table_data=allowed;await store.save(config);
}
async function terminal(runtime: AgentRuntime, id: string) {
  for (let i = 0; i < 1500; i++) {
    const task = await runtime.tasks.get(id);
    if (!['queued', 'running'].includes(task.status)) return task;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Task did not finish');
}

test('long-term memory extracts supported entries and recalls them only in the same SAP connection', async () => {
  const preference = '以后分析 ABAP 时先列主程序和直接 INCLUDE';
  const lesson = 'ZMMP026 排查时先定位直接 INCLUDE，再核对实际调用路径。';
  const f = await fixture(async messages => {
    const prompt = messages[1].content;
    const toolMessages = messages.filter(message=>message.role==='tool');
    if (prompt === preference) {
      if (!toolMessages.length) return call('get_capabilities');
      if (toolMessages.length === 1) return call('read_source',{object_uri:'/sap/bc/adt/programs/programs/zmmp026'});
      if (toolMessages.length === 2) return call('remember_for_future',{entries:[
        {kind:'preference',topic:'ABAP 分析输出',note:'先列程序',evidence:preference},
        {kind:'preference',topic:'伪造偏好',note:'伪造',evidence:'没有说过的内容'},
        {kind:'lesson',topic:'ZMMP026',note:lesson,evidence:JSON.parse(toolMessages[1].content!)._task_artifact.artifact_id}
      ]});
      assert.equal(JSON.parse(toolMessages[2].content!).data.accepted,2);
    }
    return answer('完成');
  });
  try {
    const other = {...connection,connection_id:randomUUID()};
    const config = await f.store.load();
    config.connections.push(other); await f.store.save(config);
    const original = await f.runtime.create(preference,connection.connection_id,'chat');
    const finished = await terminal(f.runtime,original.id);
    assert.equal(finished.status,'completed');
    assert.ok(!finished.events.some(event=>event.type==='memory_save_failed'));
    const next = await f.runtime.create('分析 ZMMP026',connection.connection_id,'chat');
    const recalled = (await terminal(f.runtime,next.id)).recalled_memories;
    assert.deepEqual(recalled?.map(entry=>entry.note).sort(),[preference,lesson].sort());
    const isolated = await f.runtime.create('分析 ZMMP026',other.connection_id,'chat');
    assert.deepEqual((await terminal(f.runtime,isolated.id)).recalled_memories,[]);
  } finally { await f.cleanup(); }
});

test('uploaded text remains scoped to its conversation and survives follow-ups', async () => {
  const requests: Message[][] = [];
  const f = await fixture(async messages => { requests.push(structuredClone(messages)); return answer('完成'); });
  try {
    const content = '中文附件内容\n' + 'x'.repeat(9000);
    const created = await f.runtime.create('分析文件', connection.connection_id, 'chat', undefined,
      [{ name: '报告', content }]);
    const first = await terminal(f.runtime, created.id);
    assert.equal(first.status, 'completed');
    assert.equal(first.initial_uploads?.[0].name, '报告');
    const artifact = first.initial_uploads![0].artifact_id;
    assert.ok(JSON.stringify(requests[0]).includes('中文附件内容'));
    assert.ok(JSON.stringify(requests[0]).includes('"complete":false') || JSON.stringify(requests[0]).includes('\\"complete\\":false'));
    const page = await f.runtime.tasks.artifacts.read(first.id, { artifact_id: artifact, offset: 8000, length: 2000 });
    assert.equal(page.format, 'source');
    assert.equal(page.text, content.slice(8000, 10000));
    const other = await f.runtime.create('另一个任务', connection.connection_id, 'chat');
    await terminal(f.runtime, other.id);
    await assert.rejects(f.runtime.tasks.artifacts.read(other.id, { artifact_id: artifact }), { code: 'AGENT_ARTIFACT_UNAVAILABLE' });
    await f.runtime.followUp(first.id, '比较文件', 'chat', undefined, undefined, [{ name: 'data.tsv', content: 'a,b\n1,2' }]);
    const finished = await terminal(f.runtime, first.id);
    assert.equal(finished.latest_uploads?.[0].name, 'data.tsv');
    const history = await f.runtime.tasks.conversation(first.id);
    const initial = history.messages.find(message => message.id === 'initial');
    const followup = history.messages.find(message => message.content === '比较文件');
    assert.equal(initial?.attachments?.[0].name, '报告');
    assert.equal(followup?.attachments?.[0].name, 'data.tsv');
    assert.equal(JSON.stringify(history).includes('中文附件内容'), false);
    assert.ok(requests.at(-1)?.some(message => message.content?.includes('a,b\\n1,2')));
  } finally { await f.cleanup(); }
});

test('uploads reject unsupported names, binary text and size limits before task creation', async () => {
  const f = await fixture(async () => answer());
  try {
    for (const upload of [
      { name: '../secret.txt', content: 'x' },
      { name: 'binary.txt', content: '\u0000' },
      { name: 'large.txt', content: 'x'.repeat(10 * 1024 * 1024 + 1) }
    ]) await assert.rejects(f.runtime.create('分析', connection.connection_id, 'chat', undefined, [upload]));
    await assert.rejects(f.runtime.create('分析', connection.connection_id, 'chat', undefined,
      Array.from({ length: 7 }, (_, i) => ({ name: `${i}.txt`, content: 'x'.repeat(10 * 1024 * 1024) }))));
    await assert.rejects(f.runtime.create('分析', connection.connection_id, 'chat', undefined,
      Array.from({ length: 11 }, (_, i) => ({ name: `${i}.txt`, content: 'x' }))));
    assert.deepEqual(await f.runtime.tasks.ids(), []);
  } finally { await f.cleanup(); }
});

test('a failed task save removes unpublished uploaded files', async () => {
  const f = await fixture(async () => answer());
  try {
    f.runtime.tasks.save = async () => { throw new Error('synthetic write failure'); };
    await assert.rejects(f.runtime.create('分析', connection.connection_id, 'chat', undefined,
      [{ name: 'data.txt', content: 'synthetic data' }]), /synthetic write failure/);
    const entries = await readdir(f.runtime.tasks.directory, { withFileTypes: true });
    assert.equal(entries.some(entry => entry.isDirectory()), false);
  } finally { await f.cleanup(); }
});

test('source change preview binds a verified task source and never writes to SAP', async () => {
  const uri = '/sap/bc/adt/programs/programs/ztest';
  const sourceUri = uri + '/source/main';
  const original = 'REPORT ztest.\nWRITE 1.\n';
  const source = sourceResult(connection.connection_id, uri, sourceUri, original, 'active');
  const executed: string[] = [];
  let round = 0;
  const f = await fixture(async messages => {
    round++;
    if (round === 1) return call('get_capabilities');
    if (round === 2) return call('read_source', { object_uri: uri, version: 'active' });
    if (round === 3) {
      const read = messages.findLast(message => message.role === 'tool' && message.content?.includes(source.revision));
      const artifact = JSON.parse(read!.content!)._task_artifact.artifact_id;
      return call('propose_source_change', { source_artifact_id: artifact, summary: '修改输出',
        edits: [{ old_text: 'WRITE 1.', new_text: 'WRITE 2.' }] });
    }
    return answer('已生成草稿，尚未写入 SAP。');
  }, async name => {
    executed.push(name);
    return name === 'read_source' ? { status: 'success', data: source } : { status: 'success', data: {} };
  });
  try {
    const created = await f.runtime.create('修改程序输出', connection.connection_id, 'chat');
    const task = await terminal(f.runtime, created.id);
    assert.equal(task.status, 'completed');
    assert.deepEqual(executed, ['get_capabilities', 'read_source']);
    assert.equal(task.changes?.length, 1);
    const change = task.changes![0];
    assert.equal(change.revision, source.revision);
    const preview = await readChangePreview(task, f.runtime.tasks, change.id);
    assert.equal(preview.status, 'preview');
    assert.equal(preview.diff.truncated, false);
    assert.deepEqual(preview.edits, [{ old_text: 'WRITE 1.', new_text: 'WRITE 2.' }]);
    assert.ok(preview.diff.hunks.flatMap(h => h.lines).some(line => line.kind === 'added' && line.text === 'WRITE 2.'));
    const raw = await f.runtime.tasks.artifacts.get(task.id, change.artifact_id);
    assert.equal(JSON.parse(raw.content).target_fingerprint, task.target_fingerprint);
    assert.equal(JSON.parse(raw.content).proposed_source, 'REPORT ztest.\nWRITE 2.\n');
    const other = await f.runtime.create('其他会话', connection.connection_id, 'chat');
    await terminal(f.runtime, other.id);
    await assert.rejects(readChangePreview(await f.runtime.tasks.get(other.id), f.runtime.tasks, change.id), { code: 'AGENT_CHANGE_NOT_FOUND' });
    await assert.rejects(f.runtime.reviewChange(other.id, change.id, change.artifact_id), { code: 'AGENT_CHANGE_NOT_FOUND' });
    await assert.rejects(createChangePreview(task, f.runtime.tasks, {
      source_artifact_id: '0'.repeat(64), summary: '无基线', edits: [{ old_text: 'x', new_text: 'y' }]
    }, text => text), { code: 'AGENT_CHANGE_SOURCE_INVALID' });
    const bad = await f.runtime.tasks.artifacts.put(task.id, 'result', JSON.stringify({ status: 'success',
      data: { ...source, source: original + 'tampered' } }));
    task.source_reads!.push({ artifact_id: bad, object_uri: uri, revision: source.revision, read_source: true,
      total_characters: original.length, ranges: [] });
    await assert.rejects(createChangePreview(task, f.runtime.tasks, {
      source_artifact_id: bad, summary: '损坏基线', edits: [{ old_text: '1', new_text: '2' }]
    }, text => text), { code: 'AGENT_CHANGE_SOURCE_INVALID' });
    const sourceId = task.source_reads!.find(read => read.read_source && read.revision === source.revision && read.artifact_id !== bad)!.artifact_id;
    const input = { source_artifact_id: sourceId, summary: '测试', edits: [{ old_text: 'WRITE 1.', new_text: 'WRITE 2.' }] };
    const unverified = structuredClone(task);
    delete unverified.source_reads!.find(read => read.artifact_id === sourceId)!.read_source;
    await assert.rejects(createChangePreview(unverified, f.runtime.tasks, input, text => text), { code: 'AGENT_CHANGE_SOURCE_INVALID' });
    const foreign = await f.runtime.tasks.artifacts.put(other.id, 'result', JSON.stringify({ status: 'success', data: source }));
    await assert.rejects(createChangePreview(await f.runtime.tasks.get(other.id), f.runtime.tasks,
      { ...input, source_artifact_id: foreign }, text => text), { code: 'AGENT_CHANGE_SOURCE_INVALID' });
    for (const [edits, code] of [
      [[{ old_text: 'missing', new_text: 'x' }], 'SOURCE_EDIT_NOT_FOUND'],
      [[{ old_text: 'WRITE 1.', new_text: 'WRITE 1.' }], 'AGENT_CHANGE_EMPTY'],
      [[{ old_text: 'WRITE 1.', new_text: 'x' }, { old_text: '1.', new_text: 'y' }], 'SOURCE_EDIT_OVERLAP'],
      [[{ old_text: '\n', new_text: 'x' }], 'SOURCE_EDIT_AMBIGUOUS'],
      [[{ old_text: 'WRITE 1.', new_text: 'x'.repeat(4001) }], 'AGENT_CHANGE_DIFF_INCOMPLETE'],
      [[{ old_text: original, new_text: original.replace(/\n/g, '\r\n') }], 'AGENT_CHANGE_DIFF_INCOMPLETE']
    ] as const) {
      await assert.rejects(createChangePreview(task, f.runtime.tasks, { ...input, edits: [...edits] }, text => text), { code });
    }
    const save = f.runtime.tasks.save;
    f.runtime.tasks.save = async () => { throw new Error('synthetic save failure'); };
    const previousChanges = task.changes;
    try {
      await assert.rejects(createChangePreview(task, f.runtime.tasks, input, text => text), /synthetic save failure/);
      assert.equal(task.changes, previousChanges);
    } finally { f.runtime.tasks.save = save; }
    const host = await startAdmin(f.store, credentials, 0, undefined, undefined, { agent: { model: async () => answer() } });
    try {
      const url = new URL(host.url), origin = url.origin;
      assert.equal((await fetch(`${origin}/api/agent/tasks/${task.id}/changes/${change.id}`)).status, 401);
      const headers = { 'X-Admin-Token': url.hash.slice(1) };
      const response = await fetch(`${origin}/api/agent/tasks/${task.id}/changes/${change.id}`, { headers });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.status, 'preview');
      assert.equal(Object.hasOwn(result, 'proposed_source'), false);
      assert.equal((await fetch(`${origin}/api/agent/tasks/${other.id}/changes/${change.id}`, { headers })).status, 400);
    } finally { await host.close(); }
  } finally { await f.cleanup(); }
});

test('baseline verification rereads the bound SAP object without authorizing or writing', async () => {
  const uri = '/sap/bc/adt/programs/programs/zverify', sourceUri = uri + '/source/main';
  const original = 'REPORT zverify.\nWRITE 1.\n';
  const base = sourceResult(connection.connection_id, uri, sourceUri, original, 'active');
  let current: unknown = { status: 'success', data: base }, round = 0;
  let onRead: (() => Promise<void>) | undefined;
  const executed: { name: string; input: Record<string, unknown> }[] = [];
  const execute = async (name: string, input: Record<string, unknown>) => {
    executed.push({ name, input });
    if (name === 'read_source') await onRead?.();
    return name === 'read_source' ? current : { status: 'success', data: {} };
  };
  const f = await fixture(async messages => {
    round++;
    if (round === 1) return call('get_capabilities');
    if (round === 2) return call('read_source', { object_uri: uri, version: 'active' });
    if (round === 3) {
      const read = messages.findLast(message => message.role === 'tool' && message.content?.includes(base.revision));
      return call('propose_source_change', { source_artifact_id: JSON.parse(read!.content!)._task_artifact.artifact_id,
        summary: '修改输出', edits: [{ old_text: 'WRITE 1.', new_text: 'WRITE 2.' }] });
    }
    return answer();
  }, execute);
  try {
    const task = await terminal(f.runtime, (await f.runtime.create('修改程序', connection.connection_id, 'chat')).id);
    assert.equal(task.status, 'completed');
    const change = task.changes![0];
    executed.length = 0;
    const matched = await f.runtime.verifyChangeBaseline(task.id, change.id);
    assert.equal(matched.matches, true);
    assert.ok(!Number.isNaN(Date.parse(matched.checked_at)));
    assert.deepEqual(executed.map(item => item.name), ['read_source']);
    assert.equal(executed[0].input.object_uri, uri);
    assert.equal(executed[0].input.source_uri, sourceUri);
    assert.equal(executed[0].input.version, 'active');
    current = { status: 'success', data: sourceResult(connection.connection_id, uri, sourceUri, original + 'WRITE 3.\n', 'active') };
    assert.equal((await f.runtime.verifyChangeBaseline(task.id, change.id)).matches, false);
    current = { status: 'success', data: { ...base, source: original + 'tampered' } };
    await assert.rejects(f.runtime.verifyChangeBaseline(task.id, change.id), { code: 'AGENT_CHANGE_VERIFY_FAILED' });
    current = { status: 'success', data: sourceResult(connection.connection_id, uri, sourceUri + '/other', original, 'active') };
    await assert.rejects(f.runtime.verifyChangeBaseline(task.id, change.id), { code: 'AGENT_CHANGE_VERIFY_FAILED' });
    current = { status: 'error' };
    await assert.rejects(f.runtime.verifyChangeBaseline(task.id, change.id), { code: 'AGENT_CHANGE_VERIFY_FAILED' });
    await assert.rejects(f.runtime.verifyChangeBaseline(task.id, randomUUID()), { code: 'AGENT_CHANGE_NOT_FOUND' });
    current = { status: 'success', data: base };
    const host = await startAdmin(f.store, credentials, 0, undefined, undefined, { agent: { model: async () => answer(), execute } });
    try {
      const url = new URL(host.url), path = `${url.origin}/api/agent/tasks/${task.id}/changes/${change.id}/verify`;
      assert.equal((await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
      const headers = { 'X-Admin-Token': url.hash.slice(1), Origin: url.origin, 'Content-Type': 'application/json' };
      const response = await fetch(path, { method: 'POST', headers, body: '{}' });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.deepEqual(Object.keys(result).sort(), ['checked_at', 'matches']);
      assert.equal(result.matches, true);
      assert.notEqual((await fetch(path, { method: 'POST', headers, body: '{"confirm":true}' })).status, 200);
      const reviewPath = `${url.origin}/api/agent/tasks/${task.id}/changes/${change.id}/review`;
      const body = JSON.stringify({ confirm: true, artifact_id: change.artifact_id });
      assert.equal((await fetch(reviewPath, { method: 'POST', headers: { Origin: url.origin, 'Content-Type': 'application/json' }, body })).status, 401);
      assert.equal((await fetch(reviewPath, { method: 'POST', headers: { ...headers, Origin: 'http://evil.test' }, body })).status, 403);
      assert.notEqual((await fetch(reviewPath, { method: 'POST', headers, body: JSON.stringify({ confirm: false, artifact_id: change.artifact_id }) })).status, 200);
      const badArtifact = await fetch(reviewPath, { method: 'POST', headers,
        body: JSON.stringify({ confirm: true, artifact_id: '0'.repeat(64) }) });
      assert.equal((await badArtifact.json()).error.code, 'AGENT_CHANGE_CHANGED');
      current = { status: 'success', data: sourceResult(connection.connection_id, uri, sourceUri, original + 'WRITE 3.\n', 'active') };
      const stale = await fetch(reviewPath, { method: 'POST', headers, body });
      assert.equal((await stale.json()).error.code, 'AGENT_CHANGE_STALE');
      assert.equal((await f.runtime.tasks.get(task.id)).change_reviews, undefined);
      current = { status: 'success', data: base };
      const reviewed = await fetch(reviewPath, { method: 'POST', headers, body });
      assert.equal(reviewed.status, 200);
      const review = await reviewed.json();
      assert.deepEqual(Object.keys(review).sort(), ['id', 'reviewed_at', 'verified_at']);
      const persisted = await f.runtime.tasks.get(task.id);
      assert.equal(persisted.change_reviews?.[0].artifact_id, change.artifact_id);
      assert.equal(persisted.change_reviews?.[0].target_fingerprint, task.target_fingerprint);
      assert.equal(persisted.change_reviews?.[0].revision, change.revision);
      const detail = await fetch(`${url.origin}/api/agent/tasks/${task.id}/changes/${change.id}`, { headers });
      assert.equal((await detail.json()).review.id, review.id);
      const wrongReview = await fetch(reviewPath, { method: 'DELETE', headers,
        body: JSON.stringify({ confirm:true, review_id:randomUUID() }) });
      assert.equal((await wrongReview.json()).error.code, 'AGENT_CHANGE_REVIEW_CHANGED');
      const removed = await fetch(reviewPath, { method: 'DELETE', headers,
        body: JSON.stringify({ confirm:true, review_id:review.id }) });
      assert.equal(removed.status, 200);
      assert.equal((await f.runtime.tasks.get(task.id)).change_reviews?.length, 0);
      const replay = await fetch(reviewPath, { method: 'DELETE', headers,
        body: JSON.stringify({ confirm:true, review_id:review.id }) });
      assert.equal((await replay.json()).error.code, 'AGENT_CHANGE_REVIEW_CHANGED');
    } finally { await host.close(); }
    const savedReview = await f.runtime.reviewChange(task.id, change.id, change.artifact_id);
    const replacement = await f.runtime.reviewChange(task.id, change.id, change.artifact_id);
    assert.notEqual(savedReview.id, replacement.id);
    await assert.rejects(f.runtime.revokeChangeReview(task.id, change.id, savedReview.id), { code: 'AGENT_CHANGE_REVIEW_CHANGED' });
    await f.runtime.revokeChangeReview(task.id, change.id, replacement.id);
    const save = f.runtime.tasks.save;
    f.runtime.tasks.save = async () => { throw new Error('synthetic review save failure'); };
    try {
      await assert.rejects(f.runtime.reviewChange(task.id, change.id, change.artifact_id), /synthetic review save failure/);
    } finally { f.runtime.tasks.save = save; }
    assert.equal((await f.runtime.tasks.get(task.id)).change_reviews?.length, 0);
    onRead = async () => {
      const config = await f.store.load(); config.connections[0].client = '200'; await f.store.save(config);
    };
    await assert.rejects(f.runtime.verifyChangeBaseline(task.id, change.id), { code: 'AGENT_TARGET_CHANGED' });
    onRead = undefined;
    const callsBefore = executed.length;
    await assert.rejects(f.runtime.verifyChangeBaseline(task.id, change.id), { code: 'AGENT_TARGET_CHANGED' });
    assert.equal(executed.length, callsBefore);
    assert.ok(executed.every(item => item.name === 'read_source'));
  } finally { await f.cleanup(); }
});

test('agent tool allowlist uses shared schemas and excludes all writes, queries and connection enumeration', () => {
  assert.ok(agentReadTools.length > 0);
  assert.ok(agentReadTools.includes('get_odata_service_binding'));
  assert.equal(agentModelTools().length, agentReadTools.length);
  for (const tool of agentModelTools(true)) {
    const schema = tool.function.parameters as { properties: Record<string, unknown>; required?: string[] };
    assert.equal(Object.hasOwn(schema.properties, 'connection_id'), false);
    assert.equal(schema.required?.includes('connection_id') ?? false, false);
  }
  for (const name of agentReadTools) assert.equal(writeTools.has(name), false);
  for (const name of ['update_source', 'run_atc', 'run_unit_tests', 'list_connections', '__proto__'])
    assert.throws(() => validateAgentTool(name, {}, connection.connection_id), { code: 'AGENT_TOOL_DENIED' });
  for (const name of agentTableTools)
    assert.throws(() => validateAgentTool(name, {}, connection.connection_id), { code: 'AGENT_TABLE_DATA_DISABLED' });
  assert.throws(() => validateAgentTool('search_objects', { query: 'Z*', connection_id: randomUUID() }, connection.connection_id), { code: 'AGENT_TARGET_CHANGED' });
  assert.throws(() => validateAgentTool('search_objects', { query: 'Z*', injected: true }, connection.connection_id), { code: 'AGENT_INVALID_ARGUMENTS' });
  assert.equal(validateAgentTool('search_objects', { query: 'Z*' }, connection.connection_id).input.limit, 100);
  assert.equal(validateAgentTool('search_objects', { query: 'Z*' }, connection.connection_id).input.connection_id, connection.connection_id);
});

test('table tools are exposed only when allowed, with shared schemas and no write tools', async () => {
  assert.equal(agentModelTools().some(tool => tool.function.name === 'query_table'), false);
  assert.equal(agentModelTools(true).length, agentReadTools.length + 2);
  for (const tool of agentModelTools(true)) assert.equal(writeTools.has(tool.function.name), false);
  const table = validateAgentTool('query_table', { table_name: 'MARA', fields: ['MATNR'], limit: 5 }, connection.connection_id, true);
  assert.equal(table.input.limit, 5);
  assert.equal(validateAgentTool('query_sql', { sql: 'SELECT matnr FROM mara', limit: 5 }, connection.connection_id, true).name, 'query_sql');
  assert.throws(() => validateAgentTool('update_source', {}, connection.connection_id, true), { code: 'AGENT_TOOL_DENIED' });
  await assert.rejects(cliExecutor('unused')('query_table', { table_name: 'MARA', connection_id: connection.connection_id },
    new AbortController().signal), { code: 'AGENT_TABLE_DATA_DISABLED' });
});

test('harness performs discovery and replans when the model skips or batches the prerequisite', async () => {
  for (const batched of [false, true]) {
    let round = 0;
    const executed: string[] = [];
    const f = await fixture(async messages => {
      if (++round === 1) {
        const premature = call('search_objects', { query: 'PREMATURE' });
        if (batched) premature.message.tool_calls!.unshift(...call('get_capabilities').message.tool_calls!);
        return premature;
      }
      assert.ok(JSON.stringify(messages).includes('DISCOVERY_RESULT'));
      assert.equal(JSON.stringify(messages).includes('PREMATURE'), false);
      return round === 2 ? call('search_objects', { query: 'REPLANNED' }) : answer();
    }, async (name, input) => {
      executed.push(name);
      if (name === 'search_objects') assert.equal(input.query, 'REPLANNED');
      return { operation_id: 'fixture-operation', status: 'success', data: { marker: 'DISCOVERY_RESULT' } };
    });
    try {
      const created = await f.runtime.create('解释程序', connection.connection_id);
      const task = await terminal(f.runtime, created.id);
      assert.equal(task.status, 'completed');
      assert.deepEqual(executed, ['get_capabilities', 'search_objects']);
      assert.equal(task.tool_calls, 2);
    } finally { await f.cleanup(); }
  }
});

test('failed automatic discovery keeps SAP reads blocked and lets the model explain the failure', async () => {
  let requests = 0;
  const executed: string[] = [];
  const f = await fixture(async messages => {
    requests++;
    if (requests === 1) return call('search_objects', { query: 'Z*' });
    assert.equal(JSON.parse(messages.at(-1)!.content!).error.code, requests === 2 ? 'DISCOVERY_FAILED' : 'AGENT_CAPABILITIES_REQUIRED');
    return requests === 2 ? call('search_objects', { query: 'Z*' }) : answer('暂时无法验证 SAP 连接。');
  }, async name => {
    executed.push(name);
    throw new AppError('DISCOVERY_FAILED', '无法读取系统能力');
  });
  try {
    const created = await f.runtime.create('解释程序', connection.connection_id);
    const task = await terminal(f.runtime, created.id);
    assert.equal(task.status, 'completed');
    assert.equal(task.capabilities_verified, false);
    assert.deepEqual(executed, ['get_capabilities']);
    assert.equal(requests, 3);
  } finally { await f.cleanup(); }
});

test('a model cannot call table queries when settings are off, even with a forged tool call', async () => {
  for (const name of agentTableTools) {
    let round = 0; const executed: string[] = [];
    const f = await fixture(async (messages, tools) => {
      assert.equal(tools.some(tool => tool.function.name === name), false);
      if (++round === 1) return call('get_capabilities');
      if (round === 2) return call(name, name === 'query_table' ? { table_name: 'MARA' } : { sql: 'SELECT matnr FROM mara' });
      assert.equal(JSON.parse(messages.at(-1)!.content!).error.code, 'AGENT_TABLE_DATA_DISABLED');
      return answer('表数据访问未开启。');
    }, async tool => { executed.push(tool); return { operation_id: 'fixture', status: 'success', data: {} }; });
    try {
      const task = await f.runtime.create('分析', connection.connection_id);
      const result = await terminal(f.runtime, task.id);
      assert.equal(result.status, 'completed');
      assert.deepEqual(executed, ['get_capabilities']);
    } finally { await f.cleanup(); }
  }
});

test('enabled table access is captured in the task and can provide actual rows to the model', async () => {
  let round = 0;
  const f = await fixture(async (messages, tools) => {
    assert.ok(tools.some(tool => tool.function.name === 'query_table'));
    if (++round === 1) return call('get_capabilities');
    if (round === 2) return call('query_table', { table_name: 'MARA', fields: ['MATNR'], limit: 1 });
    assert.ok(JSON.stringify(messages).includes('SYNTHETIC_ROW'));
    return answer('本次只读取了一条合成数据。');
  }, async () => ({ operation_id: 'fixture', status: 'success', data: { rows: [['SYNTHETIC_ROW']] } }), true);
  try {
    const task = await f.runtime.create('读取一条数据', connection.connection_id);
    assert.equal(task.allow_table_data, true);
    const result = await terminal(f.runtime, task.id);
    assert.equal(result.status, 'completed');
    result.status = 'interrupted'; await f.runtime.tasks.save(result);
    await setTablePolicy(f.store,connection.connection_id,false);
    await assert.rejects(f.runtime.resume(task.id), { code: 'AGENT_TABLE_DATA_DISABLED' });
    assert.equal(round, 3);
  } finally { await f.cleanup(); }
});

test('enabling table access does not expand an older code-only task on resume', async () => {
  const f = await fixture(async (_messages, tools) => {
    assert.equal(tools.some(tool => tool.function.name === 'query_table'), false);
    return answer();
  });
  try {
    const created = await f.runtime.create('解释程序', connection.connection_id);
    const task = await terminal(f.runtime, created.id);
    task.status = 'stopped'; await f.runtime.tasks.save(task);
    await setTablePolicy(f.store,connection.connection_id,true);
    await f.runtime.resume(task.id);
    const result = await terminal(f.runtime, task.id);
    assert.equal(result.allow_table_data, false); assert.equal(result.status, 'completed');
  } finally { await f.cleanup(); }
});

test('revoking table access during a query prevents rows from entering persisted model context', async () => {
  let round = 0;
  let store:ConfigStore;
  const f = await fixture(async () => ++round === 1 ? call('get_capabilities')
    : call('query_table', { table_name: 'MARA', limit: 1 }), async name => {
    if (name === 'query_table') {
      await setTablePolicy(store,connection.connection_id,false);
      return { operation_id: 'query', status: 'success', data: { rows: [['MUST_NOT_REACH_MODEL']] } };
    }
    return { operation_id: 'capability', status: 'success', data: {} };
  }, true);
  store = f.store;
  try {
    const created = await f.runtime.create('分析数据', connection.connection_id);
    const result = await terminal(f.runtime, created.id);
    assert.equal(result.status, 'completed');
    assert.match(result.answer!, /表数据访问已关闭/);
    assert.equal(round, 2);
    assert.equal(JSON.stringify(result.messages).includes('MUST_NOT_REACH_MODEL'), false);
    await f.runtime.followUp(created.id, '继续查询');
    const followup = await terminal(f.runtime, created.id);
    assert.match(followup.answer!, /表数据访问已关闭/);
    assert.equal(round, 2);
  } finally { await f.cleanup(); }
});
test('table data permission is isolated per connection and legacy model permission grants nothing',async()=>{
  const f=await fixture(async()=>answer('完成'));
  try{
    await mkdir(join(f.directory,'agent'),{recursive:true});
    await writeFile(join(f.directory,'agent/model.json'),JSON.stringify({schema_version:1,model:'deepseek-flash',allow_table_data:true}));
    const second={...connection,connection_id:randomUUID(),name:'Agent_OTHER',client:'200',allow_table_data:true};
    const config=await f.store.load();config.connections.push(second);await f.store.save(config);
    const first=await f.runtime.create('默认关闭',connection.connection_id);assert.equal(first.allow_table_data,false);await terminal(f.runtime,first.id);
    const allowed=await f.runtime.create('允许的连接',second.connection_id);assert.equal(allowed.allow_table_data,true);
    const result=await terminal(f.runtime,allowed.id);result.status='stopped';await f.runtime.tasks.save(result);
    await setTablePolicy(f.store,connection.connection_id,true);
    await setTablePolicy(f.store,second.connection_id,false);
    await assert.rejects(f.runtime.resume(allowed.id),{code:'AGENT_TABLE_DATA_DISABLED'});
    const firstTask=await f.runtime.tasks.get(first.id);firstTask.status='stopped';await f.runtime.tasks.save(firstTask);
    await f.runtime.resume(first.id);assert.equal((await terminal(f.runtime,first.id)).allow_table_data,false);
    await setTablePolicy(f.store,second.connection_id,true);await f.runtime.resume(allowed.id);
    assert.equal((await terminal(f.runtime,allowed.id)).status,'completed');
  }finally{await f.cleanup();}
});
test('existing connections without a policy default to allowed while explicit choices persist',async()=>{
  const f=await fixture(async()=>answer('完成'));
  try{
    const config=await f.store.load();
    delete config.connections[0].allow_table_data;
    const disabled={...connection,connection_id:randomUUID(),name:'EXPLICIT_OFF',allow_table_data:false};
    config.connections.push(disabled);
    await writeFile(join(f.directory,'config.json'),JSON.stringify(config));
    const loaded=await f.store.load();
    assert.equal(loaded.connections[0].allow_table_data,true);
    assert.equal(loaded.connections[1].allow_table_data,false);
    const task=await f.runtime.create('旧连接',connection.connection_id);
    assert.equal(task.allow_table_data,true);await terminal(f.runtime,task.id);
    const other=await f.runtime.create('已关闭的连接',disabled.connection_id);
    assert.equal(other.allow_table_data,false);await terminal(f.runtime,other.id);
    await f.store.save(loaded);
    const persisted=JSON.parse(await readFile(join(f.directory,'config.json'),'utf8'));
    assert.equal(persisted.connections[0].allow_table_data,true);
    await setTablePolicy(f.store,connection.connection_id,false);
    assert.equal((await new ConfigStore(f.directory).load()).connections[0].allow_table_data,false);
  }finally{await f.cleanup();}
});

test('legacy agent connection policy migrates without changing explicit permissions',async()=>{
  const f=await fixture(async()=>answer('完成'));
  try{
    const config=await f.store.load();
    const legacy = (name:string, agent_allow_table_data:boolean, allow_table_data?:boolean) =>
      ({...connection, connection_id:randomUUID(), name, agent_allow_table_data,
        ...(allow_table_data === undefined ? {} : {allow_table_data})});
    config.connections=[legacy('LEGACY_OFF',false),legacy('LEGACY_ON',true),legacy('CANONICAL_OFF',true,false)];
    await writeFile(join(f.directory,'config.json'),JSON.stringify(config));
    const loaded=await f.store.load();
    assert.deepEqual(loaded.connections.map(item=>item.allow_table_data),[false,true,false]);
    assert.ok(loaded.connections.every(item=>!('agent_allow_table_data' in item)));
    await f.store.save(loaded);
    const saved=JSON.parse(await readFile(join(f.directory,'config.json'),'utf8'));
    assert.deepEqual(saved.connections.map((item:{allow_table_data:boolean})=>item.allow_table_data),[false,true,false]);
    assert.ok(saved.connections.every((item:object)=>!('agent_allow_table_data' in item)));
  }finally{await f.cleanup();}
});

test('real-sized SAP discovery is summarized without losing capability limitations or changing other results', () => {
  const input = { operation_id: 'discovery', status: 'success', completed_steps: [], data: {
    discovery: [{ collection: Array.from({ length: 500 }, () => ({ href: '/service', templateLinks: 'x'.repeat(1000) })) }],
    transport: 'rfc', limitations: ['advertisement is not authorization'], repository_query: { tools: ['find_references'] }
  } };
  const output = projectAgentResult('get_capabilities', input) as any;
  assert.equal(output.operation_id, 'discovery');
  assert.deepEqual(output.data.limitations, input.data.limitations);
  assert.equal(output.data.discovery, undefined);
  assert.equal(output.data.discovery_summary.collection_count, 500);
  assert.equal(output.data.discovery_summary.full_discovery_omitted, true);
  assert.ok(Buffer.byteLength(JSON.stringify(output)) < 4096);
  assert.equal(input.data.discovery.length, 1);
  assert.equal(projectAgentResult('read_source', input), input);
});

test('unsupported SAP object search is reported without losing successful results in the same turn', async () => {
  const operationId = randomUUID();
  const failure = { status: 'error', operation_id: operationId,
    error: { code: 'ADT_ERROR', details: { http_status: 400, sap_message: 'Value IWSV for property TYPE is invalid' } } };
  const projected = projectAgentReadFailure('search_objects', failure)!;
  assert.equal(projected.error.code, 'SEARCH_TYPE_UNSUPPORTED');
  assert.equal(projected.error.http_status, 400);
  assert.equal(projectAgentReadFailure('read_source', { status: 'error', error: { code: 'INVALID_URI' } })?.error.code, 'INVALID_URI');
  assert.equal(projectAgentReadFailure('get_capabilities', failure)?.error.code, 'ADT_ERROR');
  assert.equal(projectAgentReadFailure('search_objects', { status: 'error', error: { code: 'AUTH_FAILED' } })?.error.code, 'AUTH_FAILED');
  let round = 0;
  const f = await fixture(async messages => {
    if (++round === 1) return call('get_capabilities');
    if (round === 2) {
      const calls = ['SRVB', 'IWSV', 'SRVD'].map(type => call('search_objects', { query: '*', type }).message.tool_calls![0]);
      return { message: { role: 'assistant', content: '先查询服务绑定和服务定义。',
        reasoning_content: 'INTERNAL_REASONING_FIXTURE', tool_calls: calls } };
    }
    const results = messages.slice(-3).map(message => JSON.parse(message.content!));
    assert.deepEqual(results.map(result => result.status), ['success', 'error', 'success']);
    assert.equal(results[1].error.code, 'SEARCH_TYPE_UNSUPPORTED');
    assert.equal(results[1].error.details, undefined);
    return answer('已确认服务绑定及服务定义，IWSV 搜索未核实。');
  }, async (_tool, input) => input.type === 'IWSV' ? projected : {
    status: 'success', operation_id: randomUUID(), data: { objects: input.type ? [{ name: input.type }] : [] }
  });
  try {
    const created = await f.runtime.create('帮我查询 OData 对象', connection.connection_id);
    const task = await terminal(f.runtime, created.id);
    assert.equal(task.status, 'completed', JSON.stringify(task.error));
    assert.match(task.answer!, /IWSV 搜索未核实/);
    assert.ok(task.events.some(event => event.type === 'model_finished' && event.summary === '先查询服务绑定和服务定义。'));
    assert.doesNotMatch(JSON.stringify(task.events), /INTERNAL_REASONING_FIXTURE/);
    const failureEvent = task.events.find(event => event.type === 'tool_failed' && event.operation_id === operationId)!;
    assert.ok(failureEvent.result_artifact_id);
    const result = await f.runtime.tasks.toolResult(task.id, failureEvent.sequence, 0);
    assert.equal(JSON.parse(result.text).error.code, 'SEARCH_TYPE_UNSUPPORTED');
    assert.equal(result.next_offset, null);
    await assert.rejects(f.runtime.tasks.toolResult(task.id, 1, 0), { code: 'AGENT_ARTIFACT_UNAVAILABLE' });
  } finally { await f.cleanup(); }
});

test('runtime persists a complete read-only model/tool exchange and correlated events', async () => {
  let turn = 0;
  const f = await fixture(async messages => {
    turn++;
    if (turn === 1) return call('get_capabilities');
    if (turn === 2) {
      assert.equal(messages.at(-1)?.role, 'tool');
      assert.match(messages[0].content!, /跨 Client 共享/);
      return call('search_objects', { query: 'Z*' });
    }
    return answer();
  });

  test('reasoning survives tool rounds but is excluded from readable archives and compaction input', async () => {
    let round = 0;
    const marker = 'INTERNAL_REASONING_ONLY';
    const f = await fixture(async messages => {
      round++;
      if (round === 1) {
        const response = call('get_capabilities');
        response.message.reasoning_content = marker;
        return response;
      }
      assert.ok(messages.some(message => message.reasoning_content === marker));
      return { message: { role: 'assistant', content: '完成', reasoning_content: marker } };
    });
    try {
      const created = await f.runtime.create('分析', connection.connection_id, 'chat');
      const task = await terminal(f.runtime, created.id);
      assert.equal(task.status, 'completed');
      assert.equal(task.messages.filter(message => message.reasoning_content === marker).length, 2);
      let head = task.archive_head;
      while (head) {
        const artifact = await f.runtime.tasks.artifacts.get(task.id, head);
        assert.equal(artifact.content.includes(marker), false);
        head = JSON.parse(artifact.content).previous;
      }
      let summaryInput = '';
      await compactContext(task, f.runtime.tasks, async messages => {
        summaryInput = JSON.stringify(messages);
        return answer('摘要');
      }, [], new AbortController().signal, async () => {}, text => text, true);
      assert.equal(summaryInput.includes(marker), false);
      const contextId = /原始历史附件：([a-f0-9]{64})/.exec(task.memory!)![1];
      assert.equal((await f.runtime.tasks.artifacts.get(task.id, contextId)).content.includes(marker), false);
    } finally { await f.cleanup(); }
  });
  try {
    const task = await f.runtime.create('解释对账程序', connection.connection_id);
    const result = await terminal(f.runtime, task.id);
    assert.equal(result.status, 'completed');
    assert.equal(result.model_requests, 3); assert.equal(result.tool_calls, 2);
    assert.deepEqual(result.messages.map(item => item.role), ['system', 'user', 'assistant', 'tool', 'assistant', 'tool', 'assistant']);
    assert.ok(result.events.some(event => event.operation_id === 'fixture-operation'));
    assert.deepEqual(result.events.map(item => item.sequence), result.events.map((_, index) => index + 1));
    assert.equal((await new TaskStore(f.directory).get(task.id)).answer, result.answer);
  } finally { await f.cleanup(); }
});

test('whole model batch is denied before a write or target switch can reach the executor', async () => {
  const mixed = call('get_capabilities');
  mixed.message.tool_calls!.push(...call('update_source').message.tool_calls!);
  for (const response of [call('update_source'), call('search_objects', { query: 'Z*', connection_id: randomUUID() }), mixed]) {
    let executed = 0;
    const f = await fixture(async () => ({ message: { ...response.message,
      tool_calls: response.message.tool_calls!.map(tool => ({ ...tool, id: randomUUID() })) } }),
      async () => { executed++; return { operation_id: '', status: 'success', data: {} }; });
    try {
      const task = await f.runtime.create('分析', connection.connection_id);
      const result = await terminal(f.runtime, task.id);
      assert.equal(result.status, 'completed'); assert.equal(executed, 0);
      assert.match(result.answer!, /连续几次工具调用未成功/);
    } finally { await f.cleanup(); }
  }
});

test('task stop, interrupted recovery and resume preserve complete-turn checkpoints', async () => {
  let block = true;
  const f = await fixture(async (_messages, _tools, signal) => {
    if (!block) return answer('恢复成功');
    return new Promise((_resolve, reject) => {
      if (signal.aborted) return reject(new Error('aborted'));
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  });
  try {
    const task = await f.runtime.create('分析', connection.connection_id);
    assert.equal((await f.runtime.stop(task.id)).status, 'stopped');
    const stopped = await f.runtime.tasks.get(task.id);
    assert.equal(stopped.messages.length, 2);
    // Simulate a process exiting after checkpointing the next request.
    stopped.status = 'running'; await f.runtime.tasks.save(stopped);
    await f.runtime.initialize();
    assert.equal((await f.runtime.tasks.get(task.id)).status, 'interrupted');
    block = false;
    await f.runtime.resume(task.id);
    assert.equal((await terminal(f.runtime, task.id)).answer, '恢复成功');
  } finally { await f.cleanup(); }
});

test('changed connection identity prevents dispatch and resumption', async () => {
  const f = await fixture(async () => answer());
  try {
    const task = await f.runtime.create('分析', connection.connection_id);
    await terminal(f.runtime, task.id);
    const stored = await f.runtime.tasks.get(task.id); stored.status = 'interrupted'; await f.runtime.tasks.save(stored);
    const config = await f.store.load(); config.connections[0].client = '200'; await f.store.save(config);
    await assert.rejects(f.runtime.resume(task.id), { code: 'AGENT_TARGET_CHANGED' });
    assert.equal(targetFingerprint(connection) === targetFingerprint({ ...connection, client: '200' }), false);
  } finally { await f.cleanup(); }
});

test('CLI verifies the target fingerprint under its configuration lease before any SAP/credential access', async () => {
  const f = await fixture(async () => answer());
  try {
    let touched = false;
    await assert.rejects(runSapOperation(f.store, credentials, 'get_capabilities', { connection_id: connection.connection_id },
      () => { touched = true; throw new Error('unexpected'); }, 'bad-fingerprint'), { code: 'AGENT_TARGET_CHANGED' });
    assert.equal(touched, false);
    // The real child process must also refuse before connecting.
    await assert.rejects(cliExecutor(f.directory, 'bad-fingerprint')('get_capabilities',
      { connection_id: connection.connection_id }, new AbortController().signal), { code: 'AGENT_TARGET_CHANGED' });
  } finally { await f.cleanup(); }
});

test('runtime runs beyond former request limits and resumes legacy budget failures without losing context', async () => {
  let round = 0;
  const f = await fixture(async () => ++round > 160 ? answer() : round === 1 ? call('get_capabilities') : call('search_objects', { query: 'Z*' }));
  try {
    const task = await f.runtime.create('分析', connection.connection_id);
    const result = await terminal(f.runtime, task.id);
    assert.equal(result.status, 'completed');
    assert.equal(result.model_requests, 161);
    assert.equal(result.tool_calls, 160);
    result.status = 'failed'; result.error = { code: 'AGENT_BUDGET_LIMIT', message: '旧版调用上限' };
    await f.runtime.tasks.save(result);
    await f.runtime.resume(task.id);
    const continued = await terminal(f.runtime, task.id);
    assert.equal(continued.status, 'completed');
    assert.equal(continued.model_requests, 162);
    assert.equal(continued.tool_calls, result.tool_calls);
    assert.deepEqual(continued.messages.slice(0, result.messages.length), result.messages);
  } finally { await f.cleanup(); }
});

test('model service failure appears in the conversation without entering retry context', async () => {
  let requests = 0;
  const f = await fixture(async messages => {
    if (++requests === 1) throw new AppError('MODEL_TIMEOUT', 'PRIVATE_PROVIDER_ERROR');
    assert.equal(messages.length, 2);
    return answer('重试完成。');
  });
  try {
    const created = await f.runtime.create('分析', connection.connection_id, 'chat');
    const failed = await terminal(f.runtime, created.id);
    assert.equal(failed.status, 'failed');
    assert.match(failed.answer!, /模型响应超时/);
    assert.doesNotMatch(JSON.stringify(failed), /PRIVATE_PROVIDER_ERROR/);
    assert.deepEqual((await f.runtime.tasks.conversation(created.id)).messages.map(message => message.content),
      ['分析', failed.answer]);
    await f.runtime.resume(created.id);
    const resumed = await terminal(f.runtime, created.id);
    assert.equal(resumed.answer, '重试完成。');
    assert.deepEqual((await f.runtime.tasks.conversation(created.id)).messages.map(message => message.content),
      ['分析', failed.answer, '重试完成。']);
  } finally { await f.cleanup(); }
});

test('runtime does not persist raw unknown exceptions', async () => {
  const bad = await fixture(async () => { throw new Error('PRIVATE_PROVIDER_BODY'); });
  try {
    const task = await bad.runtime.create('分析', connection.connection_id);
    const result = await terminal(bad.runtime, task.id);
    assert.equal(result.error?.code, 'AGENT_FAILED');
    await assert.rejects(bad.runtime.resume(task.id), { code: 'AGENT_NOT_RESUMABLE' });
    assert.equal((await readFile(join(bad.directory, 'agent/tasks', task.id + '.json'), 'utf8')).includes('PRIVATE_PROVIDER_BODY'), false);
  } finally { await bad.cleanup(); }
});

test('task IDs cannot traverse the local task directory', async () => {
  const tasks = new TaskStore(resolve('.saplink/unused'));
  await assert.rejects(tasks.get('../config'), { code: 'AGENT_INVALID_TASK' });
});

test('provider usage accumulates across resume and absent usage is not invented', async () => {
  let reportUsage = true;
  const f = await fixture(async () => ({ ...answer(), ...(reportUsage ? { usage: { prompt_tokens: 100, completion_tokens: 12, total_tokens: 112 } } : {}) }));
  try {
    const created = await f.runtime.create('用量记录', connection.connection_id);
    const task = await terminal(f.runtime, created.id);
    assert.deepEqual(task.model_usage, { reported_requests: 1, prompt_tokens: 100, completion_tokens: 12, total_tokens: 112 });
    task.status = 'interrupted'; await f.runtime.tasks.save(task);
    reportUsage = false; await f.runtime.resume(task.id);
    const resumed = await terminal(f.runtime, task.id);
    assert.deepEqual(resumed.model_usage, task.model_usage);
    assert.equal(resumed.model_requests, 2);
  } finally { await f.cleanup(); }
});

test('reports are conversation-bound, survive normal chat and update only in report mode',async()=>{
  let round=0;
  const f=await fixture(async()=>answer(['初始完整报告','普通聊天回答','第二版报告','另一个会话报告'][round++]));
  try{
    const first=await f.runtime.create('首次分析',connection.connection_id);await terminal(f.runtime,first.id);
    const original=(await f.runtime.tasks.report(first.id)).report!;assert.equal(original.content,'初始完整报告');
    assert.deepEqual(original.tools,[]);assert.equal(original.tools_partial,false);
    await f.runtime.followUp(first.id,'追问');await terminal(f.runtime,first.id);
    assert.equal((await f.runtime.tasks.report(first.id)).report!.id,original.id);
    assert.deepEqual((await f.runtime.tasks.report(first.id)).report,original);
    await f.runtime.followUp(first.id,'更新报告','report');await terminal(f.runtime,first.id);
    assert.equal((await f.runtime.tasks.report(first.id)).report!.content,'第二版报告');
    const other=await f.runtime.create('另一会话',connection.connection_id);await terminal(f.runtime,other.id);
    assert.equal((await f.runtime.tasks.report(other.id)).report!.content,'另一个会话报告');
    assert.equal((await f.runtime.tasks.report(first.id)).report!.content,'第二版报告');
  }finally{await f.cleanup();}
});

test('legacy reports use the original analysis instead of the latest short follow-up',async()=>{
  let round=0;const f=await fixture(async()=>answer(++round===1?'历史完整报告':'后续简短回答'));
  try{
    const first=await f.runtime.create('老对话',connection.connection_id);await terminal(f.runtime,first.id);
    await f.runtime.followUp(first.id,'追问');const task=await terminal(f.runtime,first.id);
    delete task.report_schema;delete task.report_artifact_id;delete task.report_updated_at;delete task.reports;delete task.active_report_id;await f.runtime.tasks.save(task);
    const legacy=(await f.runtime.tasks.report(task.id)).report!;
    assert.equal(legacy.legacy,true);assert.equal(legacy.content,'历史完整报告');
  }finally{await f.cleanup();}
});
test('a conversation keeps independent reports and updates only the requested report',async()=>{
  let round=0;const f=await fixture(async messages=>{if(round===2){const target=messages.find(message=>message.content?.startsWith('当前更新目标报告的历史资料'));assert.ok(target?.content?.includes('报告A'));assert.equal(target?.content?.includes('报告B'),false);}return answer(['报告A','报告B','A的更新版'][round++]);});
  try{
    const task=await f.runtime.create('分析A',connection.connection_id);await terminal(f.runtime,task.id);
    const a=(await f.runtime.tasks.reportList(task.id)).reports[0];
    await f.runtime.followUp(task.id,'分析B','report');await terminal(f.runtime,task.id);
    const list=await f.runtime.tasks.reportList(task.id);assert.equal(list.reports.length,2);
    assert.equal((await f.runtime.tasks.report(task.id,a.id)).report!.content,'报告A');
    const b=list.reports[1];await f.runtime.followUp(task.id,'补充A','report',a.id);await terminal(f.runtime,task.id);
    assert.equal((await f.runtime.tasks.reportList(task.id)).reports.length,2);
    assert.equal((await f.runtime.tasks.report(task.id,a.id)).report!.content,'A的更新版');
    assert.equal((await f.runtime.tasks.report(task.id,b.id)).report!.content,'报告B');
    await assert.rejects(f.runtime.followUp(task.id,'越界','report',randomUUID()),{code:'AGENT_REPORT_NOT_FOUND'});
  }finally{await f.cleanup();}
});
test('report management preserves other reports and conversations, validates versions and migrates legacy reports',async()=>{
  let round=0;const f=await fixture(async()=>answer(['报告A','报告B'][round++]));
  try{
    const task=await f.runtime.create('分析A',connection.connection_id);await terminal(f.runtime,task.id);
    await f.runtime.followUp(task.id,'分析B','report');await terminal(f.runtime,task.id);
    const [a,b]=(await f.runtime.tasks.reportList(task.id)).reports;
    await f.runtime.manageReport(task.id,a.id,a,'重命名报告');
    assert.equal((await f.runtime.tasks.report(task.id,a.id)).report!.title,'重命名报告');
    await assert.rejects(f.runtime.manageReport(task.id,a.id,a),{code:'AGENT_REPORT_CHANGED'});
    await f.runtime.manageReport(task.id,b.id,b);
    const remaining=await f.runtime.tasks.reportList(task.id);assert.equal(remaining.active_report_id,a.id);assert.equal(remaining.reports.length,1);
    assert.equal((await f.runtime.tasks.report(task.id,a.id)).report!.content,'报告A');
    await assert.rejects(f.runtime.tasks.report(task.id,b.id),{code:'AGENT_REPORT_NOT_FOUND'});
    const renamed=remaining.reports[0];await f.runtime.manageReport(task.id,a.id,renamed);
    assert.deepEqual((await f.runtime.tasks.reportList(task.id)).reports,[]);
    assert.equal((await f.runtime.tasks.report(task.id)).report,null);
    assert.ok((await f.runtime.tasks.conversation(task.id)).messages.some(message=>message.content==='报告A'));
    const legacyTask=await f.runtime.tasks.get(task.id);
    delete legacyTask.reports;delete legacyTask.report_schema;delete legacyTask.report_artifact_id;delete legacyTask.active_report_id;
    await f.runtime.tasks.save(legacyTask);
    const legacy=(await f.runtime.tasks.reportList(task.id)).reports[0];assert.equal(legacy.id,'legacy');
    await f.runtime.manageReport(task.id,legacy.id,legacy,'旧报告名称');
    const migrated=(await f.runtime.tasks.reportList(task.id)).reports[0];
    assert.equal(migrated.title,'旧报告名称');assert.equal((await f.runtime.tasks.report(task.id,'legacy')).report!.content,'报告A');
    await f.runtime.manageReport(task.id,'legacy',migrated);
    assert.equal((await f.runtime.tasks.report(task.id)).report,null);
  }finally{await f.cleanup();}
});
test('report management API requires confirmation and validates titles and report ownership',async()=>{
  const f=await fixture(async()=>answer('报告内容'));
  let host:Awaited<ReturnType<typeof startAdmin>>|undefined;
  try{
    const task=await f.runtime.create('分析',connection.connection_id);await terminal(f.runtime,task.id);
    const report=(await f.runtime.tasks.reportList(task.id)).reports[0];
    host=await startAdmin(f.store,credentials,0);const url=new URL(host.url),headers={'X-Admin-Token':url.hash.slice(1),Origin:url.origin,'Content-Type':'application/json'};
    const path=`${url.origin}/api/agent/tasks/${task.id}/reports/${report.id}`;
    const request=(method:string,body:object)=>fetch(path,{method,headers,body:JSON.stringify(body)});
    assert.equal((await request('DELETE',report)).status,400);
    assert.equal((await request('PATCH',{title:'  ',updated_at:report.updated_at,artifact_id:report.artifact_id})).status,400);
    assert.equal((await fetch(path,{method:'PATCH',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
    assert.notEqual((await fetch(`${url.origin}/api/agent/tasks/${task.id}/reports/${randomUUID()}`,{method:'DELETE',headers,body:JSON.stringify({confirm:true,updated_at:report.updated_at,artifact_id:report.artifact_id})})).status,200);
    assert.equal((await request('PATCH',{title:'新标题',updated_at:report.updated_at,artifact_id:report.artifact_id})).status,200);
    assert.notEqual((await request('DELETE',{confirm:true,updated_at:report.updated_at,artifact_id:report.artifact_id})).status,200);
    const updated=(await f.runtime.tasks.reportList(task.id)).reports[0];
    assert.equal((await request('DELETE',{confirm:true,updated_at:updated.updated_at,artifact_id:updated.artifact_id})).status,200);
  }finally{if(host)await host.close();await f.cleanup();}
});
test('report management rejects running tasks',async()=>{
  const f=await fixture(async()=>answer('报告内容'));
  try{
    const task=await f.runtime.create('分析',connection.connection_id);const finished=await terminal(f.runtime,task.id);
    const report=(await f.runtime.tasks.reportList(task.id)).reports[0];
    finished.status='running';await f.runtime.tasks.save(finished);
    await assert.rejects(f.runtime.manageReport(task.id,report.id,report,'新标题'),{code:'AGENT_BUSY'});
    await assert.rejects(f.runtime.manageReport(task.id,report.id,report),{code:'AGENT_BUSY'});
    finished.status='completed';await f.runtime.tasks.save(finished);
    assert.equal((await f.runtime.tasks.reportList(task.id)).reports[0].title,report.title);
  }finally{await f.cleanup();}
});
test('the model can publish a local report without SAP reads and ordinary chat creates none',async()=>{
  let round=0,reads=0;const f=await fixture(async()=>++round===1?answer('你好'):round===2?call('create_report',{title:'独立分析',content:'## 完整结论\n完整报告'}):answer('## 完整结论\n报告已生成'),async()=>{reads++;throw new Error('No SAP call expected');});
  try{
    const task=await f.runtime.create('你好',connection.connection_id,'chat');await terminal(f.runtime,task.id);
    assert.equal((await f.runtime.tasks.reportList(task.id)).reports.length,0);
    await f.runtime.followUp(task.id,'请生成报告');await terminal(f.runtime,task.id);
    const list=await f.runtime.tasks.reportList(task.id);assert.equal(list.reports.length,1);assert.equal(list.reports[0].title,'独立分析');
    assert.equal((await f.runtime.tasks.report(task.id,list.reports[0].id)).report!.content,'## 完整结论\n完整报告');assert.equal(reads,0);
  }finally{await f.cleanup();}
});
test('steering interrupts model output, records the user message and replans in the same turn',async()=>{
  let round=0, began!:()=>void;
  const started=new Promise<void>(resolve=>{began=resolve;});
  const f=await fixture(async (messages,_tools,signal,onDraft)=>{
    if(++round===1){
      onDraft?.('即将被替换的回答');
      began();
      return new Promise((_resolve,reject)=>{
        signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
      });
    }
    assert.equal(messages[1].content,'分析当前对象');
    assert.equal(messages.at(-1)?.content,'先核实日期逻辑');
    return answer('已经按新方向分析。');
  });
  try{
    const task=await f.runtime.create('分析当前对象',connection.connection_id,'chat');
    await started;
    assert.deepEqual(f.runtime.steer(task.id,'先核实日期逻辑'),{accepted:true});
    const done=await terminal(f.runtime,task.id);
    assert.equal(done.answer,'已经按新方向分析。');
    assert.equal(done.events.filter(event=>event.type==='user_guidance').length,1);
    assert.equal(done.events.some(event=>event.type==='followup'),false);
    assert.deepEqual((await f.runtime.tasks.conversation(task.id)).messages.map(message=>message.content),
      ['分析当前对象','先核实日期逻辑','已经按新方向分析。']);
  }finally{await f.cleanup();}
});
test('steering lets the dispatched SAP call finish and skips remaining calls from the old plan',async()=>{
  let round=0, began!:()=>void, finish!:()=>void;
  const started=new Promise<void>(resolve=>{began=resolve;});
  const release=new Promise<void>(resolve=>{finish=resolve;});
  const executed:string[]=[];
  const f=await fixture(async messages=>{
    if(++round===1)return call('get_capabilities');
    if(round===2){
      const first=call('search_objects',{query:'ZFIRST'}).message;
      first.tool_calls!.push(call('search_objects',{query:'ZSECOND'}).message.tool_calls![0]);
      return {message:first};
    }
    assert.equal(messages.at(-1)?.content,'无需继续查询');
    assert.ok(messages.some(message=>message.role==='tool'&&message.content?.includes('AGENT_GUIDANCE_RECEIVED')));
    return answer('已调整范围。');
  },async (...[name,input,signal]:unknown[])=>{
    if(name==='search_objects'){
      executed.push((input as {query:string}).query);
      began();await release;
      assert.equal((signal as AbortSignal).aborted,false);
    }
    return {operation_id:'steer-fixture',status:'success',data:{}};
  });
  try{
    const task=await f.runtime.create('查找对象',connection.connection_id,'chat');
    await started;
    f.runtime.steer(task.id,'无需继续查询');
    finish();
    assert.equal((await terminal(f.runtime,task.id)).answer,'已调整范围。');
    assert.deepEqual(executed,['ZFIRST']);
  }finally{finish();await f.cleanup();}
});
test('assistant questions persist, reject stale replies and resume with selected and skipped answers',async()=>{
  let round=0;
  const f=await fixture(async (messages,tools)=>{
    if(++round===1){
      assert.ok(tools.some(tool=>tool.function.name==='ask_user'));
      return call('ask_user',{questions:[{prompt:'检查哪个模块？',options:['MM','FI']},{prompt:'有什么补充？'}]});
    }
    assert.equal(JSON.parse(messages.find(message=>message.role==='tool')!.content!).status,'waiting_for_user');
    assert.match(messages.at(-1)!.content!,/1\. MM\n2\. 已跳过/);
    return answer('按 MM 范围继续。');
  });
  try{
    const task=await f.runtime.create('帮我确定检查范围',connection.connection_id,'chat');
    const waiting=await terminal(f.runtime,task.id);
    assert.equal(waiting.status,'waiting_input');assert.equal(round,1);
    const pending=(await new TaskStore(f.directory).get(task.id)).pending_question!;
    assert.deepEqual(pending.questions[0].options,['MM','FI']);
    await assert.rejects(f.runtime.answerQuestions(task.id,{question_id:randomUUID(),answers:['MM',null]}),{code:'AGENT_BUSY'});
    await assert.rejects(f.runtime.answerQuestions(task.id,{question_id:pending.id,answers:['MM']}),{code:'AGENT_INVALID_ARGUMENTS'});
    await f.runtime.answerQuestions(task.id,{question_id:pending.id,answers:['MM',null]});
    const done=await terminal(f.runtime,task.id);
    assert.equal(done.answer,'按 MM 范围继续。');
    assert.equal(done.pending_question,undefined);
    assert.equal(done.events.some(event=>event.type==='followup'),false);
    assert.match((await f.runtime.tasks.conversation(task.id)).messages[1].content,/检查哪个模块/);
    await assert.rejects(f.runtime.answerQuestions(task.id,{question_id:pending.id,answers:['MM',null]}),{code:'AGENT_BUSY'});
  }finally{await f.cleanup();}
});
test('a structured analysis sent as chat is saved and becomes the active report',async()=>{
  const first='## 对象\n主程序 ZTEST。\n\n## 完整结论\n已核实主程序入口。';
  const second='## 影响分析\n需回归程序入口。';
  const example='示例标题：\n\n```markdown\n## 完整结论\n这里填写正文。\n```';
  const replies=[first,example,second];
  const f=await fixture(async()=>answer(replies.shift()!));
  try{
    const task=await f.runtime.create('分析一下 ZTEST',connection.connection_id,'chat');
    assert.equal((await terminal(f.runtime,task.id)).answer,first);
    const initial=await f.runtime.tasks.reportList(task.id);
    assert.equal(initial.reports.length,1);
    assert.equal((await f.runtime.tasks.report(task.id)).report!.content,first);
    await f.runtime.followUp(task.id,'Markdown 标题怎么写？');await terminal(f.runtime,task.id);
    assert.deepEqual(await f.runtime.tasks.reportList(task.id),initial);
    await f.runtime.followUp(task.id,'再分析另一个对象的影响');await terminal(f.runtime,task.id);
    const latest=await f.runtime.tasks.reportList(task.id);
    assert.equal(latest.reports.length,2);
    assert.equal(latest.active_report_id,latest.reports[1].id);
    assert.equal((await f.runtime.tasks.report(task.id)).report!.content,second);
  }finally{await f.cleanup();}
});
test('a program overview uses actual source reads and does not depend on exact Markdown headings',async()=>{
  const prompt='看一下中化qas系统的ZSLFIR0034程序';
  const uri='/sap/bc/adt/programs/programs/zslfir0034';
  const analysis='## 对象与版本\nZSLFIR0034 活动版本。\n\n## 业务用途\n读取选择条件并生成清单。';
  let round=0;
  const f=await fixture(async messages=>{
    switch (++round) {
      case 1:
        assert.match(messages[0].content!, /本轮是整个 SAP 程序的独立分析/);
        return call('get_capabilities');
      case 2: return call('read_source',{object_uri:uri});
      case 3: return answer(analysis);
      case 4:
        assert.doesNotMatch(messages[0].content!, /本轮是整个 SAP 程序的独立分析/);
        return call('read_source',{object_uri:uri});
      case 5: return answer('这里初始化选择条件。');
      default: return answer('还需要确认程序所在的系统。');
    }
  },async (...[name]:unknown[])=>({operation_id:'overview-fixture',status:'success',
    data:name==='read_source'?{object_uri:uri,source:'REPORT zslfir0034.'}:{}}));
  try {
    const task=await f.runtime.create(prompt,connection.connection_id,'chat');
    assert.equal((await terminal(f.runtime,task.id)).answer,analysis);
    const saved=await f.runtime.tasks.reportList(task.id);
    assert.equal(saved.reports.length,1);
    assert.equal((await f.runtime.tasks.report(task.id)).report?.content,analysis);
    await f.runtime.followUp(task.id,'看一下 ZSLFIR0034 程序的日期条件');
    await terminal(f.runtime,task.id);
    assert.deepEqual(await f.runtime.tasks.reportList(task.id),saved);
    const unread=await f.runtime.create(prompt,connection.connection_id,'chat');
    await terminal(f.runtime,unread.id);
    assert.equal((await f.runtime.tasks.reportList(unread.id)).reports.length,0);
  }finally{await f.cleanup();}
});
test('natural-language report updates use the viewed report context and preserve other reports',async()=>{
  let round=0;const f=await fixture(async messages=>{
    round++;if(round===1)return answer('报告A');if(round===2)return answer('报告B');
    if(round===3){const note=messages.find(message=>message.content?.startsWith('当前查看的报告资料'))!;assert.ok(note.content?.includes('不是更新指令'));
      const target=JSON.parse(note.content!.slice(note.content!.indexOf('\n')+1));assert.equal(target.content,'报告A');
      return call('update_report',{report_id:target.report_id,content:'报告A新版'});}
    return answer('已更新报告A');
  });
  try{
    const task=await f.runtime.create('分析A',connection.connection_id);await terminal(f.runtime,task.id);
    const a=(await f.runtime.tasks.reportList(task.id)).reports[0];
    await f.runtime.followUp(task.id,'另一个主题','report');await terminal(f.runtime,task.id);
    const b=(await f.runtime.tasks.reportList(task.id)).reports[1];
    await f.runtime.followUp(task.id,'更新这份报告','chat',undefined,a.id);await terminal(f.runtime,task.id);
    assert.equal((await f.runtime.tasks.reportList(task.id)).reports.length,2);
    assert.equal((await f.runtime.tasks.report(task.id,a.id)).report!.content,'报告A新版');
    assert.equal((await f.runtime.tasks.report(task.id,b.id)).report!.content,'报告B');
    await f.runtime.followUp(task.id,'只解释一下','chat',undefined,a.id);await terminal(f.runtime,task.id);
    assert.equal((await f.runtime.tasks.report(task.id,a.id)).report!.content,'报告A新版');
  }finally{await f.cleanup();}
});
test('a model update cannot target a report in another conversation',async()=>{
  let round=0;const foreign=randomUUID();const f=await fixture(async messages=>{
    if(++round===1)return call('update_report',{report_id:foreign,content:'不能保存'});
    assert.equal(JSON.parse(messages.at(-1)!.content!).error.code,'AGENT_REPORT_NOT_FOUND');
    return answer('当前会话没有这份报告。');
  });
  try{const task=await f.runtime.create('更新报告',connection.connection_id,'chat');const result=await terminal(f.runtime,task.id);
    assert.equal(result.status,'completed');assert.equal((await f.runtime.tasks.reportList(task.id)).reports.length,0);
  }finally{await f.cleanup();}
});
test('legacy report migration preserves the old report and identical retried publication is idempotent',async()=>{
  const f=await fixture(async()=>answer('旧报告'));
  try{
    const created=await f.runtime.create('旧会话',connection.connection_id);let task=await terminal(f.runtime,created.id);
    delete task.reports;delete task.active_report_id;await f.runtime.tasks.save(task);
    const old=(await f.runtime.tasks.reportList(task.id)).reports[0];
    const a=await f.runtime.tasks.saveReport(task,'新报告','新主题');await f.runtime.tasks.save(task);
    const b=await f.runtime.tasks.saveReport(task,'新报告','新主题');assert.equal(a.id,b.id);
    assert.equal((await f.runtime.tasks.reportList(task.id)).reports.length,2);
    assert.equal((await f.runtime.tasks.report(task.id,old.id)).report!.content,'旧报告');
  }finally{await f.cleanup();}
});
test('invalid mixed tool batches cannot publish a report before a forbidden SAP operation',async()=>{
  const f=await fixture(async()=>({message:{role:'assistant',content:null,tool_calls:[
    {id:randomUUID(),type:'function',function:{name:'create_report',arguments:JSON.stringify({title:'不应保存',content:'不应保存'})}},
    {id:randomUUID(),type:'function',function:{name:'update_source',arguments:'{}'}}]}}));
  try{const created=await f.runtime.create('分析',connection.connection_id,'chat');const task=await terminal(f.runtime,created.id);
    assert.equal(task.status,'completed');assert.equal((await f.runtime.tasks.reportList(task.id)).reports.length,0);
  }finally{await f.cleanup();}
});
test('identical model report retries do not duplicate a deliverable and a truncated acknowledgement keeps it',async()=>{
  let round=0;const f=await fixture(async()=>++round<=2?call('create_report',{title:'独立成果',content:'完整内容'}):Promise.reject(new AppError('MODEL_OUTPUT_TRUNCATED','截断')));
  try{const created=await f.runtime.create('生成报告',connection.connection_id,'chat');const task=await terminal(f.runtime,created.id);
    assert.equal(task.status,'completed');assert.match(task.answer!,/模型输出超出/);
    const list=await f.runtime.tasks.reportList(task.id);assert.equal(list.reports.length,1);
    assert.equal((await f.runtime.tasks.report(task.id,list.reports[0].id)).report!.content,'完整内容');
  }finally{await f.cleanup();}
});

test('system-filtered history and cleanup expose only the selected connection with independently stored reports',async()=>{
  let round=0;const f=await fixture(async()=>answer(++round===1?'系统A报告':'系统B报告'));
  const otherId=randomUUID();const config=await f.store.load();config.connections.push({...connection,connection_id:otherId,name:'OTHER'});await f.store.save(config);
  let host:Awaited<ReturnType<typeof startAdmin>>|undefined;
  try{
    const a=await f.runtime.create('系统A会话',connection.connection_id);await terminal(f.runtime,a.id);
    const b=await f.runtime.create('系统B会话',otherId);await terminal(f.runtime,b.id);
    host=await startAdmin(f.store,credentials,0);const url=new URL(host.url),headers={'X-Admin-Token':url.hash.slice(1),Origin:url.origin,'Content-Type':'application/json'};
    const filtered=await(await fetch(url.origin+'/api/agent/tasks?connection_id='+connection.connection_id,{headers})).json();
    assert.deepEqual(filtered.tasks.map(task=>task.id),[a.id]);
    const report=await(await fetch(`${url.origin}/api/agent/tasks/${b.id}/report`,{headers})).json();assert.equal(report.report.content,'系统B报告');
    assert.equal((await fetch(`${url.origin}/api/agent/tasks/${b.id}/report`)).status,401);
    const preview=await(await fetch(url.origin+'/api/agent/tasks/cleanup/preview',{method:'POST',headers,
      body:JSON.stringify({older_than_days:0,connection_id:connection.connection_id})})).json();
    assert.deepEqual(preview.candidates.map(task=>task.id),[a.id]);
  }finally{await host?.close();await f.cleanup();}
});

test('follow-up uses the same target, previous answer and source context without repeating SAP reads', async () => {
  let round = 0, reads = 0;
  const f = await fixture(async messages => {
    if (++round === 1) return call('get_capabilities');
    if (round === 2) return call('read_source', { object_uri: '/sap/bc/adt/programs/programs/ztest' });
    if (round === 3) return answer('第一轮：读取的代码输出3。');
    assert.ok(JSON.stringify(messages).includes('第一轮：读取的代码输出3。'));
    assert.ok(JSON.stringify(messages).includes('SECOND_QUESTION'));
    assert.ok(JSON.stringify(messages).includes('SYNTHETIC_SOURCE'));
    return answer('第二轮：沿用之前读取的代码。');
  }, async () => { reads++; return { operation_id: 'fixture', status: 'success', data: { source: 'SYNTHETIC_SOURCE' } }; });
  try {
    const first = await f.runtime.create('第一问', connection.connection_id); await terminal(f.runtime,first.id);
    const next = await f.runtime.followUp(first.id,'SECOND_QUESTION');
    assert.equal(next.id,first.id); assert.equal(next.connection_id,connection.connection_id);
    const task = await terminal(f.runtime,first.id);
    assert.equal(task.status,'completed'); assert.equal(reads,2);
    const transcript = await f.runtime.tasks.conversation(task.id);
    assert.deepEqual(transcript.messages.map(m => m.content),['第一问','第一轮：读取的代码输出3。','SECOND_QUESTION','第二轮：沿用之前读取的代码。']);
    assert.equal(transcript.next_cursor,null);
    const config = await f.store.load(); config.connections[0].client='200'; await f.store.save(config);
    await f.runtime.followUp(task.id,'再问');
    const changed = await terminal(f.runtime, task.id);
    assert.equal(changed.status, 'completed');
    assert.match(changed.answer!, /原 SAP 连接已变化/);
    assert.equal(round, 4);
    assert.equal(reads, 2);
  } finally { await f.cleanup(); }
});

test('public conversation pages survive compaction and legacy task migration without leaking tool history', async () => {
  const f = await fixture(async messages => answer('答：'+messages.at(-1)!.content));
  try {
    const first = await f.runtime.create('问题0',connection.connection_id); await terminal(f.runtime,first.id);
    const old = await f.runtime.tasks.get(first.id); delete old.archive_head; await f.runtime.tasks.save(old);
    assert.equal((await f.runtime.tasks.conversation(first.id)).messages.length,2);
    for (let i=1;i<=12;i++) { await f.runtime.followUp(first.id,'问题'+i); await terminal(f.runtime,first.id); }
    let cursor: string | undefined; let messages: {id:string;role:string;content:string}[]=[];
    do {
      const page = await f.runtime.tasks.conversation(first.id,cursor);
      messages = [...page.messages,...messages]; cursor = page.next_cursor ?? undefined;
    } while(cursor);
    assert.equal(messages.length,26); assert.equal(new Set(messages.map(m=>m.id)).size,26);
    assert.equal(messages[0].content,'问题0'); assert.equal(messages.at(-1)!.content,'答：问题12');
    assert.ok(messages.every(message=>['user','assistant'].includes(message.role)));
    await assert.rejects(f.runtime.tasks.conversation(first.id,'../config'),{code:'AGENT_ARTIFACT_INVALID'});
  } finally { await f.cleanup(); }
});

test('unfinished streamed drafts are visible live but never become saved answers',async()=>{
  let started!:()=>void;
  const ready=new Promise<void>(resolve=>{started=resolve;});
  const f=await fixture(async(_messages,_tools,signal,onText)=>{
    onText('未完成的草稿');started();
    return new Promise((_resolve,reject)=>{
      if(signal.aborted)return reject(new Error('stopped'));
      signal.addEventListener('abort',()=>reject(new Error('stopped')),{once:true});
    });
  });
  try{
    const task=await f.runtime.create('实时输出',connection.connection_id);await ready;
    assert.equal(f.runtime.liveSnapshot(task.id).text,'未完成的草稿');
    assert.equal((await f.runtime.tasks.get(task.id)).answer,undefined);
    const stopped=await f.runtime.stop(task.id);assert.equal(stopped.status,'stopped');
    assert.equal(f.runtime.liveSnapshot(task.id).text,'');
    assert.equal((await f.runtime.exportConversation(task.id)).includes('未完成的草稿'),false);
  }finally{await f.cleanup();}
});

test('rename, pin, public export and deletion preserve other tasks and remove archived attachments',async()=>{
  const f=await fixture(async()=>answer('公开答案'));
  try{
    const a=await f.runtime.create('第一个问题',connection.connection_id);await terminal(f.runtime,a.id);
    const b=await f.runtime.create('第二个问题',connection.connection_id);await terminal(f.runtime,b.id);
    const renamed=await f.runtime.edit(a.id,{title:'我的会话',pinned:true});
    assert.equal(renamed.title,'我的会话');assert.equal(renamed.pinned,true);
    const exported=await f.runtime.exportConversation(a.id);
    assert.match(exported,/# 我的会话/);assert.match(exported,/第一个问题/);assert.match(exported,/公开答案/);
    assert.equal(exported.includes('你是 SapLink'),false);
    assert.equal((await f.runtime.cleanupPreview(0,[])).candidates.some(task=>task.id===a.id),false);
    const removed=await f.runtime.remove(a.id,renamed.updated_at);assert.equal(removed.cleanup_pending,false);
    await assert.rejects(f.runtime.tasks.get(a.id),{code:'AGENT_TASK_NOT_FOUND'});
    await assert.rejects(stat(join(f.runtime.tasks.directory,a.id)),{code:'ENOENT'});
    assert.equal((await f.runtime.tasks.get(b.id)).answer,'公开答案');
    await assert.rejects(f.runtime.remove('../config','invalid'),{code:'AGENT_INVALID_TASK'});
  }finally{await f.cleanup();}
});

test('cleanup skips kept, pinned, active and changed conversations and deletes only reviewed snapshots',async()=>{
  let block=false;
  const f=await fixture(async(_messages,_tools,signal)=>{
    if(!block)return answer();
    return new Promise((_resolve,reject)=>{if(signal.aborted)return reject(new Error('stopped'));signal.addEventListener('abort',()=>reject(new Error('stopped')),{once:true});});
  });
  try{
    const ids:string[]=[];
    for(let i=0;i<4;i++){const t=await f.runtime.create('会话'+i,connection.connection_id);await terminal(f.runtime,t.id);ids.push(t.id);}
    await f.runtime.edit(ids[0],{pinned:true});
    const preview=await f.runtime.cleanupPreview(0,[ids[1]]);
    assert.deepEqual(new Set(preview.candidates.map(t=>t.id)),new Set(ids.slice(2)));
    await f.runtime.edit(ids[2],{title:'清单确认后改名'});
    block=true;const running=await f.runtime.create('运行中',connection.connection_id);
    await assert.rejects(f.runtime.remove(running.id,running.updated_at),{code:'AGENT_BUSY'});
    assert.equal((await f.runtime.cleanupPreview(0,[])).candidates.some(t=>t.id===running.id),false);
    const result=await f.runtime.cleanup(preview.candidates);
    assert.deepEqual(result.deleted.map(t=>t.id),[ids[3]]);
    assert.ok(result.skipped.some(t=>t.id===ids[2]&&t.code==='AGENT_TASK_CHANGED'));
    assert.equal((await f.runtime.tasks.get(ids[0])).pinned,true);
    await f.runtime.stop(running.id);
  }finally{await f.cleanup();}
});

test('interrupted task deletion resumes on startup without touching unrelated paths',async()=>{
  const f=await fixture(async()=>answer());
  try{
    const t=await f.runtime.create('删除恢复',connection.connection_id);const done=await terminal(f.runtime,t.id);
    const trash=join(f.runtime.tasks.directory,'.trash');await mkdir(trash,{recursive:true});
    const {rename}=await import('node:fs/promises');
    await rename(join(f.runtime.tasks.directory,t.id+'.json'),join(trash,t.id+'.json'));
    await new TaskStore(f.directory).recover();
    await assert.rejects(stat(join(f.runtime.tasks.directory,t.id)),{code:'ENOENT'});
    await assert.rejects(stat(join(trash,t.id+'.json')),{code:'ENOENT'});
    assert.equal(done.status,'completed');
  }finally{await f.cleanup();}
});

test('batched tools can exceed the former 128-call total', async () => {
  let round = 0, executed = 0;
  const f = await fixture(async () => {
    if (++round === 1) return call('get_capabilities');
    if (round > 41) return answer();
    const batch = call('search_objects', { query: 'Z*' });
    for (let i = 1; i < 4; i++) batch.message.tool_calls!.push(...call('search_objects', { query: 'Z*' }).message.tool_calls!);
    return batch;
  }, async () => { executed++; return { operation_id: 'fixture', status: 'success', data: {} }; });
  try {
    const created = await f.runtime.create('分析', connection.connection_id);
    const task = await terminal(f.runtime, created.id);
    assert.equal(task.status, 'completed');
    assert.equal(task.tool_calls, 161);
    assert.equal(executed, 161);
    assert.equal(task.messages.filter(message => message.role === 'tool').length, 161);
  } finally { await f.cleanup(); }
});

test('task snapshots tolerate polling during writes and damaged history cannot run on recovery', async () => {
  const f = await fixture(async () => answer());
  try {
    const created = await f.runtime.create('分析', connection.connection_id);
    await terminal(f.runtime, created.id);
    const snapshot = await f.runtime.tasks.get(created.id);
    await Promise.all(Array.from({ length: 30 }, (_, i) => i % 2
      ? f.runtime.tasks.save(structuredClone(snapshot)) : f.runtime.tasks.get(created.id)));
    assert.equal((await f.runtime.tasks.get(created.id)).status, 'completed');
    const broken = randomUUID();
    await writeFile(join(f.directory, 'agent/tasks', broken + '.json'), '{"schema_version":1}');
    await f.runtime.initialize();
    await assert.rejects(f.runtime.tasks.get(broken), { code: 'AGENT_TASK_UNREADABLE' });
  } finally { await f.cleanup(); }
});

test('same-connection tasks run in parallel and stop discards only the selected unfinished batch', async () => {
  let toolStarted!: () => void, releaseTool!: () => void, parallelStarted!: () => void;
  const started = new Promise<void>(resolve => { toolStarted = resolve; });
  const toolGate = new Promise<void>(resolve => { releaseTool = resolve; });
  const streaming = new Promise<void>(resolve => { parallelStarted = resolve; });
  const f = await fixture(async (messages,_tools,signal,onText) => {
    if (messages[1].content !== '分析 B') return call('get_capabilities');
    onText('B 的实时输出');
    parallelStarted();
    return new Promise((_resolve,reject) => {
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
    });
  }, async () => {
    toolStarted();
    await toolGate;
    return { operation_id: 'read-only', status: 'success', data: {} };
  });
  try {
    const other = {...connection,connection_id:randomUUID()};
    const config = await f.store.load();
    config.connections.push(other); await f.store.save(config);
    const [task, parallel] = await Promise.all([
      f.runtime.create('分析 A', connection.connection_id),
      f.runtime.create('分析 B', connection.connection_id)
    ]);
    await Promise.all([started,streaming]);
    const status = await f.runtime.status();
    assert.deepEqual(status.active_task_ids,[task.id,parallel.id]);
    assert.equal(status.active_connection_id,connection.connection_id);
    assert.notEqual(f.runtime.liveSnapshot(task.id).run_id,f.runtime.liveSnapshot(parallel.id).run_id);
    assert.equal(f.runtime.liveSnapshot(task.id).text,'');
    assert.equal(f.runtime.liveSnapshot(parallel.id).text,'B 的实时输出');
    await assert.rejects(f.runtime.followUp(task.id,'重复发送'), { code: 'AGENT_BUSY' });
    await assert.rejects(f.runtime.create('另一系统', other.connection_id), { code: 'AGENT_BUSY' });
    const stopping = f.runtime.stop(task.id);
    releaseTool();
    const stopped = await stopping;
    assert.equal(stopped.status, 'stopped');
    assert.equal(stopped.messages.length, 2);
    assert.equal(stopped.tool_calls, 1);
    assert.deepEqual((await f.runtime.status()).active_task_ids,[parallel.id]);
    assert.equal(f.runtime.liveSnapshot(parallel.id).finished,false);
    await assert.rejects(f.runtime.create('另一系统', other.connection_id), { code: 'AGENT_BUSY' });
    await f.runtime.stop(parallel.id);
    assert.equal((await f.runtime.status()).active_connection_id,null);
    const switched = await f.runtime.create('另一系统', other.connection_id);
    assert.equal((await f.runtime.status()).active_connection_id,other.connection_id);
    await f.runtime.stop(switched.id);
  } finally { releaseTool(); await f.cleanup(); }
});

test('oversized discovery reports the tool error and leaves capabilities unverified', async () => {
  let round = 0;
  const f = await fixture(async messages => {
    if (++round === 1) return call('get_capabilities');
    assert.equal(JSON.parse(messages.at(-1)!.content!).error.code, 'AGENT_RESULT_LIMIT');
    return answer('能力验证结果过大。');
  }, async () => ({ operation_id: 'large',
    status: 'success', data: { text: 'x'.repeat(65537) } }));
  try {
    const task = await f.runtime.create('分析', connection.connection_id);
    const result = await terminal(f.runtime, task.id);
    assert.equal(result.status, 'completed');
    assert.equal(result.capabilities_verified, false);
  } finally { await f.cleanup(); }
});

test('oversized CLI output returns an explicit error so the model can narrow its query', async () => {
  for (const cliFailure of [true]) {
    let round = 0;
    const f = await fixture(async messages => {
      if (++round === 1) return call('get_capabilities');
      if (round === 2) return call('list_package_objects', { package_name: 'ZTEST', limit: 100 });
      if (round === 3) {
        const result = JSON.parse(messages.at(-1)!.content!);
        assert.equal(result.status, 'error');
        assert.equal(result.error.code, 'AGENT_RESULT_LIMIT');
        assert.equal(JSON.stringify(messages).includes('x'.repeat(1000)), false);
        return call('list_package_objects', { package_name: 'ZTEST', limit: 1 });
      }
      return answer('仅核实返回的一项。');
    }, async (name, input) => {
      if (name === 'list_package_objects' && input.limit === 100) {
        if (cliFailure) throw new AppError('AGENT_RESULT_LIMIT', 'too large');
        return { operation_id: 'large', status: 'success', data: { text: 'x'.repeat(65537) } };
      }
      return { operation_id: 'small', status: 'success', data: {} };
    });
    try {
      const created = await f.runtime.create('分析开发包', connection.connection_id);
      const task = await terminal(f.runtime, created.id);
      assert.equal(task.status, 'completed');
      assert.ok(task.events.some(event => event.type === 'tool_failed'));
    } finally { await f.cleanup(); }
  }
});

test('large source is archived completely and can be paged only inside its originating task', async () => {
  let round = 0, artifact = '';
  const source = 'WRITE / hello.\n'.repeat(8000) + 'EXACT_END_MARKER';
  const f = await fixture(async messages => {
    if (++round === 1) return call('get_capabilities');
    if (round === 2) return call('read_source', { object_uri: '/sap/bc/adt/programs/programs/ztest' });
    if (round === 3) {
      const result = JSON.parse(messages.at(-1)!.content!);
      assert.equal(result.preview, true); assert.equal(result.complete, false);
      assert.equal(JSON.stringify(messages).includes('EXACT_END_MARKER'), false);
      artifact = result._task_artifact.artifact_id;
      return call('read_task_artifact', { artifact_id: artifact, offset: source.length - 30, length: 30 });
    }
    assert.match(JSON.parse(messages.at(-1)!.content!).text, /EXACT_END_MARKER/);
    const progress = messages.find(message => message.content?.startsWith('执行器记录的源码提供范围'));
    assert.ok(progress); assert.match(progress.content!, /"ranges"/);
    return answer();
  }, async name => ({ operation_id: 'fixture', status: 'success', data: name === 'read_source'
    ? { source, revision: 'revision', version: 'active' } : {} }));
  try {
    const created = await f.runtime.create('分析大程序', connection.connection_id);
    const task = await terminal(f.runtime, created.id);
    assert.equal(task.status, 'completed');
    const raw = await f.runtime.tasks.artifacts.get(task.id, artifact);
    assert.equal(JSON.parse(raw.content).data.source, source);
    await assert.rejects(f.runtime.tasks.artifacts.get(randomUUID(), artifact), { code: 'AGENT_ARTIFACT_UNAVAILABLE' });
    await assert.rejects(f.runtime.tasks.artifacts.get(task.id, '../config'), { code: 'AGENT_ARTIFACT_INVALID' });
    await writeFile(join(f.runtime.tasks.directory, task.id, 'artifacts', artifact + '.json'), '{}');
    await assert.rejects(f.runtime.tasks.artifacts.get(task.id, artifact), { code: 'AGENT_ARTIFACT_UNAVAILABLE' });
  } finally { await f.cleanup(); }
});

test('1M context compacts before exhausting space for the model response', async () => {
  const f = await fixture(async () => answer());
  try {
    const created = await f.runtime.create('核对 1M 上下文', connection.connection_id);
    const task = await terminal(f.runtime, created.id);
    task.context_tokens = 1000000;
    task.messages = task.messages.slice(0,2);
    for (let index = 0; index < 2; index++)
      task.messages.push({role:'assistant',content:'x'.repeat(1420000)});
    const estimated = estimateTokens(workingMessages(task));
    assert.ok(estimated > 936000 && estimated < 1000000);
    await compactContext(task,f.runtime.tasks,async messages => {
      assert.ok(estimateTokens(messages) <= 936000);
      return answer('继续核对。');
    },[],new AbortController().signal,async () => {},text => text);
    assert.equal(task.compactions,1);
  } finally { await f.cleanup(); }
});

test('compaction reserves space for fixed instructions before retaining complete tool batches', async () => {
  const f = await fixture(async () => answer());
  try {
    const created = await f.runtime.create('保留完整证据', connection.connection_id);
    const task = await terminal(f.runtime, created.id);
    task.context_tokens = 16000;
    task.messages = task.messages.slice(0, 2);
    const fixed = estimateTokens(workingMessages(task));
    task.messages[0].content += 's'.repeat((14000 - fixed) * 3);
    for (let i = 0; i < 3; i++) task.messages.push(
      { role: 'assistant', content: null, tool_calls: [{ id: `batch-${i}`, type: 'function',
        function: { name: 'read_source', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: `batch-${i}`, content: 'x'.repeat(6000) + `END-${i}` });
    const original = structuredClone(task.messages);
    await compactContext(task, f.runtime.tasks, async messages => {
      const input = JSON.parse(messages[1].content!);
      assert.deepEqual(input.receipts.map(message => message.tool_call_id).filter(Boolean),
        ['batch-0', 'batch-1', 'batch-2']);
      for (let i = 0; i < 3; i++) assert.ok(input.receipts.some(message => message.content?.endsWith(`END-${i}`)));
      return answer('三份源码均已读取，保留证据，继续原目标。');
    }, [], new AbortController().signal, async () => {}, text => text);
    assert.equal(task.compactions, 1);
    assert.ok(estimateTokens(workingMessages(task)) <= task.context_tokens);
    assert.deepEqual(task.messages, original.slice(0, 2));
    const archiveId = task.memory!.match(/原始历史附件：([a-f0-9]{64})/)![1];
    const archived = JSON.parse((await f.runtime.tasks.artifacts.get(task.id, archiveId)).content);
    assert.deepEqual(archived.messages, original);
  } finally { await f.cleanup(); }
});

test('long tasks compact complete turns repeatedly, archive every turn, and resume from persisted memory', async () => {
  let round = 0, summaries = 0;
  let resumeMemory:string|undefined;
  const f = await fixture(async (messages, tools) => {
    if (!tools.length) {
      summaries++;
      const input = JSON.parse(messages[1].content!);
      if(resumeMemory)assert.equal(input.previous_memory,resumeMemory);
      assert.ok(input.receipts.some(receipt => receipt.evidence?.artifact?.artifact_id));
      assert.ok(input.receipts.some(receipt => receipt.content?.includes('SUMMARY_MUST_SEE_THE_END')));
      return answer('已核实部分程序；原始数据以附件为准，继续核实尚未完成的依赖。');
    }
    assert.ok(estimateTokens(messages, tools) <= smallTestContext);
    assert.equal(messages[1].content, '长任务的原始目标');
    const pending = new Set<string>();
    for (const message of messages) {
      for (const c of message.tool_calls ?? []) pending.add(c.id);
      if (message.role === 'tool') { assert.ok(pending.delete(message.tool_call_id!)); }
    }
    assert.equal(pending.size, 0);
    if (++round > 45) return answer('长任务完成');
    return round === 1 ? call('get_capabilities') : call('read_source', { object_uri: '/sap/bc/adt/programs/programs/ztest' });
  }, async () => ({ operation_id: 'fixture', status: 'success', data: { source: 'WRITE / sample.\n'.repeat(700) + 'SUMMARY_MUST_SEE_THE_END' } }));
  try {
    useSmallTestContext(f.runtime);
    const created = await f.runtime.create('长任务的原始目标', connection.connection_id);
    const task = await terminal(f.runtime, created.id);
    assert.equal(task.status, 'completed', JSON.stringify(task.error));
    assert.ok(summaries > 1); assert.equal(task.compactions, summaries);
    assert.equal(task.model_requests, 46 + summaries);
    assert.ok(task.messages.length < 45 * 2);
    let head = task.archive_head, archivedTurns = 0;
    while (head) {
      const archived = JSON.parse((await f.runtime.tasks.artifacts.get(task.id, head)).content);
      archivedTurns++; head = archived.previous;
    }
    assert.equal(archivedTurns, 46);
    task.status = 'interrupted'; await f.runtime.tasks.save(task);
    resumeMemory=task.memory;
    await f.runtime.resume(task.id);
    const resumed = await terminal(f.runtime, task.id);
    assert.equal(resumed.status, 'completed');
    if(resumed.compactions===task.compactions)assert.equal(resumed.memory,task.memory);
    else{assert.equal(resumed.compactions,task.compactions!+1);assert.ok(resumed.memory?.startsWith('已核实部分程序；原始数据以附件为准'));}
    assert.equal(resumed.capabilities_verified, true);
  } finally { await f.cleanup(); }
});

test('rolling event snapshots preserve every archived event and monotonic sequence', async () => {
  const f = await fixture(async () => answer());
  try {
    const created = await f.runtime.create('轨迹', connection.connection_id);
    const task = await terminal(f.runtime, created.id);
    for (let i = 0; i < 1100; i++) taskEvent(task, 'test_event');
    const last = task.events.at(-1)!.sequence;
    await f.runtime.tasks.save(task);
    assert.equal(task.events.length, 256);
    const prior = JSON.parse((await f.runtime.tasks.artifacts.get(task.id, task.event_archive_head!)).content).events;
    assert.equal(prior.length + task.events.length, last);
    assert.deepEqual([...prior, ...task.events].map(e => e.sequence), Array.from({length: last}, (_, i) => i + 1));
    taskEvent(task, 'later'); await f.runtime.tasks.save(task);
    assert.equal((await f.runtime.tasks.get(task.id)).events.at(-1)!.sequence, last + 1);
  } finally { await f.cleanup(); }
});

test('stop during compaction preserves the old checkpoint and resumes the summary safely', { timeout: 15000 }, async () => {
  let started!: () => void, block = true, round = 0;
  const compacting = new Promise<void>(resolve => { started = resolve; });
  const f = await fixture(async (_messages, tools, signal) => {
    if (!tools.length) {
      if (!block) return answer('继续原目标，原始证据以附件为准。');
      started();
      return new Promise((_resolve, reject) => {
        if (signal.aborted) return reject(new Error('stopped'));
        signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true });
      });
    }
    if (!block) return answer('恢复完成');
    return ++round === 1 ? call('get_capabilities') : call('read_source', { object_uri: '/sap/bc/adt/programs/programs/ztest' });
  }, async () => ({ operation_id: 'fixture', status: 'success', data: { source: 'WRITE / sample.\n'.repeat(700) } }));
  try {
    useSmallTestContext(f.runtime);
    const created = await f.runtime.create('可恢复的长任务', connection.connection_id);
    await compacting;
    const stopped = await f.runtime.stop(created.id);
    assert.equal(stopped.status, 'stopped'); assert.equal(stopped.memory, undefined);
    const old = structuredClone(stopped.messages);
    assert.equal(old.at(-1)?.role, 'tool');
    block = false;
    await f.runtime.resume(created.id);
    const result = await terminal(f.runtime, created.id);
    assert.equal(result.status, 'completed', JSON.stringify(result.error)); assert.equal(result.compactions, 1);
    assert.match(result.memory!, /继续原目标/);
    const context = result.memory!.match(/原始历史附件：([a-f0-9]{64})/)![1];
    const original = JSON.parse((await f.runtime.tasks.artifacts.get(created.id, context)).content);
    assert.deepEqual(original.messages, old);
  } finally { block = false; await f.cleanup(); }
});

test('compaction failure preserves history for retry and never promotes an invalid summary', async () => {
  let round = 0, retry = false;
  const f = await fixture(async (_messages, tools) => {
    if (!tools.length) return retry ? answer('恢复的工作摘要') : call('read_source');
    if (retry) return answer('完成');
    return ++round === 1 ? call('get_capabilities') : call('read_source', { object_uri: '/sap/bc/adt/programs/programs/ztest' });
  }, async () => ({ operation_id: 'fixture', status: 'success', data: { source: 'WRITE / sample.\n'.repeat(700) } }));
  try {
    useSmallTestContext(f.runtime);
    const created = await f.runtime.create('摘要故障', connection.connection_id);
    const failed = await terminal(f.runtime, created.id);
    assert.equal(failed.status, 'completed');
    assert.match(failed.answer!, /原始记录仍保留/);
    assert.equal(failed.memory, undefined); assert.equal(failed.messages.at(-2)?.role, 'tool');
    retry = true; await f.runtime.followUp(created.id, '缩小范围，继续分析');
    const resumed = await terminal(f.runtime, created.id);
    assert.equal(resumed.status, 'completed', JSON.stringify(resumed.error));
  } finally { await f.cleanup(); }
});

const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
test('DeepSeek web search accepts only safe source links and reports sanitized failures', async () => {
  const signal = new AbortController().signal;
  const search = deepSeekSearch('SYNTHETIC',async (url,request) => {
    assert.equal(url,'https://api.deepseek.com/v1/tools/search');
    assert.deepEqual(JSON.parse(request!.body as string),{query:'ABAP',count:5,need_content:false});
    return Response.json({results:[
      {title:'SAP Help',url:'https://help.sap.com/docs/abap',snippet:'ABAP'},
      {title:'Duplicate',url:'https://help.sap.com/docs/abap'},
      {title:'Invalid',url:'javascript:alert(1)'},
      {title:'Credential URL',url:'https://user:secret@example.com'}
    ]});
  });
  assert.deepEqual(await search('ABAP',signal),{status:'success',data:{results:[
    {title:'SAP Help',url:'https://help.sap.com/docs/abap',summary:'ABAP'}
  ]}});
  const limited = deepSeekSearch('SYNTHETIC',async () => new Response('provider detail',{status:429}));
  const result = await limited('ABAP',signal);
  assert.equal(result.status,'error');
  if (result.status === 'error') assert.equal(result.error.code,'WEB_SEARCH_RATE_LIMIT');
  assert.doesNotMatch(JSON.stringify(result),/provider detail|SYNTHETIC/);
});
const stream = (content = '中文') => frame({ choices: [{ index: 0, delta: { content }, finish_reason: null }] }) +
  frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { total_tokens: 10 } }) + 'data: [DONE]\n\n';

test('production DeepSeek transport streams Chinese with medium thinking by default and preserves usage', async () => {
  let partial = '';
  const model = deepSeekModel('PRIVATE', 'deepseek-flash', async (url, options) => {
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    const body = JSON.parse(options!.body as string);
    assert.deepEqual(body.thinking, { type: 'enabled' });
    assert.equal(body.reasoning_effort,'high');
    assert.equal(body.max_tokens, 393216);
    assert.equal(options!.redirect, 'error');
    return new Response(stream(), { headers: { 'Content-Type': 'text/event-stream' } });
  });
  const response = await model([], [], new AbortController().signal, text => { partial += text; });
  assert.equal(partial, '中文'); assert.equal(response.usage?.total_tokens, 10);
});

test('DeepSeek thinking mode forwards reasoning across tool calls at maximum effort', async () => {
  const events = frame({ choices: [{ index: 0, delta: { reasoning_content: '分析' }, finish_reason: null }] }) +
    frame({ choices: [{ index: 0, delta: { reasoning_content: '过程', tool_calls: [{ index: 0, id: 'call-1',
      type: 'function', function: { name: 'lookup', arguments: '{}' } }] }, finish_reason: null }] }) +
    frame({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n';
  let captured: { thinking: { type: string }; reasoning_effort?: string; messages: Message[] } | undefined;
  const request: typeof fetch = async (_url, options) => {
    captured = JSON.parse(options!.body as string);
    return new Response(events, { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const model = deepSeekModel('PRIVATE', 'deepseek-flash', request, 'max');
  let shown = '';
  const first = await model([], [], new AbortController().signal, chunk => { shown += chunk; });
  assert.equal(shown, '');
  assert.equal(first.message.reasoning_content, '分析过程');
  assert.deepEqual(captured?.thinking, { type: 'enabled' });
  assert.equal(captured?.reasoning_effort, 'max');
  await model([first.message, { role: 'tool', content: '{}', tool_call_id: 'call-1' }], [],
    new AbortController().signal, () => {});
  assert.equal(captured?.messages[0].reasoning_content, '分析过程');
  await model([{ role: 'assistant', content: '旧回答' }], [], new AbortController().signal, () => {});
  assert.equal(captured?.messages[0].reasoning_content, '');

});

test('assistant compacts and retries a rejected context without replaying completed SAP reads', async () => {
  let requests = 0;
  const executed: string[] = [];
  const f = await fixture(async (messages, tools) => {
    if (!tools.length) {
      assert.match(messages[1].content!, /SYNTHETIC_CONTEXT/);
      return answer('已读取对象，保留核实结果。');
    }
    switch (++requests) {
      case 1: return call('get_capabilities');
      case 2: return call('search_objects', { query: 'Z*' });
      case 3: throw new AppError('MODEL_CONTEXT_LIMIT', '上下文超限');
      default:
        assert.ok(messages.some(message => message.content?.includes('已读取对象，保留核实结果')));
        return answer('压缩后完成回答。');
    }
  }, async name => {
    executed.push(name);
    return { operation_id: 'fixture', status: 'success', data: name === 'search_objects'
      ? { text: 'SYNTHETIC_CONTEXT' + 'a'.repeat(30000) } : {} };
  });
  try {
    const created = await f.runtime.create('核实对象', connection.connection_id);
    const task = await terminal(f.runtime, created.id);
    assert.equal(task.answer, '压缩后完成回答。');
    assert.equal(task.compactions, 1);
    assert.equal(task.model_requests, 5);
    assert.deepEqual(executed, ['get_capabilities', 'search_objects']);
  } finally { await f.cleanup(); }
});

test('assistant joins a truncated answer and requests continuation without tools', async () => {
  let round = 0;
  const f = await fixture(async (messages, tools) => {
    if (++round === 1) throw new ModelLengthError('已核实。这里是需要去重的连续回答片段。', false, { completion_tokens: 10 });
    assert.equal(tools.length, 0);
    assert.match(messages.at(-1)!.content!, /只输出后续正文/);
    return answer('这里是需要去重的连续回答片段。最终结论。');
  });
  try {
    const created = await f.runtime.create('解释对象', connection.connection_id, 'chat');
    const task = await terminal(f.runtime, created.id);
    assert.equal(task.answer, '已核实。这里是需要去重的连续回答片段。最终结论。');
    assert.equal(task.model_usage?.reported_requests, 1);
  } finally { await f.cleanup(); }
});

test('assistant retries a truncated tool turn and executes only the complete replacement', async () => {
  let round = 0;
  const executed: string[] = [];
  const f = await fixture(async (messages, tools) => {
    if (++round === 1) throw new ModelLengthError('尚未完成的前置说明', true);
    if (round === 2) {
      assert.ok(tools.some(tool => tool.function.name === 'get_capabilities'));
      assert.match(messages[0].content!, /未执行任何截断的工具调用/);
      return call('get_capabilities');
    }
    return answer('重新生成后完成。');
  }, async name => { executed.push(name); return { operation_id: 'fixture', status: 'success', data: {} }; });
  try {
    const created = await f.runtime.create('检查连接', connection.connection_id);
    const task = await terminal(f.runtime, created.id);
    assert.equal(task.answer, '重新生成后完成。');
    assert.deepEqual(executed, ['get_capabilities']);
    assert.ok(task.messages.every(message => !message.content?.includes('尚未完成的前置说明')));
  } finally { await f.cleanup(); }
});

test('DeepSeek context rejection is distinguished from other HTTP errors without keeping the response body', async () => {
  const model = deepSeekModel('SYNTHETIC', 'deepseek-flash', async () =>
    new Response(JSON.stringify({ error: { message: 'This model maximum context length is 1000000. PRIVATE_BODY' } }), { status: 400 }));
  await assert.rejects(model([{ role:'user', content:'分析' }], [], new AbortController().signal, () => {}),
    (error: AppError) => error.code === 'MODEL_CONTEXT_LIMIT' && !error.message.includes('PRIVATE_BODY'));
});

test('production model rejects incomplete streams, truncated output and private HTTP error bodies', async () => {
  await assert.rejects(readModelStream(new Response(frame({ choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: 'stop' }] })).body!, () => {}),
    { code: 'MODEL_INCOMPLETE_STREAM' });
  await assert.rejects(readModelStream(new Response(frame({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }) + 'data: [DONE]\n\n').body!, () => {}),
    { code: 'MODEL_OUTPUT_TRUNCATED' });
  const partialTool = frame({ choices: [{ index: 0, delta: { content:'前置说明', tool_calls: [
    { index:0, id:'partial', type:'function', function:{ name:'search_objects', arguments:'PRIVATE_PARTIAL_ARGUMENT' } }
  ] }, finish_reason:'length' }] }) + 'data: [DONE]\n\n';
  await assert.rejects(readModelStream(new Response(partialTool).body!, () => {}), error =>
    error instanceof ModelLengthError && error.partialToolCall && error.text === '前置说明' &&
    !JSON.stringify(error).includes('PRIVATE_PARTIAL_ARGUMENT'));
  for (const status of [401, 429, 500]) {
    const model = deepSeekModel('PRIVATE', 'deepseek-flash', async () => new Response('PRIVATE', { status }));
    await assert.rejects(model([], [], new AbortController().signal, () => {}), error => {
      assert.equal((error as Error).message.includes('PRIVATE'), false); return error instanceof AppError;
    });
  }
});

test('production stream assembles Chinese and fragmented tool calls before execution', async () => {
  const events = frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function',
    function: { name: 'get_', arguments: '{"connection_' } }] }, finish_reason: null }] }) +
    frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'capabilities',
      arguments: 'id":"中文"}' } }] }, finish_reason: null }] }) +
    frame({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n';
  const encoded = new TextEncoder().encode(events);
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    for (const byte of encoded) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } });
  const result = await readModelStream(body, () => {});
  assert.equal(result.message.tool_calls?.[0].function.name, 'get_capabilities');
  assert.deepEqual(JSON.parse(result.message.tool_calls![0].function.arguments), { connection_id: '中文' });
});

test('Agent API inherits authentication/origin checks, defaults to allowing model data and omits model history', async () => {
  const f = await fixture(async () => answer('接口任务完成'));
  const apiRequests: Message[][] = [];
  const host = await startAdmin(f.store, credentials, 0, undefined, undefined,
    { agent: { model: async messages => { apiRequests.push(structuredClone(messages)); return answer('接口任务完成'); }, execute: async () => ({}) } });
  const url = new URL(host.url), origin = url.origin;
  const headers = { 'X-Admin-Token': url.hash.slice(1), Origin: origin, 'Content-Type': 'application/json' };
  try {
    assert.equal((await fetch(`${origin}/api/agent/status`)).status, 401);
    assert.equal((await fetch(`${origin}/API/agent/status`)).status, 401);
    const input = { prompt: '解释程序', connection_id: connection.connection_id };
    assert.equal((await fetch(`${origin}/api/agent/tasks`, { method: 'POST', headers,
      body: JSON.stringify({ ...input, allow_model_data: false }) })).status, 400);
    assert.equal((await fetch(`${origin}/api/agent/tasks`, { method: 'POST', headers,
      body: JSON.stringify({ ...input, allow_table_data: true }) })).status, 400);
    assert.equal((await fetch(`${origin}/api/agent/tasks`, { method: 'POST', headers: { ...headers, Origin: 'https://evil.test' },
      body: JSON.stringify({ ...input, allow_model_data: true }) })).status, 403);
    assert.equal((await fetch(`${origin}/api/agent/tasks`, { method: 'POST', headers,
      body: JSON.stringify({ ...input, attachments: [{ name: 'binary', content: '\u0000' }] }) })).status, 400);
    await setTablePolicy(f.store,connection.connection_id,true);
    const fileLimit = 10 * 1024 * 1024;
    const escapedText = '"'.repeat(fileLimit);
    const created = await fetch(`${origin}/api/agent/tasks`, { method: 'POST', headers,
      body: JSON.stringify({...input,allow_table_data:false, attachments:[{name:'large.txt',content:'synthetic'+escapedText.slice(9)},
        ...Array.from({length:9},(_,i)=>({name:`notes-${i}`,content:i===0?escapedText:''}))]}) });
    assert.equal(created.status, 202);
    const task = await created.json();
    assert.equal(task.allow_table_data,false);
    assert.equal(Object.hasOwn(task, 'messages'), false);
    assert.equal(task.current_attachments[0].name, 'large.txt');
    assert.equal(task.current_attachments.length,10);
    const list = await (await fetch(`${origin}/api/agent/tasks`, { headers })).json();
    assert.ok(list.tasks.some((entry: { id: string }) => entry.id === task.id));
    assert.equal(Object.hasOwn(list.tasks[0], 'messages'), false);
    for (let i = 0; i < 100; i++) {
      const result = await (await fetch(`${origin}/api/agent/tasks/${task.id}`, { headers })).json();
      if (result.status === 'completed') {
        assert.equal(result.answer, '接口任务完成');
        const saved = await new TaskStore(f.directory).get(task.id);
        const tools = [...agentModelTools(saved.allow_table_data === true), artifactTool, changePreviewTool, operationProposalTool, workflowProposalTool,webSearchTool,...localWorkTools,memoryTool,...mcpManagementTools,skillDraftTool,
          ...(saved.output_mode === 'chat' ? [createReportTool, updateReportTool] : []),askUserTool];
        assert.equal(result.context_estimated_tokens, estimateTokens(workingMessages(saved), tools));
        assert.equal(result.context_tokens, saved.context_tokens);
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
      if (i === 99) assert.fail('API task did not finish');
    }
    const history = await (await fetch(`${origin}/api/agent/tasks/${task.id}/conversation`,{headers})).json();
    assert.deepEqual(history.messages.map(message=>message.role),['user','assistant']);
    assert.equal(history.messages[0].attachments[0].name,'large.txt');
    assert.ok(JSON.stringify(apiRequests[0]).includes('synthetic'));
    assert.equal((await fetch(`${origin}/api/agent/tasks/${task.id}/conversation`)).status,401);
    assert.equal((await fetch(`${origin}/api/agent/tasks/${task.id}/messages`,{method:'POST',headers,
      body:JSON.stringify({prompt:'追问',connection_id:randomUUID()})})).status,400);
    const followup = await fetch(`${origin}/api/agent/tasks/${task.id}/messages`,{method:'POST',headers,body:JSON.stringify({prompt:'继续解释',attachments:[{name:'follow.csv',content:'a,b'}]})});
    assert.equal(followup.status,202);
    const continued = await followup.json(); assert.equal(continued.id,task.id); assert.equal(continued.current_prompt,'继续解释');
    assert.equal(continued.current_attachments[0].name,'follow.csv');
    for (let i = 0; i < 100; i++) {
      const result = await (await fetch(`${origin}/api/agent/tasks/${task.id}`, { headers })).json();
      if (result.status === 'completed') {
        const saved = await new TaskStore(f.directory).get(task.id);
        assert.equal(saved.output_mode, 'chat');
        assert.equal(result.context_estimated_tokens, estimateTokens(workingMessages(saved),
          [...agentModelTools(saved.allow_table_data === true), artifactTool, changePreviewTool, operationProposalTool, workflowProposalTool, webSearchTool,...localWorkTools,memoryTool,...mcpManagementTools,skillDraftTool,createReportTool, updateReportTool,askUserTool]));
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
      if (i === 99) assert.fail('API follow-up did not finish');
    }
  } finally { await host.close(); await f.cleanup(); }
});

test('manual context compaction preserves conversation and records actual model usage', async () => {
  const f = await fixture(async messages => messages[0].content?.includes('工作记忆整理器')
    ? { ...answer('已整理工作摘要'), usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 } }
    : { ...answer('原始回答'), usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
  try {
    const created = await f.runtime.create('解释程序', connection.connection_id, 'chat');
    const completed = await terminal(f.runtime, created.id);
    assert.equal(completed.last_model_input_tokens, 100);
    const before = await f.runtime.tasks.conversation(created.id);
    const compacted = await f.runtime.compact(created.id);
    assert.equal(compacted.status, 'completed');
    assert.equal(compacted.compactions, 1);
    assert.equal(compacted.last_model_input_tokens, 100);
    assert.deepEqual(compacted.model_usage, { reported_requests: 2, prompt_tokens: 140, completion_tokens: 30, total_tokens: 170 });
    assert.deepEqual(await f.runtime.tasks.conversation(created.id), before);
    const persisted = await f.runtime.tasks.get(created.id);
    assert.equal(persisted.memory?.includes('已整理工作摘要'), true);
    assert.equal(persisted.last_model_input_tokens, 100);
  } finally { await f.cleanup(); }
});

test('manual compaction failure keeps the completed checkpoint and remains retryable', async () => {
  const f = await fixture(async messages => messages[0].content?.includes('工作记忆整理器')
    ? answer('') : answer('原始回答'));
  try {
    const created = await f.runtime.create('解释程序', connection.connection_id, 'chat');
    const before = await terminal(f.runtime, created.id);
    await assert.rejects(() => f.runtime.compact(created.id), (error: AppError) => error.code === 'AGENT_COMPACTION_FAILED');
    const after = await f.runtime.tasks.get(created.id);
    assert.equal(after.status, 'completed');
    assert.equal(after.answer, before.answer);
    assert.deepEqual(after.messages, before.messages);
    assert.equal(after.compactions ?? 0, 0);
    assert.equal(after.events.at(-1)?.type, 'context_compaction_failed');
  } finally { await f.cleanup(); }
});

test('manual compaction requires API confirmation and returns updated context', async () => {
  const model: Model = async messages => messages[0].content?.includes('工作记忆整理器')
    ? answer('工作摘要') : { ...answer('接口回答'), usage: { prompt_tokens: 80, total_tokens: 90 } };
  const f = await fixture(model);
  const host = await startAdmin(f.store, credentials, 0, undefined, undefined, { agent: { model } });
  const url = new URL(host.url);
  const headers = { 'X-Admin-Token': url.hash.slice(1), Origin: url.origin, 'Content-Type': 'application/json' };
  try {
    const created = await (await fetch(`${url.origin}/api/agent/tasks`, { method: 'POST', headers,
      body: JSON.stringify({ prompt: '解释程序', connection_id: connection.connection_id, output_mode: 'chat' }) })).json();
    let task;
    for (let i = 0; i < 100; i++) {
      task = await (await fetch(`${url.origin}/api/agent/tasks/${created.id}`, { headers })).json();
      if (task.status === 'completed') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(task.status, 'completed');
    assert.equal(task.last_model_input_tokens, 80);
    const path = `${url.origin}/api/agent/tasks/${created.id}/compact`;
    assert.equal((await fetch(path, { method: 'POST', headers, body: '{}' })).status, 400);
    assert.equal((await fetch(path, { method: 'POST', headers: { Origin: url.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }) })).status, 401);
    const response = await fetch(path, { method: 'POST', headers, body: JSON.stringify({ confirm: true }) });
    assert.equal(response.status, 200);
    const compacted = await response.json();
    assert.equal(compacted.status, 'completed');
    assert.equal(compacted.compactions, 1);
    assert.equal(compacted.last_model_input_tokens, 80);
    const saved = await new TaskStore(f.directory).get(created.id);
    assert.equal(compacted.context_estimated_tokens, estimateTokens(workingMessages(saved),
      [...agentModelTools(false), artifactTool, changePreviewTool, operationProposalTool, workflowProposalTool, webSearchTool,...localWorkTools,memoryTool,...mcpManagementTools,
        ...(saved.skill_authoring_enabled ? [skillDraftTool] : []),createReportTool, updateReportTool,askUserTool]));
  } finally { await host.close(); await f.cleanup(); }
});

test('stopping manual compaction retains the completed checkpoint', async () => {
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const f = await fixture(async (messages, _tools, signal) => {
    if (!messages[0].content?.includes('工作记忆整理器')) return answer('原始回答');
    started();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  });
  try {
    const created = await f.runtime.create('解释程序', connection.connection_id, 'chat');
    const before = await terminal(f.runtime, created.id);
    const compaction = f.runtime.compact(created.id);
    const failed = assert.rejects(compaction);
    await ready;
    const stopped = await f.runtime.stop(created.id);
    await failed;
    assert.equal(stopped.status, 'completed');
    assert.deepEqual(stopped.messages, before.messages);
    assert.equal(stopped.compactions ?? 0, 0);
  } finally { await f.cleanup(); }
});

test('authenticated SSE streams drafts before completion and management APIs require explicit delete confirmation',async()=>{
  let release!:()=>void,started!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<void>(resolve=>{started=resolve;});
  const f=await fixture(async()=>answer());
  const host=await startAdmin(f.store,credentials,0,undefined,undefined,{agent:{model:async(_m,_t,_s,onText)=>{
    onText('实时第一段');started();await gate;onText('和第二段');return answer('实时第一段和第二段');
  }}});
  const url=new URL(host.url),headers={'X-Admin-Token':url.hash.slice(1),Origin:url.origin,'Content-Type':'application/json'};
  let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  try{
    const created=await(await fetch(url.origin+'/api/agent/tasks',{method:'POST',headers,body:JSON.stringify({prompt:'流式测试',connection_id:connection.connection_id})})).json();
    await ready;
    assert.equal((await fetch(`${url.origin}/api/agent/tasks/${created.id}/stream`)).status,401);
    const response=await fetch(`${url.origin}/api/agent/tasks/${created.id}/stream`,{headers,signal:AbortSignal.timeout(10000)});
    assert.match(response.headers.get('content-type')!,/text\/event-stream/);reader=response.body!.getReader();
    const chunk=await reader.read();const frame=new TextDecoder().decode(chunk.value);
    assert.match(frame,/实时第一段/);assert.match(frame,/"finished":false/);
    const inProgress=await(await fetch(`${url.origin}/api/agent/tasks/${created.id}`,{headers})).json();assert.equal(inProgress.answer,undefined);
    release();await reader.cancel();reader=undefined;
    let done;
    for(let i=0;i<100;i++){
      done=await(await fetch(`${url.origin}/api/agent/tasks/${created.id}`,{headers})).json();if(done.status==='completed')break;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(done.answer,'实时第一段和第二段');
    const renamed=await(await fetch(`${url.origin}/api/agent/tasks/${created.id}`,{method:'PATCH',headers,body:JSON.stringify({title:'新名称',pinned:true})})).json();
    assert.equal(renamed.title,'新名称');assert.equal(renamed.pinned,true);
    const exported=await fetch(`${url.origin}/api/agent/tasks/${created.id}/export`,{headers});assert.match(await exported.text(),/新名称/);
    assert.equal((await fetch(`${url.origin}/api/agent/tasks/${created.id}`,{method:'DELETE',headers,body:JSON.stringify({updated_at:renamed.updated_at})})).status,400);
    const removed=await fetch(`${url.origin}/api/agent/tasks/${created.id}`,{method:'DELETE',headers,body:JSON.stringify({confirm:true,updated_at:renamed.updated_at})});
    assert.equal(removed.status,200);
  }finally{release();await reader?.cancel();await host.close();await f.cleanup();}
});
