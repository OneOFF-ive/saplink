"""Publish verified official release assets; keep the COS pointer last and monotonic."""
import hashlib
import http.client
import importlib.util
import json
import logging
import os
from pathlib import Path
import re
import sys
import time
import urllib.error
import urllib.request

BUCKET = 'saplink-1302377695'
REGION = 'ap-shanghai'
ORIGIN = f'https://{BUCKET}.cos.{REGION}.myqcloud.com'
LATEST_KEY = 'saplink/latest.json'
SKILL_LATEST_KEY = 'saplink/skill-latest.json'
MAX_INSTALLER_SIZE = 256 * 1024 * 1024
TRANSFER_CHUNK = 1024 * 1024


class SyncError(ValueError):
    """A locally defined error message that is safe to show in workflow logs."""


def version_tuple(value):
    if not isinstance(value, str) or not re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)', value):
        raise SyncError('Expected a stable three-part version')
    return tuple(map(int, value.split('.')))


def prepare_manifest(path, release):
    prepared = json.loads(path.read_text(encoding='utf-8'))
    version = prepared['version']
    version_tuple(version)
    if (release.get('tag_name') != f'v{version}' or release.get('id') != prepared['release_id']
            or release.get('draft') or release.get('prerelease') or not release.get('published_at')):
        raise SyncError('Prepared assets no longer match the latest stable release')
    if set(prepared['platforms']) != {'x64', 'arm64'}:
        raise SyncError('Both official architectures are required')
    files = []
    downloads = []
    for arch in ('x64', 'arm64'):
        asset = prepared['platforms'][arch]
        filename = f'SapLink-{version}-win-{arch}-setup.exe'
        if asset.get('filename') != filename or not re.fullmatch(r'[a-f0-9]{64}', asset.get('sha256', '')):
            raise SyncError('Invalid official asset name or digest')
        if type(asset.get('size')) is not int or not 0 < asset['size'] <= MAX_INSTALLER_SIZE:
            raise SyncError('Invalid installer size')
        local = path.parent / filename
        digest = hashlib.sha256()
        size = 0
        with local.open('rb') as stream:
            while chunk := stream.read(1024 * 1024):
                size += len(chunk)
                if size > asset['size']:
                    raise SyncError('Installer exceeds expected size')
                digest.update(chunk)
        if size != asset['size'] or digest.hexdigest() != asset['sha256']:
            raise SyncError('Local installer does not match the verified release')
        key = f'saplink/v{version}/{filename}'
        files.append((key, local, size, asset['sha256']))
        downloads.append({'architecture': arch, 'url': f'{ORIGIN}/{key}', 'sha256': asset['sha256']})
    return {'schema_version': 1, 'version': version, 'published_at': release['published_at'], 'downloads': downloads}, files


def may_publish(existing, candidate):
    if existing is None:
        return True
    if existing.get('schema_version') != 1:
        raise SyncError('Existing COS manifest has an unsupported schema; inspect it manually')
    current, proposed = version_tuple(existing.get('version')), version_tuple(candidate['version'])
    if current > proposed:
        return False
    if current == proposed:
        # Never silently replace an already published version with different binaries.
        if existing.get('downloads') != candidate['downloads']:
            raise SyncError('Same-version manifest conflicts with published downloads; publish a new version')
    return True


def publish_skill_manifest(store, candidate, read_public):
    """Publish an independent pointer without changing the legacy installer contract."""
    existing = store.read_manifest(SKILL_LATEST_KEY)
    if existing:
        if existing.get('schema_version') != 1:
            raise SyncError('Unsupported skill manifest schema')
        current, proposed = version_tuple(existing.get('version')), version_tuple(candidate['version'])
        if current > proposed:
            return
        if current == proposed and existing.get('skill') != candidate['skill']:
            raise SyncError('Same-version skill manifest conflicts; publish a new version')
    if existing != candidate:
        store.put_bytes(SKILL_LATEST_KEY, (json.dumps(candidate, indent=2) + '\n').encode(), immutable=False)
    if store.read_manifest(SKILL_LATEST_KEY) != candidate or json.loads(read_public(SKILL_LATEST_KEY, 256 * 1024)) != candidate:
        raise SyncError('Published skill manifest verification failed')


def repair_existing_manifest(store, read_public=None):
    """Migrate only verified metadata, leaving all published binaries untouched."""
    read_public = read_public or public_bytes
    existing = store.read_manifest()
    required = {'schema_version', 'version', 'published_at', 'downloads'}
    if not existing or existing.get('schema_version') != 1 or not required <= set(existing) or set(existing) - required - {'skill'}:
        raise SyncError('Unexpected installer manifest; inspect it manually')
    version_tuple(existing['version'])
    if 'skill' not in existing:
        print('Installer metadata is already compatible; nothing changed.')
        return False
    version = existing['version']
    architectures = set()
    for item in existing['downloads']:
        architecture = item.get('architecture')
        if (set(item) != {'architecture', 'url', 'sha256'} or architecture not in {'x64', 'arm64'}
                or architecture in architectures or item['url'] != f'{ORIGIN}/saplink/v{version}/SapLink-{version}-win-{architecture}-setup.exe'
                or not re.fullmatch(r'[a-f0-9]{64}', item['sha256'])):
            raise SyncError('Invalid installer metadata; nothing changed')
        architectures.add(architecture)
    if architectures != {'x64', 'arm64'}:
        raise SyncError('Both installer architectures are required')
    skill = existing['skill']
    filename = f'SapLink-{version}-skill.zip'
    if (set(skill) != {'commit', 'filename', 'url', 'size', 'sha256'}
            or skill['filename'] != filename or skill['url'] != f'{ORIGIN}/saplink/v{version}/{filename}'
            or not re.fullmatch(r'[a-f0-9]{40}', skill['commit']) or not re.fullmatch(r'[a-f0-9]{64}', skill['sha256'])
            or type(skill['size']) is not int or not 0 < skill['size'] <= 16 * 1024 * 1024):
        raise SyncError('Invalid skill metadata; nothing changed')
    package = read_public(f'saplink/v{version}/{filename}', 16 * 1024 * 1024)
    if len(package) != skill['size'] or hashlib.sha256(package).hexdigest() != skill['sha256']:
        raise SyncError('Skill ZIP verification failed; nothing changed')
    if json.loads(read_public(LATEST_KEY, 256 * 1024)) != existing:
        raise SyncError('Public and authenticated metadata differ; nothing changed')
    encoded = (json.dumps(existing, indent=2) + '\n').encode()
    backup = f'saplink/manifest-backups/latest-{version}-{hashlib.sha256(encoded).hexdigest()}.json'
    if not store.exists(backup):
        store.put_bytes(backup, encoded, immutable=True)
    if read_public(backup, 256 * 1024) != encoded:
        raise SyncError('Metadata backup verification failed')
    publish_skill_manifest(store, {key: existing[key] for key in ('schema_version', 'version', 'published_at', 'skill')}, read_public)
    if store.read_manifest() != existing:
        raise SyncError('Installer metadata changed during repair; retry after checking concurrent publishers')
    repaired = {key: existing[key] for key in ('schema_version', 'version', 'published_at', 'downloads')}
    store.put_bytes(LATEST_KEY, (json.dumps(repaired, indent=2) + '\n').encode(), immutable=False)
    if store.read_manifest() != repaired or json.loads(read_public(LATEST_KEY, 256 * 1024)) != repaired:
        raise SyncError('Repaired installer metadata verification failed')
    print(f'Restored legacy installer metadata: v{version}; backup: {backup}')
    return True


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise SyncError('Unexpected COS redirect')


def open_public(key, start=None, end=None, etag=None):
    opener = urllib.request.build_opener(NoRedirect())
    headers = {'Cache-Control': 'no-cache'}
    if start is not None:
        headers['Range'] = f'bytes={start}-{end}'
    if etag:
        headers['If-Match'] = etag
    request = urllib.request.Request(f'{ORIGIN}/{key}', headers=headers)
    return opener.open(request, timeout=60)


def public_bytes(key, limit):
    with open_public(key) as response:
        data = response.read(limit + 1)
    if len(data) > limit:
        raise SyncError('Public metadata exceeds expected size')
    return data


def verify_public(key, expected_size, expected_hash):
    digest = hashlib.sha256()
    etag = None
    for start in range(0, expected_size, TRANSFER_CHUNK):
        end = min(start + TRANSFER_CHUNK, expected_size) - 1
        for attempt in range(3):
            try:
                with open_public(key, start, end, etag) as response:
                    if response.status != 206 or response.headers.get('Content-Range') != f'bytes {start}-{end}/{expected_size}':
                        raise SyncError('Public COS range or object size is inconsistent')
                    current_etag = response.headers.get('ETag')
                    if not current_etag or (etag is not None and current_etag != etag):
                        raise SyncError('Public COS object changed during verification')
                    chunk = response.read(end - start + 2)
                    if len(chunk) != end - start + 1:
                        raise OSError('Incomplete public range')
                    etag = current_etag
                break
            except (OSError, urllib.error.URLError, http.client.IncompleteRead) as error:
                if isinstance(error, urllib.error.HTTPError) and error.code not in (408, 429, 500, 502, 503, 504):
                    raise SyncError(f'Public COS verification returned HTTP {error.code}') from None
                if attempt == 2:
                    raise SyncError('Public COS range verification failed after three attempts') from None
                print(f'Retrying public range {start}-{end}: {key}', flush=True)
                time.sleep(2 ** attempt)
        digest.update(chunk)
        print(f'Public verification: {key} {end + 1}/{expected_size} bytes', flush=True)
    if digest.hexdigest() != expected_hash:
        raise SyncError('Public COS download failed SHA-256 verification')


def sync_release(path, store, latest_release, api, verify=verify_public, read_public=public_bytes):
    print('Checking latest GitHub release and local installer checksums...', flush=True)
    release = latest_release()
    candidate, files = prepare_manifest(path, release)
    from website_skill import build
    content, metadata = build(api, candidate['version'])
    skill_key = f'saplink/v{candidate["version"]}/{metadata["filename"]}'
    skill = {key: value for key, value in metadata.items() if key != 'version'}
    skill['url'] = f'{ORIGIN}/{skill_key}'
    print('Reading existing COS latest.json...', flush=True)
    if not may_publish(store.read_manifest(), candidate):
        print('Skipping: COS already advertises a newer version.')
        return False
    for key, local, size, sha256 in files:
        print(f'Checking COS object: {key}', flush=True)
        if not store.exists(key):
            print(f'Uploading {local.name}: {size} bytes', flush=True)
            store.put_file(key, local)
        # Existing binaries must also match; a failed upload retry never overwrites them.
        print(f'Verifying anonymous HTTPS download: {key}', flush=True)
        verify(key, size, sha256)
        checksum = f'{sha256}  {local.name}\n'.encode()
        checksum_key = key + '.sha256'
        if not store.exists(checksum_key):
            store.put_bytes(checksum_key, checksum, immutable=True)
        if read_public(checksum_key, 1024).decode('utf-8-sig').strip() != checksum.decode().strip():
            raise SyncError('Public COS checksum sidecar is inconsistent')
        print(f'Verified public COS download: {local.name}', flush=True)
    print(f'Uploading and verifying skill ZIP: {skill_key}', flush=True)
    if not store.exists(skill_key):
        store.put_bytes(skill_key, content, immutable=True)
    verify(skill_key, metadata['size'], metadata['sha256'])
    checksum = f'{metadata["sha256"]}  {metadata["filename"]}\n'.encode()
    if not store.exists(skill_key + '.sha256'):
        store.put_bytes(skill_key + '.sha256', checksum, immutable=True)
    if read_public(skill_key + '.sha256', 1024).decode('utf-8-sig').strip() != checksum.decode().strip():
        raise SyncError('Public COS skill checksum is inconsistent')
    # Release events may queue while a newer release is being published.
    latest = latest_release()
    if latest.get('id') != release['id'] or latest.get('tag_name') != release['tag_name']:
        print('Skipping latest.json: a newer GitHub release was published during upload.')
        return False
    existing = store.read_manifest()
    if not may_publish(existing, candidate):
        print('Skipping latest.json: COS already advertises a newer version.')
        return False
    # Publish the small skill pointer first. Old clients must see exactly the original
    # four installer keys, including when repairing an already polluted same-version pointer.
    if existing and existing['version'] == candidate['version'] and existing.get('skill', skill) != skill:
        raise SyncError('Existing combined skill metadata conflicts; inspect it manually')
    publish_skill_manifest(store, {'schema_version': 1, 'version': candidate['version'],
                                 'published_at': candidate['published_at'], 'skill': skill}, read_public)
    expected = {key: existing[key] for key in ('schema_version', 'version', 'published_at', 'downloads')} \
        if existing and existing['version'] == candidate['version'] else candidate
    if existing != expected:
        print('Both installers and skill ZIP verified; publishing latest.json...', flush=True)
        encoded = (json.dumps(expected, indent=2) + '\n').encode()
        store.put_bytes(LATEST_KEY, encoded, immutable=False)
    # Compare JSON semantically: manually uploaded metadata may use different whitespace.
    if store.read_manifest() != expected:
        raise SyncError('Published COS manifest verification failed')
    if json.loads(read_public(LATEST_KEY, 256 * 1024)) != expected:
        raise SyncError('Public COS manifest verification failed')
    print(f'COS synchronization complete: v{candidate["version"]}')
    return True


class CosStore:
    def __init__(self, client, service_error):
        self.client = client
        self.service_error = service_error

    def exists(self, key):
        try:
            self.client.head_object(Bucket=BUCKET, Key=key)
            return True
        except self.service_error as error:
            if error.get_status_code() == 404 and error.get_error_code() in ('NoSuchKey', 'NoSuchResource'):
                return False
            raise

    def read_manifest(self, key=LATEST_KEY):
        try:
            response = self.client.get_object(Bucket=BUCKET, Key=key)
        except self.service_error as error:
            if error.get_status_code() == 404 and error.get_error_code() == 'NoSuchKey':
                return None
            raise
        stream = response['Body'].get_raw_stream()
        try:
            data = stream.read(256 * 1024 + 1)
        finally:
            stream.close()
        if len(data) > 256 * 1024:
            raise SyncError('Existing COS manifest is oversized')
        return json.loads(data)

    def put_file(self, key, path):
        def progress(completed, total):
            print(f'Upload: {path.name} {int(completed)}/{int(total)} bytes', flush=True)
        try:
            self.client.upload_file(Bucket=BUCKET, Key=key, LocalFilePath=str(path),
                                    PartSize=1, MAXThread=3, EnableMD5=True, progress_callback=progress,
                                    Metadata={'x-cos-forbid-overwrite': 'true'}, ContentType='application/octet-stream',
                                    CacheControl='public, max-age=31536000, immutable')
        except self.service_error as error:
            if error.get_status_code() == 403:
                raise SyncError('COS multipart access denied; check InitiateMultipartUpload, UploadPart, '
                                'CompleteMultipartUpload, ListMultipartUploads and ListParts permissions') from None
            raise

    def put_bytes(self, key, data, immutable):
        # SDK 1.9.44 passes custom HTTP headers through Metadata, without adding a prefix.
        options = {'Metadata': {'x-cos-forbid-overwrite': 'true'}} if immutable else {}
        self.client.put_object(Bucket=BUCKET, Key=key, Body=data, EnableMD5=True,
                               ContentType='application/zip' if key.endswith('.zip') else ('text/plain' if immutable else 'application/json'),
                               CacheControl='public, max-age=31536000, immutable' if immutable else 'no-cache', **options)


def create_cos_client(config):
    from qcloud_cos import CosS3Client

    class ImmutableMultipartClient(CosS3Client):
        def complete_multipart_upload(self, *args, **kwargs):
            # SDK 1.9.44 upload_file forwards Metadata to initiation only.
            # The final commit must independently forbid overwriting a published object.
            kwargs['Metadata'] = {**kwargs.get('Metadata', {}), 'x-cos-forbid-overwrite': 'true'}
            return super().complete_multipart_upload(*args, **kwargs)

    return ImmutableMultipartClient(config, retry=2)


def main():
    # Import SDK only in the uploader step; tests use an isolated in-memory store.
    from qcloud_cos import CosConfig
    from qcloud_cos.cos_exception import CosServiceError
    secret_id = os.environ.get('COS_SECRET_ID')
    secret_key = os.environ.get('COS_SECRET_KEY')
    if not secret_id or not secret_key:
        raise SyncError('Missing COS_SECRET_ID or COS_SECRET_KEY')
    config = CosConfig(Region=REGION, SecretId=secret_id, SecretKey=secret_key, Scheme='https', Timeout=60, AllowRedirects=False)
    client = create_cos_client(config)
    store = CosStore(client, CosServiceError)
    if os.environ.get('REPAIR_METADATA_ONLY') == '1':
        repair_existing_manifest(store)
        return
    spec = importlib.util.spec_from_file_location('prepare_release', Path(__file__).with_name('prepare-website-release.py'))
    github = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(github)
    path = Path(os.environ['RELEASE_MANIFEST'])
    latest = lambda: github.api('releases/latest')
    sync_release(path, store, latest, github.api)


if __name__ == '__main__':
    logging.disable(logging.CRITICAL)  # SDK errors can otherwise log request context.
    try:
        main()
    except Exception as error:
        # Do not dump SDK exception text, signed URLs or headers into Actions logs.
        reason = str(error) if isinstance(error, SyncError) else type(error).__name__
        print(f'COS synchronization failed: {reason}. Check assets, public-read access and scoped COS permissions.', file=sys.stderr)
        sys.exit(1)
