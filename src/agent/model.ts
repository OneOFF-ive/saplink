import { AppError } from '../errors.js';
import { maxOutputTokens, modelContextTokens, maxOutputCharacters, maxToolArgumentCharacters, maxModelStreamBytes, modelIdleTimeoutMs } from './output-limits.js';
import { estimateTokens } from './token-estimate.js';

export type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
export type Message = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null;
  tool_calls?: ToolCall[]; tool_call_id?: string; reasoning_content?: string };
export type ReasoningEffort = 'low' | 'high' | 'max';
export type ModelTool = { type: 'function'; function: { name: string; description: string; parameters: unknown } };
export type Completion = { message: Message; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
export type Model = (messages: Message[], tools: ModelTool[], signal: AbortSignal,
  onText: (text: string) => void) => Promise<Completion>;

export class ModelLengthError extends AppError {
  constructor(readonly text: string, readonly partialToolCall: boolean, readonly usage?: Completion['usage']) {
    super('MODEL_OUTPUT_TRUNCATED', modelErrorMessage('MODEL_OUTPUT_TRUNCATED'));
  }
}

const failure = (code: string): never => { throw new AppError(code, modelErrorMessage(code)); };
export function modelErrorMessage(code: string) {
  return ({ MODEL_AUTH_FAILED: '模型认证失败，请在本机配置有效的 DeepSeek API Key。',
    MODEL_RATE_LIMITED: '模型服务限流，请稍后在当前对话重试。', MODEL_TIMEOUT: '模型响应超时，请稍后在当前对话重试。',
    MODEL_CONNECTION_FAILED: '暂时无法连接模型服务，请检查网络后重试。',
    MODEL_HTTP_ERROR: '模型服务拒绝了本次请求，请稍后重试或检查模型设置。',
    MODEL_INVALID_STREAM: '模型服务返回了无法读取的响应，请稍后重试。',
    MODEL_INCOMPLETE_STREAM: '模型服务在回答完成前断开了连接，请稍后重试。',
    MODEL_NOT_CONFIGURED: '尚未配置 DeepSeek API Key。', MODEL_OUTPUT_TRUNCATED: '模型输出被截断，不能作为完成结果。',
    MODEL_CONTEXT_LIMIT: '输入已占满模型上下文，请整理对话或减少本轮资料后继续。'
  } as Record<string, string>)[code] ?? '模型响应无法验证，任务已停止。';
}

// Parse a full tool-call turn before dispatch. A partial stream cannot execute SAP tools.
export async function readModelStream(body: ReadableStream<Uint8Array>, onText: (text: string) => void,
  onActivity: () => void = () => {}): Promise<Completion> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const calls = new Map<number, ToolCall>();
  let buffer = '', content = '', reasoning = '', finish: string | undefined, done = false, size = 0;
  let usage: Completion['usage'];
  function frame(raw: string) {
    if (done) return;
    const data = raw.split(/\r?\n/).filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data) return;
    if (data === '[DONE]') { done = true; return; }
    let chunk;
    try { chunk = JSON.parse(data); } catch { return failure('MODEL_INVALID_JSON'); }
    if (!chunk || typeof chunk !== 'object' || chunk.error || !Array.isArray(chunk.choices)) failure('MODEL_INVALID_STREAM');
    if (chunk.usage) usage = Object.fromEntries(['prompt_tokens', 'completion_tokens', 'total_tokens']
      .filter(key => Number.isSafeInteger(chunk.usage[key]) && chunk.usage[key] >= 0)
      .map(key => [key, chunk.usage[key]]));
    for (const choice of chunk.choices) {
      if (choice.index !== 0 || finish !== undefined || !choice.delta || typeof choice.delta !== 'object') failure('MODEL_INVALID_STREAM');
      const delta = choice.delta;
      if (delta.reasoning_content != null) {
        if (typeof delta.reasoning_content !== 'string') failure('MODEL_INVALID_STREAM');
        reasoning += delta.reasoning_content;
        if (reasoning.length > maxOutputCharacters) failure('MODEL_RESPONSE_LIMIT');
      }
      if (delta.content != null) {
        if (typeof delta.content !== 'string') failure('MODEL_INVALID_STREAM');
        content += delta.content;
        if (content.length > maxOutputCharacters) failure('MODEL_RESPONSE_LIMIT');
        onText(delta.content);
      }
      if (delta.tool_calls !== undefined) {
        if (!Array.isArray(delta.tool_calls)) failure('MODEL_INVALID_TOOL');
        for (const part of delta.tool_calls) {
          if (!Number.isInteger(part.index) || part.index < 0 || part.index >= 8 ||
              (part.type !== undefined && part.type !== 'function')) failure('MODEL_INVALID_TOOL');
          const call = calls.get(part.index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (part.id !== undefined) {
            if (typeof part.id !== 'string' || !part.id || (call.id && call.id !== part.id)) failure('MODEL_INVALID_TOOL');
            call.id = part.id;
          }
          for (const key of ['name', 'arguments'] as const) {
            const value = part.function?.[key];
            if (value !== undefined) {
              if (typeof value !== 'string') failure('MODEL_INVALID_TOOL');
              call.function[key] += value;
            }
          }
          if (call.id.length > 256 || call.function.name.length > 128 || call.function.arguments.length > maxToolArgumentCharacters)
            failure('MODEL_INVALID_TOOL');
          calls.set(part.index, call);
        }
      }
      if (choice.finish_reason != null) finish = choice.finish_reason;
    }
  }
  function consume() {
    let match;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      frame(buffer.slice(0, match.index));
      buffer = buffer.slice(match.index + match[0].length);
    }
  }
  for await (const bytes of body) {
    if (bytes.byteLength) onActivity();
    size += bytes.byteLength;
    // SSE framing is substantially larger than the generated text itself.
    if (size > maxModelStreamBytes) failure('MODEL_RESPONSE_LIMIT');
    buffer += decoder.decode(bytes, { stream: true });
    consume();
    if (done) break;
  }
  buffer += decoder.decode(); consume();
  if (!done && buffer.trim()) frame(buffer);
  if (!done) failure('MODEL_INCOMPLETE_STREAM');
  if (finish === 'length') throw new ModelLengthError(content, calls.size > 0, usage);
  if (!['stop', 'tool_calls'].includes(finish ?? '')) failure('MODEL_INVALID_STREAM');
  const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
  const ids = new Set<string>();
  for (const call of toolCalls) {
    if (!call.id || !call.function.name || ids.has(call.id)) failure('MODEL_INVALID_TOOL');
    ids.add(call.id);
    let args;
    try { args = JSON.parse(call.function.arguments); } catch { return failure('MODEL_INVALID_TOOL'); }
    if (!args || typeof args !== 'object' || Array.isArray(args)) failure('MODEL_INVALID_TOOL');
  }
  if ((finish === 'tool_calls') !== Boolean(toolCalls.length) || (!toolCalls.length && !content.trim())) failure('MODEL_INVALID_STREAM');
  return { message: { role: 'assistant', content: content || null,
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}), ...(reasoning ? { reasoning_content: reasoning } : {}) }, usage };
}

async function rejectedContext(response: Response) {
  if (response.status !== 400 || !response.body) return false;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '', bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 8192) return false;
      text += decoder.decode(value, { stream: true });
    }
    const error = JSON.parse(text + decoder.decode())?.error;
    return error?.code === 'context_length_exceeded' || (typeof error?.message === 'string' &&
      /maximum context length|context length (?:limit |is )?exceeded|exceeds? (?:the )?(?:model(?:'s)? )?(?:maximum )?context (?:length|window)|输入.{0,12}超过.{0,12}上下文/i.test(error.message));
  } catch { return false; }
  finally { await reader.cancel().catch(() => {}); }
}

export function deepSeekModel(apiKey: string, model = 'deepseek-flash', request: typeof fetch = fetch, reasoningEffort: ReasoningEffort = 'high'): Model {
  if (!apiKey.trim()) failure('MODEL_NOT_CONFIGURED');
  if (!['deepseek-flash', 'deepseek-v4-pro'].includes(model)) failure('MODEL_UNSUPPORTED');
  return async (messages, tools, signal, onText) => {
    const requestMessages = messages.map(message => message.role === 'assistant' && message.reasoning_content === undefined
        ? { ...message, reasoning_content: '' } : message);
    const outputTokens = Math.min(maxOutputTokens, modelContextTokens - estimateTokens(requestMessages, tools));
    if (outputTokens < 1) failure('MODEL_CONTEXT_LIMIT');
    const timeout = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const activity = () => {
      clearTimeout(timer);
      timer = setTimeout(() => timeout.abort(), modelIdleTimeoutMs);
      timer.unref?.();
    };
    activity();
    try {
      const response = await request('https://api.deepseek.com/chat/completions', {
        method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, timeout.signal]),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages: requestMessages, ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
          stream: true, stream_options: { include_usage: true },
          thinking: { type: 'enabled' }, reasoning_effort: reasoningEffort, max_tokens: outputTokens })
      });
      if (!response.ok) {
        if (response.status === 400 && await rejectedContext(response)) failure('MODEL_CONTEXT_LIMIT');
        if (!response.bodyUsed) await response.body?.cancel();
        failure([401, 403].includes(response.status) ? 'MODEL_AUTH_FAILED'
          : response.status === 429 ? 'MODEL_RATE_LIMITED' : 'MODEL_HTTP_ERROR');
      }
      if (!response.body || !response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) {
        await response.body?.cancel(); failure('MODEL_INVALID_STREAM');
      }
      activity();
      return await readModelStream(response.body!, onText, activity);
    } catch (error) {
      if (signal.aborted) throw new AppError('AGENT_STOPPED', '任务已停止；不表示 SAP 后端请求已取消。');
      if (timeout.signal.aborted) failure('MODEL_TIMEOUT');
      if (error instanceof AppError) throw error;
      return failure('MODEL_CONNECTION_FAILED');
    } finally { clearTimeout(timer!); }
  };
}
