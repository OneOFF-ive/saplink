import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { AppError } from './errors.js';

export const xmlArray = <T>(value: T | T[] | undefined): T[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
export function qualityXml(xml: string, root: string): any {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true)
    throw new AppError('INVALID_BACKEND_RESPONSE', 'Expected valid SAP XML without document entities');
  const parsed = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true,
    parseTagValue: false, parseAttributeValue: false, trimValues: false }).parse(xml);
  if (parsed[root] === '') return {};
  if (!parsed[root] || typeof parsed[root] !== 'object') throw new AppError('INVALID_BACKEND_RESPONSE', `Expected SAP ${root} XML`);
  return parsed[root];
}

// Only follow same-origin ADT resources discovered for this object's history.
// Query parameters are not accepted from MCP callers and cannot override Client.
export function versionResource(value: string, base: string, origin: string, validateUri: (value: string) => string) {
  const url = new URL(value, new URL(base, origin));
  if (value.length > 8192 || url.origin !== origin || url.username || url.password || url.hash || /[\x00-\x20\\]/.test(value))
    throw new AppError('INVALID_URI', 'Unsafe SAP version resource');
  validateUri(url.pathname);
  for (const [key, value] of url.searchParams) {
    if (!['version', 'context'].includes(key) || value.length > 2048 || /[\x00-\x1f]/.test(value))
      throw new AppError('INVALID_URI', 'Unsupported parameters in SAP version resource');
  }
  return url.pathname + url.search;
}

export function parseVersions(xml: string, feedUri: string, origin: string, validateUri: (value: string) => string) {
  const feed = qualityXml(xml, 'feed');
  return { entries: xmlArray<any>(feed.entry).map(entry => {
    const content = entry.content?.['@_src'];
    if (typeof content !== 'string' || !content) throw new AppError('INVALID_BACKEND_RESPONSE', 'Version entry has no source resource');
    return { resource: versionResource(content, feedUri, origin, validateUri), title: String(entry.title?.['#text'] ?? entry.title ?? '').slice(0, 2000),
      date: String(entry.updated ?? '').slice(0, 128), author: String(entry.author?.name ?? '').slice(0, 256) };
  }), has_next: xmlArray<any>(feed.link).some(link => link['@_rel'] === 'next') };
}
