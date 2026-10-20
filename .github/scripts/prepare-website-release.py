import hashlib
import io
import json
import os
from pathlib import Path
import re
import tarfile
import time
import urllib.parse
import urllib.request

REPO = 'OneOFF-ive/saplink'
TOKEN = os.environ.get('GH_TOKEN', '')
ROOT = Path(os.environ['RUNNER_TEMP']) / 'saplink-website-sync'
ROOT.mkdir(exist_ok=True)


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, new_url):
        destination = urllib.parse.urlparse(new_url)
        if destination.scheme != 'https' or destination.hostname not in {
            'api.github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'}:
            raise ValueError('Unexpected asset redirect')
        redirected = super().redirect_request(request, fp, code, msg, headers, new_url)
        if destination.hostname != 'api.github.com':
            redirected.remove_header('Authorization')
        return redirected


opener = urllib.request.build_opener(SafeRedirect())


def request(url, binary=False):
    headers = {'User-Agent': 'SapLink-Website-Sync',
               'Accept': 'application/octet-stream' if binary else 'application/vnd.github+json'}
    if TOKEN:
        headers['Authorization'] = 'Bearer ' + TOKEN
    return opener.open(urllib.request.Request(url, headers=headers), timeout=60)


def api(endpoint):
    with request(f'https://api.github.com/repos/{REPO}/{endpoint}') as response:
        return json.load(response)


def main():
    tag = os.environ.get('RELEASE_TAG', '').strip()
    latest = api('releases/latest')
    if tag and tag != latest.get('tag_name'):
        print('Skipping a release that is no longer the latest stable version.')
        with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
            output.write('ready=false\n')
        return
    tag = tag or latest['tag_name']
    if not re.fullmatch(r'v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)', tag):
        raise ValueError('Expected a stable vMAJOR.MINOR.PATCH tag')
    version = tag[1:]
    # Website publication now ships only the skill; installers go to COS.
    if os.environ.get('SKILL_ONLY') == '1':
        release = api('releases/tags/' + tag)
        if release.get('draft') or release.get('prerelease') or not release.get('published_at'):
            raise ValueError('The release is not a published stable version')
        with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
            output.write(f'ready=true\nversion={version}\n')
        return
    manifest = None
    selected = {}
    for attempt in range(18):
        release = api('releases/tags/' + tag)
        if release.get('draft') or release.get('prerelease') or not release.get('published_at'):
            raise ValueError('The release is not a published stable version')
        platforms = {}
        selected = {}
        for arch in ('x64', 'arm64'):
            name = f'SapLink-{version}-win-{arch}-setup.exe'
            matches = [asset for asset in release.get('assets', []) if asset.get('name') == name]
            if len(matches) != 1:
                continue
            asset = matches[0]
            digest = asset.get('digest', '')
            size = asset.get('size')
            if not isinstance(digest, str) or not re.fullmatch(r'sha256:[0-9a-f]{64}', digest):
                continue
            if type(size) is not int or not 0 < size <= 256 * 1024 * 1024 or asset.get('state') != 'uploaded':
                continue
            selected[arch] = asset
            platforms[arch] = {
                'name': 'Windows ' + ('ARM64' if arch == 'arm64' else 'x64'),
                'filename': name, 'url': f'downloads/{tag}/{name}',
                'size': size, 'sha256': digest[7:]
            }
        if len(platforms) == 2:
            manifest = {'version': version, 'release_id': release['id'], 'platforms': platforms}
            break
        if attempt < 17:
            print('Waiting for both official installer assets and SHA-256 metadata...', flush=True)
            time.sleep(10)
    if manifest is None:
        raise ValueError('Both official installers must finish uploading before synchronization')

    for arch, asset in selected.items():
        target = ROOT / manifest['platforms'][arch]['filename']
        digest = hashlib.sha256()
        received = 0
        # API asset IDs come from this repository's authenticated release metadata.
        with request(f'https://api.github.com/repos/{REPO}/releases/assets/{asset["id"]}', binary=True) as response, target.open('wb') as output:
            while chunk := response.read(1024 * 1024):
                received += len(chunk)
                if received > asset['size']:
                    raise ValueError('Asset exceeds the official size')
                output.write(chunk)
                digest.update(chunk)
        if received != asset['size'] or digest.hexdigest() != manifest['platforms'][arch]['sha256']:
            raise ValueError('Official installer checksum verification failed')
        print('Verified ' + target.name, flush=True)

    payload = ROOT / 'installers.tar'
    encoded = (json.dumps(manifest, indent=2) + '\n').encode()
    manifest_path = ROOT / 'releases.json'
    manifest_path.write_bytes(encoded)
    metadata_payload = ROOT / 'metadata.tar'
    with tarfile.open(metadata_payload, 'w') as archive:
        entry = tarfile.TarInfo('releases.json')
        entry.size = len(encoded)
        archive.addfile(entry, io.BytesIO(encoded))
    with tarfile.open(payload, 'w') as archive:
        entry = tarfile.TarInfo('releases.json')
        entry.size = len(encoded)
        archive.addfile(entry, io.BytesIO(encoded))
        for asset in manifest['platforms'].values():
            archive.add(ROOT / asset['filename'], arcname=asset['filename'], recursive=False)
    with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
        output.write(f'ready=true\nversion={version}\npayload={payload}\nmetadata={metadata_payload}\nmanifest={manifest_path}\n')


if __name__ == '__main__':
    main()
