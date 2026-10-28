import { open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { connectionSchema } from './config.js';

const MAX_BYTES = 5 * 1024 * 1024;
const array = (value: any): any[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
const text = (value: unknown, max = 253) => typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/.test(value) ? value : '';
export type SapLogonEntry = {
  id: string; label: string; system_id: string; available: boolean; reason?: string;
  rfc?: { ashost: string; sysnr: string; saprouter?: string }; client?: string; language?: string;
};

export function parseSapLogon(documents: string[]): SapLogonEntry[] {
  const landscapes = documents.map(xml => {
    if (Buffer.byteLength(xml) > MAX_BYTES || /<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true)
      throw new Error('INVALID_LANDSCAPE');
    const parsed = new XMLParser({ ignoreAttributes: false, parseAttributeValue: false, parseTagValue: false }).parse(xml);
    if (!parsed.Landscape) throw new Error('INVALID_LANDSCAPE');
    return parsed.Landscape;
  });
  const routers = new Map<string, string>();
  for (const landscape of landscapes) for (const router of array(landscape.Routers?.Router)) {
    const id = text(router['@_uuid']);
    if (id) routers.set(id, text(router['@_router'], 2048));
  }
  const entries: SapLogonEntry[] = [];
  const seen = new Set<string>();
  // Later documents (the user's file) override global service definitions.
  for (const landscape of [...landscapes].reverse()) for (const service of array(landscape.Services?.Service)) {
    if (service['@_type'] !== 'SAPGUI') continue;
    if (entries.length >= 2000) throw new Error('TOO_MANY_SERVICES');
    const uuid = text(service['@_uuid']);
    if (uuid && seen.has(uuid)) continue;
    if (uuid) seen.add(uuid);
    const entry: SapLogonEntry = { id: String(entries.length), label: text(service['@_name']) || '未命名连接',
      system_id: text(service['@_systemid'], 16), available: false };
    const server = text(service['@_server']);
    const match = /^([A-Za-z0-9][A-Za-z0-9.-]*):32(\d{2})$/.exec(server);
    const routerId = text(service['@_routerid']);
    const route = routerId ? routers.get(routerId) : undefined;
    if (service['@_msid'] || (service['@_mode'] && service['@_mode'] !== '1')) entry.reason = '暂不支持消息服务器或负载均衡连接';
    else if (!['', '0', '-1'].includes(text(service['@_sncop'], 8))) entry.reason = '暂不支持 SNC 连接';
    else if (!match) entry.reason = '暂不支持此服务器地址或自定义端口';
    else if (routerId && !route) entry.reason = '未找到对应的 SAProuter 配置';
    else {
      const parsed = connectionSchema.shape.rfc.safeParse({ ashost: match[1], sysnr: match[2], ...(route ? { saprouter: route } : {}) });
      if (!parsed.success || !parsed.data) entry.reason = '服务器或 SAProuter 格式暂不支持';
      else { entry.available = true; entry.rfc = parsed.data; }
    }
    // Never extract username, password, Memo or arbitrary service attributes.
    const client = text(service['@_client'], 3), language = text(service['@_language'], 2).toUpperCase();
    if (/^\d{3}$/.test(client)) entry.client = client;
    if (/^[A-Z]{2}$/.test(language)) entry.language = language;
    entries.push(entry);
  }
  return entries;
}

export async function readSapLogon(env = process.env) {
  const directory = env.APPDATA ? join(env.APPDATA, 'SAP', 'Common') : undefined;
  const override = env.SAPLOGON_LSXML_FILE;
  const paths = [...new Set([
    ...(directory ? [join(directory, 'SAPUILandscapeGlobal.xml'), join(directory, 'SAPUILandscape.xml')] : []),
    ...(override && isAbsolute(override) && !/^[/\\]{2}/.test(override) ? [override] : [])
  ])];
  const documents: string[] = [], warnings: string[] = [];
  for (const path of paths) {
    let handle;
    try {
      handle = await open(path, 'r');
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('INVALID_LANDSCAPE');
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > MAX_BYTES) throw new Error('INVALID_LANDSCAPE');
      const bytes = buffer.subarray(0, length);
      const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf16le' : 'utf8';
      const xml = bytes.toString(encoding).replace(/^\uFEFF/, '');
      parseSapLogon([xml]);
      documents.push(xml);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push('部分本地 SAP Logon 配置无法读取或格式不受支持。');
    } finally { await handle?.close(); }
  }
  // Do not follow Includes: they may reference remote servers or unrelated files.
  if (documents.some(xml => /<Include\s/.test(xml))) warnings.push('仅导入本地配置中的连接；外部引用文件中的连接暂不支持。');
  return { connections: parseSapLogon(documents), warnings: [...new Set(warnings)] };
}
