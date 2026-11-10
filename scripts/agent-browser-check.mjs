import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm, readFile } from 'node:fs/promises';
import { zipSync,unzipSync,strToU8,strFromU8 } from 'fflate';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import { ConfigStore } from '../dist/config.js';
import { startAdmin } from '../dist/admin.js';
import { TaskStore } from '../dist/agent/task-store.js';
import { sourceResult } from '../dist/adt.js';
import { AppError } from '../dist/errors.js';
import { AuditLog } from '../dist/audit.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = join(process.cwd(), '.saplink', 'agent-browser'); await mkdir(root, { recursive: true });
const directory = await mkdtemp(join(root, 'fixture-'));
const store = new ConfigStore(directory);
const connectionId = '11111111-1111-4111-8111-111111111111';
const config = await store.load();
config.connections.push({ connection_id: connectionId, name: '开发系统_FIXTURE', base_url: 'https://sap.test',
  client: '100', username: 'TEST', language: 'ZH', write_enabled: false, allow_table_data:false });
config.connections.push({ ...config.connections[0], connection_id: '22222222-2222-4222-8222-222222222222', name: '其他系统_FIXTURE' });
await store.save(config);
const secrets = new Map();
const credentials = { get: async id => { if (!secrets.has(id)) throw new Error('Missing'); return secrets.get(id); },
  set: async (id, value) => { secrets.set(id, value); }, remove: async id => { secrets.delete(id); } };
let continueSlow = false;
let includeAttack = true;
let fixtureSource = 'REPORT zdemo.\nWRITE 3.\n';
let fixtureInactive;
let fixtureQualityRuns = 0;
let workflowSaveGate, workflowSaveStarted, releaseWorkflowSave = () => {};
let workflowUncertain = false;
let mcpTestPort;
const model = async (messages, _tools, signal, onText) => {
  if (messages[1].content.startsWith('MCP 管理测试：')) {
    const commands = {
      'MCP 管理测试：添加':{action:'add',name:'对话添加样例',url:'https://example.com/mcp'},
      'MCP 管理测试：启动':{action:'start',port:mcpTestPort},
      'MCP 管理测试：停止':{action:'stop'},
      'MCP 管理测试：状态':{action:'status'}
    };
    const input = commands[messages[1].content];
    const result = messages.find(message=>message.role==='tool');
    if (result) {
      const {data,status} = JSON.parse(result.content);
      assert.equal(status,'success');
      if (input.action==='status') assert.deepEqual(data,{running:true,port:mcpTestPort});
      else assert.equal(data.confirmation_required,true);
      return {message:{role:'assistant',content:input.action==='status'?'对外服务正在运行。':'请确认 MCP 变更。'}};
    }
    const name = input.action==='status'?'inspect_mcp_services':'propose_mcp_change';
    assert.ok(_tools.some(tool=>tool.function.name===name));
    return {message:{role:'assistant',content:null,tool_calls:[{id:randomUUID(),type:'function',
      function:{name,arguments:JSON.stringify(input)}}]}};
  }
  if (messages[1].content==='为采购检查创建一个技能') {
    assert.ok(_tools.some(tool=>tool.function.name==='draft_skill_package'));
    const results = messages.filter(message=>message.role==='tool');
    const creator = /"id":"([^"]+)","name":"技能生成"/.exec(messages[0].content)[1];
    if (!results.length) return {message:{role:'assistant',content:null,tool_calls:[{id:randomUUID(),type:'function',
      function:{name:'read_skill_file',arguments:JSON.stringify({skill_id:creator,path:'SKILL.md'})}}]}};
    if (results.length===1) return {message:{role:'assistant',content:null,tool_calls:[{id:randomUUID(),type:'function',
      function:{name:'draft_skill_package',arguments:JSON.stringify({files:[
        {path:'SKILL.md',text:'---\nname: po-review\ndescription: 检查采购订单\n---\n读取 docs/checklist.md'},
        {path:'docs/checklist.md',text:'核对数量和供应商。'}
      ]})}}]}};
    return {message:{role:'assistant',content:'采购检查技能包已生成。'}};
  }
  if (messages[1].content==='本地工作测试') {
    if (messages.some(message=>message.role==='tool')) return {message:{role:'assistant',content:'文档已生成，脚本等待审核。'}};
    return {message:{role:'assistant',content:null,tool_calls:[
      {id:randomUUID(),type:'function',function:{name:'propose_local_script',arguments:JSON.stringify({
        title:'生成测试文本',runtime:'node',outputs:['result.txt'],
        script:"import { writeFileSync } from 'node:fs'; writeFileSync('output/result.txt','本地脚本结果'); console.log('运行正常');"
      })}},
      {id:randomUUID(),type:'function',function:{name:'create_local_document',arguments:JSON.stringify({
        filename:'本地报告.docx',title:'本地文档',sections:[{heading:'验证结果',paragraphs:['这是生成的正文。']}]
      })}}
    ]}};
  }
  const recoveryIndex = messages.findLastIndex(message=>message.role==='user'&&message.content==='根据本次保存结果重新生成草稿。');
  if (recoveryIndex>=0) {
    const receipt = messages.slice(recoveryIndex+1).find(message=>message.role==='tool');
    if (receipt) {
      assert.match(receipt.content,/"attempt_id"|attempt_id/);
      assert.match(receipt.content,/evidence_artifact/);
      return {message:{role:'assistant',content:'已收到本次保存回执。'}};
    }
    assert.match(messages[0].content,/仅生成本机草稿/);
    const evidence = messages.findLast(message=>message.content?.startsWith('本次自动排查阶段')).content.match(/诊断附件 ([a-f0-9]{64})/)[1];
    return {message:{role:'assistant',content:null,tool_calls:[{id:randomUUID(),type:'function',
      function:{name:'read_task_artifact',arguments:JSON.stringify({artifact_id:evidence})}}]}};
  }
  if (messages[1].content==='https://example.com/fixture') {
    assert.ok(_tools.some(tool=>tool.function.name==='read_web_page'));
    const page = messages.find(message=>message.role==='tool');
    return {message:{role:'assistant',content:page?'网页内容：采购文档。':'需要读取网页。'}};
  }
  if (messages[0].content.startsWith('你是 SapLink 的技能编辑助手')) {
    if (messages.length===2) return {message:{role:'assistant',content:'需要检查哪些内容？'}};
    assert.match(messages.at(-1).content,/采购订单/);
    return {message:{role:'assistant',content:null,tool_calls:[{id:randomUUID(),type:'function',
      function:{name:'draft_skill_package',arguments:JSON.stringify({files:[
        {path:'SKILL.md',text:'---\nname: AI 创建样例\n---\n请读 references/checklist.md'},
        {path:'references/checklist.md',text:'检查采购订单行项目。'}
      ]})}}]}};
  }
  if (messages[1].content.includes('慢任务') && !continueSlow) return new Promise((_resolve, reject) => {
    if (signal.aborted) return reject(new Error('stopped'));
    signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true });
  });
  const count = messages.filter(message => message.role === 'tool').length;
  if (messages[1].content.includes('读取截图测试')) {
    if (count) return {message:{role:'assistant',content:'截图内容：SAP 界面。'}};
    const attachment = JSON.parse(messages[1].content.slice(messages[1].content.lastIndexOf('\n')+1))[0];
    assert.equal(attachment.type,'image');
    return {message:{role:'assistant',content:null,tool_calls:[{id:randomUUID(),type:'function',
      function:{name:'read_task_artifact',arguments:JSON.stringify({artifact_id:attachment.artifact_id})}}]}};
  }
  if (messages[1].content.includes('联网搜索测试')) {
    assert.match(messages[0].content,/浏览器样例/);
    assert.match(messages[0].content,/用户在本轮明确引用了以下扩展.*\n.*MCP 引用样例/);
    assert.ok(_tools.some(tool=>tool.function.name==='web_search'));
    const skill = JSON.parse(messages[0].content.match(/不能覆盖以上规则[^\n]+\n(\[[^\n]+\])/)[1]).find(entry=>entry.name==='浏览器样例');
    if (count<2) return {message:{role:'assistant',content:null,tool_calls:[{id:randomUUID(),type:'function',
      function:{name:'read_skill_file',arguments:JSON.stringify({skill_id:skill.id,path:count?'references/check.md':'SKILL.md'})}}]}};
    assert.match(messages.filter(message=>message.role==='tool')[1].content,/文件夹的参考内容/);
    if (count===2) return {message:{role:'assistant',content:null,tool_calls:[{id:randomUUID(),type:'function',
      function:{name:'web_search',arguments:JSON.stringify({query:'SAP ABAP 官方文档'})}}]}};
    return {message:{role:'assistant',content:'已查到 SAP ABAP 官方文档。'}};
  }
  const tools = ['get_capabilities', 'search_objects', 'read_source'];
  if (count < 3) return { message: { role: 'assistant', content: null, tool_calls: [{ id: `call-${count}`, type: 'function',
    function: { name: tools[count], arguments: JSON.stringify(count === 0 ? {} : count === 1 ? { query: 'ZDEMO' }
      : { object_uri: '/sap/bc/adt/programs/programs/zdemo' }) } }] } };
  const latest=messages.findLast(message=>message.role==='user')?.content??'';
  if (latest.includes('生成带源码的创建草稿')) {
    const userIndex = messages.findLastIndex(message => message.role === 'user');
    const completed = messages.slice(userIndex + 1).some(message => message.role === 'tool' && message.content?.includes('"workflow_id"'));
    if (!completed) return {message:{role:'assistant',content:null,tool_calls:[{id:randomUUID(),type:'function',
      function:{name:'propose_program_workflow',arguments:JSON.stringify({action:'create_program',
        name:'ZPLAN_FIXTURE',description:'修改计划测试',package_name:'$TMP',source:'REPORT zplan_fixture.\nWRITE 1.'})}}]}};
    return {message:{role:'assistant',content:'创建操作已加入修改计划。'}};
  }
  if (latest.includes('生成任务计划')) {
    const userIndex = messages.findLastIndex(message => message.role === 'user');
    const completed = messages.slice(userIndex + 1).some(message => message.role === 'tool' && message.content?.includes('"workflow_id"'));
    if (!completed) {
      const uri = '/sap/bc/adt/programs/programs/zdemo';
      const baseline = sourceResult(connectionId, uri, uri + '/source/main', fixtureSource, 'active');
      return { message: { role:'assistant', content:null, tool_calls:[{ id:randomUUID(), type:'function',
        function:{ name:'propose_program_workflow', arguments:JSON.stringify({ action:'update_source', object_uri:uri,
          source_uri:baseline.source_uri, version:'active', expected_revision:baseline.revision,
          source:'REPORT zdemo.\nWRITE 9.\n', syntax_check:true, activate:true }) } }] } };
    }
    return { message: { role:'assistant', content:'任务计划已生成，等待审核。' } };
  }
  if (latest.includes('生成ATC操作草稿')) {
    const userIndex = messages.findLastIndex(message => message.role === 'user');
    const completed = messages.slice(userIndex + 1).some(message => message.role === 'tool' && message.content?.includes('"operation_id"'));
    if (!completed) return { message: { role:'assistant', content:null, tool_calls:[{ id:randomUUID(), type:'function',
      function:{ name:'propose_controlled_operation', arguments:JSON.stringify({ tool:'run_atc',
        input:{ object_uri:'/sap/bc/adt/programs/programs/zdemo', check_variant:'DEFAULT' } }) } }] } };
    return { message: { role:'assistant', content:'操作草稿已生成，等待用户审批。' } };
  }
  if (latest.includes('生成源码草稿')) {
    const userIndex = messages.findLastIndex(message => message.role === 'user');
    const completed = messages.slice(userIndex + 1).some(message => message.role === 'tool' && message.content?.includes('"change_id"'));
    if (!completed) {
      const read = messages.findLast(message => message.role === 'tool' && message.content?.includes('"source_uri"'));
      const artifact = JSON.parse(read.content)._task_artifact.artifact_id;
      return { message: { role:'assistant', content:null, tool_calls:[{ id:randomUUID(), type:'function',
        function:{ name:'propose_source_change', arguments:JSON.stringify({ source_artifact_id:artifact, summary:'修改输出',
          edits:[{ old_text:'WRITE 3.', new_text:'WRITE 4. " <img src=x onerror="window.AGENT_XSS=true">' }] }) } }] } };
    }
    return { message: { role:'assistant', content:'草稿已生成，尚未写入 SAP。' } };
  }
  let content = messages[0].content.includes('22222222-2222-4222-8222-222222222222')?'# 其他系统报告\n仅属于其他系统的分析内容。'
    : latest.includes('继续说明刚才的程序')?'这是普通追问回答。'
    : latest.includes('新建一份独立分析报告')?'## 完整结论\n这是独立报告内容。'
    : latest.includes('更新这份报告')?'# 更新后的报告\n这是报告第二版。'
    : '## 对象\n### 已定位关键对象\n| 对象 | 类型 | 用途 | 关联 |\n| --- | --- | --- | --- |\n| ZDEMO | ABAP程序 | 示例程序 | MM |\n| MARA | 标准表 | 物料 | MM |\n\n## 完整结论\n# 分析结果\nZDEMO 的默认次数为 3。\n' +
    (includeAttack ? '<img src=x onerror="window.AGENT_XSS=true">\n' : '') + '\n**结论**：使用 `WRITE` 输出。\n\n- 第一项\n- 第二项\n\n> 已读取源码。\n\n```abap\nWRITE 3.\n```\n\n## 调用链\n### 核心调用链\n1. 入口 ZDEMO\n2. 显示结果\n\n### 依赖关系\n| 当前对象 | 直接依赖 | 间接依赖 | 影响 |\n| --- | --- | --- | --- |\n| ZDEMO | MARA | 未核实 | 未核实 |\n\n## 业务解读\n### 业务流程\n1. 输入条件\n2. 输出数据\n\n### 业务解释\n示例业务说明。\n\n## 影响分析\n### 影响范围\n| 对象 | 建议 | 原因 |\n| --- | --- | --- |\n| ZDEMO | 验证输出 | 输出规则 |\n\n### 回归范围\n- 正常输出\n- 空结果\n\n## 改造建议\n### 建议改造\n```diff\n- WRITE 3.\n+ WRITE 4.\n```';
  content=content.replace('## 影响分析\n### 影响范围','## 影响分析\n### 影响摘要\n| 指标 | 结果 |\n| --- | --- |\n| 直接修改对象 | 2 |\n| 关联对象 | 7 |\n| 需回归接口 | 3 |\n| 风险等级 | 中 |\n\n### 影响范围');
  const userIndex=messages.findLastIndex(message=>message.role==='user');
  const published=messages.slice(userIndex+1).some(message=>message.role==='tool'&&message.content?.includes('"report_id"'));
  if(latest.includes('更新这份报告')&&!published){
    const target=messages.find(message=>message.content?.startsWith('当前查看的报告资料'));
    const reportId=JSON.parse(target.content.slice(target.content.indexOf('\n')+1)).report_id;
    return {message:{role:'assistant',content:null,tool_calls:[{id:randomUUID(),type:'function',function:{name:'update_report',arguments:JSON.stringify({report_id:reportId,content})}}]}};
  }
  if(_tools.some(tool=>tool.function.name==='create_report')&&!latest.includes('继续说明刚才的程序')&&!published){
    return {message:{role:'assistant',content:null,tool_calls:[{id:randomUUID(),type:'function',function:{name:'create_report',arguments:JSON.stringify({title:'示例分析报告',content})}}]}};
  }
  onText(content.slice(0,20));await new Promise(resolve=>setTimeout(resolve,600));
  signal.throwIfAborted();onText(content.slice(20));await new Promise(resolve=>setTimeout(resolve,600));
  return { message: { role: 'assistant', content } };
};
const backend = connection => ({
  capabilities: async () => ({}), packageOf: async () => '$TMP', lock: async () => 'fixture-lock',
  unlock: async () => {}, close: async () => {},
  quality: async () => { fixtureQualityRuns++; return { run_id:'RUN_BROWSER', submission:'accepted' }; },
  read: async (uri, version) => {
    const text = version === 'active' ? fixtureSource : fixtureInactive;
    if (text === undefined) throw new AppError('VERSION_UNAVAILABLE', 'No inactive source');
    return sourceResult(connection.connection_id, uri, uri + '/source/main', text, version);
  },
  check: async () => ({passed:true}),
  save: async (_uri, text) => {
    if (workflowSaveGate) { workflowSaveStarted?.(); await workflowSaveGate; }
    fixtureInactive = text;
    if (workflowUncertain) throw new AppError('OUTCOME_UNKNOWN', '模拟保存连接中断');
  }
});
const host = await startAdmin(store, credentials, 0, backend, undefined, { agent: { model, audit: new AuditLog(join(directory, 'test-logs')),
  pageReader:async url=>({status:'success',data:{url,title:'网页测试来源',text:'采购文档。',truncated:false}}),
  searchRequest:async (url,options)=>{
    assert.equal(url,'https://api.deepseek.com/v1/tools/search');
    assert.deepEqual(JSON.parse(options.body),{query:'SAP ABAP 官方文档',count:5,need_content:false});
    return Response.json({results:[{title:'SAP Help Portal',url:'https://help.sap.com/docs/abap',summary:'ABAP 文档'}]});
  },
  imageRequest:async (url,options)=>{
    assert.equal(url,'https://api.deepseek.com/chat/completions');
    const request = JSON.parse(options.body);
    assert.equal(request.model,'deepseek-flash');
    assert.match(request.messages[1].content[1].image_url.url,/^data:image\/png;base64,/);
    const frame = (delta,finish_reason)=>'data: '+JSON.stringify({choices:[{index:0,delta,finish_reason}]})+'\n\n';
    return new Response(frame({content:'SAP 界面'},null)+frame({},'stop')+'data: [DONE]\n\n',
      {headers:{'Content-Type':'text/event-stream'}});
  },
  execute: async (name, input) => { await new Promise(resolve => setTimeout(resolve, 40));
    const uri = '/sap/bc/adt/programs/programs/zdemo';
    const data = name === 'read_source'
      ? sourceResult(input.connection_id, uri, uri + '/source/main', fixtureSource, 'active')
      : { synthetic: true };
    return { operation_id: 'fixture-read', status: 'success', data }; } } });
let browser;
async function selectAgentConnection(page, id) {
  await page.locator('#agent-connection-picker').click();
  await page.locator('#agent-connection-menu button[data-value="'+id+'"]').click();
}
try {
  browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const legacyConfig=await store.load();delete legacyConfig.connections[0].allow_table_data;await store.save(legacyConfig);
  const legacyPage=await browser.newPage({viewport:{width:1440,height:1000}});
  await legacyPage.goto(host.url);
  await legacyPage.locator('#agent-data-policy').filter({hasText:'表数据访问已开启'}).waitFor();
  await legacyPage.locator('#agent-connections').click();
  await legacyPage.locator('#connection-rows tr').filter({hasText:'开发系统_FIXTURE'}).getByRole('button',{name:'编辑连接'}).click();
  assert.equal(await legacyPage.getByText('允许访问表数据', {exact:true}).isVisible(),true);
  assert.equal(await legacyPage.getByText('控制此连接的表数据查询工具', {exact:false}).count(),0);
  assert.equal(await legacyPage.locator('#connection-form select[name="transport"]').isDisabled(),true);
  assert.equal(await legacyPage.locator('#connection-form input[name="base_url"]').isDisabled(),true);
  assert.equal(await legacyPage.locator('#connection-form input[name="client"]').isEnabled(),true);
  assert.equal(await legacyPage.locator('#target-locked-hint').isVisible(),true);
  const legacyPermission=legacyPage.locator('#connection-form input[name="allow_table_data"]');
  const policy=legacyPage.locator('#connection-form input[name="write_enabled"]');
  assert.equal(await legacyPermission.isChecked(),true);
  assert.equal(await policy.isChecked(),false);
  assert.equal(await legacyPage.locator('#connection-form select[name="write_policy"]').count(),0);
  await policy.check();
  await legacyPage.locator('#connection-form input[name="client"]').fill('002');
  await legacyPage.locator('#connection-form input[name="password"]').fill('fixture-password');
  await legacyPermission.uncheck();await legacyPage.locator('#connection-form button[type=submit]').click();
  await legacyPage.locator('#connection-dialog').waitFor({state:'hidden'});
  assert.equal((await store.load()).connections[0].allow_table_data,false);
  assert.equal((await store.load()).connections[0].write_enabled,true);
  assert.equal(Object.hasOwn((await store.load()).connections[0],'write_governance'),false);
  await legacyPage.locator('#connection-rows tr').filter({hasText:'开发系统_FIXTURE'}).getByRole('button',{name:'编辑连接'}).click();
  assert.equal(await policy.isChecked(),true);
  await legacyPage.locator('#connection-form input[name="client"]').fill('100');
  await legacyPage.locator('#connection-form input[name="password"]').fill('fixture-password');
  await policy.uncheck();await legacyPage.locator('#connection-form button[type=submit]').click();
  await legacyPage.locator('#connection-dialog').waitFor({state:'hidden'});
  assert.equal((await store.load()).connections[0].write_enabled,false);
  await legacyPage.locator('#add-connection').click();
  assert.equal(await legacyPage.locator('#connection-form select[name="transport"]').isEnabled(),true);
  assert.equal(await legacyPage.locator('#connection-form input[name="rfc_ashost"]').isEnabled(),true);
  await legacyPage.locator('#connection-dialog .close-dialog').click();
  const rfcId=randomUUID();
  const rfcConfig=await store.load();
  rfcConfig.connections.push({connection_id:rfcId,name:'RFC_FIXTURE',base_url:'http://rfc.invalid',
    client:'100',username:'TEST',language:'EN',write_enabled:false,allow_table_data:true,
    rfc:{ashost:'sap.test',sysnr:'00',saprouter:'/H/router.test/S/3299'}});
  await store.save(rfcConfig);
  await legacyPage.reload();await legacyPage.locator('#agent-connections').click();
  await legacyPage.locator('#connection-rows tr').filter({hasText:'RFC_FIXTURE'}).getByRole('button',{name:'编辑连接'}).click();
  for(const name of ['rfc_ashost','rfc_sysnr','rfc_saprouter'])
    assert.equal(await legacyPage.locator(`#connection-form input[name="${name}"]`).isDisabled(),true);
  assert.equal(await legacyPage.locator('#connection-form input[name="client"]').isEnabled(),true);
  await legacyPage.locator('#connection-form input[name="client"]').fill('200');
  await legacyPage.locator('#connection-form input[name="password"]').fill('fixture-password');
  await legacyPage.locator('#connection-form button[type=submit]').click();
  await legacyPage.locator('#connection-dialog').waitFor({state:'hidden'});
  const afterRfc=await store.load();const savedRfc=afterRfc.connections.find(c=>c.connection_id===rfcId);
  assert.equal(savedRfc.client,'200');assert.equal(savedRfc.allow_table_data,true);
  assert.deepEqual(savedRfc.rfc,{ashost:'sap.test',sysnr:'00',saprouter:'/H/router.test/S/3299'});
  afterRfc.connections=afterRfc.connections.filter(c=>c.connection_id!==rfcId);await store.save(afterRfc);
  secrets.delete(connectionId);secrets.delete(rfcId);
  await legacyPage.close();
  const approvalConfig = await store.load();
  approvalConfig.connections[0].write_enabled = true;
  await store.save(approvalConfig);
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const defaultPage=await browser.newPage({viewport:{width:1440,height:1000}});
  defaultPage.on('pageerror',error=>errors.push(error.message));
  await defaultPage.goto(host.url);
  await defaultPage.locator('.nav.active[data-view="agent"]').waitFor();
  await defaultPage.locator('#agent-connection-picker').filter({hasText:'开发系统_FIXTURE'}).waitFor();
  assert.equal(await defaultPage.locator('#agent-view').isVisible(),true);
  assert.equal(await defaultPage.locator('#connections-view').isVisible(),false);
  await defaultPage.reload();await defaultPage.locator('.nav.active[data-view="agent"]').waitFor();
  const connectionUrl=new URL(host.url);connectionUrl.searchParams.set('view','connections');
  await defaultPage.goto(connectionUrl.href);await defaultPage.locator('.nav.active[data-view="connections"]').waitFor();
  assert.equal(await defaultPage.locator('#agent-view').isVisible(),false);
  await defaultPage.close();
  const emptyPage=await browser.newPage({viewport:{width:1440,height:1000}});
  emptyPage.on('pageerror',error=>errors.push(error.message));
  await emptyPage.route('**/api/state',async route=>{
    const response=await route.fetch(),state=await response.json();state.connections=[];
    await route.fulfill({response,json:state});
  });
  await emptyPage.goto(host.url);await emptyPage.locator('.nav.active[data-view="agent"]').waitFor();
  await emptyPage.locator('#agent-notice').filter({hasText:'先添加一个 SAP 连接'}).waitFor();
  assert.equal(await emptyPage.locator('#agent-send').isDisabled(),true);
  await emptyPage.locator('#agent-connections').click();
  assert.equal(await emptyPage.locator('#connections-view').isVisible(),true);
  await emptyPage.close();
  const previewUrl = new URL(host.url); previewUrl.searchParams.set('view', 'agent'); previewUrl.searchParams.set('dev', '1');
  await page.goto(previewUrl.href);
  await page.locator('.nav.active[data-view="agent"]').waitFor();
  assert.equal(await page.locator('#agent-report-new,#agent-update-report,#agent-report-create').count(),0);
  assert.equal(await page.locator('#agent-progress').isVisible(),false);
  assert.equal(await page.title(), 'SapLink 3.0 · 开发预览');
  await page.locator('#agent-connection-picker').filter({hasText:'开发系统_FIXTURE'}).waitFor();
  await page.locator('#agent-model-label').click();
  await page.locator('#agent-model-dialog').waitFor({state:'visible'});
  assert.equal(await page.locator('#agent-table-data').count(),0);
  await page.screenshot({ path: join(root, 'model-settings.png'), fullPage: true });
  await page.locator('#agent-api-key').fill('SYNTHETIC_BROWSER_KEY');
  assert.equal(await page.locator('#agent-model-dialog details, #agent-model-dialog .field-hint').count(),0);
  assert.equal(await page.locator('#agent-model-dialog select:visible').count(),0);
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.locator('#agent-model-dialog').waitFor({ state: 'hidden' });
  await page.locator('#agent-data-policy').filter({ hasText: '表数据访问未开启' }).waitFor();
  assert.equal(await page.locator('#agent-api-key').inputValue(), '');
  assert.equal(await page.locator('#agent-composer-connection').count(), 0);
  assert.equal(await page.locator('#agent-connection-menu').isHidden(),true);
  assert.equal(await page.locator('#agent-select-target').count(), 0);
  assert.match(await page.locator('#agent-connection-picker').innerText(), /开发系统_FIXTURE · Client 100/);
  await page.locator('#agent-connection-picker').click();
  assert.equal(await page.locator('#agent-connection-menu [aria-pressed=true]').getAttribute('data-value'),connectionId);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#agent-connection-picker').evaluate(button=>button===document.activeElement),true);
  assert.match(await page.locator('#agent-model-label').innerText(), /DeepSeek/);
  assert.match(await page.locator('#agent-model-label').getAttribute('aria-label'), /选择模型/);
  await page.locator('#agent-write-mode').filter({hasText:'受控写入'}).waitFor();
  await page.locator('#agent-write-mode').click();
  assert.equal(await page.locator('#agent-write-menu button').count(),2);
  await page.locator('#agent-write-menu button[data-value="unrestricted"]').click();
  await page.locator('#agent-write-mode span').filter({hasText:'完全写入'}).waitFor();
  await page.reload();
  await page.locator('#agent-write-mode span').filter({hasText:'完全写入'}).waitFor();
  await page.locator('#agent-write-mode').click(); await page.emulateMedia({colorScheme:'dark'});
  await page.waitForTimeout(250);
  await page.locator('#agent-write-menu').screenshot({path:join(root,'client-write-menu-dark.png')});
  await page.keyboard.press('Escape');await page.setViewportSize({width:390,height:844});
  await page.locator('#agent-write-mode').scrollIntoViewIfNeeded();await page.locator('#agent-write-mode').click();
  assert.equal(await page.locator('#agent-write-menu').evaluate(node => node.scrollWidth<=node.clientWidth+1),true);
  assert.equal(await page.locator('#agent-write-menu').evaluate(node => { const rect=node.getBoundingClientRect();return rect.left>=0&&rect.right<=innerWidth&&rect.top>=0&&rect.bottom<=innerHeight; }),true);
  await page.locator('#agent-write-menu').screenshot({path:join(root,'client-write-menu-mobile.png')});
  await page.keyboard.press('Escape'); await page.setViewportSize({width:1440,height:1000}); await page.emulateMedia({colorScheme:'light'});
  await selectAgentConnection(page,'22222222-2222-4222-8222-222222222222');
  await page.locator('#agent-write-mode').waitFor({state:'hidden'});
  await selectAgentConnection(page,connectionId);
  await page.locator('#agent-write-mode span').filter({hasText:'完全写入'}).waitFor();
  await page.locator('#agent-prompt').fill('保留的草稿');
  await page.locator('#agent-model-label').click();
  assert.equal(await page.locator('#agent-model-options button').count(),2);
  assert.equal(await page.locator('#agent-model-menu button[data-value="deepseek-flash"]').getAttribute('aria-pressed'),'true');
  await page.locator('#agent-model-menu button[data-value="deepseek-v4-pro"]').click();
  await page.locator('#agent-model-label span').filter({hasText:'DeepSeek V4 Pro'}).waitFor();
  assert.equal(await page.locator('#agent-prompt').inputValue(),'保留的草稿');
  let savedSettings=JSON.parse(await readFile(join(directory,'agent/model.json'),'utf8'));
  assert.equal(savedSettings.context_tokens,512000);assert.equal(secrets.size,1);
  await page.locator('#agent-model-label').click();await page.keyboard.press('Home');await page.keyboard.press('Enter');
  await page.locator('#agent-model-label span').filter({hasText:'DeepSeek Flash'}).waitFor();
  await page.route('**/api/agent/model',async route=>{
    if(route.request().method()==='PUT')await route.fulfill({status:500,json:{error:{message:'模型切换失败测试'}}});
    else await route.continue();
  });
  await page.locator('#agent-model-label').click();await page.locator('#agent-model-menu button[data-value="deepseek-v4-pro"]').click();
  await page.locator('#agent-poll-error').filter({hasText:'模型切换失败测试'}).waitFor();
  assert.equal(await page.locator('#agent-model-label span').innerText(),'DeepSeek Flash');
  await page.unroute('**/api/agent/model');
  await page.locator('#agent-retry-poll').click();
  await page.waitForFunction(()=>!document.querySelector('#agent-model-label').disabled);
  assert.equal(await page.locator('#agent-prompt').inputValue(),'保留的草稿');
  await page.locator('#agent-prompt').fill('');
  assert.equal(await page.locator('#agent-send').isDisabled(),true);
  await page.locator('#agent-model-tuning').click();
  assert.deepEqual(await page.locator('#agent-reasoning-options button').allTextContents(),['低','中','高']);
  await page.locator('#agent-reasoning-options button[data-value=max]').click();
  await page.locator('#agent-reasoning-value').filter({hasText:/^高$/}).waitFor();
  await page.locator('#agent-context-details summary').click();
  assert.match(await page.locator('#agent-tuning-menu #agent-context-amount').innerText(), /新对话/);
  assert.equal(await page.locator('#agent-compact').isDisabled(), true);
  await page.locator('#agent-model-tuning').click();
  assert.equal(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }).includes('SYNTHETIC_BROWSER_KEY')), false);
  const contextValue = page.locator('#agent-context-value');
  const contextMenu = page.locator('#agent-tuning-menu #agent-context-options');
  await contextValue.click();
  assert.deepEqual((await contextMenu.locator('button').allTextContents()).map(text=>text.trim()),['128K','512K','1M']);
  assert.equal(await contextMenu.locator('[aria-pressed=true]').getAttribute('data-value'),'512000');
  await contextMenu.locator('[data-value="1000000"]').click();
  await contextValue.filter({hasText:/^1M$/}).waitFor();
  assert.equal(await contextMenu.locator('[aria-pressed=true]').getAttribute('data-value'),'1000000');
  await contextMenu.locator('[data-value="512000"]').click();
  await contextValue.filter({hasText:/^512K$/}).waitFor();
  assert.equal(await contextValue.evaluate(node=>getComputedStyle(node).borderLeftWidth),'1px');
  await page.keyboard.press('Escape');
  assert.equal((await readFile(join(directory, 'agent/model.json'), 'utf8')).includes('SYNTHETIC_BROWSER_KEY'), false);
  const promptFonts = await page.locator('#agent-prompt').evaluate(input => ({
    input: getComputedStyle(input).fontFamily,
    placeholder: getComputedStyle(input, '::placeholder').fontFamily,
    answer: getComputedStyle(document.querySelector('#agent-answer')).fontFamily
  }));
  assert.equal(promptFonts.input, promptFonts.answer);
  assert.equal(promptFonts.placeholder, promptFonts.answer);
  await page.locator('#agent-prompt').fill('第一行');
  await page.locator('#agent-prompt').press('Shift+Enter');
  await page.locator('#agent-prompt').pressSequentially('第二行');
  assert.equal(await page.locator('#agent-prompt').inputValue(), '第一行\n第二行');
  await page.locator('#agent-prompt').dispatchEvent('keydown', { key: 'Enter', isComposing: true });
  assert.equal(await page.locator('#agent-prompt').inputValue(), '第一行\n第二行');
  assert.equal(await page.locator('#agent-result').isVisible(), false);
  await page.locator('#agent-prompt').fill('解释 ZDEMO 的主要逻辑');
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('button',{name:'添加到对话'}).innerText(),'');
  assert.equal(await page.locator('#agent-upload svg').count(),1);
  await page.locator('#agent-upload').click();
  const [fileChooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button',{name:'添加文件',exact:true}).click()
  ]);
  assert.equal(fileChooser.isMultiple(),true);
  await fileChooser.setFiles({ name:'remove.txt', mimeType:'text/plain', buffer:Buffer.from('remove me') });
  const pasteAccepted = await page.locator('#agent-prompt').evaluate(input => {
    const data = new DataTransfer();
    data.items.add(new File(['合成的附件内容'], '说明.txt', { type:'text/plain' }));
    return !input.dispatchEvent(new ClipboardEvent('paste', { clipboardData:data, bubbles:true, cancelable:true }));
  });
  assert.equal(pasteAccepted, true);
  assert.equal(await page.locator('#agent-upload-list .agent-upload-item').count(),2);
  const attachmentList = await page.locator('#agent-upload-list').boundingBox();
  const attachmentPrompt = await page.locator('#agent-prompt').boundingBox();
  assert.ok(attachmentList.y+attachmentList.height<attachmentPrompt.y);
  assert.equal(await page.locator('#agent-upload-note').count(),0);
  await page.getByRole('button',{name:'移除文件 remove.txt'}).click();
  assert.equal(await page.locator('#agent-upload-list .agent-upload-item').count(),1);
  await page.locator('#agent-upload-input').setInputFiles({name:'invalid.txt',mimeType:'text/plain',buffer:Buffer.from([0xff])});
  await page.locator('#agent-send').click();
  await page.locator('#agent-poll-error').filter({hasText:'不是有效的 UTF-8 文本'}).waitFor();
  assert.equal(await page.locator('#agent-upload-list .agent-upload-item').count(),2);
  assert.equal(await page.locator('#agent-prompt').inputValue(),'解释 ZDEMO 的主要逻辑');
  await page.getByRole('button',{name:'移除文件 invalid.txt'}).click();
  assert.equal(await page.locator('#agent-connection').inputValue(), connectionId);
  assert.equal(await page.locator('#agent-connection option[value=""]').count(),0);
  await page.waitForFunction(()=>!document.querySelector('#agent-send').disabled);
  assert.equal(await page.locator('#agent-send').isDisabled(), false);
  assert.equal(await page.locator('#agent-send').innerText(), '');
  assert.equal(await page.locator('#agent-send svg').count(),1);
  assert.equal(await page.locator('#agent-send').getAttribute('aria-label'), '开始分析');
  const checkComposerLayout=async()=>{
    const send=await page.locator('#agent-send').boundingBox();
    const box=await page.locator('.agent-input-box').boundingBox();
    const upload=await page.locator('#agent-upload').boundingBox(),prompt=await page.locator('#agent-prompt').boundingBox();
    const model=await page.locator('#agent-model-label').boundingBox();
    const tuning=await page.locator('#agent-model-tuning').boundingBox();
    const context=await page.locator('#agent-context-value').boundingBox();
    assert.ok(tuning.x<context.x&&context.x+context.width<=tuning.x+tuning.width&&tuning.x+tuning.width<=send.x);
    assert.ok(model.x+model.width<=tuning.x&&Math.abs(model.y+model.height/2-send.y-send.height/2)<2);
    assert.ok(send.x+send.width<=box.x+box.width);
    assert.ok(upload.y>=prompt.y+prompt.height && upload.x>=box.x);
    assert.ok(upload.x+upload.width<=model.x && Math.abs(upload.y+upload.height/2-model.y-model.height/2)<3);
  };
  await checkComposerLayout();
  assert.equal(await page.locator('#agent-consent').count(), 0);
  await page.locator('#agent-prompt').press('Enter');
  await page.locator('#agent-question-attachments').filter({ hasText:'附件：说明.txt' }).waitFor();
  assert.equal(await page.locator('#agent-upload-list .agent-upload-item').count(),0);
  assert.equal(await page.locator('#agent-upload-list').evaluate(list=>list.offsetHeight),0);
  assert.equal(await page.locator('#agent-question-attachments').innerText(),'附件：说明.txt');
  await page.locator('#agent-stream-note').waitFor({state:'visible'});
  assert.match(await page.locator('#agent-answer').innerText(),/对象/);
  assert.equal(await page.locator('#agent-task-status').innerText(),'分析中');
  assert.equal(await page.locator('#agent-model-label').isEnabled(),true);
  assert.equal(await page.locator('#agent-activity-current').innerText(),'正在生成回答');
  await page.locator('#agent-task-status').filter({ hasText: '已完成' }).waitFor();
  const uploaded = await new TaskStore(directory).get(await page.locator('#agent-history').inputValue());
  assert.equal((await new TaskStore(directory).artifacts.get(uploaded.id, uploaded.initial_uploads[0].artifact_id)).content,'合成的附件内容');
  await page.waitForFunction(()=>document.querySelector('#agent-context-percent').textContent.endsWith('%'));
  await page.locator('#agent-model-tuning').click();
  await page.locator('#agent-context-details summary').click();
  assert.match(await page.locator('#agent-context-amount').innerText(), /\/ 512,000 Token/);
  await page.waitForFunction(()=>!document.querySelector('#agent-compact').disabled);
  assert.equal(await page.locator('#agent-compact').isEnabled(), true);
  await page.locator('#agent-model-tuning').click();
  // Simulate a previously exhausted task, including tasks from the old budget.
  const tasks = new TaskStore(directory);
  const exhausted = await tasks.get(await page.locator('#agent-history').inputValue());
  exhausted.context_tokens = 160000;
  exhausted.status = 'failed'; exhausted.error = { code: 'AGENT_BUDGET_LIMIT', message: '工具调用达到上限。' };
  await tasks.save(exhausted);
  await page.locator('#agent-history').dispatchEvent('change');
  await page.locator('#agent-task-status').filter({ hasText: '分析失败' }).waitFor();
  const resume = page.getByRole('button',{name:'继续任务',exact:true});
  await resume.waitFor({state:'visible'});
  await page.locator('#agent-prompt').fill('输入内容时发送新消息');
  await page.getByRole('button',{name:'发送',exact:true}).waitFor({state:'visible'});
  await page.locator('#agent-prompt').clear();
  await resume.click();
  await page.locator('#agent-task-status').filter({ hasText: '已完成' }).waitFor();
  assert.equal((await tasks.get(exhausted.id)).context_tokens,512000);
  assert.match(await page.locator('#agent-answer').innerText(), /默认次数为 3/);
  await page.locator('#agent-report-content').filter({hasText:'默认次数为 3'}).waitFor();
  assert.equal(await page.locator('#agent-session-search').isVisible(),false);
  await page.locator('#agent-search-toggle').click();
  assert.equal(await page.locator('#agent-session-search').isVisible(),true);
  assert.equal(await page.locator('#agent-session-search').evaluate(node=>node===document.activeElement),true);
  await page.locator('#agent-session-search').fill('不存在的会话');
  await page.locator('#agent-sessions-empty').filter({hasText:'没有匹配的会话'}).waitFor();
  await page.locator('#agent-search-toggle').click();
  assert.equal(await page.locator('#agent-session-search').isVisible(),false);
  assert.equal(await page.locator('#agent-session-search').inputValue(),'');
  assert.equal(await page.locator('#agent-session-list .session-select').count(),1);
  assert.equal(await page.locator('#agent-report-content img').count(),0);
  assert.deepEqual(await page.locator('.report-tab').allTextContents(),['对象','调用链','业务解读','影响分析','改造建议','完整结论']);
  for(const name of ['调用链','业务解读','影响分析','改造建议','完整结论']){
    await page.getByRole('tab',{name,exact:true}).click();
    assert.equal(await page.locator('.report-tab-panel:not([hidden])').count(),1);
  }
  assert.equal(await page.locator('.report-tab-panel:not([hidden]) .report-analysis strong').first().innerText(),'结论');
  assert.equal(await page.locator('.report-tab-panel:not([hidden]) .report-analysis ul li').count(),2);
  assert.equal(await page.locator('.report-analysis blockquote').count(),1);
  assert.equal(await page.locator('#agent-answer table').count(),4);
  assert.equal(await page.locator('.report-analysis .diff-add').count(),1);assert.equal(await page.locator('.report-analysis .diff-remove').count(),1);
  const markdownCheck=await page.evaluate(()=>{
    const node=document.createElement('div');
    window.SapLinkMarkdown.render('# 标题\n\n**加粗**与*斜体*、~~删除~~、`代码`。\n\n1. 第一项\n   - 子项\n\n> 引用\n\n| 列 | 值 |\n| --- | --- |\n| A | B |\n\n[正常](https://example.com) [危险](javascript:alert(1))\n\n![远程图片](https://example.com/image.png)\n\n<img src=x onerror="window.AGENT_XSS=true"><script>window.AGENT_XSS=true</script>',node);
    return {heading:node.querySelector('h1')?.textContent,bold:node.querySelector('strong')?.textContent,
      em:node.querySelector('em')?.textContent,del:node.querySelector('del')?.textContent,code:node.querySelector('code')?.textContent,
      nested:!!node.querySelector('ol li ul li'),quote:!!node.querySelector('blockquote'),table:!!node.querySelector('table tbody td'),
      safe:!!node.querySelector('a[href="https://example.com"]'),unsafe:node.querySelectorAll('img,script,[onerror],a[href^="javascript:"]').length};
  });
  assert.deepEqual(markdownCheck,{heading:'标题',bold:'加粗',em:'斜体',del:'删除',code:'代码',nested:true,quote:true,table:true,safe:true,unsafe:0});
  assert.equal(await page.locator('#report-tab-panel-0 .report-stat').count(),4);
  assert.equal(await page.locator('.report-inventory tbody tr').count(),2);
  assert.deepEqual(await page.locator('#report-tab-panel-0 .report-stat strong').allTextContents(),['1','1','0','0']);
  assert.deepEqual(await page.locator('#report-tab-panel-3 .report-stat strong').allTextContents(),['2','7','3','中']);
  assert.equal(await page.locator('.report-tool-chip.succeeded').count(),3);
  await page.getByRole('tab',{name:'业务解读',exact:true}).click();await page.waitForTimeout(1700);
  assert.equal(await page.getByRole('tab',{name:'业务解读',exact:true}).getAttribute('aria-selected'),'true');
  await page.getByRole('tab',{name:'对象',exact:true}).click();
  await page.emulateMedia({colorScheme:'dark'});await page.waitForTimeout(200);
  await page.screenshot({path:join(root,'structured-report.png'),fullPage:true});
  for(const [index,name] of ['调用链','业务解读','影响分析','改造建议','完整结论'].entries()){
    await page.getByRole('tab',{name,exact:true}).click();await page.screenshot({path:join(root,'report-tab-'+index+'.png'),fullPage:true});
  }
  await page.emulateMedia({colorScheme:'light'});
  await page.getByRole('tab',{name:'完整结论',exact:true}).click();
  assert.equal(await page.locator('#agent-answer img').count(), 0);
  assert.equal(await page.evaluate(() => window.AGENT_XSS), undefined);
  assert.ok(await page.locator('#agent-events>li').count()>0);
  assert.equal(await page.locator('#agent-progress').isVisible(),true);
  assert.match(await page.locator('#agent-activity-history>summary').innerText(),/用时/);
  assert.equal(await page.locator('#agent-activity-history').getAttribute('open'),null);
  await page.locator('#agent-activity-history>summary').click();
  const capabilitiesActivity = page.locator('.activity-tool').filter({hasText:'验证系统能力'}).first();
  await capabilitiesActivity.locator('summary').click();
  assert.match(await capabilitiesActivity.locator('.activity-tool-detail').innerText(),/get_capabilities/);
  await capabilitiesActivity.locator('.activity-result-text').filter({hasText:'success'}).waitFor({state:'visible'});
  assert.equal(await capabilitiesActivity.getByRole('button', {name:'查看结果'}).count(),0);
  await page.waitForTimeout(1700);
  assert.equal(await capabilitiesActivity.getAttribute('open'),'');
  await page.emulateMedia({colorScheme:'dark'});await page.waitForTimeout(180);
  await page.screenshot({path:join(root,'activity-stream.png'),fullPage:true});
  await page.emulateMedia({colorScheme:'light'});
  const selectedText = await page.evaluate(() => {
    const range = document.createRange(); range.selectNodeContents(document.querySelector('#agent-answer'));
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); return selection.toString();
  });
  await page.waitForTimeout(1800);
  assert.equal(await page.evaluate(() => getSelection().toString()), selectedText);
  const conversationId = await page.locator('#agent-history').inputValue();
  assert.equal((await tasks.get(conversationId)).write_mode,'unrestricted');
  await page.locator('#agent-write-mode').click(); await page.locator('#agent-write-menu button[data-value="controlled"]').click();
  await page.locator('#agent-write-mode span').filter({hasText:'受控写入'}).waitFor();
  assert.equal((await tasks.get(conversationId)).write_mode,'controlled');
  await page.locator('#agent-prompt').fill('继续说明刚才的程序');
  await page.locator('#agent-send').click();
  await page.locator('#agent-question').filter({hasText:'继续说明刚才的程序'}).waitFor();
  await page.locator('#agent-task-status').filter({hasText:'已完成'}).waitFor();
  assert.match(await page.locator('#agent-answer').innerText(),/普通追问回答/);
  assert.equal(await page.locator('#agent-activity-history').isVisible(),true);
  assert.match(await page.locator('#agent-report-content').innerText(),/默认次数为 3/);
  const firstReportId=await page.locator('#agent-report-history').inputValue();
  const chooseReport=async id=>{await page.locator('#agent-report-switcher').click();await page.locator('.report-option[data-report-id="'+id+'"]').click();};
  assert.equal(await page.locator('#agent-report-history option').count(),1);
  assert.equal(await page.locator('#agent-history').inputValue(),conversationId);
  await page.locator('#agent-chat-history').filter({hasText:'解释 ZDEMO 的主要逻辑'}).waitFor();
  assert.match(await page.locator('#agent-chat-history').innerText(),/默认次数为 3/);
  assert.equal(await page.locator('#agent-chat-history img').count(),0);
  await page.locator('#agent-chat-scroll').evaluate(scroll=>{
    scroll.parentElement.style.maxHeight='140px';
    scroll.scrollTop=0;
  });
  const jump = page.getByRole('button',{name:'回到底部',exact:true});
  await jump.click();
  await page.waitForFunction(()=>{
    const scroll = document.querySelector('#agent-chat-scroll');
    return scroll.scrollHeight-scroll.clientHeight-scroll.scrollTop<2;
  });
  await jump.waitFor({state:'hidden'});
  await page.locator('#agent-chat-scroll').evaluate(scroll=>{scroll.parentElement.style.maxHeight='';});
  await page.locator('#agent-prompt').fill('新建一份独立分析报告');await page.locator('#agent-send').click();
  await page.locator('#agent-task-status').filter({hasText:'已完成'}).waitFor();
  await page.locator('#agent-report-content').filter({hasText:'独立报告内容'}).waitFor();
  await page.waitForFunction(()=>document.querySelector('#agent-task-status').textContent==='已完成'&&document.querySelector('#agent-report-state').textContent==='已保存'&&!document.querySelector('#agent-report-history').disabled&&!!document.querySelector('#agent-report-history').value);
  assert.equal(await page.locator('#agent-report-history option').count(),2);
  const independentId=await page.locator('#agent-report-history').inputValue();
  await page.emulateMedia({colorScheme:'dark'});await page.waitForTimeout(180);
  await page.screenshot({path:join(root,'multi-report.png'),fullPage:true});
  await page.locator('#agent-report-switcher').click();
  assert.equal(await page.locator('#agent-report-menu .report-option').count(),2);
  assert.equal((await page.locator('#agent-report-menu .report-option').allTextContents()).some(title=>/^\d+\./.test(title)),false);
  const selectedReportRow=page.locator('.report-row').filter({has:page.locator('.report-option[aria-pressed=true]')});
  const reportActionOpacity=()=>selectedReportRow.locator('.report-row-actions').evaluate(node=>getComputedStyle(node).opacity);
  await page.mouse.move(2,2);
  assert.equal(await reportActionOpacity(),'0');
  await selectedReportRow.hover();assert.equal(await reportActionOpacity(),'1');
  await page.mouse.move(2,2);assert.equal(await reportActionOpacity(),'0');
  await page.keyboard.press('End');
  assert.equal(await reportActionOpacity(),'1');
  await page.keyboard.press('Tab');
  assert.equal(await selectedReportRow.locator('.report-rename').evaluate(node=>document.activeElement===node),true);
  assert.equal(await reportActionOpacity(),'1');
  await page.screenshot({path:join(root,'report-switcher-menu.png'),fullPage:true});
  await page.locator('#agent-report-menu').press('Escape');
  assert.equal(await page.locator('#agent-report-menu').isVisible(),false);
  await page.emulateMedia({colorScheme:'light'});
  await chooseReport(firstReportId);
  await page.locator('#agent-report-content').filter({hasText:'默认次数为 3'}).waitFor();
  await page.locator('#agent-prompt').fill('更新这份报告，补充第二版结论');await page.locator('#agent-send').click();
  await page.locator('#agent-report-content').filter({hasText:'报告第二版'}).waitFor();
  await page.locator('#agent-task-status').filter({hasText:'已完成'}).waitFor();
  assert.equal(await page.locator('#agent-report-history option').count(),2);
  await chooseReport(independentId);
  await page.locator('#agent-report-content').filter({hasText:'独立报告内容'}).waitFor();
  await chooseReport(firstReportId);
  await page.locator('#agent-report-content').filter({hasText:'报告第二版'}).waitFor();
  await page.locator('#agent-prompt').fill('生成源码草稿');await page.locator('#agent-send').click();
  await page.locator('#agent-task-status').filter({hasText:'已完成'}).waitFor();
  const draftCard=page.locator('.agent-draft-card').filter({hasText:'修改输出'});
  await draftCard.waitFor();
  const originalCard=await draftCard.elementHandle();
  const originalDraftId=await draftCard.getAttribute('data-draft-id');
  await page.locator('#agent-prompt').fill('生成源码草稿，再确认输出改动');
  await page.locator('#agent-send').click();
  await page.waitForFunction(id=>document.querySelector('.agent-draft-card')?.dataset.draftId!==id,originalDraftId);
  await page.locator('#agent-task-status').filter({hasText:'已完成'}).waitFor();
  assert.equal(await draftCard.count(),1);
  assert.equal(await originalCard.evaluate(node=>node.isConnected),true);
  await page.locator('#agent-change-list button').filter({hasText:'修改输出'}).click();
  await page.locator('#agent-draft-dialog').waitFor({state:'visible'});
  assert.match(await page.locator('#agent-draft-note').innerText(),/非活动版本/);
  assert.match(await page.locator('#agent-draft-diff').innerText(),/WRITE 3\./);
  assert.match(await page.locator('#agent-draft-diff').innerText(),/WRITE 4\./);
  assert.ok(await page.locator('#agent-draft-diff tr.draft-diff-added td:nth-child(2)').first().innerText());
  assert.ok(await page.locator('#agent-draft-diff tr.draft-diff-removed td:first-child').first().innerText());
  assert.deepEqual(await page.locator('#agent-draft-dialog .dialog-actions button').allTextContents(),['作废','保存']);
  assert.equal(await page.locator('#agent-draft-diff img').count(),0);
  assert.equal(await page.evaluate(()=>window.AGENT_XSS),undefined);
  // The backend projects legacy execution records; the UI must honor those capabilities.
  await page.locator('#agent-draft-close').click();
  const legacyDraftView=async route=>{
    const response=await route.fetch(),detail=await response.json();
    detail.draft={state:'saved',legacy:true,message:'这份草稿已执行成功，无需再次保存。'};
    detail.can_save=false;detail.can_discard=false;
    await route.fulfill({response,json:detail});
  };
  await page.route('**/drafts/change/*',legacyDraftView);
  await page.locator('#agent-change-list button').filter({hasText:'修改输出'}).click();
  await page.locator('#agent-draft-status').filter({hasText:'已执行成功'}).waitFor();
  assert.equal(await page.locator('#agent-draft-save').isDisabled(),true);
  assert.equal(await page.locator('#agent-draft-discard').isDisabled(),true);
  await page.locator('#agent-draft-close').click();await page.unroute('**/drafts/change/*',legacyDraftView);
  await page.locator('#agent-change-list button').filter({hasText:'修改输出'}).click();
  await page.locator('#agent-draft-dialog').waitFor({state:'visible'});
  assert.equal(await page.locator('#agent-draft-save').isEnabled(),true);
  assert.equal(await page.locator('#agent-draft-discard').isEnabled(),true);
  await page.emulateMedia({colorScheme:'dark'});
  await page.locator('#agent-draft-dialog').screenshot({path:join(root,'unified-draft-dark.png')});
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.locator('#agent-draft-dialog').evaluate(n=>n.scrollWidth<=n.clientWidth+1),true);
  await page.locator('#agent-draft-dialog').screenshot({path:join(root,'unified-draft-mobile.png')});
  await page.setViewportSize({width:1440,height:1000});
  secrets.set(connectionId,'fixture-password');
  await page.locator('#agent-draft-close').click();
  await draftCard.locator('[data-action=save]').click();
  await page.locator('#agent-activate-dialog').waitFor({state:'visible'});
  assert.equal(await page.locator('#agent-activate-atc').isChecked(),false);
  assert.equal(fixtureInactive,'REPORT zdemo.\nWRITE 4. " <img src=x onerror="window.AGENT_XSS=true">\n');
  await page.locator('#agent-activate-dialog').screenshot({path:join(root,'activate-after-save.png')});
  await page.locator('#agent-activate-later').click();
  const partialCreation = route => route.fulfill({json:[{
    object_uri:'/sap/bc/adt/programs/programs/zpartial',completed_at:'2026-11-07T01:00:00.000Z'
  }]});
  await page.route('**/draft-creation-history',partialCreation);
  await page.locator('#agent-change-history').click();
  const creationReceipt = page.locator('.change-history-receipt').filter({hasText:'zpartial'});
  await creationReceipt.waitFor();
  assert.match(await creationReceipt.innerText(),/已创建/);
  assert.equal(await creationReceipt.locator('button').count(),0);
  await page.unroute('**/draft-creation-history',partialCreation);
  await page.locator('#agent-change-history-list button').filter({hasText:'修改输出'}).click();
  await page.locator('#agent-draft-heading').filter({hasText:'查看修改'}).waitFor();
  assert.equal(await page.locator('#agent-draft-dialog .dialog-actions').isHidden(),true);
  assert.equal(await page.locator('#agent-activate-dialog').isHidden(),true);
  await page.locator('#agent-draft-close').click();
  await page.locator('#agent-change-history-close').click();
  await page.locator('#agent-change-list button').filter({hasText:'待激活'}).click();
  await page.locator('#agent-activate-dialog').waitFor({state:'visible'});
  await page.locator('#agent-activate-later').click();
  await page.locator('#agent-prompt').fill('生成ATC操作草稿');await page.locator('#agent-send').click();
  await page.locator('#agent-change-list button').filter({hasText:'执行 ATC'}).waitFor();
  await page.locator('#agent-task-status').filter({hasText:'已完成'}).waitFor();
  await page.locator('#agent-change-list button').filter({hasText:'执行 ATC'}).click();
  await page.locator('#agent-draft-dialog').waitFor({state:'visible'});
  assert.match(await page.locator('#agent-draft-source').innerText(),/DEFAULT/);
  await page.locator('#agent-draft-save').click();
  await page.locator('#agent-draft-save-result').filter({hasText:'ATC 请求已提交'}).waitFor();
  await page.locator('#agent-draft-save-close').click();
  assert.equal(fixtureQualityRuns,1);
  assert.equal(await page.locator('#agent-draft-save').isDisabled(),true);
  await page.locator('#agent-draft-close').click();
  fixtureInactive=undefined;workflowUncertain=true;
  workflowSaveGate=new Promise(resolve=>{releaseWorkflowSave=resolve;});
  const savingWorkflow=new Promise(resolve=>{workflowSaveStarted=resolve;});
  await page.locator('#agent-prompt').fill('生成任务计划');await page.locator('#agent-send').click();
  const workflowButton=page.locator('#agent-change-list button').filter({hasText:'修改源码'});
  await workflowButton.waitFor();await page.locator('#agent-task-status').filter({hasText:'已完成'}).waitFor();
  await page.locator('#agent-prompt').fill('保留的说明');
  assert.equal(await page.locator('#agent-prompt').inputValue(),'保留的说明');
  await workflowButton.click();await page.locator('#agent-draft-save').click();await savingWorkflow;
  await page.locator('#agent-draft-save-steps li[data-stage="processing"]').waitFor();
  const savingIcon = page.locator('#agent-draft-save-result[data-state="running"] .draft-save-glyph');
  assert.equal(await savingIcon.evaluate(icon=>getComputedStyle(icon).animationName),'draft-save-spin');
  assert.equal(await page.locator('#agent-draft-save').isDisabled(),true);
  releaseWorkflowSave();
  await page.locator('#agent-draft-save-result[data-state="failed"]').waitFor();
  assert.equal(await page.locator('#agent-draft-save-result .draft-save-glyph').evaluate(icon=>getComputedStyle(icon).animationName),'none');
  await page.locator('#agent-draft-save-review').click();
  await page.locator('#agent-draft-status').filter({hasText:'读回源码与草稿一致'}).waitFor();
  await page.locator('#agent-task-status').filter({hasText:'已完成'}).waitFor();
  await page.locator('#agent-draft-reconcile').click();
  assert.match(await page.locator('#confirm-message').innerText(),/上次操作已结束/);
  await page.locator('#confirm-dialog .dialog-actions .close-dialog').click();
  await page.locator('#agent-draft-close').click();
  await page.locator('#agent-draft-dialog').waitFor({state:'hidden'});
  assert.equal(await page.locator('#agent-prompt').inputValue(),'保留的说明');
  await page.locator('#agent-task-status').filter({hasText:'已完成'}).waitFor();
  await page.locator('#agent-prompt').fill('');
  workflowSaveGate=undefined;workflowUncertain=false;secrets.delete(connectionId);
  await page.setViewportSize({width:1440,height:1000});
  await page.locator('#agent-upload-input').setInputFiles({name:'draft.txt',mimeType:'text/plain',buffer:Buffer.from('draft')});
  await page.locator('#agent-change-history').click();
  assert.equal(await page.locator('#agent-change-history-list button').filter({hasText:/执行 ATC|修改源码/}).count(),0);
  await page.locator('#agent-change-history-list button').filter({hasText:'修改输出'}).click();
  await page.locator('#agent-draft-dialog').waitFor({state:'visible'});
  await page.locator('#agent-connection').evaluate(select => {
    select.value = '22222222-2222-4222-8222-222222222222';
    select.dispatchEvent(new Event('change', { bubbles:true }));
  });
  await page.locator('#agent-draft-dialog').waitFor({state:'hidden'});
  await page.locator('#agent-change-history-dialog').waitFor({state:'hidden'});
  await page.locator('#agent-sessions-empty').filter({hasText:'这个系统还没有会话'}).waitFor();
  assert.equal(await page.locator('#agent-change-list').isHidden(),true);
  assert.equal(await page.locator('#agent-upload-list .agent-upload-item').count(),0);
  assert.match(await page.locator('#agent-connection-picker').innerText(), /其他系统_FIXTURE/);
  assert.equal(await page.locator('#agent-report-content').isVisible(),false);
  await page.locator('#agent-prompt').fill('其他系统分析');await page.locator('#agent-send').click();
  await page.locator('#agent-report-content').filter({hasText:'仅属于其他系统'}).waitFor();
  await page.locator('#agent-task-status').filter({hasText:'已完成'}).waitFor();
  const otherConversationId=await page.locator('#agent-history').inputValue();
  assert.equal(await page.locator('#agent-session-list .session-select').count(),1);
  await selectAgentConnection(page,connectionId);
  await page.waitForFunction(id=>document.querySelector('#agent-history').value===id,conversationId);
  await page.locator('#agent-report-content').filter({hasText:'报告第二版'}).waitFor();
  await page.locator('#agent-change-history').click();
  await page.locator('#agent-change-history-list button').filter({hasText:'修改输出'}).waitFor();
  await page.locator('#agent-change-history-close').click();
  assert.equal(await page.locator('#agent-session-list .session-select').count(),1);
  const panels=await Promise.all(['.session-panel','.report-panel','.chat-panel'].map(selector=>page.locator(selector).boundingBox()));
  assert.ok(panels[0].x<panels[1].x&&panels[1].x<panels[2].x);
  const navBox=await page.locator('.top-nav').boundingBox();assert.ok(navBox.y<panels[0].y);
  includeAttack = false;
  await page.reload();
  await page.getByRole('button', { name: 'SAP 助手', exact: true }).click();
  await page.locator('#agent-report-content').filter({hasText:'报告第二版'}).waitFor();
  assert.equal(await page.locator('#agent-history').inputValue(),conversationId);
  await page.waitForFunction(id => document.querySelector('#agent-connection').value === id, connectionId);
  assert.equal(await page.locator('.top-nav .nav[data-view="tokens"]').count(),0);
  for(const name of ['connections','service','updates']){
    await page.locator(`.top-nav .nav[data-view="${name}"]`).click();
    await page.waitForFunction(value=>document.body.dataset.view===value,name);
    assert.ok((await page.locator('.top-nav').boundingBox()).y>=0);
    if(name==='connections'){
      await page.locator('#search').fill('找不到的连接');
      await page.locator('#empty-connections h2').filter({hasText:'未找到匹配连接'}).waitFor();
      assert.equal(await page.locator('#empty-add').isVisible(),false);
      await page.locator('#search').fill('');
      assert.equal(await page.locator('#connection-rows tr').count(),2);
    }
    if(name==='service'){
      assert.equal(await page.locator('#tokens-view').isVisible(),true);
      assert.equal(await page.locator('#create-token').isVisible(),true);
      assert.equal(await page.locator('#clear-cache').isVisible(),false);
    }
    if(name==='updates'){
      for(const selector of ['#check-updates','#open-rfc-environment-service','#clear-cache','#clear-logs'])assert.equal(await page.locator(selector).isVisible(),true);
      assert.equal(await page.locator('.top-nav .nav[data-view="updates"]').innerText(),'系统设置');
    }
  }
  await page.locator('.top-nav .nav[data-view="agent"]').click();
  await page.locator('#agent-report-content').filter({hasText:'报告第二版'}).waitFor();
  const footer=await page.locator('.report-footer').boundingBox(),scroll=await page.locator('.report-scroll').boundingBox();
  assert.ok(footer.height>=30&&scroll.y+scroll.height<=footer.y+1);
  assert.match(await page.locator('#agent-report-length').innerText(),/字符/);
  await page.locator('#agent-prompt').fill('验证刷新后可以发送');
  assert.equal(await page.locator('#agent-send').isDisabled(), false);
  await page.getByRole('button', { name: '模型设置', exact: true }).click();
  await page.locator('#agent-key-indicator').filter({hasText:'已保存'}).waitFor();
  assert.equal(await page.locator('#agent-api-key').inputValue(), '');
  assert.equal(await page.locator('#agent-key-indicator').isVisible(), true);
  assert.equal(await page.locator('#agent-key-indicator').innerText(), '已保存');
  assert.match(await page.locator('#agent-api-key').getAttribute('placeholder'), /已保存/);
  await page.screenshot({ path: join(root, 'saved-model-settings.png'), fullPage: true });
  assert.equal(secrets.size, 1);
  assert.equal([...secrets.values()][0], 'SYNTHETIC_BROWSER_KEY');
  assert.equal(await page.locator('#agent-table-data').count(),0);
  await page.locator('#agent-model-close').click();
  const setConnectionTableAccess=async(name,enabled)=>{
    await page.locator('#agent-connections').click();
    await page.locator('#connection-rows tr').filter({hasText:name}).getByRole('button',{name:'编辑连接'}).click();
    const input=page.locator('#connection-form input[name="allow_table_data"]');
    await input.setChecked(enabled);
    await page.locator('#connection-form button[type=submit]').click();
    await page.locator('#connection-dialog').waitFor({state:'hidden'});
    await page.locator('.nav[data-view="agent"]').click();
    await page.waitForFunction(()=>!document.querySelector('#agent-connection').disabled);
  };
  await setConnectionTableAccess('开发系统_FIXTURE',true);
  await page.locator('#agent-data-policy').filter({ hasText: '表数据访问已开启' }).waitFor();
  assert.equal((await store.load()).connections.find(c=>c.connection_id===connectionId).allow_table_data,true);
  assert.notEqual((await store.load()).connections.find(c=>c.connection_id!==connectionId).allow_table_data,true);
  await page.locator('#agent-model-label').click();await page.locator('#agent-model-menu button[data-value="deepseek-v4-pro"]').click();
  await page.locator('#agent-model-label span').filter({hasText:'DeepSeek V4 Pro'}).waitFor();
  assert.match(await page.locator('#agent-data-policy').innerText(),/表数据访问已开启/);
  await page.locator('#agent-model-label').click();await page.locator('#agent-model-menu button[data-value="deepseek-flash"]').click();
  await page.locator('#agent-model-label span').filter({hasText:'DeepSeek Flash'}).waitFor();
  await selectAgentConnection(page,'22222222-2222-4222-8222-222222222222');
  await page.locator('#agent-data-policy').filter({hasText:'表数据访问未开启'}).waitFor();
  await selectAgentConnection(page,connectionId);
  await page.locator('#agent-data-policy').filter({hasText:'表数据访问已开启'}).waitFor();
  await setConnectionTableAccess('开发系统_FIXTURE',false);
  await page.locator('#agent-data-policy').filter({ hasText: '表数据访问未开启' }).waitFor();
  await page.locator('#agent-history option').nth(1).waitFor({ state: 'attached' });
  await page.locator('#agent-history').selectOption({ index: 1 });
  await page.locator('#agent-answer').filter({ hasText: '任务计划已生成' }).waitFor();
  await setConnectionTableAccess('开发系统_FIXTURE',true);
  await page.locator('#agent-data-policy').filter({ hasText: '表数据访问已开启' }).waitFor();
  await page.locator('#agent-new').click();
  assert.equal(await page.locator('#agent-progress').isVisible(),false);
  await page.locator('#agent-prompt').fill('慢任务：检查停止与恢复');
  await page.locator('#agent-send').click();
  await page.locator('#agent-task-status').filter({ hasText: '分析中' }).waitFor();
  assert.equal(await page.locator('#agent-send').isHidden(),true);
  assert.equal(await page.locator('#agent-stop svg').count(),1);
  const firstRunningId = await page.locator('#agent-history').inputValue();
  const connectionPicker = page.locator('#agent-connection-picker');
  assert.equal(await connectionPicker.isDisabled(),true);
  await page.locator('#agent-new').click();
  await page.locator('#agent-prompt').fill('慢任务：并行会话');
  await page.locator('#agent-send').click();
  await page.locator('#agent-task-status').filter({hasText:'分析中'}).waitFor();
  const parallelId = await page.locator('#agent-history').inputValue();
  assert.notEqual(parallelId,firstRunningId);
  assert.equal((await new TaskStore(directory).get(firstRunningId)).status,'running');
  await page.locator('#agent-stop').click();
  await page.locator('#agent-task-status').filter({hasText:'已停止'}).waitFor();
  assert.equal(await connectionPicker.isDisabled(),true);
  const parallelRow = page.locator('.session-item[data-task-id="'+parallelId+'"]');
  await parallelRow.hover();
  await parallelRow.locator('.session-delete').click();
  await page.locator('#agent-manage-confirm').click();
  await parallelRow.waitFor({state:'hidden'});
  await page.locator('#agent-history').selectOption(firstRunningId);
  await page.locator('#agent-task-status').filter({hasText:'分析中'}).waitFor();
  await page.locator('#agent-stop').click();
  await page.locator('#agent-task-status').filter({ hasText: '已停止' }).waitFor();
  await page.waitForFunction(()=>!document.querySelector('#agent-connection').disabled);
  assert.equal(await page.locator('#agent-stop').isHidden(),true);
  assert.equal(await page.locator('#agent-send').isVisible(),true);
  assert.equal(await resume.isDisabled(), false);
  await setConnectionTableAccess('开发系统_FIXTURE',false);
  await page.locator('#agent-table-policy-note').filter({ hasText: '当前连接的权限已关闭' }).waitFor();
  assert.equal(await resume.isDisabled(), true);
  await setConnectionTableAccess('开发系统_FIXTURE',true);
  await page.locator('#agent-data-policy').filter({ hasText: '表数据访问已开启' }).waitFor();
  continueSlow = true;
  await resume.click();
  await page.locator('#agent-task-status').filter({ hasText: '已完成' }).waitFor();
  const resumedId=await page.locator('#agent-history').inputValue();
  let releaseSelection, selectionStarted, selectionFinished;
  const selectionGate = new Promise(resolve => { releaseSelection = resolve; });
  const selectionRequest = new Promise(resolve => { selectionStarted = resolve; });
  const selectionDone = new Promise(resolve => { selectionFinished = resolve; });
  const selectionRoute = async route => {
    selectionStarted();
    try { await selectionGate; await route.continue(); }
    finally { selectionFinished(); }
  };
  await page.route('**/api/agent/tasks/'+conversationId, selectionRoute);
  try {
    await page.locator('.session-item[data-task-id="'+conversationId+'"] .session-select').click();
    await selectionRequest;
    assert.equal(await page.locator('.session-item[data-task-id="'+conversationId+'"] .session-select').getAttribute('aria-pressed'),'true');
    assert.equal(await page.locator('#agent-task-status').innerText(),'加载中');
    assert.equal(await page.locator('#agent-report-content').isVisible(),false);
    await page.locator('.session-item[data-task-id="'+resumedId+'"] .session-select').click();
    await page.locator('#agent-report-content').filter({hasText:'默认次数为 3'}).waitFor();
  } finally {
    releaseSelection();
    await selectionDone;
    await page.unroute('**/api/agent/tasks/'+conversationId, selectionRoute);
  }
  assert.equal(await page.locator('#agent-history').inputValue(),resumedId);
  await page.locator('#agent-history').selectOption(conversationId);
  await page.locator('#agent-report-content').filter({hasText:'报告第二版'}).waitFor();
  await page.locator('#agent-report-switcher').click();
  const reportRow=page.locator('.report-row').filter({has:page.locator('.report-option[data-report-id="'+independentId+'"]')});
  await reportRow.hover();
  assert.equal(await reportRow.locator('.report-rename').isVisible(),true);
  assert.equal(await reportRow.locator('.report-delete').isVisible(),true);
  await reportRow.locator('.report-rename').click();
  await page.locator('#agent-title').fill('独立报告新名称');
  await page.locator('#agent-manage-confirm').click();await page.locator('#agent-manage-dialog').waitFor({state:'hidden'});
  await page.waitForFunction(()=>!document.querySelector('#agent-report-switcher').disabled);
  assert.equal(await page.locator('#agent-report-history').inputValue(),firstReportId);
  await page.locator('#agent-report-switcher').click();
  await reportRow.hover();assert.match(await reportRow.innerText(),/独立报告新名称/);
  await reportRow.locator('.report-delete').click();await page.locator('#agent-manage-cancel').click();
  await page.locator('#agent-report-switcher').click();await reportRow.hover();await reportRow.locator('.report-delete').click();
  await page.locator('#agent-manage-confirm').click();await page.locator('#agent-manage-dialog').waitFor({state:'hidden'});
  await page.waitForFunction(()=>!document.querySelector('#agent-report-switcher').disabled);
  assert.equal(await page.locator('#agent-report-history option').count(),1);
  assert.equal(await page.locator('#agent-report-history').inputValue(),firstReportId);
  assert.match(await page.locator('#agent-report-content').innerText(),/报告第二版/);
  await page.waitForFunction(()=>!document.querySelector('#agent-history').disabled);
  await page.locator('#agent-history').selectOption(resumedId);
  await page.locator('#agent-report-content').filter({hasText:'默认次数为 3'}).waitFor();
  await page.screenshot({ path: join(root, 'desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await checkComposerLayout();
  await page.locator('#agent-model-label').click();
  const modelMenuBox=await page.locator('#agent-model-menu').boundingBox();
  assert.ok(modelMenuBox.x>=0&&modelMenuBox.x+modelMenuBox.width<=390);
  await page.keyboard.press('Escape');
  assert.ok((await page.locator('.session-panel').boundingBox()).width>250);
  await page.screenshot({ path: join(root, 'mobile.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const managedId=await page.locator('#agent-history').inputValue();
  await page.getByRole('tab',{name:'完整结论',exact:true}).click();
  const sessionRow=id=>page.locator('.session-item[data-task-id="'+id+'"]');
  const renameSession=async(id,title)=>{
    await sessionRow(id).locator('.session-select').dblclick();
    const input=sessionRow(id).locator('.session-title-input');await input.fill(title);
    await page.waitForTimeout(1600);assert.equal(await input.inputValue(),title);
    await input.press('Enter');
    await page.waitForFunction(({id,title})=>!document.querySelector('#agent-history').disabled&&[...document.querySelector('#agent-history').options].some(option=>option.value===id&&option.textContent.includes(title)),{id,title});
  };
  assert.equal(await page.locator('#agent-export').count(),0);
  assert.equal(await page.locator('#agent-session-menu').count(),0);
  assert.equal(await page.locator('.session-item small').count(),0);
  await sessionRow(conversationId).locator('.session-select').dblclick();
  await sessionRow(conversationId).locator('.session-title-input').fill('取消的修改');
  await sessionRow(conversationId).locator('.session-title-input').press('Escape');
  assert.notEqual((await tasks.get(conversationId)).title,'取消的修改');
  await renameSession(conversationId,'后台会话重命名');
  assert.equal(await page.locator('#agent-history').inputValue(),managedId);
  assert.match(await page.locator('#agent-report-content').innerText(),/默认次数为 3/);
  assert.equal((await tasks.get(conversationId)).title,'后台会话重命名');
  await renameSession(managedId,'恢复后的会话');
  await sessionRow(managedId).hover();await sessionRow(managedId).locator('.session-pin').click();
  await page.waitForFunction(()=>document.querySelector('#agent-history').selectedOptions[0]?.textContent.includes('★'));
  await page.locator('#agent-cleanup').click();await page.locator('#agent-cleanup-days').selectOption('0');
  // The earlier uncertain write is intentionally retained, rather than erased by cleanup.
  await page.waitForFunction(()=>document.querySelector('#agent-manage-confirm').disabled);
  await page.locator('#agent-manage-cancel').click();await page.locator('#agent-manage-dialog').waitFor({state:'hidden'});
  assert.equal((await tasks.get(conversationId)).drafts.some(draft=>draft.state==='uncertain'),true);
  await page.waitForFunction(()=>document.querySelector('#agent-history').options.length===3);
  assert.equal(await page.locator('#agent-history').inputValue(),managedId);
  await page.locator('#agent-prompt').fill('生成任务计划');await page.locator('#agent-send').click();
  await page.locator('.agent-draft-card-summary').filter({hasText:'修改源码'}).waitFor();
  await page.locator('#agent-task-status').filter({hasText:'已完成'}).waitFor();
  await page.locator('#agent-prompt').fill('生成带源码的创建草稿');await page.locator('#agent-send').click();
  const combined = page.locator('.agent-draft-card').filter({hasText:'修改计划 · 2 项'});
  await combined.waitFor();
  await page.locator('#agent-task-status').filter({hasText:'已完成'}).waitFor();
  assert.equal(await page.locator('.agent-draft-card').count(),1);
  assert.doesNotMatch(await combined.innerText(),/ZPLAN_FIXTURE/);
  assert.deepEqual(await combined.locator('.agent-draft-card-actions button').allTextContents(),['保存','作废']);
  await page.locator('#agent-change-history').click();
  await page.locator('#agent-change-history-empty').waitFor();
  assert.equal(await page.locator('#agent-change-history-list > li').count(),0);
  await page.locator('#agent-change-history-close').click();
  const omitCreationDiff = async route => {
    const response = await route.fetch();
    const plan = await response.json();
    for (const item of plan.items) {
      if (item.proposal.plan?.action === 'create_program') delete item.diff;
    }
    await route.fulfill({response,json:plan});
  };
  await page.route('**/draft-plan',omitCreationDiff);
  await combined.locator('.agent-draft-card-state').click();
  await page.locator('#agent-draft-plan-dialog').waitFor({state:'visible'});
  await page.unroute('**/draft-plan',omitCreationDiff);
  assert.match(await page.locator('#agent-draft-plan-items').innerText(),/zplan_fixture/i);
  const creationDetails = page.locator('#agent-draft-plan-items details').filter({hasText:'新建 ABAP 报表 ZPLAN_FIXTURE'});
  assert.match(await creationDetails.innerText(),/\$TMP（本地对象）/);
  assert.doesNotMatch(await creationDetails.innerText(),/connection_id|request_id/);
  assert.match(await creationDetails.locator('.draft-diff-heading').innerText(),/新增源码/);
  const additions = creationDetails.locator('tr.draft-diff-added');
  assert.equal(await additions.count(),2);
  assert.deepEqual(await additions.first().locator('td').allTextContents(),['','1','+','REPORT zplan_fixture.']);
  assert.equal(await creationDetails.locator('tr.draft-diff-removed').count(),0);
  assert.deepEqual(await page.locator('#agent-draft-plan-dialog .dialog-actions button').allTextContents(),['作废','保存']);
  assert.equal(await page.locator('#agent-draft-plan-items details').count(),2);
  assert.equal(await page.locator('#agent-draft-plan-items details[open]').count(),2);
  await page.locator('#agent-draft-plan-dialog [data-plan-action=save]').click();
  const saveDialog = page.locator('#agent-draft-save-dialog');
  await saveDialog.locator('[data-state="failed"]').waitFor();
  assert.equal(await saveDialog.locator('textarea').count(),0);
  assert.equal((await tasks.get(managedId)).latest_prompt,'生成带源码的创建草稿');
  await saveDialog.screenshot({path:join(root,'draft-save-result.png')});
  await saveDialog.getByRole('button',{name:'重新生成草稿'}).click();
  await saveDialog.waitFor({state:'hidden'});
  await page.locator('#agent-answer').filter({hasText:'已收到本次保存回执。'}).waitFor();
  assert.equal((await tasks.get(managedId)).repair_only,true);
  assert.equal((await tasks.get(managedId)).draft_save_recovery,undefined);
  await combined.locator('.agent-draft-card-state').click();
  await page.locator('#agent-draft-plan-dialog [data-plan-action=discard]').click();
  await page.locator('#agent-draft-plan-dialog').waitFor({state:'hidden'});
  await combined.waitFor({state:'hidden'});
  await page.locator('#agent-change-history').click();
  await page.locator('#agent-change-history-empty').waitFor();
  assert.equal(await page.locator('#agent-change-history-list > li').count(),0);
  await page.locator('#agent-change-history-close').click();
  await sessionRow(managedId).hover();await sessionRow(managedId).locator('.session-delete').click();await page.locator('#agent-manage-cancel').click();
  assert.equal(await page.locator('#agent-history').inputValue(),managedId);
  await sessionRow(managedId).hover();await sessionRow(managedId).locator('.session-delete').click();await page.locator('#agent-manage-confirm').click();
  await page.locator('#agent-manage-dialog').waitFor({state:'hidden'});await page.locator('#agent-empty').waitFor({state:'visible'});
  assert.equal(await page.locator('#agent-history').inputValue(),'');assert.equal(secrets.size,1);
  assert.equal((await tasks.get(otherConversationId)).status,'completed');
  await selectAgentConnection(page,'22222222-2222-4222-8222-222222222222');
  await page.locator('#agent-report-content').filter({hasText:'仅属于其他系统'}).waitFor();
  await page.setViewportSize({width:1600,height:1000});await page.emulateMedia({colorScheme:'dark'});
  await page.waitForFunction(()=>!document.querySelector('#agent-settings').disabled);await page.waitForTimeout(250);
  await page.screenshot({path:join(root,'workspace-dark.png'),fullPage:true});
  await page.locator('#agent-report-switcher').click();
  const lastReport=page.locator('.report-row').first();await lastReport.hover();await lastReport.locator('.report-delete').click();
  await page.locator('#agent-manage-confirm').click();await page.locator('#agent-manage-dialog').waitFor({state:'hidden'});
  await page.locator('#agent-report-empty').waitFor({state:'visible'});
  await page.locator('#agent-report-library').waitFor({state:'hidden'});
  assert.equal(await page.locator('#agent-report-state').innerText(),'尚未生成');
  assert.equal(await page.locator('#agent-history').inputValue(),otherConversationId);
  await page.locator('#agent-settings').click();
  const settingsDialog = page.getByRole('dialog',{name:'模型设置'});
  await settingsDialog.getByRole('button',{name:'MCP',exact:true}).click();
  const mcpEditor = page.locator('#agent-mcp-form');
  const mcpList = page.locator('#agent-mcp-list');
  await page.locator('#agent-mcp-empty').waitFor({state:'visible'});
  assert.equal(await mcpEditor.isVisible(),false);
  await settingsDialog.getByRole('button',{name:'添加 MCP 服务',exact:true}).click();
  await mcpEditor.getByLabel('名称',{exact:true}).fill('MCP 浏览器样例');
  await mcpEditor.getByLabel('服务地址').fill('https://example.com/mcp');
  await mcpEditor.getByLabel('访问令牌').fill('fixture-token');
  assert.equal(await mcpEditor.getByRole('button',{name:'测试连接'}).isVisible(),false);
  await mcpEditor.getByRole('button',{name:'保存服务'}).click();
  await mcpList.getByRole('switch',{name:'MCP 浏览器样例',checked:false}).click();
  await mcpList.getByRole('switch',{name:'MCP 浏览器样例',checked:true}).waitFor();
  await settingsDialog.screenshot({path:join(root,'mcp-management.png')});
  await mcpList.getByRole('button',{name:/^MCP 浏览器样例/}).locator('.agent-extension-arrow').click();
  assert.equal(await mcpEditor.getByRole('checkbox').count(),0);
  await mcpEditor.getByLabel('名称',{exact:true}).fill('MCP 浏览器样例已编辑');
  await mcpEditor.getByRole('button',{name:'保存服务'}).click();
  await mcpList.getByRole('switch',{name:'MCP 浏览器样例已编辑',checked:true,exact:true}).waitFor();
  await mcpList.getByRole('button',{name:/^MCP 浏览器样例已编辑/}).click();
  assert.equal(await mcpEditor.getByLabel('访问令牌').inputValue(),'');
  assert.match(await mcpEditor.getByLabel('访问令牌').getAttribute('placeholder'),/已保存/);
  await page.route('**/api/agent/extensions/mcp/*/test',route=>route.fulfill({json:[{name:'fixture_read'}]}));
  await mcpEditor.getByRole('button',{name:'测试连接'}).click();
  await page.locator('#agent-extensions-result').filter({hasText:'fixture_read'}).waitFor();
  await mcpEditor.getByRole('button',{name:'删除服务'}).click();
  await page.locator('#confirm-action').click();
  await page.locator('#agent-mcp-empty').waitFor({state:'visible'});
  await settingsDialog.getByRole('button',{name:'技能',exact:true}).click();
  assert.equal(await page.locator('#agent-mcp-panel').isVisible(),false);
  const installedSkills = page.locator('#agent-skill-list');
  for (const name of [/^技能生成.*内置/, /^SapLink.*内置/]) {
    const row = installedSkills.getByRole('button',{name}).locator('..');
    await row.getByText('始终启用',{exact:true}).waitFor();
    assert.equal(await row.getByRole('switch').count(),0);
  }
  await installedSkills.getByRole('button',{name:/^SapLink.*内置/}).click();
  await page.locator('#agent-skill-preview').filter({hasText:'以当前会话选定的 SAP 系统'}).waitFor();
  assert.equal(await installedSkills.getByRole('button',{name:'管理技能 SapLink',exact:true}).count(),0);
  await page.locator('#agent-skill-detail-close').click();
  await page.locator('#agent-skill-detail').waitFor({state:'hidden'});
  await settingsDialog.getByRole('button',{name:'新增技能',exact:true}).click();
  const [skillPicker] = await Promise.all([page.waitForEvent('filechooser'),
    settingsDialog.getByRole('button',{name:'本地导入技能',exact:true}).click()]);
  assert.equal(await skillPicker.element().getAttribute('accept'),'.zip');
  await skillPicker.setFiles({name:'browser-skill.zip',mimeType:'application/zip',buffer:Buffer.from(zipSync({
    'browser-skill/SKILL.md':strToU8('---\nname: 浏览器样例\n---\n使用浏览器样例指引'),
    'browser-skill/references/check.md':strToU8('文件夹的参考内容')
  }))});
  await page.getByRole('switch',{name:'浏览器样例',checked:false,exact:true}).click();
  await page.getByRole('switch',{name:'浏览器样例',checked:true,exact:true}).waitFor();
  const skillRow = page.locator('#agent-skill-list').getByRole('button',{name:/^浏览器样例/});
  const skillDetail = page.locator('#agent-skill-detail');
  await skillRow.click();
  await page.getByRole('dialog',{name:'浏览器样例',exact:true}).waitFor();
  await page.waitForFunction(()=>document.querySelector('#agent-skill-preview').textContent.includes('使用浏览器样例指引'));
  await page.locator('#agent-skill-files').selectOption('references/check.md');
  await page.waitForFunction(()=>document.querySelector('#agent-skill-preview').textContent==='文件夹的参考内容');
  await skillDetail.getByRole('button',{name:'关闭技能详情',exact:true}).click();
  await skillDetail.waitFor({state:'hidden'});
  assert.equal(await skillRow.getAttribute('aria-haspopup'),'dialog');
  let releasePreview;
  const previewGate = new Promise(resolve=>{releasePreview=resolve;});
  const skillFileRequest = /\/extensions\/skills\/[^/]+\/file\?/;
  await page.route(skillFileRequest,async route=>{
    await previewGate;
    await route.continue();
  },{times:1});
  await Promise.all([page.waitForRequest(skillFileRequest),skillRow.locator('.agent-extension-arrow').click()]);
  await skillDetail.waitFor({state:'visible'});
  await page.keyboard.press('Escape');
  await skillDetail.waitFor({state:'hidden'});
  const latePreview = page.waitForResponse(skillFileRequest);
  releasePreview();
  await latePreview;
  assert.equal(await skillDetail.isVisible(),false);
  const skillMenu = installedSkills.getByRole('button',{name:'管理技能 浏览器样例',exact:true});
  const originalSkillId = await skillRow.getAttribute('data-skill-id');
  const chooseReplacement = async () => {
    await skillMenu.click();
    const [picker] = await Promise.all([page.waitForEvent('filechooser'),
      settingsDialog.getByRole('button',{name:'重新上传技能',exact:true}).click()]);
    return picker;
  };
  const invalidReplacement = await chooseReplacement();
  await invalidReplacement.setFiles({name:'invalid.zip',mimeType:'application/zip',buffer:Buffer.from(zipSync({'README.md':strToU8('bad')}))});
  await page.locator('#agent-extensions-error').filter({hasText:'SKILL.md'}).waitFor();
  assert.equal(await skillRow.getAttribute('data-skill-id'),originalSkillId);
  const replacement = await chooseReplacement();
  await replacement.setFiles({name:'replacement.zip',mimeType:'application/zip',buffer:Buffer.from(zipSync({
    'SKILL.md':strToU8('---\nname: 浏览器样例\n---\n使用浏览器样例指引（已更新）'),
    'references/check.md':strToU8('文件夹的参考内容'),
    'references/long.md':strToU8('分页预览测试\n'.repeat(2000)+'预览末尾')
  }))});
  await page.locator('#agent-skill-preview').filter({hasText:'已更新'}).waitFor();
  assert.equal(await skillRow.getAttribute('data-skill-id'),originalSkillId);
  await page.locator('#agent-skill-files').selectOption('references/long.md');
  const skillPreview = page.locator('#agent-skill-preview');
  await skillPreview.filter({hasText:'分页预览测试'}).waitFor();
  assert.equal((await skillPreview.textContent()).includes('预览末尾'),false);
  await skillPreview.evaluate(node=>{node.scrollTop = node.scrollHeight;});
  await skillPreview.filter({hasText:'预览末尾'}).waitFor();
  assert.equal(await skillDetail.getByRole('button',{name:'继续读取',exact:true}).count(),0);
  await skillDetail.getByRole('button',{name:'关闭技能详情',exact:true}).click();
  assert.equal(await page.getByRole('switch',{name:'浏览器样例',checked:true,exact:true}).count(),1);
  await skillMenu.click();
  await settingsDialog.getByRole('button',{name:'卸载技能',exact:true}).click();
  await page.locator('#confirm-dialog .dialog-actions .close-dialog').click();
  await skillRow.waitFor();
  await skillDetail.waitFor({state:'hidden'});
  const dropSkillFile = (name,bytes)=>page.locator('#agent-skill-drop').evaluate((zone,{name,bytes})=>{
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File([Uint8Array.from(bytes)],name));
    zone.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer}));
    if (!zone.hasAttribute('data-dragging')) throw new Error('Skill drop zone did not accept the archive');
    zone.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer}));
  },{name,bytes:Array.from(bytes)});
  const dropSkillZip = entries=>dropSkillFile('test.zip',zipSync(entries));
  await dropSkillFile('SKILL.md',strToU8('---\nname: 单文件\n---\n单文件不能导入'));
  await page.locator('#agent-extensions-error').filter({hasText:'请选择 ZIP 技能包'}).waitFor();
  assert.equal(await page.locator('#agent-skill-list li').count(),3);
  await dropSkillZip({'README.md':strToU8('missing entry point')});
  await page.locator('#agent-extensions-error').filter({hasText:'根目录 SKILL.md'}).waitFor();
  assert.equal(await page.locator('#agent-skill-list li').count(),3);
  await dropSkillZip({
    'zip-skill/SKILL.md':strToU8('---\nname: ZIP 样例\n---\nZIP 测试'),
    'zip-skill/assets/sample.txt':strToU8('附带资源')
  });
  await page.getByRole('switch',{name:'ZIP 样例',checked:false,exact:true}).waitFor();
  await page.locator('#agent-skill-drop').evaluate(zone=>{
    const entry = (name,text)=>({name,isFile:true,file:resolve=>resolve(new File([text],name))});
    const directory = (name,entries)=>({name,isDirectory:true,createReader:()=>{
      let batch = entries;
      return {readEntries:resolve=>{resolve(batch);batch=[];}};
    }});
    const root = directory('dragged-skill',[
      entry('SKILL.md','---\nname: 拖入文件夹样例\n---\n读取 docs/check.md'),
      directory('docs',[entry('check.md','保留自定义子目录')])
    ]);
    const drop = new DragEvent('drop',{bubbles:true,cancelable:true});
    Object.defineProperty(drop,'dataTransfer',{value:{types:['Files'],files:[],items:[{kind:'file',webkitGetAsEntry:()=>root}]}});
    zone.dispatchEvent(drop);
  });
  await page.getByRole('switch',{name:'拖入文件夹样例',checked:false,exact:true}).waitFor();
  await settingsDialog.getByRole('button',{name:'新增技能',exact:true}).click();
  await settingsDialog.getByRole('button',{name:'对话创建技能',exact:true}).click();
  await page.locator('#agent-skill-prompt').fill('帮我创建一个检查技能');
  await page.locator('#agent-skill-send').click();
  await page.locator('#agent-skill-chat').getByText('需要检查哪些内容？').waitFor();
  await page.locator('#agent-skill-prompt').fill('检查采购订单');
  await page.locator('#agent-skill-send').click();
  await page.locator('#agent-skill-draft-files').selectOption({label:'references/checklist.md'});
  assert.equal(await page.locator('#agent-skill-draft-preview').innerText(),'检查采购订单行项目。');
  await page.getByRole('button',{name:'安装技能',exact:true}).click();
  await page.getByRole('switch',{name:'AI 创建样例',checked:false,exact:true}).waitFor();
  await settingsDialog.screenshot({path:join(root,'skill-management.png')});
  await settingsDialog.getByRole('button',{name:'关闭模型设置'}).click();
  await page.locator('#agent-new').click();
  await page.evaluate(id=>api('agent/extensions/mcp/'+id,'PUT',{name:'MCP 引用样例',url:'https://example.com/mcp',enabled:true}),randomUUID());
  await page.locator('#agent-upload').click();
  await page.locator('#agent-add-options').getByRole('button',{name:'技能',exact:true}).click();
  await page.getByRole('searchbox',{name:'搜索技能'}).fill('浏览器');
  await page.locator('#agent-reference-list').getByRole('button',{name:/浏览器样例/}).click();
  await page.locator('#agent-upload').click();
  await page.locator('#agent-add-options').getByRole('button',{name:'MCP',exact:true}).click();
  await page.locator('#agent-reference-list').getByRole('button',{name:/MCP 引用样例/}).click();
  assert.equal(await page.locator('#agent-upload-list .agent-upload-item').count(),2);
  await page.locator('#agent-prompt').fill('联网搜索测试');
  await page.locator('#agent-send').click();
  const sourceLink = page.locator('#agent-answer').getByRole('link',{name:'SAP Help Portal'});
  await sourceLink.waitFor();
  assert.equal(await sourceLink.getAttribute('href'),'https://help.sap.com/docs/abap');
  assert.match(await page.locator('#agent-question-attachments').innerText(),/技能：浏览器样例.*MCP：MCP 引用样例/);
  assert.deepEqual((await tasks.get(await page.locator('#agent-history').inputValue())).events
    .filter(event=>event.type==='tool_completed').map(event=>event.tool),['read_skill_file','read_skill_file','web_search']);
  await page.locator('#agent-new').click();
  const pasteWebsite = () => page.locator('#agent-prompt').evaluate(input=>{
    input.setSelectionRange(input.value.length,input.value.length);
    const data = new DataTransfer();
    data.setData('text/plain','https://example.com/fixture');
    return !input.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));
  });
  assert.equal(await pasteWebsite(),true);
  const website = page.locator('#agent-upload-list .agent-website-item');
  assert.equal(await website.getAttribute('title'),'https://example.com/fixture');
  assert.match(await website.innerText(),/example\.com.*\/fixture/s);
  await website.getByRole('button',{name:'移除网站 example.com'}).click();
  assert.equal(await page.locator('#agent-send').isDisabled(),true);
  assert.equal(await pasteWebsite(),true);
  assert.equal(await page.locator('#agent-prompt').inputValue(),'');
  await page.locator('#agent-send').click();
  await page.locator('#agent-answer').filter({hasText:'网页内容：采购文档。'}).getByRole('link',{name:'网页测试来源'}).waitFor();
  await page.locator('#agent-new').click();
  await page.locator('#agent-upload-input').setInputFiles({name:'截图.png',mimeType:'image/png',
    buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOqsAAAAASUVORK5CYII=','base64')});
  await page.locator('#agent-prompt').fill('读取截图测试');
  await page.locator('#agent-send').click();
  await page.locator('#agent-answer').filter({hasText:'截图内容：SAP 界面。'}).waitFor();
  const imageTask = await tasks.get(await page.locator('#agent-history').inputValue());
  assert.ok(imageTask.messages.some(message=>message.role==='tool'&&message.content.includes('image_analysis')));
  assert.doesNotMatch(JSON.stringify(imageTask),/iVBORw0KGgo/);
  await page.locator('#agent-new').click();
  await page.locator('#agent-prompt').fill('本地工作测试');
  await page.locator('#agent-send').click();
  await page.locator('#agent-answer').filter({hasText:'文档已生成，脚本等待审核。'}).waitFor();
  const localTaskId = await page.locator('#agent-history').inputValue();
  const pending = await tasks.get(localTaskId);
  assert.equal(pending.local_scripts[0].state,'pending');
  assert.deepEqual(pending.generated_files.map(file=>file.name),['本地报告.docx']);
  const getDownload = async name=>{
    const [download] = await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'下载 '+name,exact:true}).click()]);
    assert.equal(download.suggestedFilename(),name);
    return readFile(await download.path());
  };
  const docx = unzipSync(await getDownload('本地报告.docx'));
  assert.match(strFromU8(docx['word/document.xml']),/本地文档[\s\S]*这是生成的正文/);
  await page.getByRole('button',{name:/生成测试文本/}).click();
  const localDialog = page.locator('#agent-local-script-dialog');
  await localDialog.waitFor({state:'visible'});
  assert.match(await localDialog.locator('#agent-local-script-source').innerText(),/writeFileSync/);
  await localDialog.getByRole('button',{name:'运行脚本',exact:true}).click();
  await localDialog.locator('#agent-local-script-output').filter({hasText:'运行正常'}).waitFor();
  assert.equal(await localDialog.getByRole('button',{name:'运行脚本',exact:true}).count(),0);
  await localDialog.getByRole('button',{name:'关闭脚本详情'}).click();
  assert.equal((await getDownload('result.txt')).toString('utf8'),'本地脚本结果');
  assert.equal((await tasks.get(localTaskId)).local_scripts[0].state,'completed');
  await page.locator('#agent-new').click();
  await page.locator('#agent-prompt').fill('为采购检查创建一个技能');
  await page.locator('#agent-send').click();
  await page.locator('#agent-answer').filter({hasText:'采购检查技能包已生成。'}).waitFor();
  const skillZip = unzipSync(await getDownload('skill-po-review.zip'));
  assert.match(strFromU8(skillZip['SKILL.md']),/docs\/checklist.md/);
  assert.equal(strFromU8(skillZip['docs/checklist.md']),'核对数量和供应商。');
  const mcpChange = page.locator('.agent-mcp-change');
  const askMcp = async (action,answer) => {
    await page.locator('#agent-new').click();
    await page.locator('#agent-prompt').fill('MCP 管理测试：'+action);
    await page.locator('#agent-send').click();
    await page.locator('#agent-answer').filter({hasText:answer}).waitFor();
  };
  const extensionsFile = join(directory,'agent','extensions.json');
  const customMcp = async () => JSON.parse(await readFile(extensionsFile,'utf8')).mcp.find(server=>server.name==='对话添加样例');
  await askMcp('添加','请确认 MCP 变更。');
  assert.equal(await customMcp(),undefined);
  await mcpChange.getByRole('button',{name:'确认变更',exact:true}).click();
  await mcpChange.getByText('已完成',{exact:true}).waitFor();
  assert.equal((await customMcp()).enabled,false);
  await store.createToken('MCP 管理测试');
  const reservation = createServer();
  await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
  mcpTestPort = reservation.address().port;
  await new Promise(resolve=>reservation.close(resolve));
  await askMcp('启动','请确认 MCP 变更。');
  await mcpChange.getByRole('button',{name:'确认变更',exact:true}).click();
  await mcpChange.getByText('已完成',{exact:true}).waitFor();
  await askMcp('状态','对外服务正在运行。');
  await askMcp('停止','请确认 MCP 变更。');
  await mcpChange.getByRole('button',{name:'取消',exact:true}).click();
  await mcpChange.getByText('已取消',{exact:true}).waitFor();
  await askMcp('状态','对外服务正在运行。');
  await askMcp('停止','请确认 MCP 变更。');
  await mcpChange.getByRole('button',{name:'确认变更',exact:true}).click();
  await mcpChange.getByText('已完成',{exact:true}).waitFor();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'passed', checks: ['model-settings', 'default-model-data', 'task', 'safe-rendering',
    'default-connection-selection', 'connection-remembered', 'settings-reload', 'table-data-setting', 'table-data-revocation', 'history-reload',
    'continuous-chat', 'live-output', 'hover-session-actions','inline-session-title', 'cleanup-preview', 'delete-cancel-confirm', 'stop-resume', 'mobile-layout',
    'agent-home','system-selector-model-switch','top-navigation','three-pane-workspace','system-scoped-history','session-bound-report','report-update','report-management','system-scoped-cleanup',
    'unified-draft-review','save-before-activation','readback-without-retry','preserve-composer-on-close',
    'client-write-menu','client-write-mode-persistence','client-write-mode-isolation','skill-folder-zip-and-ai','skill-reference-reading','web-search-with-sources','chat-mcp-management'], screenshots: root }));
} finally { releaseWorkflowSave(); await browser?.close(); await host.close(); await rm(directory, { recursive: true, force: true }); }
