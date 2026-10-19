"""Offline source integrity, reproducibility and publication regression checks."""
import base64
import copy
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

from website_skill import build, receive


class SkillTests(unittest.TestCase):
    def setUp(self):
        self.files = {'SKILL.md': b'---\nname: saplink-manager\n---\nUsage',
                      'references/client-setup.md': b'Client setup',
                      'agents/openai.yaml': b'display_name: SapLink'}
        self.entries = []
        self.blobs = {}
        for name, data in self.files.items():
            sha = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
            self.entries.append({'path': 'skills/saplink-manager/' + name, 'type': 'blob',
                                 'mode': '100644', 'size': len(data), 'sha': sha})
            self.blobs[sha] = {'encoding': 'base64', 'content': base64.b64encode(data).decode()}
        self.latest = {'id': 10, 'tag_name': 'v1.0.1', 'published_at': '2026-10-19T00:00:00Z'}
        test_root = Path(__file__).resolve().parents[2] / '.saplink/tests'
        test_root.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=test_root)
        self.addCleanup(self.temp.cleanup)
        self.downloads = Path(self.temp.name)

    def api(self, path):
        if path == 'commits/v1.0.1':
            return {'sha': 'a' * 40, 'commit': {'tree': {'sha': 'b' * 40}}}
        if path.startswith('git/trees/'):
            return {'tree': copy.deepcopy(self.entries), 'truncated': False}
        if path.startswith('git/blobs/'):
            return self.blobs[path.split('/')[-1]]
        raise AssertionError(path)

    def test_zip_uses_release_tag_and_includes_skill_and_supporting_files(self):
        content, metadata = build(self.api, '1.0.1')
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            self.assertEqual(set(archive.namelist()), {'saplink-manager/' + name for name in self.files})
            for name, data in self.files.items():
                self.assertEqual(archive.read('saplink-manager/' + name), data)
        self.assertEqual(metadata['commit'], 'a' * 40)
        self.assertEqual(metadata['sha256'], hashlib.sha256(content).hexdigest())
        self.assertEqual(metadata['size'], len(content))

    def test_zip_is_reproducible_across_tree_order(self):
        first = build(self.api, '1.0.1')
        self.entries.reverse()
        self.assertEqual(build(self.api, '1.0.1'), first)

    def test_corrupted_source_blob_is_rejected(self):
        self.blobs[self.entries[0]['sha']]['content'] = base64.b64encode(b'corrupted').decode()
        with self.assertRaisesRegex(ValueError, 'blob verification'):
            build(self.api, '1.0.1')

    def test_missing_skill_and_unsafe_entries_are_rejected(self):
        for change in ('missing', 'symlink', 'traversal'):
            with self.subTest(change=change):
                saved = copy.deepcopy(self.entries)
                if change == 'missing':
                    self.entries = self.entries[1:]
                elif change == 'symlink':
                    self.entries[1]['mode'] = '120000'
                else:
                    self.entries[1]['path'] = 'skills/saplink-manager/../secret'
                try:
                    with self.assertRaises(ValueError):
                        build(self.api, '1.0.1')
                finally:
                    self.entries = saved

    def test_tampered_upload_preserves_existing_downloads(self):
        sentinel = self.downloads / 'installer.exe'
        sentinel.write_bytes(b'unchanged')
        with self.assertRaisesRegex(ValueError, 'differs'):
            receive(io.BytesIO(b'bad zip'), self.downloads, '1.0.1', self.api, lambda: self.latest)
        self.assertFalse((self.downloads / 'skills').exists())
        self.assertEqual(sentinel.read_bytes(), b'unchanged')

    @unittest.skipIf(__import__('os').name == 'nt', 'Publication uses Linux symlinks')
    def test_publishes_zip_metadata_alias_and_idempotent_retry(self):
        content, metadata = build(self.api, '1.0.1')
        for _ in range(2):
            receive(io.BytesIO(content), self.downloads, '1.0.1', self.api, lambda: self.latest)
        latest = self.downloads / 'skills/latest'
        self.assertEqual((latest / 'saplink-manager.zip').read_bytes(), content)
        self.assertEqual(json.loads((latest / 'skill.json').read_text()), metadata)

    def test_old_release_and_pre_release_cannot_publish(self):
        content, _ = build(self.api, '1.0.1')
        for latest in ({**self.latest, 'tag_name': 'v1.0.2'}, {**self.latest, 'prerelease': True}):
            with self.assertRaises(ValueError):
                receive(io.BytesIO(content), self.downloads, '1.0.1', self.api, lambda: latest)

    def test_new_release_during_transfer_does_not_switch_pointer(self):
        content, _ = build(self.api, '1.0.1')
        releases = iter([self.latest, {**self.latest, 'id': 11}])
        with self.assertRaisesRegex(ValueError, 'newer release'):
            receive(io.BytesIO(content), self.downloads, '1.0.1', self.api, lambda: next(releases))
        self.assertFalse((self.downloads / 'skills/latest').exists())


if __name__ == '__main__':
    unittest.main()
