import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
const [statePath, eventPath, mode = 'normal'] = process.argv.slice(2);
const decode = value => Buffer.from(value, 'base64').toString('utf8');
const encode = value => Buffer.from(value).toString('base64');
const object = '/sap/bc/adt/programs/programs/ztest';
let role;
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (line === 'CLOSE') { console.log('CLOSED'); break; }
  const fields = line.split('\t');
  if (fields[0] === 'INIT') {
    if (fields.length !== 10) process.exit(8);
    role = decode(fields[7]);
    writeFileSync(`${statePath}.init-${role}.json`, JSON.stringify({ router: decode(fields[9]), role }));
    console.log('READY\t1'); continue;
  }
  const [id, method64, uri64, headers64, body64] = fields;
  const method = decode(method64), uri = new URL(decode(uri64), 'http://fake.invalid');
  const headers = decode(headers64), body = decode(body64);
  appendFileSync(eventPath, JSON.stringify({ role, method, path: uri.pathname,
    credential_headers: /authorization|cookie|x-csrf-token/i.test(headers) }) + '\n');
  if (mode === 'hang') continue;
  if (mode === 'slow') await new Promise(resolve => setTimeout(resolve, 300));
  if (mode === 'crash') process.exit(9);
  if (mode === 'auth') { console.log(`${id}\tERROR\t103`); continue; }
  if (mode === 'malformed') { console.log(`${id}\tOK\t200\t%%%\t%%%`); continue; }
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  let response = '', status = 200, contentType = 'application/xml';
  if (uri.pathname.endsWith('/compatibility/graph')) response = '<graph/>';
  else if (uri.pathname.endsWith('/discovery')) response = '<app:service xmlns:app="http://www.w3.org/2007/app" xmlns:atom="http://www.w3.org/2005/Atom"><app:workspace><atom:title>RFC</atom:title><app:collection href="/sap/bc/adt/programs/programs"><atom:title>Programs</atom:title></app:collection></app:workspace></app:service>';
  else if (uri.pathname === object && method === 'POST') {
    if (uri.searchParams.get('_action') === 'LOCK') {
      response = '<asx:abap xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA><LOCK_HANDLE>private-lock</LOCK_HANDLE></DATA></asx:values></asx:abap>';
    }
  } else if (uri.pathname === object) {
    const version = uri.searchParams.get('version') ?? 'active';
    const history = state.historyOrigin ? `<atom:link rel="http://www.sap.com/adt/relations/versions" href="${state.historyOrigin}${object}/source/main/versions"/>` : '';
    response = `<program:abapProgram xmlns:program="http://www.sap.com/adt/programs/programs" xmlns:adtcore="http://www.sap.com/adt/core" xmlns:abapsource="http://www.sap.com/adt/abapsource" xmlns:atom="http://www.w3.org/2005/Atom" adtcore:name="ZTEST" adtcore:type="PROG/P" adtcore:version="${version}" abapsource:sourceUri="source/main"><atom:link href="source/main" type="text/plain"/>${history}</program:abapProgram>`;
  } else if (uri.pathname === `${object}/source/main` && method === 'PUT') {
    state.inactive = body; writeFileSync(statePath, JSON.stringify(state)); status = 204;
    if (mode === 'save-crash') process.exit(9);
  } else if (uri.pathname === `${object}/source/main/versions`) {
    const link = state.historyLink ?? `http://history-alias.invalid:8123${object}/source/main/versions/00001/content`;
    response = `<feed><entry><title>Earlier source</title><content src="${link}"/></entry></feed>`;
  } else if (uri.pathname === `${object}/source/main/versions/00001/content`) {
    response = 'REPORT ztest.\n* earlier source'; contentType = 'text/plain';
  } else if (uri.pathname === `${object}/source/main`) response = state[uri.searchParams.get('version') ?? 'active'];
  else if (uri.pathname.endsWith('/checkruns')) response = '<chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun"/>';
  else if (uri.pathname.endsWith('/datapreview/ddic')) response = '<tableData><columns><metadata name="MATNR" type="C"/><dataSet><data>000001</data></dataSet></columns></tableData>';
  else if (uri.pathname.endsWith('/nodepath')) response = '<projectexplorer:nodepath xmlns:projectexplorer="test" xmlns:adtcore="http://www.sap.com/adt/core"><projectexplorer:objectLinkReferences><objectLinkReference adtcore:name="$TMP" adtcore:type="DEVC/K" adtcore:uri="/sap/bc/adt/packages/%24tmp"/></projectexplorer:objectLinkReferences></projectexplorer:nodepath>';
  else { status = 404; response = '<error/>'; }
  console.log(`${id}\tOK\t${status}\t${encode(`content-type:${contentType}\n`)}\t${encode(response)}`);
}
