import { parentPort,workerData } from 'node:worker_threads';
import { OfficeParser } from 'officeparser';

try {
  const {bytes,format} = workerData;
  let truncated = false;
  const document = await OfficeParser.parseOffice(bytes,{
    fileType:format,extractAttachments:false,ocr:false,
    decompressionLimits:{maxUncompressedBytes:32*1024*1024,maxZipEntries:2000,maxTableCells:100000},
    onWarning: issue => { if (issue.code === 'TABLE_CELL_LIMIT_EXCEEDED') truncated = true; }
  });
  const {value} = await document.to('text');
  const text = String(value).trim();
  parentPort!.postMessage({text:text.slice(0,2000000),truncated:truncated || text.length>2000000});
} catch {
  parentPort!.postMessage(null);
}
