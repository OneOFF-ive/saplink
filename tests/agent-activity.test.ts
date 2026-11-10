import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const context=vm.createContext({window:{}});vm.runInContext(await readFile(new URL('../web/activity.js',import.meta.url),'utf8'),context);
const build=(task:unknown)=>JSON.parse(JSON.stringify(vm.runInContext('window.SapLinkActivity.build',context)(task,Date.parse('2026-10-31T01:00:10Z'))));
const event=(sequence:number,type:string,tool?:string)=>({sequence,type,tool,time:`2026-10-31T01:00:0${sequence}Z`});
test('activity pairs outcomes, groups repeated tools and preserves individual failures',()=>{
  const value=build({status:'completed',events:[event(1,'created'),event(2,'tool_started','read_source'),event(3,'tool_completed','read_source'),event(5,'tool_started','read_source'),event(6,'tool_failed','read_source'),event(7,'completed')]});
  assert.equal(value.groups.length,1);assert.equal(value.groups[0].rows.length,2);assert.equal(value.groups[0].status,'failed');
  assert.equal(value.groups[0].rows[0].status,'completed');assert.equal(value.operations,2);assert.equal(value.elapsed,6);
});
test('activity shows public model summaries and links each result to its completion event',()=>{
  const value=build({status:'completed',events:[event(1,'model_started'),
    {...event(2,'model_finished'),summary:'先定位开发对象。'},event(3,'tool_started','search_objects'),
    {...event(4,'tool_completed','search_objects'),result_artifact_id:'a'.repeat(64)},event(5,'completed')]});
  assert.deepEqual(value.groups.map((group:{tool:string})=>group.tool),['model','search_objects']);
  assert.equal(value.groups[0].rows[0].summary,'先定位开发对象。');
  assert.equal(value.groups[1].rows[0].result,4);
  assert.equal(value.operations,1);
});
test('activity shows the current follow-up and does not turn interrupted old work into running work',()=>{
  const events=[event(1,'tool_started','read_source'),event(2,'stopped'),event(3,'resumed'),event(4,'model_started')];
  const resumed=build({status:'running',events});assert.equal(resumed.groups[0].status,'interrupted');assert.equal(resumed.current,'model');
  const next=build({status:'running',events:[...events,event(5,'followup'),event(6,'model_started')],live:{text:'回答'}});
  assert.equal(next.operations,0);assert.equal(next.current,'answer');assert.equal(next.turn,5);
});
test('archived outcomes have unknown duration and incomplete attempts never become successes',()=>{
  const value=build({status:'completed',events_archived:true,events:[event(1,'tool_completed','search_objects'),event(2,'tool_started','read_source'),event(3,'completed')]});
  assert.equal(value.partial,true);assert.equal(value.groups[0].rows[0].incomplete,true);assert.equal(value.groups[1].status,'interrupted');
});

test('inline activity expands while running, collapses on completion and can be reopened',async()=>{
  const source=await readFile(new URL('../web/agent.js',import.meta.url),'utf8');
  const start=source.indexOf('  function renderActivity() {');
  const end=source.indexOf('\n  const localScriptDialog',start);
  const noticeStart=source.indexOf('  function streamStatus(message) {');
  const noticeEnd=source.indexOf('  function stopStreaming()',noticeStart);
  assert.ok(start>=0&&end>start);
  assert.ok(noticeStart>=0&&noticeEnd>noticeStart);
  class Node {
    children:Node[]=[];
    dataset:Record<string,string>={};
    hidden=false;
    open=false;
    constructor(public tag:string,public textContent='') {}
    append(...children:Node[]){this.children.push(...children);}
    replaceChildren(){this.children=[];}
    querySelectorAll(){return [];}
    setAttribute(){}
  }
  const nodes=new Map<string,Node>();
  const node=(selector:string)=>{
    if(!nodes.has(selector))nodes.set(selector,new Node(selector));
    return nodes.get(selector)!;
  };
  const task={id:'test',current_user_id:'initial',status:'running',events:[event(1,'model_started'),
    {...event(2,'model_finished'),summary:'先核对对象定义。'},event(3,'tool_started','search_objects')]};
  const render=vm.createContext({$:node,window:{SapLinkActivity:{build}},selectedTask:task,
    activityKey:undefined,activityTurn:undefined,activityWasActive:false,activityResults:new Map(),streamNotice:'',
    element:(tag:string,text?:string)=>new Node(tag,text),icon:()=>new Node('svg'),icons:()=>{},
    activityDuration:()=> '3秒',toolNames:{search_objects:'搜索对象'},names:{failed:'分析失败'}});
  vm.runInContext(source.slice(start,end),render);
  vm.runInContext(source.slice(noticeStart,noticeEnd),render);
  const draw=()=>vm.runInContext('renderActivity()',render);
  const history=node('#agent-activity-history');
  vm.runInContext('streamStatus("正在重连：1 / 5")',render);
  assert.equal(node('#agent-activity-current').textContent,'正在重连：1 / 5');
  vm.runInContext('streamStatus("")',render);
  assert.equal(node('#agent-activity-current').textContent,'正在搜索对象');
  draw();
  assert.equal(history.open,true);
  assert.equal(node('#agent-events').children[0].textContent,'先核对对象定义。');
  assert.equal(node('#agent-events').children[1].children[0].tag,'details');
  history.open=false;draw();
  assert.equal(history.open,false);
  history.open=true;task.status='completed';task.events.push(event(4,'tool_completed','search_objects'),event(5,'completed'));draw();
  assert.equal(history.open,false);
  assert.equal(node('#agent-activity-time').textContent,'用时 3秒');
  history.open=true;draw();
  assert.equal(history.open,true);
});

test('inline tool results append plain text on scroll without pagination buttons',async()=>{
  const source=await readFile(new URL('../web/agent.js',import.meta.url),'utf8');
  const start=source.indexOf('  const activityResults');
  const end=source.indexOf('  function renderActivity()',start);
  assert.ok(start>=0&&end>start);
  class Node {
    children:Node[]=[];
    hidden=false;
    scrollHeight=800;
    scrollTop=0;
    clientHeight=280;
    onScroll?:()=>void;
    constructor(public tag:string,public textContent='') {}
    append(...children:Node[]){this.children.push(...children);}
    setAttribute(){}
    addEventListener(_name:string,handler:()=>void){this.onScroll=handler;}
  }
  const paths:string[]=[];
  const render=vm.createContext({element:(tag:string,text?:string)=>new Node(tag,text),
    document:{createTextNode:(text:string)=>new Node('#text',text)},api:async (path:string)=>{
    paths.push(path);
    const second=path.endsWith('=12000');
    return {text:second?'第二页':'<b>工具原文</b>',offset:second?12000:0,total_characters:12003,
      previous_offset:second?0:null,next_offset:second?null:12000};
  }});
  vm.runInContext(source.slice(start,end),render);
  const result=vm.runInContext("inlineToolResult('task', 4)",render);
  assert.equal(paths.length,0);
  result.show();await new Promise<void>(resolve=>setImmediate(resolve));
  const output=result.node.children[1] as Node;
  assert.equal(output.tag,'pre');
  assert.equal(output.children[0].textContent,'<b>工具原文</b>');
  assert.equal(result.node.children.length,2);
  result.show();
  output.onScroll!();
  assert.deepEqual(paths,['agent/tasks/task/tool-results/4?offset=0']);
  output.scrollTop=520;
  output.onScroll!();output.onScroll!();
  await new Promise<void>(resolve=>setImmediate(resolve));
  assert.deepEqual(output.children.map(node=>node.textContent),['<b>工具原文</b>','第二页']);
  output.onScroll!();
  assert.deepEqual(paths,['agent/tasks/task/tool-results/4?offset=0','agent/tasks/task/tool-results/4?offset=12000']);
});

test('the current reply stays hidden until text is available',async()=>{
  const source=await readFile(new URL('../web/agent.js',import.meta.url),'utf8');
  const start=source.indexOf('  function renderCurrentReply');
  const end=source.indexOf('  function drawDraft',start);
  assert.ok(start>=0&&end>start);
  const nodes={'#agent-current-reply':{hidden:false},'#agent-stream-note':{hidden:false}};
  const render=vm.createContext({$:(id:keyof typeof nodes)=>nodes[id],renderAnswer:()=>{}});
  vm.runInContext(source.slice(start,end),render);
  const show=vm.runInContext('renderCurrentReply',render);
  show('',true);
  assert.equal(nodes['#agent-current-reply'].hidden,true);
  show('正在输出的正文',true);
  assert.equal(nodes['#agent-current-reply'].hidden,false);
  assert.equal(nodes['#agent-stream-note'].hidden,false);
  show('最终回复',false);
  assert.equal(nodes['#agent-stream-note'].hidden,true);
});

test('stream failures retry five times then fall back to HTTP polling without starting a task',async()=>{
  const source=await readFile(new URL('../web/agent.js',import.meta.url),'utf8');
  const from=source.indexOf('  async function connectDraftStream');
  const to=source.indexOf('  function ensureStreaming()',from);
  assert.ok(from>=0&&to>from);
  const messages:string[]=[];
  const session={controller:new AbortController(),http:false};
  let attempts=0,polls=0;
  const ctx=vm.createContext({streamSession:session,streamStatus:(text:string)=>messages.push(text),
    streamRetryDelay:async()=>{},readDraftStream:async()=>{attempts++;throw new Error('offline');},
    poll:()=>{polls++;}});
  vm.runInContext(source.slice(from,to),ctx);
  await vm.runInContext('connectDraftStream(streamSession,"task")',ctx);
  assert.equal(attempts,6);
  assert.equal(polls,1);
  assert.equal(session.http,true);
  assert.deepEqual(messages,[1,2,3,4,5].map(n=>`正在重连：${n} / 5`).concat('已切换为 HTTP 输出'));
});

test('stream reconnect stops when the task finishes or the session is cancelled',async()=>{
  const source=await readFile(new URL('../web/agent.js',import.meta.url),'utf8');
  const from=source.indexOf('  async function connectDraftStream');
  const to=source.indexOf('  function ensureStreaming()',from);
  for(const cancel of [false,true]){
    const session={controller:new AbortController(),http:false};
    let attempts=0;
    const ctx=vm.createContext({streamSession:session,streamStatus:()=>{},streamRetryDelay:async()=>{
      if(cancel)session.controller.abort();
    },readDraftStream:async()=>++attempts===2,poll:()=>assert.fail('HTTP fallback was not needed')});
    vm.runInContext(source.slice(from,to),ctx);
    await vm.runInContext('connectDraftStream(streamSession,"task")',ctx);
    assert.equal(attempts,cancel?1:2);
    assert.equal(session.http,false);
  }
});
