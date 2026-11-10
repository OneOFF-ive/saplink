import { unzipSync,zipSync } from 'fflate';
import { z } from 'zod';
import { AppError } from '../errors.js';
import type { ModelTool } from './model.js';

const maxBytes = 8 * 1024 * 1024;
const maxFiles = 128;
const maxEncoded = Math.ceil(maxBytes / 3) * 4;
const base64 = z.string().max(maxEncoded).regex(/^[A-Za-z0-9+/]*={0,2}$/);
const pathInput = z.string().min(1).max(240);
const packageFile = z.object({path:pathInput,data:base64}).strict();
export const packageInput = z.discriminatedUnion('format',[
  z.object({format:z.literal('folder'),files:z.array(packageFile).min(1).max(maxFiles)}).strict(),
  z.object({format:z.literal('zip'),data:base64}).strict()
]);
export const skillPackageRequestLimit = 12 * 1024 * 1024;
export const maxSkillBody = 32000;
export const skillFileInput = z.object({path:pathInput,offset:z.int().min(0).default(0)}).strict();
export const readSkillFileInput = skillFileInput.extend({skill_id:z.uuid()});
export const skillFileTool:ModelTool = {type:'function',function:{name:'read_skill_file',
  description:'读取相关技能包的 SKILL.md，首段同时返回文件清单。其他文件路径须来自该清单。长文件使用返回的 next_offset 继续读。',
  parameters:z.toJSONSchema(readSkillFileInput,{io:'input'})}};

export const skillDraft = z.object({
  files:z.array(z.object({path:pathInput,text:z.string().max(maxSkillBody)}).strict()).min(1).max(8)
}).strict();
export const skillChatInput = z.object({
  messages:z.array(z.object({role:z.enum(['user','assistant']),content:z.string().trim().min(1).max(4000)}).strict()).min(1).max(24),
  draft:skillDraft.optional()
}).strict().refine(input=>input.messages.at(-1)?.role==='user');
export const skillDraftTool:ModelTool = {type:'function',function:{name:'draft_skill_package',
  description:'提出供用户预览和安装的完整技能包草稿，每次返回完整文件集，必须包含根目录 SKILL.md。',
  parameters:z.toJSONSchema(skillDraft,{io:'input'})}};

const packageError = (message:string) => new AppError('AGENT_SKILL_PACKAGE_INVALID',message);
function validatePath(path:string) {
  if (path.split('/').some(part=>!part || part==='.' || part==='..' || /[. ]$/.test(part) ||
      /[\\:\u0000-\u001f<>"|?*]/u.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) ||
      ['__proto__','constructor','prototype'].includes(part.toLowerCase())))
    throw packageError('技能包包含无效的文件路径。');
}
function decode(data:string) {
  const bytes = Buffer.from(data,'base64');
  if (bytes.toString('base64')!==data) throw packageError('技能包文件编码无效。');
  return bytes;
}
function zipFiles(bytes:Buffer) {
  try {
    if (bytes.length<22 || bytes.length>maxBytes) throw new Error();
    let count = 0, size = 0;
    const paths = new Set<string>();
    const files = unzipSync(bytes,{filter:entry=>{
      if (++count>maxFiles*2 || (size+=Math.max(entry.originalSize,entry.size))>maxBytes)
        throw packageError('技能包解压后最多 8 MiB、128 个文件。');
      const directory = entry.name.endsWith('/');
      const path = directory ? entry.name.slice(0,-1) : entry.name;
      validatePath(pathInput.parse(path));
      const key = path.toLowerCase();
      if (paths.has(key)) throw packageError('技能包包含重名文件。');
      paths.add(key);
      return !directory;
    }});
    return Object.entries(files);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw packageError('无法读取 ZIP 技能包，请检查压缩包格式和大小。');
  }
}
export function prepareSkillPackage(input:z.infer<typeof packageInput>) {
  const entries = input.format==='zip' ? zipFiles(decode(input.data))
    : input.files.map(file=>[file.path,decode(file.data)] as const);
  return normalizePackage(entries);
}
export function prepareSkillDraft(draft:z.infer<typeof skillDraft>) {
  return normalizePackage(draft.files.map(file=>[file.path,Buffer.from(file.text)]));
}
export function exportSkillDraft(draft:z.infer<typeof skillDraft>) {
  const {name,files} = prepareSkillDraft(draft);
  const slug = name.replace(/[^\p{L}\p{N}_-]+/gu,'-').slice(0,64);
  return {name:`skill-${slug}.zip`,bytes:Buffer.from(zipSync(Object.fromEntries(
    files.map(file=>[file.path,Buffer.from(file.data,'base64')])
  )))};
}
function normalizePackage(entries:ReadonlyArray<readonly [string,Uint8Array]>) {
  let size = 0;
  const seen = new Set<string>();
  const accepted = entries.filter(([path,bytes])=>{
    validatePath(path);
    const key = path.toLowerCase();
    if (seen.has(key)) throw packageError('技能包包含重名文件。');
    seen.add(key);
    size += bytes.length;
    return !path.split('/').some(part=>['.git','__macosx','.ds_store','thumbs.db'].includes(part.toLowerCase()));
  });
  if (size>maxBytes || accepted.length>maxFiles) throw packageError('技能包最多 8 MiB、128 个文件。');
  const filePaths = new Set(accepted.map(([path])=>path.toLowerCase()));
  for (const path of filePaths) {
    for (let slash = path.indexOf('/'); slash!==-1; slash = path.indexOf('/',slash+1)) {
      if (filePaths.has(path.slice(0,slash))) throw packageError('技能包包含同名的文件和目录。');
    }
  }
  const root = accepted.find(([path])=>path.toLowerCase()==='skill.md');
  const nested = accepted.filter(([path])=>path.split('/').length===2 && path.toLowerCase().endsWith('/skill.md'));
  const main = root ?? (nested.length===1 && accepted.every(([path])=>path.startsWith(nested[0][0].split('/')[0]+'/')) ? nested[0] : undefined);
  if (!main) throw packageError('请导入包含一个根目录 SKILL.md 的技能包。');
  const prefixLength = main[0].length-'SKILL.md'.length;
  const body = skillText(main[1]);
  if (!body?.trim() || body.length>maxSkillBody) throw packageError('SKILL.md 须为 UTF-8 文本且不超过 32000 字符。');
  const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(body)?.[1] ?? '';
  const metadata = (key:string) => {
    const match = header.match(new RegExp('^'+key+':[ \\t]*([^\\r\\n]+)((?:\\r?\\n[ \\t]+[^\\r\\n]*)*)','m'));
    if (!match) return undefined;
    const value = match[1].trim();
    return /^[>|][+-]?$/.test(value) ? match[2].trim().replace(/\s+/g,' ') : value.replace(/^(['"])(.*)\1$/,'$2');
  };
  const name = (metadata('name') || main[0].split('/')[0].replace(/^skill\.md$/i,'') || '自定义技能').slice(0,80);
  const description = (metadata('description') || '').slice(0,500);
  const files = accepted.map(([path,bytes])=>({
    path:path===main[0]?'SKILL.md':path.slice(prefixLength),data:Buffer.from(bytes).toString('base64')
  })).sort((a,b)=>a.path.localeCompare(b.path));
  return {name,description,body,files};
}

export function skillText(bytes:Uint8Array) {
  try {
    const text = new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    return /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text) ? undefined : text;
  } catch { return undefined; }
}
