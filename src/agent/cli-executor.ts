import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { toolSchemas, toolDescription, type ToolName } from '../tool-definitions.js';
import { tableDataToolNames, writeTools } from '../tool-policy.js';
import { AppError } from '../errors.js';
import type { ModelTool } from './model.js';

// Positive allowlist: a newly added tool is never implicitly available to the agent.
export const agentReadTools = [
  'get_capabilities', 'search_objects', 'list_package_objects', 'read_source',
  'get_ddic_definition', 'get_data_element', 'get_domain_values', 'find_references',
  'find_definition', 'get_class_structure', 'get_type_hierarchy', 'search_enhancements', 'get_odata_service_binding',
  'list_source_versions', 'compare_source_versions', 'list_function_group_members', 'get_function_group', 'get_atc_configuration', 'list_transport_requests'
] as const satisfies readonly ToolName[];
export const agentTableTools = tableDataToolNames satisfies readonly ToolName[];
export type ReadTool = typeof agentReadTools[number] | typeof agentTableTools[number];
export type Execute = (name: ReadTool, input: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;

export function validateAgentTool(name: string, raw: unknown, connectionId: string, allowTableData = false) {
  if ((agentTableTools as readonly string[]).includes(name) && !allowTableData)
    throw new AppError('AGENT_TABLE_DATA_DISABLED', '本任务未允许访问表数据；请在连接配置中确认权限后新建任务。');
  const allowed: readonly string[] = allowTableData ? [...agentReadTools, ...agentTableTools] : agentReadTools;
  if (!allowed.includes(name) || writeTools.has(name))
    throw new AppError('AGENT_TOOL_DENIED', '当前 Agent 只允许指定的只读分析工具。');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new AppError('AGENT_INVALID_ARGUMENTS', '工具参数必须为一个对象。');
  const args = raw as Record<string, unknown>;
  if (args.connection_id !== undefined && args.connection_id !== connectionId)
    throw new AppError('AGENT_TARGET_CHANGED', '工具目标与任务选定连接不一致。');
  const tool = name as ReadTool;
  const parsed = toolSchemas[tool].safeParse({ ...args, connection_id: connectionId });
  if (!parsed.success) throw new AppError('AGENT_INVALID_ARGUMENTS', '工具参数不符合当前操作定义。');
  return { name: tool, input: parsed.data as Record<string, unknown> };
}

export function agentModelTools(allowTableData = false): ModelTool[] {
  const tools: readonly ReadTool[] = allowTableData ? [...agentReadTools, ...agentTableTools] : agentReadTools;
  return tools.map(name => {
    const parameters = z.toJSONSchema(toolSchemas[name], { io: 'input' });
    // The harness binds the connection and validates the full shared schema at
    // dispatch. Do not repeat its UUID and selection instructions in every tool.
    delete parameters.properties?.connection_id;
    if (parameters.required) parameters.required = parameters.required.filter(key => key !== 'connection_id');
    return { type: 'function', function: { name, description: toolDescription(name), parameters } };
  });
}

// Real SAP discovery can contain hundreds of editor/service templates. The
// agent already has a fixed tool catalog; do not put that entire payload into
// model context or mistake the 64 KiB result limit for a failed SAP login.
export function projectAgentResult(name: ReadTool, operation: unknown): unknown {
  if (name !== 'get_capabilities' || !operation || typeof operation !== 'object') return operation;
  const result = operation as Record<string, unknown>;
  if (!result.data || typeof result.data !== 'object' || Array.isArray(result.data)) return operation;
  const { discovery, ...capabilities } = result.data as Record<string, unknown>;
  if (!Array.isArray(discovery)) return operation;
  return { ...result, data: { ...capabilities, discovery_summary: {
    workspace_count: discovery.length,
    collection_count: discovery.reduce((sum, workspace) => sum + (Array.isArray(workspace?.collection) ? workspace.collection.length : 0), 0),
    full_discovery_omitted: true,
    note: 'Service templates are omitted from agent context. Advertised capabilities are not authorization or verified availability.'
  } } };
}

const objectReadFailures: Record<string, string> = {
  ADT_ERROR: 'SAP ADT 未能完成这次读取。此结果不能视为没有找到对象。',
  AUTH_FAILED: '本次 SAP 登录失败，请检查连接凭据。',
  HTTP_FORBIDDEN: 'SAP 拒绝了这次操作，请核对授权。',
  OBJECT_LOCKED: '本次操作涉及的对象已锁定。',
  CAPABILITY_UNSUPPORTED: '当前后端不支持这次读取。',
  INVALID_URI: '本次读取的对象地址无效。请使用 SAP 搜索结果中的对象地址。',
  OBJECT_NOT_FOUND: 'SAP 未找到本次请求的对象或接口。',
  VERSION_UNAVAILABLE: 'SAP 未返回所请求的对象版本。'
};

export function projectAgentReadFailure(name: ReadTool, operation: unknown) {
  if (!operation || typeof operation !== 'object') return;
  const result = operation as { status?: unknown; operation_id?: unknown;
    error?: { code?: unknown; details?: { http_status?: unknown; sap_message?: unknown } } };
  const code = result.error?.code;
  if (result.status !== 'error' || typeof code !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/.test(code)) return;
  const http = result.error?.details?.http_status;
  const sapMessage = result.error?.details?.sap_message;
  const unsupportedType = name === 'search_objects' && code === 'ADT_ERROR' && http === 400 &&
    typeof sapMessage === 'string' && /^Value [A-Z0-9/]+ for property TYPE is invalid\.?$/i.test(sapMessage);
  return { status: 'error' as const,
    ...(typeof result.operation_id === 'string' && z.uuid().safeParse(result.operation_id).success ? { operation_id: result.operation_id } : {}),
    error: { code: unsupportedType ? 'SEARCH_TYPE_UNSUPPORTED' : code,
      message: unsupportedType ? '当前 SAP ADT 不支持搜索这个对象类型。'
        : (Object.hasOwn(objectReadFailures, code) ? objectReadFailures[code] : '本次工具调用失败，请根据错误码判断是否能改用其他方法。'),
      ...(typeof http === 'number' && Number.isInteger(http) && http >= 400 && http <= 599 ? { http_status: http } : {}) }
  };
}

export function cliExecutor(directory: string, expectedTarget?: string, allowTableData = false): Execute {
  const cli = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
  return async (name, raw, signal) => {
    // Enforce policy here too, even when called without the runtime.
    const { input } = validateAgentTool(name, raw, String(raw.connection_id ?? ''), allowTableData);
    if (signal.aborted) throw new AppError('AGENT_STOPPED', '任务已停止。');
    const env: NodeJS.ProcessEnv = { ...process.env, SAPLINK_CONFIG_DIR: directory, SAPLINK_AUTO_UPDATE_CHECK: '0' };
    delete env.DEEPSEEK_API_KEY;
    delete env.SAPLINK_PROBE_API_KEY;
    if (expectedTarget) env.SAPLINK_EXPECTED_TARGET_FINGERPRINT = expectedTarget;
    return new Promise((resolve, reject) => {
      let output = '', size = 0, tooLarge = false, settled = false;
      // No model-controlled command, executable, path or shell arguments.
      const child = spawn(process.execPath, [cli, 'sap', name, '--input', '-', '--json'], {
        windowsHide: true, shell: false, env, stdio: ['pipe', 'pipe', 'pipe']
      });
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 45000);
      const abort = () => child.kill();
      signal.addEventListener('abort', abort, { once: true });
      const finish = (error?: AppError, data?: unknown) => {
        if (settled) return;
        settled = true; clearTimeout(timeout); signal.removeEventListener('abort', abort);
        error ? reject(error) : resolve(data);
      };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        size += Buffer.byteLength(chunk);
        if (size > 4 * 1024 * 1024) { tooLarge = true; child.kill(); } else output += chunk;
      });
      // Drain but never log stderr: backend diagnostics may carry sensitive values.
      child.stderr.on('data', () => {});
      child.stdin.on('error', () => {});
      child.once('error', () => finish(new AppError('AGENT_CLI_UNAVAILABLE', '无法启动本机 SapLink CLI。')));
      child.once('close', code => {
        if (signal.aborted) return finish(new AppError('AGENT_STOPPED', '读取已停止；SAP 服务器不保证取消。'));
        if (timedOut) return finish(new AppError('AGENT_TOOL_TIMEOUT', '本次 SAP 工具调用超时。'));
        if (tooLarge) return finish(new AppError('AGENT_RESULT_LIMIT', '工具结果过大，请缩小分析范围。'));
        let result;
        try { result = JSON.parse(output); } catch { return finish(new AppError('AGENT_CLI_FAILED', 'CLI 未返回完整的结构化结果。')); }
        if (code === 1 && result?.status === 'error') {
          const failure = projectAgentReadFailure(name, result.data ?? result);
          if (failure?.error.code === 'AGENT_TARGET_CHANGED' || failure?.error.code === 'CONNECTION_NOT_FOUND')
            return finish(new AppError('AGENT_TARGET_CHANGED', '连接身份已改变，请重新核对目标并创建任务。'));
          if (failure) return finish(undefined, failure);
        }
        if (code !== 0 || result?.status !== 'success' || result.data?.status !== 'success')
          return finish(new AppError('AGENT_SAP_FAILED', 'SAP 读取失败，请检查登录、权限、能力或当前锁状态。'));
        finish(undefined, projectAgentResult(name, result.data));
      });
      child.stdin.end(JSON.stringify(input));
    });
  };
}
