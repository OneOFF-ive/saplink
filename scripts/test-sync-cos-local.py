"""Offline checks for the local COS recovery entry point; never use credentials."""
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('cos_local', ROOT / 'scripts/sync-cos-local.py')
local = importlib.util.module_from_spec(spec)
spec.loader.exec_module(local)
publisher = local.load('cos_local_test_publisher', 'sync-cos-release.py')


class LocalTests(unittest.TestCase):
    def setUp(self):
        root = ROOT / '.saplink' / 'tests'
        root.mkdir(parents=True, exist_ok=True)
        temporary = tempfile.TemporaryDirectory(dir=root)
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.directory = self.root / 'installers with spaces'
        self.directory.mkdir()
        self.work = self.root / 'work'
        self.work.mkdir()
        self.release = {'id': 101, 'tag_name': 'v1.2.3', 'draft': False, 'prerelease': False,
                        'published_at': '2026-10-26T00:00:00Z', 'assets': []}
        for index, arch in enumerate(('x64', 'arm64'), 1):
            name = f'SapLink-1.2.3-win-{arch}-setup.exe'
            content = ('fixture-' + arch).encode()
            (self.directory / name).write_bytes(content)
            self.release['assets'].append({'id': index, 'name': name, 'state': 'uploaded',
                                          'size': len(content), 'digest': 'sha256:' + hashlib.sha256(content).hexdigest()})
        self.args = SimpleNamespace(tag='v1.2.3', directory=str(self.directory), dry_run=False)
        self.github = SimpleNamespace(api=Mock(return_value=self.release), request=Mock())
        self.factory = Mock()

    def prepare(self):
        with contextlib.redirect_stdout(io.StringIO()):
            return local.prepare_local(self.release, self.args.tag, self.args.directory, self.work, publisher)

    def test_local_installers_are_verified_in_place_without_replacing_build_metadata(self):
        (self.directory / 'latest.json').write_text('local build metadata', encoding='utf-8')
        path, directory = self.prepare()
        self.assertEqual(path.parent, self.work)
        self.assertEqual(directory, self.directory.resolve())
        self.assertEqual(json.loads(path.read_text())['release_id'], 101)
        self.assertEqual((self.directory / 'latest.json').read_text(), 'local build metadata')
        self.github.request.assert_not_called()

    def test_default_directory_uses_github_latest_not_local_package_version(self):
        self.args.directory = None
        default = self.root / 'outputs/installers/1.2.3'
        default.parent.mkdir(parents=True)
        self.directory.rename(default)
        with patch.object(local, 'REPOSITORY', self.root):
            _, directory = self.prepare()
        self.assertEqual(directory, default)

    def test_rejects_old_tag_unpublished_and_prerelease(self):
        for changed in ({'tag_name': 'v1.2.4'}, {'draft': True}, {'prerelease': True}, {'published_at': None}):
            with self.subTest(changed=changed), patch.dict(self.release, changed):
                with self.assertRaises(local.LocalError):
                    self.prepare()

    def test_missing_corrupt_or_incomplete_installers_do_not_request_cos_credentials(self):
        for issue in ('missing', 'corrupt', 'digest', 'duplicate', 'size', 'state'):
            with self.subTest(issue=issue):
                if issue == 'missing':
                    self.args.directory = str(self.root / 'missing')
                elif issue == 'corrupt':
                    (self.directory / self.release['assets'][0]['name']).write_bytes(b'bad')
                elif issue == 'duplicate':
                    self.release['assets'].append(self.release['assets'][0])
                else:
                    self.release['assets'][0][issue] = {'digest': '', 'size': 0, 'state': 'new'}[issue]
                with self.assertRaises((local.LocalError, publisher.SyncError)), contextlib.redirect_stdout(io.StringIO()):
                    local.run(self.args, publisher, self.github, self.work, self.factory)
                self.factory.assert_not_called()
                # Restore the fixture for the next independent case.
                self.setUp()

    def test_dry_run_verifies_official_skill_without_accessing_cos(self):
        self.args.dry_run = True
        metadata = {'filename': 'SapLink-1.2.3-skill.zip', 'size': 10, 'sha256': 'a' * 64}
        with patch('skill_archive.load_release', return_value=(b'zip', metadata)) as skill, contextlib.redirect_stdout(io.StringIO()):
            local.run(self.args, publisher, self.github, self.work, self.factory)
        self.factory.assert_not_called()
        skill.assert_called_once_with(self.github.api, self.release, self.github.request)

    def test_upload_delegates_to_action_publisher_with_the_local_directory(self):
        with patch.object(publisher, 'sync_release', return_value=True) as sync, contextlib.redirect_stdout(io.StringIO()):
            local.run(self.args, publisher, self.github, self.work, self.factory)
        self.factory.assert_called_once_with()
        self.assertEqual(sync.call_args.kwargs['asset_directory'], self.directory.resolve())
        self.assertIs(sync.call_args.kwargs['request'], self.github.request)
        self.assertEqual(sync.call_args.args[2](), self.release)

    def test_skipped_upload_returns_failure_instead_of_claiming_success(self):
        with patch.object(publisher, 'sync_release', return_value=False), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(local.LocalError):
                local.run(self.args, publisher, self.github, self.work, self.factory)

    def test_env_credentials_do_not_prompt(self):
        with patch.dict(local.os.environ, {'COS_SECRET_ID': 'fixture-id', 'COS_SECRET_KEY': 'fixture-secret'}), patch.object(local.getpass, 'getpass', side_effect=AssertionError('Unexpected prompt')):
            self.assertEqual(local.credentials(), ('fixture-id', 'fixture-secret'))

    def test_prompted_credentials_are_not_persisted(self):
        with patch.dict(local.os.environ, {}, clear=True), patch.object(local.getpass, 'getpass', side_effect=['fixture-id', 'fixture-secret']):
            self.assertEqual(local.credentials(), ('fixture-id', 'fixture-secret'))
            self.assertNotIn('COS_SECRET_ID', local.os.environ)
            self.assertNotIn('COS_SECRET_KEY', local.os.environ)


if __name__ == '__main__':
    unittest.main()
