import { access, readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const readJson = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));

async function canonical(path) {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = dirname(absolute);
    if (parent === absolute) throw error;
    return join(await canonical(parent), absolute.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
  }
}

function overlaps(a, b) {
  if (process.platform === 'win32') { a = a.toLowerCase(); b = b.toLowerCase(); }
  const inside = (parent, child) => {
    const path = relative(parent, child);
    return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
  };
  return inside(a, b) || inside(b, a);
}

export async function previewEnvironment(env = process.env) {
  const appData = env.APPDATA ?? homedir();
  const directory = resolve(env.SAPLINK_DEV_CONFIG_DIR ?? join(appData, 'saplink-3.0-dev'));
  const preview = await canonical(directory);
  const protectedDirectories = [join(appData, 'saplink')];
  if (env.SAPLINK_CONFIG_DIR && env.SAPLINK_DEV_PREVIEW !== '1') protectedDirectories.push(env.SAPLINK_CONFIG_DIR);
  for (const protectedDirectory of protectedDirectories) {
    if (overlaps(preview, await canonical(protectedDirectory)))
      throw Object.assign(new Error('Development and installed configuration directories must be separate.'), { code: 'DEV_DIRECTORY_CONFLICT' });
  }
  const logs = await canonical(join(directory, 'logs'));
  const protectedLogs = [join(env.LOCALAPPDATA ?? homedir(), 'saplink', 'logs'), ...protectedDirectories];
  if (env.SAPLINK_LOG_DIR && env.SAPLINK_DEV_PREVIEW !== '1') protectedLogs.push(env.SAPLINK_LOG_DIR);
  for (const protectedDirectory of protectedLogs) {
    if (overlaps(logs, await canonical(protectedDirectory)))
      throw Object.assign(new Error('Development logs must not overlap installed data.'), { code: 'DEV_DIRECTORY_CONFLICT' });
  }
  return {
    ...env, SAPLINK_CONFIG_DIR: directory, SAPLINK_LOG_DIR: join(directory, 'logs'),
    SAPLINK_DEV_PREVIEW: '1', SAPLINK_UI_PORT: '18766', SAPLINK_AUTO_UPDATE_CHECK: '0',
    SAPLINK_WINDOWS_LAUNCHER: undefined
  };
}

export async function previewRuntimeEnvironment(env = process.env, platform = process.platform) {
  let install = env.SAPLINK_DEV_INSTALL_ROOT;
  if (!install && platform === 'win32' && env.LOCALAPPDATA &&
      !env.SAPLINK_RFC_JAVA && !env.SAPLINK_RFC_JCO_JAR && !env.SAPLINK_RFC_NATIVE_DIR && !env.SAPLINK_RFC_BRIDGE_CLASSES) {
    const candidate = join(env.LOCALAPPDATA, 'Programs', 'SapLink');
    try { await access(join(candidate, 'install-manifest.json')); install = candidate; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return install ? previewRfcEnvironment(env, install) : env;
}

export async function previewRfcEnvironment(env, installRoot) {
  const directory = resolve(installRoot);
  const manifest = await readJson(join(directory, 'install-manifest.json'));
  if (manifest.app_id !== 'org.saplink.desktop' || manifest.schema_version !== 1)
    throw Object.assign(new Error('Installed RFC runtime is not verified.'), { code: 'DEV_RUNTIME_UNVERIFIED' });
  const localBridge = await readFile(join(root, 'bridge', 'src', 'SapLinkRfcBridge.java'));
  const installedBridge = await readFile(join(directory, 'app', 'bridge', 'src', 'SapLinkRfcBridge.java'));
  if (hash(localBridge) !== hash(installedBridge))
    throw Object.assign(new Error('Installed RFC bridge does not match the development source.'), { code: 'DEV_BRIDGE_MISMATCH' });
  const rfc = await readJson(join(directory, 'runtime', 'rfc-runtime.json'));
  if (rfc.schema_version !== 1 || !/^(sapjco3|com\.sap\.conn\.jco[-_]\d+\.\d+\.\d+)\.jar$/.test(rfc.jar_file))
    throw Object.assign(new Error('Installed RFC runtime is not verified.'), { code: 'DEV_RUNTIME_UNVERIFIED' });
  const paths = { SAPLINK_RFC_JAVA: join(directory, 'runtime', 'java', 'bin', 'java.exe'),
    SAPLINK_RFC_JCO_JAR: join(directory, 'runtime', 'jco', rfc.jar_file),
    SAPLINK_RFC_NATIVE_DIR: join(directory, 'runtime', 'jco'),
    SAPLINK_RFC_BRIDGE_CLASSES: join(directory, 'app', 'bridge', 'classes') };
  for (const path of Object.values(paths)) await access(path);
  return { ...env, ...paths };
}
