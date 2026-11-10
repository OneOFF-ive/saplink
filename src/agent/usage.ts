import type { AgentTask } from './task-store.js';
import type { Completion } from './model.js';

// Count only usage actually returned by the provider; failed/aborted calls may
// be billed without reporting usage, so never present this as a complete bill.
export function recordModelUsage(task: AgentTask, usage: Completion['usage']) {
  if (!usage) return;
  const keys = ['prompt_tokens', 'completion_tokens', 'total_tokens'] as const;
  const reported = keys.filter(key => Number.isSafeInteger(usage[key]) && usage[key]! >= 0);
  if (!reported.length) return;
  task.model_usage ??= { reported_requests: 0 };
  task.model_usage.reported_requests++;
  for (const key of reported) task.model_usage[key] = (task.model_usage[key] ?? 0) + usage[key]!;
}
