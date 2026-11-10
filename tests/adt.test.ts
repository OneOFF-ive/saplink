import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { AdtBackend, programUri } from '../src/adt.js';
import { connectionSchema } from '../src/config.js';
import { safeError } from '../src/errors.js';
import { XMLParser } from 'fast-xml-parser';
import type { ProgramKind } from '../src/adt.js';
import { ddicTypes, type DdicKind } from '../src/ddic-definition.js';

for (const kind of ['structure','table'] as DdicKind[]) {
  test(`ADT creates a DDIC ${kind} and writes its inactive source on the returned object`,async()=>{
    const {collection,type}=ddicTypes[kind], object='/sap/bc/adt/ddic/structures/zcreated';
    const ddl=`define ${kind} zcreated { field : abap.int4; }`;
    let code='', created=false, locked=false, dispatched=false;
    let creation:Record<string,unknown>|undefined;
    const server=createServer(async(req,res)=>{
      const url=new URL(req.url!,'http://local');let body='';
      for await(const chunk of req)body+=chunk;
      res.setHeader('Content-Type','application/xml');
      if(url.pathname.endsWith('/compatibility/graph')){res.setHeader('x-csrf-token','test');res.end('<graph/>');}
      else if(url.pathname===collection+'/validation'){
        assert.equal(url.searchParams.get('objtype'),type);
        res.end('<asx:abap xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA><SEVERITY>SUCCESS</SEVERITY><CHECK_RESULT>X</CHECK_RESULT></DATA></asx:values></asx:abap>');
      }else if(url.pathname===collection&&req.method==='POST'){
        assert.equal(dispatched,true);
        creation=new XMLParser({ignoreAttributes:false}).parse(body)['blue:blueSource'];
        created=true;res.statusCode=201;res.setHeader('Location',object);res.end();
      }else if(url.pathname===object&&url.searchParams.get('_action')==='LOCK'){
        locked=true;res.end('<asx:abap xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA><LOCK_HANDLE>handle</LOCK_HANDLE></DATA></asx:values></asx:abap>');
      }else if(url.pathname===object&&url.searchParams.get('_action')==='UNLOCK'){
        locked=false;res.end();
      }else if(url.pathname===object&&created){
        res.end(`<blue:blueSource xmlns:blue="http://www.sap.com/wbobj/blue" xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="ZCREATED" adtcore:type="${type}" adtcore:version="new"/>`);
      }else if(url.pathname===object+'/source/main'&&req.method==='PUT'){
        assert.equal(locked,true);code=body;res.statusCode=204;res.end();
      }else if(url.pathname===object+'/source/main'){res.setHeader('Content-Type','text/plain');res.end(code);}
      else if(url.pathname==='/sap/public/bc/icf/logoff')res.end();
      else{res.statusCode=404;res.end();}
    });
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const address=server.address();assert.ok(address&&typeof address!=='string');
    const backend=new AdtBackend(connectionSchema.parse({connection_id:randomUUID(),name:'mock',
      base_url:`http://127.0.0.1:${address.port}`,client:'001',language:'EN',username:'TEST'}),'fake');
    try{
      const uri=await backend.createDdic(kind,'ZCREATED','Fields & data','$TMP',undefined,()=>{dispatched=true;});
      assert.equal(uri,object);
      assert.equal(creation?.['@_adtcore:type'],type);
      assert.equal(creation?.['@_adtcore:description'],'Fields & data');
      const handle=await backend.lock(uri), source=await backend.read(uri,'inactive');
      await backend.save(source.source_uri,ddl,handle);
      await backend.unlock(uri,handle);
      assert.equal((await backend.read(uri,'inactive')).source,ddl);
      await assert.rejects(backend.read(uri,'active'),{code:'VERSION_UNAVAILABLE'});
    }finally{try{await backend.close();}finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}}
  });
}

for (const kind of ['report', 'include', 'module_pool', 'subroutine_pool'] as ProgramKind[]) {
  test(`create ${kind} sends escaped XML, transport and verifies metadata`, async () => {
    const include = kind === 'include'; const collection = include ? 'includes' : 'programs';
    const type = include ? 'PROG/I' : 'PROG/P'; const prefix = include ? 'include' : 'program';
    const programType = { report: 'executableProgram', module_pool: 'modulePool', subroutine_pool: 'subroutinePool', include: '' }[kind];
    const object = `/sap/bc/adt/programs/${collection}/zcreated`;
    let creation: Record<string, string> | undefined; let validationType: string | null = null; let task: string | null = null;
    const server = createServer(async (req, res) => {
      const url = new URL(req.url!, 'http://local'); let body = ''; for await (const chunk of req) body += chunk;
      res.setHeader('Content-Type', 'application/xml');
      if (url.pathname.endsWith('/compatibility/graph')) { res.setHeader('x-csrf-token', 'test'); res.end('<graph/>'); }
      else if (url.pathname.endsWith('/validation')) {
        validationType = url.searchParams.get('objtype');
        res.end('<asx:abap xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA><SEVERITY>SUCCESS</SEVERITY><CHECK_RESULT>X</CHECK_RESULT></DATA></asx:values></asx:abap>');
      } else if (url.pathname === `/sap/bc/adt/programs/${collection}` && req.method === 'POST') {
        creation = new XMLParser({ ignoreAttributes: false }).parse(body)[`${prefix}:${include ? 'abapInclude' : 'abapProgram'}`];
        task = url.searchParams.get('corrNr'); res.statusCode = 201; res.end();
      } else if (url.pathname === object) res.end(`<${prefix}:${include ? 'abapInclude' : 'abapProgram'} xmlns:${prefix}="http://www.sap.com/adt/programs/${collection}" xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="ZCREATED" adtcore:type="${type}" adtcore:version="inactive" ${include ? '' : `program:programType="${programType}"`}/>`);
      else { res.end(''); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const backend = new AdtBackend(connectionSchema.parse({ connection_id: randomUUID(), name: 'mock', base_url: `http://127.0.0.1:${address.port}`, client: '001', language: 'EN', username: 'TEST' }), 'fake');
    try {
      assert.equal(await backend.create('ZCREATED', 'A & "B" <C>', 'ZPACKAGE', 'DEVK900001', kind), object);
      assert.equal(validationType, type); assert.equal(task, 'DEVK900001');
      assert.ok(creation); assert.equal(creation['@_adtcore:type'], type);
      assert.equal(creation['@_adtcore:description'], 'A & "B" <C>');
      assert.equal(creation['@_program:programType'], include ? undefined : programType);
    } finally { await backend.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
}

test('writable URIs accept Program and Include main sources but reject other objects', () => {
  for (const kind of ['programs', 'includes']) {
    const uri = `/sap/bc/adt/programs/${kind}/ztest`;
    assert.equal(programUri(uri), uri); assert.equal(programUri(`${uri}/source/main`), uri);
  }
  for (const uri of ['/sap/bc/adt/oo/classes/ztest', '/sap/bc/adt/programs/includes/ztest/source/other',
    '/sap/bc/adt/programs/includes/../ztest']) assert.throws(() => programUri(uri));
});

for (const [kind, type, programType] of [['includes', 'PROG/I', 'include'], ['programs', 'PROG/P', 'modulePool'], ['programs', 'PROG/P', 'subroutinePool']]) {
  test(`ADT ${type} ${programType} supports package lookup, locking, save and activation`, async () => {
    const object = `/sap/bc/adt/programs/${kind}/ztest`;
    let code = '* test source'; let saved = '';
    const server = createServer(async (req, res) => {
      const url = new URL(req.url!, 'http://local'); let body = ''; for await (const chunk of req) body += chunk;
      res.setHeader('Content-Type', 'application/xml');
      if (url.pathname.endsWith('/compatibility/graph')) { res.setHeader('x-csrf-token', 'test'); res.end('<graph/>'); }
      else if (url.pathname.endsWith('/nodepath')) res.end(`<projectexplorer:nodepath xmlns:projectexplorer="test" xmlns:adtcore="http://www.sap.com/adt/core"><projectexplorer:objectLinkReferences><objectLinkReference adtcore:name="$TMP" adtcore:type="DEVC/K" adtcore:uri="/sap/bc/adt/packages/%24tmp"/></projectexplorer:objectLinkReferences></projectexplorer:nodepath>`);
      else if (url.pathname === object && url.searchParams.get('_action') === 'LOCK') res.end('<asx:abap xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA><LOCK_HANDLE>handle</LOCK_HANDLE></DATA></asx:values></asx:abap>');
      else if (url.pathname === object && url.searchParams.get('_action') === 'UNLOCK') res.end('');
      else if (url.pathname === object) res.end(`<program:abapProgram xmlns:program="http://www.sap.com/adt/programs/programs" xmlns:adtcore="http://www.sap.com/adt/core" xmlns:abapsource="http://www.sap.com/adt/abapsource" adtcore:name="ZTEST" adtcore:type="${type}" adtcore:version="${url.searchParams.get('version') ?? 'active'}" program:programType="${programType}" abapsource:sourceUri="source/main"/>`);
      else if (url.pathname === `${object}/source/main` && req.method === 'PUT') { saved = body; res.statusCode = 204; res.end(); }
      else if (url.pathname === `${object}/source/main`) { res.setHeader('Content-Type', 'text/plain'); res.end(url.searchParams.get('version') === 'inactive' ? saved : code); }
      else if (url.pathname.endsWith('/activation')) { assert.ok(body.includes(object)); code = saved; res.statusCode = 204; res.end(); }
      else res.end('');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const backend = new AdtBackend(connectionSchema.parse({ connection_id: randomUUID(), name: 'mock', base_url: `http://127.0.0.1:${address.port}`, client: '001', language: 'EN', username: 'TEST' }), 'fake');
    try {
      assert.equal(await backend.packageOf(object), '$TMP');
      const original = await backend.read(object, 'active'); assert.equal(original.source_uri, `${object}/source/main`);
      const handle = await backend.lock(object); await backend.save(original.source_uri, '* changed source', handle);
      assert.equal((await backend.read(object, 'inactive')).source, '* changed source');
      await backend.unlock(object, handle); assert.equal((await backend.activate(object)).success, true);
      assert.equal((await backend.read(object, 'active')).source, '* changed source');
    } finally { await backend.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
}

test('403 classification distinguishes an editor lock from CSRF and unknown rejection', () => {
  assert.equal(safeError({ status: 403, message: '使用者 TEST 当前编辑 ZTEST005' }).code, 'OBJECT_LOCKED');
  assert.equal(safeError({ status: 403, message: 'CSRF token validation failed' }).code, 'CSRF_FAILED');
  assert.equal(safeError({ status: 403, message: 'Forbidden' }).code, 'HTTP_FORBIDDEN');
});

test('search filters exact subtypes before limiting; package results exclude URI-less categories', async () => {
  const rows = [
    { name: 'ZINCLUDE', type: 'PROG/I', uri: '/sap/bc/adt/programs/includes/zinclude' },
    { name: 'ZREPORT1', type: 'PROG/P', uri: '/sap/bc/adt/programs/programs/zreport1' },
    { name: 'ZREPORT2', type: 'PROG/P', uri: '/sap/bc/adt/programs/programs/zreport2' }
  ];
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://local');
    res.setHeader('Content-Type', 'application/xml');
    if (url.pathname.endsWith('/compatibility/graph')) {
      res.setHeader('x-csrf-token', 'test'); res.end('<graph/>');
    } else if (url.pathname.endsWith('/search')) {
      const selected = url.searchParams.get('query') === 'SATURATED' ? Array.from({ length: Number(url.searchParams.get('maxResults')) }, () => rows[0]) : rows;
      res.end(`<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">${selected.map(r =>
        `<adtcore:objectReference adtcore:name="${r.name}" adtcore:type="${r.type}" adtcore:uri="${r.uri}"/>`).join('')}</adtcore:objectReferences>`);
    } else if (url.pathname.endsWith('/nodestructure')) {
      res.end(`<asx:abap xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA><TREE_CONTENT>
        <SEU_ADT_REPOSITORY_OBJ_NODE><OBJECT_TYPE>DEVC/P</OBJECT_TYPE><OBJECT_NAME/><OBJECT_URI/></SEU_ADT_REPOSITORY_OBJ_NODE>
        <SEU_ADT_REPOSITORY_OBJ_NODE><OBJECT_TYPE>DEVC/I</OBJECT_TYPE><OBJECT_NAME/><OBJECT_URI> </OBJECT_URI></SEU_ADT_REPOSITORY_OBJ_NODE>
        ${rows.slice(1).map(r => `<SEU_ADT_REPOSITORY_OBJ_NODE><OBJECT_TYPE>${r.type}</OBJECT_TYPE><OBJECT_NAME>${r.name}</OBJECT_NAME><OBJECT_URI>${r.uri}</OBJECT_URI></SEU_ADT_REPOSITORY_OBJ_NODE>`).join('')}
        </TREE_CONTENT></DATA></asx:values></asx:abap>`);
    } else { res.end(''); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const backend = new AdtBackend(connectionSchema.parse({ connection_id: randomUUID(), name: 'mock',
    base_url: `http://127.0.0.1:${address.port}`, client: '001', language: 'EN', username: 'TEST' }), 'fake');
  try {
    const exact = await backend.search('Z*', 'prog/p', 1);
    assert.deepEqual(exact.objects.map(o => o.name), ['ZREPORT1']); assert.equal(exact.truncated, true);
    const all = await backend.search('Z*', 'PROG/P', 3);
    assert.deepEqual(all.objects.map(o => o.type), ['PROG/P', 'PROG/P']); assert.equal(all.truncated, false);
    assert.equal((await backend.search('Z*', 'PROG', 3)).objects.length, 3);
    assert.equal((await backend.search('Z*', undefined, 3)).objects.length, 3);
    const saturated = await backend.search('SATURATED', 'PROG/P', 3);
    assert.equal(saturated.objects.length, 0); assert.equal(saturated.truncated, true);
    const small = await backend.listPackage('$TMP', 1);
    assert.equal(small.objects[0].OBJECT_NAME, 'ZREPORT1'); assert.equal(small.truncated, true);
    const complete = await backend.listPackage('$TMP', 2);
    assert.equal(complete.objects.length, 2); assert.equal(complete.truncated, false);
    assert.ok(complete.objects.every(o => o.OBJECT_URI));
  } finally { await backend.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('real ADT adapter carries Client, language, cookies and CSRF through read/save/check/activate', async () => {
  const object = '/sap/bc/adt/programs/programs/ztest';
  const source = `${object}/source/main`;
  let active = 'REPORT ztest.';
  let inactive = active;
  const requests: { path: string; method: string; body: string; csrf?: string; cookie?: string }[] = [];
  const assertions: (() => void)[] = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://local');
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ path: url.pathname, method: req.method!, body, csrf: req.headers['x-csrf-token'] as string, cookie: req.headers.cookie });
    res.setHeader('Content-Type', 'application/xml');
    if (url.pathname.endsWith('/compatibility/graph')) {
      assertions.push(() => {
        assert.equal(url.searchParams.get('sap-client'), '001');
        assert.equal(url.searchParams.get('sap-language'), 'EN');
        assert.equal(req.headers.authorization, 'Basic ' + Buffer.from('TEST:fake').toString('base64'));
      });
      res.setHeader('x-csrf-token', 'csrf-test'); res.setHeader('Set-Cookie', 'SAP_SESSIONID_TEST=test; Path=/');
      res.end('<compatibility:graph xmlns:compatibility="test"/>');
    } else if (url.pathname.endsWith('/discovery')) {
      res.end('<app:service xmlns:app="http://www.w3.org/2007/app" xmlns:atom="http://www.w3.org/2005/Atom"><app:workspace><atom:title>Programs</atom:title><app:collection href="/sap/bc/adt/programs/programs"><atom:title>Programs</atom:title></app:collection></app:workspace></app:service>');
    } else if (url.pathname === object && url.searchParams.get('_action') === 'LOCK') {
      res.end('<asx:abap xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA><LOCK_HANDLE>lock-test</LOCK_HANDLE></DATA></asx:values></asx:abap>');
    } else if (url.pathname === object && url.searchParams.get('_action') === 'UNLOCK') {
      res.end('');
    } else if (url.pathname === object) {
      const version = url.searchParams.get('version') ?? 'active';
      res.end(`<program:abapProgram xmlns:program="http://www.sap.com/adt/programs/programs" xmlns:adtcore="http://www.sap.com/adt/core" xmlns:abapsource="http://www.sap.com/adt/abapsource" xmlns:atom="http://www.w3.org/2005/Atom" adtcore:name="ZTEST" adtcore:type="PROG/P" adtcore:version="${version}" program:programType="executableProgram" abapsource:sourceUri="source/main"><atom:link href="source/main" type="text/plain"/></program:abapProgram>`);
    } else if (url.pathname === source && req.method === 'PUT') {
      assertions.push(() => assert.equal(url.searchParams.get('lockHandle'), 'lock-test'));
      inactive = body; res.statusCode = 204; res.end();
    } else if (url.pathname === source) {
      res.setHeader('Content-Type', 'text/plain'); res.end(url.searchParams.get('version') === 'inactive' ? inactive : active);
    } else if (url.pathname.endsWith('/checkruns')) {
      res.end('<chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun"/>');
    } else if (url.pathname.endsWith('/activation')) {
      active = inactive; res.statusCode = 204; res.end();
    } else if (url.pathname.endsWith('/logoff')) { res.end(''); }
    else { res.statusCode = 404; res.end('Missing'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const connection = connectionSchema.parse({ connection_id: randomUUID(), name: 'mock', base_url: `http://127.0.0.1:${address.port}`,
    client: '001', language: 'EN', username: 'TEST' });
  const backend = new AdtBackend(connection, 'fake');
  try {
    assert.ok(await backend.capabilities());
    assert.equal((await backend.read(object, 'active')).source, active);
    const handle = await backend.lock(object); assert.equal(handle, 'lock-test');
    await backend.save(source, 'REPORT ztest. WRITE 1.', handle);
    assert.equal((await backend.read(object, 'inactive')).source, inactive);
    assert.equal((await backend.check(object, 'inactive') as { passed: boolean }).passed, true);
    assert.equal((await backend.activate(object)).success, true);
    await backend.unlock(object, handle);
    assert.equal((await backend.read(object, 'active')).source, 'REPORT ztest. WRITE 1.');
    for (const request of requests.filter(r => r.path !== '/sap/bc/adt/compatibility/graph')) {
      assert.equal(request.csrf, 'csrf-test'); assert.ok(request.cookie?.includes('SAP_SESSIONID_TEST=test'));
    }
    for (const assertion of assertions) assertion();
  } finally { await backend.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('ADT adapter does not follow redirects or leak credentials to redirect targets', async () => {
  let targetHits = 0;
  const target = createServer((_req, res) => { targetHits++; res.end('unexpected'); });
  await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
  const targetAddress = target.address(); assert.ok(targetAddress && typeof targetAddress !== 'string');
  const redirect = createServer((_req, res) => { res.statusCode = 302; res.setHeader('Location', `http://127.0.0.1:${targetAddress.port}/target`); res.end(''); });
  await new Promise<void>(resolve => redirect.listen(0, '127.0.0.1', resolve));
  const address = redirect.address(); assert.ok(address && typeof address !== 'string');
  const backend = new AdtBackend(connectionSchema.parse({ connection_id: randomUUID(), name: 'mock', base_url: `http://127.0.0.1:${address.port}`,
    client: '001', language: 'EN', username: 'TEST' }), 'fake');
  try { await assert.rejects(backend.capabilities()); assert.equal(targetHits, 0); }
  finally { await backend.close().catch(() => {}); await new Promise<void>(resolve => redirect.close(() => resolve()));
    await new Promise<void>(resolve => target.close(() => resolve())); }
});

test('CTS preflight distinguishes explicit no-recording from missing or failed checks', async () => {
  let flags = '<RESULT>S</RESULT><KORRFLAG/><RECORDING/>';
  const calls: { body: string; state: string | string[] | undefined }[] = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://local');
    res.setHeader('Content-Type', 'application/xml');
    if (url.pathname.endsWith('/compatibility/graph')) { res.setHeader('x-csrf-token', 'test'); res.end('<graph/>'); }
    else if (url.pathname.endsWith('/cts/transportchecks')) {
      let body = ''; for await (const chunk of req) body += chunk;
      calls.push({ body, state: req.headers['x-sap-adt-sessiontype'] });
      res.end(`<asx:abap xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>${flags}</DATA></asx:values></asx:abap>`);
    } else res.end('');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const backend = new AdtBackend(connectionSchema.parse({ connection_id: randomUUID(), name: 'mock',
    base_url: `http://127.0.0.1:${address.port}`, client: '001', language: 'EN', username: 'TEST' }), 'fake');
  const uri = '/sap/bc/adt/programs/programs/ztest';
  try {
    assert.equal(await backend.transportRequirement(uri, 'TEST_LOCAL', 'U'), 'not_required');
    const input = new XMLParser().parse(calls[0].body)['asx:abap']['asx:values'].DATA;
    assert.equal(input.URI, uri); assert.equal(input.DEVCLASS, 'TEST_LOCAL'); assert.equal(input.OPERATION, 'I');
    assert.equal(calls[0].state, 'stateless');
    flags = '<RESULT>S</RESULT><KORRFLAG>X</KORRFLAG><RECORDING>X</RECORDING>';
    assert.equal(await backend.transportRequirement(uri, 'ZPACKAGE', 'I'), 'required');
    for (const response of ['<RESULT>S</RESULT>', '<RESULT>E</RESULT><KORRFLAG/><RECORDING/>',
      '<RESULT>S</RESULT><KORRFLAG>X</KORRFLAG><RECORDING/>']) {
      flags = response;
      await assert.rejects(backend.transportRequirement(uri, 'ZPACKAGE', 'U'), error => safeError(error).code === 'TRANSPORT_CHECK_UNAVAILABLE');
    }
  } finally { await backend.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('transport creation escapes its payload and distinguishes returned task from verified parent', async () => {
  let reply = '/sap/bc/adt/cts/transports/DEVK900002\n';
  let payload: any; let posts = 0;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://local');
    res.setHeader('Content-Type', 'application/xml');
    if (url.pathname.endsWith('/compatibility/graph')) { res.setHeader('x-csrf-token', 'test'); res.end('<graph/>'); }
    else if (url.pathname === '/sap/bc/adt/cts/transports') {
      let body = ''; for await (const chunk of req) body += chunk;
      posts++; payload = new XMLParser().parse(body)['asx:abap']['asx:values'].DATA;
      res.setHeader('Content-Type', 'text/plain'); res.statusCode = 201; res.end(reply);
    } else if (url.pathname === '/sap/bc/adt/cts/transportrequests') {
      assert.equal(req.headers.accept, 'application/vnd.sap.adt.transportorganizertree.v1+xml');
      assert.equal(url.searchParams.get('user'), 'TEST');
      res.end('<tm:root xmlns:tm="test"><tm:workbench><tm:target tm:name="DEV"><tm:modifiable><tm:request tm:number="DEVK900001" tm:owner="TEST" tm:status="modifiable"><tm:task tm:number="DEVK900002" tm:owner="TEST" tm:status="modifiable"/><tm:task tm:number="DEVK900003" tm:owner="OTHER" tm:status="modifiable"/></tm:request></tm:modifiable></tm:target></tm:workbench></tm:root>');
    } else res.end('');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const backend = new AdtBackend(connectionSchema.parse({ connection_id: randomUUID(), name: 'mock',
    base_url: `http://127.0.0.1:${address.port}`, client: '001', language: 'EN', username: 'TEST' }), 'fake');
  const uri = '/sap/bc/adt/programs/programs/ztest';
  try {
    assert.equal(await backend.createTransportRequest(uri, 'ZPACKAGE', 'A & B <test>'), 'DEVK900002');
    assert.equal(payload.REQUEST_TEXT, 'A & B <test>'); assert.equal(payload.DEVCLASS, 'ZPACKAGE');
    assert.equal(payload.REF, uri); assert.equal(payload.OPERATION, 'I');
    const verified = await backend.verifyTransportRequest('DEVK900002');
    assert.equal(verified?.request_number, 'DEVK900001');
    assert.deepEqual(verified?.tasks, [{ task_number: 'DEVK900002', owner: 'TEST', status: 'modifiable' }]);
    assert.equal(await backend.verifyTransportRequest('DEVK999999'), undefined);
    reply = 'not a transport number';
    await assert.rejects(backend.createTransportRequest(uri, 'ZPACKAGE', 'Test'), error => safeError(error).code === 'TRANSPORT_RESPONSE_INVALID');
    assert.equal(posts, 2);
  } finally { await backend.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('SAP authentication failures are classified without exposing response data', async () => {
  const server = createServer((_req, res) => { res.statusCode = 401; res.end('secret backend detail'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const backend = new AdtBackend(connectionSchema.parse({ connection_id: randomUUID(), name: 'mock', base_url: `http://127.0.0.1:${address.port}`,
    client: '001', language: 'EN', username: 'TEST' }), 'fake');
  try { await assert.rejects(backend.capabilities(), error => {
    const result = safeError(error); assert.equal(result.code, 'AUTH_FAILED'); assert.equal(JSON.stringify(result).includes('secret'), false); return true;
  }); } finally { await backend.close().catch(() => {}); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('inactive version probes use a separate stateless session without invalidating a module lock', async () => {
  const object = '/sap/bc/adt/functions/groups/zgroup/fmodules/zmodule';
  let saved = false; let statelessProbe = false;
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://local');
    res.setHeader('Content-Type', 'application/xml');
    if (url.pathname.endsWith('/compatibility/graph')) {
      res.setHeader('x-csrf-token', 'test');
      res.setHeader('Set-Cookie', 'SAP_SESSIONID_TEST=initial; Path=/'); res.end('<graph/>');
    } else if (url.searchParams.get('_action') === 'LOCK') {
      res.end('<asx:abap xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA><LOCK_HANDLE>module-lock</LOCK_HANDLE></DATA></asx:values></asx:abap>');
    } else if (url.searchParams.get('_action') === 'UNLOCK') {
      res.end('');
    } else if (url.pathname === object) {
      statelessProbe = req.headers['x-sap-adt-sessiontype'] === 'stateless';
      res.statusCode = 404;
      res.setHeader('Set-Cookie', 'SAP_SESSIONID_TEST=refreshed; Path=/');
      res.end('<exc:exception xmlns:exc="test"><type id="NotFound"/><message>Inactive version missing</message></exc:exception>');
    } else if (req.method === 'PUT') {
      saved = statelessProbe && req.headers.cookie?.includes('SAP_SESSIONID_TEST=initial') === true &&
        url.searchParams.get('lockHandle') === 'module-lock';
      res.statusCode = saved ? 204 : 423; res.end();
    } else res.end('');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const backend = new AdtBackend(connectionSchema.parse({ connection_id: randomUUID(), name: 'mock',
    base_url: `http://127.0.0.1:${address.port}`, client: '001', language: 'EN', username: 'TEST' }), 'fake');
  try {
    const handle = await backend.lock(object);
    await assert.rejects(backend.read(object, 'inactive'), error => safeError(error).code === 'OBJECT_NOT_FOUND');
    await backend.save(`${object}/source/main`, 'FUNCTION zmodule. ENDFUNCTION.', handle);
    assert.equal(saved, true);
    await backend.unlock(object, handle);
  } finally { await backend.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
