import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTransportList, parseTransportDetails, parseTransportSummary } from '../src/transports.js';
import { AdtBackend } from '../src/adt.js';
import { connectionSchema } from '../src/config.js';
import { randomUUID } from 'node:crypto';
import { AppError } from '../src/errors.js';

for (const prefix of ['tm:', 'cts:', '']) {
  for (const grouped of [true, false]) {
    test(`transport list accepts prefix ${prefix || 'default'} and grouped=${grouped}`, () => {
      const xml = `<root xmlns="urn:test"><workbench>${grouped ? '<target name="DEV">' : ''}<modifiable><request number="DEVK904708" owner="ZJT_WUZH1" status="D"><task number="DEVK904709" owner="ZJT_WUZH1" status="D"/></request></modifiable>${grouped ? '</target>' : ''}</workbench><customizing/></root>`;
      const namespaced = prefix ? xml.replace(/<(\/?)(\w+)/g, `<$1${prefix}$2`).replace('xmlns="urn:test"', `xmlns:${prefix.slice(0, -1)}="urn:test"`) : xml;
      const result = parseTransportList(namespaced);
      assert.equal(result.workbench[0].modifiable[0]['tm:number'], 'DEVK904708');
      assert.equal(result.workbench[0].modifiable[0].tasks[0]['tm:number'], 'DEVK904709');
      assert.deepEqual(result.customizing, []);
    });
  }
}
test('unrecognized transport XML must not appear as an empty list', () => {
  for (const xml of ['', '<html/>', '<root><unexpected/></root>']) assert.throws(() => parseTransportList(xml));
  assert.deepEqual(parseTransportList('<root><workbench/><customizing/></root>'), { workbench: [], customizing: [] });
});
test('transport details preserve classification and task ownership', () => {
  const request = parseTransportDetails('<root><request number="DEVK904708" type="K" status="D" owner="TEST"><task number="DEVK904709" owner="OTHER"/></request></root>');
  assert.equal((request as any)['tm:type'], 'K');
  assert.equal(request?.tasks[0]['tm:owner'], 'OTHER');
});
test('unknown transport schema diagnostics expose element names only', () => {
  assert.throws(() => parseTransportList('<root token="secret"><tree><node owner="private">hidden</node></tree></root>'), (error: any) => {
    assert.deepEqual(error.details, { response_element_paths: ['tree', 'tree/node'] });
    assert.doesNotMatch(JSON.stringify(error.details), /secret|private|hidden|token|owner/);
    return true;
  });
});
test('empty legacy transport root uses a matching saved configuration read-only', async () => {
  const backend = new AdtBackend(connectionSchema.parse({ connection_id: randomUUID(), name: 'mock',
    base_url: 'http://127.0.0.1:12345', client: '001', language: 'EN', username: 'TEST' }), 'fake');
  const uri = '/sap/bc/adt/cts/transportrequests/searchconfiguration/configurations/test';
  const calls: any[] = [];
  let configs = [{ link: uri }];
  (backend as any).reader = {
    transportConfigurations: async () => configs,
    getTransportConfiguration: async (path: string) => {
      assert.equal(path, uri);
      return { User: 'TEST', WorkbenchRequests: true, Modifiable: true };
    },
    httpClient: { request: async (path: string, options: any) => {
      calls.push(options);
      assert.equal(path, '/sap/bc/adt/cts/transportrequests');
      assert.equal(options.method, undefined);
      assert.equal(options.headers.Accept, 'application/vnd.sap.adt.transportorganizertree.v1+xml');
      return { body: options.qs.configUri
        ? '<root><workbench><modifiable><request number="DEVK904708"><task number="DEVK904709"/></request></modifiable></workbench></root>'
        : '<root marker="empty"/>' };
    } }
  };
  const result = await backend.transports();
  assert.equal(result.workbench[0].modifiable[0]['tm:number'], 'DEVK904708');
  assert.equal(calls[1].qs.configUri, uri);
  configs = [];
  await assert.rejects(backend.transports(), (error: any) => error.code === 'TRANSPORT_QUERY_CONFIG_REQUIRED');
});
test('source save resolves an explicitly selected user task to its parent correction request', async () => {
  const backend = new AdtBackend(connectionSchema.parse({ connection_id: randomUUID(), name: 'mock',
    base_url: 'http://127.0.0.1:12345', client: '001', language: 'EN', username: 'TEST' }), 'fake');
  const source = '/sap/bc/adt/programs/programs/ztest/source/main';
  const calls: any[] = [];
  let owner = 'TEST'; let status = 'D';
  (backend as any).reader = { httpClient: { request: async () => { throw new AppError('OBJECT_NOT_FOUND', 'Unsupported detail', { http_status: 404 }); } } };
  backend.transports = async () => ({ workbench: [{ 'tm:name': '', 'tm:desc': '', released: [], modifiable: [
    { 'tm:number': 'DEVK904714', tasks: [{ 'tm:number': 'DEVK904715', 'tm:owner': owner, 'tm:status': status }] } as any
  ] }], customizing: [] });
  (backend as any).client = { setObjectSource: async (...args: any[]) => { calls.push(args); } };
  await backend.save(source, 'REPORT ztest.', 'handle', 'DEVK904715');
  assert.deepEqual(calls[0], [source, 'REPORT ztest.', 'handle', 'DEVK904714']);
  for (const invalid of ['DEVK904714', 'DEVK999999']) {
    await assert.rejects(backend.save(source, 'REPORT ztest.', 'handle', invalid), (error: any) => error.code === 'TRANSPORT_TASK_INVALID');
  }
  owner = 'OTHER';
  await assert.rejects(backend.save(source, 'REPORT ztest.', 'handle', 'DEVK904715'));
  owner = 'TEST'; status = 'R';
  await assert.rejects(backend.save(source, 'REPORT ztest.', 'handle', 'DEVK904715'));
  assert.equal(calls.length, 1);
  await backend.save(source, 'REPORT ztest.', 'handle');
  assert.equal(calls[1][3], undefined);
});


test('save dispatch is reported only after transport preflight succeeds', async () => {
  const backend = new AdtBackend(connectionSchema.parse({ connection_id: randomUUID(), name: 'mock',
    base_url: 'http://127.0.0.1:12345', client: '001', language: 'EN', username: 'TEST' }), 'fake');
  let dispatched = 0; let writes = 0;
  (backend as any).client = { setObjectSource: async () => { writes++; assert.equal(dispatched, 1); } };
  (backend as any).reader = { httpClient: { request: async () => { throw new AppError('OBJECT_NOT_FOUND', 'Unsupported detail', { http_status: 404 }); } } };
  backend.transports = async () => { throw new Error('preflight failed'); };
  await assert.rejects(backend.save('/sap/bc/adt/programs/programs/ztest/source/main', 'REPORT ztest.', 'handle', 'DEVK904715', () => { dispatched++; }));
  assert.equal(dispatched, 0); assert.equal(writes, 0);
  await backend.save('/sap/bc/adt/programs/programs/ztest/source/main', 'REPORT ztest.', 'handle', undefined, () => { dispatched++; });
  assert.equal(writes, 1);
});


function taskDetail(owner = 'TEST', status = 'D', parentStatus = 'D', parentType = 'K') {
  return '<root><request number="DEVK904714" type="' + parentType + '" status="' + parentStatus + '" owner="OTHER"/>' +
    '<task number="DEVK904715" parent="DEVK904714" owner="' + owner + '" status="' + status + '"><abap_object name="PRIVATE_OBJECT"/><link href="PRIVATE_ACTION"/></task></root>';
}

test('task detail summary handles sibling tasks and omits inventories and action links', () => {
  const result = parseTransportSummary(taskDetail())!;
  assert.equal(result['tm:number'], 'DEVK904714');
  assert.equal(result.tasks[0]['tm:number'], 'DEVK904715');
  assert.deepEqual(result.tasks[0].objects, []); assert.deepEqual(result.tasks[0].links, []);
  assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
  assert.throws(() => parseTransportSummary(taskDetail().replace('parent="DEVK904714"', 'parent="DEVK999999"')));
  assert.throws(() => parseTransportSummary('<root>broken'));
  assert.throws(() => parseTransportSummary('<root><request number="DEVK904714"/><request number="DEVK999999"/></root>'));
});

test('save uses a single task detail, validates ownership and state, and never reads the full list', async () => {
  const backend = new AdtBackend(connectionSchema.parse({ connection_id: randomUUID(), name: 'mock',
    base_url: 'http://127.0.0.1:12345', client: '001', language: 'EN', username: 'TEST' }), 'fake');
  let body = taskDetail(); let reads = 0; let writes = 0;
  (backend as any).reader = { httpClient: { request: async (path: string, options: any) => {
    assert.equal(path, '/sap/bc/adt/cts/transportrequests/DEVK904715');
    assert.equal(options.method, undefined); reads++; return { body };
  } } };
  backend.transports = async () => { throw Error('full list must not be queried'); };
  (backend as any).client = { setObjectSource: async (_s: string, _c: string, _h: string, parent: string) => {
    assert.equal(parent, 'DEVK904714'); writes++;
  } };
  const save = () => backend.save('/sap/bc/adt/programs/programs/ztest/source/main', 'REPORT ztest.', 'handle', 'DEVK904715');
  await save(); assert.equal(reads, 1); assert.equal(writes, 1);
  for (const invalid of [taskDetail('OTHER'), taskDetail('TEST', 'R'), taskDetail('TEST', 'D', 'R'), taskDetail('TEST', 'D', 'D', 'W')]) {
    body = invalid; await assert.rejects(save(), (error: any) => error.code === 'TRANSPORT_TASK_INVALID');
  }
  assert.equal(writes, 1);
  for (const status of [401, 403, 500]) {
    (backend as any).reader.httpClient.request = async () => { throw new AppError('ADT_ERROR', 'failed', { http_status: status }); };
    await assert.rejects(save());
  }
});

test('known transport query is compact and does not query the collection', async () => {
  const backend = new AdtBackend(connectionSchema.parse({ connection_id: randomUUID(), name: 'mock',
    base_url: 'http://127.0.0.1:12345', client: '001', language: 'EN', username: 'TEST' }), 'fake');
  (backend as any).reader = { httpClient: { request: async (path: string) => {
    assert.equal(path, '/sap/bc/adt/cts/transportrequests/DEVK904715'); return { body: taskDetail() };
  } } };
  const result = await backend.transports('DEVK904715');
  assert.equal(result.workbench[0].modifiable[0].tasks[0]['tm:number'], 'DEVK904715');
  assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
  await assert.rejects(backend.transports('../bad'));
});


test('created task verification uses one detail read rather than listing all requests', async () => {
  const backend = new AdtBackend(connectionSchema.parse({ connection_id: randomUUID(), name: 'mock',
    base_url: 'http://127.0.0.1:12345', client: '001', language: 'EN', username: 'TEST' }), 'fake');
  let reads = 0;
  (backend as any).reader = { httpClient: { request: async (path: string) => {
    assert.equal(path, '/sap/bc/adt/cts/transportrequests/DEVK904715'); reads++; return { body: taskDetail() };
  } } };
  backend.transports = async () => { throw Error('full list must not be queried'); };
  const verified = await backend.verifyTransportRequest('DEVK904715');
  assert.equal(verified?.request_number, 'DEVK904714');
  assert.deepEqual(verified?.tasks, [{ task_number: 'DEVK904715', owner: 'TEST', status: 'D' }]);
  assert.equal(reads, 1);
});
