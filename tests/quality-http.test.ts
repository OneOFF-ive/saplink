import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { AdtBackend } from '../src/adt.js';
import { connectionSchema } from '../src/config.js';
import { safeError } from '../src/errors.js';

const object = '/sap/bc/adt/programs/programs/ztest';
async function fixture(unitStatus = 200) {
  const calls: { url: URL; method?: string; body: string; session?: string; accept?: string }[] = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const url = new URL(req.url!, 'http://local');
    res.setHeader('Content-Type', 'application/xml');
    if (url.pathname.endsWith('/compatibility/graph')) { res.setHeader('x-csrf-token', 'mock'); res.end('<graph/>'); return; }
    if (url.pathname.endsWith('/icf/logoff')) { res.end(''); return; }
    calls.push({ url, method: req.method, body, session: req.headers['x-sap-adt-sessiontype'] as string, accept: req.headers.accept });
    if (url.pathname === '/sap/bc/adt/atc/customizing') {
      res.end('<customizing><properties><property name="defaultCheckVariant" value="DEFAULT"/></properties><exemption><reasons/></exemption></customizing>');
    } else if (url.pathname === '/sap/bc/adt/atc/worklists' && req.method === 'POST') { res.setHeader('Content-Type', 'text/plain'); res.end('WL_1'); }
    else if (url.pathname === '/sap/bc/adt/atc/runs') {
      res.end('<worklistRun><worklistId>WL_1</worklistId><worklistTimestamp>2026-10-24T00:00:00Z</worklistTimestamp><infos/></worklistRun>');
    } else if (url.pathname === '/sap/bc/adt/atc/worklists/WL_1') {
      res.end(`<worklist id="WL_1" timestamp="2026-10-24T00:00:00Z" usedObjectSet="SCOPE" objectSetIsComplete="true"><objectSets/><objects>
      <object uri="${object}" type="PROG/P" name="ZTEST" packageName="$TMP" author="DEV"><findings>
      <finding uri="/sap/bc/adt/atc/finding/1" location="${object}/source/main#start=2,0;end=2,4" priority="1" checkId="CHECK" checkTitle="Quality" messageId="001" messageTitle="Review this" exemptionApproval="" exemptionKind=""><link href="/sap/bc/adt/atc/doc/1" rel="doc" type="text/plain"/></finding>
      </findings></object></objects></worklist>`);
    } else if (url.pathname === '/sap/bc/adt/abapunit/testruns') {
      res.statusCode = unitStatus;
      res.end(unitStatus === 200 ? '<aunit:runResult xmlns:aunit="http://www.sap.com/adt/aunit"><program><testClasses><testClass name="LTC_TEST" riskLevel="harmless"><testMethods><testMethod name="OK" executionTime="0.1"/></testMethods></testClass></testClasses></program></aunit:runResult>' : '<error/>');
    } else if (url.pathname === '/sap/bc/adt/oo/classes/ztest') {
      res.end(`<class:abapClass xmlns:class="http://www.sap.com/adt/oo/classes" xmlns:adtcore="http://www.sap.com/adt/core" xmlns:abapsource="http://www.sap.com/adt/abapsource" xmlns:atom="http://www.w3.org/2005/Atom" adtcore:name="ZTEST" adtcore:type="CLAS/OC" adtcore:version="active" class:visibility="public"><class:include class:includeType="main" abapsource:sourceUri="source/main"><atom:link rel="http://www.sap.com/adt/relations/versions" href="includes/main/versions"/><atom:link rel="http://www.sap.com/adt/relations/source" href="source/main" type="text/plain"/></class:include></class:abapClass>`);
    } else if (url.pathname === '/sap/bc/adt/oo/classes/ztest/includes/main/versions') {
      res.setHeader('Content-Type', 'application/atom+xml;type=feed');
      res.end('<atom:feed xmlns:atom="http://www.w3.org/2005/Atom"><atom:entry><atom:title>Earlier class</atom:title><atom:content src="/sap/bc/adt/oo/classes/ztest/includes/main/versions/20261024000000/00001/content"/></atom:entry></atom:feed>');
    } else if (url.pathname === '/sap/bc/adt/oo/classes/ztest/includes/main/versions/20261024000000/00001/content') {
      res.setHeader('Content-Type', 'text/plain'); res.end('CLASS ztest DEFINITION.\nENDCLASS.');
    } else if (url.pathname === '/sap/bc/adt/oo/classes/ztest/source/main') {
      res.setHeader('Content-Type', 'text/plain'); res.end('CLASS ztest DEFINITION FINAL.\nENDCLASS.');
    } else if (url.pathname === object) {
      res.end(`<program:abapProgram xmlns:program="http://www.sap.com/adt/programs/programs" xmlns:adtcore="http://www.sap.com/adt/core" xmlns:abapsource="http://www.sap.com/adt/abapsource" xmlns:atom="http://www.w3.org/2005/Atom" adtcore:name="ZTEST" adtcore:type="PROG/P" adtcore:version="${url.searchParams.get('version') ?? 'active'}" abapsource:sourceUri="source/main"><atom:link rel="http://www.sap.com/adt/relations/versions" href="${object}/source/main/versions"/></program:abapProgram>`);
    } else if (url.pathname === object + '/source/main/versions') {
      res.setHeader('Content-Type', 'application/atom+xml;type=feed');
      res.end(`<atom:feed xmlns:atom="http://www.w3.org/2005/Atom"><atom:entry><atom:title>Transport snapshot</atom:title><atom:content src="${object}/source/main?version=00001"/><atom:updated>2026-10-20T00:00:00Z</atom:updated><atom:author><atom:name>DEV</atom:name></atom:author></atom:entry></atom:feed>`);
    } else if (url.pathname === object + '/source/main') {
      res.setHeader('Content-Type', 'text/plain');
      res.end(url.searchParams.get('version') === '00001' ? 'REPORT ztest.\nWRITE 0.' : url.searchParams.get('version') === 'inactive' ? 'REPORT ztest.\nWRITE 2.' : 'REPORT ztest.\nWRITE 1.');
    } else { res.statusCode = 404; res.end('<error/>'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const connection = connectionSchema.parse({ connection_id: randomUUID(), name: 'mock', base_url: `http://127.0.0.1:${address.port}`,
    username: 'DEV', client: '001', language: 'EN' });
  const backend = new AdtBackend(connection, 'fake');
  return { backend, calls, connection, close: async () => { try { await backend.close(); } finally { await new Promise<void>(resolve => server.close(() => resolve())); } } };
}

test('ATC creates one bounded worklist/run and reads findings without asserting overall pass', async () => {
  const f = await fixture();
  try {
    const config: any = await f.backend.quality('get_atc_configuration', {});
    assert.equal(config.properties[0].value, 'DEFAULT');
    const run: any = await f.backend.quality('run_atc', { object_uri: object, check_variant: 'DEFAULT', max_findings: 25, confirm_execution: true, request_id: 'one' });
    assert.equal(run.run_id, 'WL_1'); assert.equal(run.submission, 'accepted');
    assert.equal(run.next_action.arguments.connection_id, f.connection.connection_id);
    const execution = f.calls.find(c => c.url.pathname.endsWith('/runs'))!;
    assert.equal(execution.method, 'POST'); assert.equal(execution.url.searchParams.get('worklistId'), 'WL_1');
    assert.ok(execution.body.includes('maximumVerdicts="25"')); assert.ok(execution.body.includes(object));
    const result: any = await f.backend.quality('get_atc_results', { run_id: run.run_id, limit: 5 });
    assert.equal(result.items[0].priority, 1); assert.equal(result.assessment, 'findings_present');
    assert.equal(result.execution_status, 'unknown'); assert.equal(result.findings_may_be_limited, true);
    assert.equal(f.calls.filter(c => c.method === 'POST').length, 2);
  } finally { await f.close(); }
});

test('Unit sends only the selected object and harmless risk flags without saves or activation', async () => {
  const f = await fixture();
  try {
    const result: any = await f.backend.quality('run_unit_tests', { object_uri: object, max_duration: 'medium', confirm_execution: true, request_id: 'one' });
    assert.equal(result.test_status, 'passed');
    const request = f.calls[0];
    assert.equal(request.url.pathname, '/sap/bc/adt/abapunit/testruns'); assert.equal(request.method, 'POST');
    assert.equal(request.session, 'stateful');
    assert.ok(request.body.includes('harmless="true"')); assert.ok(request.body.includes('dangerous="false"'));
    assert.ok(request.body.includes('critical="false"')); assert.ok(request.body.includes('medium="true"'));
    assert.ok(request.body.includes('long="false"')); assert.ok(!request.body.includes('request_id'));
    assert.equal((request.body.match(/adtcore:objectReference /g) ?? []).length, 1);
    assert.equal(f.calls.length, 1);
  } finally { await f.close(); }
});

test('a previously logged-in execution session never implicitly replays Unit after HTTP 401', async () => {
  const f = await fixture(401);
  try {
    await f.backend.quality('get_atc_configuration', {});
    await assert.rejects(f.backend.quality('run_unit_tests', { object_uri: object, confirm_execution: true, request_id: 'one' }), e => {
      assert.equal(safeError(e).code, 'AUTH_FAILED'); return true;
    });
    assert.equal(f.calls.filter(c => c.url.pathname.endsWith('/testruns')).length, 1);
  } finally { await f.close(); }
});

test('history uses Atom media type and opaque object-bound selectors for discovered source resources', async () => {
  const f = await fixture();
  try {
    const list: any = await f.backend.quality('list_source_versions', { object_uri: object });
    const handle = list.items[0].version_id; assert.match(handle, /^[a-f0-9]{64}$/);
    assert.equal(list.items[0].resource, undefined);
    assert.equal(f.calls.find(c => c.url.pathname.endsWith('/versions'))?.accept, 'application/atom+xml;type=feed');
    const comparison: any = await f.backend.quality('compare_source_versions', { object_uri: object, from_version: handle, to_version: 'active' });
    assert.equal(comparison.added_lines, 1); assert.equal(comparison.removed_lines, 1);
    assert.ok(f.calls.some(c => c.url.searchParams.get('version') === '00001'));
    await assert.rejects(f.backend.quality('compare_source_versions', { object_uri: object, from_version: 'f'.repeat(64), to_version: 'active' }), /selector is unavailable/);
    assert.ok(f.calls.every(c => c.method === 'GET'));
  } finally { await f.close(); }
});


test('class main history links resolve relative to the class document, not source/main', async () => {
  const f = await fixture(); const classObject = '/sap/bc/adt/oo/classes/ztest';
  try {
    const history: any = await f.backend.quality('list_source_versions', { object_uri: classObject });
    assert.equal(history.returned_count, 1);
    assert.ok(f.calls.some(c => c.url.pathname === classObject + '/includes/main/versions'));
    assert.ok(!f.calls.some(c => c.url.pathname.includes('/source/main/includes/')));
    const result: any = await f.backend.quality('compare_source_versions', { object_uri: classObject,
      from_version: history.items[0].version_id, to_version: 'active' });
    assert.equal(result.equal, false); assert.equal(result.added_lines, 1); assert.equal(result.removed_lines, 1);
    assert.ok(f.calls.every(c => c.method === 'GET'));
  } finally { await f.close(); }
});
