import type { TaskEvent } from './task-store.js';
import { marked } from 'marked';
import { z } from 'zod';
import { maxOutputCharacters } from './output-limits.js';
import type { ModelTool } from './model/model.js';

export const createReportInput=z.object({title:z.string().trim().min(1).max(80),content:z.string().trim().min(1).max(maxOutputCharacters)}).strict();
export const createReportTool:ModelTool={type:'function',function:{name:'create_report',description:'在当前会话中新建一份独立、完整的分析报告。仅保存本机报告，不操作 SAP；不会覆盖已有报告。',parameters:{type:'object',properties:{title:{type:'string',description:'简短报告标题'},content:{type:'string',description:'完整 Markdown 报告，使用规定的六类章节按需组织'}},required:['title','content'],additionalProperties:false}}};
export const updateReportInput=z.object({report_id:z.union([z.uuid(),z.string().regex(/^[a-f0-9]{64}$/),z.literal('legacy')]),content:z.string().trim().min(1).max(maxOutputCharacters),title:z.string().trim().min(1).max(80).optional()}).strict();
export const updateReportTool:ModelTool={type:'function',function:{name:'update_report',description:'用户要求更新报告时，更新当前会话中指定报告的完整内容，保持报告编号，不新建报告。使用已有报告编号，不能猜测或跨会话操作。',parameters:{type:'object',properties:{report_id:{type:'string',description:'已有报告编号；“这份报告”使用当前查看报告的编号'},content:{type:'string',description:'更新后的完整 Markdown，不能只提交改动片段'},title:{type:'string',description:'仅需改标题时提供，否则保留原标题'}},required:['report_id','content'],additionalProperties:false}}};
export const reportDecisionInstructions=`根据用户意图调用 create_report 新建或 update_report 更新报告。用户要求分析 SAP 程序、梳理业务流程或评估修改影响等独立分析时，完成分析后主动新建报告，即使用户没有说“生成报告”。明确要求另建报告时也新建。若无法调用 create_report，直接以规定的 Markdown 二级标题输出完整报告，客户端会自动保存。要求补充、修订、更新已有报告时调用 update_report，必须提交完整内容并保留仍适用的原文。“这份报告”指当前查看报告资料中的 report_id；若用户指定另一份已有报告，使用其真实编号。目标不明确、没有可更新报告或更新失败时，在对话中说明，不猜编号、不擅自覆盖或以新建代替更新。普通追问、简短解释和闲聊直接回答，不使用规定的报告标题。选中报告本身不表示用户要求更新。两个工具只保存当前会话的本机报告，不读取或修改 SAP。成功后简短说明报告标题，不重复整份正文。报告内容遵循以下结构：\n`;

const reportHeadings = new Set(['对象', '调用链', '业务解读', '影响分析', '改造建议', '完整结论']);
export function requestsProgramOverview(prompt: string) {
  const request = prompt.replace(/[`*]/g, '').trim().replace(/[。！？.!?]+$/u, '').trim()
    .replace(/^(?:请|麻烦)?\s*(?:帮我)?\s*/u, '');
  const target = request.match(/^(?:看一下|看下|看看|分析一下|分析下|分析|解读一下|解读|理解一下|了解一下)\s*(.+)$/u)?.[1];
  if (!target) return /^[A-Z][A-Z0-9_]{2,}\s*(?:程序\s*)?(?:分析一下|看一下|解读一下)\s*(?:(?:这|该|此)个?程序)?$/iu.test(request);
  const subject = target.replace(/^[\p{L}\p{N}_ -]+?系统(?:中|里)?的?\s*/u, '');
  return /^(?:(?:这|该|此)个?程序|(?:ABAP\s*)?程序\s*[A-Z][A-Z0-9_]{2,}|[A-Z][A-Z0-9_]{2,}\s*(?:ABAP\s*)?程序|[ZY][A-Z0-9_]{2,})$/iu.test(subject);
}

export function isStructuredReport(content: string) {
  if (!content.includes('##')) return false;
  const blocks = marked.lexer(content);
  return blocks.some((block, index) => {
    if (block.type !== 'heading' || block.depth !== 2 || !reportHeadings.has(block.text)) return false;
    for (const next of blocks.slice(index + 1)) {
      if (next.type === 'heading' && next.depth <= 2) return false;
      if (!['heading', 'space', 'hr', 'html'].includes(next.type) &&
          !/^(?:暂无|无|不适用|未提供|待补充)[。！\s]*$/.test(next.raw.trim())) return true;
    }
    return false;
  });
}

export const reportInstructions = `本轮生成分析报告。按用户需求和实际证据选择以下六类 Markdown 二级标题；不相关的整类省略，不为凑页签输出空标题、暂无或模板。标题固定为“对象”“调用链”“业务解读”“影响分析”“改造建议”“完整结论”，不要生成“能力总览”。同一标题只出现一次；类内用三级标题组织以下结构。
## 对象
### 已定位关键对象
| 对象 | 类型 | 用途 | 关联 |
| --- | --- | --- | --- |
逐行列出本次实际定位的对象，每行一个对象，不把多个表合并一行。类型使用 ABAP程序、ABAP类、函数、INCLUDE、标准表、自定义表、配置、接口或其他；用途和关联没有依据时填“未核实”。没有实际定位对象时省略表格并明确说明缺口。不要根据问题中的名称、示例或惯例虚构对象或数量，不把源码里提到的名称自动当作已定位对象。
## 调用链
### 核心调用链
用有序列表逐步列出入口、调用对象及作用；分支、动态调用、读写方向明确标注。只描述有依据的调用关系，不把数据依赖当调用。
### 依赖关系
用“当前对象 | 直接依赖 | 间接依赖 | 影响”表格列举依赖；没有完整遍历时写已知对象名或未核实，不编造依赖数量。
## 业务解读
### 业务流程
用有序列表逐步说明业务步骤及输入输出。
### 业务解释
用通俗语言解释对象如何实现用户关注的业务。
### 风险点
按需列出事实、推断及待验证风险。
## 影响分析
### 影响摘要
仅在有充分依据时用“指标 | 结果”两列表格列出直接修改对象、关联对象、需回归接口、风险等级；缺少依据的指标省略，不推测数量或级别。
### 影响范围
用“对象 | 建议 | 原因”表格说明直接和间接影响；只有用户有明确修改目标时才分析相应修改范围。不编造修改数量或风险等级。
### 回归范围
按需列出应验证的正常、异常及边界场景。
## 改造建议
### 建议改造
给出与用户需求相关的具体建议，必要时使用 diff 或 ABAP 代码块；代码示意与可执行变更须区分。当前只读，明确未执行写入，不暗示已经修改、检查或激活。
## 完整结论
完整回答用户的问题，汇总关键判断、证据和分析范围，明确事实、推断与未核实事项。不要输出准备报告的自述。不要生成统计卡片或工具调用记录；这些由界面根据对象表和真实执行记录呈现。`;

export function reportToolRecords(events: TaskEvent[]) {
  const records = new Map<string,{name:string;completed:number;failed:number}>();
  for (const event of events) {
    if (!event.tool || !['tool_completed','tool_failed'].includes(event.type)) continue;
    const record=records.get(event.tool)??{name:event.tool,completed:0,failed:0};
    if(event.type==='tool_completed')record.completed++;else record.failed++;
    records.set(event.tool,record);
  }
  return [...records.values()];
}
