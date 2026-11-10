import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../web/agent.js', import.meta.url), 'utf8');
const start = source.indexOf('  async function selectSession(id) {');
const end = source.indexOf('\n  async function submitTask(', start);
assert.ok(start >= 0 && end > start);

function fixture() {
  const rows = ['a', 'b'].map(id => ({
    dataset: { taskId: id }, selected: false, pressed: '',
    classList: { toggle(_name: string, value: boolean) { rows.find(row => row.classList === this)!.selected = value; } },
    querySelector() { return { setAttribute: (_name: string, value: string) => { this.pressed = value; } }; }
  }));
  const nodes: Record<string, { value: string; click?: () => void; onchange?: () => void }> = {
    '#agent-connection': { value: 'system' }, '#agent-history': { value: 'a' }, '#agent-new': { value: '', click: () => {} }
  };
  const requests = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const errors: string[] = [];
  const context = vm.createContext({
    $: (selector: string) => nodes[selector],
    document: { querySelectorAll: () => rows },
    taskList: [{ id: 'a', connection_id: 'system' }, { id: 'b', connection_id: 'system' }],
    selectedTask: { id: 'old', connection_id: 'system' }, generation: 0,
    sessionLoading: false, sessionDetailLoading: false, sessionLoadFailed: false,
    reportTaskId: 'old', currentReportId: 'old-report', reportValue: {}, reportDrawKey: 'old', reportLoading: false, reportRequest: 0,
    chatTaskId: 'old', chatMessages: ['old content'], chatCursor: 'old',
    stopStreaming: () => {}, rememberTask: () => {}, clearUploads: () => {}, pollError: (message: string) => { errors.push(message); },
    renderTask: () => {}, renderHistory: () => {}, renderSetup: () => {}, updateControls: () => {}, schedule: () => {},
    loadConversation: async () => {}, loadReport: async () => {},
    api: (path: string) => new Promise((resolve, reject) => requests.set(path, { resolve, reject }))
  });
  vm.runInContext(source.slice(start, end), context);
  return { context, rows, requests, errors, select: (id: string) => vm.runInContext(`selectSession('${id}')`, context) as Promise<void> };
}

test('selection and loading state update before the request completes', async () => {
  const f = fixture();
  const pending = f.select('a');
  assert.equal(f.context.selectedTask.id, 'a');
  assert.equal(f.context.sessionLoading, true);
  assert.equal(f.context.sessionDetailLoading, true);
  assert.equal(f.rows[0].selected, true);
  assert.equal(f.rows[1].selected, false);
  assert.equal(f.context.reportValue, undefined);
  assert.equal(f.context.chatTaskId, undefined);
  f.requests.get('agent/tasks/a')!.resolve({ id: 'a', connection_id: 'system', answer: 'a answer' });
  await pending;
  assert.equal(f.context.selectedTask.answer, 'a answer');
  assert.equal(f.context.sessionLoading, false);
});

test('a late response cannot overwrite a newer selected session', async () => {
  const f = fixture();
  const first = f.select('a'), second = f.select('b');
  f.requests.get('agent/tasks/b')!.resolve({ id: 'b', connection_id: 'system', answer: 'b answer' });
  await second;
  f.requests.get('agent/tasks/a')!.resolve({ id: 'a', connection_id: 'system', answer: 'a answer' });
  await first;
  assert.equal(f.context.selectedTask.id, 'b');
  assert.equal(f.context.selectedTask.answer, 'b answer');
  assert.equal(f.rows[1].selected, true);
  assert.equal(f.context.sessionLoading, false);
});

test('failed loading stays on selected session and reports the error', async () => {
  const f = fixture();
  const pending = f.select('a');
  f.requests.get('agent/tasks/a')!.reject(new Error('网络不可用'));
  await pending;
  assert.equal(f.context.selectedTask.id, 'a');
  assert.equal(f.context.sessionLoadFailed, true);
  assert.equal(f.context.sessionLoading, false);
  assert.match(f.errors.at(-1)!, /网络不可用/);
});

test('opening or returning to a conversation shows the latest messages, while refreshing preserves reading position', async () => {
  const paginationStart = source.indexOf('  function loadEarlierAtTop() {');
  const paginationEnd = source.indexOf('  async function pinTask(', paginationStart);
  const scrollStart = source.indexOf('  function updateScrollBottom() {');
  const scrollEnd = source.indexOf('  chatScroll.addEventListener', scrollStart);
  const chatScroll = {
    clientHeight: 200,
    scrollHeight: 0,
    position: 0,
    get scrollTop() { return this.position; },
    set scrollTop(value: number) { this.position = Math.min(value, Math.max(0, this.scrollHeight - this.clientHeight)); }
  };
  const scrollBottom = { hidden: true };
  const requests: string[] = [];
  const state = vm.createContext({
    chatScroll, scrollBottom, selectedTask: { id: 'a' }, generation: 0,
    chatTaskId: undefined, chatMessages: [], chatCursor: undefined, earlierRequest: undefined,
    $: () => ({}),
    renderChatHistory: () => { chatScroll.scrollHeight = 600; },
    pollError: assert.fail,
    api: async (path: string) => {
      requests.push(path);
      return { messages: [{ id: 'latest' }], next_cursor: 'older' };
    }
  });
  vm.runInContext(source.slice(scrollStart, scrollEnd) + source.slice(paginationStart, paginationEnd), state);
  const load = (options = '') => vm.runInContext(`loadConversation(${options})`, state) as Promise<void>;
  await load();
  assert.equal(chatScroll.scrollTop, 400);
  assert.equal(scrollBottom.hidden, true);

  chatScroll.scrollTop = 100;
  await load();
  assert.equal(chatScroll.scrollTop, 100);
  assert.equal(scrollBottom.hidden, false);

  await load('{ showLatest: true }');
  assert.equal(chatScroll.scrollTop, 400);
  assert.equal(scrollBottom.hidden, true);
  assert.deepEqual(requests, Array(3).fill('agent/tasks/a/conversation'));
});

test('scrolling to the top fetches one older page and keeps the visible messages in place', async () => {
  const paginationStart = source.indexOf('  function loadEarlierAtTop() {');
  const paginationEnd = source.indexOf('  async function pinTask(', paginationStart);
  const history = { offsetHeight: 300 };
  const chatScroll = { clientHeight: 200, scrollHeight: 300, scrollTop: 80 };
  const requests: string[] = [];
  let finish!: (value: unknown) => void;
  const state = vm.createContext({
    chatScroll, selectedTask: { id: 'a' }, generation: 0,
    chatTaskId: 'a', chatMessages: [{ id: 'recent' }], chatCursor: 'page', earlierRequest: undefined,
    $: () => history, renderChatHistory: () => { history.offsetHeight += 120; chatScroll.scrollHeight += 120; },
    updateScrollBottom: () => {}, pollError: assert.fail,
    api: (path: string) => {
      requests.push(path);
      return new Promise(resolve => { finish = resolve; });
    }
  });
  vm.runInContext(source.slice(paginationStart, paginationEnd), state);
  const atTop = () => vm.runInContext('loadEarlierAtTop()', state);
  atTop();
  assert.deepEqual(requests, []);
  chatScroll.scrollTop = 0;
  atTop();
  atTop();
  assert.deepEqual(requests, ['agent/tasks/a/conversation?before=page']);
  chatScroll.scrollTop = 15;
  finish({ messages: [{ id: 'older' }], next_cursor: null });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(chatScroll.scrollTop, 135);
  assert.equal(state.chatMessages.map((message: { id: string }) => message.id).join(','), 'older,recent');
  chatScroll.scrollTop = 0;
  atTop();
  assert.equal(requests.length, 1);
});

test('question card advances through choices, a custom answer and a skipped question', () => {
  const start=source.indexOf('  let questionView;');
  const end=source.indexOf('  async function sendQuestionAnswers(',start);
  assert.ok(start>=0&&end>start);
  class Node {
    children:Node[]=[];
    value='';
    constructor(public tag:string,public text?:string){}
    append(...nodes:Node[]){this.children.push(...nodes);}
    replaceChildren(){this.children=[];}
    setAttribute(){}
    focus(){}
    onclick?:()=>void;
    onsubmit?:(event:{preventDefault:()=>void})=>void;
  }
  const card=new Node('section'), heading=new Node('h3');
  const submitted:unknown[]=[];
  const context=vm.createContext({
    $:(selector:string)=>selector==='#agent-question-card'?card:heading,
    element:(tag:string,text?:string)=>new Node(tag,text),icon:(name:string)=>new Node('icon',name),icons:()=>{},
    chatScroll:{scrollHeight:500,clientHeight:400,scrollTop:100},
    selectedTask:{pending_question:{id:'one',questions:[
      {prompt:'选择范围',options:['MM','FI']},{prompt:'补充限制',options:[]},{prompt:'补充日期',options:[]}
    ]}},
    sendQuestionAnswers:(state:{answers:unknown[]})=>submitted.push([...state.answers])
  });
  vm.runInContext(source.slice(start,end)+'\nrenderQuestionCard()',context);
  assert.equal(card.children[0].children[0].text,'选择范围');
  card.children[1].children[0].onclick!();
  assert.equal(card.children[0].children[0].text,'补充限制');
  const form=card.children[2];
  form.children[1].value='只看已过账单据';
  form.onsubmit!({preventDefault(){}});
  assert.equal(card.children[0].children[0].text,'补充日期');
  card.children.at(-1)!.children[0].onclick!();
  assert.deepEqual(submitted,[['MM','只看已过账单据',null]]);
});
