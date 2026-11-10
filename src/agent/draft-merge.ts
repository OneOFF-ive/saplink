import { sourceResult } from '../adt.js';
import { sourceDiff } from '../source-diff.js';
import { AppError } from '../errors.js';
import type { AgentTask, TaskStore } from './task-store.js';

export type DraftBaseline = {
  object_uri: string;
  source_uri: string;
  version: 'active' | 'inactive';
  revision: string;
};

export async function readDraftBaseline(task: AgentTask, store: TaskStore, baseline: DraftBaseline) {
  const reads = (task.source_reads ?? []).filter(read => read.read_source && read.revision === baseline.revision &&
    read.object_uri === baseline.object_uri);
  for (const read of reads) {
    const artifact = await store.artifacts.get(task.id, read.artifact_id).catch(error => {
      if (error instanceof AppError && error.code === 'AGENT_ARTIFACT_UNAVAILABLE') return undefined;
      throw error;
    });
    if (artifact?.kind !== 'result') continue;
    let result;
    try { result = JSON.parse(artifact.content); } catch { continue; }
    const source = result?.data;
    if (result?.status !== 'success' || typeof source?.source !== 'string' || source.source_uri !== baseline.source_uri ||
        source.object_uri !== baseline.object_uri || source.version !== baseline.version) continue;
    const expected = sourceResult(task.connection_id, baseline.object_uri, baseline.source_uri, source.source, baseline.version);
    if (source.hash === expected.hash && baseline.revision === expected.revision) return source.source as string;
  }
}

type Hunk = { start: number; end: number; lines: string[] };

function hunks(base: string, source: string): Hunk[] | undefined {
  const diff = sourceDiff(base, source, 0, 2000);
  if (diff.truncated || diff.line_endings_only) return;
  let delta = 0;
  return diff.hunks.map(hunk => {
    const removed = hunk.lines.filter(line => line.kind === 'removed');
    const added = hunk.lines.filter(line => line.kind === 'added');
    const start = removed.length ? removed[0].old_line! - 1 : added[0].new_line! - 1 - delta;
    delta += added.length - removed.length;
    return { start, end: start + removed.length, lines: added.map(line => line.text) };
  });
}

// Both proposals use the same base. Identical hunks are shared and touching
// insertions are held for review because their ordering can change behavior.
export function mergeDraftSources(base: string, previous: string, next: string) {
  if (previous === next) return previous;
  const previousHunks = hunks(base, previous);
  const nextHunks = hunks(base, next);
  if (!previousHunks || !nextHunks) return;
  const combined = [...previousHunks];
  for (const candidate of nextHunks) {
    if (previousHunks.some(hunk => hunk.start === candidate.start && hunk.end === candidate.end &&
      hunk.lines.join('\n') === candidate.lines.join('\n'))) continue;
    if (previousHunks.some(hunk => {
      if (candidate.start === candidate.end) return candidate.start >= hunk.start && candidate.start <= hunk.end;
      if (hunk.start === hunk.end) return hunk.start >= candidate.start && hunk.start <= candidate.end;
      return candidate.start < hunk.end && hunk.start < candidate.end;
    })) return;
    combined.push(candidate);
  }
  const ending = base.includes('\r\n') ? '\r\n' : '\n';
  if (base.replace(/\r\n/g, '').includes('\r') || (ending === '\r\n' && base.replace(/\r\n/g, '').includes('\n'))) return;
  const lines = base === '' ? [] : base.replace(/\r\n/g, '\n').split('\n');
  for (const hunk of combined.sort((a, b) => b.start - a.start)) {
    lines.splice(hunk.start, hunk.end - hunk.start, ...hunk.lines);
  }
  return lines.join(ending);
}
