import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const renderSource = source.slice(source.indexOf('function renderUpdate()'), source.indexOf('async function pollUpdate()'));
function screen(update: unknown, supported = true) {
  const nodes = new Map<string, any>();
  const element = () => ({ hidden: false, disabled: false, textContent: '', children: [] as unknown[],
    removeAttribute() {}, replaceChildren() { this.children = []; }, append(...items: unknown[]) { this.children.push(...items); } });
  const context = vm.createContext({ state: { version: '1.0.0', update,
    update_install: { phase: 'idle', supported, architecture: 'x64' } },
    updateChecking: false, updateCheckError: '', element,
    document: { createTextNode: (text: string) => text },
    $: (selector: string) => { if (!nodes.has(selector)) nodes.set(selector, element()); return nodes.get(selector); } });
  vm.runInContext(renderSource, context);
  const render = () => vm.runInContext('renderUpdate()', context);
  render();
  return { nodes, context, render };
}
const available = { update_available: true, latest_version: '1.1.0', source: 'cos',
  release_url: 'https://github.com/OneOFF-ive/saplink/releases', downloads: [{ architecture: 'x64', url: 'https://example.test/setup.exe' }] };

test('background discovery shows New and an install action without a second manual check', () => {
  const { nodes } = screen(available);
  assert.equal(nodes.get('#update-new').hidden, false);
  assert.equal(nodes.get('#check-updates').hidden, true);
  assert.equal(nodes.get('#install-update').hidden, false);
  assert.equal(nodes.get('#install-update').disabled, false);
  assert.match(nodes.get('#update-summary').textContent, /1.1.0/);
});

test('no available release keeps the normal manual check page and clears an earlier badge', () => {
  const { nodes, context, render } = screen(available);
  vm.runInContext('state.update = { update_available: false, latest_version: "1.0.0" }', context);
  render();
  assert.equal(nodes.get('#update-new').hidden, true);
  assert.equal(nodes.get('#check-updates').hidden, false);
  assert.equal(nodes.get('#install-update').hidden, true);
  assert.equal(screen(null).nodes.get('#check-updates').hidden, false);
});

test('unsupported installations cannot auto-install and failed checks allow retry', () => {
  const { nodes, context, render } = screen(available, false);
  assert.equal(nodes.get('#update-new').hidden, false);
  assert.equal(nodes.get('#install-update').disabled, true);
  vm.runInContext('updateCheckError = "offline"', context);
  render();
  assert.equal(nodes.get('#check-updates').hidden, false);
  assert.equal(nodes.get('#install-update').disabled, true);
});

test('installer cleanup failure remains visible after a successful upgrade', () => {
  const { nodes, context, render } = screen({ update_available: false });
  vm.runInContext('state.update_install.last_result = {status: "installed", version: "1.1.0", installer_cleanup: {status: "failed", path: "installer.exe"}}', context);
  render();
  assert.equal(nodes.get('#update-help').hidden, false);
  assert.match(nodes.get('#update-help').textContent, /1.1.0/);
  assert.match(nodes.get('#update-help').textContent, /清理失败.*installer.exe/);
});

test('release prose is displayed as text and missing notes have an explicit placeholder', () => {
  const { nodes, context, render } = screen({...available, release_title: 'New title', release_notes: '<script>example</script>\n- fix'});
  assert.equal(nodes.get('#release-details').hidden, false);
  assert.equal(nodes.get('#release-title').textContent, 'New title');
  assert.equal(nodes.get('#release-notes').textContent, '<script>example</script>\n- fix');
  vm.runInContext('state.update = {update_available:true,latest_version:"1.1.0"}', context);
  render();
  assert.match(nodes.get('#release-notes').textContent, /暂未提供/);
  vm.runInContext('state.update = {update_available:false}', context);
  render();
  assert.equal(nodes.get('#release-details').hidden, true);
});
