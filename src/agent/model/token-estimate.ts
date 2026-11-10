import type { Message, ModelTool } from './model.js';

// Conservative approximation, not a provider tokenizer. Include tool schemas.
export function estimateTokens(messages: Message[], tools: ModelTool[] = []) {
  return Math.ceil(Buffer.byteLength(JSON.stringify({ messages, tools })) / 3) + messages.length * 16;
}
