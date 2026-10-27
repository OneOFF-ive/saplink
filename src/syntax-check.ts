import type { AdtHTTP } from 'abap-adt-api/build/AdtHTTP.js';
import { XMLBuilder, XMLParser, XMLValidator } from 'fast-xml-parser';
import { AppError } from './errors.js';

export async function checkSavedVersion(http: AdtHTTP, sourceUri: string, version: 'active' | 'inactive') {
  const body = '<?xml version="1.0" encoding="UTF-8"?>' + new XMLBuilder({ ignoreAttributes: false }).build({
    'chkrun:checkObjectList': {
      '@_xmlns:chkrun': 'http://www.sap.com/adt/checkrun', '@_xmlns:adtcore': 'http://www.sap.com/adt/core',
      'chkrun:checkObject': { '@_adtcore:uri': sourceUri, '@_chkrun:version': version }
    }
  });
  const response = await http.request('/sap/bc/adt/checkruns', {
    method: 'POST', qs: { reporters: 'abapCheckRun' }, body,
    headers: { 'Content-Type': 'application/vnd.sap.adt.checkobjects+xml; charset=utf-8',
      Accept: 'application/vnd.sap.adt.checkmessages+xml' }
  });
  return syntaxDiagnostics(response.body);
}

export function syntaxDiagnostics(xml: string) {
  if (XMLValidator.validate(xml) !== true) throw new AppError('INVALID_BACKEND_RESPONSE', 'SAP returned invalid syntax check XML');
  const parsed = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseAttributeValue: false }).parse(xml);
  if (!Object.hasOwn(parsed, 'checkRunReports'))
    throw new AppError('INVALID_BACKEND_RESPONSE', 'SAP returned no syntax check reports');
  const array = (value: any): any[] => value == null || value === '' ? [] : Array.isArray(value) ? value : [value];
  return array(parsed.checkRunReports?.checkReport).flatMap(report =>
    array(report.checkMessageList?.checkMessage).map(message => {
      if (typeof message?.['@_type'] !== 'string' || typeof message?.['@_shortText'] !== 'string')
        throw new AppError('INVALID_BACKEND_RESPONSE', 'SAP returned incomplete syntax diagnostics');
      const uri = String(message['@_uri'] ?? '');
      const position = uri.match(/^([^#]+)#start=(\d+),(\d+)/);
      return { uri: position?.[1] ?? uri, line: position ? Number(position[2]) : 0,
        offset: position ? Number(position[3]) : 0, severity: message['@_type'], text: message['@_shortText'] };
    }));
}
