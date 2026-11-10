import type { WorkflowPlan } from './workflow-review.js';

export type WorkflowEvent = { state: string; step?: string; phase?: string; time?: string; [key: string]: unknown };
export function workflowPhases(plan: WorkflowPlan) {
  return [
    ...(plan.action === 'create_program' ? [{ id: 'create_program', tool: 'create_program', label: '创建程序' }] : []),
    { id: 'baseline', tool: 'read_source', label: '核对源码基线' },
    { id: 'update_source', tool: 'update_source', label: '保存非活动源码' },
    ...(plan.syntax_check ? [
      { id: 'before_check', tool: 'read_source', label: '核对检查版本' },
      { id: 'syntax_check', tool: 'syntax_check', label: '语法检查' },
      { id: 'after_check', tool: 'read_source', label: '确认检查期间源码未变' }
    ] : []),
    ...(plan.activate ? [{ id: 'activate_objects', tool: 'activate_objects', label: '激活程序' }] : []),
    ...(plan.atc_variant ? [
      { id: 'before_atc', tool: 'read_source', label: '核对活动源码' },
      { id: 'run_atc', tool: 'run_atc', label: '提交 ATC 检查' }
    ] : [])
  ];
}

export function workflowProgress(plan: WorkflowPlan, execution?: {
  state: string; running?: boolean; events: WorkflowEvent[];
} | null) {
  type State = 'pending' | 'running' | 'completed' | 'failed' | 'unknown' | 'skipped';
  const phases = workflowPhases(plan).map(phase => ({ ...phase, status: 'pending' as State,
    started_at: undefined as string | undefined, finished_at: undefined as string | undefined,
    approval_id: undefined as string | undefined, result: undefined as WorkflowEvent | undefined }));
  let current: typeof phases[number] | undefined, readIndex = 0;
  const readPhases = phases.filter(phase => phase.tool === 'read_source');
  let failure: WorkflowEvent | undefined;
  for (const event of execution?.events ?? []) {
    if (event.state === 'stopped') {
      failure = event;
      const failed = phases.find(phase => phase.id === event.phase) ?? current;
      if (failed) {
        const error = event.error as { code?: string } | undefined;
        failed.status = ['WORKFLOW_RESULT_UNCERTAIN', 'WORKFLOW_SAVE_UNVERIFIED'].includes(error?.code ?? '') || failed.result?.outcome === 'unknown' ||
          failed.result?.outcome === 'partial' ? 'unknown' : 'failed';
        failed.finished_at = event.time;
      }
      continue;
    }
    if (!['step_started', 'step_finished', 'step_approved'].includes(event.state)) continue;
    // Older journals have no phase IDs. Repeated source reads follow plan order.
    const phase = event.phase ? phases.find(phase => phase.id === event.phase)
      : event.step === 'read_source' ? event.state === 'step_started' ? readPhases[readIndex++] : current
      : phases.find(phase => phase.id === event.step);
    if (!phase) continue;
    current = phase;
    if (typeof event.approval_id === 'string') phase.approval_id = event.approval_id;
    if (event.state === 'step_started') { phase.status = 'running'; phase.started_at = event.time; }
    if (event.state === 'step_finished') {
      phase.result = event; phase.finished_at = event.time;
      phase.status = event.outcome === 'unknown' || event.outcome === 'partial' ? 'unknown'
        : event.status === 'success' ? 'completed' : 'failed';
    }
  }
  if (execution && !execution.running) for (const phase of phases) {
    if (phase.status === 'running') phase.status = 'unknown';
    if (phase.status === 'pending') phase.status = 'skipped';
  }
  return { phases, completed: phases.filter(phase => phase.status === 'completed').length,
    total: phases.length, failure: failure?.error ?? null };
}
