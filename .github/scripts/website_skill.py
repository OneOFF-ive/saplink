"""Build a reproducible skill ZIP from the source commit of an official release."""
import base64
import hashlib
import io
import json
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
                'url': f'/downloads/skills/v{version}/{name}', 'size': len(content),
                'sha256': hashlib.sha256(content).hexdigest()}
    return content, metadata


def receive(stream, downloads, version, api, get_latest):
    # The caller holds the same lock used by installer publication.
    import os
    from pathlib import Path
    import tempfile
    latest = get_latest()
    if (latest.get('tag_name') != 'v' + version or latest.get('draft')
            or latest.get('prerelease') or not latest.get('published_at')):
        raise ValueError('Only the latest stable release skill may be published')
    expected, metadata = build(api, version)
    content = stream.read(MAX_ZIP + 1)
    if content != expected:
        raise ValueError('Skill ZIP differs from official release source')
    root = Path(downloads) / 'skills'
    if root.is_symlink():
        raise ValueError('Unexpected skill download directory')
    root.mkdir(mode=0o755, exist_ok=True)
    target = root / ('v' + version)
    if target.is_symlink():
        raise ValueError('Unexpected skill release directory')
    with tempfile.TemporaryDirectory(prefix='.skill-', dir=root) as temporary:
        work = Path(temporary)
        if target.exists():
            if (target / metadata['filename']).is_symlink() or (target / metadata['filename']).read_bytes() != expected:
                raise ValueError('Existing skill version conflicts with official source')
            if json.loads((target / 'skill.json').read_text()) != metadata:
                raise ValueError('Existing skill metadata conflicts with official source')
        else:
            work.chmod(0o755)
            (work / metadata['filename']).write_bytes(content)
            (work / metadata['filename']).chmod(0o644)
            (work / 'skill.json').write_text(json.dumps(metadata, indent=2) + '\n')
            (work / 'skill.json').chmod(0o644)
        if get_latest().get('id') != latest['id']:
            raise ValueError('A newer release was published during skill transfer')
        if not target.exists():
            (work / 'saplink-manager.zip').symlink_to(metadata['filename'])
            os.rename(work, target)
        # Use a separate pointer so installer pruning and metadata are unaffected.
        with tempfile.TemporaryDirectory(prefix='.skill-pointer-', dir=root) as pointer:
            link = Path(pointer) / 'latest'
            link.symlink_to('v' + version)
            os.replace(link, root / 'latest')
    return {'status': 'synced', **metadata}
