import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { workflowProgress } from '../src/workflow-progress.js';
import { workflowPlanSchema } from '../src/workflow-review.js';

const plan = workflowPlanSchema.parse({ connection_id: randomUUID(), plan_id: randomUUID(), action: 'create_program',
  name: 'ZTEST', description: 'test', package_name: '$TMP', source: 'REPORT ztest.', activate: true });
test('planned phases contain only selected steps and distinguish repeated source checks', () => {
  const progress = workflowProgress(plan);
  assert.deepEqual(progress.phases.map(phase => phase.id),
    ['create_program', 'baseline', 'update_source', 'before_check', 'syntax_check', 'after_check', 'activate_objects']);
  assert.ok(progress.phases.every(phase => phase.status === 'pending'));
  assert.equal(workflowProgress({ ...plan, syntax_check: false, activate: false }).total, 3);
});
test('failed semantic checks override a successful HTTP result without marking later steps complete', () => {
  const progress = workflowProgress(plan, { state: 'stopped', running: false, events: [
    { state: 'step_finished', step: 'update_source', phase: 'update_source', status: 'success', outcome: 'confirmed' },
    { state: 'step_started', step: 'syntax_check', phase: 'syntax_check' },
    { state: 'step_finished', step: 'syntax_check', phase: 'syntax_check', status: 'success', data: { passed: false } },
    { state: 'stopped', phase: 'syntax_check', error: { code: 'WORKFLOW_SYNTAX_FAILED', message: '未通过' } }
  ] });
  assert.equal(progress.phases.find(phase => phase.id === 'update_source')!.status, 'completed');
  assert.equal(progress.phases.find(phase => phase.id === 'syntax_check')!.status, 'failed');
  assert.equal(progress.phases.find(phase => phase.id === 'activate_objects')!.status, 'skipped');
  assert.equal(progress.completed, 1);
});
test('legacy journals and interrupted writes display uncertainty instead of claiming success', () => {
  const progress = workflowProgress(plan, { state: 'unknown', running: false, events: [
    { state: 'step_started', step: 'read_source' },
    { state: 'step_finished', step: 'read_source', status: 'success' },
    { state: 'step_approved', step: 'update_source', approval_id: randomUUID() },
    { state: 'step_started', step: 'update_source' }
  ] });
  assert.equal(progress.phases.find(phase => phase.id === 'baseline')!.status, 'completed');
  assert.equal(progress.phases.find(phase => phase.id === 'update_source')!.status, 'unknown');
  assert.equal(progress.phases.find(phase => phase.id === 'syntax_check')!.status, 'skipped');
});
