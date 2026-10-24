import test from 'node:test';
import assert from 'node:assert/strict';
import type { UsageReference, UsageReferenceSnippet } from 'abap-adt-api';
import { findReferences, referenceBudget } from '../src/reference-query.js';
import { adtUri } from '../src/adt.js';
import { AppError } from '../src/errors.js';

const target = '/sap/bc/adt/oo/classes/ztarget';
const caller = '/sap/bc/adt/programs/programs/zcaller/source/main';
function row(id: string, extra: Partial<UsageReference> = {}): UsageReference {
  return { uri: caller, objectIdentifier: id, parentUri: '/sap/bc/adt/packages/ztest',
    isResult: false, canHaveChildren: true, usageInformation: '', 'adtcore:responsible': '',
    'adtcore:name': id, packageRef: { 'adtcore:uri': '/sap/bc/adt/packages/ztest', 'adtcore:name': 'ZTEST' }, ...extra };
}
function details(id: string, line = 20, column = 4, source = caller, content = 'ztarget=>run( ).', matches = '4-10,gradeDirect'): UsageReferenceSnippet {
  return { objectIdentifier: id, snippets: [{ uri: { uri: source, start: { line, column }, end: { line, column: column + 6 } },
    content, matches, description: 'Caller context' }] };
}
function reader(rows: UsageReference[], run?: (batch: UsageReference[], count: number) => Promise<UsageReferenceSnippet[]>) {
  const batches: UsageReference[][] = [];
  return { batches, usageReferences: async () => rows, usageReferenceSnippets: async (batch: UsageReference[]) => {
    batches.push(batch); return run ? run(batch, batches.length) : batch.map((r, i) => details(r.objectIdentifier, 20 + i));
  } };
}

test('where-used expands identifiers even when SAP flags are false, deduplicating actual locations', async () => {
  const packageNode = row('', { uri: '/sap/bc/adt/packages/ztest' });
  const r = reader([packageNode, row('A'), row('A'), row('B')], async () => [details('A'), details('B')]);
  const out = await findReferences(r, target, 10, adtUri);
  assert.equal(out.reference_count, 1); assert.equal(out.returned_count, 1);
  assert.equal(out.expanded_groups, 2); assert.equal(out.requests_used, 2);
  assert.equal(out.unexpanded_count, 0); assert.equal(out.expansion_complete, true);
  assert.equal(out.items[0].line, 20); assert.equal(out.items[0].column, 5);
  assert.equal(out.items[0].end_column_exclusive, 11);
  assert.equal(out.items[0].source_uri, caller);
  assert.equal(r.batches[0].length, 2);
});

test('target declarations do not count as usages, while actual internal calls remain', async () => {
  const source = `${target}/source/main`;
  const r = reader([row('A')], async () => [{ objectIdentifier: 'A', snippets: [
    details('A', 1, 6, source, 'CLASS ztarget DEFINITION.').snippets[0],
    details('A', 8, 8, source, 'CLASS-METHODS run.', '8-11,gradeComponent').snippets[0],
    details('A', 1, 9, source, 'METHOD run.', '9-12,gradeComponent').snippets[0],
    details('A', 30, 4, source, 'ztarget=>run( ).', '4-11,gradeDirect;13-16,gradeComponent').snippets[0]
  ] }]);
  const out = await findReferences(r, target, 10, adtUri);
  assert.equal(out.reference_count, 1); assert.equal(out.items[0].line, 30);
  assert.equal(out.excluded_declarations, 3); assert.equal(out.truncated, false);
});

test('result limit applies to actual usage sites rather than tree nodes', async () => {
  const r = reader([row('A'), row('B')]);
  const out = await findReferences(r, target, 1, adtUri);
  assert.equal(out.reference_count, 1); assert.equal(out.truncated, true);
  assert.ok(out.truncation_reasons.includes('reference_limit')); assert.equal(out.expansion_complete, false);
});

for (const reason of ['request_limit', 'group_limit', 'duration_limit']) {
  test(`where-used stops at ${reason} and reports unexpanded nodes`, async () => {
    const r = reader([row('A'), row('B'), row('C')]);
    const budget = { ...referenceBudget, batch_size: 1,
      ...(reason === 'request_limit' ? { max_requests: 2 } : {}),
      ...(reason === 'group_limit' ? { max_groups: 1 } : {}) };
    let ticks = 0;
    const out = await findReferences(r, target, 100, adtUri, { budget,
      now: () => reason === 'duration_limit' && ticks++ > 0 ? 30000 : 0 });
    assert.ok(out.truncation_reasons.includes(reason)); assert.equal(out.expansion_complete, false);
    assert.equal(out.unexpanded_count, reason === 'duration_limit' ? 3 : 2);
    assert.equal(out.requests_used, reason === 'duration_limit' ? 1 : 2);
  });
}

test('failed expansion preserves earlier results and sanitized errors without retrying', async () => {
  const r = reader([row('A'), row('B'), row('C')], async (batch, count) => {
    if (count === 2) throw new AppError('HTTP_FORBIDDEN', 'SAP denied snippet access');
    return [details(batch[0].objectIdentifier)];
  });
  const out = await findReferences(r, target, 100, adtUri, { budget: { ...referenceBudget, batch_size: 1 } });
  assert.equal(out.reference_count, 1); assert.equal(out.unexpanded_count, 2);
  assert.equal(out.errors[0].code, 'HTTP_FORBIDDEN'); assert.equal(out.requests_used, 3);
  assert.equal(r.batches.length, 2); assert.equal(out.truncated, true);
});

test('identifiers are escaped before library XML construction and correlated with decoded responses', async () => {
  const id = 'A<&"\'';
  const r = reader([row(id)], async batch => {
    assert.equal(batch[0].objectIdentifier, 'A&lt;&amp;&quot;&apos;'); return [details(id)];
  });
  const out = await findReferences(r, target, 10, adtUri);
  assert.equal(out.reference_count, 1);
});

test('missing snippet response and invalid locations cannot masquerade as completed empty searches', async () => {
  const missing = await findReferences(reader([row('A')], async () => []), target, 10, adtUri);
  assert.equal(missing.expansion_complete, false); assert.equal(missing.unexpanded_count, 1);
  assert.equal(missing.unexpanded_nodes[0].reason, 'missing_snippet_response');
  const unsafe = await findReferences(reader([row('A')], async () => [details('A', 20, 0, 'https://example.invalid/source')]), target, 10, adtUri);
  assert.equal(unsafe.reference_count, 0); assert.equal(unsafe.expansion_complete, false);
  assert.equal(unsafe.unexpanded_nodes[0].reason, 'location_unavailable');
});

test('snippet and context size are bounded without discarding the location', async () => {
  const r = reader([row('A')], async () => {
    const value = details('A', 20, 0, caller, 'x'.repeat(5000));
    value.snippets[0].description = 'y'.repeat(5000); return [value];
  });
  const out = await findReferences(r, target, 10, adtUri);
  assert.equal(out.items[0].snippet?.length, 2000); assert.equal(out.items[0].snippet_truncated, true);
  assert.equal(out.items[0].description.length, 2000); assert.equal(out.items[0].column, 1);
});

test('empty index response and directly returned usage locations are handled without snippet calls', async () => {
  const empty = await findReferences(reader([]), target, 10, adtUri);
  assert.equal(empty.reference_count, 0); assert.equal(empty.requests_used, 1);
  const r = reader([row('', { uri: `${caller}#start=7,0;end=7,4`, isResult: true, canHaveChildren: false })]);
  const direct = await findReferences(r, target, 10, adtUri);
  assert.equal(direct.reference_count, 1); assert.equal(direct.items[0].column, 1);
  assert.equal(direct.items[0].end_column_exclusive, 5); assert.equal(r.batches.length, 0);
});


test('fragment-relative locations retain their component identity rather than posing as whole-source coordinates', async () => {
  const r = reader([row('A')], async () => {
    const value = details('A');
    value.snippets[0].uri.type = 'CLAS/OM'; value.snippets[0].uri.name = 'RUN'; return [value];
  });
  const out = await findReferences(r, target, 10, adtUri);
  assert.equal(out.items[0].coordinate_scope, 'fragment');
  assert.equal(out.items[0].fragment_type, 'CLAS/OM'); assert.equal(out.items[0].fragment_name, 'RUN');
});
