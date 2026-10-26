import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from './errors.js';
import { appVersion } from './version.js';

const repository = 'OneOFF-ive/saplink';
const releasesUrl = `https://github.com/${repository}/releases`;
export const defaultManifestUrl = 'https://saplink-1302377695.cos.ap-shanghai.myqcloud.com/saplink/latest.json';
const cacheLifetime = 24 * 60 * 60 * 1000;
const versionPattern = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const releaseSchema = z.object({
  tag_name: z.string().max(256).regex(versionPattern),
  name: z.string().max(1024).nullable().optional(), body: z.string().max(64000).nullable().optional(),
  draft: z.literal(false), prerelease: z.literal(false),
  published_at: z.string().nullable(),
  html_url: z.string().refine(value => {
    try { const url = new URL(value); return url.origin === 'https://github.com' && !url.username && !url.password &&
      url.pathname.startsWith(`/${repository}/releases/tag/`) && !url.search && !url.hash; }
    catch { return false; }
  })
}).refine(value => !versionPattern.exec(value.tag_name)?.[4], 'Expected a stable release');
const notesSchema = z.object({ schema_version: z.literal(1), version: z.string(),
  title: z.string().max(1024), notes: z.string().max(64000) }).strict();
const downloadSchema = z.object({
  architecture: z.enum(['x64', 'arm64']), url: z.string().url(), sha256: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();
const manifestSchema = z.object({
  schema_version: z.literal(1), version: z.string().regex(/^\d+\.\d+\.\d+$/),
  published_at: z.string().datetime(), downloads: z.array(downloadSchema).min(1).max(2),
  skill: z.object({
    commit: z.string().regex(/^[a-f0-9]{40}$/), filename: z.string().max(256),
    url: z.string().url(), size: z.number().int().positive().max(16 * 1024 * 1024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/)
  }).strict().optional()
}).strict();
const cacheSchema = z.object({
  checked_at: z.number(), manifest_url: z.string().nullable(), source: z.enum(['cos', 'github']),
  release: releaseSchema.nullable(), downloads: z.array(downloadSchema).max(2)
});

function manifestLocation(value: string | null): URL | null {
  if (value === null) return null;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash) return url;
  } catch { /* Report a configuration error without exposing the supplied value. */ }
  throw new AppError('UPDATE_SOURCE_INVALID', 'SAPLINK_UPDATE_URL must be an HTTPS manifest URL without credentials, query or fragment; use github for GitHub only.');
}

function validateDownloads(downloads: z.infer<typeof downloadSchema>[], location: URL | null, version: string) {
  if (!location || !downloads.length || new Set(downloads.map(item => item.architecture)).size !== downloads.length) throw new Error('Invalid download list');
  const prefix = new URL('.', location).pathname;
  for (const item of downloads) {
    const url = new URL(item.url);
    const expectedPath = `${prefix}v${version}/SapLink-${version}-win-${item.architecture}-setup.exe`;
    if (url.origin !== location.origin || url.pathname !== expectedPath || url.username || url.password || url.search || url.hash) {
      throw new Error('Download must match the manifest origin, version and architecture');
    }
  }
}

async function readMetadata(response: Response): Promise<unknown> {
  // Bound both valid and malformed responses before parsing JSON.
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty metadata response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 256 * 1024) throw new Error('Oversized release metadata');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function isNewerVersion(latest: string, current: string): boolean {
  const a = versionPattern.exec(latest); const b = versionPattern.exec(current);
  if (!a || !b || a[4]) throw new AppError('UPDATE_VERSION_INVALID', 'Expected a valid current version and a stable release tag such as v0.2.0.');
  for (let i = 1; i <= 3; i++) {
    if (BigInt(a[i]) !== BigInt(b[i])) return BigInt(a[i]) > BigInt(b[i]);
  }
  return Boolean(b[4]);
}

export async function checkForUpdate(currentVersion: string, directory: string,
  options: { force?: boolean; fetcher?: typeof fetch; now?: number; signal?: AbortSignal; manifestUrl?: string | null } = {}) {
  const now = options.now ?? Date.now();
  const configured = options.manifestUrl !== undefined ? options.manifestUrl :
    process.env.SAPLINK_UPDATE_URL === 'github' ? null : process.env.SAPLINK_UPDATE_URL ?? defaultManifestUrl;
  const location = manifestLocation(configured);
  const manifestUrl = location?.href ?? null;
  const cachePath = join(directory, 'update-check.json');
  let cached: z.infer<typeof cacheSchema> | undefined;
  if (!options.force) {
    try {
      const value = cacheSchema.parse(JSON.parse(await readFile(cachePath, 'utf8')));
      if (location && value.source !== 'cos') throw new Error('Refresh legacy fallback cache');
      if (value.source === 'cos') {
        if (!value.release) throw new Error('Missing mirror version');
        validateDownloads(value.downloads, location, value.release.tag_name.replace(/^v/, ''));
      } else if (value.downloads.length) throw new Error('Unexpected mirror downloads');
      if (value.manifest_url === manifestUrl && now >= value.checked_at && now - value.checked_at < cacheLifetime) cached = value;
    } catch { /* Missing, old-format or invalid caches are refreshed. */ }
  }
  let release = cached?.release;
  let source: 'cos' | 'github' = cached?.source ?? 'github';
  let downloads = cached?.downloads ?? [];
  if (!cached) {
    // Stopping may happen while the asynchronous cache read is still pending.
    options.signal?.throwIfAborted();
    const request = (url: string, github = false) => (options.fetcher ?? fetch)(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'SapLink-update-check',
          ...(github ? { 'X-GitHub-Api-Version': '2022-11-28' } : {}) },
        signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000), redirect: 'error'
      });
    let mirrorSucceeded = false;
    if (location) {
      try {
        const response = await request(location.href);
        if (!response.ok) throw new Error('Mirror unavailable');
        const manifest = manifestSchema.parse(await readMetadata(response));
        // Reuse the same strict stable-version validation as GitHub.
        release = releaseSchema.parse({ tag_name: `v${manifest.version}`, draft: false, prerelease: false,
          published_at: manifest.published_at, html_url: `${releasesUrl}/tag/v${manifest.version}` });
        validateDownloads(manifest.downloads, location, manifest.version);
        downloads = manifest.downloads;
        source = 'cos';
        mirrorSucceeded = true;
      } catch {
        options.signal?.throwIfAborted();
        throw new AppError('UPDATE_CHECK_FAILED', 'COS 更新清单不可用或格式无效，请稍后重试；未自动切换到 GitHub。');
      }
    }
    if (!mirrorSucceeded) {
      options.signal?.throwIfAborted();
      let response: Response;
      try { response = await request(`https://api.github.com/repos/${repository}/releases/latest`, true); }
      catch { throw new AppError('UPDATE_CHECK_FAILED', `Could not reach GitHub${location ? ' after the mirror failed' : ''} within the update check timeout. Try again later or visit ${releasesUrl}`); }
      if (response.status === 404) release = null;
      else {
        if (!response.ok) throw new AppError('UPDATE_CHECK_FAILED', `GitHub returned HTTP ${response.status}${location ? ' after the mirror failed' : ''}. Try again later or visit ${releasesUrl}`);
        try { release = releaseSchema.parse(await readMetadata(response)); }
        catch { throw new AppError('UPDATE_RESPONSE_INVALID', `GitHub returned invalid release metadata. Visit ${releasesUrl}`); }
      }
      downloads = [];
      source = 'github';
    }
    if (source === 'cos' && location && release && isNewerVersion(release.tag_name, currentVersion)) {
      // Separate metadata preserves the strict installer manifest used by older clients.
      // Fetch only the matching version from COS; notes failure must not block installation.
      try {
        const version = release.tag_name.replace(/^v/, '');
        const response = await request(new URL(`v${version}/release-notes.json`, new URL('.', location)).href);
        if (response.ok) {
          const notes = notesSchema.parse(await readMetadata(response));
          if (notes.version === version) release = { ...release, name: notes.title, body: notes.notes };
        } else await response.body?.cancel().catch(() => {});
      } catch { options.signal?.throwIfAborted(); }
    }
    // Update metadata is separate from connection configuration and needs no service lock.
    try {
      await mkdir(directory, { recursive: true });
      const temporary = join(directory, `update-${randomUUID()}.tmp`);
      await writeFile(temporary, JSON.stringify({ checked_at: now, manifest_url: manifestUrl, source, release, downloads }), { mode: 0o600 });
      await rename(temporary, cachePath);
    } catch { /* A cache write failure must not hide a successful check. */ }
  }
  return {
    current_version: currentVersion,
    latest_version: release?.tag_name.replace(/^v/, '') ?? null,
    source, downloads,
    ...(release?.name != null ? { release_title: release.name } : {}),
    ...(release?.body != null ? { release_notes: release.body } : {}),
    update_available: release ? isNewerVersion(release.tag_name, currentVersion) : false,
    release_url: source === 'cos' ? releasesUrl : release?.html_url ?? releasesUrl,
    published_at: release?.published_at ?? null,
    checked_at: new Date(cached?.checked_at ?? now).toISOString(), cached: Boolean(cached),
    message: !release ? 'No public stable release found; the repository may be private or have no published releases.' :
      isNewerVersion(release.tag_name, currentVersion) ? 'A new version is available. Open the release page to choose and download the appropriate installer.' :
        'No newer stable version is available.'
  };
}

export type UpdateResult = Awaited<ReturnType<typeof checkForUpdate>>;
let automaticResult: UpdateResult | undefined;
export const getAutomaticUpdate = () => automaticResult;

export function startAutomaticUpdates(currentVersion: string, directory: string,
  options: { disabled?: boolean; intervalMs?: number; fetcher?: typeof fetch; manifestUrl?: string | null;
    notify?: (result: UpdateResult) => void | Promise<void> } = {}) {
  const controller = new AbortController();
  let checking = false;
  let notified: string | null = null;
  const check = async () => {
    if (checking || controller.signal.aborted || options.disabled) return;
    checking = true;
    try {
      // Refresh background metadata even when a CLI check populated the 24-hour cache.
      await Promise.resolve();
      const result = await checkForUpdate(currentVersion, directory, { force: true, fetcher: options.fetcher, signal: controller.signal, manifestUrl: options.manifestUrl });
      if (controller.signal.aborted) return;
      automaticResult = result;
      if (result.update_available && result.latest_version !== notified) {
        notified = result.latest_version;
        await options.notify?.(result);
      }
    } catch { /* Background failures do not interrupt SAP or produce repeated alerts. */ }
    finally { checking = false; }
  };
  const initialCheck = check();
  const timer = options.disabled ? undefined : setInterval(() => { void check(); }, options.intervalMs ?? 60 * 60 * 1000);
  timer?.unref();
  return { initialCheck, check, stop: () => { controller.abort(); if (timer) clearInterval(timer); } };
}

export function startRuntimeUpdateChecks(directory: string) {
  return startAutomaticUpdates(appVersion, directory, {
    // The management UI displays update availability without popups or notice files.
    disabled: process.env.SAPLINK_AUTO_UPDATE_CHECK === '0'
  });
}
