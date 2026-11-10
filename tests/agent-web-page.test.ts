import test from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { authorizedWebUrl,readPublicPage,requestedWebUrls } from '../src/agent/web-page.js';

function page(statusCode:number,headers:IncomingMessage['headers'],text='') {
  return Object.assign(Readable.from([Buffer.from(text)]),{statusCode,headers}) as unknown as IncomingMessage;
}

test('web page reads only supplied URLs and extracts visible HTML without executing scripts',async()=>{
  const urls = requestedWebUrls('读一下 https://example.com/doc#section，再检查 SKILL.md');
  assert.deepEqual(urls,['https://example.com/doc']);
  assert.equal(authorizedWebUrl('https://example.com/doc?extra=1',urls),undefined);
  const result = await readPublicPage(urls[0],AbortSignal.timeout(1000),[],
    async()=>[{address:'8.8.8.8',family:4}],
    async (url,address)=>{
      assert.equal(url.href,urls[0]); assert.equal(address,'8.8.8.8');
      return page(200,{'content-type':'text/html; charset=utf-8'},
        '<html><head><title>测试 &amp; 文档</title></head><body><nav>菜单</nav><main><h1>采购文档</h1><p>含正文 &amp; 数据</p><script>不应读取</script></main></body></html>');
    });
  assert.equal(result.status,'success');
  if (result.status==='success') {
    assert.equal(result.data.title,'测试 & 文档');
    assert.match(result.data.text,/采购文档[\s\S]*含正文 & 数据/);
    assert.doesNotMatch(result.data.text,/不应读取|菜单/);
  }
});

test('web reader checks each redirect and refuses mixed or private DNS answers',async()=>{
  const urls:string[] = [];
  const result = await readPublicPage('https://example.com/',AbortSignal.timeout(1000),[],
    async host=>host==='example.com'?[{address:'8.8.8.8',family:4}]:
      [{address:'8.8.4.4',family:4},{address:'::ffff:127.0.0.1',family:6}],
    async url=>{urls.push(url.href);return page(302,{location:'http://private.example.com/doc'});});
  assert.deepEqual(urls,['https://example.com/']);
  assert.equal(result.status==='error' && result.error.code,'WEB_PAGE_PRIVATE');
});
