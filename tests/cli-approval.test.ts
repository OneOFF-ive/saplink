import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ApprovalService } from '../src/approval-service.js';
import { ConfigStore } from '../src/config.js';
import { targetFingerprint } from '../src/connection-identity.js';
import { WriteApprovalStore } from '../src/write-approval.js';

const noRead = async () => { throw new Error('Unexpected baseline read'); };
const execute = promisify(execFile);

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'sap-cli-approval-'));
  const store = new ConfigStore(directory);
  const connection = { connection_id: randomUUID(), name: 'dev', base_url: 'https://sap.test',
    client: '001', username: 'TEST', language: 'EN', write_enabled: true, write_governance: 'approval_required' as const };
  await store.save({ schema_version: 1, connections: [connection], tokens: [] });
  return { directory, store, connection, close: () => rm(directory, { recursive: true, force: true }) };
}

test('Client review and approval bind every supported operation and share the existing approval store', async () => {
  const f = await fixture();
  try {
    const service = new ApprovalService(f.store, noRead), connection_id = f.connection.connection_id;
    const uri = '/sap/bc/adt/programs/programs/ztest';
    const actions = [
      ['create_program', { name: 'ZTEST', description: 'test', package_name: '$TMP' }],
      ['create_function_group', { name: 'ZGROUP', description: 'test', package_name: '$TMP' }],
      ['create_function_module', { name: 'ZFUNC', description: 'test', function_group_uri: '/sap/bc/adt/functions/groups/zgroup' }],
      ['create_transport_request', { object_uri: uri, package_name: 'ZDEV', description: 'test' }],
      ['activate_objects', { objects: [{ object_uri: uri, expected_revision: 'c'.repeat(64) }] }],
      ['run_atc', { object_uri: uri, check_variant: 'DEFAULT', confirm_execution: true }],
      ['run_unit_tests', { object_uri: uri, confirm_execution: true }]
    ] as const;
    for (const [tool, fields] of actions) {
      const input = { ...fields, connection_id, request_id: randomUUID() };
      const review = await service.review(tool, input);
      assert.equal(review.intent.tool, tool);
      await assert.rejects(service.approve(tool, { ...input, request_id: randomUUID() }, review.review_id),
        { code: 'APPROVAL_REVIEW_CHANGED' });
      const approval = await service.approve(tool, input, review.review_id);
      assert.equal((await service.status(approval.approval_id)).state, 'pending');
      await assert.rejects(service.approve(tool, input, review.review_id), { code: 'APPROVAL_EXISTS' });
      const record = await new WriteApprovalStore(f.directory).get(approval.approval_id);
      assert.equal(record.artifact_id, review.review_id);
      assert.equal(record.target_fingerprint, targetFingerprint(f.connection));
      assert.equal(record.operation, tool);
      assert.equal(approval.input.approval_id, approval.approval_id);
      await service.revoke(approval.approval_id);
      assert.equal((await service.status(approval.approval_id)).state, 'revoked');
    }
    assert.equal((await service.list()).length, actions.length);
    await assert.rejects(service.review('read_source', {}), { code: 'APPROVAL_INVALID' });
  } finally { await f.close(); }
});

test('source review verifies baseline and full diff again before issuing an approval', async () => {
  const f = await fixture();
  try {
    const object_uri = '/sap/bc/adt/programs/programs/ztest', source_uri = object_uri + '/source/main';
    let revision = 'a'.repeat(64), source = 'REPORT ztest.\nWRITE private_original.\n';
    const service = new ApprovalService(f.store, async input => ({
      operation_id: randomUUID(), status: 'success', completed_steps: [],
      data: { object_uri, source_uri, version: input.version, revision, source }
    }));
    const input = { connection_id: f.connection.connection_id, object_uri, source_uri, version: 'active' as const,
      expected_revision: revision, edits: [{ old_text: 'private_original', new_text: 'private_change' }], request_id: randomUUID() };
    const review = await service.review('update_source', input);
    assert.ok(review.diff?.hunks.flatMap(h => h.lines).some(line => line.text.includes('private_change')));
    revision = 'b'.repeat(64);
    await assert.rejects(service.approve('update_source', input, review.review_id), { code: 'APPROVAL_BASELINE_CHANGED' });
    revision = input.expected_revision;
    source = 'REPORT ztest.\nWRITE private_original.\nWRITE extra.\n';
    await assert.rejects(service.approve('update_source', input, review.review_id), { code: 'APPROVAL_REVIEW_CHANGED' });
    source = 'REPORT ztest.\nWRITE private_original.\n';
    const approval = await service.approve('update_source', input, review.review_id);
    const content = await readFile(join(f.directory, 'write-approvals', `${approval.approval_id}.json`), 'utf8');
    assert.doesNotMatch(content, /private_original|private_change/);
    const store = new WriteApprovalStore(f.directory);
    await store.consume(approval.approval_id, input, targetFingerprint(f.connection), review.review_id);
    await assert.rejects(service.approve('update_source', { ...input, request_id: randomUUID() },
      (await service.review('update_source', { ...input, request_id: 'new-request' })).review_id),
    { code: 'APPROVAL_REVIEW_CHANGED' });
    const next = { ...input, request_id: randomUUID() }, nextReview = await service.review('update_source', next);
    await assert.rejects(service.approve('update_source', next, nextReview.review_id), { code: 'APPROVAL_RECONCILIATION_REQUIRED' });
    assert.equal((await service.resolve(approval.approval_id)).verification, 'user_attested');
    await service.approve('update_source', next, nextReview.review_id);
    await assert.rejects(service.review('update_source', { ...input, source_uri: undefined }), { code: 'APPROVAL_INVALID' });
  } finally { await f.close(); }
});

test('parallel approvals cannot create two pending approvals for the same review', async () => {
  const f = await fixture();
  try {
    const service = new ApprovalService(f.store, noRead);
    const input = { connection_id: f.connection.connection_id, name: 'ZTEST', description: 'test',
      package_name: '$TMP', request_id: randomUUID() };
    const review = await service.review('create_program', input);
    const results = await Promise.allSettled([
      service.approve('create_program', input, review.review_id),
      service.approve('create_program', input, review.review_id)
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal((await service.list()).filter(item => item.state === 'pending').length, 1);
  } finally { await f.close(); }
});

test('approval rejects changed connection identity or disabled policy', async () => {
  const f = await fixture();
  try {
    const service = new ApprovalService(f.store, noRead);
    const input = { connection_id: f.connection.connection_id, name: 'ZTEST', description: 'test',
      package_name: '$TMP', request_id: randomUUID() };
    const review = await service.review('create_program', input);
    await f.store.save({ schema_version: 1, connections: [{ ...f.connection, username: 'OTHER' }], tokens: [] });
    await assert.rejects(service.approve('create_program', input, review.review_id), { code: 'APPROVAL_REVIEW_CHANGED' });
    await f.store.save({ schema_version: 1, connections: [{ ...f.connection, write_enabled: false }], tokens: [] });
    await assert.rejects(service.approve('create_program', input, review.review_id), { code: 'APPROVAL_POLICY_CHANGED' });
  } finally { await f.close(); }
});

test('CLI no longer exposes approval or reviewed workflow commands', async () => {
  const f = await fixture();
  try {
    const env = { ...process.env, SAPLINK_CONFIG_DIR: f.directory, SAPLINK_AUTO_UPDATE_CHECK: '0' };
    for (const command of ['approval', 'workflow']) await assert.rejects(
      execute(process.execPath, [resolve('dist/cli.js'), command, 'review', '--json'], { env }),
      error => { assert.equal(JSON.parse((error as Error & { stdout:string }).stdout).error.code, 'INVALID_ARGUMENTS'); return true; });
  } finally { await f.close(); }
});
