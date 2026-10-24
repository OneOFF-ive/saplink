import { AppError } from './errors.js';

// Bounded line-based LCS. Trim unchanged edges first so small edits in large
// sources remain cheap; refuse expensive comparisons rather than invent a diff.
export function sourceDiff(before: string, after: string, context = 3, maxLines = 400) {
  const split = (value: string) => value === '' ? [] : value.replace(/\r\n?/g, '\n').split('\n');
  const a = split(before), b = split(after);
  let prefix = 0, suffix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  const n = a.length - prefix - suffix, m = b.length - prefix - suffix;
  if (a.length + b.length > 40000 || (n + 1) * (m + 1) > 4000000)
    throw new AppError('DIFF_TOO_LARGE', 'Comparison exceeds the bounded line-diff budget; compare smaller source parts locally');
  const matrix = new Uint16Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    matrix[at(i, j)] = a[prefix + i] === b[prefix + j] ? 1 + matrix[at(i + 1, j + 1)]
      : Math.max(matrix[at(i + 1, j)], matrix[at(i, j + 1)]);
  type Line = { kind: 'context' | 'added' | 'removed'; old_line: number | null; new_line: number | null; text: string; text_truncated?: boolean };
  const lines: Line[] = [];
  let oldLine = 1, newLine = 1;
  const push = (kind: Line['kind'], text: string) => lines.push({ kind,
    old_line: kind === 'added' ? null : oldLine++, new_line: kind === 'removed' ? null : newLine++, text });
  for (let i = 0; i < prefix; i++) push('context', a[i]);
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[prefix + i] === b[prefix + j]) { push('context', a[prefix + i++]); j++; }
    else if (i < n && (j === m || matrix[at(i + 1, j)] >= matrix[at(i, j + 1)])) push('removed', a[prefix + i++]);
    else push('added', b[prefix + j++]);
  }
  for (let i = a.length - suffix; i < a.length; i++) push('context', a[i]);
  const keep = new Set<number>();
  for (let k = 0; k < lines.length; k++) if (lines[k].kind !== 'context')
    for (let x = Math.max(0, k - context); x <= Math.min(lines.length - 1, k + context); x++) keep.add(x);
  const hunks: { lines: Line[] }[] = [];
  let last = -2, count = 0, bytes = 0, truncated = false;
  for (const k of [...keep].sort((a, b) => a - b)) {
    const original = lines[k];
    const line = { ...original, text: original.text.slice(0, 4000), text_truncated: original.text.length > 4000 };
    const size = Buffer.byteLength(JSON.stringify(line));
    if (count >= maxLines || bytes + size > 65536) { truncated = true; break; }
    if (line.text_truncated) truncated = true;
    if (k !== last + 1) hunks.push({ lines: [] });
    hunks[hunks.length - 1].lines.push(line); last = k; count++; bytes += size;
  }
  return { equal: before === after, line_endings_only: before !== after && before.replace(/\r\n?/g, '\n') === after.replace(/\r\n?/g, '\n'),
    added_lines: lines.filter(l => l.kind === 'added').length, removed_lines: lines.filter(l => l.kind === 'removed').length,
    hunks, returned_diff_lines: count, truncated, context_lines: context,
    limits: { max_cells: 4000000, max_total_lines: 40000, max_output_bytes: 65536 } };
}
