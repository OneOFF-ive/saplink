import { z } from 'zod';
import { AppError } from './errors.js';

const maximumSourceLength = 1024 * 1024;
export const sourceUpdateFields = {
  source: z.string().max(maximumSourceLength).optional(),
  edits: z.array(z.object({
    old_text: z.string().min(1).max(maximumSourceLength),
    new_text: z.string().max(maximumSourceLength)
  }).strict()).min(1).max(50).optional(),
  include_source: z.boolean().optional()
};
export const sourceUpdateSchema = z.object(sourceUpdateFields).refine(
  value => (value.source === undefined) !== (value.edits === undefined),
  {message: 'Provide exactly one of source or edits'}
);
export type SourceEdit = NonNullable<z.infer<typeof sourceUpdateSchema>['edits']>[number];

// All edits refer to the same reviewed original. Never replace ambiguous matches,
// apply replacements to newly inserted text, or modify part of an overlapping set.
export function applySourceEdits(original: string, edits: SourceEdit[]): string {
  const spans = edits.map((edit, index) => {
    const start = original.indexOf(edit.old_text);
    if (!edit.old_text || start < 0) throw new AppError('SOURCE_EDIT_NOT_FOUND', 'Original fragment was not found; reread and review source before editing.', {edit_index:index});
    if (original.indexOf(edit.old_text, start + 1) >= 0) {
      throw new AppError('SOURCE_EDIT_AMBIGUOUS', 'Original fragment occurs more than once; include enough unchanged context to identify one location.', {edit_index:index});
    }
    return {start, end:start + edit.old_text.length, text:edit.new_text, index};
  }).sort((a,b) => a.start - b.start);
  let length = original.length;
  for (let i=0; i<spans.length; i++) {
    const span = spans[i];
    if (i && span.start < spans[i-1].end) throw new AppError('SOURCE_EDIT_OVERLAP', 'Edit fragments overlap; submit non-overlapping fragments.', {edit_index:span.index});
    length += span.text.length - (span.end - span.start);
  }
  if (length > maximumSourceLength) throw new AppError('INVALID_INPUT', 'Edited source exceeds the 1 MiB character limit.');
  const parts: string[] = [];
  let offset = 0;
  for (const span of spans) {parts.push(original.slice(offset, span.start), span.text); offset = span.end;}
  parts.push(original.slice(offset));
  return parts.join('');
}
