import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../errors.js';
import type { Credentials } from '../config.js';

const defaultContextTokens = 512000;
const defaultReasoningEffort = 'high';
const contextPreset = z.union([z.literal(128000),z.literal(512000),z.literal(1000000)]);
const reasoningEffort = z.enum(['low', 'high', 'max']);
export const modelSettingsInput = z.object({ model: z.enum(['deepseek-flash', 'deepseek-v4-pro']),
  api_key: z.string().trim().max(1024).optional(),
  reasoning_effort: reasoningEffort.optional(),
  context_tokens: contextPreset.optional() }).strict();
const metadataSchema = z.object({ schema_version: z.literal(1), model: modelSettingsInput.shape.model,
  credential_id: z.uuid().optional(), allow_table_data: z.boolean().optional(),
  reasoning_effort: z.union([reasoningEffort,z.literal('off')]).default(defaultReasoningEffort),
  context_tokens: z.number().optional() }).strict()
  .transform(({context_tokens:_legacyContext,...metadata}) => ({
    ...metadata, context_tokens: contextPreset.safeParse(_legacyContext).data ?? defaultContextTokens,
    reasoning_effort: metadata.reasoning_effort === 'off' ? 'low' as const : metadata.reasoning_effort
  }));
type Metadata = z.infer<typeof metadataSchema>;

export class ModelSettings {
  private directory: string;
  private scope: string;
  private pending: Promise<void> = Promise.resolve();
  constructor(directory: string, private credentials: Credentials) {
    this.directory = join(directory, 'agent');
    this.scope = createHash('sha256').update(process.platform === 'win32' ? resolve(directory).toLowerCase() : resolve(directory)).digest('hex');
  }
  private account(id: string) { return `agent:deepseek:${this.scope}:${id}`; }
  private serialized<T>(action: () => Promise<T>): Promise<T> {
    const next = this.pending.then(action);
    this.pending = next.then(() => {}, () => {});
    return next;
  }
  private metadata(): Promise<Metadata> { return this.serialized(() => this.readMetadata()); }
  private async readMetadata(): Promise<Metadata> {
    try {
      const text = await readFile(join(this.directory, 'model.json'), 'utf8');
      if (text.length > 4096) throw new Error('size');
      return metadataSchema.parse(JSON.parse(text));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schema_version: 1,
        model: process.env.SAPLINK_AGENT_MODEL === 'deepseek-v4-pro' ? 'deepseek-v4-pro' : 'deepseek-flash',
        reasoning_effort: defaultReasoningEffort, context_tokens: defaultContextTokens };
      throw new AppError('MODEL_SETTINGS_INVALID', '模型设置无法读取，请检查本机配置。');
    }
  }
  async resolve() {
    const metadata = await this.metadata();
    if (metadata.credential_id) {
      try {
        const apiKey = await this.credentials.get(this.account(metadata.credential_id));
        if (!apiKey.trim()) throw new Error('empty');
        return { model: metadata.model, apiKey, source: 'windows_credentials' as const, contextTokens: metadata.context_tokens, reasoningEffort: metadata.reasoning_effort };
      } catch { throw new AppError('MODEL_CREDENTIAL_UNAVAILABLE', '无法读取已保存的模型密钥，请重新配置。'); }
    }
    return { model: metadata.model, apiKey: process.env.DEEPSEEK_API_KEY?.trim() ?? '', source: 'environment' as const,
      contextTokens: metadata.context_tokens, reasoningEffort: metadata.reasoning_effort };
  }
  async status() {
    const metadata = await this.metadata();
    try {
      const config = await this.resolve();
      return { provider: 'deepseek', model: config.model, configured: Boolean(config.apiKey),
        key_source: config.apiKey ? config.source : 'none', authentication_verified: false, context_tokens: metadata.context_tokens, reasoning_effort: metadata.reasoning_effort };
    } catch {
      return { provider: 'deepseek', model: metadata.model, configured: false,
        key_source: 'unavailable', authentication_verified: false, context_tokens: metadata.context_tokens, reasoning_effort: metadata.reasoning_effort };
    }
  }
  async save(raw: unknown) {
    const input = modelSettingsInput.parse(raw);
    const previous = await this.metadata();
    const {allow_table_data:_legacyTableData,...previousModel}=previous;
    const next: Metadata = { ...previousModel, model: input.model,
      reasoning_effort: input.reasoning_effort ?? previous.reasoning_effort,
      context_tokens: input.context_tokens ?? previous.context_tokens };
    const key = input.api_key?.trim();
    if (!key && !(await this.status()).configured)
      throw new AppError('MODEL_KEY_REQUIRED', '请先输入 DeepSeek API Key。');
    const newId = key ? randomUUID() : undefined;
    if (newId) {
      try { await this.credentials.set(this.account(newId), key!); }
      catch { throw new AppError('MODEL_CREDENTIAL_STORE_FAILED', '无法保存到 Windows 凭据管理器，原设置未修改。'); }
      next.credential_id = newId;
    }
    const temporary = join(this.directory, `${randomUUID()}.tmp`);
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
      await this.serialized(() => rename(temporary, join(this.directory, 'model.json')));
    } catch {
      if (newId) await this.credentials.remove(this.account(newId)).catch(() => {});
      throw new AppError('MODEL_SETTINGS_SAVE_FAILED', '模型设置未保存，请稍后重试。');
    } finally { await unlink(temporary).catch(() => {}); }
    let cleanupWarning = false;
    if (newId && previous.credential_id) {
      try { await this.credentials.remove(this.account(previous.credential_id)); }
      catch { cleanupWarning = true; }
    }
    return { ...await this.status(), credential_cleanup_warning: cleanupWarning };
  }
}
