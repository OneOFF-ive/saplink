import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const navigation = source.slice(source.indexOf('function showView('), source.indexOf("for (const node of document.querySelectorAll('.nav')) node.onclick"));
const start = source.slice(source.indexOf('async function startService('), source.indexOf("$('#start-service').onclick = startService;"));
function screen(latest: unknown) {
  const views = ['service', 'connections', 'tokens', 'updates'].map(name => ({id: name + '-view', hidden: name !== 'service'}));
  const navigationItems = views.map(view => ({dataset: {view: view.id.replace('-view', '')}, active: !view.hidden,
    classList: {toggle(_name: string, value: boolean) { navigationItems.find(item => item.classList === this)!.active = value; }} }));
  const breadcrumb = {textContent: 'MCP 服务'};
  let focused = false, confirm: (() => void) | undefined;
  const requests: string[] = [];
  const context = vm.createContext({state: {connections: []}, labels: {service: 'MCP 服务', connections: '系统连接', tokens: '访问令牌'},
    document: {querySelectorAll: (selector: string) => selector === '.view' ? views : navigationItems},
    $: (selector: string) => selector === '#breadcrumb' ? breadcrumb : selector === '#port' ? {value: '8765'} : {focus: () => {focused = true;}},
    api: async (path: string) => {requests.push(path); return latest;},
    act: async (action: () => Promise<unknown>) => action(), toast: () => {},
    confirmAction: (_title: string, _message: string, action: () => void) => {confirm = action;}
  });
  vm.runInContext(navigation + start, context);
  return {requests, views, navigationItems, breadcrumb, focused: () => focused, confirm: () => confirm?.(),
    start: () => vm.runInContext('startService()', context)};
}

test('empty connections require confirmation before navigating and never submit service/start', async () => {
  const page = screen({connections: [], tokens: [], running: false});
  await page.start();
  assert.deepEqual(page.requests, ['state']);
  assert.equal(page.views.find(view => view.id === 'service-view')!.hidden, false);
  page.confirm();
  assert.equal(page.views.find(view => view.id === 'connections-view')!.hidden, false);
  assert.equal(page.navigationItems.find(item => item.dataset.view === 'connections')!.active, true);
  assert.equal(page.breadcrumb.textContent, '系统连接');
  assert.equal(page.focused(), true);
  assert.deepEqual(page.requests, ['state']);
});

test('start uses current server connections rather than stale local state', async () => {
  const page = screen({connections: [{connection_id: 'configured'}], tokens: [{id:'token'}], running: false});
  await page.start();
  assert.deepEqual(page.requests, ['state', 'service/start']);
  assert.equal(page.views.find(view => view.id === 'service-view')!.hidden, false);
});

test('already running service is not started again', async () => {
  const page = screen({connections: [], running: true});
  await page.start();
  assert.deepEqual(page.requests, ['state']);
  page.confirm();
  assert.equal(page.views.find(view => view.id === 'service-view')!.hidden, false);
});

test('configured connections with no token guide to tokens only after confirmation', async () => {
  const page = screen({connections: [{connection_id: 'configured'}], tokens: [], running: false});
  await page.start();
  assert.deepEqual(page.requests, ['state']);
  assert.equal(page.views.find(view => view.id === 'service-view')!.hidden, false);
  page.confirm();
  assert.equal(page.views.find(view => view.id === 'tokens-view')!.hidden, false);
  assert.equal(page.navigationItems.find(item => item.dataset.view === 'tokens')!.active, true);
  assert.equal(page.breadcrumb.textContent, '访问令牌');
  assert.equal(page.focused(), true);
  assert.deepEqual(page.requests, ['state']);
});

test('connections have priority over tokens when both are missing', async () => {
  const page = screen({connections: [], tokens: [], running: false});
  await page.start();
  page.confirm();
  assert.equal(page.views.find(view => view.id === 'connections-view')!.hidden, false);
  assert.equal(page.views.find(view => view.id === 'tokens-view')!.hidden, true);
  assert.deepEqual(page.requests, ['state']);
});
