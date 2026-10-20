"""Build a reproducible skill ZIP from the source commit of an official release."""
import base64
import hashlib
import io
import re
from pathlib import PurePosixPath
import zipfile

MAX_ZIP = 16 * 1024 * 1024
PREFIX = 'skills/saplink-manager/'


def build(api, version):
    if not re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)', version):
        raise ValueError('Invalid skill release version')
    commit = api('commits/v' + version)
    tree = api('git/trees/' + commit['commit']['tree']['sha'] + '?recursive=1')
    if tree.get('truncated'):
        raise ValueError('Incomplete source tree')
    entries = sorted((entry for entry in tree['tree'] if entry['path'].startswith(PREFIX)
                      and entry['type'] != 'tree'), key=lambda entry: entry['path'])
    if not 0 < len(entries) <= 128:
        raise ValueError('Missing or oversized skill source tree')
    if not any(entry['path'] == PREFIX + 'SKILL.md' for entry in entries):
        raise ValueError('Release source has no saplink-manager/SKILL.md')
    result = io.BytesIO()
    total = 0
    with zipfile.ZipFile(result, 'w', compression=zipfile.ZIP_STORED) as archive:
        for entry in entries:
            relative = entry['path'][len(PREFIX):]
            if (entry.get('mode') not in {'100644', '100755'} or '\\' in relative
                    or any(part in {'', '.', '..'} for part in relative.split('/'))):
                raise ValueError('Unsafe skill source entry')
            size = entry.get('size')
            if type(size) is not int or not 0 <= size <= 1024 * 1024:
                raise ValueError('Invalid skill source size')
            total += size
            if total > MAX_ZIP // 2:
                raise ValueError('Skill source is too large')
            blob = api('git/blobs/' + entry['sha'])
            if blob.get('encoding') != 'base64':
                raise ValueError('Unexpected source encoding')
            data = base64.b64decode(blob['content'])
            blob_hash = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
            if len(data) != size or blob_hash != entry['sha']:
                raise ValueError('Skill source blob verification failed')
            info = zipfile.ZipInfo(str(PurePosixPath('saplink-manager') / relative), (1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data)
    content = result.getvalue()
    if len(content) > MAX_ZIP:
        raise ValueError('Skill ZIP is too large')
    name = f'SapLink-{version}-skill.zip'
    metadata = {'version': version, 'commit': commit['sha'], 'filename': name,
                'size': len(content),
                'sha256': hashlib.sha256(content).hexdigest()}
    return content, metadata


def archive_files(content):
    """Read a bounded ZIP without extracting paths or accepting duplicate entries."""
    if len(content) > MAX_ZIP:
        raise ValueError('Skill ZIP is too large')
    files = {}
    total = 0
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        entries = archive.infolist()
        if len(entries) > 256:
            raise ValueError('Too many skill ZIP entries')
        for entry in entries:
            name = entry.filename
            parts = name.rstrip('/').split('/')
            if ('\\' in name or not name.startswith('saplink-manager/')
                    or any(part in {'', '.', '..'} for part in parts)
                    or entry.flag_bits & 1 or entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)):
                raise ValueError('Unsafe skill ZIP entry')
            mode = (entry.external_attr >> 16) & 0o170000
            if entry.is_dir():
                if mode not in (0, 0o040000):
                    raise ValueError('Unsafe skill ZIP directory')
                continue
            if mode not in (0, 0o100000) or name in files or entry.file_size > 1024 * 1024:
                raise ValueError('Invalid skill ZIP file')
            total += entry.file_size
            if len(files) >= 128 or total > MAX_ZIP // 2:
                raise ValueError('Skill ZIP contents are too large')
            files[name] = archive.read(entry)
    return files


def load_release(api, release, request=None):
    """Prefer verified Release attachments; otherwise generate from the exact tag."""
    import urllib.error
    version = release['tag_name'].removeprefix('v')
    if not re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)', version):
        raise ValueError('Invalid skill release version')
    filename = f'SapLink-{version}-skill.zip'
    names = (filename, filename + '.sha256')
    selected = [[asset for asset in release.get('assets', []) if asset.get('name') == name] for name in names]
    if any(len(matches) > 1 for matches in selected):
        raise ValueError('Duplicate skill Release attachments')
    if request is None or any(not matches or matches[0].get('state') != 'uploaded' for matches in selected):
        print('Skill attachments unavailable; generating from the release tag.', flush=True)
        return build(api, version)

    def read_asset(asset, maximum):
        size = asset.get('size')
        identifier = asset.get('id')
        if type(size) is not int or not 0 < size <= maximum or type(identifier) is not int or identifier <= 0:
            raise ValueError('Invalid skill attachment metadata')
        with request(f'https://api.github.com/repos/OneOFF-ive/saplink/releases/assets/{identifier}', binary=True) as response:
            data = response.read(maximum + 1)
        if len(data) != size:
            raise ValueError('Skill attachment size mismatch')
        digest = asset.get('digest')
        if digest and digest != 'sha256:' + hashlib.sha256(data).hexdigest():
            raise ValueError('GitHub skill attachment digest mismatch')
        return data

    try:
        content = read_asset(selected[0][0], MAX_ZIP)
        checksum = read_asset(selected[1][0], 1024)
    except (OSError, urllib.error.URLError):
        print('Could not download skill attachments; generating from the release tag.', flush=True)
        return build(api, version)
    expected = hashlib.sha256(content).hexdigest() + '  ' + filename
    if checksum.decode('utf-8-sig').strip() != expected:
        raise ValueError('Release skill SHA-256 sidecar mismatch')
    # ZIP encoders differ between Windows and Python. Compare every file with the
    # official tag rather than requiring identical compression or ZIP headers.
    generated, metadata = build(api, version)
    if archive_files(content) != archive_files(generated):
        raise ValueError('Release skill ZIP differs from the release tag source')
    metadata = {**metadata, 'size': len(content), 'sha256': hashlib.sha256(content).hexdigest()}
    print('Using the verified skill ZIP and checksum from the Release.', flush=True)
    return content, metadata
