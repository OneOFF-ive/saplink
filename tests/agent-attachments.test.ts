import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir,mkdtemp,rm } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { OfficeParser } from 'officeparser';
import { strToU8,zipSync } from 'fflate';
import { ArtifactStore } from '../src/agent/artifacts.js';
import { prepareUploads } from '../src/agent/attachments/uploads.js';
import { deepSeekImageReader } from '../src/agent/attachments/attachment-reader.js';
import { maxInlineImageBytes } from '../src/agent/output-limits.js';

function pdf() {
  const content = 'BT /F1 12 Tf 30 100 Td (SAP PDF sample) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`
  ];
  let source = '%PDF-1.4\n';
  const offsets = objects.map((body,index)=>{
    const offset = source.length;
    source += `${index+1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  return Buffer.from(source + 'xref\n0 6\n0000000000 65535 f \n' +
    offsets.map(offset=>String(offset).padStart(10,'0')+' 00000 n \n').join('') +
    `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${source.length}\n%%EOF\n`);
}

test('PDF and Office attachments produce readable text artifacts while image bytes stay out of chat history', async () => {
  const root = resolve('.saplink/tests');
  await mkdir(root,{recursive:true});
  const directory = await mkdtemp(join(root,'attachment-'));
  try {
    const store = new ArtifactStore(directory), taskId = randomUUID();
    const word = await OfficeParser.parseOffice(Buffer.from('SAP Word sample.'),{fileType:'md'});
    const {value:docx} = await word.to('docx');
    const sheet = zipSync({
      'xl/workbook.xml':strToU8('<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>'),
      'xl/_rels/workbook.xml.rels':strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'),
      'xl/worksheets/sheet1.xml':strToU8('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>SAP Excel sample</t></is></c></row></sheetData></worksheet>')
    });
    const slides = zipSync({
      'ppt/presentation.xml':strToU8('<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>'),
      'ppt/_rels/presentation.xml.rels':strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>'),
      'ppt/slides/slide1.xml':strToU8('<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>SAP PowerPoint sample</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>')
    });
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOqsAAAAASUVORK5CYII=','base64');
    const files = [['source.pdf',pdf()],['word.docx',docx],['sheet.xlsx',sheet],['slides.pptx',slides],['image.png',png]] as const;
    const {saved,context} = await prepareUploads(store,taskId,files.map(([name,bytes])=>({
      name,encoding:'base64',content:Buffer.from(bytes).toString('base64')
    })),text=>text);
    assert.deepEqual(saved.map(file=>file.name),files.map(([name])=>name));
    for (const expected of ['PDF','Word','Excel','PowerPoint']) assert.match(context,new RegExp('SAP '+expected+' sample'));
    assert.doesNotMatch(context,/iVBORw0KGgo/);
    const image = await store.read(taskId,{artifact_id:saved[4].artifact_id},async data=>{
      assert.equal(data,'data:image/png;base64,'+png.toString('base64'));
      return '图片识别结果';
    });
    assert.equal(image.text,'图片识别结果');
    assert.equal(image.format,'image_analysis');
    await assert.rejects(prepareUploads(store,taskId,[{name:'fake.pdf',encoding:'base64',content:'eA=='}],text=>text),
      {code:'AGENT_UPLOAD_INVALID'});
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test('an image at the inline byte limit fits local storage and the DeepSeek JSON request', async () => {
  const root = resolve('.saplink/tests');
  await mkdir(root,{recursive:true});
  const directory = await mkdtemp(join(root,'large-image-'));
  try {
    const bytes = Buffer.alloc(maxInlineImageBytes);
    Buffer.from('89504e470d0a1a0a','hex').copy(bytes);
    const store = new ArtifactStore(directory),taskId = randomUUID();
    const {saved} = await prepareUploads(store,taskId,[{
      name:'image.png',encoding:'base64',content:bytes.toString('base64')
    }],text=>text);
    const artifact = await store.get(taskId,saved[0].artifact_id);
    const reader = deepSeekImageReader('test',async (_url,request)=>{
      assert.ok(Buffer.byteLength(request!.body as string) < 48*1024*1024);
      const frame = (delta:object,finish_reason:string|null) =>
        'data: '+JSON.stringify({choices:[{index:0,delta,finish_reason}]})+'\n\n';
      return new Response(frame({content:'识别结果'},null)+frame({},'stop')+'data: [DONE]\n\n',
        {headers:{'Content-Type':'text/event-stream'}});
    });
    assert.equal((await reader(artifact.content,'测试图片',new AbortController().signal)).message.content,'识别结果');
  } finally { await rm(directory,{recursive:true,force:true}); }
});
