import test from 'node:test';
import assert from 'node:assert/strict';
import { XMLParser } from 'fast-xml-parser';
import { scopedActivationBody, activationResponse, type ActivationReference } from '../src/activation.js';
import { AdtBackend } from '../src/adt.js';
import { connectionSchema } from '../src/config.js';
import { randomUUID } from 'node:crypto';

const group = '/sap/bc/adt/functions/groups/zgroup';
const a = '/sap/bc/adt/programs/programs/za', b = '/sap/bc/adt/programs/programs/zb';
const refs = (body: string): any[] => {
  const objects = new XMLParser({ ignoreAttributes: false }).parse(body)['adtcore:objectReferences']['adtcore:objectReference'];
  return Array.isArray(objects) ? objects : [objects];
};
const entry = (uri: string, name: string, type: string, user = 'TEST') => `<ioc:entry><ioc:object ioc:user="${user}" ioc:deleted="false"><ioc:ref adtcore:uri="${uri}" adtcore:name="${name}" adtcore:type="${type}"/></ioc:object></ioc:entry>`;
const preaudit = (entries: string) => `<ioc:inactiveObjects xmlns:ioc="test" xmlns:adtcore="http://www.sap.com/adt/core">${entries}</ioc:inactiveObjects>`;
const approved: ActivationReference[] = [{ uri: a, name: 'ZA', type: 'PROG/P' }, { uri: b, name: 'ZB', type: 'PROG/P' }];

test('preaudit parser preserves reference identity, owner and deletion flags', () => {
  const result = activationResponse(preaudit(entry(a, 'ZA', 'PROG/P')));
  assert.equal(result.success, false);
  assert.equal(result.inactive[0].object?.user, 'TEST');
  assert.equal(result.inactive[0].object?.deleted, false);
  assert.equal(result.inactive[0].object?.['adtcore:uri'], a);
  assert.equal(activationResponse(preaudit(entry(a, 'ZA', 'PROG/P').replace('deleted="false"', 'deleted="true"'))).inactive[0].object?.deleted, true);
  assert.deepEqual(refs(scopedActivationBody(result, approved, 'TEST')).map(ref => ref['@_adtcore:uri']), [a, b]);
});

test('preaudit rejects unapproved objects, other owners, deleted objects and changed identities', () => {
  for (const xml of [entry('/sap/bc/adt/programs/programs/zc', 'ZC', 'PROG/P'),
    entry(a, 'ZA', 'PROG/P', 'OTHER'), entry(a, 'ZA', 'CLAS/OC'), entry(a, 'WRONG', 'PROG/P'),
    entry(a, 'ZA', 'PROG/P').replace('deleted="false"', 'deleted="true"'),
    entry(a, 'ZA', 'PROG/P').replace('adtcore:name=', 'adtcore:parentUri="/other" adtcore:name=')]) {
    assert.throws(() => scopedActivationBody(activationResponse(preaudit(xml)), approved, 'TEST'), /unapproved/);
  }
  assert.throws(() => scopedActivationBody(activationResponse(preaudit('<ioc:entry/>')), approved, 'TEST'));
});

test('preaudit transport context is omitted and group source references remain scoped', () => {
  const groupRef = { uri: group, name: 'ZGROUP', type: 'FUGR/F', parentUri: group };
  const allowed = [groupRef, { ...groupRef, uri: `${group}/source/main` }];
  const transport = '<ioc:entry><ioc:transport><ioc:ref adtcore:uri="/sap/bc/adt/cts/transportrequests/DEVK900001"/></ioc:transport></ioc:entry>';
  const xml = preaudit(transport + entry(`${group}/source/main`, 'ZGROUP', 'FUGR/F'));
  const body = scopedActivationBody(activationResponse(xml), allowed, 'TEST', [groupRef]);
  assert.doesNotMatch(body, /DEVK|undefined/);
  assert.deepEqual(refs(body).map(ref => ref['@_adtcore:uri']), [`${group}/source/main`, group]);
});

test('activation response rejects malformed or unrelated responses and retains errors', () => {
  assert.equal(activationResponse('').success, true);
  assert.equal(activationResponse('<chkl:messages xmlns:chkl="test"><msg type="E"><shortText><txt>Failure</txt></shortText></msg></chkl:messages>').success, false);
  for (const xml of ['<html/>', '<ioc:inactiveObjects>']) assert.throws(() => activationResponse(xml));
});

function backendFixture() {
  const backend = new AdtBackend(connectionSchema.parse({ connection_id: randomUUID(), name: 'mock',
    base_url: 'http://127.0.0.1:12345', client: '001', language: 'EN', username: 'TEST' }), 'fake');
  const calls: { body: string; preauditRequested: boolean }[] = [];
  let responses = [''];
  (backend as any).reader = { objectStructure: async (uri: string) => ({ metaData: {
    'adtcore:name': uri === a ? 'ZA' : uri === b ? 'ZB' : uri === group ? 'ZGROUP' : 'ZMODULE',
    'adtcore:type': uri === a || uri === b ? 'PROG/P' : uri === group ? 'FUGR/F' : 'FUGR/FF'
  } }) };
  (backend as any).client = { httpClient: { request: async (path: string, options: any) => {
    assert.equal(path, '/sap/bc/adt/activation');
    calls.push({ body: options.body, preauditRequested: options.qs.preauditRequested });
    return { body: responses.shift() ?? '' };
  } } };
  return { backend, calls, respond: (...xml: string[]) => { responses = xml; } };
}

test('mutually dependent objects share one initial activation request', async () => {
  const f = backendFixture(); let dispatched = 0;
  assert.equal((await f.backend.activateBatch([{ object_uri: a }, { object_uri: b }], () => { dispatched++; })).success, true);
  assert.equal(f.calls.length, 1); assert.equal(dispatched, 1);
  assert.deepEqual(refs(f.calls[0].body).map(ref => ref['@_adtcore:uri']), [a, b]);
  assert.equal(f.calls[0].preauditRequested, true);
});

test('joint preaudit keeps the full set in one second phase, without looping', async () => {
  const f = backendFixture();
  f.respond(preaudit(entry(a, 'ZA', 'PROG/P')), preaudit(entry(b, 'ZB', 'PROG/P')));
  assert.equal((await f.backend.activateBatch([{ object_uri: a }, { object_uri: b }])).success, false);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].preauditRequested, false);
  assert.deepEqual(refs(f.calls[1].body).map(ref => ref['@_adtcore:uri']), [a, b]);
});

test('unapproved dependency stops after preaudit and reports required scope', async () => {
  const f = backendFixture(); f.respond(preaudit(entry('/sap/bc/adt/programs/programs/zc', 'ZC', 'PROG/P')));
  await assert.rejects(f.backend.activateBatch([{ object_uri: a }, { object_uri: b }]), (error: any) =>
    error.code === 'ACTIVATION_SCOPE_INVALID' && error.details.unapproved_objects[0].name === 'ZC');
  assert.equal(f.calls.length, 1);
});

test('group and its inactive members join other selected programs in one request', async () => {
  const f = backendFixture(), member = `${group}/fmodules/zmodule`;
  const snapshot = { object_uri: group, revision: 'test', name: 'ZGROUP', members: [
    { object_uri: member, version: 'inactive' as const, revision: 'm', hash: 'h' }
  ] };
  assert.equal((await f.backend.activateBatch([{ object_uri: group, snapshot }, { object_uri: a }])).success, true);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(refs(f.calls[0].body).map(ref => ref['@_adtcore:uri']), [member, group, a]);
  await assert.rejects(f.backend.activateBatch([{ object_uri: group, snapshot }, { object_uri: member }]), /either/);
  await assert.rejects(f.backend.activate(group), /snapshot/);
  assert.equal(f.calls.length, 1);
});

test('metadata failure before dispatch does not invoke the dispatch callback', async () => {
  const f = backendFixture(); let dispatched = false;
  (f.backend as any).reader.objectStructure = async () => { throw new Error('metadata unavailable'); };
  await assert.rejects(f.backend.activateBatch([{ object_uri: a }], () => { dispatched = true; }));
  assert.equal(dispatched, false); assert.equal(f.calls.length, 0);
});

test('SAP error diagnostics stop without a confirmation phase', async () => {
  const f = backendFixture();
  f.respond('<chkl:messages xmlns:chkl="test"><msg type="E"><shortText><txt>Syntax error</txt></shortText></msg></chkl:messages>');
  const result = await f.backend.activateBatch([{ object_uri: a }, { object_uri: b }]);
  assert.equal(result.success, false); assert.equal(f.calls.length, 1);
});

test('activation transport failure is never retried', async () => {
  const f = backendFixture(); let requests = 0;
  (f.backend as any).client.httpClient.request = async () => { requests++; throw new Error('Response lost'); };
  await assert.rejects(f.backend.activateBatch([{ object_uri: a }, { object_uri: b }]));
  assert.equal(requests, 1);
});
