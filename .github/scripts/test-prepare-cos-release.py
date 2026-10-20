"""Verify official asset preparation without network access or website archives."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

class PrepareCosTests(unittest.TestCase):
    def setUp(self):
        root = Path(__file__).resolve().parents[2] / '.saplink/tests'
        root.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=root)
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.environment = patch.dict(os.environ, {'RUNNER_TEMP': str(self.root),
            'GITHUB_OUTPUT': str(self.root / 'output'), 'RELEASE_TAG': 'v1.2.3'})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        spec = importlib.util.spec_from_file_location('prepare_cos', Path(__file__).with_name('prepare-cos-release.py'))
        self.prepare = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.prepare)
        self.payloads = {1: b'MZ fixture x64', 2: b'MZ fixture arm64'}
        self.release = {'id': 10, 'tag_name': 'v1.2.3', 'draft': False, 'prerelease': False,
                        'published_at': '2026-10-20T00:00:00Z', 'assets': [
            {'id': index, 'name': f'SapLink-1.2.3-win-{arch}-setup.exe', 'size': len(self.payloads[index]),
             'digest': 'sha256:' + hashlib.sha256(self.payloads[index]).hexdigest(), 'state': 'uploaded'}
            for index, arch in ((1, 'x64'), (2, 'arm64'))]}

    def run_prepare(self):
        def binary(url, binary=False):
            self.assertTrue(binary)
            return io.BytesIO(self.payloads[int(url.rsplit('/', 1)[-1])])
        with patch.object(self.prepare, 'api', return_value=self.release), patch.object(self.prepare, 'request', side_effect=binary), contextlib.redirect_stdout(io.StringIO()):
            self.prepare.main()

    def test_prepares_only_verified_binaries_and_cos_manifest(self):
        self.run_prepare()
        manifest = json.loads((self.prepare.ROOT / 'releases.json').read_text())
        self.assertEqual(set(manifest['platforms']), {'x64', 'arm64'})
        self.assertEqual(len(list(self.prepare.ROOT.iterdir())), 3)
        self.assertFalse(list(self.prepare.ROOT.glob('*.tar')))
        outputs = (self.root / 'output').read_text()
        self.assertIn('ready=true', outputs)
        self.assertIn('manifest=', outputs)
        self.assertNotIn('payload=', outputs)
        self.assertNotIn('metadata=', outputs)

    def test_corrupt_download_never_publishes_ready_output(self):
        self.payloads[1] = b'corrupt'
        with self.assertRaisesRegex(ValueError, 'checksum verification'):
            self.run_prepare()
        self.assertFalse((self.root / 'output').exists())

    def test_outdated_release_is_skipped_without_downloading(self):
        os.environ['RELEASE_TAG'] = 'v1.0.0'
        with patch.object(self.prepare, 'api', return_value=self.release), patch.object(self.prepare, 'request', side_effect=AssertionError('No downloads')), contextlib.redirect_stdout(io.StringIO()):
            self.prepare.main()
        self.assertEqual((self.root / 'output').read_text(), 'ready=false\n')
        self.assertEqual(list(self.prepare.ROOT.iterdir()), [])

if __name__ == '__main__':
    unittest.main()
