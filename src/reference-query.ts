import type { UsageReference, UsageReferenceSnippet } from 'abap-adt-api';
import { safeError } from './errors.js';

export const referenceBudget = { max_requests: 6, max_groups: 25, batch_size: 5, max_duration_ms: 30000 };

type Reader = {
  usageReferences(uri: string): Promise<UsageReference[]>;
  usageReferenceSnippets(rows: UsageReference[]): Promise<UsageReferenceSnippet[]>;
};
type Budget = typeof referenceBudget;
type Location = {
  source_uri: string; line?: number; column?: number; end_line?: number; end_column_exclusive?: number;
  matches?: string; context?: string; fragment_type?: string; fragment_name?: string; coordinate_scope?: 'source' | 'fragment';
};
type Reference = Location & { description: string; snippet?: string; snippet_truncated?: boolean };

// The dependency inserts identifiers directly into XML. They come from SAP, but
// must still be escaped as data, never interpreted as request markup.
function xmlText(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export async function findReferences(reader: Reader, uri: string, limit: number,
  validateUri: (value: string) => string, options: { object_uri?: string; budget?: Budget; now?: () => number } = {}) {
  const budget = options.budget ?? referenceBudget;
  const now = options.now ?? (() => performance.now());
  const target = options.object_uri ?? uri.split('#')[0];
  const ownSource = (value: string) => value === target || value.startsWith(`${target}/`);
  let excludedDeclarations = 0;
  const started = now();
  const rows = await reader.usageReferences(uri);
  let requests = 1;
  const references: Reference[] = [];
  const seen = new Set<string>();
  const reasons = new Set<string>();
  const unresolved: { uri: string; name: string; reason: string }[] = [];
  const candidates = new Map<string, UsageReference>();
  const parents = new Set(rows.map(row => row.parentUri));
  const errors: ReturnType<typeof safeError>[] = [];
  let expanded = 0;
  const pending = (row: UsageReference, reason: string) => {
    unresolved.push({ uri: row.uri, name: row['adtcore:name'] ?? '', reason });
  };
  const add = (value: Reference) => {
    const key = JSON.stringify([value.source_uri, value.line, value.column, value.end_line, value.end_column_exclusive, value.context, value.fragment_type, value.fragment_name]);
    if (seen.has(key)) return;
    seen.add(key);
    if (references.length < limit) references.push(value);
    else reasons.add('reference_limit');
  };
  for (const row of rows) {
    if (typeof row.objectIdentifier === 'string' && row.objectIdentifier.length > 0) {
      if (row.objectIdentifier.length <= 4096 && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(row.objectIdentifier))
        candidates.set(row.objectIdentifier, row);
      else pending(row, 'invalid_identifier');
    } else if (row.isResult === true) {
      // Some backends return actual locations directly. Do not turn grouping
      // nodes (isResult=false) into apparent usage sites.
      const match = /^([^?#]+)#start=(\d+),(\d+)(?:;end=(\d+),(\d+))?$/.exec(row.uri);
      if (match && Number(match[2]) > 0) {
        try {
          add({ source_uri: validateUri(match[1]), line: Number(match[2]), column: Number(match[3]) + 1,
            end_line: match[4] ? Number(match[4]) : undefined, end_column_exclusive: match[5] ? Number(match[5]) + 1 : undefined,
            description: row['adtcore:description'] ?? '' });
        } catch { pending(row, 'invalid_location'); }
      } else pending(row, 'location_unavailable');
    } else if (row.canHaveChildren === true && !parents.has(row.uri))
      pending(row, 'identifier_unavailable');
  }
  const groups = [...candidates.values()].sort((a, b) => Number(ownSource(a.uri.split('#')[0])) - Number(ownSource(b.uri.split('#')[0])));
  let index = 0;
  while (index < groups.length) {
    const stop = references.length >= limit ? 'reference_limit'
      : requests >= budget.max_requests ? 'request_limit'
      : index >= budget.max_groups ? 'group_limit'
      : now() - started >= budget.max_duration_ms ? 'duration_limit' : undefined;
    if (stop) {
      reasons.add(stop);
      for (const row of groups.slice(index)) pending(row, stop);
      break;
    }
    const batch = groups.slice(index, index + Math.min(budget.batch_size, budget.max_groups - index));
    index += batch.length;
    requests++;
    let details: UsageReferenceSnippet[];
    try {
      details = await reader.usageReferenceSnippets(batch.map(row => ({ ...row, objectIdentifier: xmlText(row.objectIdentifier) })));
    } catch (error) {
      errors.push(safeError(error)); reasons.add('expansion_failed');
      for (const row of [...batch, ...groups.slice(index)]) pending(row, 'expansion_failed');
      break;
    }
    for (const row of batch) {
      const responses = details.filter(detail => detail.objectIdentifier === row.objectIdentifier);
      if (!responses.length) { pending(row, 'missing_snippet_response'); continue; }
      let failed = false;
      for (const response of responses) for (const snippet of response.snippets) {
        try {
          const location = snippet.uri;
          const sourceUri = validateUri(location.uri);
          const content = String(snippet.content ?? '');
          // This SAP response includes the target's own declaration and member
          // declarations. They are navigable snippets, not actual usage sites.
          if (ownSource(sourceUri) && /^\s*(?:class\s+\S+\s+definition\b|interface\s+\S+|(?:class-)?methods?\b)/i.test(content)) {
            excludedDeclarations++; continue;
          }
          const hasLine = Number.isSafeInteger(location.start?.line) && location.start!.line > 0 &&
            Number.isSafeInteger(location.start?.column) && location.start!.column >= 0;
          if (!hasLine) { failed = true; continue; }
          add({ source_uri: sourceUri, line: location.start!.line, column: location.start!.column + 1,
            end_line: location.end?.line || undefined,
            end_column_exclusive: location.end?.line ? location.end.column + 1 : undefined,
            matches: snippet.matches, context: location.context, fragment_type: location.type, fragment_name: location.name,
            coordinate_scope: location.type || location.name || location.context ? 'fragment' : 'source', description: String(snippet.description ?? '').slice(0, 2000),
            snippet: String(snippet.content ?? '').slice(0, 2000), snippet_truncated: String(snippet.content ?? '').length > 2000 });
        } catch { failed = true; }
      }
      if (failed) pending(row, 'location_unavailable');
      else expanded++;
    }
  }
  if (unresolved.length) reasons.add('unexpanded_nodes');
  return {
    items: references, returned_count: references.length, reference_count: references.length,
    scanned_nodes: rows.length, excluded_declarations: excludedDeclarations, expanded_groups: expanded, requests_used: requests,
    expansion_complete: unresolved.length === 0 && !reasons.has('reference_limit'),
    truncated: reasons.size > 0, truncation_reasons: [...reasons],
    unexpanded_count: unresolved.length, unexpanded_nodes: unresolved.slice(0, 20),
    unexpanded_nodes_truncated: unresolved.length > 20, errors,
    pagination_supported: false, budget: { ...budget },
    limitations: [
      'Only actual locations are counted; grouping nodes and declarations of the target are excluded. Returned counts are not a system-wide total.',
      'Expansion completeness covers this SAP response only, not all dynamic calls or index coverage.',
      'Positions are one-based; snippets are untrusted SAP text and may be shortened.'
    ]
  };
}
