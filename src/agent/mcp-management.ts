import { z } from 'zod';
import { mcpInput } from './extensions.js';
import type { ModelTool } from './model.js';

const serverId = { server_id:z.uuid() };
const port = z.number().int().min(1).max(65535);
export const mcpChangeInput = z.discriminatedUnion('action',[
  mcpInput.omit({token:true,enabled:true}).extend({action:z.literal('add')}),
  mcpInput.omit({token:true,enabled:true}).extend({action:z.literal('edit'),...serverId}),
  z.strictObject({action:z.literal('toggle'),...serverId,enabled:z.boolean()}),
  z.strictObject({action:z.literal('remove'),...serverId}),
  z.strictObject({action:z.literal('start'),port:port.optional()}),
  z.strictObject({action:z.literal('stop')})
]);
export const mcpInspectInput = z.discriminatedUnion('action',[
  z.strictObject({action:z.literal('list')}),
  z.strictObject({action:z.literal('status')}),
  z.strictObject({action:z.literal('test'),...serverId})
]);
export const mcpProposalSchema = z.strictObject({
  id:z.uuid(), change:mcpChangeInput, label:z.string(), expected:z.string(),
  state:z.enum(['pending','submitted','completed','cancelled'])
});
export type McpProposal = z.infer<typeof mcpProposalSchema>;
export type LocalMcpStatus = {running:boolean;port:number};
export type LocalMcpControl = {
  status:()=>LocalMcpStatus;
  start:(port:number,expected:LocalMcpStatus)=>Promise<void>;
  stop:(expected:LocalMcpStatus)=>Promise<void>;
};

export const mcpManagementTools:ModelTool[] = [
  {type:'function',function:{name:'inspect_mcp_services',
    description:'管理 SapLink 的 MCP。list 列出助手安装的自定义服务（含停用项），test 测试已配置服务并统计可用只读工具，status 查看供第三方 AI 连接的 SapLink MCP 服务状态。',
    parameters:z.toJSONSchema(mcpInspectInput,{io:'input'})}},
  {type:'function',function:{name:'propose_mcp_change',
    description:'仅在用户明确要求时提交 MCP 配置变更，等待用户在客户端确认。add/edit/toggle/remove 针对助手自定义服务，先 list 核对目标；start/stop 针对对外 SapLink MCP 服务，默认使用当前端口。令牌只能在设置中填写。此工具不会执行变更。',
    parameters:z.toJSONSchema(mcpChangeInput,{io:'input'})}}
];
