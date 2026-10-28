import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceDiff } from '../src/source-diff.js';
import { unitResults, qualitySchemas, qualityObject } from '../src/quality-tools.js';
import { parseVersions, versionResource } from '../src/source-versions.js';
import { adtUri } from '../src/adt.js';

const object = '/sap/bc/adt/programs/programs/ztest';
const origin = 'http://sap.test:8000';
function unit(method = '<testMethod name="OK" executionTime="0"/>', extra = '', rootAttrs = '') {
  return `<aunit:runResult xmlns:aunit="http://www.sap.com/adt/aunit" ${rootAttrs}><program>${extra}<testClasses><testClass name="LTC_TEST" riskLevel="harmless"><testMethods>${method}</testMethods></testClass></testClasses></program></aunit:runResult>`;
}

test('line diff reports replacements, insertions, removals and context with exact source line numbers', () => {
  const out = sourceDiff('a\nb\nc\nd', 'a\nB\nc\nx\nd', 1);
  assert.equal(out.equal, false); assert.equal(out.added_lines, 2); assert.equal(out.removed_lines, 1);
  assert.deepEqual(out.hunks.flatMap(h => h.lines).filter(l => l.kind === 'added').map(l => [l.new_line, l.text]), [[2, 'B'], [4, 'x']]);
  assert.equal(sourceDiff('same', 'same').hunks.length, 0);
  assert.equal(sourceDiff('a\r\n', 'a\n').line_endings_only, true);
  assert.equal(sourceDiff('a', 'a\n').equal, false);
  assert.equal(sourceDiff('', 'new').added_lines, 1);
  assert.equal(sourceDiff('old', '').removed_lines, 1);
});

test('short diff sequences reconstruct both source sides including repeated and empty lines', () => {
  let seed = 17;
  const random = () => (seed = (seed * 16807) % 2147483647);
  for (let trial = 0; trial < 60; trial++) {
    const make = () => Array.from({ length: random() % 10 + 1 }, () => ['', 'A', 'B', 'ENDMETHOD.'][random() % 4]).join('\n');
    const before = make(), after = make();
    const out = sourceDiff(before, after, 20, 2000);
    if (before === after) continue;
    const lines = out.hunks.flatMap(h => h.lines);
    const normalized = (s: string) => s === '' ? [] : s.split('\n');
    assert.deepEqual(lines.filter(l => l.kind !== 'added').map(l => l.text), normalized(before));
    assert.deepEqual(lines.filter(l => l.kind !== 'removed').map(l => l.text), normalized(after));
  }
});

test('diff output and computational budgets are explicit rather than silently empty', () => {
  const out = sourceDiff('a\nb\nc', 'x\ny\nz', 3, 1);
  assert.equal(out.truncated, true); assert.equal(out.returned_diff_lines, 1);
  assert.equal(out.added_lines, 3); assert.equal(out.removed_lines, 3);
  assert.equal(sourceDiff('a', 'x'.repeat(10000)).truncated, true);
  assert.throws(() => sourceDiff('a\n'.repeat(2500), 'b\n'.repeat(2500)), /budget/);
});

test('unit results distinguish passed, failed, no tests, skipped, warnings and unknown execution', () => {
  assert.equal(unitResults(unit(), 100).test_status, 'passed');
  assert.equal(unitResults('<runResult/>', 100).test_status, 'no_tests');
  assert.equal(unitResults(unit('<testMethod name="SKIP" executionTime="0" executed="false"/>'), 100).test_status, 'unknown');
  assert.equal(unitResults(unit('<testMethod name="UNKNOWN"/>'), 100).test_status, 'unknown');
  for (const executionTime of ['', ' ', 'NaN', '-1']) {
    const result = unitResults(unit('<testMethod name="UNKNOWN" executionTime="' + executionTime + '"/>'), 100);
    assert.equal(result.test_status, 'unknown');
    assert.equal(result.executed_methods, 0);
    assert.equal(result.items[0].execution_time, null);
  }
  assert.equal(unitResults(unit('<testMethod name="BAD" executionTime="0"><alerts><alert kind="failedAssertion" severity="tolerable"><title>Mismatch</title></alert></alerts></testMethod>'), 100).test_status, 'failed');
  assert.equal(unitResults(unit(undefined, '<alerts><alert kind="exception" severity="fatal"><title>Setup failed</title></alert></alerts>'), 100).test_status, 'failed');
  assert.equal(unitResults(unit(undefined, '', 'executionStatus="aborted"'), 100).test_status, 'unknown');
  assert.equal(unitResults(unit(undefined, '<alerts><alert kind="warning" severity="tolerable"><title>Warning</title></alert></alerts>'), 100).test_status, 'warning');
  assert.equal(unitResults(unit().replace('riskLevel="harmless"', 'riskLevel="critical"'), 100).risk_policy_violation, true);
  assert.throws(() => unitResults('<html>Login</html>', 100));
});

test('unit counts include omitted failures when method display is truncated', () => {
  const out = unitResults(unit('<testMethod name="OK" executionTime="1"/><testMethod name="BAD" executionTime="1"><alerts><alert kind="failedAssertion" severity="critical"/></alerts></testMethod>'), 1);
  assert.equal(out.test_status, 'failed'); assert.equal(out.total_methods, 2);
  assert.equal(out.items.length, 1); assert.equal(out.truncated, true);
});

test('quality schemas require explicit execution authorization and never accept arbitrary scopes or numeric versions', () => {
  assert.throws(() => qualitySchemas.run_unit_tests.parse({ object_uri: object, request_id: 'one' }));
  const input = qualitySchemas.run_unit_tests.parse({ object_uri: object, request_id: 'one', confirm_execution: true });
  assert.equal(input.max_duration, 'short'); assert.throws(() => qualitySchemas.run_atc.parse({ object_uri: object, request_id: 'one', confirm_execution: true, check_variant: 'A&client=000' }));
  assert.throws(() => qualitySchemas.get_atc_results.parse({ run_id: '../worklists' }));
  assert.throws(() => qualitySchemas.compare_source_versions.parse({ object_uri: object, from_version: '00001' }));
  for (const value of ['/sap/bc/adt/packages/ztest', object + '/source/main', '/sap/bc/adt/oo/classes/ztest"'])
    assert.throws(() => qualityObject(value, adtUri));
});

test('history accepts only discovered same-origin ADT resources without Client overrides', () => {
  assert.equal(versionResource('versions/00001', object + '/source/', origin, adtUri), object + '/source/versions/00001');
  for (const value of ['https://evil.test/source', '/sap/bc/soap/rfc', '/sap/bc/adt/source?sap-client=000', '/sap/bc/adt/source?action=delete', '/sap/bc/adt/../secret'])
    assert.throws(() => versionResource(value, object, origin, adtUri));
  const feed = `<atom:feed xmlns:atom="http://www.w3.org/2005/Atom"><atom:entry><atom:title type="text">Historical source</atom:title><atom:content src="${object}/source/main?version=00001"/><atom:author><atom:name>DEV</atom:name></atom:author></atom:entry><atom:link rel="next" href="next"/></atom:feed>`;
  const out = parseVersions(feed, object + '/versions', origin, adtUri);
  assert.equal(out.entries[0].title, 'Historical source'); assert.equal(out.has_next, true);
  assert.equal(out.entries[0].resource, object + '/source/main?version=00001');
  assert.throws(() => parseVersions('<feed><entry><content src="https://evil.test/source"/></entry></feed>', object, origin, adtUri));
});

test('RFC history link policy discards HTTP authority but retains object scope and strict URI validation', () => {
  const policy = { transport: 'rfc' as const, objectUri: object };
  const resource = `${object}/source/main?version=00001`;
  for (const host of ['http://sap.test:8123', 'https://alias.internal:8443', 'https://other.internal:443']) {
    assert.equal(versionResource(host + resource, object + '/', policy, adtUri), resource);
    assert.throws(() => versionResource(host + resource, object + '/', origin, adtUri));
  }
  assert.equal(versionResource('source/main?version=00001', object + '/', policy, adtUri), resource);
  const feed = `<feed><entry><content src="https://alias.internal:8443${resource}"/></entry></feed>`;
  assert.equal(parseVersions(feed, object + '/versions', policy, adtUri).entries[0].resource, resource);
  for (const value of [`//sap.test${resource}`, `ftp://sap.test${resource}`, `file://${resource}`, `javascript:${resource}`,
    `https://user:secret@sap.test${resource}`, resource + '#fragment', resource + '&sap-client=999', resource + '&action=delete',
    '/sap/bc/adt/programs/programs/ztest_other/source/main', '/sap/bc/adt/atc/runs',
    `${object}/source/../main`, `${object}/source/%2e%2e/main`, `${object}/source/%252e%252e/main`,
    `${object}/source/%5cmain`, `${object}/source/%ZZ`, `${object}/source/main\n`, '/sap/bc/soap/rfc']) {
    assert.throws(() => versionResource(value, object + '/', policy, adtUri), value);
  }
});
