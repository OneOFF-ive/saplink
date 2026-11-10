import { randomUUID } from 'node:crypto';
import { mkdir,open,readFile,rename,unlink,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { digest,type Credentials } from '../config.js';
import { toolSchemas } from '../tool-definitions.js';
import type { ModelTool } from './model.js';
import { maxSkillBody,skillText,type prepareSkillPackage } from './skill-packages.js';
import { builtinSkillIds,builtinSkills } from './builtin-skills.js';

const common = {name:z.string().trim().min(1).max(80),enabled:z.boolean()};
export const extensionRefsInput = z.object({skills:z.array(z.uuid()).max(12),mcp:z.array(z.uuid()).max(6)}).strict();
export const extensionRefSchema = z.object({id:z.uuid(),name:z.string().max(80),kind:z.enum(['skills','mcp'])}).strict();
export type ExtensionRef = z.infer<typeof extensionRefSchema>;
export const skillInput = z.object({...common,body:z.string().trim().min(1).max(8000)}).strict();
const endpoint = z.url().max(1000).refine(value=>{
  const url = new URL(value);
  return !url.username && !url.password && !url.hash && !url.search &&
    (url.protocol==='https:' || url.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname));
},'请输入 HTTPS MCP 地址，或本机 HTTP 地址。');
const serverFields = {...common,url:endpoint};
export const mcpInput = z.object({...serverFields,enabled:z.boolean().optional(),token:z.string().trim().max(4096)
  .regex(/^(?:[A-Za-z0-9._~+/-]+=*)?$/).optional()}).strict();
const skill = skillInput.extend({id:z.uuid(),body:z.string().trim().min(1).max(maxSkillBody),
  description:z.string().max(500).optional(),files:z.array(z.string()).max(128).optional(),package_id:z.uuid().optional()});
const server = z.object({...serverFields,id:z.uuid(),credential_id:z.uuid().optional()}).strict();
const configSchema = z.object({skills:z.array(skill).max(10),mcp:z.array(server).max(6),
  builtin_disabled:z.array(z.string().refine(id=>builtinSkillIds.includes(id))).max(2).optional()}).strict()
  .transform(({builtin_disabled: _legacy,...config})=>config);
type Config = z.infer<typeof configSchema>;
type Server = z.infer<typeof server>;

export class AgentExtensions {
  private pending = Promise.resolve();
  private readonly path:string;
  private readonly scope:string;
  constructor(private directory:string,private credentials:Credentials) {
    this.path = join(directory,'agent','extensions.json');
    this.scope = digest(process.platform==='win32' ? directory.toLowerCase() : directory);
  }
  private account(id:string) { return 'agent:mcp:'+this.scope+':'+id; }
  async load():Promise<Config> {
    try {
      const content = await readFile(this.path,'utf8');
      if (content.length > 1024*1024) throw new Error();
      return configSchema.parse(JSON.parse(content));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code==='ENOENT') return {skills:[],mcp:[]};
      throw new AppError('AGENT_EXTENSIONS_INVALID','无法读取自定义扩展配置。');
    }
  }
  async available() {
    const [config,builtins] = await Promise.all([this.load(),builtinSkills()]);
    return {mcp:config.mcp,skills:[...builtins.map(entry=>({...entry,enabled:true})),...config.skills]};
  }
  async view() {
    const {skills,mcp} = await this.available();
    return {skills,mcp:mcp.map(({credential_id,...entry})=>({...entry,has_token:Boolean(credential_id)}))};
  }
  async references(input?:z.infer<typeof extensionRefsInput>):Promise<ExtensionRef[]> {
    if (!input?.skills.length && !input?.mcp.length) return [];
    const config = await this.available();
    return (['skills','mcp'] as const).flatMap(kind=>[...new Set(input[kind])].map(id=>{
      const entry = config[kind].find(item=>item.id===id && item.enabled);
      if (!entry) throw new AppError('AGENT_EXTENSION_UNAVAILABLE','引用的技能或 MCP 服务已停用或移除，请重新选择。');
      return {id,name:entry.name,kind};
    }));
  }
  private change(action:(config:Config)=>Promise<void>) {
    const next = this.pending.then(async()=>{await action(await this.load());return this.view();});
    this.pending = next.then(()=>{},()=>{});
    return next;
  }
  private async save(config:Config) {
    const validated = configSchema.parse(config);
    const temporary = this.path+'.'+randomUUID()+'.tmp';
    await mkdir(join(this.directory,'agent'),{recursive:true});
    try {
      await writeFile(temporary,JSON.stringify(validated),{mode:0o600});
      await rename(temporary,this.path);
    } finally { await unlink(temporary).catch(()=>{}); }
  }
  saveSkill(id:string,input:z.infer<typeof skillInput>) {
    return this.change(async config=>{
      if (builtinSkillIds.includes(id)) throw new AppError('AGENT_SKILL_BUILTIN','内置技能随客户端更新。');
      if (config.skills.some(entry=>entry.id===id && entry.files))
        throw new AppError('AGENT_SKILL_PACKAGE_INVALID','已安装的技能包不能通过旧版编辑器覆盖。');
      config.skills = [...config.skills.filter(entry=>entry.id!==id),{id,...input}];
      await this.save(config);
    });
  }
  private packagePath(id:string) { return join(this.directory,'agent','skill-packages',id+'.json'); }
  installSkill({files,...metadata}:ReturnType<typeof prepareSkillPackage>,replaceId?:string) {
    return this.change(async config=>{
      if (replaceId && builtinSkillIds.includes(replaceId))
        throw new AppError('AGENT_SKILL_BUILTIN','内置技能随客户端更新。');
      const index = config.skills.findIndex(entry=>entry.id===replaceId);
      const previous = config.skills[index];
      if (replaceId && !previous) throw new AppError('AGENT_SKILL_NOT_FOUND','此技能已移除。');
      const packageId = randomUUID(), path = this.packagePath(packageId);
      const entry = {id:previous?.id ?? packageId,...metadata,enabled:previous?.enabled ?? false,
        files:files.map(file=>file.path),...(previous ? {package_id:packageId} : {})};
      if (previous) config.skills[index] = entry;
      else config.skills.push(entry);
      configSchema.parse(config);
      await mkdir(join(this.directory,'agent','skill-packages'),{recursive:true});
      const file = await open(path,'wx',0o600);
      try {
        try { await file.writeFile(JSON.stringify(files)); }
        finally { await file.close(); }
        await this.save(config);
      }
      catch (error) { await unlink(path).catch(()=>{}); throw error; }
      if (previous?.files) await unlink(this.packagePath(previous.package_id ?? previous.id)).catch(()=>{});
    });
  }
  setSkillEnabled(id:string,enabled:boolean) {
    return this.change(async config=>{
      if (builtinSkillIds.includes(id)) {
        if (!enabled) throw new AppError('AGENT_SKILL_BUILTIN','内置技能始终启用。');
        return;
      }
      const entry = config.skills.find(skill=>skill.id===id);
      if (!entry) throw new AppError('AGENT_SKILL_NOT_FOUND','此技能已移除。');
      entry.enabled = enabled;
      await this.save(config);
    });
  }
  async skillFile(id:string,path:string,offset:number,requireEnabled=false) {
    const entry = (await this.available()).skills.find(skill=>skill.id===id && (!requireEnabled || skill.enabled));
    if (!entry || !(entry.files ?? ['SKILL.md']).includes(path))
      throw new AppError('AGENT_SKILL_NOT_FOUND','此技能或文件不可用。');
    let text = entry.body;
    if (path!=='SKILL.md') {
      const packageId = 'package_id' in entry ? entry.package_id ?? id : id;
      const raw = await readFile(this.packagePath(packageId),'utf8').catch(error=>{
        if (error.code!=='ENOENT') throw error;
        throw new AppError('AGENT_SKILL_NOT_FOUND','技能包已变化或移除，请重新打开。');
      });
      const files: Array<{path:string,data:string}> = JSON.parse(raw);
      const file = files.find(file=>file.path===path);
      if (!file) throw new AppError('AGENT_SKILL_NOT_FOUND','技能包缺少此文件。');
      const decoded = skillText(Buffer.from(file.data,'base64'));
      if (decoded===undefined) return {path,binary:true};
      text = decoded;
    }
    let end = Math.min(offset+12000,text.length);
    if (/[\uD800-\uDBFF]/.test(text.charAt(end-1)) && end<text.length) end++;
    return {path,text:text.slice(offset,end),next_offset:end<text.length?end:null,
      ...(path==='SKILL.md' && offset===0 && entry.files ? {files:entry.files} : {})};
  }
  mcpVersion(entry:Server | undefined) { return entry ? digest(JSON.stringify(entry)) : ''; }
  private checkMcpVersion(entry:Server | undefined,expected?:string) {
    if (expected!==undefined && this.mcpVersion(entry)!==expected)
      throw new AppError('AGENT_MCP_CHANGED','MCP 配置已变化，请重新提交。');
  }
  saveMcp(id:string,input:z.infer<typeof mcpInput>,expected?:string) {
    return this.change(async config=>{
      const previous = config.mcp.find(entry=>entry.id===id);
      this.checkMcpVersion(previous,expected);
      if (expected==='' && config.mcp.some(entry=>entry.name===input.name && entry.url===input.url))
        throw new AppError('AGENT_MCP_DUPLICATE','已添加同名、同地址的 MCP 服务。');
      const {token,enabled,...values} = input;
      const credentialId = token ? randomUUID() : previous?.url===values.url ? previous.credential_id : undefined;
      if (token && credentialId) await this.credentials.set(this.account(credentialId),token);
      try {
        config.mcp = [...config.mcp.filter(entry=>entry.id!==id),{
          id,...values,enabled:enabled ?? previous?.enabled ?? false,credential_id:credentialId
        }];
        await this.save(config);
      } catch (error) {
        if (token && credentialId) await this.credentials.remove(this.account(credentialId)).catch(()=>{});
        throw error;
      }
      if (previous?.credential_id && previous.credential_id!==credentialId)
        await this.credentials.remove(this.account(previous.credential_id)).catch(()=>{});
    });
  }
  setMcpEnabled(id:string,enabled:boolean,expected?:string) {
    return this.change(async config=>{
      const entry = config.mcp.find(server=>server.id===id);
      this.checkMcpVersion(entry,expected);
      if (!entry) throw new AppError('AGENT_MCP_UNAVAILABLE','该 MCP 服务已移除。');
      entry.enabled = enabled;
      await this.save(config);
    });
  }
  remove(kind:'skills'|'mcp',id:string,expected?:string) {
    return this.change(async config=>{
      if (kind==='skills' && builtinSkillIds.includes(id)) throw new AppError('AGENT_SKILL_BUILTIN','内置技能随客户端提供。');
      const previous = config.mcp.find(entry=>entry.id===id);
      if (kind==='mcp') this.checkMcpVersion(previous,expected);
      const removedSkill = kind==='skills' ? config.skills.find(entry=>entry.id===id) : undefined;
      if (kind==='skills') config.skills=config.skills.filter(entry=>entry.id!==id);
      else config.mcp=config.mcp.filter(entry=>entry.id!==id);
      await this.save(config);
      if (removedSkill?.files) await unlink(this.packagePath(removedSkill.package_id ?? id)).catch(()=>{});
      if (kind==='mcp' && previous?.credential_id) await this.credentials.remove(this.account(previous.credential_id)).catch(()=>{});
    });
  }
  private async withMcp<T>(entry:Server,signal:AbortSignal,action:(client:Client,token:string)=>Promise<T>) {
    const client = new Client({name:'SapLink',version:'1.0.0'});
    try {
      const token = entry.credential_id ? await this.credentials.get(this.account(entry.credential_id)) : '';
      signal.throwIfAborted();
      const transport = new StreamableHTTPClientTransport(new URL(entry.url),{
        requestInit:{headers:token?{Authorization:'Bearer '+token}:undefined},
        fetch:async (input,init)=>{
          const response = await fetch(input,{...init,redirect:'error'});
          if (!response.body) return response;
          let size = 0;
          const body = response.body.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({
            transform(chunk,controller) {
              size += chunk.byteLength;
              if (size > 1024*1024) controller.error(new Error('MCP response too large'));
              else controller.enqueue(chunk);
            }
          }));
          return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
        }
      });
      await client.connect(transport,{signal,timeout:10000});
      return await action(client,token);
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof AppError) throw error;
      throw new AppError('AGENT_MCP_FAILED','无法连接或调用自定义 MCP 服务。');
    } finally { await client.close().catch(()=>{}); }
  }
  private async availableTools(client:Client,signal:AbortSignal) {
    const result = await client.listTools(undefined,{signal,timeout:10000});
    return result.tools.filter(tool=>tool.annotations?.readOnlyHint===true && !Object.hasOwn(toolSchemas,tool.name));
  }
  private sameServer(entry:Server,expected?:Server) {
    if (expected && (entry.url!==expected.url || entry.credential_id!==expected.credential_id))
      throw new AppError('AGENT_MCP_UNAVAILABLE','MCP 服务配置已变化，请发起新一轮对话后重试。');
  }
  async listMcp(id:string,signal:AbortSignal,testing=false,expected?:Server) {
    const entry = (await this.load()).mcp.find(server=>server.id===id && (testing || server.enabled));
    if (!entry) throw new AppError('AGENT_MCP_UNAVAILABLE','该 MCP 服务未启用或已移除。');
    this.sameServer(entry,expected);
    return this.withMcp(entry,signal,async(client,token)=>(await this.availableTools(client,signal)).slice(0,30)
      .flatMap(tool=>{
        const schema = JSON.stringify(tool.inputSchema);
        if (schema.length > 3000 || withoutToken(schema,token)!==schema || withoutToken(tool.name,token)!==tool.name) return [];
        return [{name:tool.name,description:withoutToken(tool.description ?? '',token).slice(0,500),input_schema:tool.inputSchema}];
      }));
  }
  async callMcp(id:string,name:string,args:Record<string,unknown>,signal:AbortSignal,expected:Server) {
    const entry = (await this.load()).mcp.find(server=>server.id===id && server.enabled);
    if (!entry) throw new AppError('AGENT_MCP_UNAVAILABLE','该 MCP 服务未启用或已移除。');
    this.sameServer(entry,expected);
    return this.withMcp(entry,signal,async(client,token)=>{
      const encoded = JSON.stringify(args);
      if (encoded.length > 16000 || withoutToken(encoded,token)!==encoded)
        throw new AppError('AGENT_MCP_ARGUMENTS','MCP 参数过长或包含凭据。');
      const tools = await this.availableTools(client,signal);
      if (!tools.some(tool=>tool.name===name))
        throw new AppError('AGENT_MCP_TOOL_DENIED','该工具未声明为只读，或属于 SapLink 内置工具。');
      const current = (await this.load()).mcp.find(server=>server.id===id && server.enabled);
      if (!current) throw new AppError('AGENT_MCP_UNAVAILABLE','该 MCP 服务未启用或已移除。');
      this.sameServer(current,expected);
      const result = await client.callTool({name,arguments:args},undefined,{signal,timeout:30000});
      return {status:result.isError?'error':'success',data:withoutToken(JSON.stringify(result),token).slice(0,24000)};
    });
  }
}

function withoutToken(text:string,token:string) {
  return token ? text.replaceAll(token,'[REDACTED]') : text;
}

export const listCustomMcpInput = z.object({server_id:z.uuid()}).strict();
export const callCustomMcpInput = listCustomMcpInput.extend({tool:z.string().min(1).max(128),
  arguments:z.record(z.string(),z.unknown())}).strict();
export const customMcpTools:ModelTool[] = [
  {type:'function',function:{name:'list_custom_mcp_tools',description:'列出指定自定义 MCP 服务的只读工具。',
    parameters:z.toJSONSchema(listCustomMcpInput,{io:'input'})}},
  {type:'function',function:{name:'call_custom_mcp_tool',description:'调用已经列出的自定义 MCP 只读工具。仅发送本次任务所需且用户允许向该服务共享的参数。',
    parameters:z.toJSONSchema(callCustomMcpInput,{io:'input'})}}
];
