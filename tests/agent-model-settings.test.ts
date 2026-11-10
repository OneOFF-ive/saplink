import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ConfigStore, type Credentials } from '../src/config.js';
import { ModelSettings } from '../src/agent/model-settings.js';
import { AgentRuntime } from '../src/agent/runtime.js';
import { startAdmin } from '../src/admin.js';

async function fixture() {
  const root = resolve('.saplink/tests'); await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'model-settings-'));
  const secrets = new Map<string, string>();
  const credentials: Credentials = { get: async id => {
    const value = secrets.get(id); if (!value) throw new Error('private credential error'); return value;
  }, set: async (id, value) => { secrets.set(id, value); }, remove: async id => { secrets.delete(id); } };
  return { directory, secrets, credentials, settings: new ModelSettings(directory, credentials),
    cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('model configuration stages secrets in credential store, never metadata or status', async () => {
  const f = await fixture();
  try {
    assert.equal(Object.hasOwn(await f.settings.status(),'allow_table_data'), false);
    assert.equal((await f.settings.status()).context_tokens, 512000);
    assert.equal((await f.settings.status()).reasoning_effort, 'high');
    const status = await f.settings.save({ model: 'deepseek-flash', api_key: 'SYNTHETIC_KEY_1' });
    assert.equal(status.configured, true); assert.equal(status.authentication_verified, false);
    assert.equal(Object.hasOwn(status, 'context_window'), false);
    assert.equal(status.key_source, 'windows_credentials');
    assert.equal(JSON.stringify(status).includes('SYNTHETIC_KEY_1'), false);
    const metadata = await readFile(join(f.directory, 'agent/model.json'), 'utf8');
    assert.equal(metadata.includes('SYNTHETIC_KEY_1'), false);
    assert.equal((await f.settings.resolve()).apiKey, 'SYNTHETIC_KEY_1');
    assert.equal((await new ModelSettings(f.directory, f.credentials).resolve()).apiKey, 'SYNTHETIC_KEY_1');
    assert.ok([...f.secrets.keys()][0].startsWith('agent:deepseek:'));
    await f.settings.save({ model: 'deepseek-v4-pro', api_key: '' });
    await f.settings.save({ model: 'deepseek-v4-pro', reasoning_effort: 'high' });
    assert.equal((await new ModelSettings(f.directory, f.credentials).resolve()).reasoningEffort, 'high');
    assert.equal((await new ModelSettings(f.directory, f.credentials).resolve()).contextTokens, 512000);
    await assert.rejects(f.settings.save({ model: 'deepseek-flash', context_tokens: 1000001 }));
    assert.equal((await f.settings.resolve()).apiKey, 'SYNTHETIC_KEY_1');
    assert.equal((await f.settings.status()).model, 'deepseek-v4-pro');
    const legacy=JSON.parse(await readFile(join(f.directory,'agent/model.json'),'utf8'));
    await writeFile(join(f.directory,'agent/model.json'),JSON.stringify({...legacy,allow_table_data:true}));
    await assert.rejects(f.settings.save({ model: 'deepseek-v4-pro', allow_table_data: true }));
    await f.settings.save({ model: 'deepseek-flash' });
    assert.equal(Object.hasOwn(JSON.parse(await readFile(join(f.directory,'agent/model.json'),'utf8')),'allow_table_data'),false);
    const switched=await f.settings.resolve();
    assert.equal(switched.contextTokens,512000);assert.equal(switched.apiKey,'SYNTHETIC_KEY_1');assert.equal(switched.reasoningEffort,'high');
    await assert.rejects(f.settings.save({ model: 'deepseek-flash', reasoning_effort: 'medium' }));
    await f.settings.save({ model: 'deepseek-flash', api_key: 'SYNTHETIC_KEY_2' });
    assert.equal(f.secrets.size, 1);
    assert.equal([...f.secrets.values()][0], 'SYNTHETIC_KEY_2');
    assert.equal(Object.hasOwn(await f.settings.status(),'allow_table_data'), false);
  } finally { await f.cleanup(); }
});

test('context presets persist and unsupported legacy thresholds fall back to 512K', async () => {
  const f = await fixture();
  try {
    await f.settings.save({model:'deepseek-flash',api_key:'SYNTHETIC_CONTEXT_KEY'});
    const path = join(f.directory,'agent/model.json');
    const saved = JSON.parse(await readFile(path,'utf8'));
    const {reasoning_effort:_reasoning,...withoutReasoning} = saved;
    await writeFile(path,JSON.stringify(withoutReasoning));
    assert.equal((await f.settings.resolve()).reasoningEffort,'high');
    await writeFile(path,JSON.stringify({...saved,context_tokens:160000,reasoning_effort:'off'}));
    const legacy = await f.settings.resolve();
    assert.equal(legacy.contextTokens,512000);
    assert.equal(legacy.reasoningEffort,'low');
    assert.equal(legacy.apiKey,'SYNTHETIC_CONTEXT_KEY');
    await assert.rejects(f.settings.save({model:'deepseek-flash',context_tokens:160000}));
    await assert.rejects(f.settings.save({model:'deepseek-flash',reasoning_effort:'off'}));
    await f.settings.save({model:'deepseek-v4-pro',reasoning_effort:'max'});
    const migrated = JSON.parse(await readFile(path,'utf8'));
    assert.equal(migrated.context_tokens,512000);
    assert.equal(migrated.reasoning_effort,'max');
    assert.equal((await f.settings.resolve()).apiKey,'SYNTHETIC_CONTEXT_KEY');
    for (const context_tokens of [128000,1000000]) {
      await f.settings.save({model:'deepseek-v4-pro',context_tokens});
      assert.equal((await new ModelSettings(f.directory,f.credentials).resolve()).contextTokens,context_tokens);
    }
  } finally { await f.cleanup(); }
});

test('credential failure leaves previous metadata and usable secret intact without exposing error text', async () => {
  const f = await fixture();
  try {
    await f.settings.save({ model: 'deepseek-flash', api_key: 'ORIGINAL_KEY' });
    const before = await readFile(join(f.directory, 'agent/model.json'), 'utf8');
    const broken = new ModelSettings(f.directory, { ...f.credentials, set: async () => { throw new Error('NEW_KEY'); } });
    await assert.rejects(broken.save({ model: 'deepseek-v4-pro', api_key: 'NEW_KEY' }), error => {
      assert.equal((error as Error).message.includes('NEW_KEY'), false);
      return (error as { code?: string }).code === 'MODEL_CREDENTIAL_STORE_FAILED';
    });
    assert.equal(await readFile(join(f.directory, 'agent/model.json'), 'utf8'), before);
    f.secrets.clear();
    assert.equal((await f.settings.status()).configured, false);
    assert.equal((await f.settings.status()).key_source, 'unavailable');
  } finally { await f.cleanup(); }
});

test('stored model key is redacted from task prompts, output and persisted history', async () => {
  const f = await fixture();
  const store = new ConfigStore(f.directory);
  const config = await store.load();
  const connectionId = '11111111-1111-4111-8111-111111111111';
  config.connections.push({ connection_id: connectionId, name: 'FIXTURE', base_url: 'https://sap.test', client: '100',
    username: 'TEST', language: 'EN', write_enabled: false }); await store.save(config);
  await f.settings.save({ model: 'deepseek-flash', api_key: 'STORED_PRIVATE_KEY', context_tokens: 1000000 });
  const runtime = new AgentRuntime(store, { settings: f.settings, model: async (messages,_tools,_signal,onText) => {
    assert.equal(JSON.stringify(messages).includes('STORED_PRIVATE_KEY'), false);
    onText('这是 STORED_PRIVATE_');
    assert.equal(runtime.liveSnapshot(runtimeId!).text,'这是 ');
    onText('KEY 的合成验证。');
    assert.equal(runtime.liveSnapshot(runtimeId!).text.includes('STORED_PRIVATE_KEY'),false);
    return { message: { role: 'assistant', content: '这是 STORED_PRIVATE_KEY 的合成验证。' } };
  } });
  let runtimeId: string | undefined;
  try {
    await runtime.initialize();
    const task = await runtime.create('分析 STORED_PRIVATE_KEY', connectionId);
    runtimeId=task.id;
    for (let i = 0; i < 200; i++) {
      const current = await runtime.tasks.get(task.id);
      if (current.status === 'completed') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal((await runtime.tasks.get(task.id)).status, 'completed');
    assert.equal((await runtime.tasks.get(task.id)).context_tokens, 1000000);
    assert.equal((await readFile(join(f.directory, 'agent/tasks', task.id + '.json'), 'utf8')).includes('STORED_PRIVATE_KEY'), false);
  } finally { await runtime.close(); await f.cleanup(); }
});

test('model settings API requires local authentication and never returns stored key material', async () => {
  const f = await fixture();
  const host = await startAdmin(new ConfigStore(f.directory), f.credentials, 0);
  const url = new URL(host.url), origin = url.origin;
  const headers = { 'X-Admin-Token': url.hash.slice(1), Origin: origin, 'Content-Type': 'application/json' };
  const body = JSON.stringify({ model: 'deepseek-flash', api_key: 'API_SYNTHETIC_SECRET' });
  try {
    assert.equal((await fetch(origin + '/api/agent/model')).status, 401);
    assert.equal((await fetch(origin + '/API/agent/model', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body })).status, 401);
    assert.equal((await fetch(origin + '/api/agent/model', { method: 'PUT', headers: { ...headers, Origin: 'https://evil.test' }, body })).status, 403);
    const saved = await fetch(origin + '/api/agent/model', { method: 'PUT', headers, body });
    assert.equal(saved.status, 200);
    assert.equal((await saved.text()).includes('API_SYNTHETIC_SECRET'), false);
    const status = await (await fetch(origin + '/api/agent/model', { headers })).json();
    assert.equal(status.configured, true); assert.equal(Object.hasOwn(status, 'api_key'), false);
    assert.equal(Object.hasOwn(status, 'context_window'), false);
    const agentStatus = await (await fetch(origin + '/api/agent/status', { headers })).json();
    assert.equal(Object.hasOwn(agentStatus, 'context_window'), false);
    assert.equal((await f.settings.resolve()).apiKey, 'API_SYNTHETIC_SECRET');
  } finally { await host.close(); await f.cleanup(); }
});
