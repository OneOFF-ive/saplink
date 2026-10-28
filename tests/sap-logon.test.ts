import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSapLogon, readSapLogon } from '../src/sap-logon.js';

const landscape = (services: string, routers = '') => `<Landscape><Services>${services}</Services><Routers>${routers}</Routers></Landscape>`;
test('SAP Logon imports only allowed connection fields and resolves global router references', () => {
  const global = landscape('', '<Router uuid="router" router="/H/router.example/S/3299"/>');
  const local = landscape(`<Service type="SAPGUI" uuid="dev" name="Dev &amp; QA" systemid="DEV" mode="1" server="internal.sap:3202" routerid="router" client="001" language="zh" user="DO_NOT_IMPORT" password="SECRET"><Memo>MEMO_SECRET</Memo></Service>
    <Service type="SAPGUI" name="Direct" server="other.sap:3299" sncop="-1"/>
    <Service type="FIORI" name="Web" url="https://example.test"/>`);
  const entries = parseSapLogon([global, local]);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], { id: '0', label: 'Dev & QA', system_id: 'DEV', available: true,
    rfc: { ashost: 'internal.sap', sysnr: '02', saprouter: '/H/router.example/S/3299' }, client: '001', language: 'ZH' });
  assert.equal(entries[1].rfc?.sysnr, '99');
  assert.doesNotMatch(JSON.stringify(entries), /SECRET|DO_NOT_IMPORT|Memo|password|username/);
});
test('unsupported routes, SNC and load balancing cannot silently become direct connections', () => {
  const entries = parseSapLogon([landscape(`
    <Service type="SAPGUI" name="Missing router" server="sap:3200" routerid="missing"/>
    <Service type="SAPGUI" name="Secret router" server="sap:3200" routerid="secret"/>
    <Service type="SAPGUI" name="SNC" server="sap:3200" sncop="1"/>
    <Service type="SAPGUI" name="Balanced" server="PUBLIC" msid="message" mode="0"/>
    <Service type="SAPGUI" name="Custom" server="sap:1234"/>
    <Service type="SAPGUI" name="Bad host" server="user:SECRET@sap:3200"/>`, '<Router uuid="secret" router="/H/router/P/ROUTE_SECRET"/>')]);
  assert.equal(entries.length, 6);
  for (const entry of entries) { assert.equal(entry.available, false); assert.equal(entry.rfc, undefined); assert.ok(entry.reason); }
  assert.doesNotMatch(JSON.stringify(entries), /ROUTE_SECRET|user:SECRET/);
});
test('user definitions override global services and XML declarations cannot resolve external entities', () => {
  const entries = parseSapLogon([landscape('<Service uuid="same" type="SAPGUI" name="Global" server="global:3200"/>'),
    landscape('<Service uuid="same" type="SAPGUI" name="User" server="user:3201"/>')]);
  assert.equal(entries.length, 1); assert.equal(entries[0].rfc?.ashost, 'user');
  for (const xml of ['<Landscape>', '<html/>', '<!DOCTYPE Landscape [<!ENTITY secret SYSTEM "file:///secret">]><Landscape/>', 'x'.repeat(5 * 1024 * 1024 + 1)])
    assert.throws(() => parseSapLogon([xml]));
});
test('local discovery handles missing files, malformed files and overrides without following Includes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'saplink-logon-'));
  try {
    assert.deepEqual(await readSapLogon({ APPDATA: directory }), { connections: [], warnings: [] });
    const common = join(directory, 'SAP', 'Common'); await mkdir(common, { recursive: true });
    await writeFile(join(common, 'SAPUILandscapeGlobal.xml'), '<invalid');
    await writeFile(join(common, 'SAPUILandscape.xml'), '<Landscape><Includes><Include url="https://example.test/secret"/></Includes></Landscape>');
    const override = join(directory, 'custom.xml');
    await writeFile(override, '\uFEFF' + landscape('<Service type="SAPGUI" name="Custom" server="sap:3200"/>'), 'utf16le');
    const result = await readSapLogon({ APPDATA: directory, SAPLOGON_LSXML_FILE: override });
    assert.equal(result.connections.length, 1); assert.equal(result.warnings.length, 2);
    assert.doesNotMatch(JSON.stringify(result), /https:|custom.xml|invalid/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
