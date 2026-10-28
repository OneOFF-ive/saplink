import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const updateSource = source.slice(source.indexOf('function updateRfcFields()'), source.indexOf('connectionForm.elements.transport.onchange'));
const submitSource = source.slice(source.indexOf('connectionForm.onsubmit ='), source.indexOf("for (const node of document.querySelectorAll('.close-dialog'))"));
function screen() {
  const elements: Record<string, any> = Object.fromEntries(Object.entries({ name: 'test', transport: 'http', base_url: 'https://sap.test',
    client: '001', username: 'TEST', language: 'EN', rfc_ashost: 'internal.sap', rfc_sysnr: '00',
    rfc_saprouter: ' /H/router.example/S/3299 ', password: 'synthetic-secret', write_enabled: '' })
    .map(([key, value]) => [key, { value, disabled: false, required: false, checked: false }]));
  const button = { disabled: false }, form = { elements, querySelector: () => button };
  const nodes = new Map<string, any>([['#connection-form', form]]);
  const calls: any[] = [];
  const context = vm.createContext({ connectionForm: form, working: false, editing: null, tests: new Map(),
    $: (selector: string) => { if (!nodes.has(selector)) nodes.set(selector, { hidden: false, close() {} }); return nodes.get(selector); },
    FormData: function(form: any) { return Object.entries(form.elements).filter(([, field]: any) => !field.disabled).map(([name, field]: any) => [name, field.value]); },
    api: async (path: string, method: string, data: unknown) => { calls.push({ path, method, data }); },
    render() {}, refresh: async () => {}, toast() {} });
  vm.runInContext(updateSource + submitSource, context);
  return { elements, nodes, calls, update: () => vm.runInContext('updateRfcFields()', context),
    submit: () => vm.runInContext('connectionForm.onsubmit({preventDefault(){},currentTarget:connectionForm})', context) };
}

test('connection form sends only the selected transport and restores routed RFC on switching back', async () => {
  const f = screen();
  f.update();
  assert.equal(f.elements.rfc_ashost.disabled, true); assert.equal(f.elements.rfc_saprouter.disabled, true);
  assert.equal(f.elements.base_url.required, true);
  assert.equal(f.nodes.get('#sap-logon-import').hidden, true);
  await f.submit();
  assert.equal(f.calls[0].data.rfc, undefined);
  f.elements.transport.value = 'rfc'; f.update();
  assert.equal(f.nodes.get('#saprouter-field').hidden, false);
  assert.equal(f.elements.rfc_ashost.required, true); assert.equal(f.elements.rfc_sysnr.required, true);
  assert.equal(f.elements.rfc_saprouter.required, false);
  assert.equal(f.nodes.get('#sap-logon-import').hidden, false);
  assert.equal(f.nodes.get('#connection-url-field').hidden, true);
  assert.equal(f.elements.base_url.disabled, true); assert.equal(f.elements.base_url.required, false);
  await f.submit();
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[1].data.rfc)), { ashost: 'internal.sap', sysnr: '00', saprouter: '/H/router.example/S/3299' });
  assert.equal(Object.hasOwn(f.calls[1].data, 'base_url'), false);
  f.elements.rfc_saprouter.value = ''; await f.submit();
  assert.equal(f.calls[2].data.rfc.saprouter, undefined, 'clearing the route must save an RFC direct connection');
  f.elements.transport.value = 'http'; f.update(); await f.submit();
  assert.equal(f.calls[3].data.rfc, undefined); assert.equal(f.nodes.get('#saprouter-field').hidden, true);
  assert.equal(f.calls[3].data.base_url, 'https://sap.test');
  assert.equal(f.nodes.get('#connection-url-field').hidden, false);
});

test('SAP Logon selection fills RFC parameters while preserving manually entered identity and credentials', () => {
  const fields: Record<string, any> = Object.fromEntries(Object.entries({ transport: 'rfc', name: 'my_connection', username: 'MY_USER', password: 'manual-secret',
    rfc_ashost: '', rfc_sysnr: '', rfc_saprouter: '/H/old', client: '100', language: 'EN' }).map(([name, value]) =>
    [name, { value, setCustomValidity() {}, removeAttribute() {} }]));
  fields.language.options = [{ value: 'EN' }, { value: 'ZH' }];
  let closed = false;
  const context = vm.createContext({ editing: null, connectionForm: { elements: fields }, toast() {},
    $: () => ({ close() { closed = true; }, textContent: '' }) });
  vm.runInContext(source.slice(source.indexOf('function applySapLogon('), source.indexOf('function renderSapLogon(')), context);
  context.entry = { available: true, label: 'GUI NAME', username: 'GUI_USER', password: 'GUI_SECRET',
    rfc: { ashost: 'new.sap', sysnr: '02' }, client: '001', language: 'ZH' };
  vm.runInContext('applySapLogon(entry)', context);
  assert.equal(closed, true); assert.equal(fields.rfc_ashost.value, 'new.sap'); assert.equal(fields.rfc_sysnr.value, '02');
  assert.equal(fields.rfc_saprouter.value, ''); assert.equal(fields.client.value, '001'); assert.equal(fields.language.value, 'ZH');
  assert.equal(fields.name.value, 'my_connection'); assert.equal(fields.username.value, 'MY_USER'); assert.equal(fields.password.value, 'manual-secret');
  context.editing = {}; fields.rfc_ashost.value = 'unchanged';
  vm.runInContext('applySapLogon(entry)', context); assert.equal(fields.rfc_ashost.value, 'unchanged');
});
