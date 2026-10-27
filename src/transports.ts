import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { AppError } from './errors.js';
import type { TransportsOfUser, TransportRequest } from 'abap-adt-api/build/api/transports.js';

type Node = Record<string, any>;
const array = (value: any): Node[] => value == null ? [] : Array.isArray(value) ? value : [value];
// Report schema shape only: never include attribute values or backend text.
function elementPaths(node: unknown, prefix = '', depth = 0): string[] {
  if (!node || typeof node !== 'object' || depth > 5) return [];
  if (Array.isArray(node)) return elementPaths(node[0], prefix, depth);
  return Object.entries(node).filter(([key]) => /^[A-Za-z_][A-Za-z0-9_.-]{0,79}$/.test(key)).slice(0, 20)
    .flatMap(([key, value]) => {
      const path = prefix ? `${prefix}/${key}` : key;
      return [path, ...elementPaths(value, path, depth + 1)];
    }).slice(0, 60);
}
function root(xml: string): Node {
  if (XMLValidator.validate(xml) !== true) throw new AppError('TRANSPORT_RESPONSE_INVALID', 'SAP returned invalid transport XML');
  const parsed = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseAttributeValue: false }).parse(xml);
  if (!parsed.root || typeof parsed.root !== 'object') throw new AppError('TRANSPORT_RESPONSE_INVALID', 'SAP returned no transport root');
  return parsed.root;
}
function attributes(node: Node): Node {
  return Object.fromEntries(Object.entries(node).filter(([key]) => key.startsWith('@_') && !key.startsWith('@_xmlns'))
    .map(([key, value]) => [`tm:${key.slice(2)}`, value]));
}
function task(node: Node): any {
  return { ...attributes(node), links: array(node.link).map(link => Object.fromEntries(Object.entries(link)
    .filter(([key]) => key.startsWith('@_')).map(([key, value]) => [key.slice(2), value]))),
    objects: array(node.abap_object).map(attributes) };
}
function request(node: Node): TransportRequest {
  return { ...task(node), tasks: array(node.task).map(task) };
}
export function parseTransportList(xml: string): TransportsOfUser {
  const data = root(xml);
  if (!('workbench' in data) && !('customizing' in data)) {
    throw new AppError('TRANSPORT_RESPONSE_INVALID', 'SAP returned no transport categories; refusing to report an empty list',
      { response_element_paths: elementPaths(data) });
  }
  const targets = (category: any) => array(category).flatMap(group => {
    if (!group || typeof group !== 'object') return [];
    // Some SAP versions omit target grouping even when targets=true is requested.
    const groups = [...array(group.target), ...('modifiable' in group || 'released' in group ? [group] : [])];
    return groups.map(target => ({ 'tm:name': '', 'tm:desc': '', ...attributes(target),
      modifiable: array(target.modifiable?.request).map(request),
      released: array(target.released?.request).map(request) }));
  });
  return { workbench: targets(data.workbench), customizing: targets(data.customizing) };
}
export function parseTransportDetails(xml: string): TransportRequest | undefined {
  return array(root(xml).request).map(request)[0];
}


// Detail responses can put the selected task beside its parent request, rather than inside it.
// Ignore object inventories and action links: validation needs headers only.
export function parseTransportSummary(xml: string): (TransportRequest & { 'tm:type': string }) | undefined {
  if (XMLValidator.validate(xml) !== true) throw new AppError('TRANSPORT_RESPONSE_INVALID', 'SAP returned invalid transport XML');
  const parsed = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseAttributeValue: false,
    updateTag: tag => !['abap_object', 'link'].includes(tag) }).parse(xml);
  const data = parsed.root;
  if (!data || typeof data !== 'object') throw new AppError('TRANSPORT_RESPONSE_INVALID', 'SAP returned no transport root');
  const parents = array(data.request);
  if (parents.length === 0) return undefined;
  if (parents.length !== 1) throw new AppError('TRANSPORT_RESPONSE_INVALID', 'SAP returned ambiguous parent requests');
  const parent = request(parents[0]);
  const siblings = array(data.task).map(task);
  if (siblings.some(t => t['tm:parent'] !== parent['tm:number']))
    throw new AppError('TRANSPORT_RESPONSE_INVALID', 'SAP task parent does not match the returned request');
  parent.tasks = [...parent.tasks, ...siblings];
  if (parent.tasks.some(t => (t as any)['tm:parent'] && (t as any)['tm:parent'] !== parent['tm:number']))
    throw new AppError('TRANSPORT_RESPONSE_INVALID', 'SAP task parent does not match the returned request');
  const numbers = parent.tasks.map(t => t['tm:number']);
  if (new Set(numbers).size !== numbers.length)
    throw new AppError('TRANSPORT_RESPONSE_INVALID', 'SAP returned duplicate transport tasks');
  return parent as TransportRequest & { 'tm:type': string };
}
