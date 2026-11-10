import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConfigStore } from '../src/config.js';
import { AgentRuntime } from '../src/agent/runtime.js';
import { TaskStore } from '../src/agent/task-store.js';
import { deepSeekModel, readModelStream } from '../src/agent/model/model.js';
import { estimateTokens } from '../src/agent/model/token-estimate.js';

const frame = (delta: unknown, finish_reason: string | null = null) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
const end = (reason = 'stop') => frame({}, reason) + 'data: [DONE]\n\n';
const text = '报告内容。'.repeat(80000);

test('both DeepSeek models request the official maximum and accept large complete streams', async () => {
  for (const name of ['deepseek-flash', 'deepseek-v4-pro']) {
    const model = deepSeekModel('SYNTHETIC', name, async (_url, options) => {
      assert.equal(JSON.parse(options!.body as string).max_tokens, 393216);
      return new Response(': ' + ' '.repeat(9 * 1024 * 1024) + '\n\n' + frame({ content: text }) + end(),
        { headers: { 'Content-Type': 'text/event-stream' } });
    });
    let visible = '';
    const result = await model([], [], new AbortController().signal, chunk => { visible += chunk; });
    assert.equal(result.message.content, text);
    assert.equal(visible, text);
  }
});

test('maximum output adapts to remaining context when input is large', async () => {
  const messages = [{ role: 'user' as const, content: 'x'.repeat(2400000) }];
  let dispatched = 0;
  const model = deepSeekModel('SYNTHETIC', 'deepseek-flash', async (_url, options) => {
    dispatched++;
    const max = JSON.parse(options!.body as string).max_tokens;
    assert.equal(max, 1000000 - estimateTokens(messages));
    assert.ok(max > 0 && max < 393216);
    return new Response(frame({ content: '完整回答' }) + end(), { headers: { 'Content-Type': 'text/event-stream' } });
  });
  await model(messages, [], new AbortController().signal, () => {});
  await assert.rejects(model([{ role: 'user', content: 'x'.repeat(3000000) }], [], new AbortController().signal, () => {}),
    { code: 'MODEL_CONTEXT_LIMIT' });
  assert.equal(dispatched, 1);
});

test('large answers and report tool arguments survive runtime storage and reload without truncation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sap-output-'));
  const store = new ConfigStore(directory), connectionId = randomUUID();
  await store.save({ ...(await store.load()), connections: [{ connection_id: connectionId, name: 'FIXTURE',
    base_url: 'https://sap.test', client: '100', username: 'TEST', language: 'EN', write_enabled: false }] });
  let report = false, round = 0;
  const model = deepSeekModel('SYNTHETIC', 'deepseek-flash', async () => {
    const body = report && round++ === 0 ? frame({ tool_calls: [{ index: 0, id: 'large-report', type: 'function',
      function: { name: 'create_report', arguments: JSON.stringify({ title: '完整报告', content: text }) } }] }) + end('tool_calls')
      : frame({ content: report ? '报告已保存' : text }) + end();
    return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
  });
  const runtime = new AgentRuntime(store, { model, execute: async () => { throw new Error('Must not access SAP'); } });
  async function complete(id: string) {
    for (let i = 0; i < 300; i++) {
      const task = await runtime.tasks.get(id);
      if (task.status === 'completed' || task.status === 'failed') {
        assert.equal(task.status, 'completed', JSON.stringify(task.error));
        return task;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Task did not complete');
  }
  try {
    await runtime.initialize();
    const first = await complete((await runtime.create('输出完整回答', connectionId)).id);
    assert.equal(first.answer, text);
    assert.equal((await new TaskStore(directory).get(first.id)).answer, text);
    assert.ok((await stat(join(directory, 'agent/tasks', first.id + '.json'))).size > 2 * 1024 * 1024);
    assert.equal((await runtime.tasks.report(first.id)).report?.content, text);
    report = true;
    const second = await complete((await runtime.create('生成完整报告', connectionId, 'chat')).id);
    assert.equal((await runtime.tasks.report(second.id)).report?.content, text);
    const toolMessage = second.messages.find(message => message.tool_calls?.some(call => call.function.name === 'create_report'));
    assert.equal(JSON.parse(toolMessage!.tool_calls![0].function.arguments).content, text);
    assert.equal((await new TaskStore(directory).report(second.id)).report?.content, text);
  } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});

test('continuous streaming can exceed two minutes, but idle streams still time out and can be stopped', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let peerSignal: AbortSignal, controller: ReadableStreamDefaultController<Uint8Array>;
  const model = deepSeekModel('SYNTHETIC', 'deepseek-flash', async (_url, options) => {
    peerSignal = options!.signal!;
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    peerSignal.addEventListener('abort', () => controller.error(new Error('request aborted')), { once: true });
    return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
  });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const pending = model([], [], new AbortController().signal, () => {});
  await flush();
  for (let i = 0; i < 4; i++) {
    t.mock.timers.tick(60000);
    assert.equal(peerSignal!.aborted, false);
    controller!.enqueue(new TextEncoder().encode(frame({ content: '继续' })));
    await flush();
  }
  controller!.enqueue(new TextEncoder().encode(end())); controller!.close();
  assert.equal((await pending).message.content, '继续'.repeat(4));

  const idle = assert.rejects(model([], [], new AbortController().signal, () => {}), { code: 'MODEL_TIMEOUT' });
  await flush(); t.mock.timers.tick(120001); await idle;
  const stop = new AbortController();
  const stopped = assert.rejects(model([], [], stop.signal, () => {}), { code: 'AGENT_STOPPED' });
  await flush(); stop.abort(); await stopped;
});

test('large incomplete tool output is still rejected before dispatch', async () => {
  const body = frame({ tool_calls: [{ index: 0, id: 'unfinished', type: 'function',
    function: { name: 'create_report', arguments: JSON.stringify({ content: text }) } }] }) + end('length');
  await assert.rejects(readModelStream(new Response(body).body!, () => {}), { code: 'MODEL_OUTPUT_TRUNCATED' });
});
