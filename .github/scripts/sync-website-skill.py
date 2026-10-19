"""Package the release's skill and send it to the restricted website receiver."""
import importlib.util
import json
import os
from pathlib import Path

from website_skill import build


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


if __name__ == '__main__':
    prepare = load('prepare', 'prepare-website-release.py')
    upload = load('upload', 'upload-website-release.py')
    version = os.environ['RELEASE_VERSION']
    content, metadata = build(prepare.api, version)
    target = prepare.ROOT / metadata['filename']
    target.write_bytes(content)
    options = ['-T', '-i', os.environ['SYNC_SSH_KEY'], '-o', 'IdentitiesOnly=yes',
               '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
               '-o', 'UserKnownHostsFile=' + os.environ['SYNC_SSH_HOSTS'],
               '-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=15',
               '-o', 'ServerAliveCountMax=4', '-o', 'IPQoS=none']
    result = upload.ssh(options, 'skill ' + version, content, timeout=300)
    if result.get('status') != 'synced' or any(result.get(k) != v for k, v in metadata.items()):
        raise ValueError('Server did not confirm the official skill ZIP')
    print(json.dumps(result), flush=True)
