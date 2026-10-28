import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { defaultConfigDirectory } from './paths.js';
import { AppError } from './errors.js';

const execute = promisify(execFile);
const applicationRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const localPath = z.string().trim().min(1).max(4096).refine(value => isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value));
export const rfcEnvironmentSchema = z.object({ java_home: localPath.optional(), jco_directory: localPath.optional() }).strict();
export type RfcEnvironmentSettings = z.infer<typeof rfcEnvironmentSchema>;
type Candidate = { path: string; source: 'settings' | 'environment' | 'bundled' | 'system' };
export type RfcEnvironmentOptions = { env?: NodeJS.ProcessEnv; directory?: string; appRoot?: string; platform?: NodeJS.Platform };

function readSettings(directory: string): RfcEnvironmentSettings {
  try { return rfcEnvironmentSchema.parse(JSON.parse(readFileSync(join(directory, 'rfc-runtime.json'), 'utf8'))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new AppError('RFC_ENVIRONMENT_INVALID', 'RFC 环境配置无效，请重新保存运行环境路径。');
  }
}
function folders(root: string) {
  try { return readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).slice(0, 32).map(entry => join(root, entry.name)).reverse(); }
  catch { return []; }
}
function explicitPath(value: string | undefined, label: string): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (!isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) throw new AppError('RFC_ENVIRONMENT_INVALID', `${label} 必须是本机绝对路径。`);
  return value;
}

// Local discovery never downloads components, executes a shell or contacts SAP.
export function discoverRfcEnvironment(options: RfcEnvironmentOptions = {}) {
  const env = options.env ?? process.env, root = options.appRoot ?? applicationRoot;
  const directory = options.directory ?? env.SAPLINK_CONFIG_DIR ?? defaultConfigDirectory();
  const platform = options.platform ?? process.platform, settings = readSettings(directory);
  const javaName = platform === 'win32' ? 'java.exe' : 'java';
  const dllName = platform === 'win32' ? 'sapjco3.dll' : platform === 'darwin' ? 'libsapjco3.jnilib' : 'libsapjco3.so';
  let java: Candidate | undefined, jar: Candidate | undefined, native: Candidate | undefined;
  if (settings.java_home) java = { path: join(settings.java_home, 'bin', javaName), source: 'settings' };
  else if (env.SAPLINK_RFC_JAVA) java = { path: explicitPath(env.SAPLINK_RFC_JAVA, 'SAPLINK_RFC_JAVA')!, source: 'environment' };
  else {
    const bundled = resolve(root, '..', 'runtime', 'java', 'bin', javaName);
    if (existsSync(bundled)) java = { path: bundled, source: 'bundled' };
    else {
      const homes = [env.JAVA_HOME, env.JRE_HOME].filter((value): value is string => Boolean(value && isAbsolute(value)));
      const candidates = [...homes.map(home => join(home, 'bin', javaName)),
        ...(env.PATH ?? env.Path ?? '').split(delimiter).filter(path => isAbsolute(path)).map(path => join(path, javaName)),
        ...[env.ProgramFiles, env['ProgramFiles(x86)']].filter((value): value is string => Boolean(value))
          .flatMap(path => [...folders(join(path, 'Eclipse Adoptium')), ...folders(join(path, 'Java')), ...folders(join(path, 'Microsoft'))])
          .map(home => join(home, 'bin', javaName))];
      const path = candidates.find(path => existsSync(path));
      if (path) java = { path, source: 'system' };
    }
  }
  if (settings.jco_directory) {
    jar = { path: join(settings.jco_directory, 'sapjco3.jar'), source: 'settings' };
    native = { path: settings.jco_directory, source: 'settings' };
  } else {
    if (env.SAPLINK_RFC_JCO_JAR) jar = { path: explicitPath(env.SAPLINK_RFC_JCO_JAR, 'SAPLINK_RFC_JCO_JAR')!, source: 'environment' };
    if (env.SAPLINK_RFC_NATIVE_DIR) native = { path: explicitPath(env.SAPLINK_RFC_NATIVE_DIR, 'SAPLINK_RFC_NATIVE_DIR')!, source: 'environment' };
    if (jar && !native && existsSync(join(dirname(jar.path), dllName))) native = { path: dirname(jar.path), source: jar.source };
    const candidates = [env.SAPJCO_HOME, join(directory, 'jco'), ...(env.CLASSPATH ?? '').split(delimiter)
      .filter(path => /(?:^|[/\\])sapjco3\.jar$/i.test(path)).map(path => dirname(path))]
      .filter((value): value is string => Boolean(value && isAbsolute(value)));
    if (!jar && !native) for (const home of candidates) {
      if (existsSync(join(home, 'sapjco3.jar')) && existsSync(join(home, dllName))) {
        jar = { path: join(home, 'sapjco3.jar'), source: 'system' };
        native = { path: home, source: 'system' }; break;
      }
    }
  }
  const classes = explicitPath(env.SAPLINK_RFC_BRIDGE_CLASSES, 'SAPLINK_RFC_BRIDGE_CLASSES') ?? join(root, 'bridge', 'classes');
  return { settings, java, jar, native, nativeFile: native ? join(native.path, dllName) : undefined, classes };
}

export async function saveRfcEnvironment(directory: string, value: unknown) {
  const parsed = rfcEnvironmentSchema.safeParse(value);
  if (!parsed.success) throw new AppError('INVALID_INPUT', '请填写本机 Java 安装目录和 JCo 目录的绝对路径，留空可恢复自动检测。');
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `rfc-runtime-${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(parsed.data, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, join(directory, 'rfc-runtime.json'));
  return parsed.data;
}

// A bounded local JVM loads JNI and exits. No SAP destination or credentials exist.
export async function checkRfcEnvironment(options: RfcEnvironmentOptions = {}) {
  const found = discoverRfcEnvironment(options);
  const checks: { name: string; passed: boolean; message: string }[] = [];
  const add = (name: string, passed: boolean, message: string) => checks.push({ name, passed, message });
  const javaFound = Boolean(found.java && existsSync(found.java.path)), jarFound = Boolean(found.jar && existsSync(found.jar.path));
  const nativeFound = Boolean(found.nativeFile && existsSync(found.nativeFile)), bridgeFound = existsSync(join(found.classes, 'SapLinkRfcBridge.class'));
  add('java', javaFound, javaFound ? '已找到 Java。' : '未找到 Java，请修复安装或指定 Java 目录。');
  add('jco', jarFound, jarFound ? '已找到 JCo JAR。' : '未找到 JCo，请指定已从 SAP 获取的本地 JCo 目录。');
  add('native', nativeFound, nativeFound ? '已找到原生库。' : '未找到配套原生库，请检查 JCo 目录。');
  add('bridge', bridgeFound, bridgeFound ? 'SapLink RFC 桥接组件可用。' : '缺少 SapLink RFC 桥接组件，请修复安装或编译桥接组件。');
  let versions: { java: string; architecture: string; jco: string } | undefined;
  if (checks.every(check => check.passed) && found.java && found.jar && found.native) {
    try {
      const { stdout } = await execute(found.java.path, [`-Djava.library.path=${found.native.path}`, '-cp',
        `${found.classes}${delimiter}${found.jar.path}`, 'SapLinkRfcBridge', '--check-runtime'], {
        windowsHide: true, timeout: 15000, maxBuffer: 32768, cwd: dirname(found.java.path),
        env: { ...(options.env ?? process.env), JAVA_TOOL_OPTIONS: '', JDK_JAVA_OPTIONS: '', _JAVA_OPTIONS: '' }
      });
      const fields = stdout.trim().split(/\r?\n/).at(-1)?.split('\t') ?? [];
      if (fields.length !== 5 || fields[0] !== 'RFC_ENV' || fields[1] !== '1') throw new Error('INVALID_CHECK_PROTOCOL');
      const values = fields.slice(2).map(value => Buffer.from(value, 'base64').toString('utf8'));
      if (values.some(value => !/^[a-zA-Z0-9._+() -]{1,100}$/.test(value))) throw new Error('INVALID_CHECK_PROTOCOL');
      versions = { java: values[0], architecture: values[1], jco: values[2] };
      add('load', true, 'Java、JCo 和原生库已成功加载；未连接 SAP。');
    } catch {
      add('load', false, '加载失败：请检查 Java/JCo 支持的版本、32/64 位架构、原生库版本及 Windows VC++ 运行库是否匹配。');
    }
  }
  return { healthy: checks.every(check => check.passed), checks, versions, settings: found.settings,
    detected: { java: found.java, jco_jar: found.jar, native_directory: found.native, bridge_classes: found.classes }, sap_connected: false };
}
