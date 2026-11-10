import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { acquireLease } from '../lease.js';
import type { ModelTool } from './model.js';

const candidate = z.object({
  kind:z.enum(['preference','lesson']),
  topic:z.string().trim().min(2).max(80),
  note:z.string().trim().min(2).max(400),
  evidence:z.string().trim().min(2).max(160)
}).strict();
export const memoryInput = z.object({entries:z.array(candidate).min(1).max(3)}).strict();
const record = candidate.omit({evidence:true}).extend({
  task_id:z.uuid(), created_at:z.iso.datetime(),
  evidence_artifact:z.string().regex(/^[a-f0-9]{64}$/).optional()
});
export const recalledMemoriesSchema = z.array(record).max(5);
export type MemoryRecord = z.infer<typeof record>;
export type MemoryCandidate = z.infer<typeof candidate>;

export const memoryTool:ModelTool = {type:'function',function:{
  name:'remember_for_future',
  description:'自动提取跨会话可复用记忆。preference 只记用户明确表达的长期偏好，evidence 是当前用户原话的连续片段。lesson 只记可复用的排查步骤，evidence 是本轮已成功读取的 SAP 源码或元数据附件编号。用稳定的 topic 去重。仅保存简短描述，禁止保存源码、表数据、密码、个人资料或写入授权。只在确有可复用信息时调用。',
  parameters:{type:'object',additionalProperties:false,required:['entries'],properties:{
    entries:{type:'array',minItems:1,maxItems:3,items:{type:'object',additionalProperties:false,
      required:['kind','topic','note','evidence'],properties:{
        kind:{type:'string',enum:['preference','lesson']},topic:{type:'string',minLength:2,maxLength:80},
        note:{type:'string',minLength:2,maxLength:400},evidence:{type:'string',minLength:2,maxLength:160}
      }}}
  }}
}};

function terms(text:string) {
  const matches = text.normalize('NFKC').toLowerCase().match(/[a-z0-9_]{2,}|[\p{Script=Han}]+/gu) ?? [];
  return new Set(matches.flatMap(term => /^[\p{Script=Han}]+$/u.test(term)
    ? Array.from({length:term.length-1},(_,index)=>term.slice(index,index+2)) : [term]));
}

export class LongTermMemory {
  private readonly directory:string;
  private pending = Promise.resolve();
  constructor(private readonly configDirectory:string) {
    this.directory = join(configDirectory,'agent','memory');
  }
  private path(fingerprint:string) {
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('Invalid memory scope');
    return join(this.directory,fingerprint+'.json');
  }
  private async read(fingerprint:string) {
    try { return z.array(record).max(100).parse(JSON.parse(await readFile(this.path(fingerprint),'utf8'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
  async recall(fingerprint:string, taskId:string, query:string) {
    const words = terms(query);
    return (await this.read(fingerprint)).filter(entry=>entry.task_id !== taskId)
      .map(entry=>({entry,score:[...terms(entry.topic+' '+entry.note)].reduce((count,word)=>
        count+(words.has(word)?(/[0-9_]/.test(word)?2:1):0),0)}))
      .filter(({entry,score})=>entry.kind === 'preference' || score >= 2)
      .sort((a,b)=>b.score-a.score || b.entry.created_at.localeCompare(a.entry.created_at))
      .slice(0,5).map(({entry})=>entry);
  }
  save(fingerprint:string, entries:MemoryRecord[]) {
    const next = this.pending.then(async () => {
      const path = this.path(fingerprint);
      await mkdir(this.directory,{recursive:true,mode:0o700});
      const release = await acquireLease(this.configDirectory,`agent-memory-${fingerprint}.lock`);
      const temporary = join(this.directory,randomUUID()+'.tmp');
      try {
        const merged = new Map((await this.read(fingerprint)).map(entry=>[this.key(entry),entry]));
        for (const entry of entries) {
          const key = this.key(entry);
          merged.delete(key);
          merged.set(key,entry);
        }
        await writeFile(temporary,JSON.stringify([...merged.values()].slice(-100)),{mode:0o600});
        await rename(temporary,path);
      } finally {
        await unlink(temporary).catch(()=>{});
        await release();
      }
    });
    this.pending = next.then(()=>{},()=>{});
    return next;
  }
  private key(entry:MemoryRecord) {
    return entry.kind+':'+entry.topic.normalize('NFKC').toLowerCase().replace(/\s+/g,' ');
  }
}
