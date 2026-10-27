import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { syntaxDiagnostics } from '../src/syntax-check.js';
import { AdtBackend, sourceResult } from '../src/adt.js';
import { connectionSchema } from '../src/config.js';

for (const prefix of ['chkrun:', 'custom:', '']) {
  test('syntax report supports namespace ' + prefix, () => {
    const xml = '<checkRunReports><checkReport><checkMessageList><checkMessage uri="/sap/bc/adt/source#start=12,3" type="E" shortText="Invalid &amp; incomplete"/></checkMessageList></checkReport></checkRunReports>';
    const namespaced = xml.replace(/<(\/?)([A-Za-z]+)/g, '<$1' + prefix + '$2');
    assert.deepEqual(syntaxDiagnostics(namespaced), [{ uri: '/sap/bc/adt/source', line: 12, offset: 3, severity: 'E', text: 'Invalid & incomplete' }]);
  });
}

test('syntax parser rejects HTML, broken XML and incomplete findings', () => {
  for (const xml of ['<html>login</html>', '<broken', '<checkRunReports><checkReport><checkMessageList><checkMessage type="E"/></checkMessageList></checkReport></checkRunReports>'])
    assert.throws(() => syntaxDiagnostics(xml));
  assert.deepEqual(syntaxDiagnostics('<checkRunReports/>'), []);
});

for (const version of ['active', 'inactive'] as const) {
  test('syntax check references the exact saved ' + version + ' version without inline source', async () => {
    const connection = connectionSchema.parse({ connection_id: randomUUID(), name: 'mock',
      base_url: 'http://127.0.0.1:12345', client: '001', username: 'TEST', language: 'EN' });
    const backend = new AdtBackend(connection, 'fake');
    const object = '/sap/bc/adt/programs/programs/ztest';
    const sourceUri = object + '/source/main';
    let changed = false; let reads = 0; let requests = 0;
    backend.read = async (_object, requested) => {
      assert.equal(requested, version); reads++;
      return sourceResult(connection.connection_id, object, sourceUri, changed && reads % 2 === 0 ? 'REPORT ztest. WRITE 1.' : 'REPORT ztest. PRIVATE_SOURCE', requested);
    };
    (backend as any).client.httpClient.request = async (path: string, options: any) => {
      requests++; assert.equal(path, '/sap/bc/adt/checkruns'); assert.equal(options.method, 'POST');
      assert.equal(options.qs.reporters, 'abapCheckRun');
      assert.equal(options.headers.Accept, 'application/vnd.sap.adt.checkmessages+xml');
      const body = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true }).parse(options.body);
      const checked = body.checkObjectList.checkObject;
      assert.equal(checked['@_uri'], sourceUri); assert.equal(checked['@_version'], version);
      assert.equal(checked.artifacts, undefined); assert.equal(options.body.includes('PRIVATE_SOURCE'), false);
      return { body: '<checkRunReports><checkReport><checkMessageList><checkMessage type="E" shortText="Syntax error"/></checkMessageList></checkReport></checkRunReports>' };
    };
    const result = await backend.check(object, version);
    assert.equal(result.passed, false); assert.equal(result.checked_version, version);
    assert.equal(result.request_mode, 'saved_version'); assert.equal(reads, 2); assert.equal(requests, 1);
    changed = true;
    await assert.rejects(backend.check(object, version), (error: any) => error.code === 'VERSION_CONFLICT');
  });
}
