import { execFile,spawn } from 'node:child_process';
import { lstat,mkdtemp,mkdir,open,rm,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Document,HeadingLevel,Packer,Paragraph,TextRun } from 'docx';
import { z } from 'zod';
import { AppError } from '../errors.js';
import type { ModelTool } from './model/model.js';

const fileName = z.string().trim().min(1).max(120)
  .regex(/^[\p{L}\p{N}_-][\p{L}\p{N} ._-]*\.[a-z0-9]{1,12}$/iu)
  .refine(value=>!/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(value));
const artifactId = z.string().regex(/^[a-f0-9]{64}$/);
const runtimes = z.enum(['node','powershell']);
export const scriptInput = z.object({title:z.string().trim().min(1).max(100),runtime:runtimes,
  script:z.string().trim().min(1).max(48000),outputs:z.array(fileName).max(6)}).strict()
  .refine(input=>new Set(input.outputs.map(name=>name.toLowerCase())).size===input.outputs.length);
export const documentInput = z.object({filename:fileName.refine(name=>/\.(?:docx|md|txt)$/i.test(name)),
  title:z.string().trim().min(1).max(180),sections:z.array(z.object({
    heading:z.string().trim().max(180).optional(),paragraphs:z.array(z.string().max(10000)).max(40)
  }).strict()).min(1).max(40)}).strict().refine(input=>input.sections.flatMap(section=>section.paragraphs)
    .reduce((size,text)=>size+text.length,0)<=120000);
export const localScriptSchema = z.object({id:z.uuid(),title:z.string().max(100),runtime:runtimes,artifact_id:artifactId,
  state:z.enum(['pending','running','completed','failed','interrupted']),message:z.string().max(200).optional(),
  result_id:artifactId.optional()}).strict();
export const generatedFileSchema = z.object({name:fileName,artifact_id:artifactId,bytes:z.int().min(0).max(8*1024*1024)}).strict();
export type LocalScript = z.infer<typeof localScriptSchema>;
export type GeneratedFile = z.infer<typeof generatedFileSchema>;
export type ScriptInput = z.infer<typeof scriptInput>;

export const localWorkTools:ModelTool[] = [
  {type:'function',function:{name:'propose_local_script',
    description:'按用户明确要求起草本机 JavaScript(Node.js) 或 Windows PowerShell 脚本。此工具只提交待用户审核的脚本。用 UTF-8 输出；需下载的文件写到工作目录下的 output/，并在 outputs 申报文件名。不得通过脚本绕过 SAP 工具权限或读取凭据。',
    parameters:z.toJSONSchema(scriptInput,{io:'input'})}},
  {type:'function',function:{name:'create_local_document',
    description:'根据用户请求生成可下载的本机文档，支持 DOCX、Markdown、TXT。用标题、分节和段落组织内容。',
    parameters:z.toJSONSchema(documentInput,{io:'input'})}}
];

export async function buildLocalDocument(input:z.infer<typeof documentInput>) {
  const name = input.filename;
  if (!/\.docx$/i.test(name)) {
    const markdown = /\.md$/i.test(name);
    const text = [markdown?'# '+input.title:input.title,...input.sections.flatMap(section=>[
      ...(section.heading ? [markdown?'## '+section.heading:section.heading] : []),...section.paragraphs
    ])].join('\n\n');
    return Buffer.from(text+'\n','utf8');
  }
  const paragraphs = [new Paragraph({text:input.title,heading:HeadingLevel.TITLE})];
  for (const section of input.sections) {
    if (section.heading) paragraphs.push(new Paragraph({text:section.heading,heading:HeadingLevel.HEADING_1}));
    for (const paragraph of section.paragraphs) {
      const children = paragraph.split(/\r?\n/).map((text,index)=>new TextRun({text,...(index?{break:1}:{})}));
      paragraphs.push(new Paragraph({children,spacing:{after:120}}));
    }
  }
  return Packer.toBuffer(new Document({title:input.title,sections:[{children:paragraphs}]}));
}

const maxFileBytes = 8*1024*1024, maxRunOutput = 64*1024;
const system32 = join(process.env.SystemRoot ?? 'C:\\Windows','System32');
function runScript(executable:string,args:string[],directory:string,signal:AbortSignal) {
  signal.throwIfAborted();
  return new Promise<{exit_code:number|null;stdout:string;stderr:string;error?:string}>(resolve=>{
    const env = Object.fromEntries(Object.entries(process.env).filter(([name])=>
      ['path','pathext','systemroot','windir','comspec','lang'].includes(name.toLowerCase())));
    const child = spawn(executable,args,{cwd:directory,shell:false,windowsHide:true,
      detached:process.platform!=='win32',stdio:['ignore','pipe','pipe'],
      env:{...env,TEMP:directory,TMP:directory,TMPDIR:directory}});
    const buffers = {stdout:[] as Buffer[],stderr:[] as Buffer[]};
    let size = 0, error:string|undefined;
    function stop(reason:string) {
      if (error) return;
      error = reason;
      if (child.pid) {
        if (process.platform==='win32' && child.exitCode===null)
          execFile(join(system32,'taskkill.exe'),['/pid',String(child.pid),'/t','/f'],{windowsHide:true,timeout:5000},()=>{child.kill();});
        else if (process.platform!=='win32') {
          try { process.kill(-child.pid,'SIGKILL'); } catch { child.kill('SIGKILL'); }
        }
      }
      child.stdout.destroy(); child.stderr.destroy();
    }
    const abort = () => stop('本地脚本运行已中断。');
    signal.addEventListener('abort',abort,{once:true});
    const timer = setTimeout(()=>stop('本地脚本运行超过 60 秒。'),60000);
    for (const stream of ['stdout','stderr'] as const) child[stream].on('data',(chunk:Buffer)=>{
      if (size<maxRunOutput) buffers[stream].push(chunk.subarray(0,maxRunOutput-size));
      size += chunk.length;
      if (size>maxRunOutput) stop('脚本输出超过上限，运行已中断。');
    });
    child.on('error',()=>{error ??= '无法启动本地脚本解释器。';});
    child.once('close',exit_code=>{
      clearTimeout(timer); signal.removeEventListener('abort',abort);
      resolve({exit_code,stdout:Buffer.concat(buffers.stdout).toString('utf8'),stderr:Buffer.concat(buffers.stderr).toString('utf8'),error});
    });
  });
}

export async function executeLocalScript(input:ScriptInput,signal:AbortSignal) {
  if (input.runtime==='powershell' && process.platform!=='win32')
    throw new AppError('AGENT_SCRIPT_RUNTIME','当前系统不提供 Windows PowerShell。');
  const directory = await mkdtemp(join(tmpdir(),'saplink-script-'));
  try {
    const output = join(directory,'output');
    await mkdir(output);
    const script = join(directory,input.runtime==='node'?'run.mjs':'run.ps1');
    const body = input.runtime==='powershell'?'\uFEFF'+input.script:input.script;
    await writeFile(script,body,{encoding:'utf8',flag:'wx'});
    const result = await runScript(input.runtime==='node'?process.execPath:join(system32,'WindowsPowerShell','v1.0','powershell.exe'),
      input.runtime==='node'?[script]:['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',
        "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); & '.\\run.ps1'; if (-not $?) { exit 1 }"],directory,signal);
    const files:{name:string;bytes:Buffer}[] = [], missing:string[] = [];
    let total = 0;
    if (!result.error && result.exit_code===0 && input.outputs.length) {
      const outputDirectory = await lstat(output).catch(()=>undefined);
      for (const name of input.outputs) {
        const path = join(output,name);
        const entry = outputDirectory?.isDirectory() ? await lstat(path).catch(()=>undefined) : undefined;
        if (!entry?.isFile() || entry.size>maxFileBytes || total+entry.size>16*1024*1024) { missing.push(name); continue; }
        const file = await open(path,'r');
        try {
          const bytes = Buffer.alloc(entry.size);
          const read = await file.read(bytes,0,bytes.length,0);
          if (read.bytesRead!==entry.size) { missing.push(name); continue; }
          total += bytes.length;
          files.push({name,bytes});
        } finally { await file.close(); }
      }
    }
    return {...result,files,missing};
  } finally {
    await rm(directory,{recursive:true,force:true}).catch(()=>{});
  }
}
