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

export type VersionLinkPolicy = string | { transport: 'rfc'; objectUri: string };

// These links come only from this authenticated backend's history metadata/feed.
// HTTP retains same-origin checks. RFC never contacts the advertised HTTP host;
// it accepts only paths within the selected object and sends them over that RFC session.
export function versionResource(value: string, base: string, policy: VersionLinkPolicy, validateUri: (value: string) => string) {
  const rfc = typeof policy !== 'string';
  if (value.length > 8192 || /[\x00-\x20\\]/.test(value))
    throw new AppError('INVALID_URI', 'Unsafe SAP version resource');
  if (rfc) {
    let decoded: string;
    try { decoded = decodeURIComponent(value.split(/[?#]/)[0]); }
    catch { throw new AppError('INVALID_URI', 'Unsafe SAP version resource'); }
    if (value.startsWith('//') || /(?:^|\/)\.{1,2}(?:\/|$)/.test(decoded))
      throw new AppError('INVALID_URI', 'Unsafe SAP version resource');
  }
  const origin = rfc ? 'https://rfc.invalid' : policy;
  let url: URL;
  try { url = new URL(value, new URL(base, origin)); }
  catch { throw new AppError('INVALID_URI', 'Unsafe SAP version resource'); }
  if (!['http:', 'https:'].includes(url.protocol) || (!rfc && url.origin !== origin) || url.username || url.password || url.hash)
    throw new AppError('INVALID_URI', 'Unsafe SAP version resource');
  validateUri(url.pathname);
  if (rfc) {
    const object = validateUri(policy.objectUri);
    if (!url.pathname.startsWith(object + '/')) throw new AppError('INVALID_URI', 'SAP version resource belongs to another object');
  }
  for (const [key, value] of url.searchParams) {
    if (!['version', 'context'].includes(key) || value.length > 2048 || /[\x00-\x1f]/.test(value))
      throw new AppError('INVALID_URI', 'Unsupported parameters in SAP version resource');
  }
  return url.pathname + url.search;
}

export function parseVersions(xml: string, feedUri: string, policy: VersionLinkPolicy, validateUri: (value: string) => string) {
  const feed = qualityXml(xml, 'feed');
  return { entries: xmlArray<any>(feed.entry).map(entry => {
    const content = entry.content?.['@_src'];
    if (typeof content !== 'string' || !content) throw new AppError('INVALID_BACKEND_RESPONSE', 'Version entry has no source resource');
    return { resource: versionResource(content, feedUri, policy, validateUri), title: String(entry.title?.['#text'] ?? entry.title ?? '').slice(0, 2000),
      date: String(entry.updated ?? '').slice(0, 128), author: String(entry.author?.name ?? '').slice(0, 256) };
  }), has_next: xmlArray<any>(feed.link).some(link => link['@_rel'] === 'next') };
}
