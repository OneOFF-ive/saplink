import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultConfigDirectory } from './paths.js';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError } from './errors.js';

export const connectionFieldHints: Record<string, string> = {
  name: '连接名称仅允许英文字母、数字、下划线（_）和连字符（-），不允许中文、空格、点号或斜杠。例如 sap_system_01。',
  base_url: 'ADT 地址必须是 http:// 或 https:// 开头的服务器地址，例如 https://sap-host:443；路径只能为空、/ 或 /sap/bc/adt，不允许内嵌用户名密码、查询参数或 # 片段。',
  client: 'Client 必须是 3 位半角数字，例如 001 或 100；请保留前导零。',
  username: 'SAP 用户名不能为空，请填写 SAP 登录用户名。',
  language: '语言必须是 2 位大写英文字母，例如 EN、ZH 或 DE。',
  password: 'SAP 密码必须为文本，最多 512 个字符。',
  write_enabled: '允许程序写入必须为开启或关闭。',
  rfc: 'RFC 连接需要应用服务器主机名或 IP，以及恰好两位数字的系统号（例如 00）。',
  rfc_ashost: '请填写 RFC 应用服务器的主机名或 IPv4 地址，不要填写路由串。',
  rfc_sysnr: 'RFC 系统号必须恰好为两位数字，例如 00。',
  rfc_saprouter: 'SAProuter 格式为 /H/router-host/S/3299，可串联多个 /H/ 节点；不要包含目标应用服务器或路由密码。'
};

// Only non-secret router hops belong in connection configuration. Route passwords
// (/P/, /W/) and SNC routes require a separate credential/configuration flow.
export const sapRouterSchema = z.preprocess(value => typeof value === 'string' ? value.trim() || undefined : value,
  z.string().max(2048).refine(route => {
    if (!/^(?:\/H\/[A-Za-z0-9][A-Za-z0-9.-]{0,252}(?:\/S\/[A-Za-z0-9][A-Za-z0-9._-]{0,31})?){1,8}$/.test(route)) return false;
    return [...route.matchAll(/\/S\/([^/]+)/g)].every(([, service]) => !/^\d+$/.test(service) || (Number(service) >= 1 && Number(service) <= 65535));
  }, connectionFieldHints.rfc_saprouter).optional());

export const connectionSchema = z.object({
  connection_id: z.string().uuid(),
  name: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  base_url: z.string().transform((value, context) => {
    try {
      return normalizeUrl(value);
    } catch {
      context.addIssue({ code: 'custom', message: connectionFieldHints.base_url });
      return z.NEVER;
    }
  }),
  client: z.string().regex(/^\d{3}$/),
  username: z.string().min(1),
  language: z.string().regex(/^[A-Z]{2}$/),
  write_enabled: z.boolean().default(false),
  rfc: z.object({
    ashost: z.string().min(1).max(253).regex(/^[A-Za-z0-9][A-Za-z0-9.-]*$/),
    sysnr: z.string().regex(/^\d{2}$/),
    saprouter: sapRouterSchema
  }).strict().optional(),
}).strict();

export type Connection = z.infer<typeof connectionSchema>;

// Keep the legacy field for config compatibility; RFC does not use its HTTP origin.
export function connectionBaseUrl(baseUrl: string | undefined, rfc: { ashost: string; sysnr: string } | undefined, old?: Connection) {
  if (baseUrl !== undefined) return baseUrl;
  if (!rfc) return undefined;
  if (old?.rfc?.ashost === rfc.ashost && old.rfc.sysnr === rfc.sysnr) return old.base_url;
  return 'http://rfc.invalid';
}

export function connectionIdentityChanged(old: Connection, updated: Connection) {
  return (!(old.rfc && updated.rfc) && old.base_url !== updated.base_url) || old.username !== updated.username || old.client !== updated.client
    || old.rfc?.ashost !== updated.rfc?.ashost || old.rfc?.sysnr !== updated.rfc?.sysnr
    || old.rfc?.saprouter !== updated.rfc?.saprouter;
}

const tokenNameSchema = z.string().trim().min(1).max(80).regex(/^[^\x00-\x1f\x7f]+$/);
function tokenName(value: unknown) {
  const parsed = tokenNameSchema.safeParse(value);
  if (!parsed.success) throw new AppError('INVALID_INPUT', '令牌名称需为 1～80 个字符，不能包含换行或控制字符。');
  return parsed.data;
}

const configSchema = z.object({
  schema_version: z.literal(1),
  connections: z.array(connectionSchema),
  tokens: z.array(z.object({
    id: z.string(),
    name: tokenNameSchema.optional(),
    hash: z.string(),
    created_at: z.string()
  }))
});

export type Config = z.infer<typeof configSchema>;

export function normalizeUrl(value: string): string {
  const u = new URL(value);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash ||
    !['/', '/sap/bc/adt', '/sap/bc/adt/'].includes(u.pathname)) {
    throw new Error('Use an HTTP or HTTPS server URL without credentials, query or custom path');
  }
  return u.origin;
}

export const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export class ConfigStore {
  constructor(public directory = defaultConfigDirectory()) { }

  async load(): Promise<Config> {
    try {
      return configSchema.parse(JSON.parse(await readFile(join(this.directory, 'config.json'), 'utf8')));
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return {
          schema_version: 1,
          connections: [],
          tokens: []
        };
      if (error instanceof z.ZodError || error instanceof SyntaxError) {
        const legacy = error instanceof z.ZodError && error.issues.some(issue => issue.code === 'unrecognized_keys' && issue.keys.includes('allowed_packages'));
        throw new AppError('CONFIG_INVALID', legacy
          ? '本地 config.json 包含已废弃的 allowed_packages 字段，请删除该字段后重试；连接不限制包。'
          : '本地 config.json 格式无效，请检查配置文件；这不是连接表单的格式错误。');
      }
      throw error;
    }
  }

  async save(config: Config) {
    const validated = configSchema.parse(config);
    await mkdir(this.directory, { recursive: true });
    const temp = join(this.directory, `${randomUUID()}.tmp`);
    await writeFile(temp, JSON.stringify(validated, null, 2) + '\n', { mode: 0o600 });
    await rename(temp, join(this.directory, 'config.json'));
  }

  async createToken(name?: string) {
    const label = name === undefined ? undefined : tokenName(name);
    const config = await this.load();
    const token = randomBytes(32).toString('base64url');
    const id = randomUUID();
    config.tokens.push({
      id,
      ...(label === undefined ? {} : { name: label }),
      hash: digest(token),
      created_at: new Date().toISOString()
    });
    await this.save(config);
    return {
      id,
      ...(label === undefined ? {} : { name: label }),
      token
    };
  }

  async renameToken(id: string, name: string) {
    const label = tokenName(name);
    const config = await this.load();
    const token = config.tokens.find(token => token.id === id);
    if (!token) throw new AppError('NOT_FOUND', '令牌不存在');
    token.name = label;
    await this.save(config);
    return { id: token.id, name: token.name, created_at: token.created_at };
  }

  async authenticate(token: string) {
    const hash = Buffer.from(digest(token), 'hex');
    return (await this.load()).tokens.some(t => {
      const expected = Buffer.from(t.hash, 'hex');
      return expected.length === hash.length && timingSafeEqual(expected, hash);
    });
  }
}

export interface Credentials {
  get(id: string): Promise<string>;
  set(id: string, password: string): Promise<void>;
  remove(id: string): Promise<void>;
}

export class WindowsCredentials implements Credentials {
  private async entry(id: string) {
    if (process.platform !== 'win32')
      throw new Error('Windows Credential Manager is required');
    const { Entry } = await import('@napi-rs/keyring');
    return new Entry('saplink', id);
  }

  async get(id: string) {
    const password = (await this.entry(id)).getPassword();
    if (!password)
      throw new Error('SAP credential is missing');
    return password;
  }

  async set(id: string, password: string) { (await this.entry(id)).setPassword(password); }

  async remove(id: string) { (await this.entry(id)).deletePassword(); }
}
