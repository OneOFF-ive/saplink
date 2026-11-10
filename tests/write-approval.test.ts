import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WriteApprovalStore, type ControlledOperationIntent, type SourceWriteIntent } from '../src/write-approval.js';

const target = 'a'.repeat(64), artifact = 'b'.repeat(64), revision = 'c'.repeat(64);
const intent = (): SourceWriteIntent => ({
  connection_id: randomUUID(), object_uri: '/sap/bc/adt/programs/programs/ztest',
  source_uri: '/sap/bc/adt/programs/programs/ztest/source/main', version: 'active',
  expected_revision: revision, edits: [{ old_text: 'private original', new_text: 'private change' }],
  request_id: randomUUID(), transport_task: 'DEVK900001'
});
const future = () => new Date(Date.now() + 60000);

test('source approvals bind the complete intent and contain no source', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sap-approval-'));
  try {
    const store = new WriteApprovalStore(dir), input = intent();
    const approval = await store.create(input, target, artifact, future());
    const contents = await readFile(join(dir, 'write-approvals', `${approval.id}.json`), 'utf8');
    assert.doesNotMatch(contents, /private original|private change/);
    for (const altered of [
      { ...input, request_id: randomUUID() }, { ...input, connection_id: randomUUID() },
      { ...input, expected_revision: 'd'.repeat(64) }, { ...input, transport_task: 'DEVK900002' },
      { ...input, edits: [{ old_text: 'private original', new_text: 'different' }] }
    ]) await assert.rejects(store.consume(approval.id, altered, target, artifact), { code: 'APPROVAL_MISMATCH' });
    await assert.rejects(store.consume(approval.id, input, 'd'.repeat(64), artifact), { code: 'APPROVAL_MISMATCH' });
    await assert.rejects(store.consume(approval.id, input, target, 'd'.repeat(64)), { code: 'APPROVAL_MISMATCH' });
    const reordered = { ...input, connection_id: input.connection_id };
    assert.equal((await store.consume(approval.id, reordered, target, artifact)).id, approval.id);
    await assert.rejects(new WriteApprovalStore(dir).consume(approval.id, input, target, artifact), { code: 'APPROVAL_USED' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('concurrent consumption and revocation allow only one final state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sap-approval-'));
  try {
    const first = new WriteApprovalStore(dir), second = new WriteApprovalStore(dir), input = intent();
    const approval = await first.create(input, target, artifact, future());
    const results = await Promise.allSettled([
      first.consume(approval.id, input, target, artifact),
      second.consume(approval.id, input, target, artifact),
      second.revoke(approval.id)
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    for (const result of results) if (result.status === 'rejected') assert.equal(result.reason.code, 'APPROVAL_USED');
    await assert.rejects(first.consume(approval.id, input, target, artifact), { code: 'APPROVAL_USED' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('invalid, expired and revoked approvals never authorize a write', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sap-approval-'));
  try {
    let time = Date.now();
    const store = new WriteApprovalStore(dir, () => time), input = intent();
    await assert.rejects(store.get('../other'), { code: 'APPROVAL_INVALID' });
    await assert.rejects(store.create(input, target, artifact, new Date(0)), { code: 'APPROVAL_INVALID' });
    const expired = await store.create(input, target, artifact, new Date(time + 100));
    time += 100;
    await assert.rejects(store.consume(expired.id, input, target, artifact), { code: 'APPROVAL_EXPIRED' });
    const revoked = await store.create(input, target, artifact, future());
    await store.revoke(revoked.id);
    await assert.rejects(store.consume(revoked.id, input, target, artifact), { code: 'APPROVAL_USED' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a consumed approval with no persisted result is treated as unknown until reconciled', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sap-approval-'));
  try {
    const store = new WriteApprovalStore(dir), input = intent();
    const approval = await store.create(input, target, artifact, future());
    await store.consume(approval.id, input, target, artifact);
    assert.equal((await store.status(approval.id)).state, 'unknown');
    await assert.rejects(store.requireResolved(input), { code: 'APPROVAL_RECONCILIATION_REQUIRED' });
    for (const name of ['ZTEST', '%7atest']) {
      await assert.rejects(store.requireResolved({ ...input, object_uri: `/sap/bc/adt/programs/programs/${name}`,
        source_uri: `/sap/bc/adt/programs/programs/${name}/source/main` }), { code: 'APPROVAL_RECONCILIATION_REQUIRED' });
    }
    await store.resolve(approval.id, new Date().toISOString());
    await store.requireResolved(input);
    await assert.rejects(store.consume(approval.id, input, target, artifact), { code: 'APPROVAL_USED' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('controlled operations bind action, complete parameters, connection and target', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sap-approval-'));
  try {
    const store = new WriteApprovalStore(dir), connection_id = randomUUID();
    const actions: ControlledOperationIntent[] = [
      { tool: 'create_program', input: { connection_id, name: 'ZTEST', description: 'test', package_name: '$TMP', request_id: randomUUID() } },
      { tool: 'create_function_group', input: { connection_id, name: 'ZGROUP', description: 'test', package_name: '$TMP', request_id: randomUUID() } },
      { tool: 'create_function_module', input: { connection_id, name: 'ZFUNC', description: 'test', function_group_uri: '/sap/bc/adt/functions/groups/zgroup', request_id: randomUUID() } },
      { tool: 'activate_objects', input: { connection_id, objects: [{ object_uri: '/sap/bc/adt/programs/programs/ztest', expected_revision: revision }], request_id: randomUUID() } },
      { tool: 'run_atc', input: { connection_id, object_uri: '/sap/bc/adt/oo/classes/ztest', check_variant: 'DEFAULT', confirm_execution: true, request_id: randomUUID() } },
      { tool: 'run_unit_tests', input: { connection_id, object_uri: '/sap/bc/adt/oo/classes/ztest', confirm_execution: true, request_id: randomUUID() } },
      { tool: 'create_transport_request', input: { connection_id, object_uri: '/sap/bc/adt/programs/programs/ztest',
        package_name: 'ZDEV', description: 'test', request_id: randomUUID() } }
    ];
    for (const action of actions) {
      const approval = await store.createOperation(action, target, artifact, future());
      const contents = await readFile(join(dir, 'write-approvals', `${approval.id}.json`), 'utf8');
      assert.doesNotMatch(contents, /ZTEST|ZGROUP|ZFUNC|DEFAULT|\$TMP/);
      const changed = { ...action, input: { ...action.input, request_id: randomUUID() } } as ControlledOperationIntent;
      await assert.rejects(store.consumeOperation(approval.id, changed, target, artifact), { code: 'APPROVAL_MISMATCH' });
      await assert.rejects(store.consumeOperation(approval.id, action, 'd'.repeat(64), artifact), { code: 'APPROVAL_MISMATCH' });
      await assert.rejects(store.consumeOperation(approval.id, action, target, 'd'.repeat(64)), { code: 'APPROVAL_MISMATCH' });
      const other = actions.find(item => item.tool !== action.tool)!;
      await assert.rejects(store.consumeOperation(approval.id, other, target, artifact), { code: 'APPROVAL_MISMATCH' });
      const result = await Promise.allSettled([
        store.consumeOperation(approval.id, action, target, artifact),
        new WriteApprovalStore(dir).consumeOperation(approval.id, action, target, artifact)
      ]);
      assert.equal(result.filter(item => item.status === 'fulfilled').length, 1);
      assert.equal(result.filter(item => item.status === 'rejected').length, 1);
    }
    const variants: ControlledOperationIntent[] = [
      { ...actions[0], input: { ...actions[0].input, package_name: 'ZOTHER' } } as ControlledOperationIntent,
      { ...actions[1], input: { ...actions[1].input, description: 'different' } } as ControlledOperationIntent,
      { ...actions[2], input: { ...actions[2].input, function_group_uri: '/sap/bc/adt/functions/groups/zother' } } as ControlledOperationIntent,
      { ...actions[3], input: { ...actions[3].input, objects: [{ object_uri: '/sap/bc/adt/programs/programs/ztest', expected_revision: 'd'.repeat(64) }] } } as ControlledOperationIntent,
      { ...actions[4], input: { ...actions[4].input, check_variant: 'OTHER' } } as ControlledOperationIntent,
      { ...actions[5], input: { ...actions[5].input, max_duration: 'long' } } as ControlledOperationIntent,
      { ...actions[6], input: { ...actions[6].input, package_name: 'ZOTHER' } } as ControlledOperationIntent
    ];
    for (let i = 0; i < actions.length; i++) {
      const approval = await store.createOperation(actions[i], target, artifact, future());
      await assert.rejects(store.consumeOperation(approval.id, variants[i], target, artifact), { code: 'APPROVAL_MISMATCH' });
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('completed results block only when execution is uncertain or partially completed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sap-approval-'));
  try {
    const store = new WriteApprovalStore(dir), connection_id = randomUUID();
    const make = (): ControlledOperationIntent => ({ tool: 'run_atc', input: { connection_id,
      object_uri: '/sap/bc/adt/oo/classes/ztest', check_variant: 'DEFAULT', request_id: randomUUID(), confirm_execution: true } });
    const beforeDispatch = make();
    const first = await store.createOperation(beforeDispatch, target, artifact, future());
    await store.consumeOperation(first.id, beforeDispatch, target, artifact);
    await store.complete(first.id, { operation_id: randomUUID(), status: 'error', completed_steps: [],
      outcome: 'confirmed', write_dispatched: false });
    await store.requireOperationResolved(make());
    const partial = make();
    const second = await store.createOperation(partial, target, artifact, future());
    await store.consumeOperation(second.id, partial, target, artifact);
    await store.complete(second.id, { operation_id: randomUUID(), status: 'error', completed_steps: [],
      outcome: 'partial', write_dispatched: true });
    await assert.rejects(store.requireOperationResolved(make()), { code: 'APPROVAL_RECONCILIATION_REQUIRED' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('uncertain multi-object operations block overlapping source and operation targets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sap-approval-'));
  try {
    const store = new WriteApprovalStore(dir), connection_id = randomUUID();
    const activation: ControlledOperationIntent = { tool: 'activate_objects', input: { connection_id, request_id: randomUUID(), objects: [
      { object_uri: '/sap/bc/adt/programs/programs/ztest', expected_revision: revision },
      { object_uri: '/sap/bc/adt/functions/groups/zgroup', expected_revision: revision }
    ] } };
    const approval = await store.createOperation(activation, target, artifact, future());
    await store.consumeOperation(approval.id, activation, target, artifact);
    const source = { ...intent(), connection_id };
    await assert.rejects(store.requireResolved(source), { code: 'APPROVAL_RECONCILIATION_REQUIRED' });
    await assert.rejects(store.requireResolved({ ...source,
      object_uri: '/sap/bc/adt/programs/programs/ztest%2fsource%2fmain', source_uri: undefined }),
    { code: 'APPROVAL_RECONCILIATION_REQUIRED' });
    await assert.rejects(store.requireResolved({ ...source, object_uri: '/sap/bc/adt/functions/groups/zgroup/fmodules/zfunc',
      source_uri: '/sap/bc/adt/functions/groups/zgroup/fmodules/zfunc/source/main' }), { code: 'APPROVAL_RECONCILIATION_REQUIRED' });
    await assert.rejects(store.requireResolved({ ...source, object_uri: '/sap/bc/adt/functions/groups/zgroup%2ffmodules%2fzfunc',
      source_uri: undefined }), { code: 'APPROVAL_RECONCILIATION_REQUIRED' });
    const check: ControlledOperationIntent = { tool: 'run_atc', input: { connection_id, object_uri: '/sap/bc/adt/functions/groups/zgroup/fmodules/zfunc',
      check_variant: 'DEFAULT', request_id: randomUUID(), confirm_execution: true } };
    await assert.rejects(store.requireOperationResolved(check), { code: 'APPROVAL_RECONCILIATION_REQUIRED' });
    await store.resolve(approval.id, new Date().toISOString());
    await store.requireResolved(source);
    await store.requireOperationResolved(check);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('controlled operation approvals expire, can be revoked, and ignore transport timeout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sap-approval-'));
  try {
    let time = Date.now();
    const store = new WriteApprovalStore(dir, () => time);
    const action: ControlledOperationIntent = { tool: 'run_unit_tests', input: { connection_id: randomUUID(),
      object_uri: '/sap/bc/adt/oo/classes/ztest', request_id: randomUUID(), confirm_execution: true } };
    const expired = await store.createOperation(action, target, artifact, new Date(time + 100));
    time += 100;
    await assert.rejects(store.consumeOperation(expired.id, action, target, artifact), { code: 'APPROVAL_EXPIRED' });
    const revoked = await store.createOperation(action, target, artifact, new Date(time + 1000));
    await store.revoke(revoked.id);
    await assert.rejects(store.consumeOperation(revoked.id, action, target, artifact), { code: 'APPROVAL_USED' });
    const approved = await store.createOperation(action, target, artifact, new Date(time + 1000));
    await store.consumeOperation(approved.id, { ...action, input: { ...action.input, timeout_ms: 5000 } }, target, artifact);
    assert.equal((await store.status(approved.id)).state, 'unknown');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('legacy uncertain source approvals conservatively block new controlled operations on the connection', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sap-approval-'));
  try {
    const store = new WriteApprovalStore(dir), source = intent();
    const approval = await store.create(source, target, artifact, future());
    await store.consume(approval.id, source, target, artifact);
    const action: ControlledOperationIntent = { tool: 'create_program', input: { connection_id: source.connection_id,
      name: 'ZOTHER', description: 'test', package_name: '$TMP', request_id: randomUUID() } };
    await assert.rejects(store.requireOperationResolved(action), { code: 'APPROVAL_RECONCILIATION_REQUIRED' });
    await store.requireOperationResolved({ ...action, input: { ...action.input, connection_id: randomUUID() } });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
