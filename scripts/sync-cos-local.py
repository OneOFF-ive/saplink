"""Manual COS recovery using local installers and the trusted Action publisher."""
import argparse
import getpass
import importlib.util
import json
import logging
import os
from pathlib import Path
import re
import sys
import tempfile

REPOSITORY = Path(__file__).resolve().parents[1]
SCRIPTS = REPOSITORY / '.github' / 'scripts'
sys.path.insert(0, str(SCRIPTS))


class LocalError(ValueError):
    """A diagnostic authored here, safe to display without request credentials."""


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def prepare_local(release, tag, directory, work, publisher):
    official_tag = release.get('tag_name', '')
    if not isinstance(official_tag, str) or not re.fullmatch(r'v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)', official_tag):
        raise LocalError('GitHub latest must be a stable vMAJOR.MINOR.PATCH release.')
    if tag and tag != official_tag:
        raise LocalError('Requested tag is not GitHub latest. Older releases cannot be published by this script.')
    if release.get('draft') or release.get('prerelease') or not release.get('published_at'):
        raise LocalError('Publish the stable GitHub Release before synchronizing COS.')
    version = official_tag[1:]
    directory = Path(directory).expanduser().resolve() if directory else REPOSITORY / 'outputs' / 'installers' / version
    if not directory.is_dir():
        raise LocalError('Installer directory does not exist. Supply --directory or build outputs/installers/<version>.')
    platforms = {}
    for arch in ('x64', 'arm64'):
        filename = f'SapLink-{version}-win-{arch}-setup.exe'
        assets = [asset for asset in release.get('assets', []) if asset.get('name') == filename]
        if len(assets) != 1 or assets[0].get('state') != 'uploaded':
            raise LocalError('GitHub Release must contain both completed official installer assets, without duplicates.')
        digest = assets[0].get('digest')
        if not isinstance(digest, str) or not re.fullmatch(r'sha256:[a-f0-9]{64}', digest):
            raise LocalError('GitHub installer SHA-256 is unavailable. Wait until the Release assets are ready.')
        if not (directory / filename).is_file():
            raise LocalError(f'Missing local installer: {filename}')
        platforms[arch] = {'filename': filename, 'size': assets[0].get('size'), 'sha256': digest[7:]}
    path = work / 'releases.json'
    path.write_text(json.dumps({'version': version, 'release_id': release['id'], 'platforms': platforms}), encoding='utf-8')
    publisher.prepare_manifest(path, release, directory)
    print(f'Verified both local installers against GitHub {official_tag}: {directory}', flush=True)
    return path, directory


def credentials():
    identifier = os.environ.get('COS_SECRET_ID') or getpass.getpass('COS SecretId (hidden): ')
    secret = os.environ.get('COS_SECRET_KEY') or getpass.getpass('COS SecretKey (hidden): ')
    if not identifier.strip() or not secret.strip():
        raise LocalError('COS SecretId and SecretKey are required.')
    return identifier.strip(), secret.strip()


def run(args, publisher, github, work, store_factory):
    release = github.api('releases/latest')
    path, directory = prepare_local(release, args.tag, args.directory, work, publisher)
    if args.dry_run:
        from skill_archive import load_release
        _, metadata = load_release(github.api, release, github.request)
        print(f'Verified skill package: {metadata["filename"]} ({metadata["size"]} bytes, SHA-256 {metadata["sha256"]})')
        print(f'Dry run complete. Target: {publisher.ORIGIN}/saplink/v{release["tag_name"][1:]}/')
        print('No COS credentials requested, no COS objects read or written.')
        return
    store = store_factory()
    result = publisher.sync_release(path, store, lambda: github.api('releases/latest'),
                                    github.api, request=github.request, asset_directory=directory)
    if not result:
        raise LocalError('Synchronization did not publish the requested release: latest changed or COS has a newer version.')
    print('Local COS synchronization succeeded. Public packages and catalogs have been verified.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tag', default='', help='Latest stable tag, e.g. v1.0.9; default: GitHub latest')
    parser.add_argument('--directory', help='Local installer directory; default: outputs/installers/<latest version>')
    parser.add_argument('--dry-run', action='store_true', help='Verify local installers and official skill without accessing COS')
    args = parser.parse_args()
    if args.tag and not re.fullmatch(r'v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)', args.tag):
        raise LocalError('Use a complete stable tag such as v1.0.9.')
    root = REPOSITORY / '.saplink' / 'cos-local'
    root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='run-', dir=root) as temporary:
        work = Path(temporary)
        previous = os.environ.get('RUNNER_TEMP')
        os.environ['RUNNER_TEMP'] = str(work)
        try:
            github = load('local_cos_github', 'prepare-cos-release.py')
        finally:
            if previous is None:
                os.environ.pop('RUNNER_TEMP', None)
            else:
                os.environ['RUNNER_TEMP'] = previous
        publisher = load('local_cos_publisher', 'sync-cos-release.py')

        def store_factory():
            from qcloud_cos import CosConfig
            from qcloud_cos.cos_exception import CosServiceError
            identifier, secret = credentials()
            config = CosConfig(Region=publisher.REGION, SecretId=identifier, SecretKey=secret,
                               Scheme='https', Timeout=60, AllowRedirects=False)
            return publisher.CosStore(publisher.create_cos_client(config), CosServiceError)

        run(args, publisher, github, work, store_factory)


if __name__ == '__main__':
    logging.disable(logging.CRITICAL)
    try:
        main()
    except KeyboardInterrupt:
        print('Cancelled. Rerun the same command to verify and resume existing uploads.', file=sys.stderr)
        sys.exit(130)
    except Exception as error:
        # SDK errors can contain signed requests. Never print them or a traceback.
        safe = isinstance(error, LocalError) or type(error).__name__ == 'SyncError'
        reason = str(error) if safe else type(error).__name__
        print(f'Local COS synchronization failed: {reason}. Check network, credentials and release assets.', file=sys.stderr)
        sys.exit(1)
