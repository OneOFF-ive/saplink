import { z } from 'zod';
import type { ModelTool } from './model.js';

export const webSearchInput = z.object({
  query: z.string().trim().min(1).refine(query => [...query].length <= 128)
}).strict();

export const webSearchTool: ModelTool = {
  type:'function', function:{
    name:'web_search', description:'搜索公开网页。仅发送简短公开关键词，不能包含 SAP 内部信息、源码、表数据或凭据。使用结果 URL 引用来源。',
    parameters:{type:'object',properties:{query:{type:'string',minLength:1,maxLength:128}},
      required:['query'],additionalProperties:false}
  }
};

const resultSchema = z.object({
  title:z.string(),url:z.string(),summary:z.string().nullish(),snippet:z.string().nullish()
});
export type WebSource = {title:string;url:string};

const searchError = (code:string,message:string) => ({status:'error' as const,error:{code,message}});

export function deepSeekSearch(apiKey:string, request:typeof fetch = fetch) {
  return async (query:string, signal:AbortSignal) => {
    if (!apiKey) return searchError('WEB_SEARCH_UNAVAILABLE','联网搜索需要 DeepSeek API Key。');
    signal.throwIfAborted();
    const timeout = AbortSignal.timeout(15000);
    try {
      const response = await request('https://api.deepseek.com/v1/tools/search', {
        method:'POST',redirect:'error',signal:AbortSignal.any([signal,timeout]),
        headers:{'Authorization':`Bearer ${apiKey}`,'Content-Type':'application/json'},
        body:JSON.stringify({query,count:5,need_content:false})
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 402) return searchError('WEB_SEARCH_BALANCE','DeepSeek 搜索账户余额不足。');
        if (response.status === 429) return searchError('WEB_SEARCH_RATE_LIMIT','搜索请求过多，请稍后再试。');
        return searchError('WEB_SEARCH_UNAVAILABLE','DeepSeek 搜索暂不可用，请检查服务和 API Key。');
      }
      const chunks:Buffer[] = [];
      let size = 0;
      if (response.body) for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > 256 * 1024) return searchError('WEB_SEARCH_RESPONSE','搜索返回内容过大。');
        chunks.push(Buffer.from(chunk));
      }
      const {results} = z.object({results:z.array(z.unknown())}).parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const sources = new Map<string,WebSource & {summary:string}>();
      for (const item of results) {
        const parsed = resultSchema.safeParse(item);
        if (!parsed.success) continue;
        const result = parsed.data;
        const url = URL.parse(result.url);
        if (!url || !['http:','https:'].includes(url.protocol) || url.username || url.password ||
            url.href.length > 2048 || sources.has(url.href)) continue;
        sources.set(url.href,{url:url.href,title:result.title.replace(/\s+/g,' ').trim().slice(0,160) || url.hostname,
          summary:(result.summary || result.snippet || '').slice(0,1000)});
        if (sources.size === 5) break;
      }
      return {status:'success' as const,data:{results:[...sources.values()]}};
    } catch {
      signal.throwIfAborted();
      return timeout.aborted ? searchError('WEB_SEARCH_TIMEOUT','联网搜索超时，请稍后再试。')
        : searchError('WEB_SEARCH_UNAVAILABLE','无法获取联网搜索结果。');
    }
  };
}

export function webSourceLinks(sources:WebSource[]) {
  if (!sources.length) return '';
  return '\n\n### 网页来源\n\n' + sources.map(({title,url}) =>
    '- [' + title.replace(/[\\\[\]]/g,'\\$&') + '](<' + url + '>)').join('\n');
}
