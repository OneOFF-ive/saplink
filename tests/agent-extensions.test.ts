import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir,mkdtemp,readFile,rm,writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { zipSync,strToU8 } from 'fflate';
import { AgentRuntime } from '../src/agent/runtime.js';
import { ConfigStore } from '../src/config.js';
import { prepareSkillPackage } from '../src/agent/skill-packages.js';
import { skillCreatorId } from '../src/agent/builtin-skills.js';

test('skill ZIP preserves assets and rejects paths outside the package', () => {
  const encode = (files:Record<string,Uint8Array>) => Buffer.from(zipSync(files)).toString('base64');
  const main = strToU8('---\nname: review-checklist\ndescription: "Review ABAP"\n---\nRead references/check.md.');
  const binary = Uint8Array.of(0,1,255);
  const skill = prepareSkillPackage({format:'zip',data:encode({
    'sample/SKILL.md':main,'sample/references/check.md':strToU8('Check authorization.'),'sample/assets/sample.bin':binary
  })});
  assert.equal(skill.name,'review-checklist');
  assert.equal(skill.description,'Review ABAP');
  assert.equal(skill.files.find(file=>file.path==='assets/sample.bin')?.data,Buffer.from(binary).toString('base64'));
  assert.throws(()=>prepareSkillPackage({format:'zip',data:encode({'SKILL.md':main,'../escape.txt':main})}),/无效的文件路径/);
  assert.throws(()=>prepareSkillPackage({format:'zip',data:encode({'SKILL.md':main,'skill.md':main})}),/重名文件/);
  assert.throws(()=>prepareSkillPackage({format:'zip',data:encode({'SKILL.md':main,'assets':binary,'assets/sample.bin':binary})}),/同名的文件和目录/);
  assert.throws(()=>prepareSkillPackage({format:'zip',data:encode({'readme.md':main})}),/根目录 SKILL.md/);
});

test('enabled skills reach the assistant and custom MCP executes only discovered read-only tools', async () => {
  const root = resolve('.saplink/tests');
  await mkdir(root,{recursive:true});
  const directory = await mkdtemp(join(root,'extensions-'));
  const credentials = new Map<string,string>(), dispatched:string[] = [];
  const app = express();
  app.use(express.json());
  app.post('/mcp',async(req,res)=>{
    assert.equal(req.get('authorization'),'Bearer MCP_TEST_TOKEN');
    const mcp = new McpServer({name:'fixture',version:'1.0.0'});
    for (const [name,readOnlyHint] of [['lookup_example',true],['write_example',false],['read_source',true]] as const) {
      mcp.registerTool(name,{inputSchema:{query:z.string()},annotations:{readOnlyHint}},async ({query})=>{
        dispatched.push(name);
        return {content:[{type:'text',text:query+' fixture response MCP_TEST_TOKEN'}]};
      });
    }
    const transport = new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
    try { await mcp.connect(transport); await transport.handleRequest(req,res,req.body); }
    finally { await mcp.close(); }
  });
  const host = await new Promise<ReturnType<typeof app.listen>>(resolve=>{
    const listener = app.listen(0,'127.0.0.1',()=>resolve(listener));
  });
  const address = host.address();
  assert.ok(address&&typeof address!=='string');
  const store = new ConfigStore(directory), connectionId = randomUUID(), serverId = randomUUID(), skillId = randomUUID();
  const config = await store.load();
  config.connections.push({connection_id:connectionId,name:'Fixture',base_url:'https://sap.test',client:'100',username:'TEST',language:'ZH',write_enabled:false});
  await store.save(config);
  const runtime = new AgentRuntime(store,{
    credentials:{get:async id=>credentials.get(id)!,set:async(id,value)=>{credentials.set(id,value);},remove:async id=>{credentials.delete(id);}},
    model:async(messages,tools)=>{
      assert.match(messages[0].content!,/按扩展样例分析/);
      assert.doesNotMatch(JSON.stringify(messages),/MCP_TEST_TOKEN/);
      assert.ok(tools.some(tool=>tool.function.name==='call_custom_mcp_tool'));
      const results = messages.filter(message=>message.role==='tool');
      if (results.length===3) return {message:{role:'assistant',content:'扩展执行完成'}};
      if (results.length===1) {
        assert.match(results[0].content!,/lookup_example/);
        assert.doesNotMatch(results[0].content!,/write_example|read_source/);
      }
      const name = results.length ? 'call_custom_mcp_tool' : 'list_custom_mcp_tools';
      const args = {server_id:serverId,...(results.length?{tool:results.length===1?'write_example':'lookup_example',arguments:{query:'public'}}:{})};
      return {message:{role:'assistant',content:null,tool_calls:[{id:randomUUID(),type:'function',
        function:{name,arguments:JSON.stringify(args)}}]}};
    }
  });
  try {
    await runtime.initialize();
    const extensionsFile = join(directory,'agent','extensions.json');
    await mkdir(join(directory,'agent'),{recursive:true});
    await writeFile(extensionsFile,JSON.stringify({skills:[],mcp:[],builtin_disabled:[skillCreatorId]}));
    const builtins = (await runtime.extensions.view()).skills.filter(entry=>'builtin' in entry);
    assert.deepEqual(builtins.map(entry=>entry.name),['技能生成','SapLink']);
    assert.ok(builtins.every(entry=>entry.enabled));
    const creator = builtins[0];
    await assert.rejects(runtime.extensions.setSkillEnabled(creator.id,false),{code:'AGENT_SKILL_BUILTIN'});
    await runtime.extensions.references({skills:[creator.id],mcp:[]});
    await assert.rejects(runtime.extensions.remove('skills',creator.id),{code:'AGENT_SKILL_BUILTIN'});
    await runtime.extensions.setSkillEnabled(creator.id,true);
    await runtime.extensions.saveSkill(skillId,{name:'样例 Skill',body:'按扩展样例分析',enabled:true});
    const view = await runtime.extensions.saveMcp(serverId,{name:'测试 MCP',url:`http://127.0.0.1:${address.port}/mcp`,token:'MCP_TEST_TOKEN',enabled:true});
    assert.equal(view.mcp[0].has_token,true);
    const stopped = await runtime.extensions.setMcpEnabled(serverId,false);
    assert.deepEqual(stopped.mcp[0],{...view.mcp[0],enabled:false});
    await runtime.extensions.setMcpEnabled(serverId,true);
    assert.equal(credentials.size,1);
    assert.doesNotMatch(await readFile(extensionsFile,'utf8'),/MCP_TEST_TOKEN|builtin_disabled/);
    const listed = await runtime.extensions.listMcp(serverId,AbortSignal.timeout(5000),true);
    assert.deepEqual(listed.map(tool=>tool.name),['lookup_example']);
    const created = await runtime.create('执行扩展样例',connectionId,'chat');
    let task = await runtime.tasks.get(created.id);
    for (let i=0;i<100 && ['queued','running'].includes(task.status);i++) {
      await new Promise(resolve=>setTimeout(resolve,30));
      task = await runtime.tasks.get(created.id);
    }
    assert.equal(task.status,'completed',JSON.stringify(task.error));
    assert.deepEqual(dispatched,['lookup_example']);
    assert.ok(task.events.some(event=>event.tool==='call_custom_mcp_tool' && event.type==='tool_failed'));
    assert.doesNotMatch(JSON.stringify(task),/MCP_TEST_TOKEN/);
    await runtime.extensions.remove('mcp',serverId);
    assert.equal(credentials.size,0);
  } finally {
    await runtime.close();
    await new Promise<void>(resolve=>host.close(()=>resolve()));
    await rm(directory,{recursive:true,force:true});
  }
});
