import { XMLBuilder, XMLParser, XMLValidator } from 'fast-xml-parser';
import type { ActivationResult } from 'abap-adt-api/build/api/activate.js';
import { AppError } from './errors.js';

export type ActivationReference = { uri: string; name: string; type: string; parentUri?: string };

export function activationBody(objects: ActivationReference[]): string {
  return new XMLBuilder({ ignoreAttributes: false }).build({ 'adtcore:objectReferences': {
    '@_xmlns:adtcore': 'http://www.sap.com/adt/core',
    // Minimal references also work on systems that reject type/parent attributes in the initial request.
    'adtcore:objectReference': objects.map(object => ({ '@_adtcore:uri': object.uri, '@_adtcore:name': object.name }))
  } });
}

export function scopedActivationBody(result: ActivationResult, approved: ActivationReference[], username: string, targets = approved): string {
  const allowed = new Map(approved.map(object => [object.uri, object]));
  const refs = new Map<string, Record<string, string>>();
  if (result.inactive.length > approved.length + 20) throw new AppError('ACTIVATION_SCOPE_INVALID', 'Too many preaudit entries');
  const unapproved: { object_uri?: string; name?: string; type?: string; user?: string }[] = [];
  for (const entry of result.inactive) {
    if (!entry.object) {
      if (entry.transport) continue;
      throw new AppError('ACTIVATION_SCOPE_INVALID', 'Preaudit entry has no object or transport');
    }
    const object = entry.object, expected = allowed.get(object['adtcore:uri']);
    if (!expected || object.deleted || (object.user && object.user.toUpperCase() !== username.toUpperCase()) ||
      object['adtcore:type'] !== expected.type || object['adtcore:name']?.toUpperCase() !== expected.name.toUpperCase() ||
      (object['adtcore:parentUri'] && object['adtcore:parentUri'] !== expected.parentUri)) {
      unapproved.push({ object_uri: object['adtcore:uri'], name: object['adtcore:name'], type: object['adtcore:type'], user: object.user });
      continue;
    }
    const ref: Record<string, string> = {};
    for (const key of ['uri', 'name', 'type', 'parentUri']) {
      const value = object[`adtcore:${key}` as keyof typeof object];
      if (typeof value === 'string' && value) ref[`@_adtcore:${key}`] = value;
    }
    refs.set(expected.uri, ref);
  }
  if (unapproved.length) throw new AppError('ACTIVATION_SCOPE_INVALID',
    'Preaudit returned unapproved objects; review the activation scope before retrying. No second-phase activation was sent.', { unapproved_objects: unapproved });
  if (!refs.size) throw new AppError('ACTIVATION_SCOPE_INVALID', 'Preaudit returned no approved activation objects');
  // Keep the complete requested set in phase two, including mutually dependent objects omitted by preaudit.
  for (const object of targets) {
    if (!object.uri.endsWith('/source/main') && !refs.has(object.uri))
      refs.set(object.uri, { '@_adtcore:uri': object.uri, '@_adtcore:name': object.name });
  }
  return new XMLBuilder({ ignoreAttributes: false }).build({ 'adtcore:objectReferences': {
    '@_xmlns:adtcore': 'http://www.sap.com/adt/core', 'adtcore:objectReference': [...refs.values()]
  } });
}

export function activationResponse(body: string): ActivationResult {
  if (!body.trim()) return { success: true, messages: [], inactive: [] };
  if (XMLValidator.validate(body) !== true) throw new AppError('ACTIVATION_RESPONSE_INVALID', 'Invalid activation XML');
  const data = new XMLParser({ ignoreAttributes: false }).parse(body);
  const array = (value: any): any[] => value == null ? [] : Array.isArray(value) ? value : [value];
  if (!('ioc:inactiveObjects' in data) && !('chkl:messages' in data)) {
    throw new AppError('ACTIVATION_RESPONSE_INVALID', 'Unrecognized activation response');
  }
  const messages: Record<string, any>[] = array(data['chkl:messages']?.msg).map(message => ({
    ...Object.fromEntries(Object.entries(message).filter(([key]) => key.startsWith('@_')).map(([key, value]) => [key.slice(2), value])),
    shortText: message.shortText?.txt || 'Activation message'
  }));
  const element = (value: any) => value?.['ioc:ref'] && {
    ...Object.fromEntries(Object.entries(value['ioc:ref']).filter(([key]) => key.startsWith('@_')).map(([key, attribute]) => [key.slice(2), String(attribute)])),
    deleted: !['', 'false', '0'].includes(String(value['@_ioc:deleted'] ?? '').toLowerCase()),
    user: String(value['@_ioc:user'] ?? '')
  };
  const inactive = array(data['ioc:inactiveObjects']?.['ioc:entry']).map(entry => ({
    object: element(entry['ioc:object']), transport: element(entry['ioc:transport'])
  })) as ActivationResult['inactive'];
  return { success: !inactive.length && !messages.some(message => /[EAX]/.test(String(message.type))),
    messages: messages as ActivationResult['messages'], inactive };
}
