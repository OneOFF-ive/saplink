"""Bounded, resumable transport for the existing verified website receiver.

Deploy next to receive_release.py. The original receiver remains responsible for
GitHub verification, immutable releases, latest promotion and synchronization locks.
"""
import hashlib
import io
import json
import os
from pathlib import Path
import re
import signal
import shutil
import sys
import tarfile
import tempfile

CHUNK_SIZE = 2 * 1024 * 1024
ARCHITECTURES = ('x64', 'arm64')
VERSION = re.compile(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)')
HASH = re.compile(r'[a-f0-9]{64}')


def directory(parent, name):
    path = parent / name
    if path.is_symlink():
        raise ValueError('Staging symlinks are not permitted')
    path.mkdir(mode=0o700, exist_ok=True)
    if not path.is_dir():
        raise ValueError('Invalid staging directory')
    return path


def session(root, version):
    if not VERSION.fullmatch(version):
        raise ValueError('Invalid staging version')
    return directory(root, 'v' + version)


def atomic_bytes(path, content):
    if path.is_symlink():
        raise ValueError('Staging symlinks are not permitted')
    fd, temporary = tempfile.mkstemp(prefix='.part-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as output:
            output.write(content)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def prepare(root, supplied, official):
    if supplied != official:
        raise ValueError('Manifest differs from official GitHub metadata')
    work = session(root, supplied['version'])
    manifest_path = work / 'releases.json'
    if manifest_path.exists() and json.loads(manifest_path.read_text()) != official:
        raise ValueError('Staged version conflicts with official metadata')
    atomic_bytes(manifest_path, json.dumps(official).encode())
    chunks = {}
    for arch in ARCHITECTURES:
        asset = official['platforms'][arch]
        chunks[arch] = {}
        for index in range((asset['size'] + CHUNK_SIZE - 1) // CHUNK_SIZE):
            part = work / f'{arch}-{index}.part'
            expected = min(CHUNK_SIZE, asset['size'] - index * CHUNK_SIZE)
            if not part.is_symlink() and part.is_file() and part.stat().st_size == expected:
                chunks[arch][str(index)] = hashlib.sha256(part.read_bytes()).hexdigest()
    return {'chunk_size': CHUNK_SIZE, 'chunks': chunks}


def upload(root, version, arch, index, digest, stream):
    if arch not in ARCHITECTURES or not index.isdecimal() or not HASH.fullmatch(digest):
        raise ValueError('Invalid chunk coordinates or digest')
    index = int(index)
    work = session(root, version)
    manifest = json.loads((work / 'releases.json').read_text())
    asset = manifest['platforms'][arch]
    size = min(CHUNK_SIZE, asset['size'] - index * CHUNK_SIZE)
    if size <= 0:
        raise ValueError('Chunk is outside the official installer')
    content = stream.read(size + 1)
    if len(content) != size or hashlib.sha256(content).hexdigest() != digest:
        raise ValueError('Chunk size or checksum verification failed')
    atomic_bytes(work / f'{arch}-{index}.part', content)
    return {'status': 'stored', 'architecture': arch, 'index': index, 'sha256': digest}


def assemble(root, version, output):
    work = session(root, version)
    manifest = json.loads((work / 'releases.json').read_text())
    with tarfile.open(fileobj=output, mode='w') as archive:
        content = json.dumps(manifest).encode()
        entry = tarfile.TarInfo('releases.json')
        entry.size = len(content)
        archive.addfile(entry, io.BytesIO(content))
        for arch in ARCHITECTURES:
            asset = manifest['platforms'][arch]
            installer = work / asset['filename']
            if installer.is_symlink():
                raise ValueError('Staging symlinks are not permitted')
            digest = hashlib.sha256()
            with installer.open('wb') as output:
                for index in range((asset['size'] + CHUNK_SIZE - 1) // CHUNK_SIZE):
                    part = work / f'{arch}-{index}.part'
                    expected = min(CHUNK_SIZE, asset['size'] - index * CHUNK_SIZE)
                    if part.is_symlink() or not part.is_file() or part.stat().st_size != expected:
                        raise ValueError('Installer chunks are missing or incomplete')
                    data = part.read_bytes()
                    digest.update(data)
                    output.write(data)
            if digest.hexdigest() != asset['sha256']:
                raise ValueError('Assembled installer does not match official SHA-256')
            archive.add(installer, arcname=asset['filename'], recursive=False)


def handle(command, legacy):
    import fcntl

    args = command.split()
    operation = args[0]
    def interrupted(signum, frame):
        raise RuntimeError('Resumable operation interrupted; completed chunks are retained')
    for name in (signal.SIGTERM, signal.SIGHUP, signal.SIGALRM):
        signal.signal(name, interrupted)
    signal.alarm(180 if operation == 'chunk' else 300)
    root = directory(Path('/var/lib/saplink-release-sync'), 'staging')
    with Path('/var/lib/saplink-release-sync/sync.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if operation == 'skill' and len(args) == 2:
            from website_skill import receive
            result = receive(sys.stdin.buffer, legacy.DOWNLOADS, args[1], legacy.api,
                             lambda: legacy.api('releases/latest'))
        elif operation == 'prepare' and len(args) == 1:
            content = sys.stdin.buffer.read(16385)
            if len(content) > 16384:
                raise ValueError('Manifest is too large')
            supplied = json.loads(content)
            version = supplied.get('version', '')
            if not isinstance(version, str) or not VERSION.fullmatch(version):
                raise ValueError('Invalid release version')
            official = legacy.release_manifest(legacy.api('releases/tags/v' + version))
            latest = legacy.api('releases/latest')
            if latest.get('id') != official['release_id']:
                raise ValueError('Only the latest official release may be staged')
            result = prepare(root, supplied, official)
        elif operation == 'chunk' and len(args) == 5:
            result = upload(root, *args[1:], sys.stdin.buffer)
        elif operation == 'promote' and len(args) == 2:
            # Reuse all original release checks and the atomic latest switch.
            with tempfile.TemporaryFile() as archive:
                assemble(root, args[1], archive)
                archive.seek(0)
                result = legacy.receive(archive, legacy.DOWNLOADS,
                                        lambda tag: legacy.api('releases/tags/' + tag),
                                        lambda: legacy.api('releases/latest'))
            # Only the successfully promoted staging session is disposable.
            work = session(root, args[1])
            if work.resolve().parent != root.resolve():
                raise ValueError('Unexpected staging cleanup target')
            shutil.rmtree(work)
        else:
            raise ValueError('Invalid resumable command')
        print(json.dumps(result), flush=True)
    signal.alarm(0)
