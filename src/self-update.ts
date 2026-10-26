import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, copyFile, mkdir, mkdtemp, open, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { AppError } from './errors.js';
import { appVersion } from './version.js';
import { checkForUpdate, isNewerVersion, type UpdateResult } from './updates.js';

export type InstalledApplication = { root: string; architecture: 'x64' | 'arm64'; launcher: string };
export type RestartPlan = { mode: 'ui' | 'service' | 'stopped'; mcp_port?: number; ui_port?: number };
export type InstallProgress = {
  phase: 'idle' | 'checking' | 'downloading' | 'verifying' | 'preparing' | 'installing' | 'failed';
  message: string; downloaded_bytes: number; total_bytes: number | null; version?: string; error_code?: string;
};

export async function installedApplication(): Promise<InstalledApplication | null> {
  if (process.platform !== 'win32' || !process.env.SAPLINK_WINDOWS_LAUNCHER) return null;
  const launcher = resolve(process.env.SAPLINK_WINDOWS_LAUNCHER);
  const root = dirname(dirname(launcher));
  if (launcher.toLowerCase() !== join(root, 'bin', 'saplink.exe').toLowerCase() ||
      resolve(process.execPath).toLowerCase() !== join(root, 'runtime', 'node.exe').toLowerCase() ||
      resolve(fileURLToPath(new URL('../', import.meta.url))).toLowerCase() !== join(root, 'app').toLowerCase()) return null;
  try {
    const manifest = JSON.parse((await readFile(join(root, 'install-manifest.json'), 'utf8')).replace(/^\uFEFF/, ''));
    const info = JSON.parse((await readFile(join(root, 'build-info.json'), 'utf8')).replace(/^\uFEFF/, ''));
    if (manifest.app_id !== 'org.saplink.desktop' || manifest.schema_version !== 1 || manifest.version !== appVersion ||
        !['x64', 'arm64'].includes(info.architecture)) return null;
    await access(join(root, 'update-runner.ps1'));
    return { root, launcher, architecture: info.architecture };
  } catch { return null; }
}

export async function downloadInstaller(download: UpdateResult['downloads'][number], directory: string,
  progress: (bytes: number, total: number | null) => void, fetcher = fetch) {
  const signal = AbortSignal.timeout(10 * 60 * 1000);
  const github = /^https:\/\/github\.com\/OneOFF-ive\/saplink\/releases\/download\/v?\d+\.\d+\.\d+\/SapLink-\d+\.\d+\.\d+-win-(?:x64|arm64)-setup\.exe$/.test(download.url);
  let url = download.url;
  let response: Response;
  for (let hop = 0; ; hop++) {
    response = await fetcher(url, { redirect: github ? 'manual' : 'error', signal });
    if (!github || ![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location');
    await response.body?.cancel().catch(() => {});
    if (!location || hop >= 3) throw new AppError('UPDATE_DOWNLOAD_FAILED', 'GitHub 安装包重定向无效。');
    const next = new URL(location, url);
    if (next.protocol !== 'https:' || next.username || next.password || next.hash ||
        !['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(next.hostname) || next.port) {
      throw new AppError('UPDATE_DOWNLOAD_FAILED', 'GitHub 安装包重定向不属于官方附件域名。');
    }
    url = next.href;
  }
  const maximum = 256 * 1024 * 1024;
  const length = response.headers.get('content-length');
  const total = length === null ? null : Number(length);
  if (!response.ok || !response.body || (total !== null && (!Number.isSafeInteger(total) || total <= 0 || total > maximum))) {
    await response.body?.cancel().catch(() => {});
    throw new AppError('UPDATE_DOWNLOAD_FAILED', '无法下载有效的安装包，请稍后重新检查更新。');
  }
  const partial = join(directory, 'installer.part');
  const target = join(directory, 'installer.exe');
  const file = await open(partial, 'wx', 0o600);
  const digest = createHash('sha256');
  let bytes = 0;
  let signature = Buffer.alloc(0);
  try {
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > maximum || (total !== null && bytes > total)) throw new AppError('UPDATE_DOWNLOAD_FAILED', '安装包大小异常，已停止更新。');
      if (signature.length < 2) signature = Buffer.concat([signature, Buffer.from(chunk)]).subarray(0, 2);
      digest.update(chunk);
      // FileHandle.write may write less than the supplied buffer.
      let offset = 0;
      while (offset < chunk.length) offset += (await file.write(chunk, offset, chunk.length - offset)).bytesWritten;
      progress(bytes, total);
    }
    if (!bytes || (total !== null && total !== bytes) || signature.toString('ascii') !== 'MZ') {
      throw new AppError('UPDATE_DOWNLOAD_FAILED', '安装包不完整或不是 Windows 可执行文件。');
    }
    if (digest.digest('hex') !== download.sha256) throw new AppError('UPDATE_HASH_MISMATCH', '安装包 SHA-256 校验失败，未停止服务或执行安装。');
  } catch (error) {
    await file.close();
    await unlink(partial).catch(() => {});
    throw error;
  }
  await file.close();
  const { rename } = await import('node:fs/promises');
  await rename(partial, target);
  return target;
}

export type UpdateDependencies = {
  installation: () => Promise<InstalledApplication | null>;
  check: () => Promise<UpdateResult>;
  github: () => Promise<UpdateResult>;
  download: typeof downloadInstaller;
  launch: (installation: InstalledApplication, script: string, plan: string) => Promise<void>;
};

async function launchRunner(installation: InstalledApplication, script: string, plan: string) {
  // The native bridge creates a hidden process without inheriting terminal/GUI pipes.
  const child = spawn(installation.launcher, ['--internal-update-run', script, plan], { windowsHide: true, stdio: 'ignore' });
  child.unref();
  let timer: ReturnType<typeof setTimeout>;
  await new Promise<void>((resolveLaunch, reject) => {
    timer = setTimeout(() => reject(new AppError('UPDATE_LAUNCH_FAILED', '更新启动器未及时响应，当前应用继续运行。')), 10000);
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolveLaunch() : reject(new AppError('UPDATE_LAUNCH_FAILED', '无法启动更新程序，当前应用继续运行。')));
  }).finally(() => clearTimeout(timer));
}

export class SelfUpdater {
  private progress: InstallProgress = { phase: 'idle', message: '', downloaded_bytes: 0, total_bytes: null };
  private checking = false;
  private updating = false;
  private result: UpdateResult | null = null;
  private task: Promise<void> | undefined;
  private dependencies: UpdateDependencies;
  constructor(private directory: string, dependencies: Partial<UpdateDependencies> = {}) {
    this.dependencies = { installation: installedApplication, check: () => checkForUpdate(appVersion, directory, { force: true }),
      github: () => checkForUpdate(appVersion, directory, { force: true, manifestUrl: null }),
      download: downloadInstaller, launch: launchRunner, ...dependencies };
  }

  get busy() { return this.checking || this.updating; }
  get latest() { return this.result; }
  async status() {
    const installation = await this.dependencies.installation();
    const last = await readFile(join(this.directory, 'update-install-result.json'), 'utf8').then(text => JSON.parse(text)).catch(() => null);
    return { ...this.progress, supported: Boolean(installation), architecture: installation?.architecture ?? null,
      unavailable_reason: installation ? null : '当前不是支持自动更新的 Windows 安装版，请手动安装新版。', last_result: last };
  }

  async check() {
    if (this.busy) throw new AppError('BUSY', '正在检查或安装更新，请稍后重试。');
    this.checking = true;
    try { this.result = await this.dependencies.check(); return this.result; }
    finally { this.checking = false; }
  }

  async install(version: string, restart: RestartPlan, shutdown: () => Promise<void>) {
    if (this.busy) throw new AppError('BUSY', '更新已在进行，请勿重复提交。');
    if (!/^\d+\.\d+\.\d+$/.test(version) || !isNewerVersion(version, appVersion)) throw new AppError('UPDATE_NOT_NEWER', '请选择比当前版本更新的正式版本。');
    this.updating = true;
    try {
      const installation = await this.dependencies.installation();
      if (!installation) throw new AppError('UPDATE_NOT_INSTALLED', '自动安装仅适用于 Windows 安装版；源码运行请手动安装。');
      const root = join(this.directory, 'updates');
      await mkdir(root, { recursive: true });
      const pending = join(root, 'pending.json');
      const id = randomUUID();
      const reservation = await open(pending, 'wx', 0o600).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new AppError('UPDATE_PENDING', '已有更新任务尚未结束，请核实更新结果后重试。');
        throw error;
      });
      try { await reservation.writeFile(JSON.stringify({ id })); }
      finally { await reservation.close(); }
      this.progress = { phase: 'downloading', message: '正在获取并下载最新安装包…', downloaded_bytes: 0, total_bytes: null, version };
      let handedOff = false;
      this.task = this.run(installation, root, id, version, restart, shutdown, () => { handedOff = true; }).catch(async error => {
        this.progress = { ...this.progress, phase: 'failed', message: error instanceof AppError ? error.message : '更新未完成，请检查网络及安装目录后重试。',
          error_code: error instanceof AppError ? error.code : 'UPDATE_FAILED' };
        this.updating = false;
        const own = await readFile(pending, 'utf8').then(text => JSON.parse(text).id === id).catch(() => false);
        if (own && !handedOff) await unlink(pending).catch(() => {});
      });
      return this.status();
    } catch (error) { this.updating = false; throw error; }
  }

  async wait() { await this.task; return this.progress; }

  private async run(installation: InstalledApplication, root: string, id: string, version: string, restart: RestartPlan,
    shutdown: () => Promise<void>, handOff: () => void) {
    // Never execute an arbitrary browser-supplied URL or a stale cached installer.
    const release = await this.dependencies.check();
    this.result = release;
    if (release.latest_version !== version || !release.update_available) {
      throw new AppError('UPDATE_VERSION_CHANGED', '更新源的版本已变化或暂不可用，请重新检查更新后再确认。');
    }
    let download = release.downloads.find(item => item.architecture === installation.architecture);
    const job = await mkdtemp(join(root, 'job-'));
    const progress = (bytes: number, total: number | null) => {
      this.progress = { ...this.progress, downloaded_bytes: bytes, total_bytes: total };
    };
    let installer: string;
    try {
      if (!download) throw new AppError('UPDATE_ARCHITECTURE_MISSING', '更新源尚未提供当前安装架构的有效安装包。');
      installer = await this.dependencies.download(download, job, progress);
    } catch (error) {
      if (release.source !== 'cos') throw error;
      this.progress = { ...this.progress, message: 'COS 安装包不可用，正在尝试 GitHub 官方发布…', downloaded_bytes: 0, total_bytes: null };
      const fallback = await this.dependencies.github();
      if (fallback.latest_version !== version || !fallback.update_available) {
        throw new AppError('UPDATE_VERSION_CHANGED', 'GitHub 后备源与已确认的目标版本不一致，请重新检查更新。');
      }
      const alternate = fallback.downloads.find(item => item.architecture === installation.architecture);
      if (!alternate) throw new AppError('UPDATE_ARCHITECTURE_MISSING', 'GitHub 未提供当前架构的安装包或有效 SHA-256，请手动处理。');
      if (download && alternate.sha256 !== download.sha256) throw new AppError('UPDATE_HASH_MISMATCH', 'COS 与 GitHub 安装包校验值不一致，已停止更新。');
      download = alternate;
      installer = await this.dependencies.download(download, job, progress);
    }
    this.progress = { ...this.progress, phase: 'preparing', message: '校验完成，正在准备正常退出并安装…' };
    const script = join(job, 'update-runner.ps1');
    await copyFile(join(installation.root, 'update-runner.ps1'), script);
    const plan = { schema_version: 1, id, install_directory: installation.root, installer, sha256: download.sha256,
      version, architecture: installation.architecture, config_directory: resolve(this.directory), ...restart };
    const planPath = join(job, 'plan.json');
    await writeFile(planPath, JSON.stringify(plan), { mode: 0o600 });
    await this.dependencies.launch(installation, script, planPath);
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const ack = await readFile(join(job, 'ready.json'), 'utf8').then(text => JSON.parse(text)).catch(() => null);
      if (ack?.id === id) { ready = true; break; }
      const failed = await readFile(join(job, 'result.json'), 'utf8').then(text => JSON.parse(text)).catch(() => null);
      if (failed) throw new AppError('UPDATE_RUNNER_FAILED', '更新程序未通过安装预检，当前应用继续运行。');
      await delay(100);
    }
    if (!ready) throw new AppError('UPDATE_RUNNER_TIMEOUT', '未确认更新程序就绪，当前应用继续运行。');
    this.progress = { ...this.progress, phase: 'installing', message: '安装包已验证，正在正常关闭应用并安装。完成后会重新启动。' };
    // After commitment only the runner may release the reservation, even if graceful shutdown fails.
    handOff();
    await writeFile(join(job, 'commit.json'), JSON.stringify({ id }), { mode: 0o600 });
    await shutdown();
  }
}
