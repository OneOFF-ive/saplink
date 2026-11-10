import test from 'node:test';
import assert from 'node:assert/strict';
import { automaticTitle,taskTitle } from '../src/agent/title.js';
test('automatic titles summarize SAP targets and purposes without copying long instructions',()=>{
  assert.equal(automaticTitle('请对 ZMMP026 做可复核的完整只读实现分析，覆盖主程序和 INCLUDE。'),'ZMMP026 程序分析');
  assert.equal(automaticTitle('请对 ZMMP026 做完整实现分析，不修改 SAP，也不分析修改影响。'),'ZMMP026 程序分析');
  assert.equal(automaticTitle('请分析 ZDEMO 的修改会影响哪些对象，并列出尚未核实的关系'),'ZDEMO 影响分析');
  assert.equal(automaticTitle('请分析这项修改会影响哪些对象，并列出尚未核实的关系'),'修改影响分析');
  assert.ok(Array.from(automaticTitle('这是一段非常非常非常非常非常非常非常长的普通会话问题')).length<=18);
});
test('legacy titles are shortened without changing explicitly named conversations',()=>{
  const prompt='请对 ZMMP026 做完整分析，提供尽可能详细的逻辑说明';
  assert.equal(taskTitle({prompt}),'ZMMP026 程序分析');
  assert.equal(taskTitle({prompt,title:'我自己命名的会话标题'}),'我自己命名的会话标题');
});
