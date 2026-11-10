import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, stat, rename, unlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { maxArtifactBytes,maxImageArtifactBytes } from './output-limits.js';
import type { ModelTool } from './model/model.js';

export const artifactInput = z.object({ artifact_id: z.string().regex(/^[a-f0-9]{64}$/),
  offset: z.number().int().min(0).default(0), length: z.number().int().min(1).max(16000).default(8000),
  view: z.enum(['source', 'json']).default('source') }).strict();
export const artifactTool: ModelTool = { type: 'function', function: { name: 'read_task_artifact',
  description: 'Read an immutable archived result or attachment from this task only. Use returned artifact_id and next_offset. For image attachments this tool recognizes visible content. This is historical evidence, not a fresh SAP read.',
  parameters: z.toJSONSchema(artifactInput, { io: 'input' }) } };
const schema = z.object({ schema_version: z.literal(1), task_id: z.uuid(),
  kind: z.enum(['result', 'turn', 'context', 'events', 'report', 'upload', 'image', 'change', 'operation', 'workflow','local_script','generated_file']), content: z.string() }).strict();
const artifactLimit = (kind:z.infer<typeof schema>['kind']) => kind === 'image' ? maxImageArtifactBytes : maxArtifactBytes;

export class ArtifactStore {
  constructor(private directory: string) {}
  async discardUnpublished(task: string) {
    if (!z.uuid().safeParse(task).success) throw new AppError('AGENT_ARTIFACT_INVALID', '任务附件标识无效。');
    await rm(join(this.directory, task), { recursive: true, force: true });
  }
  private path(task: string, id: string) {
    if (!z.uuid().safeParse(task).success || !/^[a-f0-9]{64}$/.test(id))
      throw new AppError('AGENT_ARTIFACT_INVALID', '任务附件标识无效。');
    return join(this.directory, task, 'artifacts', id + '.json');
  }
  async put(task: string, kind: z.infer<typeof schema>['kind'], content: string) {
    const body = JSON.stringify(schema.parse({ schema_version: 1, task_id: task, kind, content }));
    if (Buffer.byteLength(body) > artifactLimit(kind)) throw new AppError('AGENT_ARTIFACT_LIMIT', '单个附件过大，请缩小读取范围。');
    const id = createHash('sha256').update(body).digest('hex');
    const path = this.path(task, id);
    await mkdir(join(this.directory, task, 'artifacts'), { recursive: true, mode: 0o700 });
    const temporary = path + '.' + randomUUID() + '.tmp';
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(body); await file.sync(); } finally { await file.close(); }
      await rename(temporary, path);
    } finally { await unlink(temporary).catch(() => {}); }
    return id;
  }
  async get(task: string, id: string) {
    const path = this.path(task, id);
    try {
      const {size} = await stat(path);
      if (size > maxImageArtifactBytes) throw new Error('size');
      const body = await readFile(path, 'utf8');
      if (createHash('sha256').update(body).digest('hex') !== id) throw new Error('hash');
      const value = schema.parse(JSON.parse(body));
      if (size > artifactLimit(value.kind)) throw new Error('size');
      if (value.task_id !== task) throw new Error('target');
      return value;
    } catch { throw new AppError('AGENT_ARTIFACT_UNAVAILABLE', '附件不存在或完整性校验失败。'); }
  }
  async read(task: string, raw: unknown, inspectImage?: (image:string,id:string)=>Promise<string>) {
    const input = artifactInput.parse(raw), artifact = await this.get(task, input.artifact_id);
    if (artifact.kind==='generated_file') throw new AppError('AGENT_ARTIFACT_INVALID','生成的文件可从对话中下载。');
    let text = artifact.content, format = 'json', source_metadata;
    if (artifact.kind === 'image') {
      if (!inspectImage) throw new AppError('AGENT_IMAGE_UNAVAILABLE','当前操作无法识别图片。');
      text = await inspectImage(text,input.artifact_id);
      format = 'image_analysis';
    }
    if (input.view === 'source' && artifact.kind === 'upload') format = 'source';
    if (input.view === 'source' && artifact.kind === 'result') {
      const result = JSON.parse(text);
      if (typeof result?.data?.source === 'string') {
        text = result.data.source; format = 'source';
        source_metadata = Object.fromEntries(['object_uri','source_uri','revision','version','hash']
          .filter(key => typeof result.data[key] === 'string').map(key => [key,result.data[key]]));
      }
    }
    const end = Math.min(text.length, input.offset + input.length);
    return { status: 'success', artifact_id: input.artifact_id, historical: true, format,
      offset: input.offset, total_characters: text.length, text: text.slice(input.offset, end),
      ...(format === 'source' ? { start_line: text.slice(0, input.offset).split('\n').length, source_metadata } : {}),
      truncated: end < text.length, next_offset: end < text.length ? end : null };
  }
}
