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
const jcoArchiveName = /^(sapjco3|com\.sap\.conn\.jco[-_]\d+\.\d+\.\d+)\.jar$/;
const runtimeVersionValue = /^[a-zA-Z0-9._+() -]{1,100}$/;
const localPath = z.string().trim().min(1).max(4096)
  .refine(value => isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value));

export const rfcEnvironmentSchema = z.object({
  java_home: localPath.optional(),
  jco_directory: localPath.optional()
}).strict();

export type RfcEnvironmentSettings = z.infer<typeof rfcEnvironmentSchema>;
export type RfcEnvironmentOptions = {
  env?: NodeJS.ProcessEnv;
  directory?: string;
  appRoot?: string;
  platform?: NodeJS.Platform;
};

type Candidate = {
  path: string;
  source: 'settings' | 'environment' | 'bundled' | 'system';
};
type RfcEnvironment = {
  settings: RfcEnvironmentSettings;
  managed: boolean;
  architecture?: string;
  java?: Candidate;
  jar?: Candidate;
  native?: Candidate;
  nativeFile?: string;
  classes: string;
};
type RuntimeVersions = { java: string; architecture: string; jco: string };
type EnvironmentCheck = { name: string; passed: boolean; message: string };

function readSettings(directory: string): RfcEnvironmentSettings {
  try {
    const contents = readFileSync(join(directory, 'rfc-runtime.json'), 'utf8');
    return rfcEnvironmentSchema.parse(JSON.parse(contents));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new AppError('RFC_ENVIRONMENT_INVALID', 'RFC 环境配置无效，请重新保存运行环境路径。');
  }
}

function installationDirectories(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .slice(0, 32)
      .map(entry => join(root, entry.name))
      .reverse();
  } catch {
    return [];
  }
}

function explicitPath(value: string | undefined, label: string): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (!isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) {
    throw new AppError('RFC_ENVIRONMENT_INVALID', `${label} 必须是本机绝对路径。`);
  }
  return value;
}

function discoverBundledEnvironment(root: string, platform: NodeJS.Platform): RfcEnvironment | undefined {
  const runtimeRoot = resolve(root, '..', 'runtime');
  const manifestPath = join(runtimeRoot, 'rfc-runtime.json');
  if (!existsSync(manifestPath)) return undefined;

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    throw new AppError('RFC_ENVIRONMENT_INVALID', '随包 RFC 环境清单损坏，请修复安装。');
  }
  if (!manifest || platform !== 'win32' || manifest.schema_version !== 1 || manifest.architecture !== 'x64') {
    throw new AppError('RFC_ENVIRONMENT_INVALID', '随包 RFC 环境不支持当前平台，请修复安装。');
  }

  const jarFile = manifest.jar_file ?? 'sapjco3.jar';
  if (typeof jarFile !== 'string' || !jcoArchiveName.test(jarFile)) {
    throw new AppError('RFC_ENVIRONMENT_INVALID', '随包 JCo 文件名无效，请修复安装。');
  }
  const nativeDirectory = join(runtimeRoot, 'jco');
  return {
    settings: {},
    managed: true,
    architecture: 'x64',
    java: { path: join(runtimeRoot, 'java', 'bin', 'java.exe'), source: 'bundled' },
    jar: { path: join(nativeDirectory, jarFile), source: 'bundled' },
    native: { path: nativeDirectory, source: 'bundled' },
    nativeFile: join(nativeDirectory, 'sapjco3.dll'),
    classes: join(root, 'bridge', 'classes')
  };
}

function systemJavaCandidates(env: NodeJS.ProcessEnv, javaName: string): string[] {
  const javaHomes = [env.JAVA_HOME, env.JRE_HOME]
    .filter((value): value is string => Boolean(value && isAbsolute(value)));
  const pathDirectories = (env.PATH ?? env.Path ?? '').split(delimiter).filter(isAbsolute);
  const programDirectories = [env.ProgramFiles, env['ProgramFiles(x86)']]
    .filter((value): value is string => Boolean(value));
  const installedJavaHomes = programDirectories.flatMap(root => [
    ...installationDirectories(join(root, 'Eclipse Adoptium')),
    ...installationDirectories(join(root, 'Java')),
    ...installationDirectories(join(root, 'Microsoft'))
  ]);

  return [
    ...javaHomes.map(home => join(home, 'bin', javaName)),
    ...pathDirectories.map(directory => join(directory, javaName)),
    ...installedJavaHomes.map(home => join(home, 'bin', javaName))
  ];
}

function discoverJava(
  settings: RfcEnvironmentSettings,
  env: NodeJS.ProcessEnv,
  root: string,
  javaName: string
): Candidate | undefined {
  if (settings.java_home) {
    return { path: join(settings.java_home, 'bin', javaName), source: 'settings' };
  }
  if (env.SAPLINK_RFC_JAVA) {
    return { path: explicitPath(env.SAPLINK_RFC_JAVA, 'SAPLINK_RFC_JAVA')!, source: 'environment' };
  }

  const bundledJava = resolve(root, '..', 'runtime', 'java', 'bin', javaName);
  if (existsSync(bundledJava)) return { path: bundledJava, source: 'bundled' };

  const systemJava = systemJavaCandidates(env, javaName).find(path => existsSync(path));
  return systemJava ? { path: systemJava, source: 'system' } : undefined;
}

function discoverJco(
  settings: RfcEnvironmentSettings,
  env: NodeJS.ProcessEnv,
  directory: string,
  nativeName: string
): { jar?: Candidate; native?: Candidate } {
  if (settings.jco_directory) {
    return {
      jar: { path: join(settings.jco_directory, 'sapjco3.jar'), source: 'settings' },
      native: { path: settings.jco_directory, source: 'settings' }
    };
  }

  let jar: Candidate | undefined;
  let native: Candidate | undefined;
  if (env.SAPLINK_RFC_JCO_JAR) {
    jar = { path: explicitPath(env.SAPLINK_RFC_JCO_JAR, 'SAPLINK_RFC_JCO_JAR')!, source: 'environment' };
  }
  if (env.SAPLINK_RFC_NATIVE_DIR) {
    native = { path: explicitPath(env.SAPLINK_RFC_NATIVE_DIR, 'SAPLINK_RFC_NATIVE_DIR')!, source: 'environment' };
  }
  if (jar && !native && existsSync(join(dirname(jar.path), nativeName))) {
    native = { path: dirname(jar.path), source: jar.source };
  }
  // Even an incomplete explicit override takes precedence over system discovery.
  if (jar || native) return { jar, native };

  const classpathHomes = (env.CLASSPATH ?? '').split(delimiter)
    .filter(path => /(?:^|[/\\])sapjco3\.jar$/i.test(path))
    .map(path => dirname(path));
  const candidates = [env.SAPJCO_HOME, join(directory, 'jco'), ...classpathHomes]
    .filter((value): value is string => Boolean(value && isAbsolute(value)));
  for (const home of candidates) {
    if (existsSync(join(home, 'sapjco3.jar')) && existsSync(join(home, nativeName))) {
      return {
        jar: { path: join(home, 'sapjco3.jar'), source: 'system' },
        native: { path: home, source: 'system' }
      };
    }
  }
  return {};
}

// Local discovery never downloads components, executes a shell or contacts SAP.
export function discoverRfcEnvironment(options: RfcEnvironmentOptions = {}): RfcEnvironment {
  const env = options.env ?? process.env;
  const root = options.appRoot ?? applicationRoot;
  const directory = options.directory ?? env.SAPLINK_CONFIG_DIR ?? defaultConfigDirectory();
  const platform = options.platform ?? process.platform;

  // A complete installed runtime must never mix with system components or stale settings.
  const bundled = discoverBundledEnvironment(root, platform);
  if (bundled) return bundled;

  const settings = readSettings(directory);
  const javaName = platform === 'win32' ? 'java.exe' : 'java';
  const nativeName = platform === 'win32' ? 'sapjco3.dll'
    : platform === 'darwin' ? 'libsapjco3.jnilib' : 'libsapjco3.so';
  const java = discoverJava(settings, env, root, javaName);
  const { jar, native } = discoverJco(settings, env, directory, nativeName);
  const classes = explicitPath(env.SAPLINK_RFC_BRIDGE_CLASSES, 'SAPLINK_RFC_BRIDGE_CLASSES')
    ?? join(root, 'bridge', 'classes');

  return {
    settings,
    managed: false,
    architecture: undefined,
    java,
    jar,
    native,
    nativeFile: native ? join(native.path, nativeName) : undefined,
    classes
  };
}

export async function saveRfcEnvironment(directory: string, value: unknown) {
  const parsed = rfcEnvironmentSchema.safeParse(value);
  if (!parsed.success) {
    throw new AppError('INVALID_INPUT', '请填写本机 Java 安装目录和 JCo 目录的绝对路径，留空可恢复自动检测。');
  }
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `rfc-runtime-${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(parsed.data, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, join(directory, 'rfc-runtime.json'));
  return parsed.data;
}

export function javaProcessEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, JAVA_TOOL_OPTIONS: '', JDK_JAVA_OPTIONS: '', _JAVA_OPTIONS: '' };
}

function parseRuntimeVersions(stdout: string): RuntimeVersions {
  const fields = stdout.trim().split(/\r?\n/).at(-1)?.split('\t') ?? [];
  if (fields.length !== 5 || fields[0] !== 'RFC_ENV' || fields[1] !== '1') {
    throw new Error('INVALID_CHECK_PROTOCOL');
  }
  const values = fields.slice(2).map(value => Buffer.from(value, 'base64').toString('utf8'));
  if (values.some(value => !runtimeVersionValue.test(value))) {
    throw new Error('INVALID_CHECK_PROTOCOL');
  }
  return { java: values[0], architecture: values[1], jco: values[2] };
}

// A bounded local JVM loads JNI and exits. No SAP destination or credentials exist.
export async function checkRfcEnvironment(options: RfcEnvironmentOptions = {}) {
  const found = discoverRfcEnvironment(options);
  const checks: EnvironmentCheck[] = [];
  const add = (name: string, passed: boolean, message: string) => checks.push({ name, passed, message });
  const javaFound = Boolean(found.java && existsSync(found.java.path));
  const jarFound = Boolean(found.jar && existsSync(found.jar.path));
  const nativeFound = Boolean(found.nativeFile && existsSync(found.nativeFile));
  const bridgeFound = existsSync(join(found.classes, 'SapLinkRfcBridge.class'));

  add('java', javaFound, javaFound ? '已找到 Java。' : '未找到 Java，请修复安装或指定 Java 目录。');
  add('jco', jarFound, jarFound ? '已找到 JCo JAR。' : '未找到 JCo，请指定已从 SAP 获取的本地 JCo 目录。');
  add('native', nativeFound, nativeFound ? '已找到原生库。' : '未找到配套原生库，请检查 JCo 目录。');
  add('bridge', bridgeFound, bridgeFound ? 'SapLink RFC 桥接组件可用。' : '缺少 SapLink RFC 桥接组件，请修复安装或编译桥接组件。');

  let versions: RuntimeVersions | undefined;
  if (checks.every(check => check.passed) && found.java && found.jar && found.native) {
    try {
      const javaArguments = [
        `-Djava.library.path=${found.native.path}`,
        '-cp', `${found.classes}${delimiter}${found.jar.path}`,
        'SapLinkRfcBridge', '--check-runtime'
      ];
      const { stdout } = await execute(found.java.path, javaArguments, {
        windowsHide: true,
        timeout: 15000,
        maxBuffer: 32768,
        cwd: dirname(found.java.path),
        env: javaProcessEnvironment(options.env ?? process.env)
      });
      versions = parseRuntimeVersions(stdout);
      add('load', true, 'Java、JCo 和原生库已成功加载；未连接 SAP。');
    } catch {
      add('load', false, '加载失败：请检查 Java/JCo 支持的版本、32/64 位架构、原生库版本及 Windows VC++ 运行库是否匹配。');
    }
  }
  return {
    healthy: checks.every(check => check.passed),
    checks,
    versions,
    managed: found.managed,
    settings: found.settings,
    detected: {
      java: found.java,
      jco_jar: found.jar,
      native_directory: found.native,
      bridge_classes: found.classes
    },
    sap_connected: false
  };
}
