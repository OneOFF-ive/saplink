import type { AgentTask } from '../task-store.js';
import { workingMessages } from './context.js';
import { estimateTokens } from './token-estimate.js';
import { agentModelTools } from '../cli-executor.js';
import { artifactTool } from '../artifacts.js';
import { changePreviewTool } from '../drafts/change-preview.js';
import { operationProposalTool } from '../drafts/operation-proposal.js';
import { workflowProposalTool } from '../drafts/workflow-proposal.js';
import { webSearchTool } from '../web-search.js';
import { requestedWebUrls, webPageTool } from '../web-page.js';
import { customMcpTools } from '../extensions.js';
import { localWorkTools } from '../local-work.js';
import { memoryTool } from '../long-term-memory.js';
import { mcpManagementTools } from '../mcp-management.js';
import { skillDraftTool } from '../skill-packages.js';
import { createReportTool, updateReportTool } from '../report.js';
import { askUserTool } from '../questions.js';

const automaticWriteTools = new Set([
  'propose_source_change',
  'propose_controlled_operation',
  'propose_program_workflow',
]);
const automaticWriteDescription = '客户端完全写入：根据本轮用户需求生成并立即执行此变更、操作或程序计划，无需逐项审批。必须单独调用；真实 URI、源码基线和 SAP 传输任务仍须核对，失败后停止。参数以本工具 schema 为准。';

export function taskTools(
  task: AgentTask,
  urls = task.repair_only ? [] : requestedWebUrls(task.latest_prompt ?? task.prompt),
) {
  const tools = [
    ...agentModelTools(task.allow_table_data === true),
    artifactTool,
    changePreviewTool,
    operationProposalTool,
    workflowProposalTool,
    webSearchTool,
    ...(urls.length ? [webPageTool] : []),
    ...(task.custom_mcp_enabled ? customMcpTools : []),
    ...(task.repair_only ? [] : [...localWorkTools, memoryTool, ...mcpManagementTools]),
    ...(!task.repair_only && task.skill_authoring_enabled ? [skillDraftTool] : []),
    ...(task.output_mode === 'chat' ? [createReportTool, updateReportTool] : []),
    askUserTool,
  ];
  if (task.repair_only || !task.write_enabled || task.write_mode !== 'unrestricted') return tools;

  return tools.map(tool => {
    if (!automaticWriteTools.has(tool.function.name)) return tool;
    return {
      ...tool,
      function: { ...tool.function, description: automaticWriteDescription },
    };
  });
}

export function estimateTaskContext(task: AgentTask) {
  return estimateTokens(workingMessages(task), taskTools(task));
}
