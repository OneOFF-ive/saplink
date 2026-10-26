import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { AdtBackend, adtUri, sourceResult } from '../src/adt.js';
import { connectionSchema } from '../src/config.js';
import { repositorySchemas, parseDomain, flattenTree, parseDdicDefinition } from '../src/repository-query.js';
import { toolSchemas } from '../src/tool-definitions.js';
import { safeError } from '../src/errors.js';

const object = '/sap/bc/adt/oo/classes/ztest';
const sourceUri = `${object}/source/main`;
const code = 'CLASS ztest DEFINITION.\r\nENDCLASS.';
const domainXml = `<doma:domain xmlns:doma="http://www.sap.com/adt/ddic/domains" xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="ZSTATUS" adtcore:description="Status" adtcore:language="EN">
<doma:content><doma:typeInformation><doma:datatype>CHAR</doma:datatype><doma:length>3</doma:length></doma:typeInformation>
<doma:valueInformation><doma:valueTableRef adtcore:name="ZT_STATUS"/><doma:fixValues>
<doma:fixValue><doma:low>001</doma:low><doma:high>009</doma:high><doma:text>Range</doma:text></doma:fixValue>
<doma:fixValue><doma:low>123456789012345678.90</doma:low><doma:text>Exact</doma:text></doma:fixValue>
</doma:fixValues></doma:valueInformation></doma:content></doma:domain>`;

async function fixture(status = 200, ddlBody?: string, genericBody?: string, genericStatus = status) {
  const calls: { url: URL; method?: string; body: string; session?: string }[] = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const url = new URL(req.url!, 'http://local');
    res.setHeader('Content-Type', 'application/xml');
    if (url.pathname.endsWith('/compatibility/graph')) {
      res.setHeader('x-csrf-token', 'mock'); res.end('<graph/>'); return;
    }
    if (url.pathname.endsWith('/icf/logoff')) { res.end(''); return; }
    calls.push({ url, method: req.method, body, session: req.headers['x-sap-adt-sessiontype'] as string });
    res.statusCode = status;
    if (status !== 200 && url.pathname !== '/sap/bc/adt/ddic/elementinfo') { res.end('<error/>'); return; }
    switch (url.pathname) {
      case '/sap/bc/adt/ddic/elementinfo':
        res.statusCode = genericBody === undefined ? (genericStatus === 200 ? 404 : genericStatus) : genericStatus;
        res.end(genericBody ?? '<error/>'); break;
      case '/sap/bc/adt/ddic/ddl/elementinfo':
        if (ddlBody !== undefined) { res.end(ddlBody); break; }
        res.end(`<abapsource:elementInfo xmlns:abapsource="http://www.sap.com/adt/abapsource" xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="EKKO" adtcore:type="TABL/DT">
        <abapsource:elementInfo adtcore:name="MANDT" adtcore:type="TABL/DF"/>
        <abapsource:elementInfo adtcore:name="EBELN" adtcore:type="TABL/DF"><abapsource:properties>
        <abapsource:entry abapsource:key="ddicDataType">CHAR</abapsource:entry>
        <abapsource:entry abapsource:key="ddicLength">10</abapsource:entry>
        <abapsource:entry abapsource:key="ddicDataElement">EBELN</abapsource:entry>
        <abapsource:entry abapsource:key="ddicLabelLong">Purchasing Document</abapsource:entry>
        </abapsource:properties></abapsource:elementInfo></abapsource:elementInfo>`); break;
      case '/sap/bc/adt/ddic/domains/zstatus': res.end(domainXml); break;
      case '/sap/bc/adt/ddic/dataelements/zstatus':
        res.end(`<dtel:dataElementDefinition xmlns:dtel="http://www.sap.com/adt/ddic/dataelements" xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="ZSTATUS">
        <dtel:dataElement><dtel:typeName>ZSTATUS</dtel:typeName><dtel:dataType>CHAR</dtel:dataType><dtel:dataTypeLength>3</dtel:dataTypeLength><dtel:shortFieldLabel>Status</dtel:shortFieldLabel></dtel:dataElement></dtel:dataElementDefinition>`); break;
      case '/sap/bc/adt/repository/informationsystem/usageReferences':
        res.end(`<usageReferences:usageReferenceResult xmlns:usageReferences="http://www.sap.com/adt/ris/usageReferences" xmlns:adtcore="http://www.sap.com/adt/core"><usageReferences:referencedObjects>
        <usageReferences:referencedObject uri="${sourceUri}#start=2,1" canHaveChildren="true"><objectIdentifier>ID_A</objectIdentifier><usageReferences:adtObject adtcore:name="ZTEST" adtcore:type="CLAS/OC"/></usageReferences:referencedObject>
        <usageReferences:referencedObject uri="${sourceUri}#start=3,1"><objectIdentifier>ID_B</objectIdentifier><usageReferences:adtObject adtcore:name="ZSECOND" adtcore:type="CLAS/OC"/></usageReferences:referencedObject>
        </usageReferences:referencedObjects></usageReferences:usageReferenceResult>`); break;
      case '/sap/bc/adt/repository/informationsystem/usageSnippets':
        res.end(`<usageReferences:usageSnippetResult xmlns:usageReferences="http://www.sap.com/adt/ris/usageReferences"><usageReferences:codeSnippetObjects>
        <usageReferences:codeSnippetObject><objectIdentifier>ID_A</objectIdentifier><usageReferences:codeSnippets><usageReferences:codeSnippet uri="${sourceUri}#start=1,6;end=1,11" matches="6-11,gradeDirect"><content>CALL METHOD test.</content><description>First caller</description></usageReferences:codeSnippet></usageReferences:codeSnippets></usageReferences:codeSnippetObject>
        <usageReferences:codeSnippetObject><objectIdentifier>ID_B</objectIdentifier><usageReferences:codeSnippets><usageReferences:codeSnippet uri="${sourceUri}#start=2,0;end=2,4" matches="0-4,gradeDirect"><content>test</content><description>Second caller</description></usageReferences:codeSnippet></usageReferences:codeSnippets></usageReferences:codeSnippetObject>
        </usageReferences:codeSnippetObjects></usageReferences:usageSnippetResult>`); break;
      case '/sap/bc/adt/navigation/target':
        res.end(`<adtcore:objectReference xmlns:adtcore="http://www.sap.com/adt/core" adtcore:uri="${sourceUri}#start=1,7"/>`); break;
      case `${object}/objectstructure`:
      case '/sap/bc/adt/oo/interfaces/zif_test/objectstructure':
        res.end(`<abapsource:objectStructureElement xmlns:abapsource="http://www.sap.com/adt/abapsource" xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="ZTEST" adtcore:type="CLAS/OC">
        <abapsource:objectStructureElement adtcore:name="RUN" adtcore:type="CLAS/OM" visibility="public" level="static">
        <abapsource:objectStructureElement adtcore:name="IV_VALUE" adtcore:type="CLAS/OP"/></abapsource:objectStructureElement>
        </abapsource:objectStructureElement>`); break;
      case '/sap/bc/adt/abapsource/typehierarchy':
        res.end(`<hierarchy:info xmlns:hierarchy="http://www.sap.com/adt/abapsource/typehierarchy" xmlns:adtcore="http://www.sap.com/adt/core"><entries><entry adtcore:uri="${sourceUri}#start=1,7" adtcore:name="ZTEST" adtcore:type="CLAS/OC"/></entries></hierarchy:info>`); break;
      default: res.statusCode = 404; res.end('<error/>');
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const connection = connectionSchema.parse({ connection_id: randomUUID(), name: 'fixture',
    base_url: `http://127.0.0.1:${address.port}`, username: 'TEST', client: '810', language: 'EN', write_enabled: false });
  const backend = new AdtBackend(connection, 'fake');
  const reads: string[] = [];
  backend.read = async (uri, version) => {
    reads.push(uri); assert.equal(version, 'active');
    return sourceResult(connection.connection_id, uri, sourceUri, code, version);
  };
  return { backend, calls, reads, close: async () => {
    try { await backend.close(); } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  } };
}

test('repository schemas reject incomplete positions, unsafe names, inverted ranges and excessive limits', () => {
  assert.throws(() => repositorySchemas.find_references.parse({ object_uri: object, line: 1 }));
  assert.throws(() => repositorySchemas.find_definition.parse({ object_uri: object, line: 1, column: 7, end_column: 6 }));
  assert.throws(() => repositorySchemas.get_type_hierarchy.parse({ object_uri: object, line: 1, column: 0 }));
  for (const entity_name of ['EKKO?x', '../EKKO', 'EKKO;DELETE', 'A/B'])
    assert.throws(() => repositorySchemas.get_ddic_definition.parse({ entity_name }));
  assert.equal(repositorySchemas.get_ddic_definition.parse({ entity_name: '/ABC/TABLE' }).limit, 100);
  assert.throws(() => repositorySchemas.get_class_structure.parse({ object_uri: object, limit: 501 }));
  // MCP's connection extension must preserve cross-field refinements.
  assert.throws(() => toolSchemas.find_references.parse({ connection_id: randomUUID(), object_uri: object, column: 1 }));
});

test('domain metadata preserves zeros, ranges and decimal precision, and rejects HTML/entities', () => {
  const values = parseDomain(domainXml, 500);
  assert.deepEqual(values.items[0], { low: '001', high: '009', text: 'Range' });
  assert.equal(values.items[1].low, '123456789012345678.90');
  assert.equal(values.value_table_name, 'ZT_STATUS');
  assert.equal(parseDomain(domainXml, 1).truncated, true);
  assert.throws(() => parseDomain('<html>login</html>', 5), /Expected SAP domain/);
  assert.throws(() => parseDomain('<!DOCTYPE x [<!ENTITY a "x">]><domain/>', 5), /Invalid domain/);
});

test('flattening limits total descendants and preserves parent indexes', () => {
  type Node = { name: string; children: Node[] };
  const root: Node = { name: 'root', children: [{ name: 'parent', children: [{ name: 'leaf', children: [] }] }, { name: 'sibling', children: [] }] };
  const result = flattenTree(root, n => n.children, 3);
  assert.deepEqual(result.items.map(x => [x.node.name, x.parent_index]), [['root', null], ['parent', 0], ['leaf', 1]]);
  assert.equal(result.truncated, true);
  assert.equal(flattenTree(root, n => n.children, 4).truncated, false);
});

test('DDIC, data element, domain and OO queries use stateless read-only HTTP and bound nested members', async () => {
  const f = await fixture();
  try {
    const ddic: any = await f.backend.inspectRepository('get_ddic_definition', { entity_name: 'ekko', field_name: 'ebeln' });
    assert.equal(ddic.items[1].properties.elementProps.ddicDataElement, 'EBELN');
    assert.equal(ddic.items[1].properties.elementProps.ddicLength, 10);
    assert.equal(ddic.returned_count, 2);
    assert.equal(ddic.truncated, false);
    const request = f.calls[0];
    assert.deepEqual(request.url.searchParams.getAll('path'), ['EKKO']);
    assert.equal(request.url.searchParams.get('getExtensionViews'), 'false');
    const dtel: any = await f.backend.inspectRepository('get_data_element', { data_element_uri: '/sap/bc/adt/ddic/dataelements/zstatus' });
    assert.equal(dtel.properties.typeName, 'ZSTATUS');
    const domain: any = await f.backend.inspectRepository('get_domain_values', { domain_uri: '/sap/bc/adt/ddic/domains/zstatus', limit: 1 });
    assert.equal(domain.items[0].low, '001'); assert.equal(domain.truncated, true);
    const members: any = await f.backend.inspectRepository('get_class_structure', { object_uri: object, limit: 2 });
    assert.equal(members.items[1].name, 'RUN'); assert.equal(members.items[1].visibility, 'public');
    assert.equal(members.truncated, true);
    await f.backend.inspectRepository('get_class_structure', { object_uri: '/sap/bc/adt/oo/interfaces/zif_test' });
    assert.ok(f.calls.every(c => c.method === 'GET' && c.session === 'stateless'));
    assert.equal(f.calls[2].url.searchParams.get('version'), 'active');
  } finally { await f.close(); }
});

test('references, definitions and hierarchy preserve source context, positions and coverage limits', async () => {
  const f = await fixture();
  try {
    const wide: any = await f.backend.inspectRepository('find_references', { object_uri: object, limit: 1 });
    assert.equal(wide.truncated, true); assert.equal(wide.items[0].line, 1);
    assert.equal(wide.items[0].column, 7); assert.equal(wide.reference_count, 1); assert.equal(f.reads.length, 0);
    assert.equal(f.calls[0].url.searchParams.get('uri'), object);
    const refs: any = await f.backend.inspectRepository('find_references', { object_uri: object, line: 1, column: 1 });
    assert.equal(refs.source_context.source_uri, sourceUri);
    assert.equal(f.calls.filter(c => c.url.pathname.endsWith('/usageReferences'))[1].url.searchParams.get('uri'), `${sourceUri}#start=1,0`);
    const target: any = await f.backend.inspectRepository('find_definition', { object_uri: object, line: 1, column: 7, end_column: 11, implementation: true });
    assert.equal(target.target.line, 1); assert.equal(target.target.column, 8);
    assert.equal(f.calls.find(c => c.url.pathname.endsWith('/navigation/target'))!.url.searchParams.get('filter'), 'implementation');
    assert.equal(f.calls.find(c => c.url.pathname.endsWith('/navigation/target'))!.url.searchParams.get('uri'), `${sourceUri}#start=1,6;end=1,11`);
    assert.equal(f.calls.find(c => c.url.pathname.endsWith('/navigation/target'))!.body, code);
    for (const direction of ['super', 'sub'] as const) {
      const result: any = await f.backend.inspectRepository('get_type_hierarchy', { object_uri: object, line: 1, column: 7, direction });
      assert.equal(result.items[0].name, 'ZTEST');
      assert.equal(result.items[0].column, 8);
      assert.equal(f.calls.at(-1)!.url.searchParams.get('uri'), `${sourceUri}#start=1,6`);
      assert.equal(f.calls.at(-1)!.url.searchParams.get('type'), direction === 'super' ? 'superTypes' : 'subTypes');
    }
    const beforeInvalid = f.calls.length;
    assert.equal(beforeInvalid, 7);
    await assert.rejects(f.backend.inspectRepository('find_definition', { object_uri: object, line: 9, column: 1 }), /Position/);
    await assert.rejects(f.backend.inspectRepository('find_references', { object_uri: object, line: 1, column: 999 }), /Position/);
    assert.equal(f.calls.length, beforeInvalid, 'invalid positions send no analysis request');
    assert.ok(f.calls.every(c => c.method === 'POST' && c.session === 'stateless'));
  } finally { await f.close(); }
});

test('unsafe or mismatched URIs are rejected before backend traffic', async () => {
  const f = await fixture();
  try {
    for (const value of ['https://evil.test/a', '/sap/bc/adt/ddic/domains/../bad', '/sap/bc/adt/ddic/domains/z?x=1', object])
      await assert.rejects(f.backend.inspectRepository('get_domain_values', { domain_uri: value }));
    await assert.rejects(f.backend.inspectRepository('get_class_structure', { object_uri: '/sap/bc/adt/programs/programs/ztest' }));
    assert.equal(f.calls.length, 0);
    assert.equal(f.reads.length, 0);
    assert.throws(() => adtUri('/sap/bc/adt/%2e%2e/anything'));
  } finally { await f.close(); }
});

for (const status of [403, 404]) {
  test(`repository HTTP ${status} retains authorization/not-found distinction`, async () => {
    const f = await fixture(status);
    try {
      await assert.rejects(f.backend.inspectRepository('get_ddic_definition', { entity_name: 'EKKO' }), error => {
        assert.equal(safeError(error).code, status === 403 ? 'HTTP_FORBIDDEN' : 'OBJECT_NOT_FOUND'); return true;
      });
    } finally { await f.close(); }
  });
}

const emptyElementInfo = '<abapsource:elementInfo xmlns:abapsource="http://www.sap.com/adt/abapsource"><abapsource:properties/></abapsource:elementInfo>';
const structureElementInfo = `<s:elementInfo xmlns:s="http://www.sap.com/adt/abapsource" xmlns:c="http://www.sap.com/adt/core" c:name="zstructure" c:type="TABL/DS">
<s:properties/>
<s:elementInfo c:name=".include" c:type="TABL/DS"><s:properties><s:entry s:key="ddicIncludeName">ZBASE</s:entry></s:properties></s:elementInfo>
<s:elementInfo c:name="FIELD" c:type="TABL/DTF"><s:properties>
<s:entry s:key="ddicIsKey">false</s:entry><s:entry s:key="ddicDataElement">ZFIELD</s:entry>
<s:entry s:key="ddicDataType">char</s:entry><s:entry s:key="ddicLength">000010</s:entry>
<s:entry s:key="ddicIsPartOfInclude">ZBASE</s:entry><s:entry s:key="ddicIncludeHierarchyLevel">1</s:entry>
</s:properties><s:documentation rel="shorttext" type="text/plain">Field label</s:documentation></s:elementInfo>
<s:elementInfo c:name="CHILD_TABLE" c:type="TABL/DTF"><s:properties><s:entry s:key="ddicDataType">ttyp</s:entry><s:entry s:key="ddicDataElement">ZCHILD_T</s:entry></s:properties></s:elementInfo>
</s:elementInfo>`;

test('structures use generic DDIC metadata when the DDL endpoint returns an empty elementInfo', async () => {
  const f = await fixture(200, emptyElementInfo, structureElementInfo);
  try {
    const result: any = await f.backend.inspectRepository('get_ddic_definition', { entity_name: 'ZSTRUCTURE' });
    assert.equal(result.items[0].type, 'TABL/DS');
    assert.equal(result.items[1].name, '.include');
    assert.equal(result.items[1].properties.elementProps.ddicIncludeName, 'ZBASE');
    const field = result.items[2].properties.elementProps;
    assert.equal(field.ddicIsKey, false);
    assert.equal(field.ddicLength, 10);
    assert.equal(field.ddicIsPartOfInclude, 'ZBASE');
    assert.equal(field.ddicLabelLong, 'Field label');
    assert.equal(result.items[3].properties.elementProps.ddicDataType, 'ttyp');
    assert.equal(result.items[3].properties.elementProps.ddicDataElement, 'ZCHILD_T');
    assert.equal(result.truncated, false);
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[1].url.pathname, '/sap/bc/adt/ddic/elementinfo');
    assert.equal(f.calls[1].url.searchParams.get('path'), 'ZSTRUCTURE');
    assert.ok(f.calls.every(call => call.method === 'GET' && call.session === 'stateless'));
  } finally { await f.close(); }
});

test('generic DDIC fallback retains field filtering, bounded results and missing-field errors', async () => {
  const f = await fixture(200, emptyElementInfo, structureElementInfo);
  try {
    const filtered: any = await f.backend.inspectRepository('get_ddic_definition',
      { entity_name: 'ZSTRUCTURE', field_name: 'field' });
    assert.equal(filtered.returned_count, 2);
    assert.equal(filtered.items[1].name, 'FIELD');
    const bounded: any = await f.backend.inspectRepository('get_ddic_definition',
      { entity_name: 'ZSTRUCTURE', limit: 2 });
    assert.equal(bounded.returned_count, 2);
    assert.equal(bounded.truncated, true);
    assert.equal(bounded.items[1].parent_index, 0);
    await assert.rejects(f.backend.inspectRepository('get_ddic_definition',
      { entity_name: 'ZSTRUCTURE', field_name: 'ABSENT' }), error => safeError(error).code === 'DDIC_FIELD_NOT_FOUND');
  } finally { await f.close(); }
});

for (const status of [404, 405, 500, 501]) {
  test('generic DDIC fallback recovers DDL HTTP ' + status, async () => {
    const f = await fixture(status, undefined, structureElementInfo, 200);
    try {
      const result: any = await f.backend.inspectRepository('get_ddic_definition', { entity_name: 'ZSTRUCTURE' });
      assert.equal(result.items[0].type, 'TABL/DS');
      assert.equal(f.calls.length, 2);
    } finally { await f.close(); }
  });
}

for (const status of [401, 403]) {
  test('DDIC authorization error ' + status + ' never triggers endpoint fallback', async () => {
    const f = await fixture(status, undefined, structureElementInfo, 200);
    try {
      await assert.rejects(f.backend.inspectRepository('get_ddic_definition', { entity_name: 'ZSTRUCTURE' }),
        error => safeError(error).code === (status === 401 ? 'AUTH_FAILED' : 'HTTP_FORBIDDEN'));
      assert.equal(f.calls.length, 1);
    } finally { await f.close(); }
  });
}

test('generic DDIC parser validates identity, metadata and XML entities', () => {
  assert.throws(() => parseDdicDefinition(structureElementInfo, 'WRONG'), /does not match/);
  assert.throws(() => parseDdicDefinition(emptyElementInfo, 'ZSTRUCTURE'), /named DDIC/);
  assert.throws(() => parseDdicDefinition('<!DOCTYPE x><elementInfo/>', 'X'), /Invalid DDIC/);
  assert.throws(() => parseDdicDefinition(structureElementInfo.replace('s:key="ddicIncludeName"', 's:key="__proto__"'), 'ZSTRUCTURE'), /property key/);
  const ordinary = structureElementInfo.replace(/<s:elementInfo c:name=".include"[\s\S]*?<\/s:elementInfo>/, '');
  assert.equal(parseDdicDefinition(ordinary, 'ZSTRUCTURE').children.length, 2);
});
