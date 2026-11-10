import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../web/agent.js', import.meta.url), 'utf8');
const start = source.indexOf('  function renderSetup() {');
const end = source.indexOf('\n  function pollError(', start);
assert.ok(start >= 0 && end > start, 'setup renderer must exist');

function screen() {
  const nodes = new Map<string, { textContent: string; title: string; hidden: boolean; value: string; attributes: Record<string,string>;
    style: { width: string; properties: Record<string,string>; setProperty: (name: string, value: string) => void }; setAttribute: (name: string, value: string) => void }>();
  const node = (selector: string) => {
    if (!nodes.has(selector)) {
      const attributes:Record<string,string>={};
      const properties:Record<string,string>={};
      nodes.set(selector, { textContent: '', title: '', hidden: false, value: '', attributes,
        style: { width: '', properties, setProperty: (name,value) => { properties[name]=value; } }, setAttribute: (name,value) => { attributes[name]=value; } });
    }
    return nodes.get(selector)!;
  };
  const context = vm.createContext({ $: node, connections: [], selectedTask: undefined, modelStatus: undefined,
    modelNames: { 'deepseek-flash': 'DeepSeek Flash' }, connectionLabel: (c: { name: string; client: string }) => `${c.name} · Client ${c.client}`,
    updateControls: () => {}, renderWriteMode: () => {} });
  vm.runInContext(source.slice(start, end), context);
  return { context, node, render: () => vm.runInContext('renderSetup()', context) };
}

test('the MCP test button shows loading and resets after success or failure', async () => {
  const from=source.indexOf('  mcpFields.test.onclick');
  const to=source.indexOf('  const skillActions',from);
  assert.ok(from>=0&&to>from);
  for(const fails of [false,true]){
    const attrs=new Map<string,string>();
    const button={title:'测试连接',setAttribute:(key:string,value:string)=>attrs.set(key,value),
      removeAttribute:(key:string)=>attrs.delete(key)};
    let resolve!: (value:unknown[])=>void,reject!: (error:Error)=>void,finished!:Promise<void>;
    const response=new Promise<unknown[]>((ok,bad)=>{resolve=ok;reject=bad;});
    const context=vm.createContext({mcpFields:{test:button},editingMcpId:'service',mcpEndpoint:'mcp/',
      extensionResult:{textContent:''},api:()=>response,
      runExtensionAction:(action:()=>Promise<void>)=>{finished=action().catch(()=>{});}});
    vm.runInContext(source.slice(from,to)+'\nmcpFields.test.onclick()',context);
    assert.equal(attrs.get('aria-busy'),'true');
    assert.equal(button.title,'正在测试连接');
    if(fails)reject(new Error('fixture failure'));else resolve([]);
    await finished;
    assert.equal(attrs.has('aria-busy'),false);
    assert.equal(button.title,'测试连接');
  }
});

test('conversation offers model configuration when an API key is missing or unreadable', () => {
  const page = screen();
  page.context.modelStatus = { configured:false, key_source:'none' };
  page.render();
  assert.equal(page.node('#agent-notice').hidden, false);
  assert.equal(page.node('#agent-configure-model').hidden, false);
  assert.match(page.node('#agent-notice-text').textContent, /配置 DeepSeek API Key/);
  page.context.modelStatus.key_source = 'unavailable';
  page.render();
  assert.match(page.node('#agent-notice-text').textContent, /无法读取已保存/);
  page.context.modelStatus.configured = true;
  page.render();
  assert.equal(page.node('#agent-configure-model').hidden, true);
  let opened = 0;
  page.context.openAgentSettings = () => { opened++; };
  const bind = source.split('\n').find(line => line.includes("$('#agent-configure-model').onclick"));
  assert.ok(bind);
  vm.runInContext(bind + "\n$('#agent-configure-model').onclick()", page.context);
  assert.equal(opened, 1);
});

test('composer follows model, selected task context and connection data policy', () => {
  const page = screen();
  page.render();
  assert.equal(page.node('#agent-model-label span').textContent, '模型未配置');
  assert.equal(page.node('#agent-context-amount').textContent, '新对话暂无数据');
  assert.equal(page.node('#agent-context-usage').textContent, '暂无数据');
  page.context.connections = [{ connection_id: 'a', name: '开发系统', client: '100' }];
  page.context.modelStatus = { configured: true, model: 'deepseek-flash', context_tokens: 160000 };
  page.node('#agent-connection').value = 'a';
  page.context.selectedTask = { context_estimated_tokens: 12345, context_tokens: 160000,
    last_model_input_tokens: 10234, model_usage: { total_tokens: 30000 } };
  page.render();
  assert.equal(page.node('#agent-model-label span').textContent, 'DeepSeek Flash');
  assert.equal(page.node('#agent-reasoning-value').textContent, '中');
  assert.equal(page.node('#agent-context-value').textContent, '512K');
  page.context.modelStatus.context_tokens = 1000000;
  page.render();
  assert.equal(page.node('#agent-context-value').textContent, '1M');
  assert.match(page.node('#agent-data-policy').textContent, /表数据访问未开启/);
  page.context.connections = [{ connection_id: 'a', name: '开发系统', client: '100', allow_table_data:true }];
  page.render();
  assert.match(page.node('#agent-data-policy').textContent, /表数据访问已开启/);
  assert.equal(page.node('#agent-context-amount').textContent, '约 12,345 / 160,000 Token');
  assert.equal(page.node('#agent-context-last').textContent, '10,234 Token');
  assert.equal(page.node('#agent-context-usage').textContent, '30,000 Token');
  assert.equal(page.node('#agent-context-progress').style.width, '8%');
  page.context.selectedTask = undefined;
  page.render();
  assert.equal(page.node('#agent-context-amount').textContent, '新对话暂无数据');
});

test('the task compaction threshold remains the basis across model switches', () => {
  const page = screen();
  page.context.selectedTask = { context_estimated_tokens: 80000, context_tokens: 160000 };
  page.context.modelStatus = { configured: true, model: 'deepseek-flash', context_tokens: 256000 };
  page.render();
  assert.equal(page.node('#agent-context-percent').textContent, '50%');
  assert.equal(page.node('#agent-context-amount').textContent, '约 80,000 / 160,000 Token');
  page.context.modelStatus = { configured: true, model: 'deepseek-v4-pro', context_tokens: 256000 };
  page.render();
  assert.equal(page.node('#agent-context-percent').textContent, '50%');
  page.context.modelStatus.reasoning_effort = 'high';
  page.render();
  assert.equal(page.node('#agent-reasoning-value').textContent, '中');
  page.context.selectedTask = { context_estimated_tokens: 160000, context_tokens: 160000 };
  page.render();
  assert.equal(page.node('#agent-context-percent').textContent, '100%');
  assert.equal(page.node('#agent-context-progress').style.width, '100%');
  page.context.selectedTask = { context_estimated_tokens: 240000, context_tokens: 160000 };
  page.render();
  assert.equal(page.node('#agent-context-percent').textContent, '150%');
  assert.equal(page.node('#agent-context-progress').style.width, '100%');
  page.context.selectedTask = { context_estimated_tokens: 128000 };
  page.render();
  assert.equal(page.node('#agent-context-percent').textContent, '50%');
  assert.equal(page.node('#agent-context-amount').textContent, '约 128,000 / 256,000 Token');
  page.context.modelStatus = { configured: true, model: 'unknown' };
  page.render();
  assert.equal(page.node('#agent-context-amount').textContent, '整理阈值暂无数据');
  assert.equal(page.node('#agent-context-percent').textContent, '--');
});

test('a task without an estimate is shown as loading, not zero', () => {
  const page = screen();
  page.context.selectedTask = { context_tokens: 160000 };
  page.render();
  assert.equal(page.node('#agent-context-amount').textContent, '正在加载');
});

test('reasoning choices persist and surface errors', async () => {
  const first = source.indexOf('  function updateModelTuning() {');
  const last = source.indexOf("  $('#agent-write-mode').onclick", first);
  assert.ok(first >= 0 && last > first);
  type Button = { dataset: { value: string }; attributes: Record<string, string>; disabled: boolean;
    onclick?: () => void; setAttribute: (name: string, value: string) => void };
  const buttons = (values: string[]): Button[] => values.map(value => {
    const attributes: Record<string, string> = {};
    return { dataset: { value }, attributes, disabled: false,
      setAttribute: (name, value) => { attributes[name] = value; } };
  });
  const reasoning = buttons(['low', 'high', 'max']);
  const presets = buttons(['128000', '512000', '1000000']);
  const calls: unknown[] = [], errors: string[] = [];
  let fail = false;
  const context = vm.createContext({
    $: (selector: string) => ({ querySelectorAll: () => selector === '#agent-context-options' ? presets : reasoning }),
    modelStatus: { configured: true, model: 'deepseek-flash', context_tokens: 160000, reasoning_effort: 'low' },
    document: { activeElement: null, body: {} },
    busy: false, generation: 0, updateControls: () => {}, renderSetup: () => {}, toast: () => {}, schedule: () => {},
    pollError: (message: string) => errors.push(message),
    api: async (_path: string, _method: string, input: object) => {
      calls.push(input);
      if (fail) throw new Error('保存失败');
      return { ...context.modelStatus, ...input };
    }
  });
  vm.runInContext(source.slice(first, last), context);
  vm.runInContext('updateModelTuning()', context);
  assert.equal(reasoning[0].attributes['aria-pressed'], 'true');
  await vm.runInContext("saveModelTuning('max')", context);
  assert.equal(reasoning[2].attributes['aria-pressed'], 'true');
  assert.equal(context.modelStatus.context_tokens, 160000);
  assert.equal(context.modelStatus.reasoning_effort, 'max');
  await vm.runInContext("saveModelTuning(1000000, 'context_tokens')", context);
  assert.equal(presets[2].attributes['aria-pressed'], 'true');
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    { model: 'deepseek-flash', reasoning_effort: 'max' },
    { model: 'deepseek-flash', context_tokens: 1000000 }
  ]);
  context.modelStatus.active_task_id = 'active';
  await vm.runInContext("saveModelTuning('low')", context);
  assert.equal(calls.length, 2);
  delete context.modelStatus.active_task_id;
  fail = true;
  await vm.runInContext("saveModelTuning('low')", context);
  assert.deepEqual(errors, ['保存失败']);
  assert.equal(context.modelStatus.reasoning_effort, 'max');
});
