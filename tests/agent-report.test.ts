import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { reportToolRecords } from '../src/agent/report.js';

const context=vm.createContext({window:{}});
vm.runInContext(await readFile(new URL('../web/report.js',import.meta.url),'utf8'),context);
const parse=(text:string)=>JSON.parse(JSON.stringify(vm.runInContext('window.SapLinkReport.parse',context)(text)));
const sections=(text:string)=>JSON.parse(JSON.stringify(vm.runInContext('window.SapLinkReport.sections',context)(text)));
const inventory='## 已定位关键对象\n| 对象 | 类型 | 用途 | 关联 |\n| --- | --- | --- | --- |\n';
test('report inventory derives counts from explicit deduplicated objects and preserves analysis',()=>{
  const parsed=parse(inventory+'| ZDEMO | ABAP程序 | 测试 | MM |\n| zdemo | ABAP程序 | 重复 | MM |\n| MARA | 标准表 | 物料 | MM |\n| ZCFG | 配置 | 规则 | 未核实 |\n| ZAPI | 接口 | 调用 | SRM |\n\n## 分析结论\n保持这条结论。');
  assert.deepEqual(parsed.counts,[1,1,1,1]);assert.equal(parsed.objects.length,4);
  assert.equal(parsed.body,'## 分析结论\n保持这条结论。');
});
test('legacy prose, unrelated tables and code examples do not invent inventory or zero totals',()=>{
  for(const text of ['程序里提到 MARA。','## 其他表格\n| 对象 | 类型 | 用途 | 关联 |\n| --- | --- | --- |\n| Z | 类 | 示例 | MM |','```markdown\n'+inventory+'| Z | 类 | 示例 | MM |\n```']){
    const parsed=parse(text);assert.equal(parsed.counts,null);assert.equal(parsed.objects.length,0);assert.equal(parsed.body,text);
  }
});
test('inventory keeps untrusted content as text and handles escaped table separators',()=>{
  const parsed=parse(inventory+'| Z | 类 | <img src=x onerror=alert(1)> | MM\\|FI |');
  assert.equal(parsed.objects[0].purpose,'<img src=x onerror=alert(1)>');assert.equal(parsed.objects[0].relation,'MM|FI');
});
test('tool badges count actual outcomes and keep failures distinct from successes',()=>{
  const events=['tool_started','tool_completed','tool_failed','model_started'].map((type,index)=>({sequence:index+1,time:new Date().toISOString(),type,tool:'read_source'}));
  assert.deepEqual(reportToolRecords(events),[{name:'read_source',completed:1,failed:1}]);
});
test('report tabs follow the fixed order and omit absent or empty categories',()=>{
  const tabs=sections('## 完整结论\n已完成范围说明。\n## 调用链\n### 核心调用链\n1. A → B\n## 影响分析\n暂无\n## 业务解读\n### 业务解释\n业务说明。');
  assert.deepEqual(tabs.map(tab=>tab.name),['调用链','业务解读','完整结论']);
  assert.equal(sections('## 影响分析\n暂无').length,0);
  assert.equal(sections('## 影响分析\n### 影响范围').length,0);
});
test('impact summary omits unknown metrics and code examples',()=>{
  const metrics=vm.runInContext('window.SapLinkReport.metrics',context)('| 指标 | 结果 |\n| --- | --- |\n| 直接修改对象 | 2 |\n| 风险等级 | 未核实 |\n```\n| 关联对象 | 999 |\n```');
  assert.deepEqual(JSON.parse(JSON.stringify(metrics)),[{label:'直接修改对象',value:'2'}]);
});
test('tab headings inside code do not split content and legacy reports retain every section',()=>{
  const tabs=sections('## 改造建议\n### 建议改造\n```markdown\n## 影响分析\n```\n## 完整结论\n结果。');
  assert.deepEqual(tabs.map(tab=>tab.name),['改造建议','完整结论']);assert.ok(tabs[0].content.includes('## 影响分析'));
  const legacy=sections('原说明。\n'+inventory+'| ZDEMO | ABAP程序 | 示例 | MM |\n\n## 分析结论\n原结论。');
  assert.deepEqual(legacy.map(tab=>tab.name),['对象','完整结论']);
  assert.ok(legacy[0].content.includes('ZDEMO'));assert.ok(legacy[1].content.includes('原说明'));assert.ok(legacy[1].content.includes('原结论'));
});
