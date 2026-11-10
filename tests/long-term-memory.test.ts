import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LongTermMemory, recalledMemoriesSchema, type MemoryRecord } from '../src/agent/long-term-memory.js';
import { estimateTokens } from '../src/agent/model/token-estimate.js';

const first = 'a'.repeat(64);
const second = 'b'.repeat(64);

function lesson(topic: string, note: string): MemoryRecord {
  return { kind: 'lesson', topic, note, task_id: randomUUID(), created_at: '2026-10-01T00:00:00.000Z',
    evidence_artifact: 'c'.repeat(64) };
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'saplink-memory-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return { directory, memory: new LongTermMemory(directory) };
}

test('long-term memory selects more than five relevant items when they fit and stays within the model budget', async t => {
  const { memory } = await fixture(t);
  const relevant = Array.from({ length: 12 }, (_, index) =>
    lesson('库存过账步骤 ' + index, '核对库存过账的物料凭证。'));
  const unrelated = lesson('运费科目', '检查运费科目的分配。');
  await memory.save(first, [...relevant, unrelated]);
  await memory.save(second, [lesson('库存过账', '这是另一个 SAP 连接的排查结论。')]);

  const recalled = await memory.recall(first, randomUUID(), '怎么排查库存过账？');
  assert.equal(recalled.length, relevant.length);
  assert.ok(recalled.every(entry => entry.scope === 'connection' && entry.topic.startsWith('库存过账步骤')));
  assert.equal(recalledMemoriesSchema.parse(recalled).length, relevant.length);

  const longNotes = Array.from({ length: 25 }, (_, index) =>
    lesson('报工取消步骤 ' + index, '报工取消时先检查凭证，再核对工单状态。'.repeat(18)));
  await memory.save(first, longNotes);
  const constrained = await memory.recall(first, randomUUID(), '检查报工取消');
  assert.ok(constrained.length > 0 && constrained.length < longNotes.length);
  assert.ok(constrained.reduce((cost, entry) =>
    cost + estimateTokens([{ role: 'user', content: JSON.stringify(entry) }]), 0) <= 1800);
});

test('memory upserts persist, discard outdated index terms and isolate local overrides of profile preferences', async t => {
  const { directory, memory } = await fixture(t);
  const initial = lesson('ZPO_01', '采购收货校验使用旧步骤。');
  const updated = { ...lesson('zpo_01', '更新为核对交货完成标识。'), created_at: '2026-10-02T00:00:00.000Z' };
  const profile: MemoryRecord = { ...lesson('报告格式', '先给结论'), kind: 'preference', scope: 'profile' };
  const local: MemoryRecord = { ...lesson('报告格式', '此连接先列证据'), kind: 'preference' };
  await Promise.all([memory.save(first, [initial, profile]), new LongTermMemory(directory).save(second, [local])]);
  await memory.save(first, [updated, initial]);
  const reopened = new LongTermMemory(directory);

  assert.deepEqual((await reopened.recall(first, randomUUID(), '找一下 ZPO_01')).map(entry => entry.note),
    [profile.note, updated.note]);
  assert.deepEqual((await reopened.recall(first, randomUUID(), '采购收货校验')).map(entry => entry.note), [profile.note]);
  assert.deepEqual((await reopened.recall(second, randomUUID(), '报告格式')).map(entry => entry.note), [local.note]);
  assert.deepEqual((await reopened.recall(first, profile.task_id, '报告格式')).map(entry => entry.note), [profile.note]);
  await assert.rejects(memory.save(first, [{ ...initial, scope: 'profile' }]), /Only preferences/);
});
