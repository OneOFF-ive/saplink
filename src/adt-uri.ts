import { AppError } from './errors.js';

export function adtUri(uri: string): string {
  if (!uri.startsWith('/sap/bc/adt/') || /[?#\\\s]/.test(uri)) throw new AppError('INVALID_URI', 'Use an ADT relative object URI');
  let decoded: string;
  try { decoded = decodeURIComponent(uri); } catch { throw new AppError('INVALID_URI', 'Invalid URI encoding'); }
  if (decoded.includes('%') || decoded.includes('\\') || /[?#\x00-\x20]/.test(decoded) || decoded.split('/').some(s => s === '.' || s === '..')) {
    throw new AppError('INVALID_URI', 'Unsafe ADT URI');
  }
  return uri;
}

export function programUri(uri: string): string {
  adtUri(uri);
  if (!/^\/sap\/bc\/adt\/(?:programs\/(?:programs|includes)\/[a-zA-Z0-9_%]+|functions\/groups\/[a-zA-Z0-9_%]+(?:\/(?:fmodules|includes)\/[a-zA-Z0-9_%]+)?)(?:\/source\/main)?$/.test(uri)) {
    throw new AppError('CAPABILITY_UNSUPPORTED', 'Unsupported ABAP source object URI');
  }
  return uri.replace(/\/source\/main$/, '');
}

export function functionGroupUri(uri: string): string {
  const object = programUri(uri);
  const match = object.match(/^(\/sap\/bc\/adt\/functions\/groups\/[a-zA-Z0-9_%]+)(?:\/(?:fmodules|includes)\/[^/]+)?$/);
  if (!match) throw new AppError('INVALID_URI', 'Use a function group or member URI');
  return match[1];
}

const ddicSourcePath = /^\/sap\/bc\/adt\/ddic\/(?:structures|tables)\/([a-z0-9_]+)(?:\/source\/main)?$/i;
export function ddicUriName(uri: string) {
  return ddicSourcePath.exec(uri)?.[1].toUpperCase();
}

export function sourceObjectUri(uri: string) {
  return ddicUriName(uri) ? adtUri(uri).replace(/\/source\/main$/i,'') : programUri(uri);
}
