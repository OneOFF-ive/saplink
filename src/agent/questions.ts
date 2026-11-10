import { z } from 'zod';
import type { ModelTool } from './model.js';

const question = z.object({
  prompt: z.string().trim().min(1).max(300),
  options: z.array(z.string().trim().min(1).max(120)).max(5).default([])
}).strict();
export const askUserInput = z.object({
  questions: z.array(question).min(1).max(4)
}).strict();
export const pendingQuestionSchema = askUserInput.extend({ id: z.uuid() });
export type PendingQuestion = z.infer<typeof pendingQuestionSchema>;
export const questionReplyInput = z.object({
  question_id: z.uuid(),
  answers: z.array(z.string().trim().min(1).max(600).nullable()).min(1).max(4)
}).strict();

export const askUserTool: ModelTool = {
  type: 'function',
  function: {
    name: 'ask_user',
    description: '当缺少必须由用户决定的业务信息时，单独调用此工具暂停任务并显示提问卡片。适合给出简短选项或请用户填写。可通过 SAP 只读查询核实的内容先自行查询。此工具不用于获取密码、密钥、写入授权或替代审批。',
    parameters: {
      type: 'object', additionalProperties: false, required: ['questions'],
      properties: {
        questions: {
          type: 'array', minItems: 1, maxItems: 4,
          items: {
            type: 'object', additionalProperties: false, required: ['prompt'],
            properties: {
              prompt: { type: 'string', maxLength: 300 },
              options: { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 120 } }
            }
          }
        }
      }
    }
  }
};
